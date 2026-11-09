// CLI dispatcher: every yds_* tool and the bin/yds.js entry funnel into this
// one place, so behavior is identical for the agent (tools), the shell (bin),
// and the dsh-ris-ide startCommand (foreground mode).

import { existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { resolveConfig, describeConfig, IS_WSL } from './config.js'
import { describeYoncode, detectYoncode, patchYoncode, restoreYoncode, yoncodeWarning } from './yoncode.js'
import { pullConfcenter, readConfCache, writeConfCache, adaptAndWriteConfig, parseJdbcEndpoint, extractYonbipTargets, adaptMarker, ADAPT_VERSION } from './confcenter.js'
import { startForwarder, stopForwarder, runForwarder, isForwarderUp, probeSocksConnect } from './socks.js'
import {
  ensureBorrowedProxy, syncBorrowedRules, stopBorrowedProxy, borrowedProxyStatus, applyGitProxy, loadIdeProxy,
  loadIdeRedirector, syncRedirectorProfile, startBorrowedRedirector, stopBorrowedSideEffects,
  holdBorrowedLease, releaseBorrowedLease, dropBorrowedLease,
} from './ide-proxy.js'
import { probeRisd } from './risd-peer.js'
import { buildYmsHome, ymsHomeIsBuilt, ensureMavenSettings, findBootstrapDir } from './build.js'
import { startDetached, startForeground, stopYms, readRunning, status, rdbgaValue, tailFile } from './yms.js'
import { classifyRdbgaCookies, describeRdbgaCookies, hostVariants, isPlausibleRdbga, probeDevtoolsPorts, rdbgaFromRunningJvm, readRdbgaCookies, repairRdbgaCookie, workbenchTargets, DEVTOOLS_PORTS } from './browser.js'
import {
  applyIdeConfig, removeIdeConfig, readIdeConfig, entryName, ourEntry,
  applyLaunchConfig, removeLaunchConfig, readLaunchConfig, ourLaunchEntry, LAUNCH_ENTRY_NAME, launchRoot, stripLaunchProxy,
} from './ide.js'
import { getYycToken } from './token.js'
import { registerWorkspace, unregisterWorkspace } from './ide-watch.js'
import { feConfig, overrideRules, requestRedirects, writeOverrideRules, pageUrlWithScriptUrl } from './fe-dev.js'

/** Pull targets out of the cached yms_middleware.json + yonbip_config.json (for the forwarder). */
function forwarderTargets(cfg) {
  const cache = readConfCache(cfg)
  const targets = []
  try {
    const mw = JSON.parse(cache['yms_middleware.json'])
    for (const pool of Object.values(mw.connectionPools ?? {})) {
      const ep = parseJdbcEndpoint(String(pool?.url ?? ''))
      if (ep !== null) targets.push({ host: ep.host, port: ep.port })
    }
    for (const pool of Object.values(mw['redis.pools'] ?? {})) {
      if (typeof pool?.host === 'string') targets.push({ host: pool.host, port: Number(pool.port) || 6379, isRedis: true })
    }
  } catch { /* cache unreadable */ }
  try {
    // yonbip extras (kafka/ES/license...) keep their own port numbers locally
    for (const t of extractYonbipTargets(cache['yonbip_config.json'])) {
      if (!targets.some((x) => x.host === t.host && x.port === t.port)) targets.push(t)
    }
  } catch { /* cache unreadable / not pulled */ }
  return targets
}

/** True when yms-home/config was adapted by the current adapter version. */
/**
 * Whether yms-home/config was written by the CURRENT adapter in the CURRENT mode.
 *
 * The mode matters: with ProxyBridge running the config must keep real addresses,
 * without it they must be rewritten to 127.0.0.1. Same-version writes from the
 * other mode are re-adapted.
 * @param {object} cfg - resolved plugin config.
 * @param {boolean} rewrite - mode the caller is about to use.
 * @returns {boolean} true when the existing files can be reused as-is.
 */
function adaptIsCurrent(cfg, rewrite) {
  try {
    return readFileSync(join(cfg.stateDir, 'adapt-version'), 'utf8').trim() === adaptMarker(rewrite)
  } catch { return false }
}

/**
 * Shared start pipeline: (auto)build yms-home -> ensure config -> socks
 * forwarder. log() receives progress lines and mvn's full output goes to
 * stdout, so both the detached CLI and the dsh-ris-ide foreground entry
 * (run-with-log.sh capture) make the build trackable via `yds logs` /
 * `ris_dev_logs`.
 * @returns {boolean|`${string}`} true when ready to launch, else the reason.
 */
async function prepareStart(cfg, { log }) {
  // fail fast on unusable config before touching anything long-running
  if (cfg.module == null) return '未识别模块名——检查项目 yonbuilder.json / module.xml'
  if (cfg.java == null) return '未找到 JDK——用 .env 的 java.path 或 JAVA_HOME 指定'
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(String(cfg.serverBindAddress ?? '')) !== true) {
    return '缺少合法的 serverBindAddress（回调地址）——补项目 .vscode/settings.json 的 yds.serverBindAddress'
  }
  if (!ymsHomeIsBuilt(cfg)) {
    log('yms-home 未构建，开始 mvn 构建（首次含 kernel 下载约 19 分钟，缓存后约 1 分钟）…')
    try {
      await buildYmsHome(cfg, { onStdout: (t) => process.stdout.write(t) })
      log('mvn 构建完成')
    } catch (e) {
      return `构建失败: ${e.message}（完整输出见日志）`
    }
  }
  // A tunnel is only usable when a proxy address is configured AND it really
  // reaches the internal endpoints; probe before deciding anything else.
  let targets = []
  if (cfg.socks !== null) {
    targets = forwarderTargets(cfg)
    if (targets.length === 0) {
      return 'socks 已配置但无转发目标（confcenter 缓存里没有 DB/Redis 地址）——先运行 yds confcenter'
    }
    log(`socks 隧道预检: ${cfg.socks.host}:${cfg.socks.port} -> ${targets[0].host}:${targets[0].port}`)
    const healthy = await probeSocksConnect(cfg.socks, targets[0])
    if (!healthy) {
      return `SOCKS 隧道不可用（${cfg.socks.host}:${cfg.socks.port} 无法转发到 ${targets[0].host}:${targets[0].port}）——检查远程开发机的隧道状态后重试`
    }
  }
  // Interception mode = proxy configured + reachable + the system-level
  // redirector is RUNNING. Only then may the config keep its real endpoints:
  // ProxyBridge redirects the java process inside the kernel, so nothing is
  // bound on loopback and no mapping rows appear anywhere.
  const bridge = await loadIdeRedirector(cfg)
  // Only the THIS-SIDE hook can cover the JVM we are about to start: a Windows
  // ProxyBridge hooks the Windows stack, so yds must keep the 127.0.0.1 rewrite
  // unless the Linux/macOS side is actually intercepting.
  let bridgeRunning = bridge?.available === true
    && (typeof bridge.mod.localRedirectorRunning === 'function'
      ? bridge.mod.localRedirectorRunning() === true
      : bridge.mod.redirectorStatus().running === true)
  // The redirector belongs to the tunnel lifecycle: if the proxy is configured and
  // reachable, bring the system-level interception up with it. Elevation is the
  // expected prompt here (UAC on Windows, passwordless sudo on Linux); a side that
  // cannot be elevated is reported below, never fatal.
  if (cfg.socks !== null && bridge?.available === true && !bridgeRunning) {
    // Start the local side first (that is the one this run needs) and let the
    // Windows side come up too, so an IDE-launched java is covered as well.
    const startedBridge = await startBorrowedRedirector(cfg, { log, sides: ['local', 'windows'] })
    bridgeRunning = typeof bridge.mod.localRedirectorRunning === 'function'
      ? bridge.mod.localRedirectorRunning() === true
      : startedBridge.running === true
  }
  const intercepting = cfg.socks !== null && bridgeRunning
  if (bridge?.available === true) {
    log(intercepting
      ? 'ProxyBridge 运行中：保留真实地址，由系统层拦截 java 的连接'
      : 'ProxyBridge 未运行：config 改写为 127.0.0.1 并启用本地转发（兜底）')
  }
  if (!existsSync(join(cfg.ymsHome, 'config', 'yms_middleware.json')) || !adaptIsCurrent(cfg, !intercepting)) {
    let files = readConfCache(cfg)
    if (files['yms_middleware.json'] === undefined) {
      log('config 缺失，从 confcenter 拉取…')
      try {
        files = await pullConfcenter(cfg)
        writeConfCache(cfg, files)
      } catch (e) {
        return `配置缺失且无法拉取（${e.message}）——先运行 yds confcenter`
      }
    } else {
      log('适配版本/模式变更，从缓存重新适配 config…')
    }
    try {
      adaptAndWriteConfig(cfg, files, { rewrite: !intercepting })
    } catch (e) {
      return `config 适配失败: ${e.message}`
    }
    log(`config 已就绪（${intercepting ? '真实地址' : '127.0.0.1 兜底'}）`)
  }
  if (cfg.socks !== null) {
    if (intercepting) {
      // Rules still go into the shared table (the redirector profile is built
      // from them) but no engine is started: nothing may bind a loopback port
      // that would shadow the real endpoint.
      log('系统层拦截已生效：跳过本地转发与 127.0.0.1 映射')
      await syncBorrowedRules(cfg, targets, { log })
    } else {
      // One tunnel engine per machine: borrow dsh-ris-ide's when it is installed,
      // so the IDE dialog and this plugin never fight over 127.0.0.1:1521.
      const borrowed = await ensureBorrowedProxy(cfg, targets, { log, mapping: true })
      if (borrowed.mode === 'ide') {
        if (borrowed.ok !== true) return `代理引擎启动失败：${borrowed.error}`
      } else {
        if (!(await isForwarderUp(cfg))) {
          log(`socks 转发器启动: ${targets.map((t) => `127.0.0.1:${Number.isInteger(t.localPort) ? t.localPort : (t.isRedis === true ? cfg.redisForwardPort : cfg.dbForwardPort)}→${t.host}:${t.port}`).join(', ')}`)
          await startForwarder(cfg, targets)
        }
      }
    }
    // Keep the redirector profile in step with the rule table either way: the
    // user may start ProxyBridge right after this launch.
    const synced = await syncRedirectorProfile(cfg)
    if (synced.available === true) {
      log(synced.running === true
        ? `ProxyBridge: 系统层拦截运行中（profile ${synced.rules} 条规则）`
        : `ProxyBridge: profile 已导出（${synced.rules} 条规则），启用系统层拦截需执行：${synced.command}`)
    }
    // git honours SOCKS through its own config, so dsh-git and plain `git`
    // commands inherit the tunnel without a per-command `-c http.proxy`.
    if (cfg.gitProxy !== 'off' && cfg.git !== null) {
      const gitResult = await applyGitProxy(cfg, { enabled: true })
      log(gitResult.ok === true ? `git 代理已写入：${gitResult.key}` : `git 代理未写入：${gitResult.error}`)
    }
  }
  return true
}

