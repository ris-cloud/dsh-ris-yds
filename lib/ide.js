// dsh-ris-ide integration (user requirement 4): check / update the workspace
// run config `.dsh-ris-ide/config.json` so the YMS program appears in the
// ris-ide panel and is start/stop/JDWP-debuggable through ris_dev_* tools.
//
// We only UPSERT our own entry by name; every other entry the user keeps is
// preserved verbatim. JSONC comments are tolerated on read (ris-ide parses
// JSONC); our write serializes plain JSON with a short header comment — the
// same thing the ris-ide panel does when it generates the file.
//
// ALSO: `.vscode/launch.json` — YonCode generates a VS Code java launch
// entry ("yms-middleware-cloudnative-jdk-21") on startup via its
// ensureLaunchConfig so F5 starts/debugs the YMS middleware inside YonCode.
// We generate the byte-equivalent entry (same name → no duplicate when both
// sides write) so a workspace shared with YonCode keeps a working F5 path
// that either side can (re)create. ${command:yds.*}/${config:yds.*}
// placeholders are resolved by YonCode itself — that is intentional.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { resolveConfig } from './config.js'
import { fileURLToPath } from 'node:url'

export const IDE_CONFIG = join('.dsh-ris-ide', 'config.json')
export const LAUNCH_CONFIG = join('.vscode', 'launch.json')
export const LAUNCH_ENTRY_NAME = 'yms-middleware-cloudnative-jdk-21'
// Sibling of yms-home/config holding the UNTOUCHED confcenter copy, used by
// the direct launch mode while dsh itself still goes through SOCKS.
export const DIRECT_CONFIG_DIRNAME = 'config-direct'
const HEADER = '// dsh-ris-ide 程序配置（JSONC：允许注释与尾逗号）\n'
  + '// dsh-ris-yds 维护 YMS 程序条目（名字=项目 parent.artifactId；startCommand 内含 ${JDWP_ARGS} 占位符，ris_dev_debug 会替换为 JDWP 参数）。\n'
  '// 其余条目由用户/面板维护，此工具不会触碰。\n'
const LAUNCH_HEADER = '// dsh-ris-yds 维护 yms-middleware 运行配置（与 YonCode ensureLaunchConfig 生成的条目同名同构，任一侧写入均有效）。\n'
  '// 其余 configuration 条目由用户/YonCode 维护，此工具不会触碰。\n'

/** First match of one XML attribute in the whole document, `''` when absent. */
export function readXmlAttribute(text, tag, attribute) {
  const match = new RegExp(`<${tag}\\b[^>]*\\s${attribute}\\s*=\\s*"([^"]*)"`).exec(text)
  return match === null ? '' : match[1].trim()
}

/** `<parent><artifactId>` of a pom, `''` when the pom has no parent block. */
export function readPomParentArtifactId(pomPath) {
  try {
    const text = readFileSync(pomPath, 'utf8')
    const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)
    if (parent === null) return ''
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(parent[1])
    return artifact === null ? '' : artifact[1]
  } catch {
    return ''
  }
}

/** The bootstrap module's pom (`*bootstrap/pom.xml`) under a yds project root. */
export function findBootstrapPom(projectDir) {
  if (typeof projectDir !== 'string' || projectDir === '') return ''
  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (entry.isDirectory() !== true) continue
      if (/bootstrap$/.test(entry.name) !== true) continue
      const pom = join(projectDir, entry.name, 'pom.xml')
      if (existsSync(pom)) return pom
    }
  } catch {
    // A missing/unreadable project root just falls back to the module name.
  }
  return ''
}

/**
 * Name of the java program, as the user asked: `parent.artifactId` of the
 * bootstrap pom (the aggregator's artifactId, e.g. `c-ass-kk-hans`) — the same
 * value the YMS module is deployed under, so the panel row reads like the
 * project rather than like our own bookkeeping.
 * @param {object} cfg - resolved plugin config.
 * @returns {string} project name, falling back to the YMS module name.
 */
export function javaProjectName(cfg) {
  const pom = findBootstrapPom(cfg?.projectDir)
  const name = pom === '' ? '' : readPomParentArtifactId(pom)
  if (name !== '') return name
  return cfg?.module ?? 'local'
}

