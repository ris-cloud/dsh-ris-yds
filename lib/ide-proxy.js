// Borrow dsh-ris-ide's proxy engine instead of running a second tunnel stack.
//
// The IDE plugin owns `.dsh-ris-ide/proxy.json` and a single engine process that
// can (a) bind `127.0.0.1:<port>` shadows for literal IPv4 targets and (b) serve
// an HTTP CONNECT proxy restricted by the rule table. YDS needs exactly (a): the
// YMS runtime's JDBC/Redis endpoints are rewritten to `127.0.0.1:<same port>`, so
// the engine's shadows ARE the old `socks-forward.js` — with one owner for the
// ports, one pidfile, and a UI the user can inspect.
//
// So this module does not transport anything by itself: it generates the
// `source: 'yds'` rules (replaced wholesale on every start, user rows untouched),
// makes sure the engine is running them, and (optionally) writes the scoped git
// proxy entry so plain `git` commands — not just ones we spawn — honour SOCKS.
//
// When dsh-ris-ide is not installed the caller falls back to `lib/socks.js`, so
// the plugin still works on a machine that has only dsh-ris-yds.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { yoncodeCandidates } from './yoncode.js'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

/** Marker `source` used for every rule this plugin owns. */
export const YDS_RULE_SOURCE = 'yds'

/** Where a dsh-ris-ide checkout/install may keep its proxy engine. */
export function ideProxyCandidates(cfg) {
  const list = []
  const explicit = process.env.YDS_IDE_PROXY
  if (typeof explicit === 'string' && explicit !== '') list.push(explicit)
  const workspace = typeof cfg?.workspace === 'string' ? cfg.workspace : ''
  if (workspace !== '') {
    // A link-installed plugin lives in the profile's node_modules; a workspace
    // install (or a sibling checkout) is the other common layout.
    list.push(join(workspace, 'node_modules', 'dsh-ris-ide', 'lib', 'proxy.js'))
    list.push(join(workspace, 'work', 'dsh-ris-ide', 'lib', 'proxy.js'))
    list.push(join(workspace, '..', 'dsh-ris-ide', 'lib', 'proxy.js'))
  }
  list.push(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-ris-ide', 'lib', 'proxy.js'))
  return list
}

/**
 * Resolve and import the IDE's proxy engine.
 * @returns {Promise<{available: boolean, path: string, mod: object|null, error: string}>}
 */
export async function loadIdeProxy(cfg) {
  const explicit = process.env.YDS_IDE_PROXY
  // `none` is the documented off switch (same effect as proxy.engine=self, but
  // it also drops the search): tests and machines with a broken install use it.
  if (explicit === 'none') return { available: false, path: '', mod: null, error: '已通过 YDS_IDE_PROXY=none 禁用' }
  const tried = []
  let lastError = ''
  for (const candidate of ideProxyCandidates(cfg)) {
    tried.push(candidate)
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.startProxy !== 'function' || typeof mod.mergeConfigs !== 'function') {
        lastError = `模块不完整（缺少 startProxy/mergeConfigs）: ${candidate}`
        if (candidate === explicit) break
        continue
      }
      return { available: true, path: candidate, mod, error: '' }
    } catch (error) {
      lastError = `${candidate}: ${error?.message ?? error}`
      // An explicit override that exists but does not load is decisive: falling
      // through to the profile install would hide the user's broken setting.
      if (candidate === explicit) break
    }
  }
  return { available: false, path: '', mod: null, error: lastError === '' ? `未找到 dsh-ris-ide 的代理引擎（已尝试 ${tried.length} 处）` : lastError }
}

/**
 * Resolve the IDE's ProxyBridge adapter (the system-level interceptor).
 *
 * It is a SIBLING module of the proxy engine (`lib/redirector.js` in the same
 * install), so a machine with the engine always has it. Loading it is optional:
 * the bridge then exports the same rule table as a `.pbprofile` and reports the
 * command that would start it (starting needs root/UAC, which we never have).
 * @param {object} cfg - resolved yds config.
 * @returns {Promise<{available: boolean, path: string, mod: object|null}>}
 */