/**
 * Best-effort rollback for a failed launch: stop the forwarder we started
 * during prepareStart so an aborted start leaves no orphan tunnel.
 */
async function rollbackForwarder(cfg) {
  try { await stopBorrowedProxy(cfg) } catch { /* best effort */ }
  try { await stopForwarder(cfg) } catch { /* best effort */ }
}

/**
 * One line telling the operator which launch mode is active and, for a direct
 * launch on a tunneled machine, which config dir YonCode will read. Kept next to
 * the command so `yds ide apply` output and docs can never disagree.
 * @param cfg - resolved plugin config.
 * @returns the note, ending with a newline.
 */
function launchModeNote(cfg) {
  if (cfg.launchMode === 'direct') {
    if (cfg.socks === null) return 'launch 模式: direct（未配置 SOCKS，整机直连；config 已是原始地址）\n'
    const missing = !existsSync(join(cfg.configDirectDir, 'yms_middleware.json'))
    return `launch 模式: direct（YonCode 不设代理）; config -> ${cfg.configDirectDir}`
      + `${missing ? '（⚠️ 缺少直连副本：先运行 yds confcenter）' : ''}\n`
      + '（YonCode 端代理参数需为未注入：yds yoncode patch --no-socks）\n'
  }
  if (cfg.socks === null) return 'launch 模式: proxy（未配置 SOCKS，实际直连）\n'
  return `launch 模式: proxy; YonCode -> -DsocksProxyHost=${cfg.socks.host}:${cfg.socks.port}; config -> ${cfg.configDir}\n`
}