/**
 * Name of a frontend program: `module.xml`'s `<module name="…">` that sits
 * beside `package.json` (the MDF convention), not the directory name.
 * @param {object} cfg - resolved plugin config.
 * @param {string} [dir] - frontend directory; defaults to the configured one.
 * @returns {string} project name, `''` when no such module.xml exists.
 */
export function frontendProjectName(cfg, dir) {
  const explicit = typeof dir === 'string' && dir !== '' ? dir : ''
  if (explicit !== '') {
    const file = join(explicit, 'module.xml')
    if (existsSync(file)) {
      const name = readXmlAttribute(readFileSync(file, 'utf8'), 'module', 'name')
      if (name !== '') return name
    }
    return ''
  }
  const root = cfg?.projectDir
  if (typeof root !== 'string' || root === '') return ''
  const preferred = cfg?.frontend?.code
  const candidates = []
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() !== true || entry.name.startsWith('.') === true) continue
      const dirPath = join(root, entry.name)
      const moduleXml = join(dirPath, 'module.xml')
      if (!existsSync(moduleXml) || !existsSync(join(dirPath, 'package.json'))) continue
      const name = readXmlAttribute(readFileSync(moduleXml, 'utf8'), 'module', 'name')
      if (name !== '') candidates.push({ dir: dirPath, name })
    }
  } catch {
    return ''
  }
  if (candidates.length === 0) return ''
  const match = candidates.find((item) => item.name === preferred || item.dir.endsWith(`/${preferred}`) === true)
  return (match ?? candidates[0]).name
}

export function entryName(cfg) {
  return javaProjectName(cfg)
}

/**
 * A row is ours when it runs our CLI, or when it is a spring row named after the
 * project (the legacy name counts too, so apply/remove stay idempotent).
 *
 * The `kind` guard matters: a *frontend* row can legitimately carry the same name
 * (a yds project's package.json name is the backend domainKey), and treating that
 * row as ours would delete it on the next apply.
 */
export function isOurs(entry, cfg) {
  if (entry === null || typeof entry !== 'object') return false
  // Our launcher is always a spring row. Checking the kind *first* keeps a frontend
  // row from claiming ours-ness just because an old update copied the command onto it.
  if (entry.kind !== undefined && entry.kind !== 'spring' && entry.kind !== 'manual') return false
  const command = typeof entry.startCommand === 'string' ? entry.startCommand : ''
  if (command.includes('bin/yds.js')) return true
  if (entry.name === entryName(cfg)) return true
  return typeof cfg?.module === 'string' && entry.name === `yds-yms-${cfg.module}`
}

/**
 * The program entry we manage. startCommand runs our cross-OS node CLI in
 * FOREGROUND mode — dsh-ris-ide's run-with-log wrapper owns the lifecycle.
 */
export function ourEntry(cfg) {
  const bin = fileURLToPath(new URL('../bin/yds.js', import.meta.url))
  // The startCommand is executed through a shell by ris-ide wrappers (bash /
  // PowerShell). Inside double quotes both treat $, backtick and " as live
  // metacharacters — a plugin path containing them would be command
  // injection. Refuse up front instead of trying to out-quote two shells.
  if (/[$`"]/.test(bin)) {
    throw new Error(`插件路径含 shell 元字符（\$ \` "），无法安全生成 startCommand: ${bin}——请将插件安装到不含这些字符的路径`)
  }
  const esc = bin
  return {
    // A stable id of our own: the config update matches by id first, and without one
    // it fell back to *name* — which hijacked a discovered frontend row that carried
    // the same name and dropped this launcher from the config.
    id: `yds:${entryName(cfg)}`,
    name: entryName(cfg),
    // kind=spring is required for ris_dev_debug (JDWP) eligibility: the panel
    // only debugs spring rows. Our startCommand still wins over the default
    // spring launch (custom startCommand bypasses mvn/mainClass), so this only
    // unlocks the debug button without changing the start path.
    kind: 'spring',
    dir: cfg.workspace,
    startCommand: `node "${esc}" start --foreground --jvm-args "${'${JDWP_ARGS}'}"`,
    logName: entryName(cfg),
    stopGraceMs: 60000,
  }
}

