// dsh-ris-yds config resolution.
//
// Requirements (user 2026-11-06):
//   1. No machine-specific content in project docs; every IP/port comes from
//      settings.json (project, YonCode standard, READ-ONLY for us) or
//      .env (workspace root, OPTIONAL, machine level; shared with dsh-ris-ide).
//   2. .env is not required: SOCKS configured -> proxy, else direct.
//   3. Never casually modify project files: yonasset/.vscode/settings.json is
//      read-only; we write only dsh-owned state (.dsh-ris-yds/, yms-home in the
//      same standard format YonCode itself deploys).
//   5. No dependence on local resources: a fresh machine + this plugin + the
//      project git clone must be able to develop (confcenter config is pulled
//      live; kernel comes from jfrog).
//
// Source priority (low -> high):
//   defaults < .env < process env (YDS_*/YMS_PORT) < CLI overrides.

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_WSL = detectWsl()

function detectWsl() {
  if (IS_WINDOWS) return false
  if (process.env.WSL_DISTRO_NAME !== undefined) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Parse an env-format file (KEY=VALUE, tolerates CRLF, comments, blanks). */
export function parseEnvFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1)
    // tolerate quotes the user wrapped around values
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value.trim()
  }
  return out
}

/**
 * Find the project root: the directory whose .vscode/settings.json carries
 * yds.* keys. Search order: cwd itself -> up to 4 ancestor levels (agent
 * sessions often start inside the project tree) -> one level of children
 * (the workspace root usually holds the project dir).
 */
export function findProjectDir(workspace) {
  const candidates = []
  // ancestors (bounded)
  {
    let cur = workspace
    for (let i = 0; i < 5 && cur !== undefined; i += 1) {
      candidates.push(cur)
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }

  try {
    for (const name of readdirSync(workspace)) {
      const full = join(workspace, name)
      if (statSync(full).isDirectory() && !name.startsWith('.') && name !== 'node_modules') {
        candidates.push(full)
      }
    }
  } catch { /* unreadable cwd: only the cwd itself */ }
  for (const dir of candidates) {
    const p = join(dir, '.vscode', 'settings.json')
    if (!existsSync(p)) continue
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'))
      if (json !== null && typeof json === 'object' && Object.keys(json).some((k) => k.startsWith('yds.'))) {
        return { dir, settings: json }
      }
    } catch { /* malformed: skip */ }
  }
  return null
}

/** Read the optional machine-level `.env` (workspace root, shared with dsh-ris-ide). */
/**
 * Find the shared `.env`.
 *
 * It is deliberately NOT inside the project (a clone must not carry the tunnel
 * credentials), so the lookup walks up from the workspace: `<ws>/.env`,
 * `<ws>/../.env`, … up to four levels. First hit wins.
 * @param workspace - the workspace (or project) directory to start from.
 * @returns `{ path, exists, values }` — `path` is where the file WOULD be.
 */