export async function run(argv, { cwd = process.cwd() } = {}) {
  const [cmd, ...rest] = argv
  const flags = parseFlags(rest)
  const { config: cfg, problems } = resolveConfig(cwd)

  switch (cmd) {
    case 'doctor': {
      const st = cfg.module != null ? await status(cfg) : null
      // Companion plugin is optional: when the borrowed engine is missing we say
      // so once, with what it would buy (one shared engine + system interception),
      // and never make it a problem of this workspace.
      const engineAvailable = cfg.socks !== null && cfg.proxyEngine !== 'self' && (await loadIdeProxy(cfg)).available === true
      const siblingHint = cfg.socks !== null && cfg.proxyEngine !== 'self' && !engineAvailable
        ? '\n提示: 未检测到 dsh-ris-ide（可选）。装上后可在同一个 dsh 里启停本地服务、查看实时日志、做断点调试；不装也不影响本插件的功能。\n'
        : ''
      // WSL note: when the callback address is not on any local interface
      // (NAT-mode WSL or a public DNAT address), the gateway cannot dial
      // back without port forwarding — surface it instead of failing silently.
      let netWarn = ''
      if (cfg.module != null && typeof cfg.serverBindAddress === 'string') {
        const locals = new Set()
        for (const addrs of Object.values(os.networkInterfaces())) {
          for (const a of addrs ?? []) locals.add(a.address)
        }
        if (!locals.has(cfg.serverBindAddress)) {
          netWarn = `\n警告: 回调地址 ${cfg.serverBindAddress} 不在本机网卡上${IS_WSL ? '（WSL NAT 模式或外网映射地址——网关回连需要端口转发/公网映射，参见 SKILL.md）' : '（外网映射地址——确认已映射到本机）'}\n`
        }
      }
      return text(`$ yds doctor\n${describeConfig(cfg)}\n${netWarn}`
        + siblingHint
        + `socks 转发器: ${cfg.socks === null ? '不适用（未配置）' : (await isForwarderUp(cfg) ? '运行中' : '未运行')}\n`
        + `yms-home: ${ymsHomeIsBuilt(cfg) ? '已构建' : '未构建'}\n`
        + `${describeYoncode(detectYoncode(cfg))}\n`
        + (st !== null ? `YMS: ${st.process ? `pid ${st.process.pid}` : '未运行'}${st.ready !== null ? `, /_yms/ready=${st.ready}` : ''}\n` : '')
        + ((st === null || !st.process) ? '提示: 运行 yds start 可拉起本地运行时（YMS）；yds start 会写代理规则与转发器\n' : '')
        + (problems.length > 0 ? `\n问题:\n- ${problems.join('\n- ')}` : '\n无配置问题'))
    }
    case 'config': {
      return text(describeConfig(cfg) + (problems.length > 0 ? `\n\n问题:\n- ${problems.join('\n- ')}` : ''))
    }
    case 'token': {
      const url = flags._[0]
      if (url === undefined) throw new Error('用法: yds token <完整URL>')
      mustCred(cfg)
      const token = await getYycToken(url, cfg.accessKey, cfg.accessSecret)
      return text(token)
    }
    case 'confcenter': {
      let files
      if (flags['--offline'] === true) {
        files = readConfCache(cfg)
        if (files['yms_middleware.json'] === undefined) throw new Error('无 confcenter 缓存（先联网拉取一次）')
      } else {
        files = await pullConfcenter(cfg)
        writeConfCache(cfg, files)
      }
      const result = adaptAndWriteConfig(cfg, files)
      writeConfCache(cfg, result.files) // cache the merged ip_node_mapping too
      // The two launch modes get physically separate config dirs: config/ is
      // the adapted copy (127.0.0.1) read by a proxy launch; config-direct/ is
      // the untouched copy read by a direct launch on a machine where dsh still
      // tunnels. Write both here so they never drift; with no SOCKS there is
      // only one mode, so drop the split copy instead of leaving a stale one.
      let directNote
      if (cfg.socks !== null) {
        adaptAndWriteConfig(cfg, files, { rewrite: false, dir: cfg.configDirectDir })
        directNote = `直连副本 -> ${cfg.configDirectDir}（原始地址；只有 ide.launch=direct 读它）\n`
      } else {
        rmSync(cfg.configDirectDir, { recursive: true, force: true })
        directNote = ''
      }
      return text(`confcenter -> ${cfg.configDir}\n模式: ${result.mode}\n${directNote}文件: yms_middleware.json / module_config.json / yonbip_config.json / ip_node_mapping.json\n`
        + `回调: ${cfg.module} -> ${cfg.serverBindAddress}:${cfg.serverPort}\n`
        + (result.mode === 'socks' ? `转发目标: ${result.dbTargets.map((t) => `${t.host}:${t.port}`).join(', ')}\n（下一步: yds start 会自动起本地转发器 127.0.0.1:${cfg.dbForwardPort}/${cfg.redisForwardPort}）` : '直连模式: 使用配置中的原始地址'))
    }
    case 'build': {
      if (problems.length > 0 && cfg.workbenchUrl === '') warnProblems(problems)
      const settingsXml = ensureMavenSettings(cfg)
      const bootstrap = findBootstrapDir(cfg)
      const result = await buildYmsHome(cfg, {
        onStdout: (t) => process.stdout.write(t),
      })
      // pull + adapt config right after a fresh build
      let conf = ''
      try {
        const files = await pullConfcenter(cfg)
        writeConfCache(cfg, files)
        adaptAndWriteConfig(cfg, files)
        conf = 'confcenter 配置已拉取并适配。\n'
      } catch (e) {
        conf = `confcenter 拉取失败（${e.message}）——可离线用缓存: yds confcenter --offline\n`
      }
      return text(`构建完成: ${cfg.ymsHome}\nbootstrap: ${bootstrap}\nmaven settings: ${settingsXml}\n${conf}`)
    }
    case 'start': {
      const jvmArgs = splitJvmArgs(flags['--jvm-args'])
      const foreground = flags['--foreground'] === true
      // shared prep pipeline: build (auto) -> config -> socks forwarder.
      // log() output lands in stdout — in foreground mode that is the
      // dsh-ris-ide run-with-log.sh capture, so mvn/progress is trackable
      // via ris_dev_logs.
      const log = (t) => process.stdout.write(`[yds] ${t}\n`)
      // Hold a lease BEFORE the tunnel comes up: prepareStart may start the shared
      // risd engine, and a 3 s lease sweep would tear it down in the window before
      // the YMS pid exists (review D-P1-2). The CLI pid stands in until then.
      const earlyLease = await holdBorrowedLease(cfg, { ownerPid: process.pid, log })
      const prep = await prepareStart(cfg, { log })
      if (prep !== true) {
        if (foreground) process.stderr.write(`[yds] 启动中止: ${prep}\n`)
        return fail(`启动中止: ${prep}`)
      }
      if (foreground) {
        // Foreground mode hands the process to dsh-ris-ide and never returns, so the
        // cookie has to be calibrated BEFORE the JVM starts (same value it will use).
        const healedEarly = await healBrowserCookie(cfg, { log, budgetMs: 5000 })
        if (healedEarly.ok !== true) log(`浏览器 rdbga 未校准：${healedEarly.reason}（不影响启动）`)
        log(`前台启动 YMS（Liberty，日志同时输出到这里）`)
        log(`rdbga 回调: ${cfg.module},${cfg.context}@${cfg.serverBindAddress}:${cfg.serverPort} (base64 ${rdbgaValue(cfg)})`)
        log(browserCookieHint(cfg, rdbgaValue(cfg)))
        // Foreground CLI lives exactly as long as the JVM: it is the lease owner.
        await holdBorrowedLease(cfg, { ownerPid: process.pid, log })
        const child = startForeground(cfg, { jvmArgs })
        return new Promise((resolve_, reject_) => {
          child.once('error', reject_)
          child.once('close', (code) => resolve_(text(`YMS 前台退出 code=${code}`)))
        })
      }
      let result
      try {
        result = await startDetached(cfg, { jvmArgs })
      } catch (e) {
        await rollbackForwarder(cfg)
        throw e
      }
      if (result.unknown === true) {
        // Do NOT start a second YMS and do NOT kill blindly: the pidfile owner could
        // not be identified (PowerShell/EPERM/timeout), which used to be conflated with
        // "not our process" (review D-P1-6).
        await rollbackForwarder(cfg)
        if (earlyLease.ok === true) await dropBorrowedLease(earlyLease.id, { log })
        return fail(`无法确认 YMS 是否在运行：pidfile 指向 pid ${result.pid}，但${result.reason}。`
          + `\n为避免重复启动或误杀，已中止；请手动确认该进程后删除 ${join(cfg.stateDir, 'yms.pid')}`)
      }
      // The YMS process outlives this CLI, so it owns the risd lease: the engine
      // (and its 127.0.0.1 shadows) must stay up while YMS runs.
      if (typeof result.pid === 'number' && result.pid > 0) {
        await holdBorrowedLease(cfg, { ownerPid: result.pid, log })
        // The YMS pid now owns the lease; the CLI's stand-in would otherwise keep
        // the engine alive for a process that has exited.
        if (earlyLease.ok === true) await dropBorrowedLease(earlyLease.id, { log })
      }
      if (result.alreadyRunning === true) {
        const healed = await healBrowserCookie(cfg, { log })
        const healNote = healed.ok === true ? `浏览器 rdbga 已校准（清理 ${healed.removed} 个）` : `浏览器 rdbga 未校准：${healed.reason}`
        return text(`YMS 已在运行 pid=${result.pid}\n${healNote}`)
      }
      // The browser usually opens BEFORE the JVM is ready, so the rdbga it was given
      // can be empty/stale by now: calibrate it as part of a successful start.
      const healed = await healBrowserCookie(cfg, { log })
      const healNote = healed.ok === true ? `浏览器 rdbga 已校准（清理 ${healed.removed} 个）` : `浏览器 rdbga 未校准：${healed.reason}`
      return text(`YMS 已启动 pid=${result.pid}, 端口 ${cfg.ymsPort}, 日志 ${result.consoleLog}\n`
        + `${healNote}\n`
        + `回调 rdbga: ${cfg.module},${cfg.context}@${cfg.serverBindAddress}:${cfg.serverPort} (base64 ${rdbgaValue(cfg)})\n`
        + browserCookieHint(cfg, rdbgaValue(cfg)))
    }
    case 'stop': {
      const log = (line) => process.stdout.write(`[yds] ${line}\n`)
      const force = flags['--force'] === true
      const yms = await stopYms(cfg)
      // A stop must not pull the tunnel out from under a YMS that is still running:
      // when the pidfile proves a process exists but it could not be stopped (or its
      // identity is `unknown`), abort BEFORE touching rules/forwarder/layers
      // (review D-P1-2). `--force` is the explicit override.
      const abort = stopAbortReason(yms, { force })
      if (abort !== '') return fail(abort)
      if (yms.stopped !== true && force) log('--force：未能确认 YMS 已停止，仍继续撤掉隧道规则')
      // `--keep-socks` keeps only the bundled forwarder. It cannot keep the engine:
      // the YMS pid that owned the risd lease is already gone, so the daemon's 3 s
      // sweep would reap the lease and settle the tunnel anyway (review D-P2-7).
      // Rules are withdrawn and the machine layers settle in every case.
      const keepSocks = flags['--keep-socks'] === true
      // Release our daemon lease before withdrawing the rules: with the lease still
      // held the daemon would keep the engine for a dead YMS pid.
      await releaseBorrowedLease(cfg, { log })
      const borrowed = await stopBorrowedProxy(cfg, { log })
      const own = keepSocks ? { stopped: false, reason: '保留（--keep-socks）' } : await stopForwarder(cfg)
      const stopped = [borrowed, own].filter((r) => r && r.stopped === true)
      // Two tunnels can exist (a daemon engine the daemon keeps, plus our own
      // forwarder): report them separately instead of letting the engine line hide
      // whether the forwarder was kept or stopped (review D-P2-7).
      const engineNote = borrowed.engine === 'kept'
        ? `引擎保留（机器共享；${withdrawnText(borrowed.withdrawn)}；daemon 若配置「无租约即拆除代理」会随后关闭）`
        : (stopped.length > 0 ? `已停止 pid=${stopped.map((r) => r.pid).filter(Boolean).join(',')}` : '未运行')
      const forwarderNote = own.stopped === true
        ? `内置 socks 转发器已停止（pid ${own.pid}）`
        : (keepSocks ? '内置 socks 转发器：保留（--keep-socks）' : `内置 socks 转发器：${own.reason ?? '未运行'}`)
      const fwd = { stopped: false, engine: borrowed.engine, reason: `${engineNote}；${forwarderNote}` }
      // Machine-scoped layers that went up with the tunnel come down with it. In the
      // risd tier the daemon already reloaded the bridge while saving the table, so
      // pass its note instead of reloading the bridge locally a second time
      // (review D-P2-10).
      const side = await stopBorrowedSideEffects(cfg, {
        log,
        daemonReload: borrowed.mode === 'risd' ? (borrowed.reloadNote ?? '') : null,
      })
      const bridgeLine = side.redirector.stopped === true
        ? `已停止 pid=${side.redirector.pid}`
        : (side.redirector.reason ?? '未运行')
      const gitLine = side.git.key !== undefined && side.git.key !== '' ? `已清除 ${side.git.key}` : '未写入'
      return text(`YMS: ${yms.stopped ? `已停止 pid=${yms.pid}` : yms.reason}\nsocks 转发器: ${fwd.stopped ? `已停止 pid=${fwd.pid}` : fwd.reason}\n系统层拦截: ${bridgeLine}\ngit 代理: ${gitLine}`)
    }
    case 'fe': {
      // The dev server serves the extender at /static; the platform page loads it
      // from /mdf-wh/<domainKey>/… — the override rules bridge the two, and every
      // value in them comes from the project config, never from the old copy.
      const sub = flags._[0] ?? 'rules'
      const feUsage = '用法: yds fe [rules|plan|url <page>]'
      if (sub !== 'rules' && sub !== 'plan' && sub !== 'url') return fail(`未知动作: ${sub}\n${feUsage}`)
      const feArgProblem = checkArgs(flags, { positionals: sub === 'url' ? 2 : 1 })
      if (feArgProblem !== '') return fail(`${feArgProblem}\n${feUsage}`)
      const fe = feConfig(cfg)
      if (fe.module === '') return fail('未能识别模块名（需要 yonbuilder.json 或已部署的 yms-home/modules）——先 yds config 检查项目')
      if (sub === 'rules') {
        const written = writeOverrideRules(cfg)
        const crx = fe.crxPath === '' ? '(插件未带 assets/' + 'yds-chrome-resource-override.crx)' : fe.crxPath
        return text([
          `模块: ${written.module}   工作台: ${written.host}   前端端口: ${written.fePort}`,
          `规则文件: ${written.path}（${written.rules} 条）`,
          '',
          '用法一（Chrome 扩展 Resource Override）：',
          `  1) 安装 ${crx}`,
          '  2) 扩展里导入上面这个 JSON（Import rules）',
          `  3) 页面请求 ${written.module} 的 extend*.min.js 会被换成 http://127.0.0.1:${written.fePort}/static/…`,
          '',
          '用法二（不装扩展）：yds fe plan 拿到 正则+替换 清单，用浏览器 CDP Fetch 拦截自行改路',
          `用法三（零配置）：页面 URL 追加 scriptUrl=http://127.0.0.1:${written.fePort}/static`,
        ].join('\n'))
      }
      if (sub === 'plan') {
        const redirects = requestRedirects(cfg)
        return text([
          `模块 ${fe.module} · 前端端口 ${fe.fePort} · 共 ${redirects.length} 条`,
          '',
          ...redirects.map((item) => `#${item.id}  ${item.match}\n     → ${item.replace}\n     regex: ${item.regex}`),
        ].join('\n'))
      }
      if (sub === 'url') {
        const page = flags._[1] ?? ''
        if (page === '') return fail('用法: yds fe url <页面URL或站内路径>')
        const url = pageUrlWithScriptUrl(cfg, page)
        if (url === '') return fail('无法构造 URL：需要 .vscode/settings.json 里的 yds.workbenchUrl')
        return text(url)
      }
      return fail(feUsage)
    }
    case 'status': {
      const st = await status(cfg)
      let fwd = '不适用'
      if (cfg.socks !== null) {
        const borrowed = await borrowedProxyStatus(cfg)
        // The engine has an owner, and the label must say which one: a risd daemon
        // engine is not the borrowed dsh-ris-ide engine (review D-P2-14).
        const owner = borrowed.mode === 'risd' ? 'risd daemon 引擎' : '借用 dsh-ris-ide 引擎'
        if (borrowed.available === true) {
          fwd = borrowed.running
            ? `运行中（${owner} pid ${borrowed.pid ?? '?'}）`
            : `未运行（${owner}可用，yds start 会拉起）`
        } else {
          fwd = (await isForwarderUp(cfg)) ? '运行中（内置转发器）' : `未运行（${borrowed.error ?? '代理引擎不可用'}）`
        }
      }
      const processLine = st.process
        ? `pid ${st.process.pid}${st.processUnknown === true ? `（身份未确认：${st.process.reason ?? '探测失败'}）` : ''}`
        : '未运行'
      return text(`YMS 进程: ${processLine}\n端口 ${cfg.ymsPort}: ${st.port ? '监听中' : '未监听'}\n/_yms/ready: ${st.ready ?? '不可达'}\nyms-home: ${st.ymsHomeBuilt ? '已构建' : '未构建'}\nconfig: ${st.configPresent ? '已就绪' : '缺失'}\nsocks 转发器: ${fwd}` + (st.process ? '' : '\n提示: 运行 yds start 可拉起本地运行时（YMS）；未构建时先 yds build'))
    }
    case 'logs': {
      const lines = Number(flags['--lines'] ?? 80) || 80
      const consoleLog = tailFile(join(cfg.stateDir, 'yms-console.log'), lines)
      const appLog = tailFile(join(cfg.ymsHome, 'logs', 'c-ass-kk-hans', 'yms-application.log'), lines)
        ?? tailFile(join(cfg.ymsHome, 'logs', `${cfg.module}`, 'yms-application.log'), lines)
      return text([consoleLog && `--- yms-console.log ---\n${consoleLog}`, appLog && `--- yms-application.log ---\n${appLog}`].filter(Boolean).join('\n') || '无日志')
    }
    case 'ide': {
      const action = flags._[0] ?? 'check'
      const ideUsage = '用法: yds ide [apply|remove|check]'
      if (action !== 'apply' && action !== 'remove' && action !== 'check') return fail(`未知动作: ${action}\n${ideUsage}`)
      const ideArgProblem = checkArgs(flags, { positionals: 1 })
      if (ideArgProblem !== '') return fail(`${ideArgProblem}\n${ideUsage}`)
      if (action === 'apply') {
        const yonWarn = yoncodeWarning(detectYoncode(cfg))
        const watch = registerWorkspace(cfg.workspace)
        const r = applyIdeConfig(cfg)
        const l = applyLaunchConfig(cfg)
        const ok = !r.error && !l.error && watch.ok === true
        return (ok ? text : fail)(
          `.dsh-ris-ide/config.json: ${r.action}${r.changed ? '（已写入）' : ''}${r.error ? ` —— ${r.error}` : ''}\n`
          + `条目: ${JSON.stringify(r.entry ?? ourEntry(cfg), null, 2)}\n`
          + `.vscode/launch.json: ${l.action}${l.changed ? '（已写入）' : ''}${l.error ? ` —— ${l.error}` : ''}\n`
          + `launch 条目: ${JSON.stringify(l.entry ?? ourLaunchEntry(cfg), null, 2)}\n`
          + launchModeNote(cfg)
          + (Array.isArray(r.renamed) && r.renamed.length > 0
            ? `条目按项目文件改名: ${r.renamed.map((item) => `${item.from} → ${item.to}`).join('，')}\n`
            : '')
          + (Array.isArray(r.disabled) && r.disabled.length > 0
            ? `已禁用被 yds 启动器取代的后端条目: ${r.disabled.map((item) => item.name).join('，')}\n`
            : '')
          + (Array.isArray(r.cleaned) && r.cleaned.length > 0
            ? `已清除误挂到其它条目的 yds startCommand: ${r.cleaned.map((item) => item.name).join('，')}\n`
            : '')
          + (watch.ok === true
            ? `监听已开启（共 ${watch.workspaces.length} 个工作区）：ris-ide 初始化/刷新配置后自动补回本条目\n`
            : `监听注册失败: ${watch.error}\n`)
          + `之后可用 ris_dev_start/ris_dev_debug 启停调试 ${entryName(cfg)}；YonCode 端 F5 用 ${LAUNCH_ENTRY_NAME}`
          + (yonWarn === null ? '' : `\n\n注意: ${yonWarn}`),
        )
      }
      if (action === 'remove') {
        const r = removeIdeConfig(cfg)
        const l = removeLaunchConfig(cfg)
        const watch = unregisterWorkspace(cfg.workspace)
        return text(
          `.dsh-ris-ide/config.json: ${r.action}\n.vscode/launch.json: ${l.action}`
          + `\n监听: 已停止（剩余 ${watch.workspaces.length} 个工作区）`,
        )
      }
      const current = readIdeConfig(cwd)
      const entry = current.parsed?.programs?.find((p) => p?.name === entryName(cfg))
      const launch = readLaunchConfig(launchRoot(cfg))
      const launchEntry = launch.parsed?.configurations?.find((c) => c?.name === LAUNCH_ENTRY_NAME)
      return text(
        `.dsh-ris-ide/config.json: ${current.exists ? current.path : '（不存在）'}\n`
        + `yds 条目: ${entry ? JSON.stringify(entry, null, 2) : '缺失（yds ide apply 添加）'}\n`
        + `.vscode/launch.json: ${launch.exists ? launch.path : '（不存在）'}\n`
        + `yds launch 条目: ${launchEntry ? LAUNCH_ENTRY_NAME + '（在）' : '缺失（yds ide apply 添加）'}`,
      )
    }
    case 'yoncode': {
      // YonCode advertises whatever address settings.json holds, but refuses to
      // launch unless it is a local NIC IP. Our runs use a callback address
      // (NAT / WSL / port forward), so the check has to become a warning.
      const action = flags._[0] ?? 'status'
      const yoncodeUsage = '用法: yds yoncode [status|patch|revert]（patch 可加 --no-socks）'
      if (action !== 'status' && action !== 'patch' && action !== 'revert') return fail(`未知动作: ${action}\n${yoncodeUsage}`)
      const yoncodeArgProblem = checkArgs(flags, { positionals: 1, allowed: ['--no-socks'] })
      if (yoncodeArgProblem !== '') return fail(`${yoncodeArgProblem}\n${yoncodeUsage}`)
      const detected = detectYoncode(cfg)
      if (action === 'status') {
        const socks = detected.socksState === 'patched'
          ? `JVM 代理参数: 已注入${cfg.socks === null || cfg.socks === undefined ? '（.env 未配置 socks，值无法校验）' : `（${cfg.socks.host}:${cfg.socks.port}）`}`
          : 'JVM 代理参数: 未注入'
        return text(`${describeYoncode(detected)}\n${socks}`)
      }
      if (action === 'patch') {
        // `--no-socks` keeps the NIC fix only: the JVM flags are a workaround for
        // ProxyBridge's WinDivert path, and some setups do not need it.
        // launch mode decides the default: a direct-mode YonCode must not get
        // -DsocksProxyHost, otherwise the very next F5 mixes the two modes even
        // though launch.json is clean. `--no-socks` still wins for the odd case.
        const wantSocks = '--no-socks' in flags ? null : (cfg.launchMode === 'direct' ? null : (cfg.socks ?? null))
        const r = patchYoncode(detected, { socks: wantSocks })
        if (r.ok && !r.changed) return text(`不需要修改：${describeYoncode(detected)}`)
        if (!r.ok) {
          return fail(`打补丁失败：${r.error}${r.needElevation ? '\n需要写 YonCode 安装目录的权限：用管理员身份运行一次，或把 DSH 会话策略设为 danger-full-access 后重试' : ''}`)
        }
        const done = [`已把 serverBindAddress 校验改为告警`]
        if (r.socksState === 'patched' && wantSocks !== null && wantSocks !== undefined) {
          done.push(`已给 YMS 启动参数注入 -DsocksProxyHost=${cfg.socks.host} -DsocksProxyPort=${cfg.socks.port}（java 不再走 ProxyBridge）`)
        }
        return text(`${done.join('；')}（备份 ${detected.file}.bak）。重启 YonCode（Reload Window）后生效。`)
      }
      if (action === 'revert') {
        const r = restoreYoncode(detected)
        if (!r.ok) {
          return fail(`还原失败：${r.error}${r.needElevation ? '\n需要写 YonCode 安装目录的权限（管理员或 danger-full-access）' : ''}`)
        }
        return text('已从 .bak 还原 YonCode 原始文件；Reload Window 后恢复原校验行为。')
      }
      return fail(yoncodeUsage)
    }
    case 'proxy': {
      // Borrowed-engine control surface: the same engine the IDE's 🌐 dialog
      // shows, so a rule written here is visible there and vice versa.
      const action = flags._[0] ?? 'status'
      const proxyUsage = '用法: yds proxy [status|sync|start|stop|git-on|git-off|redirector [status|sync]]'
      const proxyActions = ['status', 'sync', 'start', 'stop', 'git-on', 'git-off', 'redirector']
      if (proxyActions.includes(action) !== true) return fail(`未知动作: ${action}\n${proxyUsage}`)
      const proxyArgProblem = checkArgs(flags, { positionals: action === 'redirector' ? 2 : 1 })
      if (proxyArgProblem !== '') return fail(`${proxyArgProblem}\n${proxyUsage}`)
      const loaded = await loadIdeProxy(cfg)
      cfg.__ideProxy = loaded
      // Tiers: a running risd daemon is enough (it owns the engine even when this
      // process cannot locate the dsh-ris-ide module), then the borrowed engine of
      // an installed dsh-ris-ide, then the bundled SOCKS forwarder as last resort.
      const risd = await probeRisd()
      // dsh-ris-ide is optional: without it the bundled SOCKS forwarder is the
      // tunnel (the same fallback `yds start` uses in prepareStart). Only the
      // actions that genuinely need an engine (rules, the panel) report absence.
      const engineMissing = loaded.available !== true && risd.usable !== true
      const engineNote = engineMissing
        ? `代理引擎不可用：${loaded.error}\n（未安装 dsh-ris-ide 时 yds 使用内置 socks 转发器；也可用 .env 的 proxy.engine=self 强制）`
        : (risd.usable === true ? `代理引擎：risd daemon（pid ${risd.state?.pid ?? '?'}，端口 ${risd.state?.port ?? '?'}）` : '')
      if (engineMissing && action === 'status') {
        const targets = cfg.socks === null ? [] : forwarderTargets(cfg)
        const up = cfg.socks !== null && await isForwarderUp(cfg)
        return text(`${engineNote}\n`
          + `内置转发器: ${cfg.socks === null ? '不适用（未配置 SOCKS，直连模式）' : up ? '运行中（127.0.0.1 兜底映射由它提供）' : '未运行（yds start / yds proxy start 会拉起）'}\n`
          + `转发目标: ${targets.length === 0 ? '(无：confcenter 缓存里没有 DB/Redis 地址)' : targets.map((t) => `${t.host}:${t.port}`).join(', ')}`)
      }
      if (action === 'status') {
        const st = await borrowedProxyStatus(cfg)
        const own = st.rules.filter((rule) => rule.source === 'yds')
        // `loaded.path` is empty when this process cannot load dsh-ris-ide, which is
        // exactly the risd-only case where the engine still has a name: risd:<port>
        // (review D-P2-1).
        return text(`引擎: ${st.path || loaded.path || '(未知)'}\n运行: ${st.running ? `是（pid ${st.pid ?? '?'}）` : '否'}\n监听端口: ${st.listenPort ?? '(未知)'}${Array.isArray(st.listenPorts) && st.listenPorts.length > 0 ? `（引擎监听 ${st.listenPorts.join(', ')}）` : ''}\n`
          + `yds 规则: ${own.length === 0 ? '(尚未生成，yds start 时自动写)' : own.map((rule) => `${rule.hosts}:${rule.ports}${rule.shadow ? ' [127.0.0.1 映射]' : ''}`).join(', ')}\n`
          + `其它规则: ${st.rules.length - own.length} 条（用户/IDE 自己的）`)
      }
      if (action === 'sync' || action === 'start') {
        const targets = forwarderTargets(cfg)
        if (targets.length === 0) return fail('无转发目标（confcenter 缓存里没有 DB/Redis 地址）——先运行 yds confcenter')
        const result = await ensureBorrowedProxy(cfg, targets, { log: (line) => process.stdout.write(`[yds] ${line}\n`) })
        if (result.mode === 'none') return text('直连模式（.env 未配置 SOCKS）：不需要代理引擎，配置里的地址就是可达地址')
        if (result.mode === 'unavailable') {
          // Standalone path: no borrowed engine (dsh-ris-ide absent, or
          // proxy.engine=self) — bring the bundled forwarder up instead.
          const notes = [engineNote]
          if (!(await isForwarderUp(cfg))) {
            const started = await startForwarder(cfg, targets)
            if (started.started !== true) return fail(`${engineNote}\n内置 socks 转发器未启动：${started.reason ?? '(未知原因)'}`)
            notes.push(`内置 socks 转发器已启动（pid ${started.pid}）：${started.targets.join(', ')}`)
          } else {
            notes.push('内置 socks 转发器已在运行')
          }
          const launch = readLaunchConfig(launchRoot(cfg))
          let launchNote = ''
          if (launch.exists && Array.isArray(launch.parsed?.configurations)
            && launch.parsed.configurations.some((c) => c?.name === LAUNCH_ENTRY_NAME)) {
            const applied = applyLaunchConfig(cfg)
            launchNote = `\nlaunch.json: ${applied.action}${applied.changed ? '（已写入 java 代理参数，YonCode/VS Code F5 启动的 java 也会走 SOCKS）' : ''}`
          }
          return text(`${notes.filter(Boolean).join('\n')}${launchNote}`)
        }
        if (result.ok !== true) return fail(`代理引擎启动失败：${result.error ?? '(未返回原因)'}`)
        // A tunnel exists now: let YonCode's own F5 run use it too (we cannot
        // intercept a process we do not spawn, but launch.json travels with it).
        const launch = readLaunchConfig(launchRoot(cfg))
        let launchNote = ''
        if (launch.exists && Array.isArray(launch.parsed?.configurations)
          && launch.parsed.configurations.some((c) => c?.name === LAUNCH_ENTRY_NAME)) {
          const applied = applyLaunchConfig(cfg)
          launchNote = `\nlaunch.json: ${applied.action}${applied.changed ? '（已写入 java 代理参数，YonCode/VS Code F5 启动的 java 也会走 SOCKS）' : ''}`
        }
        // What the engine binds is not the same thing as the 127.0.0.1 mappings YMS
        // needs: the daemon's shadows are same-port, while the adapted config points at
        // dbForwardPort/redisForwardPort and is served by the bundled forwarder. So the
        // message names the engine's listeners, and `proxy start` brings that forwarder
        // up exactly like `yds start` does (review D-P2-4).
        const listenPorts = Array.isArray(result.listenPorts) ? result.listenPorts : (result.shadowPorts ?? [])
        const notes = [`代理引擎已就绪（pid ${result.pid ?? '?'}）：引擎监听 ${listenPorts.length} 个端口${listenPorts.length > 0 ? `（${listenPorts.join(', ')}）` : ''}`]
        if (result.mode === 'risd' && cfg.socks !== null) {
          if (await isForwarderUp(cfg)) {
            notes.push('内置 socks 转发器已在运行（127.0.0.1 兜底映射）')
          } else {
            try {
              const started = await startForwarder(cfg, targets)
              notes.push(started.started === true
                ? `内置 socks 转发器已启动（pid ${started.pid}）：${started.targets.join(', ')}`
                : `内置 socks 转发器未启动：${started.reason ?? '(未知原因)'}`)
            } catch (e) {
              notes.push(`内置 socks 转发器未启动：${e.message}`)
            }
          }
        }
        return text(`${notes.join('\n')}${launchNote}`)
      }
      if (action === 'stop') {
        const r = engineMissing
          ? { ok: false, error: loaded.error }
          : await stopBorrowedProxy(cfg, { log: (line) => process.stdout.write(`[yds] ${line}\n`) })
        // The bundled forwarder is a tunnel too: stopping the proxy has to take
        // it down whether or not dsh-ris-ide is installed.
        const fwd = cfg.socks === null
          ? { stopped: false, reason: 'socks 未配置（直连模式）' }
          : await stopForwarder(cfg).catch((error) => ({ stopped: false, reason: String(error?.message ?? error) }))
        // The tunnel is gone, so the flags it justified must go too — otherwise
        // YonCode's next F5 points java at a dead loopback port.
        const stripped = stripLaunchProxy(cfg)
        const stopNote = stripped.changed
          ? '\nlaunch.json: 已移除 java 代理参数（-DsocksProxyHost/-DsocksProxyPort）'
          : ''
        const engineLine = r.engine === 'kept'
          ? (r.mode === 'risd'
            ? `risd: 已释放租约，${withdrawnText(r.withdrawn)}（引擎保留；若 daemon 生命周期配置为「无租约即拆除代理」，会在约 300ms 后关闭）`
            : `代理引擎保留（机器共享，IDE 可继续用）；${withdrawnText(r.withdrawn)}`)
          : r.ok === true || r.stopped === true
            ? '代理引擎已停止'
            : engineMissing ? `代理引擎未启用（${loaded.error}）` : `代理引擎未停止：${r.error ?? r.reason ?? '未运行'}`
        const fwdLine = fwd.stopped === true ? `\n内置转发器已停止（pid ${fwd.pid}）` : ''
        return text(engineLine + fwdLine + stopNote)
      }
      if (action === 'git-on' || action === 'git-off') {
        const r = await applyGitProxy(cfg, { enabled: action === 'git-on' })
        return r.ok === true
          ? text(`git ${action === 'git-on' ? '代理已写入' : '代理已清除'}：${r.key}`)
          : fail(`git 操作失败：${r.error}`)
      }
      if (action === 'redirector') {
        // ProxyBridge bridge: export/status only. Starting it needs root/UAC, so
        // the command is reported for the user (or an agent with rights) to run.
        const sub = flags._[1] ?? 'status'
        const redirectorUsage = '用法: yds proxy redirector [status|sync]'
        if (sub !== 'status' && sub !== 'sync') return fail(`未知动作: ${sub}\n${redirectorUsage}`)
        const loaded = await loadIdeRedirector(cfg)
        if (loaded.available !== true) {
          const message = 'ProxyBridge 适配器不可用（dsh-ris-ide 未安装或版本过旧）'
          // status only reports availability; sync was asked to export a profile.
          return sub === 'status' ? text(message) : fail(message)
        }
        const status = loaded.mod.redirectorStatus()
        const describe = (side, label) => {
          const state = status[side] ?? {}
          return `${label}: ${state.available === true ? state.path + (state.version ? ` (v${state.version})` : '') : '未安装'}`
        }
        if (sub === 'status') {
          return text([
            describe('local', '本侧'),
            describe('windows', 'Windows'),
            `profile: ${status.profilePath}${status.profileExists ? '' : '（尚未导出）'}`,
            // Two sides, two answers: a Windows engine does nothing for processes in
            // WSL, and vice versa, so the label has to say which one is up.
            `运行: ${status.running ? `${status.runningSide === 'windows' ? 'Windows 侧' : '本侧'}（pid ${status.pid}）` : '否（本侧需要 root，Windows 侧需要管理员）'}`,
            '',
            '生命周期：随 yds start 自动启动（提权走系统弹窗）、随 yds stop 自动停止；',
            '手动：yds proxy redirector start|stop，或执行 sync 输出的命令',
          ].join('\n'))
        }
        if (sub === 'sync') {
          const result = await syncRedirectorProfile(cfg)
          if (result.available !== true) return fail(`导出失败：${result.reason ?? '(未知原因)'}`)
          return text([
            `profile: ${result.profilePath}（${result.rules} 条规则）`,
            result.running ? 'ProxyBridge 已在运行：重启后新规则才生效' : '启动命令（需要 sudo / 管理员）：',
            result.command,
          ].join('\n'))
        }
        return fail(redirectorUsage)
      }
      return fail(proxyUsage)
    }
    case 'browser': {
      // The workbench browser is where rdbga must live: an empty host-only cookie
      // silently sends every request to the remote pod (page fine, local log empty,
      // breakpoints never hit). status shows it, fix repairs it, --dry-run previews.
      const usageLine = '用法: yds browser [status|fix] [--rdbga=<base64>] [--dry-run]'
      const action = flags._[0] ?? 'status'
      if (action !== 'status' && action !== 'fix') return fail(`未知动作: ${action}\n${usageLine}`)
      const argProblem = checkArgs(flags, { positionals: 1, allowed: ['--rdbga', '--dry-run'] })
      if (argProblem !== '') return fail(`${argProblem}\n${usageLine}`)
      if ('--rdbga' in flags && (typeof flags['--rdbga'] !== 'string' || flags['--rdbga'].trim() === '')) {
        return fail(`--rdbga 需要一个 base64 值\n${usageLine}`)
      }
      const dryRun = flags['--dry-run'] === true
      if (dryRun && action !== 'fix') return fail(`--dry-run 只用于 fix（status 只读）\n${usageLine}`)
      const override = typeof flags['--rdbga'] === 'string' ? flags['--rdbga'] : ''
      // Probe the browser before asking the JVM: with no DevTools port there is nowhere
      // to write, so the 1–2s PowerShell query would be wasted (m7).
      const found = await findWorkbenchPort(cfg)
      if (found.port === 0) return fail(`${found.error}\n${noDevtoolsHint(cfg)}`)
      if (action === 'status') {
        // The cookie read and the JVM query are independent: do both at once.
        const [expected, read] = await Promise.all([
          expectedRdbga(cfg, override),
          readRdbgaCookies({ port: found.port, targets: found.targets, hosts: found.hosts }),
        ])
        const lines = [
          `DevTools: 127.0.0.1:${found.port}（${found.browser || '未知版本'}）`,
          `工作台页签: ${found.targets.length}`,
          `期望 rdbga: ${expected.ok === true ? expected.value : '(无法确定)'}（来源：${expected.source || '无'}）`,
        ]
        if (expected.ok !== true) lines.push(`原因: ${expected.reason}`)
        else if (typeof expected.hint === 'string' && expected.hint !== '') lines.push(`提示: ${expected.hint}`)
        lines.push(read.ok === true
          ? describeRdbgaCookies(read.cookies, expected.ok === true ? expected.value : '', found.hosts)
          : `读取 cookie 失败: ${read.error}`)
        return text(lines.join('\n'))
      }
      // fix: reuse the targets just probed (a second listing can differ).
      const result = await healBrowserCookie(cfg, { override, dryRun, findPort: async () => found })
      if (result.ok !== true) return fail(`${dryRun === true ? '预览失败' : '校准失败'}: ${result.reason}`)
      if (dryRun === true) {
        return text(`预览（--dry-run 未改动浏览器）：将清理 ${result.removed} 个旧/空 cookie，${result.wrote} 个页签将写入 rdbga=${result.expected}（来源 ${result.source}）`)
      }
      return text(`已校准: 清理 ${result.removed} 个旧/空 cookie，${result.tabs} 个页签持有 rdbga=${result.expected}（来源 ${result.source}）`)
    }
    case 'socks-fwd': {
      // internal: long-running forwarder process spawned by startForwarder()
      // argv shape: [--socks=<host:port>] <localPort:targetHost:targetPort>...
      let socksHost = '127.0.0.1'
      let socksPort = 1080
      if (typeof flags['--socks'] === 'string') {
        const [h, p] = flags['--socks'].split(':')
        socksHost = h
        socksPort = Number(p) || 1080
      }
      const specs = []
      for (const arg of flags._) {
        const parts = String(arg).split(':')
        if (parts.length === 3) specs.push({ local: Number(parts[0]), host: parts[1], port: Number(parts[2]) })
      }
      runForwarder(socksHost, socksPort, specs)
      return new Promise(() => { }) // runs until killed
    }
    default:
      return fail(usage())
  }
}