/** Read the current file: { exists, parsed, raw, path }. */
export function readIdeConfig(workspace) {
  const path = join(workspace, IDE_CONFIG)
  if (!existsSync(path)) return { exists: false, path, parsed: null }
  const raw = readFileSync(path, 'utf8')
  let parsed = null
  try {
    parsed = JSON.parse(stripJsonc(raw))
  } catch { parsed = null }
  return { exists: true, path, parsed, raw }
}

/**
 * The yds project a program directory belongs to, judged from the **parent** dir up.
 *
 * A program row only gives us a directory. The yds project root always sits *between*
 * that directory and the workspace: a module dir (or the project dir itself) never
 * carries the IDE settings, one of its ancestors does. So the walk starts at `dir` and
 * climbs to the workspace; the first level whose `.vscode/settings.json` contains
 * `yds.`-prefixed settings is the project root, and everything beneath it belongs to
 * that project.
 * @param {string} workspace - session workspace; the walk stops there.
 * @param {string} dir - absolute directory of a program (e.g. `…/c-ass-kk-hans-fe`).
 * @returns {string} the project root, `''` when the program is not in a yds project.
 */
export function ydsProjectRootOf(workspace, dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  const stop = typeof workspace === 'string' && workspace !== '' ? resolve(workspace) : ''
  let current = resolve(dir)
  for (let depth = 0; depth < 8; depth += 1) {
    const settings = join(current, '.vscode', 'settings.json')
    if (existsSync(settings)) {
      try {
        // JSONC: the key prefix is what matters, a comment cannot fake it.
        if (/"yds\.[A-Za-z]/.test(readFileSync(settings, 'utf8'))) return current
      } catch {
        // unreadable settings: keep walking up
      }
    }
    const parent = dirname(current)
    if (parent === current) return ''
    if (stop !== '' && current === stop) return ''
    current = parent
  }
  return ''
}

/**
 * The name a yds program should carry, taken from the project's own files.
 *
 * `module.xml`'s `<module name>` for a frontend (falling back to the folder name),
 * and for a java module the pom's `parent.artifactId` — the aggregator's identity —
 * or, for the aggregator itself, its own artifactId.
 * @param {string} dir - absolute program directory.
 * @returns {string} the intended name, `''` when the files say nothing.
 */
export function ydsProgramName(dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  const moduleXml = join(dir, 'module.xml')
  if (existsSync(moduleXml)) {
    const named = readXmlAttribute(readFileSync(moduleXml, 'utf8'), 'module', 'name')
    return named !== '' ? named : basename(dir)
  }
  const pom = join(dir, 'pom.xml')
  if (!existsSync(pom)) return ''
  const text = readFileSync(pom, 'utf8')
  if (/<modules>/.test(text) === true) return readPomArtifactId(text)
  return readPomParentArtifactId(pom)
}

/** The pom's own artifactId: the first one outside the `<parent>` block. */
export function readPomArtifactId(text) {
  if (typeof text !== 'string') return ''
  const own = text.replace(/<parent>[\s\S]*?<\/parent>/, '')
  const match = /<artifactId>([^<]*)<\/artifactId>/.exec(own)
  return match === null ? '' : match[1].trim()
}

/** Whether a config row belongs to a yds project (decided by `dir`, never by name). */
export function belongsToYdsProject(cfg, row) {
  if (row === null || typeof row !== 'object') return false
  const dir = typeof row.dir === 'string' && row.dir !== '' ? resolve(cfg.workspace, row.dir) : ''
  return dir !== '' && ydsProjectRootOf(cfg.workspace, dir) !== ''
}

/**
 * Rename every row that belongs to a yds project, using that project's own files.
 *
 * A row is judged by `dir` alone: walk up to the nearest `.vscode/settings.json` with
 * `yds.` settings, then name the row after `module.xml` (frontend) or the aggregator
 * pom's `parent.artifactId` (java). Rows outside a yds project are never touched, and
 * a rename that would duplicate another row's name is skipped instead of applied.
 * @param {object} cfg - resolved plugin config (workspace is the walk bound).
 * @param {object[]} programs - config rows.
 * @returns {{programs: object[], renamed: object[], skipped: object[]}} the outcome.
 */
export function repairFrontendNames(cfg, programs) {
  const renamed = []
  const skipped = []
  if (!Array.isArray(programs)) return { programs, renamed, skipped }
  const rows = programs.map((row) => (row === null || typeof row !== 'object' ? row : { ...row }))
  // Names of rows that will not be renamed stay reserved, so we never create a clash.
  const taken = new Set()
  const targets = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const dir = typeof row.dir === 'string' && row.dir !== '' ? resolve(cfg.workspace, row.dir) : ''
    if (dir === '' || ydsProjectRootOf(cfg.workspace, dir) === '') { taken.add(row.name); continue }
    targets.push({ row, dir })
  }
  for (const { row, dir } of targets) {
    const name = ydsProgramName(dir)
    if (name === '' || name === row.name) { taken.add(row.name); continue }
    if (taken.has(name) === true) { skipped.push({ from: row.name, to: name, reason: '名字已被另一条目占用' }); taken.add(row.name); continue }
    renamed.push({ from: row.name, to: name })
    row.name = name
    taken.add(name)
  }
  return { programs: rows, renamed, skipped }
}

