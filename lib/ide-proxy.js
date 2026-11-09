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
import { acquireLease, dropDeadLease, engineStatus, forgetLease, getView, probeRisd, putRules, readLease, releaseLease, rememberLease, startEngine } from './risd-peer.js'
import { YDS_RULE_SOURCE, mergeYdsRules, programKeyOf, withdrawnBetween } from './rules.js'

/** Marker `source` used for every rule this plugin owns. */
// `YDS_RULE_SOURCE` now lives in ./rules.js (shared with risd-peer).
export { YDS_RULE_SOURCE, programKeyOf } from './rules.js'

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
        // The rule names the IMAGE (java.exe), not a pinned file: YonCode upgrades its
        // JDK in place, and other java.exe processes on the box need the same tunnel.
        out.java = 'java.exe'
        out.home = home
        break
      }
    }
    if (out.git === '' && existingFile(join(devkit, 'git', 'bin', 'git.exe')) === true) {
      out.git = 'git.exe'
    }
  }
  if (out.git === '') {
    for (const candidate of Array.isArray(options.gitPaths) === true ? options.gitPaths : []) {
      if (typeof candidate !== 'string' || candidate === '' || existingFile(candidate) !== true) continue
      // Same idea as java: one git.exe row covers the devkit copy and every other install.
      out.git = 'git.exe'
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
  const gitHost = options.gitHost ?? ''
  const rules = []
  if (withJava && found.java !== '' && hosts.length > 0) {
    rules.push({
      id: 'yds-yoncode-java',
      label: 'YonCode java',
      program: found.java,
      // YonCode's own JDK/git are Windows executables: they belong to the Windows side
      // even when this process runs inside WSL.
      side: 'windows',
      hosts: hosts.join(','),
      ports: '*',
      enabled: true,
      shadow: false,
      source: YDS_RULE_SOURCE,
    })
  }
  if (found.git !== '' && gitHost !== '') {
    rules.push({
      id: 'yds-yoncode-git',
      label: 'YonCode git',
      program: found.git,
      side: 'windows',
      hosts: gitHost,
      ports: '*',
      enabled: true,
      shadow: false,
      source: YDS_RULE_SOURCE,
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
//
// Two SIDES, not two workspaces: ProxyBridge matches `java.exe`/`git.exe` on Windows and
// `java`/`git` on WSL/Linux. Both rule sets are generated in one go, so the panel's
// global table shows the WSL-side rows that used to be missing (the WSL JVM was never
// intercepted). On Windows only the `.exe` rows make sense and are generated.
export function proxyRulesFromTargets(targets, { gitHost = '', java = false, extraHosts = [], platform = process.platform } = {}) {
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
  // ONE java rule per side for every internal segment, hosts comma-separated: the
  // backend also talks to hosts the bootstrap never lists (license, ES, kafka), so a
  // port list would go stale — and one row per /24 only made the table longer.
  const javaHosts = java ? Array.from(segments).sort().map((segment) => `${segment}.*`) : []
  const sides = platform === 'win32'
    ? [{ side: 'windows', java: 'java.exe', git: 'git.exe' }]
    : [
        { side: 'windows', java: 'java.exe', git: 'git.exe' },
        { side: 'local', java: 'java', git: 'git' },
      ]
  for (const entry of sides) {
    const local = entry.side === 'local'
    if (javaHosts.length > 0) {
      rules.push({
        id: local ? 'yds-java-local' : 'yds-java',
        // The IMAGE name, not a file path: one row covers every java.exe on the box
        // (YonCode's bundled JDK, the IDE's own, a terminal's), and a JDK upgrade
        // never invalidates it. The local side matches the WSL/Linux process name.
        program: entry.java,
        side: entry.side,
        hosts: javaHosts.join(','),
        ports: '*',
        enabled: true,
        shadow: false,
        source: YDS_RULE_SOURCE,
      })
    }
    // git reaches its remote through the same tunnel; `git config http.<host>.proxy`
    // stays as the belt for terminals that do not go through ProxyBridge.
    if (gitHost !== '') {
      rules.push({
        id: local ? 'yds-git-local' : 'yds-git',
        program: entry.git,
        side: entry.side,
        hosts: gitHost,
        ports: '*',
        enabled: true,
        shadow: false,
        source: YDS_RULE_SOURCE,
      })
    }
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
/** The rules this project owns, in one deterministic order (generic rows first). */
export function ydsRulesFor(cfg, targets, { java = cfg?.proxyJavaRules === true, platform = process.platform, log } = {}) {
  return mergeYdsRules([], [
    ...proxyRulesFromTargets(targets, { gitHost: gitHostOf(cfg), java, extraHosts: extraHostsOf(cfg), platform }),
    // YonCode runs its own JDK/git from outside the project. These rows are kept as a
    // fallback for invocations where the generic rows above are absent; when they are
    // present the side+program key is already taken and the duplicate is merged.
    ...yoncodeRules(cfg, {
      gitHost: gitHostOf(cfg),
      java,
      hosts: privateSegmentsOf(targets, extraHostsOf(cfg)),
    }),
  ], { log })
}

export function syncProxyConfig(cfg, targets, { log, mapping = true, java = cfg?.proxyJavaRules === true, platform = process.platform } = {}) {
  const loaded = cfg.__ideProxy
  if (loaded === undefined || loaded === null || loaded.available !== true) throw new Error('代理引擎未加载')
  const mod = loaded.mod
  // One read, one write: reading the shared table twice around the merge opened a
  // lost-update window between them (review D-P2).
  const stored = mod.readProxyConfig(cfg.workspace)
  // The table is machine-wide AND global, and the daemon saves it wholesale
  // (`POST /v1/proxy` is a whole-table PUT). So the complete table is built here:
  // every non-yds row kept, every yds row replaced by this run's set.
  const fresh = ydsRulesFor(cfg, targets, { java, platform, log })
  const rules = mergeYdsRules(stored?.rules, fresh, { log })
  // Bound only while the system layer is unavailable; in interception mode this is
  // empty, so nothing is bound on loopback at all.
  const shadows = mapping === false ? [] : shadowTargetsFromTargets(targets)
  const upstream = cfg.socks ?? null
  // The borrowed tier goes through `mergeConfigs` with `replaceAllRules`: the IDE
  // keeps owning socks/listenPort/shadows, while the rules are replaced wholesale by
  // the complete table above. `replaceRulesFrom` (the old per-source patch) is retired.
  const merged = mod.mergeConfigs(stored, {
    socks: upstream === null ? { host: '', port: 0 } : { host: upstream.host, port: upstream.port },
    listenPort: cfg.proxyListenPort ?? stored?.listenPort,
    shadows,
    replaceAllRules: true,
    rules,
  })
  // Pin the table we computed even if an older dsh-ris-ide build ignores the flag: a
  // stale yds row left behind here would resurface as an intercepted process.
  const saved = mod.writeProxyConfig(cfg.workspace, { ...merged, rules })
  const config = saved
  log?.(`代理规则已同步：${fresh.length} 条 yds 规则（共享表共 ${rules.length} 条）`)
  return { config: saved, rules, withdrawn: withdrawnBetween(stored?.rules, rules) }
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
export async function stopBorrowedSideEffects(cfg, { log, keepGit = false, daemonReload = null } = {}) {
  let redirector = { stopped: false, reason: '未找到 dsh-ris-ide 的 ProxyBridge 适配器' }
  if (daemonReload !== null) {
    // risd tier: POST /v1/proxy already reloaded (or reported why it could not
    // reload) the machine bridge. Reloading it here too would be a second writer
    // that is not serialised with the daemon (review D-P2-10), so render its note.
    redirector = {
      stopped: false,
      viaDaemon: true,
      reason: daemonReload === ''
        ? '由 risd daemon 管理（规则已保存；daemon 未要求重启桥接）'
        : `由 risd daemon 管理：${daemonReload}`,
    }
    log?.(`系统层拦截：${redirector.reason}`)
  } else {
    const loaded = await loadIdeRedirector(cfg)
    // The bridge is machine-wide: an IDE window may still need it. Reload it with the
    // profile that no longer contains our rules instead of stopping it; stopping is
    // what used to kill the IDE's interception on `yds stop`.
    if (loaded.available === true && typeof loaded.mod.reloadRedirectorsWithProfile === 'function') {
      const status = typeof loaded.mod.redirectorStatus === 'function' ? loaded.mod.redirectorStatus() : { running: false }
      if (status.running !== true) redirector = { stopped: false, reason: '未在运行' }
      else {
        const reload = await loaded.mod.reloadRedirectorsWithProfile(cfg.workspace, { sides: ['windows', 'local'] })
        const reloaded = Array.isArray(reload.reloaded) ? reload.reloaded.length : 0
        redirector = reloaded > 0
          ? { stopped: false, reloaded: true, reason: '已按剩余规则重载（引擎与拦截保留）' }
          : { stopped: false, reason: '未能重载，系统层拦截仍按旧规则运行（需手动重启桥接）' }
        log?.(`系统层拦截：${redirector.reason}`)
      }
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
  // Preferred tier: a running risd owns the table, the engine and the bridge.
  const risd = await probeRisd()
  if (risd.usable === true) {
    const rules = ydsRulesFor(cfg, targets)
    // No `shadows` argument on purpose: the daemon's write contract only takes
    // socks/listenPort/rules (incoming.shadows is dropped), so passing `[]` here
    // would look like "clear the mappings" while doing nothing (review D-P2-3).
    // 127.0.0.1 mappings of the risd engine are owned by the daemon / IDE side.
    const saved = await putRules(cfg.workspace ?? '', rules, { gitHost: gitHostOf(cfg), log })
    if (saved.ok !== true) throw new Error(`代理规则写入 risd 失败：${saved.error}`)
    log?.(`代理规则已写入 risd（${rules.length} 条，source=${YDS_RULE_SOURCE}）`)
    return { mode: 'risd', rules, reloadNote: saved.reloadNote ?? '' }
  }
  const loaded = await loadIdeProxy(cfg)
  cfg.__ideProxy = loaded
  if (!loaded.available) return { mode: 'unavailable' }
  const { rules } = syncProxyConfig(cfg, targets, { log, mapping: false })
  log?.('代理规则已写入（系统层拦截模式，无 127.0.0.1 映射）')
  // A running bridge parsed its profile once at start, so rewriting the table is not
  // enough: restart it with the new rules — or, if that fails, stop it. Leaving the
  // old profile running is exactly the "old proxy cannot be cancelled" failure.
  const redirector = await loadIdeRedirector(cfg)
  if (redirector.available === true && typeof redirector.mod.reloadRedirectorsWithProfile === 'function') {
    const status = typeof redirector.mod.redirectorStatus === 'function' ? redirector.mod.redirectorStatus() : { running: false }
    if (status.running === true) {
      const reload = await redirector.mod.reloadRedirectorsWithProfile(cfg.workspace, { sides: ['windows', 'local'] })
      const reloaded = Array.isArray(reload.reloaded) ? reload.reloaded.length : 0
      if (reloaded > 0) {
        log?.('系统层拦截已按新规则重启')
        return { mode: 'ide', rules, reloadNote: '系统层拦截已按新规则自动重启' }
      }
      const stopped = typeof redirector.mod.stopRedirector === 'function'
        ? await redirector.mod.stopRedirector()
        : { stopped: false }
      const note = stopped.stopped === true
        ? '系统层拦截未能重载，已停止（避免继续按旧规则代理）'
        : '系统层拦截未能重载，旧规则可能仍在生效（请重启桥接）'
      log?.(note)
      return { mode: 'ide', rules, reloadNote: note }
    }
  }
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
  // Preferred tier: the daemon owns the engine, so yds writes rules + a lease and
  // never starts a second engine (two owners would fight for the same shadows).
  const risd = await probeRisd()
  if (risd.usable === true) {
    const rules = ydsRulesFor(cfg, targets)
    const saved = await putRules(cfg.workspace ?? '', rules, { gitHost: gitHostOf(cfg), log })
    if (saved.ok !== true) return { mode: 'risd', ok: false, error: `代理规则写入 risd 失败：${saved.error}` }
    const started = await startEngine(cfg.workspace ?? '')
    if (started.ok !== true) return { mode: 'risd', ok: false, error: `risd 启动引擎失败：${started.error}` }
    const status = await engineStatus(cfg.workspace ?? '')
    const pid = status.engine?.pid ?? started.result?.pid ?? null
    const ports = Array.isArray(status.engine?.listen) ? status.engine.listen.map((item) => item.port).filter((port) => Number.isInteger(port)) : []
    log?.(`代理引擎：risd daemon 运行中（pid ${pid ?? '?'}）${ports.length > 0 ? `，监听 ${ports.join(', ')}` : ''}`)
    return { mode: 'risd', ok: true, pid, rules, shadowPorts: ports, listenPorts: ports }
  }
  const loaded = await loadIdeProxy(cfg)
  cfg.__ideProxy = loaded
  if (!loaded.available) {
    // Standalone by design: the built-in forwarder is a complete fallback, so
    // the sibling plugin is only ever a recommendation (one shared engine).
    log?.(`代理引擎：未找到 dsh-ris-ide（${loaded.error}），回退内置转发器`
      + '（可选：装上 dsh-ris-ide 可在同一个 dsh 里获得 IDE 面板与服务调试能力）')
    return { mode: 'unavailable', error: loaded.error }
  }
  const mod = loaded.mod
  const before = mod.readProxyConfig(cfg.workspace)
  const { config, rules } = syncProxyConfig(cfg, targets, { log, mapping })
  const running = mod.proxyPid(cfg.workspace) !== null
  // The engine watches `proxy.json` and reloads it (dsh-ris-ide/lib/proxy.js:
  // watchFile -> reload -> applyShadows), so an edited table reaches a running engine
  // within about a second. The restart below is belt-and-braces: it guarantees the
  // new shadow listeners are bound BEFORE the process we are about to launch dials
  // 127.0.0.1; it is not needed because "a running engine holds the old rules" — that
  // model is obsolete (review D-P2-9).
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

/**
 * Take a daemon lease owned by a long-lived pid (the YMS process, or the
 * foreground CLI) so the engine outlives this short `yds` process.
 */
export async function holdBorrowedLease(cfg, { ownerPid = process.pid, log } = {}) {
  const risd = await probeRisd()
  if (risd.usable !== true) return { ok: false, reason: risd.reason }
  // A previous YMS that was killed with -9 leaves a record whose pid is gone; the
  // daemon only reaps by pid, so drop our stale record before taking a fresh one
  // (review D-P2-6).
  if (dropDeadLease(cfg.workspace ?? '') === true) log?.('已清理该 workspace 的死租约记录')
  const lease = await acquireLease({ cwd: cfg.workspace ?? '', state: risd.state, ownerPid })
  if (lease.ok !== true) {
    log?.(`risd 租约未登记：${lease.error}`)
    return { ok: false, error: lease.error }
  }
  rememberLease(cfg.workspace ?? '', { id: lease.id, ownerPid, port: risd.state.port })
  log?.(`risd 租约已登记（owner pid ${ownerPid}）`)
  return { ok: true, id: lease.id }
}

/** Drop one specific daemon lease (the owner pid changed, e.g. CLI → YMS). */
export async function dropBorrowedLease(id, { log } = {}) {
  if (typeof id !== 'string' || id === '') return { ok: true, released: false }
  const risd = await probeRisd()
  if (risd.usable !== true) return { ok: false, reason: risd.reason }
  const released = await releaseLease(id, { state: risd.state })
  if (released.ok === true) log?.('risd 租约已移交（旧 owner 释放）')
  return released
}

/** Release the lease recorded for this workspace; idempotent when none exists. */
export async function releaseBorrowedLease(cfg, { log } = {}) {
  const entry = readLease(cfg.workspace ?? '')
  if (entry === null) return { ok: true, released: false }
  const risd = await probeRisd()
  if (risd.usable !== true) {
    // No daemon: nothing holds the lease any more, so the local record is stale.
    forgetLease(cfg.workspace ?? '')
    return { ok: true, released: false, reason: 'risd 未运行' }
  }
  const released = await releaseLease(entry.id, { state: risd.state })
  if (released.ok !== true) {
    // Keep the record so a retry (`yds stop` again) can release it instead of
    // waiting for the daemon's 3 s sweep to notice the dead owner (review D-P2-6).
    return { ok: false, released: false, reason: released.error || '释放租约失败' }
  }
  forgetLease(cfg.workspace ?? '')
  log?.(`risd 租约已释放（${entry.id}）`)
  return { ok: true, released: true }
}

/**
 * Withdraw this plugin's share of the tunnel — and leave the ENGINE running.
 *
 * The engine is machine-wide: an IDE window (or another dsh) may still be using it.
 * So `yds stop` releases the risd lease, removes every yds rule from the global table
 * and lets the machine-level layers settle; killing the engine here is what used to
 * interrupt the IDE's tunnel (the old "yds stop kills the shared engine" defect).
 */
export async function stopBorrowedProxy(cfg, { log } = {}) {
  const workspace = cfg.workspace ?? ''
  const risd = await probeRisd()
  if (risd.usable === true) {
    await releaseBorrowedLease(cfg)
    // `[]` removes EVERY yds row: the table is global and yds owns exactly the rows
    // it injected, so a stop must not leave its rows behind — and there is no
    // per-workspace share to preserve any more (global-table contract).
    // The daemon reloads the bridge inside POST /v1/proxy; its note is what
    // `yds stop` renders instead of reloading the bridge locally a second time
    // (review D-P2-10).
    const saved = await putRules(workspace, [], { gitHost: '', log })
    return {
      ok: saved.ok === true,
      stopped: false,
      engine: 'kept',
      mode: 'risd',
      withdrawn: saved.withdrawn ?? { rules: 0, hosts: 0 },
      reloadNote: saved.reloadNote ?? '',
      error: saved.ok === true ? '' : saved.error,
    }
  }
  const loaded = cfg.__ideProxy ?? await loadIdeProxy(cfg)
  if (loaded.available !== true) return { ok: false, error: loaded.error }
  // Borrowed-engine tier: remove every yds row and keep the engine (and the user's
  // own rows) for the IDE. Same blast radius as the risd tier (review D-P1-3/P1-8).
  const mod = loaded.mod
  const stored = mod.readProxyConfig(workspace)
  const rules = mergeYdsRules(stored?.rules, [], { log })
  const merged = typeof mod.mergeConfigs === 'function'
    ? mod.mergeConfigs(stored, { replaceAllRules: true, rules })
    : stored
  mod.writeProxyConfig(workspace, { ...(merged !== null && typeof merged === 'object' ? merged : {}), rules })
  return { ok: true, stopped: false, engine: 'kept', mode: 'ide', withdrawn: withdrawnBetween(stored?.rules, rules) }
}

/** Engine status for `yds status` / `yds proxy status`, whichever tier owns it. */
export async function borrowedProxyStatus(cfg) {
  const risd = await probeRisd()
  if (risd.usable === true) {
    const view = await getView(cfg.workspace ?? '', { state: risd.state })
    const engine = await engineStatus(cfg.workspace ?? '', { state: risd.state })
    const payload = view.view ?? {}
    const info = engine.engine ?? {}
    const listen = Array.isArray(info.listen) ? info.listen : []
    const listenPorts = listen.map((item) => item.port).filter((port) => Number.isInteger(port))
    return {
      available: true,
      mode: 'risd',
      path: `risd:${risd.state.port}`,
      // /v1/engine is the authoritative process view (running/pid/listen); the rule
      // table's numbers describe what was SAVED and can lag the engine (review D-P2-5).
      running: info.running === true || (info.running === undefined && payload.running === true),
      pid: info.pid ?? payload.pid ?? null,
      listenPort: payload.listenPort ?? listenPorts[0] ?? null,
      listenPorts,
      rules: Array.isArray(payload.rules) ? payload.rules : [],
    }
  }
  const loaded = cfg.__ideProxy ?? await loadIdeProxy(cfg)
  if (loaded.available !== true) return { available: false, error: loaded.error }
  const status = await loaded.mod.proxyStatus(cfg.workspace)
  return { available: true, mode: 'ide', path: loaded.path, running: status.running === true, pid: status.pid ?? null, listenPort: status.config?.listenPort ?? null, rules: status.config?.rules ?? [] }
}