function mustCred(cfg) {
  if (cfg.accessKey == null || cfg.accessSecret == null) throw new Error('缺少 accessKey/accessSecret（settings.json）')
  return [cfg.accessKey, cfg.accessSecret]
}

/** Split a JVM-args string into argv entries, honoring double quotes. */
function splitJvmArgs(raw) {
  if (typeof raw !== 'string') return []
  const out = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i]
    if (c === '"') { inQuote = !inQuote; continue }
    if (c === ' ' && !inQuote) {
      if (cur !== '') { out.push(cur); cur = '' }
      continue
    }
    cur += c
  }
  if (cur !== '') out.push(cur)
  return out
}

const BOOLEAN_FLAGS = new Set(['--foreground', '--offline', '--keep-socks', '--no-socks', '--dry-run', '--force'])

function asFlagValue(v) {
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return v
}

function parseFlags(args) {
  const flags = { _: [] }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        const name = a.slice(0, eq)
        const val = a.slice(eq + 1)
        flags[name] = BOOLEAN_FLAGS.has(name) ? asFlagValue(val) : val
      } else if (BOOLEAN_FLAGS.has(a)) flags[a] = true
      else { const next = args[i + 1]; flags[a] = next; i += 1 }
    } else flags._.push(a)
  }
  return flags
}