export function readSettingsEnv(workspace) {
  let dir = workspace
  for (let depth = 0; depth < 5; depth += 1) {
    const path = join(dir, '.env')
    if (existsSync(path)) return { path, exists: true, values: parseEnvFile(readFileSync(path, 'utf8')) }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { path: join(workspace, '.env'), exists: false, values: {} }
}

/**
 * The machine-level `.env` doubles as its own documentation: a fresh machine
 * should not have to guess key names. Whenever yds loads the config we make sure
 * every documented key exists as a **commented** placeholder (`#key=`), so the
 * file stays a template and no value is ever invented. Append-only: an existing
 * line — commented or not — is never touched or duplicated.
 */
export const ENV_TEMPLATE_SECTION = '# ---- yds 机器配置（可选）----'

/** Written in `.env` to stop the "fill these in" prompt on a machine that needs none of them. */
export const ENV_TEMPLATE_ACK = '# yds: 配置已确认（无需补齐）'

const ENV_TEMPLATE = [
  { key: 'git.url', lines: ['#git.url='] },
  {
    key: 'socks.host',
    lines: ['# socks 隧道（配置后yds插件才会注入代理规则、写 git 代理）', '#socks.host='],
  },
  { key: 'socks.port', lines: ['#socks.port='] },
  {
    key: 'proxy.javaRules',
    lines: ['# 与YonCode冲突，使用dsh-ris-ide插件启动项目时才开启', '#proxy.javaRules=on'],
  },
]

function envHasKey(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*#?\\s*${escaped}\\s*=`, 'm').test(text)
}

/** Active (uncommented, non-empty) value of `key` in `.env` text, or null. */
export function envActiveValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)$`, 'm')
  const match = re.exec(text)
  if (match === null) return null
  const value = match[1].trim()
  return value === '' ? null : value
}

/** Documented machine keys that still have no active value (need the user). */
export function envPendingKeys(workspace) {
  const found = readSettingsEnv(workspace)
  const text = found.exists ? readFileSync(found.path, 'utf8') : ''
  if (text.includes(ENV_TEMPLATE_ACK)) return { path: found.path, keys: [], acknowledged: true }
  return { path: found.path, keys: ENV_TEMPLATE.map((entry) => entry.key).filter((key) => envActiveValue(text, key) === null) }
}

/**
 * Ensure the workspace `.env` documents the optional machine keys.
 * @param workspace - workspace (or project) directory; the same upward lookup
 *   as {@link readSettingsEnv} decides where the file lives.
 * @returns `{ path, added, created }` — `added` lists keys newly documented.
 */
export function ensureEnvTemplate(workspace) {
  const found = readSettingsEnv(workspace)
  const path = found.path
  const text = found.exists ? readFileSync(path, 'utf8') : ''
  const acknowledged = text.includes(ENV_TEMPLATE_ACK)
  const missing = ENV_TEMPLATE.filter((entry) => !envHasKey(text, entry.key))
  if (missing.length === 0) {
    const pending = acknowledged ? [] : ENV_TEMPLATE.map((entry) => entry.key).filter((key) => envActiveValue(text, key) === null)
    return { path, added: [], created: false, pending, acknowledged }
  }

  const lines = []
  if (!text.includes(ENV_TEMPLATE_SECTION)) lines.push(ENV_TEMPLATE_SECTION)
  for (const entry of missing) lines.push(...entry.lines)

  const lead = text === '' ? '' : (text.endsWith('\n\n') ? '' : (text.endsWith('\n') ? '\n' : '\n\n'))
  const next = `${text}${lead}${lines.join('\n')}\n`
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, next, { mode: 0o600 })
  renameSync(tmp, path)
  const pending = acknowledged ? [] : ENV_TEMPLATE.map((entry) => entry.key).filter((key) => envActiveValue(next, key) === null)
  return { path, added: missing.map((entry) => entry.key), created: !found.exists, pending, acknowledged }
}

/** Detect the YDS module name + context from the project tree. */
export function detectModule(projectDir, ymsHome) {
  // Candidate A: yonbuilder.json in the project root or its direct children
  // (the backend project, e.g. c-ass-kk-hans-be/yonbuilder.json: {code:"..."}).
  // The root-level module.xml often describes the *scripts* module
  // (name=...-scripts, service_type=sql) — wrong for the backend runtime — so
  // it is only a last resort.
  const yonbuilderCodes = []
  const dirs = [projectDir]
  try {
    for (const name of readdirSync(projectDir)) {
      const full = join(projectDir, name)
      if (statSync(full).isDirectory() && !name.startsWith('.') && name !== 'node_modules') dirs.push(full)
    }
  } catch { /* unreadable project dir */ }
  for (const dir of dirs) {
    try {
      const p = join(dir, 'yonbuilder.json')
      if (!existsSync(p)) continue
      const json = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof json?.code === 'string' && json.code !== '' && !yonbuilderCodes.includes(json.code)) {
        yonbuilderCodes.push(json.code)
      }
    } catch { /* malformed: skip */ }
  }
  // Candidate B: modules already deployed into yms-home (deployed = intended).
  const deployed = []
  try {
    for (const name of readdirSync(join(ymsHome, 'modules'))) {
      const full = join(ymsHome, 'modules', name)
      if (statSync(full).isDirectory()) deployed.push(name)
    }
  } catch { /* no yms-home yet */ }

  let name = null
  const both = yonbuilderCodes.find((code) => deployed.includes(code))
  if (both !== undefined) name = both
  else if (yonbuilderCodes.length > 0) name = yonbuilderCodes[0]
  else if (deployed.length > 0) name = deployed[0]
  if (name === null) {
    // Last resort: module.xml at the project root.
    try {
      const p = join(projectDir, 'module.xml')
      if (existsSync(p)) {
        const m = /<module[^>]*\sname="([^"]+)"/.exec(readFileSync(p, 'utf8'))
        if (m !== null) name = m[1]
      }
    } catch { /* ignore */ }
  }
  if (name === null) return null
  // Context from the deployed module descriptor if available.
  let context = '/'
  try {
    const p = join(ymsHome, 'modules', name, name, 'WEB-INF', 'classes', 'iuap-yms-module', 'module.xml')
    if (existsSync(p)) {
      const m = /<module[^>]*\scontext="([^"]*)"/.exec(readFileSync(p, 'utf8'))
      if (m !== null && m[1] !== '') context = m[1]
    }
  } catch { /* ignore */ }
  return { name, context }
}

/** Locate a JDK: settings/env hint, JAVA_HOME, PATH, yms-home hint, Windows devkit. */
export function detectJava(cfg) {
  const candidates = []
  const fromEnv = cfg.envValues?.['java.path'] ?? process.env.YDS_JAVA_PATH
  if (typeof fromEnv === 'string' && fromEnv !== '') candidates.push(fromEnv)
  if (process.env.JAVA_HOME !== undefined) {
    candidates.push(join(process.env.JAVA_HOME, 'bin', IS_WINDOWS ? 'java.exe' : 'java'))
  }
  const fromHome = join(cfg.ymsHome ?? '', '.javaExecutable')
  if (cfg.ymsHome !== undefined && existsSync(fromHome)) {
    try {
      const v = readFileSync(fromHome, 'utf8').trim()
      if (v !== '') candidates.push(v)
    } catch { /* ignore */ }
  }
  if (IS_WINDOWS) candidates.push('java.exe') // PATH lookup
  candidates.push('java')
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      // PATH lookup: existsSync on the bare name is unreliable cross-OS
      try {
        execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 15000 })
        return candidate
      } catch { /* keep trying */ }
    }
  }
  return null
}

/**
 * Resolve the full effective configuration for a workspace.
 * @param {string} workspace - absolute session workspace root
 * @returns the config object + a `problems` list of human-readable gaps.
 */
/**
 * Pick the front-end project entry that belongs to this module.
 *
 * `yds.webConfig` is a map keyed by front-end project (e.g. `c-ass-kk-hans-fe`);
 * each value carries `yds.domainKey`, `yds.localDevUrl` (where its dev server
 * listens) and the debug/build scripts. The entry whose domainKey matches the
 * backend module is the one whose pages load this module's extender; failing that a
 * single entry is unambiguous, and otherwise the first one wins.
 * @param {object|undefined} webConfig - the raw `yds.webConfig` value.
 * @param {string|null} module - the resolved backend module name.
 * @returns {{code: string, domainKey: string, microFrontendType: string, port: number, devUrl: string, debugScript: string, buildScript: string, buildDistPath: string}} entry (port defaults to 3004).
 */
export function pickFrontend(webConfig, module) {
  const fallback = { code: '', domainKey: module ?? '', microFrontendType: '', port: DEFAULT_FE_PORT, devUrl: '', debugScript: 'debug', buildScript: 'build', buildDistPath: '' }
  if (webConfig === null || typeof webConfig !== 'object') return fallback
  const entries = Object.entries(webConfig)
    .filter(([, value]) => value !== null && typeof value === 'object')
    .map(([code, value]) => ({ code, value }))
  if (entries.length === 0) return fallback
  const matched = entries.find(({ value }) => module !== null && value['yds.domainKey'] === module)
    ?? (entries.length === 1 ? entries[0] : entries.find(({ value }) => value['yds.domainKey'] !== undefined) ?? entries[0])
  const value = matched.value
  const devUrl = typeof value['yds.localDevUrl'] === 'string' ? value['yds.localDevUrl'] : ''
  return {
    code: matched.code,
    domainKey: typeof value['yds.domainKey'] === 'string' && value['yds.domainKey'] !== '' ? value['yds.domainKey'] : (module ?? ''),
    microFrontendType: typeof value['yds.microFrontendType'] === 'string' ? value['yds.microFrontendType'] : '',
    port: portOfUrl(devUrl) || DEFAULT_FE_PORT,
    devUrl,
    debugScript: typeof value['yds.debugScript'] === 'string' && value['yds.debugScript'] !== '' ? value['yds.debugScript'] : 'debug',
    buildScript: typeof value['yds.buildScript'] === 'string' && value['yds.buildScript'] !== '' ? value['yds.buildScript'] : 'build',
    buildDistPath: typeof value['yds.buildDistPath'] === 'string' ? value['yds.buildDistPath'] : '',
  }
}

/**
 * The TCP port of a URL, or 0 when it has none / does not parse.
 * @param {string} value - e.g. `http://127.0.0.1:3004`.
 * @returns {number} port.
 */