export async function loadIdeRedirector(cfg) {
  const engine = await loadIdeProxy(cfg)
  if (engine.available === false) return { available: false, path: '', mod: null }
  const candidate = join(dirname(engine.path), 'redirector.js')
  if (!existsSync(candidate)) return { available: false, path: candidate, mod: null }
  try {
    const mod = await import(pathToFileURL(candidate).href)
    if (typeof mod.syncRedirector !== 'function' || typeof mod.redirectorStatus !== 'function') {
      return { available: false, path: candidate, mod: null }
    }
    return { available: true, path: candidate, mod }
  } catch {
    return { available: false, path: candidate, mod: null }
  }
}

/**
 * Export the machine rule table as a ProxyBridge profile.
 *
 * Deliberately never starts it: the process needs root (Linux eBPF) or UAC
 * (Windows WinDivert), and a CLI that silently asked for a password in the middle
 * of `yds start` would be worse than handing back the exact command.
 * @param {object} cfg - resolved yds config.
 * @returns {Promise<{available: boolean, profilePath?: string, rules?: number, command?: string, reason?: string}>}
 */
export async function syncRedirectorProfile(cfg) {
  const loaded = await loadIdeRedirector(cfg)
  if (loaded.available === false) return { available: false, reason: '未找到 dsh-ris-ide 的 ProxyBridge 适配器' }
  const status = loaded.mod.redirectorStatus()
  if (status.local.available !== true && status.windows.available !== true) {
    return { available: false, reason: '未找到 ProxyBridge CLI（本侧与 Windows 侧都没有）' }
  }
  const result = await loaded.mod.syncRedirector(cfg?.workspace ?? '', { start: false })
  const display = typeof result?.command === 'object' && result.command !== null ? String(result.command.display ?? '') : ''
  return {
    available: true,
    profilePath: result?.written?.path ?? status.profilePath,
    rules: result?.written?.rules ?? 0,
    command: display,
    reason: typeof result?.reason === 'string' ? result.reason : '',
    running: status.running === true,
  }
}