function warnProblems(problems) {
  process.stderr.write(`警告:\n- ${problems.join('\n- ')}\n`)
}

/** Hosts whose cookies are the workbench's; derived from config, never hardcoded. */
function workbenchHosts(cfg) {
  try { return hostVariants(new URL(String(cfg.workbenchUrl)).hostname) } catch { return [] }
}

/**
 * The rdbga the local YMS uses, plus where that value came from.
 *
 * Writing a guessed value is worse than writing nothing: `fix` deletes the working
 * cookie first, so a wrong value sends the gateway to an instance that does not exist.
 * Hence: only a value we can verify is returned, and a JVM that reports a DIFFERENT
 * value aborts instead of being overruled.
 * @param {object} cfg resolved plugin config
 * @param {string} override --rdbga value (highest priority)
 * @param {{liveQuery?: () => Promise<{ok: boolean, values: string[], error: string}>}} options
 */
export async function expectedRdbga(cfg, override = '', { liveQuery = rdbgaFromRunningJvm } = {}) {
  if (override !== '') {
    return isPlausibleRdbga(override) === true
      ? { ok: true, value: override, source: '命令行指定' }
      : { ok: false, value: '', source: '', reason: '--rdbga 不是合法值（应为 base64("module,/context@ip:port")）' }
  }
  if (cfg.module == null) {
    return { ok: false, value: '', source: '', reason: '未识别模块名——请在项目目录下运行（或补 yonbuilder.json）' }
  }
  const bind = String(cfg.serverBindAddress ?? '')
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(bind) !== true) {
    return { ok: false, value: '', source: '', reason: '缺少合法的 serverBindAddress（回调地址）——补项目 .vscode/settings.json 的 yds.serverBindAddress' }
  }
  const port = Number(cfg.serverPort)
  if (Number.isInteger(port) !== true || port < 1 || port > 65535) {
    return { ok: false, value: '', source: '', reason: '缺少合法的 serverPort——补项目 .vscode/settings.json 的 yds.serverPort' }
  }
  let own = ''
  try { own = rdbgaValue(cfg) } catch (e) { return { ok: false, value: '', source: '', reason: e.message } }
  const live = await liveQuery()
  if (live.ok === true && live.values.length > 0) {
    if (live.values.includes(own)) return { ok: true, value: own, source: '运行中的 JVM' }
    return {
      ok: false, value: '', source: '运行中的 JVM',
      reason: `运行中的 JVM 用的是另一个 rdbga（${live.values.length} 个实例：${live.values.map((v) => `${String(v).slice(0, 10)}…`).join(', ')}；与配置值 ${own.slice(0, 10)}… 都不一致）——多实例时用 --rdbga=<值> 指定，或先停掉别的实例`,
    }
  }
  if (isPlausibleRdbga(own) !== true) return { ok: false, value: '', source: '', reason: '按配置算出的 rdbga 不合法' }
  return { ok: true, value: own, source: '本机配置', hint: live.error }
}

