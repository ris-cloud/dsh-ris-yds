// YMS runtime: build the launch (env + JVM flags + rdbga), start in foreground
// (for the dsh-ris-ide run-with-log wrapper) or detached (own pidfile + logs),
// stop, status. Ports the proven work/start-yms.sh logic into cross-OS node.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, renameSync, readSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { portOpen } from './socks.js'
import { pidIdentity, stopPid } from './proc.js'
import { ymsHomeIsBuilt } from './build.js'

export function ymsPidFile(cfg) {
  return join(cfg.stateDir, 'yms.pid')
}

// EXACT flag set from the proven work/start-yms.sh (YonCode launch template).
// Do NOT edit module/package pairs from memory — wrong module names are
// silently ignored by the JVM and break Liberty JNDI init (observed:
// PseudoContext "no JNDI feature is configured" forever, module deploy fails).
// The last 2 exports + 3 opens come from the YonCode-generated
// .vscode/launch.json (ensureLaunchConfig) — same provenance, kept in sync.
const ADD_EXPORTS = [
  'java.base/sun.security.action=ALL-UNNAMED',
  'java.naming/com.sun.jndi.ldap=ALL-UNNAMED',
  'java.naming/com.sun.jndi.url.ldap=ALL-UNNAMED',
  'jdk.naming.dns/com.sun.jndi.dns=ALL-UNNAMED',
  'jdk.naming.dns/com.sun.jndi.url.dns=ALL-UNNAMED',
  'java.security.jgss/sun.security.krb5.internal=ALL-UNNAMED',
  'jdk.attach/sun.tools.attach=ALL-UNNAMED',
  'jdk.management.agent/jdk.internal.agent=ALL-UNNAMED',
  'java.base/jdk.internal.vm=ALL-UNNAMED',
]
const ADD_OPENS = [
  'java.base/java.util=ALL-UNNAMED',
  'java.base/java.lang=ALL-UNNAMED',
  'java.base/java.util.concurrent=ALL-UNNAMED',
  'java.base/java.io=ALL-UNNAMED',
  'java.base/java.nio=ALL-UNNAMED',
  'java.base/sun.nio.ch=ALL-UNNAMED',
  'java.naming/javax.naming.spi=ALL-UNNAMED',
  'java.naming/com.sun.naming.internal=ALL-UNNAMED',
  'jdk.naming.rmi/com.sun.jndi.url.rmi=ALL-UNNAMED',
  'java.naming/javax.naming=ALL-UNNAMED',
  'java.rmi/java.rmi=ALL-UNNAMED',
  'java.sql/java.sql=ALL-UNNAMED',
  'java.management/javax.management=ALL-UNNAMED',
  'java.base/java.lang.reflect=ALL-UNNAMED',
  'java.desktop/java.awt.image=ALL-UNNAMED',
  'java.base/java.security=ALL-UNNAMED',
  'java.base/java.net=ALL-UNNAMED',
  'java.base/java.text=ALL-UNNAMED',
  'java.base/sun.net.www.protocol.https=ALL-UNNAMED',
]

/**
 * rdbga cookie value (base64 of "module,/context@bind:port").
 *
 * Every part is validated: a half-filled config used to produce
 * `base64("null,/@null:31010")`, and browser tools would then happily write that into
 * the workbench — pointing the gateway at an instance that cannot exist. Fail loudly.
 */
export function rdbgaValue(cfg) {
  if (cfg.module == null) throw new Error('rdbga 值缺少 module——先在项目目录下运行（yonbuilder.json / module.xml）')
  const bind = String(cfg.serverBindAddress ?? '')
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(bind) !== true) {
    throw new Error('rdbga 值缺少合法的 serverBindAddress（IPv4）——补项目 .vscode/settings.json 的 yds.serverBindAddress')
  }
  const port = Number(cfg.serverPort)
  if (Number.isInteger(port) !== true || port < 1 || port > 65535) {
    throw new Error('rdbga 值缺少合法的 serverPort——补项目 .vscode/settings.json 的 yds.serverPort')
  }
  const context = String(cfg.context ?? '')
  const raw = `${cfg.module},${context}@${bind}:${port}`
  return Buffer.from(raw, 'utf8').toString('base64')
}