/**
 * Reconcile every row that belongs to a yds project with what that project *is*.
 *
 * Three things happen to rows inside a yds project (judged by `dir` → the nearest
 * ancestor `.vscode/settings.json` with `yds.` settings):
 *   1. rename after the project's own files (`module.xml`, pom parent artifactId);
 *   2. disable the discovered backend rows — the yds launcher starts that same app
 *      against the same port, so leaving both enabled creates two rival starters;
 *   3. strip a `bin/yds.js` startCommand from any row that is not ours — an older
 *      update could copy the launcher's command onto a frontend row.
 * @param {object} cfg - resolved plugin config.
 * @param {object[]} programs - config rows.
 * @returns {{programs: object[], renamed: object[], skipped: object[], disabled: object[], cleaned: object[]}}
 */
export function repairYdsRows(cfg, programs) {
  const repaired = repairFrontendNames(cfg, programs)
  const { renamed, skipped } = repaired
  const disabled = []
  const cleaned = []
  const rows = repaired.programs.map((row) => {
    if (row === null || typeof row !== 'object') return row
    const ours = isOurs(row, cfg) === true
    if (ours !== true && typeof row.startCommand === 'string' && row.startCommand.includes('bin/yds.js')) {
      cleaned.push({ name: row.name, startCommand: row.startCommand })
      const { startCommand, ...rest } = row
      row = rest
    }
    if (ours !== true && row.kind === 'spring' && row.disabled !== true && belongsToYdsProject(cfg, row) === true) {
      disabled.push({ name: row.name, dir: row.dir })
      row = { ...row, disabled: true }
    }
    return row
  })
  return { programs: rows, renamed, skipped, disabled, cleaned }
}

/**
 * Apply our entry: add or refresh it, preserving all others.
 * @returns { changed, action: 'created'|'added'|'updated'|'unchanged', path }
 */
/** The document ris-ide itself generates, so an initialised file looks native. */
export function emptyIdeConfigDocument() {
  return { version: 1, defaults: { jvmArgs: [] }, programs: [] }
}

/**
 * Create the config file when it does not exist yet.
 *
 * Writing our row into a file ris-ide never generated would leave it without the
 * `version`/`defaults` keys the panel writes and expects; initialising first keeps
 * one shape whether the panel or this plugin created it.
 * @returns {{created: boolean, path: string}} what happened.
 */
export function initializeIdeConfig(workspace) {
  const path = join(workspace, IDE_CONFIG)
  if (existsSync(path)) return { created: false, path }
  mkdirSync(dirname(path), { recursive: true })
  writeIdeConfig(path, emptyIdeConfigDocument())
  return { created: true, path }
}