/** First DevTools port that actually holds a workbench tab (not just any open port). */
async function findWorkbenchPort(cfg) {
  const hosts = workbenchHosts(cfg)
  if (hosts.length === 0) return { port: 0, targets: [], hosts, error: `无法从 workbenchUrl 推断工作台域名（${cfg.workbenchUrl || '缺失'}）` }
  for (const port of DEVTOOLS_PORTS) {
    const listed = await workbenchTargets(port, { hosts })
    if (listed.ok === true && listed.targets.length > 0) {
      const version = await probeDevtoolsPorts([port])
      return { port, targets: listed.targets, hosts, browser: version.browser, error: '' }
    }
  }
  return { port: 0, targets: [], hosts, error: '没有开着工作台页签的 DevTools 端口（浏览器未启动或未打开工作台）' }
}

/**
 * Where to plant the cookie by hand. `workbenchUrl` may be missing (running outside the
 * project), and interpolating it blindly produced a dangling "在  域下" — so the missing
 * case gets its own sentence.
 */
export function browserCookieHint(cfg, value) {
  const url = String(cfg?.workbenchUrl ?? '').trim()
  if (url === '') {
    return `浏览器侧: workbenchUrl 未配置——先进入项目目录/补 .vscode/settings.json 的 yds.workbenchUrl，再在浏览器里种 cookie rdbga=${value}`
  }
  return `浏览器侧: 在 ${url} 域下种 cookie rdbga=${value}`
}