/** Full launch description: env, jvm args, args. */
export function launchSpec(cfg, { jvmArgs = [] } = {}) {
  if (cfg.module == null) throw new Error('未识别模块名')
  const logsDir = join(cfg.ymsHome, 'logs')
  const env = {
    ...process.env,
    mw_profiles_active: cfg.env,
    YDS_STATE: 'debugging',
    access_key: cfg.accessKey ?? '',
    access_secret: cfg.accessSecret ?? '',
    'access.key': cfg.accessKey ?? '',
    'access.secret': cfg.accessSecret ?? '',
    enable_cloud_debug: 'true',
    YMS_ENABLE_MODULE: cfg.module,
    yms_enable_module: cfg.module,
  }
  const jvm = [
    `-DYMS_WORK_PATH=${join(cfg.ymsHome, 'workarea')}`,
    '-DYMS-DEV=true',
    '-DYMS-DEV-MODE=debug',
    `-Dyms.log.path=${logsDir}`,
    `-Dyms.dev.libProjectsFile=${join(cfg.ymsHome, '.libraryProjects.list')}`,
    `-Dapp.metainfo.preferred-networks=${cfg.serverBindAddress}`,
    '-Dapp.metainfo.ping_connect_timeout=200',
    `-Ddomain.url=${cfg.workbenchUrl}`,
    `-Dserver.port=${cfg.ymsPort}`,
    `-Drdbga=${rdbgaValue(cfg)}`,
    // start_mode=static: server discovery reads config/ip_node_mapping.json
    // instead of eureka (unreachable from a dev machine) — from YonCode's
    // generated .vscode/launch.json. Makes outbound RPC fall back to the
    // domain.url cloud-debug rewrite for unreachable pod instances.
    '-Dapp.metainfo.start_mode=static',
    '-Dyms_fetch_config_version=2.0.0',
    '-Dyms.bootstrap.enableNewConfig=true',
    ...ADD_EXPORTS.map((v) => `--add-exports=${v}`),
    ...ADD_OPENS.map((v) => `--add-opens=${v}`),
    ...jvmArgs.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()),
  ]
  return { java: cfg.java, env, jvm, main: 'iuap.yms.YMSLauncher', cp: join(cfg.ymsHome, 'yms.jar'), logsDir }
}

/** Ensure .javaExecutable / .libraryProjects.list exist so the home is self-contained. */
export function ensureHomeMarkers(cfg) {
  if (cfg.java == null) throw new Error('未找到 JDK')
  const exe = join(cfg.ymsHome, '.javaExecutable')
  if (!existsSync(exe)) writeFileSync(exe, cfg.java + '\n', 'utf8')
  const libs = join(cfg.ymsHome, '.libraryProjects.list')
  if (!existsSync(libs)) writeFileSync(libs, '\n', 'utf8')
}

/**
 * Detached start: spawn java setsid, stdout/stderr -> yms-console.log,
 * pidfile in .dsh-ris-yds/yms.pid. Returns { started, pid } or
 * { alreadyRunning }.
 */
/** Remember the port the running instance listens on (read back by config). */
function rememberPort(cfg) {
  try {
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(join(cfg.stateDir, 'yms-port'), `${cfg.ymsPort}\n`, { encoding: 'utf8' })
  } catch { /* the port file is a convenience, never a requirement */ }
}