export function applyIdeConfig(cfg) {
  const initialized = initializeIdeConfig(cfg.workspace)
  const current = readIdeConfig(cfg.workspace)
  const entry = ourEntry(cfg)
  if (current.exists === false) {
    mkdirSync(dirname(current.path), { recursive: true })
    writeIdeConfig(current.path, { ...emptyIdeConfigDocument(), programs: [entry] })
    return { changed: true, action: 'created', initialized: initialized.created, path: current.path, entry }
  }
  if (current.parsed === null) {
    return { changed: false, action: 'error', error: `${current.path} 不是合法 JSON，为避免破坏用户配置未写入`, path: current.path }
  }
  const programs = Array.isArray(current.parsed.programs) ? current.parsed.programs : []
  const others = programs.filter((p) => isOurs(p, cfg) !== true)
  const idx = programs.findIndex((p) => isOurs(p, cfg) === true)
  if (idx >= 0 && JSON.stringify(programs[idx]) === JSON.stringify(entry)) {
    return { changed: false, action: 'unchanged', initialized: initialized.created, path: current.path, entry }
  }
  const repaired = repairYdsRows(cfg, [...others, entry])
  const next = { ...current.parsed }
  next.programs = repaired.programs
  writeIdeConfig(current.path, next)
  const action = initialized.created ? 'created' : (idx >= 0 ? 'updated' : 'added')
  return {
    changed: true, action, initialized: initialized.created, path: current.path, entry,
    renamed: repaired.renamed, skipped: repaired.skipped, disabled: repaired.disabled, cleaned: repaired.cleaned,
  }
}

/** Remove our entry if present. */
export function removeIdeConfig(cfg) {
  const current = readIdeConfig(cfg.workspace)
  if (current.exists === false) return { changed: false, action: 'missing' }
  if (current.parsed === null) return { changed: false, action: 'error', error: '配置文件不是合法 JSON' }
  const programs = Array.isArray(current.parsed.programs) ? current.parsed.programs : []
  const rest = programs.filter((p) => isOurs(p, cfg) !== true)
  if (rest.length === programs.length) return { changed: false, action: 'not-present' }
  const next = { ...current.parsed, programs: rest }
  writeIdeConfig(current.path, next)
  return { changed: true, action: 'removed' }
}