/** Why there is nothing to calibrate, with the same empty-URL care as browserCookieHint. */
export function noDevtoolsHint(cfg) {
  const url = String(cfg?.workbenchUrl ?? '').trim()
  if (url === '') {
    return '（workbenchUrl 未配置，且浏览器没有开 DevTools 端口——先进入项目目录/补 .vscode/settings.json 的 yds.workbenchUrl，打开工作台后重试）'
  }
  return `（浏览器没有开 DevTools 端口——先打开工作台页面再重试；也可手工在 ${url} 域下种 cookie rdbga=<yds start 输出的值>）`
}

/**
 * Repair the workbench browser's rdbga cookie. Never throws and never blocks the caller
 * for long: a browser whose DevTools socket accepts but stops answering must not hang
 * `yds start` (the value of the deadline is that the CLI still reports the start).
 * @param {object} cfg
 * @param {{log?: (line: string) => void, override?: string, budgetMs?: number, dryRun?: boolean,
 *   findPort?: Function, repair?: Function, read?: Function, liveQuery?: Function}} options
 */
export async function healBrowserCookie(cfg, {
  log,
  override = '',
  budgetMs = 8000,
  dryRun = false,
  findPort = findWorkbenchPort,
  repair = repairRdbgaCookie,
  read = readRdbgaCookies,
  liveQuery = rdbgaFromRunningJvm,
} = {}) {
  const work = (async () => {
    // The browser is probed FIRST: with no DevTools port the expected value has nowhere
    // to go, so the 1–2s PowerShell lookup is not paid for nothing (m7).
    const found = await findPort(cfg)
    if (found.port === 0) return { ok: false, reason: found.error, expected: '', source: '' }
    const expected = await expectedRdbga(cfg, override, { liveQuery })
    if (expected.ok !== true) return { ok: false, reason: expected.reason, expected: '' }
    // Reuse the targets just listed: a second /json/list may see a different tab set.
    const result = await repair({ port: found.port, expected: expected.value, hosts: found.hosts, targets: found.targets, dryRun })
    if (result.ok !== true) return { ok: false, reason: result.error, expected: expected.value, source: expected.source, port: found.port }
    if (dryRun === true) {
      if (typeof log === 'function') log(`浏览器 rdbga 预览（--dry-run）：将清理 ${result.removed} 个，${result.wrote} 个页签将写入（来源 ${expected.source}）`)
      return { ...result, port: found.port, expected: expected.value, source: expected.source, dryRun: true }
    }
    // Read back: only a single, correct cookie means the gateway will route here.
    const after = await read({ port: found.port, targets: found.targets, hosts: found.hosts })
    if (after.ok !== true) {
      // A silent "success" with an unreadable cookie store would be a lie: the whole
      // point of the read-back is to prove the gateway will route here.
      return { ok: false, reason: `写入后回读 cookie 失败: ${after.error}`, expected: expected.value, source: expected.source, port: found.port }
    }
    const verdict = classifyRdbgaCookies(after.cookies, expected.value, found.hosts)
    if (verdict.keep.length !== 1 || verdict.remove.length !== 0) {
      return { ok: false, reason: '写入后仍有多个/错误的 rdbga（请手动检查浏览器）', expected: expected.value, source: expected.source, port: found.port }
    }
    if (typeof log === 'function') log(`浏览器 rdbga 已校准（端口 ${found.port}，清理 ${result.removed} 个，${result.tabs} 个页签，来源 ${expected.source}）`)
    return { ...result, port: found.port, expected: expected.value, source: expected.source }
  })()
  // The budget may win the race; a later failure of `work` must not surface as unhandled.
  work.catch(() => {})
  let timer = null
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `浏览器校准超时（${budgetMs}ms）`, expected: '' }), budgetMs)
  })
  try {
    return await Promise.race([work, budget])
  } catch (e) {
    return { ok: false, reason: e.message, expected: '', source: '' }
  } finally {
    // Without this the pending timer keeps the event loop (and the CLI) alive for the
    // whole budget even when the repair already succeeded.
    clearTimeout(timer)
  }
}