/** True for a dotted-quad IPv4 literal (the only host shape a shadow can bind). */
export function isIpv4Literal(host) {
  return typeof host === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/**
 * Whether a literal IPv4 address sits in an RFC1918 range.
 *
 * Only such destinations need interception: a public host (the workbench, the
 * gitlab front door) is reachable from this machine anyway, and routing it
 * through the tunnel would only add a hop.
 * @param {string} host - dotted-quad address.
 * @returns {boolean} true for 10/8, 172.16/12 and 192.168/16.
 */
export function isPrivateIpv4(host) {
  if (!isIpv4Literal(host)) return false
  const [a, b] = host.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * A path the way ProxyBridge compares it: on Windows it always sees backslashes
 * and a drive letter, so a WSL path has to become `D:\...` before it can match
 * anything. POSIX paths (a native Linux YonCode) are returned unchanged.
 */
export function toProcessPattern(value) {
  if (typeof value !== 'string' || value === '') return ''
  const mounted = /^\/mnt\/([a-z])\/(.+)$/i.exec(value)
  if (mounted !== null) return `${mounted[1].toUpperCase()}:\\${mounted[2].replace(/\//g, '\\')}`
  if (/^[A-Za-z]:[\\/]/.test(value) === true || value.includes('\\') === true) return value.replace(/\//g, '\\')
  return value
}

function existingDirectory(value) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function existingFile(value) {
  try {
    return statSync(value).isFile()
  } catch {
    return false
  }
}

/**
 * The executables YonCode itself runs: the JDK and maven it ships, plus the git it
 * shells out to. They live outside the project, so a rule written from the project
 * config would never name them — yet these are exactly the processes that need the
 * tunnel to reach 172.20.235.* and gitlab.
 */
export function yoncodeProcesses(options = {}) {
  const homes = Array.isArray(options.homes) === true ? options.homes : []
  const out = { java: '', git: '', home: '' }
  for (const home of homes) {
    if (typeof home !== 'string' || home === '' || existingDirectory(home) !== true) continue
    const devkit = join(home, 'devkit')
    if (existingDirectory(devkit) === false) continue
    if (out.java === '') {
      let versions = []
      try {
        versions = readdirSync(devkit, { withFileTypes: true })
      } catch {
        versions = []
      }
      for (const entry of versions) {
        if (entry.isDirectory() !== true) continue
        // Only JDK trees: devkit also holds maven/node/etc., and a bare `*` would
        // turn into a ProcessName that matches programs we never meant to intercept.
        if (/^jdk/i.test(entry.name) !== true) continue
        if (existingFile(join(devkit, entry.name, 'bin', 'java.exe')) === false) continue
        // Wildcard the version directory: YonCode upgrades its JDK in place and the
        // rule must survive that.
        // `jdk*\bin\*.exe` covers java.exe/javaw.exe and survives a JDK upgrade.
        out.java = toProcessPattern(join(devkit, 'jdk*', 'bin', '*.exe'))
        out.home = home
        break
      }
    }
    if (out.git === '' && existingFile(join(devkit, 'git', 'bin', 'git.exe')) === true) {
      out.git = toProcessPattern(join(devkit, 'git', 'bin', 'git.exe'))
    }
  }
  if (out.git === '') {
    for (const candidate of Array.isArray(options.gitPaths) === true ? options.gitPaths : []) {
      if (typeof candidate !== 'string' || candidate === '' || existingFile(candidate) !== true) continue
      out.git = toProcessPattern(candidate)
      break
    }
  }
  return out
}

/** Where YonCode runs on this machine, as paths this process can stat. */
export function yoncodeHomes(cfg) {
  const explicit = typeof cfg?.yoncodeHome === 'string' && cfg.yoncodeHome !== ''
    ? [cfg.yoncodeHome]
    : yoncodeCandidates(cfg ?? {})
  return explicit.filter((value) => existingDirectory(value) === true)
}

/**
 * The git YonCode uses when it is not the one bundled with the devkit: the Windows
 * installs reachable from WSL, then whatever `git` resolves to here.
 */
export function candidateGitPaths(options = {}) {
  if (Array.isArray(options.gitPaths) === true) return options.gitPaths
  const out = [
    '/mnt/c/Program Files/Git/bin/git.exe',
    '/mnt/d/Program Files/Git/bin/git.exe',
    '/mnt/c/Program Files/Git/cmd/git.exe',
    '/mnt/d/Program Files/Git/cmd/git.exe',
  ]
  if (process.platform === 'win32') {
    try {
      const where = execFileSync('where.exe', ['git'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
      for (const line of where.split(/\r?\n/)) if (line.trim() !== '') out.unshift(line.trim())
    } catch {
      // Git is optional here: without it the generic `git` rule already covers PATH.
    }
  }
  return out
}

/**
 * Rules that name YonCode's own executables, labelled so the dialog and the
 * ProxyBridge profile say where they came from.
 *
 * `hosts` is the set of private /24 segments the backend really dials, derived from the
 * resolved endpoints: YonCode's java must be redirected to the same place our own
 * `java` rows point, and hardcoding any range would silently miss another environment.
 */
export function yoncodeRules(cfg, options = {}) {
  const withJava = options.java !== false
  const hosts = Array.isArray(options.hosts) ? options.hosts.filter((host) => String(host).trim() !== '') : []
  const found = yoncodeProcesses({
    homes: options.homes ?? yoncodeHomes(cfg),
    gitPaths: options.gitPaths ?? candidateGitPaths(options),
  })
  const workspace = options.workspace ?? cfg?.workspace ?? ''
  const gitHost = options.gitHost ?? ''
  const rules = []
  if (withJava && found.java !== '' && hosts.length > 0) {
    rules.push({
      id: 'yds-yoncode-java',
      label: 'YonCode java',
      program: found.java,
      hosts: hosts.join(','),
      ports: '*',
      enabled: true,
      shadow: false,
      source: YDS_RULE_SOURCE,
      workspace,
    })
  }
  if (found.git !== '' && gitHost !== '') {
    rules.push({
      id: 'yds-yoncode-git',
      label: 'YonCode git',
      program: found.git,
      hosts: gitHost,
      ports: '*',
      enabled: true,
      shadow: false,
      source: YDS_RULE_SOURCE,
      workspace,
    })
  }
  return rules
}

/**
 * The fallback loopback listeners, derived from the same endpoint list.
 *
 * With ProxyBridge down a JDBC/Redis client inside the JVM cannot be told to use
 * SOCKS, so the tunnel is exposed on `127.0.0.1:<same port>` and the adapted config
 * points there instead. These are ENGINE INPUTS, not rule rows: the dialog shows
 * intent (which programs are proxied), never this plumbing.
 * @param {Array<{host: string, port: number}>} targets - endpoints from the config adapter.
 * @returns {Array<{host: string, port: number}>} one listener per literal-IPv4 endpoint.
 */
export function shadowTargetsFromTargets(targets) {
  const out = []
  const seen = new Set()
  for (const target of Array.isArray(targets) ? targets : []) {
    const host = String(target?.host ?? '')
    const port = Number(target?.port)
    if (!isIpv4Literal(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const key = `${host}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ host, port })
  }
  return out
}

/**
 * Rules this project contributes to the machine-wide table.
 *
 * Two rows, both naming a real process: `java` for the internal segment (the JVM
 * is the client of every JDBC/Redis/ES/license endpoint) and `git` for its remote.
 * Endpoints are deliberately NOT rows: a per-endpoint row would have to invent a
 * program name (the old `jdbc` label matched no process at all) and would repeat
 * what the /24 rule already covers.
 * @param {Array<{host: string, port: number}>} targets - endpoints from the config adapter.
 * @param {string} [workspace] - provenance label, not part of the rule identity.
 * @param {{gitHost?: string}} [options] - host of the git remote, when known.
 * @returns {object[]} rule rows in the engine's schema.
 */
// Addresses the backend must reach that are not database/redis endpoints: the
// bind/callback host (relayed back to this machine) and anything the project
// settings name explicitly. Same rule as the endpoints: private ranges only.
export function extraHostsOf(cfg) {
  const hosts = []
  const push = (value) => {
    const text = String(value ?? '').trim()
    if (text === '') return
    const host = text.includes(':') ? text.slice(0, text.lastIndexOf(':')) : text
    if (hosts.includes(host) !== true) hosts.push(host)
  }
  push(cfg?.serverBindAddress)
  return hosts
}

/**
 * Private /24 segments (as `1.2.3.*` patterns) for rows that name an executable
 * instead of a service: the java process calls the same databases/redis as the app.
 */
export function privateSegmentsOf(targets, extraHosts = []) {
  const segments = new Set()
  const add = (host) => {
    const text = String(host ?? '').trim()
    if (isPrivateIpv4(text) !== true) return
    segments.add(`${text.split('.').slice(0, 3).join('.')}.*`)
  }
  for (const target of Array.isArray(targets) ? targets : []) add(target?.host)
  for (const host of Array.isArray(extraHosts) ? extraHosts : []) add(host)
  return [...segments].sort()
}

// `java` defaults to false on purpose: config.js's `proxy.javaRules` also defaults off
// (the YMS JVM gets -DsocksProxyHost from `yds yoncode patch`, and WinDivert resets the
// Oracle TNS handshake). Both entry points must agree, or a direct helper call silently
// turns java interception back on.
export function proxyRulesFromTargets(targets, workspace = '', { gitHost = '', java = false, extraHosts = [] } = {}) {
  const rules = []
  const segments = new Set()
  for (const target of Array.isArray(targets) ? targets : []) {
    const host = String(target?.host ?? '')
    const port = Number(target?.port)
    if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (isPrivateIpv4(host)) segments.add(host.split('.').slice(0, 3).join('.'))
  }
  // Hosts the app itself has to dial that the bootstrap never lists: the callback /
  // bind address (the reverse-proxied machine that relays gateway traffic back here)
  // is such a case — Java cannot reach it without the tunnel either.
  for (const host of Array.isArray(extraHosts) ? extraHosts : []) {
    const value = String(host ?? '').trim()
    if (isPrivateIpv4(value) !== true) continue
    segments.add(value.split('.').slice(0, 3).join('.'))
  }
  // One rule per internal segment and ANY port: the backend also talks to hosts the
  // bootstrap never lists (license, ES, kafka), so a port list would go stale.
  for (const segment of java ? Array.from(segments).sort() : []) {
    rules.push({
      id: `yds-java-${segment.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
      program: 'java',
      hosts: `${segment}.*`,
      ports: '*',
      enabled: true,
      shadow: false,
      source: YDS_RULE_SOURCE,
      workspace,
    })
  }
  // git reaches its remote through the same tunnel; `git config http.<host>.proxy`
  // stays as the belt for terminals that do not go through ProxyBridge.
  if (gitHost !== '') {
    rules.push({
      id: 'yds-git',
      program: 'git',
      hosts: gitHost,
      ports: '*',
      enabled: true,
      shadow: false,
      source: YDS_RULE_SOURCE,
      workspace,
    })
  }
  return rules
}

/** The git host from the configured clone URL, or `''` when it has none. */
export function gitHostOf(cfg) {
  const url = typeof cfg?.git?.url === 'string' ? cfg.git.url : ''
  if (url === '') return ''
  try { return new URL(url).host } catch { return '' }
}

/**
 * Merge the YDS-owned rules into the IDE's proxy config and write it back.
 * @returns {{config: object, rules: object[]}} the merged config.
 */
export function syncProxyConfig(cfg, targets, { log, mapping = true, java = cfg?.proxyJavaRules === true } = {}) {
  const loaded = cfg.__ideProxy
  if (loaded === undefined || loaded === null || loaded.available !== true) throw new Error('代理引擎未加载')
  const mod = loaded.mod
  const rules = [
    ...proxyRulesFromTargets(targets, cfg.workspace ?? '', { gitHost: gitHostOf(cfg), java, extraHosts: extraHostsOf(cfg) }),
    // YonCode runs its own JDK/git from outside the project; without these rows the
    // IDE's java would only be covered by the generic `java` pattern.
    ...yoncodeRules(cfg, {
      gitHost: gitHostOf(cfg),
      workspace: cfg.workspace ?? '',
      java,
      hosts: privateSegmentsOf(targets, extraHostsOf(cfg)),
    }),
  ]
  // Bound only while the system layer is unavailable; in interception mode this is
  // empty, so nothing is bound on loopback at all.
  const shadows = mapping === false ? [] : shadowTargetsFromTargets(targets)
  const stored = mod.readProxyConfig(cfg.workspace)
  const upstream = cfg.socks ?? null
  const merged = mod.mergeConfigs(stored, {
    socks: upstream === null ? { host: '', port: 0 } : { host: upstream.host, port: upstream.port },
    listenPort: cfg.proxyListenPort ?? stored.listenPort,
    // Replacing wholesale is the whole point: rules this plugin wrote last run
    // must disappear when the endpoint list shrinks, while user rows survive.
    replaceRulesFrom: YDS_RULE_SOURCE,
    shadows,
    // The config file is machine-wide now: only this workspace's yds rows are
    // replaced, other workspaces keep theirs.
    workspace: cfg.workspace ?? '',
    rules,
  })
  mod.writeProxyConfig(cfg.workspace, merged)
  log?.(`代理规则已同步：${rules.length} 条（source=${YDS_RULE_SOURCE}）`)
  return { config: merged, rules }
}

/** Run one `git config --global` mutation; a missing git is a reported no-op. */
function runGitConfig(args) {
  return new Promise((resolvePromise) => {
    const child = spawn('git', ['config', '--global', ...args], { windowsHide: true })
    let stderr = ''
    let settled = false
    const done = (result) => { if (!settled) { settled = true; resolvePromise(result) } }
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8') })
    child.on('error', (error) => done({ ok: false, error: String(error?.message ?? error) }))
    child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `git exited with ${code}` }))
  })
}

/**
 * Write (or clear) the scoped git proxy entry, so EVERY git invocation honours
 * SOCKS — including dsh-git's own commands, which never get `-c http.proxy`.
 *
 * The key is scoped to the configured clone host (`http.https://<host>/.proxy`)
 * rather than the global `http.proxy`: a user's other remotes must not silently
 * start going through this tunnel.
 * @returns {Promise<{ok: boolean, key: string, value?: string, error?: string}>}
 */
/**
 * Persist (or forget) "this git proxy entry is ours" for the exit hook.
 *
 * dsh-ris-ide owns the file (`~/.dsh-ris-ide/git-proxy.json`) and its unset is
 * keyed on exactly this record; writing it from the CLI path means a `yds stop`
 * — or simply closing dsh — undoes the entry no matter which side wrote it.
 * @param {object} mod - the loaded dsh-ris-ide proxy module.
 * @param {{key: string, host: string}|null} state - null clears the record.
 */
function recordGitProxyState(mod, state) {
  try {
    if (typeof mod?.proxyHomeDir !== 'function') return
    const dir = mod.proxyHomeDir()
    const path = join(dir, 'git-proxy.json')
    if (state === null) {
      rmSync(path, { force: true })
      return
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // A missing state file only costs the exit-hook undo; never fail the command.
  }
}

export async function applyGitProxy(cfg, { enabled = true } = {}) {
  const loaded = cfg.__ideProxy
  if (loaded === undefined || loaded === null || loaded.available !== true) return { ok: false, key: '', error: '代理引擎未加载' }
  const host = gitHostOf(cfg)
  if (host === '' && enabled) return { ok: false, key: '', error: '未配置 git.url，无法确定要写哪一条 git 代理' }
  const plan = loaded.mod.gitProxyPlan(loaded.mod.readProxyConfig(cfg.workspace), { host, enabled })
  const result = enabled
    ? await runGitConfig([plan.key, plan.value])
    : await runGitConfig(['--unset', plan.key])
  // The Windows-side git has its own config file and cannot resolve the internal
  // host, so the same scoped entry has to be written there too — YonCode runs git on
  // that side of the boundary.
  const windows = typeof loaded.mod.runWindowsGitConfig === 'function'
    ? loaded.mod.runWindowsGitConfig(enabled ? [plan.key, plan.value] : ['--unset', plan.key])
    : { ok: false, skipped: true, error: '引擎版本过旧，不支持 Windows 侧 git' }
  // Record it where dsh-ris-ide keeps the same fact: its exit hook then clears a
  // tunnel we wrote from the CLI, so a dead tunnel never leaves git pointed at it.
  recordGitProxyState(loaded.mod, enabled ? { key: plan.key, host, windows: windows.ok === true } : null)
  return Object.assign({ key: plan.key, value: enabled ? plan.value : '', windows }, result)
}

/**
 * Make sure the IDE engine runs the current YDS rules.
 *
 * A changed rule set needs a restart: the engine binds its shadows at startup and
 * never re-reads the file (that is also why the dialog says "restart to apply").
 * @returns {Promise<{mode: string, ok?: boolean, error?: string, path?: string,
 *   rules?: object[], shadowPorts?: number[], restarted?: boolean}>}
 */
/**
 * Start the system-level interception that pairs with the tunnel.
 *
 * The engine only covers programs we spawn, so the redirector is what makes an
 * IDE-launched java or a terminal git go through the tunnel at all. Elevation is
 * the normal case: a Windows side triggers UAC, a Linux side needs passwordless
 * sudo — a side that cannot be elevated is reported, never fatal.
 * @param {object} cfg - resolved plugin config.
 * @param {{log?: Function}} [options] - logger.
 * @returns {Promise<{available: boolean, started: object[], skipped: object[], running: boolean}>} outcome.
 */
export async function startBorrowedRedirector(cfg, { log, sides } = {}) {
  const loaded = await loadIdeRedirector(cfg)
  if (loaded.available === false) return { available: false, started: [], skipped: [], running: false }
  if (typeof loaded.mod.startRedirectors !== 'function') return { available: false, started: [], skipped: [], running: false }
  // `reload: true` makes an already-running bridge restart with the profile we just
  // wrote — edited yds rules must apply without a manual stop/start (or a new UAC).
  const result = await loaded.mod.startRedirectors(Array.isArray(sides) ? { sides, reload: true } : { reload: true })
  const started = Array.isArray(result?.started) ? result.started : []
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  if (started.length > 0) {
    const reloaded = started.filter((item) => item.reloaded === true)
    const fresh = started.filter((item) => item.reloaded !== true)
    const parts = []
    if (fresh.length > 0) parts.push(`已启动（${fresh.map((item) => `${item.side} pid ${item.pid ?? '?'}`).join('，')}）`)
    if (reloaded.length > 0) parts.push(`已按新规则重载（${reloaded.map((item) => item.side).join('，')}）`)
    log?.(`系统层拦截${parts.join('；')}`)
  }
  else if (skipped.length > 0 && typeof skipped[0]?.reason === 'string') log?.(`系统层拦截未启动：${skipped[0].reason}`)
  return { available: true, started, skipped, running: result?.running === true }
}

/**
 * Stop the redirector and clear the git proxy that were started with the tunnel.
 *
 * Both are machine-scoped side effects of `yds start`, so `yds stop` removes them
 * even if this run did not create them — a leftover redirector keeps routing
 * traffic with no UI, and a leftover git proxy breaks `git` once the tunnel dies.
 * @param {object} cfg - resolved plugin config.
 * @param {{log?: Function, keepGit?: boolean}} [options] - logger / skip git undo.
 * @returns {Promise<{redirector: object, git: object}>} per-layer outcome.
 */
export async function stopBorrowedSideEffects(cfg, { log, keepGit = false } = {}) {
  const loaded = await loadIdeRedirector(cfg)
  let redirector = { stopped: false, reason: '未找到 dsh-ris-ide 的 ProxyBridge 适配器' }
  if (loaded.available === true && typeof loaded.mod.stopRedirector === 'function') {
    redirector = await loaded.mod.stopRedirector()
    if (redirector.stopped === true) log?.(`系统层拦截已停止（pid ${redirector.pid ?? '?'}）`)
    else if (typeof redirector.reason === 'string' && redirector.reason !== '' && redirector.reason !== '未在运行') {
      log?.(`系统层拦截未停止：${redirector.reason}`)
    }
  }
  let git = { ok: true, key: '' }
  if (keepGit !== true) git = await applyGitProxy(cfg, { enabled: false })
  return { redirector, git }
}

/**
 * Write this project's rules into the shared table WITHOUT starting an engine.
 *
 * Interception mode needs the rules (the ProxyBridge profile is built from them)
 * but must not bind anything: the redirector already carries the connections.
 * @param {object} cfg - resolved plugin config.
 * @param {object[]} targets - endpoints collected from the config.
 * @param {{log?: Function}} [options] - logger.
 * @returns {Promise<{mode: string, rules?: object[]}>} sync outcome.
 */
export async function syncBorrowedRules(cfg, targets, { log } = {}) {
  const loaded = await loadIdeProxy(cfg)
  cfg.__ideProxy = loaded
  if (!loaded.available) return { mode: 'unavailable' }
  const { rules } = syncProxyConfig(cfg, targets, { log, mapping: false })
  log?.('代理规则已写入（系统层拦截模式，无 127.0.0.1 映射）')
  return { mode: 'ide', rules }
}

export async function ensureBorrowedProxy(cfg, targets, { log, mapping = true } = {}) {
  // Direct mode (no `.env` SOCKS settings) has nothing to forward through: the
  // config's own addresses are reachable, so no engine is started at all.
  if (cfg.socks === null || cfg.socks === undefined) return { mode: 'none' }
  if (Array.isArray(targets) && targets.length === 0) {
    log?.('代理引擎：bootstrap 没有需要转发的内网端点，跳过')
    return { mode: 'none' }
  }
  if (cfg.proxyEngine === 'self') { log?.('代理引擎：按 .env 配置使用内置转发器（proxy.engine=self）'); return { mode: 'unavailable', error: 'disabled by proxy.engine=self' } }
  const loaded = await loadIdeProxy(cfg)
  cfg.__ideProxy = loaded
  if (!loaded.available) {
    log?.(`代理引擎：未找到 dsh-ris-ide（${loaded.error}），回退内置转发器`)
    return { mode: 'unavailable', error: loaded.error }
  }
  const mod = loaded.mod
  const before = mod.readProxyConfig(cfg.workspace)
  const { config, rules } = syncProxyConfig(cfg, targets, { log, mapping })
  const running = mod.proxyPid(cfg.workspace) !== null
  // A running engine holds the OLD rules; only a restart applies the new ones.
  const changed = JSON.stringify(before.rules) !== JSON.stringify(config.rules)
  let restarted = false
  if (running && changed) {
    log?.('代理规则变化，重启代理引擎…')
    await mod.stopProxy(cfg.workspace)
    restarted = true
  }
  const started = await mod.startProxy(cfg.workspace)
  if (started.ok !== true) return { mode: 'ide', ok: false, error: started.error ?? '代理引擎启动失败', path: loaded.path, rules }
  // The loopback listeners are a config field now, not rule rows: read them back
  // from the file the engine just loaded instead of guessing from the rules.
  const shadowPorts = (mod.readProxyConfig(cfg.workspace)?.shadows ?? []).map((entry) => entry.localPort)
  const shadowNote = shadowPorts.length > 0
    ? `，127.0.0.1 兜底映射 ${shadowPorts.length} 个端口（ProxyBridge 未运行时的后备）`
    : '，无 127.0.0.1 兜底映射（系统层拦截生效）'
  log?.(`代理引擎：dsh-ris-ide 运行中（pid ${started.pid ?? '?'}）${shadowNote}${restarted ? '（已重启）' : ''}`)
  return { mode: 'ide', ok: true, path: loaded.path, pid: started.pid ?? null, rules, shadowPorts, restarted }
}

/** Stop the borrowed engine (no-op when dsh-ris-ide is not installed). */
export async function stopBorrowedProxy(cfg) {
  const loaded = cfg.__ideProxy ?? await loadIdeProxy(cfg)
  if (loaded.available !== true) return { ok: false, error: loaded.error }
  return loaded.mod.stopProxy(cfg.workspace)
}

/** Engine status for `yds status` / `yds proxy status`. */
export async function borrowedProxyStatus(cfg) {
  const loaded = cfg.__ideProxy ?? await loadIdeProxy(cfg)
  if (loaded.available !== true) return { available: false, error: loaded.error }
  const status = await loaded.mod.proxyStatus(cfg.workspace)
  return { available: true, path: loaded.path, running: status.running === true, pid: status.pid ?? null, listenPort: status.config?.listenPort ?? null, rules: status.config?.rules ?? [] }
}