function writeIdeConfig(path, doc) {
  writeFileSync(path, `${HEADER}${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/**
 * JVM flags that make a YonCode/VS Code-launched java use the SOCKS tunnel.
 *
 * This is the only way to proxy a process we do not spawn ourselves: YonCode
 * reads vmArgs from launch.json, so the flags travel with the configuration.
 * JDBC is not affected (drivers ignore SOCKS — those need the 127.0.0.1 map).
 * @param cfg - resolved plugin config (uses `cfg.socks`).
 * @returns the vmArgs to append (`[]` when no tunnel is configured).
 */
export function proxyVmArgs(cfg) {
  const socks = cfg?.socks ?? null
  if (socks === null || typeof socks !== 'object') return []
  return [
    `-DsocksProxyHost=${socks.host}`,
    `-DsocksProxyPort=${socks.port}`,
    '-Djava.net.useSystemProxies=false',
  ]
}

/**
 * The JVM flags that select the launch mode — the ONLY place proxy flags may
 * come from, so the two modes can never be mixed:
 *   - proxy (default): {@link proxyVmArgs} (the SOCKS tunnel flags);
 *   - direct: nothing, except `-Dlocal_conf_path=<ymsHome>/config-direct/` when
 *     SOCKS is still configured (dsh needs the tunnel, YonCode must not).
 * @param cfg - resolved plugin config (uses `cfg.launchMode`, `cfg.socks`).
 * @returns the vmArgs to append.
 */
export function launchModeVmArgs(cfg) {
  const sep = process.platform === 'win32' ? '\\' : '/'
  if ((cfg?.launchMode ?? 'proxy') === 'direct') {
    const socks = cfg?.socks ?? null
    if (socks === null || typeof socks !== 'object') return []
    return [
      `-Dlocal_conf_path=\${config:yds.ymsHome}${sep}${DIRECT_CONFIG_DIRNAME}${sep}`,
      '-Dyms_use_local_conf=true',
    ]
  }
  return proxyVmArgs(cfg)
}

/** True for the flags {@link proxyVmArgs} writes — used when taking them back out. */
function isProxyVmArg(value) {
  return typeof value === 'string'
    && (/^-DsocksProxy(Host|Port)=/.test(value) || value === '-Djava.net.useSystemProxies=false')
}

/**
 * The launch.json configuration we manage — byte-equivalent to what YonCode's
 * ensureLaunchConfig writes (verified against the generated file), so YonCode
 * F5 and a regenerated file stay interchangeable. Windows path separators on
 * win32, forward slashes elsewhere.
 * @param cfg - resolved plugin config; the mode-dependent flags come from
 *   {@link launchModeVmArgs} (`ide.launch=proxy|direct`).
 */
export function ourLaunchEntry(cfg) {
  const win = process.platform === 'win32'
  const sep = win ? '\\' : '/'
  const javaExec = `\${config:yds.ymsHome}${sep}${win ? 'win32-x64-java.exe' : 'linux-x64-java'}`
  const javaHome = `\${command:yds.javaHome}${sep}bin${sep}java${win ? '.exe' : ''}`
  const exports = [
    ['--add-exports', 'java.base/sun.security.action=ALL-UNNAMED'],
    ['--add-exports', 'java.naming/com.sun.jndi.ldap=ALL-UNNAMED'],
    ['--add-exports', 'java.naming/com.sun.jndi.url.ldap=ALL-UNNAMED'],
    ['--add-exports', 'jdk.naming.dns/com.sun.jndi.dns=ALL-UNNAMED'],
    ['--add-exports', 'jdk.naming.dns/com.sun.jndi.url.dns=ALL-UNNAMED'],
    ['--add-exports', 'java.security.jgss/sun.security.krb5.internal=ALL-UNNAMED'],
    ['--add-exports', 'jdk.attach/sun.tools.attach=ALL-UNNAMED'],
  ]
  const opens = [
    ['--add-opens', 'java.base/java.util=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.lang=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.util.concurrent=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.io=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.nio=ALL-UNNAMED'],
    ['--add-opens', 'java.base/sun.nio.ch=ALL-UNNAMED'],
    ['--add-opens', 'java.naming/javax.naming.spi=ALL-UNNAMED'],
    ['--add-opens', 'java.naming/com.sun.naming.internal=ALL-UNNAMED'],
    ['--add-opens', 'jdk.naming.rmi/com.sun.jndi.url.rmi=ALL-UNNAMED'],
    ['--add-opens', 'java.naming/javax.naming=ALL-UNNAMED'],
    ['--add-opens', 'java.rmi/java.rmi=ALL-UNNAMED'],
    ['--add-opens', 'java.sql/java.sql=ALL-UNNAMED'],
    ['--add-opens', 'java.management/javax.management=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED'],
    ['--add-opens', 'java.desktop/java.awt.image=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.security=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.net=ALL-UNNAMED'],
    ['--add-opens', 'java.base/java.text=ALL-UNNAMED'],
    ['--add-opens', 'java.base/sun.net.www.protocol.https=ALL-UNNAMED'],
  ]
  return {
    type: 'java',
    name: LAUNCH_ENTRY_NAME,
    javaExec,
    request: 'launch',
    mainClass: 'iuap.yms.YMSLauncher',
    cwd: '${config:yds.ymsHome}',
    classPaths: [`\${config:yds.ymsHome}${sep}yms.jar`],
    args: [],
    vmArgs: [
      `-Djavax.net.ssl.trustStore=\${config:yds.ymsHome}${sep}cacerts`,
      '-Dapp.metainfo.ping_connect_timeout=200',
      `-DYMS_WORK_PATH=\${config:yds.ymsHome}${sep}workarea`,
      '-DYMS-DEV=true',
      '-DYMS-DEV-MODE=debug',
      '-Dyms.log.path=${config:yds.ymsHome}' + sep + 'logs',
      '-Dyms.dev.libProjectsFile=${command:yds.libraryProjectsFile}',
      '-Dapp.metainfo.preferred-networks=${command:yds.serverBindAddress}',
      '-Dserver.port=${config:yds.serverPort}',
      ...exports.flat(),
      ...opens.flat(),
      // YonCode appends these two exports AFTER the opens block — same flags,
      // order kept identical for byte-parity with ensureLaunchConfig output.
      '--add-exports', 'jdk.management.agent/jdk.internal.agent=ALL-UNNAMED',
      '--add-exports', 'java.base/jdk.internal.vm=ALL-UNNAMED',
      '-Dyms_fetch_config_version=2.0.0',
      '-Dinotify_enable=false',
      '-Dapp.metainfo.start_mode=static',
      '-Dyms.bootstrap.enableNewConfig=true',
      '-Drdbga=${command:yds.getEncryptedRDBGA}',
      // Mode switch: proxy → SOCKS flags (removed again by `yds proxy stop`);
      // direct → no proxy flag, and (when dsh still tunnels) the untouched
      // config-direct via local_conf_path. See launchModeVmArgs.
      ...launchModeVmArgs(cfg),
    ],
    env: {
      JAVA_EXECUTABLE: javaHome,
      mw_profiles_active: '${command:yds.env}',
      YDS_STATE: '${command:yds.preLaunch}',
      'access.key': '${config:yds.accessKey}',
      'access.secret': '${config:yds.accessSecret}',
      enable_cloud_debug: 'true',
      YMS_ENABLE_MODULE: '${command:yds.getSelectedYmsModules}',
      yms_enable_module: '${command:yds.getSelectedYmsModules}',
    },
    projectName: 'yds',
  }
}

/**
 * Where .vscode/launch.json lives: the PROJECT folder the IDE actually opens
 * (`cfg.projectDir`, i.e. the dir holding .vscode/settings.json — e.g.
 * yonasset/), NOT the DSH session workspace root. Falling back to the
 * session workspace when no project dir was detected keeps this usable in a
 * bare checkout.
 */
export function launchRoot(cfg) {
  return cfg.projectDir ?? cfg.workspace
}

/** Read .vscode/launch.json: { exists, parsed, path }. */
export function readLaunchConfig(workspace) {
  const path = join(workspace, LAUNCH_CONFIG)
  if (!existsSync(path)) return { exists: false, path, parsed: null }
  const raw = readFileSync(path, 'utf8')
  let parsed = null
  try {
    parsed = JSON.parse(stripJsonc(raw))
  } catch { parsed = null }
  return { exists: true, path, parsed, raw }
}

/**
 * Upsert our launch.json configuration, preserving all others (Current File /
 * MDFApplication / workbench / anything YonCode wrote).
 */
export function applyLaunchConfig(cfg) {
  const current = readLaunchConfig(launchRoot(cfg))
  const entry = ourLaunchEntry(cfg)
  if (current.exists === false) {
    mkdirSync(dirname(current.path), { recursive: true })
    writeLaunchConfig(current.path, { version: '0.2.0', configurations: [entry] })
    return { changed: true, action: 'created', path: current.path, entry }
  }
  if (current.parsed === null) {
    return { changed: false, action: 'error', error: `${current.path} 不是合法 JSON，为避免破坏用户配置未写入`, path: current.path }
  }
  const configs = Array.isArray(current.parsed.configurations) ? current.parsed.configurations : []
  const others = configs.filter((c) => c?.name !== entry.name)
  const idx = configs.findIndex((c) => c?.name === entry.name)
  if (idx >= 0 && JSON.stringify(configs[idx]) === JSON.stringify(entry)) {
    return { changed: false, action: 'unchanged', path: current.path, entry }
  }
  const next = { ...current.parsed }
  next.configurations = [...others, entry]
  writeLaunchConfig(current.path, next)
  return { changed: true, action: idx >= 0 ? 'updated' : 'added', path: current.path, entry }
}

/**
 * Take the tunnel flags back out of our launch entry (everything else stays).
 *
 * Called when the proxy engine stops: leaving `-DsocksProxyHost` behind would
 * point YonCode's java at a dead port on the next F5.
 * @param cfg - resolved plugin config.
 * @returns `{ changed, action }`.
 */
export function stripLaunchProxy(cfg) {
  const current = readLaunchConfig(launchRoot(cfg))
  if (current.exists === false) return { changed: false, action: 'missing' }
  if (current.parsed === null) return { changed: false, action: 'error', error: 'launch.json 不是合法 JSON' }
  const configs = Array.isArray(current.parsed.configurations) ? current.parsed.configurations : []
  const idx = configs.findIndex((c) => c?.name === LAUNCH_ENTRY_NAME)
  if (idx < 0) return { changed: false, action: 'not-present' }
  const vmArgs = Array.isArray(configs[idx].vmArgs) ? configs[idx].vmArgs : []
  const kept = vmArgs.filter((value) => !isProxyVmArg(value))
  if (kept.length === vmArgs.length) return { changed: false, action: 'no-proxy-args' }
  const next = { ...current.parsed }
  next.configurations = configs.map((entry, index) => (index === idx ? { ...entry, vmArgs: kept } : entry))
  writeLaunchConfig(current.path, next)
  return { changed: true, action: 'stripped' }
}

/** Remove our launch.json configuration if present. */
export function removeLaunchConfig(cfg) {
  const current = readLaunchConfig(launchRoot(cfg))
  if (current.exists === false) return { changed: false, action: 'missing' }
  if (current.parsed === null) return { changed: false, action: 'error', error: 'launch.json 不是合法 JSON' }
  const configs = Array.isArray(current.parsed.configurations) ? current.parsed.configurations : []
  const rest = configs.filter((c) => c?.name !== LAUNCH_ENTRY_NAME)
  if (rest.length === configs.length) return { changed: false, action: 'not-present' }
  const next = { ...current.parsed, configurations: rest }
  writeLaunchConfig(current.path, next)
  return { changed: true, action: 'removed' }
}

function writeLaunchConfig(path, doc) {
  writeFileSync(path, `${LAUNCH_HEADER}${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/**
 * String-aware JSONC strip in a single pass: removes // and /* *\/ comments
 * and trailing commas ONLY outside string literals. The old regex version
 * ate "http://" inside strings and ",]" sequences in startCommands —
 * silently corrupting user config on round-trip.
 */
function stripJsonc(text) {
  let outText = ''
  let i = 0
  const n = text.length
  const skipWsAndComments = (pos) => {
    let j = pos
    for (;;) {
      const ch = text[j]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { j += 1; continue }
      if (ch === '/' && text[j + 1] === '/') { while (j < n && text[j] !== '\n' && text[j] !== '\r') j += 1; continue }
      if (ch === '/' && text[j + 1] === '*') { const close = text.indexOf('*/', j + 2); j = close === -1 ? n : close + 2; continue }
      return j
    }
  }
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '"') break
        j += 1
      }
      const stop = Math.min(j + 1, n)
      outText += text.slice(i, stop)
      i = stop
      continue
    }
    if (c === '/' && text[i + 1] === '/') { i = skipWsAndComments(i); continue }
    if (c === '/' && text[i + 1] === '*') { i = skipWsAndComments(i); continue }
    if (c === ',') {
      const j = skipWsAndComments(i + 1)
      if (text[j] === '}' || text[j] === ']') { i = j; continue } // trailing comma — drop
      outText += c
      i += 1
      continue
    }
    outText += c
    i += 1
  }
  return outText
}

/**
 * Reconcile the panel config of one workspace with what its yds project is.
 *
 * Used by the config watcher (see `lib/ide-watch.js`): ris-ide rewrites the file on
 * init/refresh, we put our launcher row and the yds names back. Nothing happens when
 * the workspace has no yds project or no config file — the add-on never creates one.
 * @param workspace - absolute workspace root.
 * @returns {Promise<{changed: boolean, reason: string}>} outcome for logging.
 */
export async function reconcileWorkspaceConfig(workspace) {
  const { config: cfg } = resolveConfig(workspace)
  if (typeof cfg.projectDir !== 'string' || cfg.projectDir === '') return { changed: false, reason: 'no-project' }
  if (existsSync(join(cfg.workspace, '.dsh-ris-ide', 'config.json')) !== true) {
    return { changed: false, reason: 'no-config' }
  }
  const result = applyIdeConfig(cfg)
  return { changed: result.changed === true, reason: result.action }
}