export async function startDetached(cfg, { jvmArgs = [] } = {}) {
  const pidFile = ymsPidFile(cfg)
  const running = await readRunning(cfg)
  if (running !== null) {
    if (running.state === 'unknown') {
      return { started: false, alreadyRunning: false, unknown: true, pid: running.pid, reason: running.reason }
    }
    return { started: false, alreadyRunning: true, pid: running.pid }
  }
  if (!ymsHomeIsBuilt(cfg)) throw new Error('yms-home 未构建（先执行 yds build）')
  if (cfg.java == null) throw new Error('未找到 JDK——用 .env 的 java.path 或 JAVA_HOME 指定')
  if (cfg.module == null) throw new Error('未识别模块名——检查项目 yonbuilder.json / module.xml')
  const spec = launchSpec(cfg, { jvmArgs })
  ensureHomeMarkers(cfg)
  rememberPort(cfg)
  mkdirSync(cfg.stateDir, { recursive: true })
  const log = join(cfg.stateDir, 'yms-console.log')
  // crude rotation: keep the last full log, never let it grow unbounded
  try {
    const st = statSync(log)
    if (st.size > 16 * 1024 * 1024) renameSync(log, `${log}.old`)
  } catch { /* absent */ }
  const out = openSync(log, 'a')
  const err = openSync(log, 'a')
  const child = spawn(spec.java, [...spec.jvm, '-cp', spec.cp, spec.main], {
    cwd: cfg.ymsHome,
    env: spec.env,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  })
  child.unref()
  // parent copies of the log fds are dup'd into the child; close ours
  try { closeSync(out) } catch { /* ignore */ }
  try { closeSync(err) } catch { /* ignore */ }
  writeFileSync(pidFile, String(child.pid), 'utf8')
  // wait for the Liberty port to accept (~35s typical; hard budget 120s)
  let up = false
  for (let i = 0; i < 120 && !up; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    up = await portOpen('127.0.0.1', cfg.ymsPort, 500)
    if (!up) {
      try { process.kill(child.pid, 0) } catch { throw new Error('YMS 进程已退出，查看 .dsh-ris-yds/yms-console.log') }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!up) {
    // TERM → grace → KILL (Windows: taskkill /T /F) so a half-started java tree cannot
    // survive the failure and keep the port (review D-P2-5); the pidfile only goes
    // away once the process is actually gone.
    try { await stopPid(child.pid, { graceMs: 5000, group: true }) } catch { /* best effort */ }
    try { unlinkSync(pidFile) } catch { /* ignore */ }
    throw new Error(`YMS 端口 ${cfg.ymsPort} 在 120 秒内未就绪——查看 ${log}`)
  }
  return { started: true, pid: child.pid, port: cfg.ymsPort, consoleLog: log }
}

/** Foreground start: java as our child, signals forwarded (for run-with-log wrappers). */
export function startForeground(cfg, { jvmArgs = [], onStdout, signal } = {}) {
  if (!ymsHomeIsBuilt(cfg)) throw new Error('yms-home 未构建（先执行 yds build）')
  if (cfg.java == null) throw new Error('未找到 JDK——用 .env 的 java.path 或 JAVA_HOME 指定')
  if (cfg.module == null) throw new Error('未识别模块名——检查项目 yonbuilder.json / module.xml')
  const spec = launchSpec(cfg, { jvmArgs })
  ensureHomeMarkers(cfg)
  const child = spawn(spec.java, [...spec.jvm, '-cp', spec.cp, spec.main], {
    cwd: cfg.ymsHome,
    env: spec.env,
    stdio: ['inherit', 'inherit', 'inherit'],
    signal,
    windowsHide: true,
  })
  const fwd = (sig) => {
    try { child.kill(sig) } catch { /* ignore */ }
  }
  process.on('SIGTERM', () => fwd('SIGTERM'))
  process.on('SIGINT', () => fwd('SIGINT'))
  // record the java pid so `yds status` / `yds stop` are not blind to
  // IDE-started (foreground) instances; unlink when the child goes away.
  try {
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(ymsPidFile(cfg), String(child.pid), 'utf8')
    child.once('close', () => { try { unlinkSync(ymsPidFile(cfg)) } catch { /* ignore */ } })
  } catch { /* best effort */ }
  return child
}

const YMS_MARKERS = ['yms.jar', 'YMSLauncher']

/**
 * Identity of a pidfile owner: `ours` / `foreign` / `dead` / `unknown`. The four-way
 * answer matters: a probe that could not read the command line must never be treated
 * as "not our process" (that deletes the pidfile and starts a second YMS — review
 * D-P1-6).
 * @returns {{state: 'ours'|'foreign'|'dead'|'unknown', commandLine: string}}
 */
export function probeYmsPid(pid, options = {}) {
  return pidIdentity(pid, YMS_MARKERS, options)
}

/**
 * Read the pidfile; verify the process is alive AND ours.
 * @returns {null | {pid: number, state?: 'unknown', reason?: string}}
 *   `null` when absent/stale/foreign (the stale pidfile is unlinked). An `unknown`
 *   entry keeps the pidfile and must be treated as "do not start a second one, do not
 *   kill it blindly".
 */
export async function readRunning(cfg, options = {}) {
  const pidFile = ymsPidFile(cfg)
  if (!existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    try { unlinkSync(pidFile) } catch { /* ignore */ }
    return null
  }
  const identity = probeYmsPid(pid, options)
  if (identity.state === 'ours') return { pid }
  if (identity.state === 'dead' || identity.state === 'foreign') {
    // Gone, or the pid was reused by an unrelated process after a crash/reboot.
    try { unlinkSync(pidFile) } catch { /* ignore */ }
    return null
  }
  return {
    pid,
    state: 'unknown',
    reason: '无法确认 pidfile 进程身份（命令行为空或探测失败），已保留 pidfile 未动',
  }
}

/** Stop the detached YMS: TERM, grace (YMS is slow), KILL; Windows uses taskkill /T /F. */
export async function stopYms(cfg, { graceMs = 30000, ...options } = {}) {
  const running = await readRunning(cfg, options) // identity-verified: never kills a reused pid
  if (running === null) return { stopped: false, reason: '未在运行' }
  if (running.state === 'unknown') {
    return {
      stopped: false,
      pid: running.pid,
      reason: `${running.reason}；为避免误杀，未发送停止信号（请手动确认该 pid）`,
    }
  }
  // Windows has no graceful signal path: taskkill the tree; POSIX TERM→grace→KILL.
  const killed = await stopPid(running.pid, { graceMs, ...options })
  if (killed.ok !== true) {
    // Keep the pidfile so `yds status` still shows the process (review D-P1-7).
    return { stopped: false, pid: running.pid, reason: `停止失败：${killed.error ?? '未知原因'}（已保留 pidfile）` }
  }
  try { unlinkSync(ymsPidFile(cfg)) } catch { /* ignore */ }
  return { stopped: true, pid: running.pid }
}

/** Status row: process + port + forwarder + config state. */
export async function status(cfg) {
  const running = await readRunning(cfg) // identity-checked
  const port = await portOpen('127.0.0.1', cfg.ymsPort, 800)
  let ready = null
  if (port === true) {
    ready = await httpGet(`http://127.0.0.1:${cfg.ymsPort}/_yms/ready`, 3000)
  }
  return {
    process: running,
    processUnknown: running !== null && running.state === 'unknown',
    port,
    ready: ready !== null ? ready.status : null,
    ymsHomeBuilt: ymsHomeIsBuilt(cfg),
    configPresent: existsSync(join(cfg.ymsHome, 'config', 'yms_middleware.json')),
    socksForwarder: cfg.socks === null ? null : await portOpen('127.0.0.1', cfg.dbForwardPort, 300),
  }
}

function httpGet(url, timeout) {
  return new Promise((resolve_) => {
    const done = (value) => resolve_(value)
    const r = http.get(url, (res) => { res.resume(); done({ status: res.statusCode }) })
    r.setTimeout(timeout, () => { r.destroy(); done(null) })
    r.once('error', () => done(null))
  })
}

/** Tail helper for yds logs — reads only the last 256KB (log can be huge). */
export function tailFile(path, lines = 80) {
  if (!existsSync(path)) return null
  const st = statSync(path)
  const readSize = Math.min(st.size, 256 * 1024)
  const fh = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(readSize)
    readSync(fh, buf, 0, readSize, st.size - readSize)
    const text = buf.toString('utf8')
    const all = text.split('\n')
    // first line may be a partial line from the mid-file cut — drop it
    if (readSize < st.size && all.length > 1) all.shift()
    return all.slice(-lines).join('\n')
  } finally {
    closeSync(fh)
  }
}