function usage() {
  return [
    'yds — YonBIP YDS 本地运行时 (dsh-ris-yds)',
    '',
    '用法: node yds.js <command> [options]',
    '  doctor                 环境体检：配置解析/运行状态/缺失项',
    '  config                 显示生效配置（来源: settings.json + .env + env）',
    '  token <url>            生成 YYCToken',
    '  confcenter [--offline] 拉取(或用缓存)并适配 4 个 YMS 配置到 yms-home/config',
    '  build                  maven 部署 yms-home（首次含 kernel 下载）+ 拉配置',
    '  start [--jvm-args "…"] 后台启动 YMS（SOCKS 自动转发; 幂等）',
    '  start --foreground     前台启动（dsh-ris-ide startCommand 用）',
    '  stop [--keep-socks] [--force]  停 YMS（默认连转发器一起停；--force 表示无法确认 YMS 已停也继续撤规则）',
    '  status                 进程/端口/ready/配置状态',
    '  logs [--lines N]       tail 控制台与应用日志',
    '  ide [apply|remove|check] 维护 .dsh-ris-ide/config.json 的 yds 程序条目（+ .vscode/launch.json）',
    '  proxy [status|sync|start|stop|git-on|git-off] 借用 dsh-ris-ide 的代理引擎',
    '  proxy redirector [status|sync]                ProxyBridge 系统层拦截（需 root/管理员启动）',
    '  browser [status|fix] [--rdbga=<base64>] [--dry-run]  工作台浏览器 rdbga cookie 体检/校准（--dry-run 只预览）',
    '  fe [rules|plan|url <page>]                    前端调试接入（Resource Override 规则 / CDP 改路清单 / scriptUrl）',
    '  yoncode [status|patch|revert] YonCode 网卡 IP 校验：检测/改为告警/还原',
    '          patch --no-socks  只改网卡校验，不注入 JVM 代理参数',
    '',
    '配置来源（优先级 env > .env > settings.json > 默认）:',
    '  yonasset/.vscode/settings.json   项目标准配置（YonCode 兼容，只读）',
    '  <workspace>/.env         可选机器配置: socks.host/port, git.*,',
    '                                   ymsHome, java.path, maven.*（ymsPort 自动选空闲端口）',
    '',
    '失败时退出码非 0：bin 落地 run() 返回的 exitCode，agent 工具结果里带 ok:false。',
  ].join('\n')
}

function text(value) {
  return { text: value }
}

/** A failed command: text plus the non-zero exit code the bin (or tool) applies. */
function fail(value) {
  return { text: value, exitCode: 1 }
}

/**
 * Why `yds stop` must abort after stopYms, or '' when it may continue. A YMS with a
 * live pid that could not be stopped (or whose identity is `unknown`) must keep its
 * tunnel: withdrawing rules/forwarder/layers under it is the D-P1-2 bug. Exported so
 * the guard is unit-testable without spawning a real YMS.
 * @param {{stopped?: boolean, pid?: number|string, reason?: string}} yms
 * @param {{force?: boolean}} [options]
 * @returns {string} '' to continue, otherwise the abort message body
 */
export function stopAbortReason(yms, { force = false } = {}) {
  if (force === true) return ''
  if (yms?.stopped === true) return ''
  const pid = Number(yms?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return ''
  return `YMS 可能仍在运行（pid ${pid}）：${yms?.reason ?? '未能确认已停止'}\n`
    + '为避免把仍在运行的服务抽掉隧道，已中止：yds 规则、内置转发器、系统层拦截都未改动。\n'
    + '请先确认该进程（ps / 任务管理器）或修复权限后重试；确需强行撤掉规则时加 --force。'
}

/**
 * How much of the yds rule set a stop actually removed. `yds stop` used to print
 * "已撤掉 yds 规则" unconditionally, which was a lie both when it removed nothing and
 * when it silently deleted another workspace's hosts (review D-P0-1). The table is one
 * global list and a stop removes every yds row, so the text reports exactly that.
 */
export function withdrawnText(withdrawn) {
  const rules = Number(withdrawn?.rules ?? 0)
  const hosts = Number(withdrawn?.hosts ?? 0)
  if (!Number.isFinite(rules) || !Number.isFinite(hosts) || (rules <= 0 && hosts <= 0)) {
    return '共享规则表里没有 yds 规则（未改动）'
  }
  const parts = []
  if (rules > 0) parts.push(`${rules} 条规则`)
  if (hosts > 0) parts.push(`${hosts} 个 host`)
  return `已从共享规则表移除 yds 的 ${parts.join('、')}（全局一张表，不区分 workspace）`
}

/**
 * Reject stray positionals/options instead of silently ignoring them: `yds browser fixx`
 * used to run nothing and still report success.
 * @returns {string} human-readable problem ('' when the arguments are fine)
 */
function checkArgs(flags, { positionals = 0, allowed = [] } = {}) {
  const extra = flags._.slice(positionals)
  if (extra.length > 0) return `多余参数: ${extra.join(' ')}`
  const unknown = Object.keys(flags).filter((key) => key !== '_' && !allowed.includes(key))
  if (unknown.length > 0) return `未知选项: ${unknown.join(' ')}`
  return ''
}