export function portOfUrl(value) {
  // Only an explicit port counts: a dev URL without one tells us nothing about
  // where the dev server listens, and 80/443 would be a wrong answer.
  try {
    return Number(new URL(String(value)).port) || 0
  } catch {
    return 0
  }
}

/**
 * Remember which port the last start used.
 *
 * The port is chosen from "the first free one", so while an instance runs that port
 * is by definition taken — without the memory every `yds status` would report a
 * different port than the running JVM. Kept in the state directory next to the pid.
 * @param {string} stateDir - `<workspace>/.dsh-ris-yds`.
 * @returns {number|null} the remembered port, or null when there is none.
 */
export function readRememberedPort(stateDir) {
  try {
    const value = Number(readFileSync(join(stateDir, 'yms-port'), 'utf8').trim())
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Default webpack dev-server port of a yds front-end project. */
/** Default webpack dev-server port of a yds front-end project. */
export const DEFAULT_FE_PORT = 3004

/**
 * Find the front-end project by looking at what is on disk.
 *
 * A yds front end ships `resource_override_rules.json` naming the dev server it
 * expects (`http://127.0.0.1:3004/static/…`), so the port can be read from the
 * project instead of assumed. Used only when `yds.webConfig` is absent.
 * @param {string} projectDir - the yds project root.
 * @param {string|null} module - backend module, for the fallback domainKey.
 * @returns {object} a frontend entry (see pickFrontend).
 */
export function discoverFrontend(projectDir, module) {
  const empty = pickFrontend(undefined, module)
  let entries = []
  try {
    entries = readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
  } catch {
    return empty
  }
  for (const entry of entries) {
    const file = join(projectDir, entry.name, 'resource_override_rules.json')
    if (existsSync(file) === false) continue
    let port = 0
    try {
      const text = readFileSync(file, 'utf8')
      const found = /127\.0\.0\.1:(\d{2,5})/.exec(text)
      port = found === null ? 0 : Number(found[1])
    } catch {
      port = 0
    }
    if (port <= 0) continue
    return {
      ...empty,
      code: entry.name,
      // The front-end directory name minus the module suffix is the domainKey the
      // platform uses (`c-ass-kk-hans-fe` → `c-ass-kk-hans`, which is also the module).
      domainKey: module ?? entry.name,
      port,
      devUrl: `http://127.0.0.1:${port}`,
    }
  }
  return empty
}

/**
 * First TCP port at or above `from` that nothing is listening on.
 *
 * Binding is the only reliable test (a pidfile or config can be stale), and it is
 * released immediately — this runs before the JVM starts, never while it runs.
 * @param {number} from - preferred port.
 * @param {{attempts?: number}} [options] - how far to walk.
 * @returns {number} the port chosen (falls back to `from` when all are taken).
 */
export function findFreePort(from, options = {}) {
  const attempts = options.attempts ?? 50
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = from + offset
    if (candidate > 65535) break
    if (isPortFree(candidate)) return candidate
  }
  return from
}

/**
 * Is a port free on the loopback interface?
 * @param {number} port - the port to test.
 * @returns {boolean} free when the bind succeeds.
 */
export function isPortFree(port) {
  // A bind attempt is the only reliable test (pidfiles and configs go stale), and it
  // has to happen synchronously inside a sync config builder — so it runs in a tiny
  // child process that exits 0 when the bind succeeded.
  const script = `const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))`
  try {
    execFileSync(process.execPath, ['-e', script], { timeout: 4000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function resolveConfig(workspace) {
  const problems = []
  const project = findProjectDir(workspace)
  const settingsEnv = readSettingsEnv(workspace)
  const envValues = settingsEnv.values

  const projectSettings = project?.settings ?? {}
  const pick = (key, fallback) => {
    if (typeof projectSettings[key] === 'string' && projectSettings[key] !== '') return projectSettings[key]
    return fallback
  }

  const ymsHome = resolve(workspace, envValues['local.ymsHome'] ?? process.env.YMS_HOME ?? (project !== null ? join(project.dir, 'yms-home') : join(workspace, 'yms-home')))

  const module = project !== null ? detectModule(project.dir, ymsHome) : null
  // YonCode keeps the front-end project settings in `.vscode/settings.json` under
  // `yds.webConfig`: one entry per front-end project with its OWN dev URL/port and
  // domainKey. That is the project's declaration of where its dev server lives, so
  // the override rules read it instead of assuming 3004.
  // `yds.webConfig` is written by YonCode into the project it opened; a checkout
  // that never saw YonCode (the WSL copy) has no such key, so the front-end project's
  // own override file is the next witness of where its dev server listens.
  const frontend = projectSettings['yds.webConfig'] !== undefined
    ? pickFrontend(projectSettings['yds.webConfig'], module)
    : discoverFrontend(project !== null ? project.dir : workspace, module)

  // SOCKS: optional by design (requirement 2). No host -> direct mode.
  const socksHost = envValues['socks.host'] ?? process.env.YDS_SOCKS_HOST
  const socksPortRaw = envValues['socks.port'] ?? process.env.YDS_SOCKS_PORT
  const socks = socksHost !== undefined && socksHost !== ''
    ? { host: socksHost, port: Number(socksPortRaw ?? 1080) || 1080 }
    : null

  const workbenchUrl = (pick('yds.workbenchUrl') ?? process.env.YDS_WORKBENCH_URL ?? '').replace(/\/+$/, '')
  const serverBindAddress = pick('yds.serverBindAddress') ?? envValues['local.bindAddress'] ?? process.env.YDS_BIND
  const serverPort = Number(pick('yds.serverPort') ?? envValues['local.serverPort'] ?? process.env.YDS_SERVER_PORT ?? 31010) || 31010
  const env = pick('yds.env') ?? 'dev'
  const accessKey = pick('yds.accessKey') ?? process.env.YDS_ACCESS_KEY
  const accessSecret = pick('yds.accessSecret') ?? process.env.YDS_ACCESS_SECRET

  // Local YMS listen port: the callback port is taken by the host (or by a Windows
  // YonCode that shares it), so start two above it and walk up to the first free
  // one. No configuration to keep in sync, no "port already in use" on a machine
  // that also runs YonCode. An explicit YMS_PORT still wins (tests, CI).
  const ymsPort = Number(process.env.YMS_PORT ?? 0) > 0
    ? Number(process.env.YMS_PORT)
    : (readRememberedPort(join(workspace, '.dsh-ris-yds')) ?? findFreePort(serverPort + 2))


  // git (optional, requirement 2: proxy only when SOCKS configured)
  const git = envValues['git.url'] !== undefined
    ? {
      url: envValues['git.url'],
      tokenName: envValues['git.token.name'] ?? '',
      tokenPwd: envValues['git.token.pwd'] ?? '',
      commit: envValues['git.commit'] ?? 'never',
      proxy: socks !== null ? `socks5h://${socks.host}:${socks.port}` : undefined,
    }
    : null

  // maven: local repo + settings.xml. Auto-detect a workspace-scoped repo
  // (<workspace>/.m2 — used when the machine keeps a project-local repository);
  // otherwise default ~/.m2 and generate jfrog settings at build time.
  const workspaceMavenSettings = join(workspace, '.m2', 'settings.xml')
  const workspaceMavenRepo = join(workspace, '.m2', 'repository')
  const maven = {
    repo: envValues['maven.repo'] ?? process.env.YDS_MAVEN_REPO
      ?? (existsSync(workspaceMavenRepo) ? workspaceMavenRepo : null),
    settingsXml: envValues['maven.settings'] ?? process.env.YDS_MAVEN_SETTINGS
      ?? (existsSync(workspaceMavenSettings) ? workspaceMavenSettings : null),
  }

  const rawModule = module?.name ?? null
  // module flows into filesystem paths (logs/<module>, modules/<module>...) —
  // reject anything that could traverse or escape (path traversal guard).
  const moduleOk = rawModule !== null && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawModule)
  const cfg = {
    workspace,
    platform: process.platform,
    arch: process.arch,
    isWindows: IS_WINDOWS,
    isWsl: IS_WSL,
    projectDir: project?.dir ?? null,
    projectSettingsPath: project !== null ? join(project.dir, '.vscode', 'settings.json') : null,
    settingsEnv,
    envValues,
    module: moduleOk ? rawModule : null,
    context: moduleOk ? (module?.context ?? '/') : '/',
    env,
    workbenchUrl,
    accessKey: accessKey ?? null,
    accessSecret: accessSecret ?? null,
    serverBindAddress: serverBindAddress ?? null,
    serverPort,
    ymsPort,
    ymsHome,
    socks,
    dbForwardPort: Number(envValues['socks.dbPort'] ?? 1521) || 1521,
    redisForwardPort: Number(envValues['socks.redisPort'] ?? 6890) || 6890,
    // Which tunnel engine to use: 'auto' borrows dsh-ris-ide's engine (one owner
    // for the 127.0.0.1 ports, shared with the IDE dialog); 'self' forces the
    // bundled forwarder (a machine without dsh-ris-ide, or a deliberate split).
    // Optional: where YonCode is installed (`yds yoncode`). Empty means "search
    // the platform defaults"; when set it is authoritative.
    yoncodeHome: envValues['yoncode.home'] ?? '',
    proxyEngine: envValues['proxy.engine'] ?? 'auto',
    proxyListenPort: Number(envValues['proxy.listenPort'] ?? 0) || 0,
    // Two mutually exclusive launch modes for the YonCode bundle:
    //   proxy  - the JVM carries the SOCKS flags and reads yms-home/config,
    //            i.e. the copy rewritten to 127.0.0.1 for the local forwarder.
    //   direct - the JVM carries no proxy flag at all; when dsh still needs the
    //            tunnel, it reads the untouched copy in yms-home/config-direct.
    // The two modes must never share a config directory or leak flags into each
    // other: a 127.0.0.1 address in a direct launch (or a stale socks flag in a
    // proxy-less launch) points the JVM at a port nobody listens on.
    launchMode: String(envValues['ide.launch'] ?? 'proxy').trim() === 'direct' ? 'direct' : 'proxy',
    configDir: join(ymsHome, 'config'),
    configDirectDir: join(ymsHome, 'config-direct'),
    // ProxyBridge rules for `*java*`. Off by default because the YMS JVM gets
    // `-DsocksProxyHost` from the YonCode bundle patch (`yds yoncode patch`), and
    // funnelling Oracle through WinDivert breaks the TNS handshake (reset after
    // CONNECT). Set `proxy.javaRules=on` when you need system-level coverage for
    // java processes that have no JVM proxy flag.
    proxyJavaRules: (envValues['proxy.javaRules'] ?? '') === 'on',
    // Whether `yds start` should also write the scoped git proxy entry (so plain
    // git / dsh-git honour SOCKS without a -c flag). 'off' leaves git alone.
    gitProxy: envValues['git.proxy'] ?? 'auto',
    // Front-end dev server (webpack `debug:extend`): the dev extension and the CDP
    // plan both point at it, so the port is config, not a literal in the rule text.
    // Front-end dev server, as declared by the project (see pickFrontend).
    frontend,
    fePort: frontend.port,
    git,
    maven,
    stateDir: join(workspace, '.dsh-ris-yds'),
  }
  cfg.java = detectJava(cfg)

  if (project === null) problems.push('未找到含 yds.* 键的 .vscode/settings.json（项目配置缺失或项目未检出）')
  if (cfg.accessKey == null || cfg.accessSecret == null) problems.push('缺少 yds.accessKey / yds.accessSecret（settings.json）——YYCToken 与 confcenter 拉取不可用')
  if (cfg.serverBindAddress == null) problems.push('缺少 yds.serverBindAddress（settings.json）——rdbga 回调地址无法确定')
  if (cfg.module == null) problems.push(rawModule !== null ? `模块名 "${rawModule}" 含非法字符（仅允许字母数字._-），已拒绝` : '未能从 yonbuilder.json / module.xml 识别模块名')
  if (cfg.java == null) problems.push('未找到 JDK（可用 .env 的 java.path 或 JAVA_HOME 指定）')
  const launchRaw = envValues['ide.launch']
  if (launchRaw !== undefined && !['proxy', 'direct'].includes(String(launchRaw).trim())) {
    problems.push(`ide.launch 只能是 proxy / direct（当前 "${launchRaw}"）`)
  }
  return { config: cfg, problems }
}

/** Human-readable dump of the effective config (secrets masked). */
export function describeConfig(cfg) {
  const mask = (v) => (typeof v === 'string' && v !== '' ? `${v.slice(0, 4)}…${v.slice(-2)}(${v.length})` : '(缺失)')
  // never echo user:pass@ / user:token@ embedded in a URL
  const stripUrlUser = (u) => (typeof u === 'string' && u !== '' ? u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, '$1***@') : '(缺失)')
  const lines = [
    `workspace: ${cfg.workspace}`,
    `platform: ${cfg.platform}-${cfg.arch}${cfg.isWsl ? ' (WSL)' : ''}${cfg.isWindows ? ' (Windows)' : ''}`,
    `project: ${cfg.projectDir ?? '(未检出)'}  module: ${cfg.module ?? '(未检出)'}`,
    `workbenchUrl: ${cfg.workbenchUrl || '(缺失)'}  env: ${cfg.env}`,
    `accessKey: ${mask(cfg.accessKey)}  accessSecret: ${mask(cfg.accessSecret)}`,
    `serverBindAddress: ${cfg.serverBindAddress ?? '(缺失)'}  serverPort: ${cfg.serverPort}`,
    `ymsPort(本地监听): ${cfg.ymsPort}  ymsHome: ${cfg.ymsHome}`,
    `java: ${cfg.java ?? '(未找到)'}`,
    `socks: ${cfg.socks !== null ? `${cfg.socks.host}:${cfg.socks.port} (db→127.0.0.1:${cfg.dbForwardPort}, redis→127.0.0.1:${cfg.redisForwardPort})` : '(未配置，直连)'}`,
    `launch: ide.launch=${cfg.launchMode}  config=${cfg.configDir}${cfg.socks !== null ? `  direct=${cfg.configDirectDir}` : ''}`,
    `proxy engine: ${cfg.proxyEngine}${cfg.proxyListenPort > 0 ? ` listen=${cfg.proxyListenPort}` : ''}  git.proxy=${cfg.gitProxy}  fe.port=${cfg.fePort}(来自项目配置)`,
    `.env: ${cfg.settingsEnv.exists ? cfg.settingsEnv.path : '(不存在，可选)'}`,
    `git: ${cfg.git !== null ? `${stripUrlUser(cfg.git.url)} proxy=${cfg.git.proxy ?? '直连'} commit=${cfg.git.commit}` : '(未配置)'}`,
    `maven: repo=${cfg.maven.repo ?? '默认 ~/.m2'}  settings=${cfg.maven.settingsXml ?? '(生成 jfrog settings)'}`,
  ]
  return lines.join('\n')
}

/** jfrog repository base derived from the workbench URL (same host). */
export function artifactoryUrl(cfg) {
  if (typeof cfg.workbenchUrl !== 'string' || cfg.workbenchUrl.trim() === '') {
    throw new Error('workbenchUrl 缺失——在项目 .vscode/settings.json 配置 yds.workbenchUrl 后重试')
  }
  let u
  try { u = new URL(cfg.workbenchUrl) } catch { throw new Error(`workbenchUrl 不是合法 URL: ${cfg.workbenchUrl}`) }
  return `${u.protocol}//${u.host}/artifactory/repository/`
}
