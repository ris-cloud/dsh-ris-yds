// confcenter sync: pull the 4 YMS config files over YYCToken, cache the raw
// copies, and write the SOCKS-adapted (or direct) versions into yms-home/config.
// This replaces any bundled "golden config": a fresh environment pulls its own.
//
// Bump ADAPT_VERSION whenever the adaptation logic below changes shape: an
// existing yms-home/config written by an older adapter is then re-adapted from
// the cache on the next `yds start` (otherwise "yms_middleware.json exists"
// would short-circuit and old rewrites would stay live forever).
export const ADAPT_VERSION = '3'

/**
 * Marker content for the current adaptation shape and mode.
 * @param {boolean} rewrite - whether addresses were rewritten to 127.0.0.1.
 * @returns {string} marker string compared by adaptIsCurrent().
 */
export function adaptMarker(rewrite) {
  return `${ADAPT_VERSION}:${rewrite ? 'rewrite' : 'direct'}`
}

// Private IPv4 ranges (RFC1918). Hosts in these ranges are on the dev-machine
// side of the SOCKS tunnel and get rewritten to 127.0.0.1:<localPort>.
const PRIVATE_HOST = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/
// Hostnames the SOCKS server cannot resolve/reach (k8s-internal DNS): left
// unrewritten so behavior is unchanged, with a loud warning.
const UNREACHABLE_HOST = /\.inner-yonbip-k8s\.com$/i
// host(:port) occurrences inside string values (urls, "h:p" lists, "h1:p1,h2:p2")
const HOSTPORT_RE = /\b((?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]):(\d{2,5})\b/g

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getYycToken } from './token.js'

export const CONF_FILES = ['yonbip_config.json', 'yms_middleware.json', 'module_config.json', 'ip_node_mapping.json']
// ip_node_mapping.json is NOT served by this endpoint (it is generated locally
// by the YonCode sync step); the other three come from confcenter.
const PULLED_FILES = ['yonbip_config.json', 'yms_middleware.json', 'module_config.json']

/**
 * Pull the confcenter bundle for one app.
 * GET <workbench>/iuap-yms-manage/confcenter/web/v2/config/new/file
 *     ?env=<env>&version=2.0.0&c_isolate=default&apps=<module>
 * Response JSON: { "<file name>": <parsed file content>, ... } — a top-level
 * object keyed by file name (values are the parsed JSON of each file).
 * Returns the files as JSON text (normalized for the cache + adapt step).
 */
export async function pullConfcenter(cfg, { signal } = {}) {
  if (cfg.accessKey == null || cfg.accessSecret == null) throw new Error('缺少 accessKey/accessSecret，无法拉取配置')
  if (cfg.module == null) throw new Error('未识别模块名，无法拉取配置')
  const base = `${cfg.workbenchUrl}/iuap-yms-manage/confcenter/web/v2/config/new/file`
  const url = `${base}?env=${encodeURIComponent(cfg.env)}&version=2.0.0&c_isolate=default&apps=${encodeURIComponent(cfg.module)}`
  const token = await getYycToken(url, cfg.accessKey, cfg.accessSecret)
  // timeout guard: hang DoS protection (fetch without a signal can hang forever)
  const timeout = AbortSignal.timeout(60_000)
  const signalOrTimeout = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
  const res = await fetch(url, { headers: { YYCToken: token }, signal: signalOrTimeout })
  if (!res.ok) throw new Error(`confcenter HTTP ${res.status}`)
  const body = await res.json()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`confcenter 响应形状异常: ${String(body).slice(0, 120)}`)
  }
  const files = {}
  for (const [name, content] of Object.entries(body)) {
    const fileName = String(name).split('/').pop()
    if (!PULLED_FILES.includes(fileName)) continue
    // accept either the parsed object or raw text
    files[fileName] = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  }
  const missing = PULLED_FILES.filter((f) => files[f] === undefined)
  if (missing.length > 0) throw new Error(`confcenter 响应缺文件: ${missing.join(', ')}`)
  return files
}

/** Read the raw cache; used when the network is unreachable (offline start). */
export function readConfCache(cfg) {
  const dir = join(cfg.stateDir, 'confcenter')
  const files = {}
  for (const name of CONF_FILES) {
    const p = join(dir, name)
    if (existsSync(p)) files[name] = readFileSync(p, 'utf8')
  }
  return files
}

export function writeConfCache(cfg, files) {
  const dir = join(cfg.stateDir, 'confcenter')
  // 0o700/0o600: the cache carries DB/Redis endpoints + credentials from
  // confcenter — keep it owner-only.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of CONF_FILES) {
    if (files[name] !== undefined) writeFileSync(join(dir, name), files[name], { encoding: 'utf8', mode: 0o600 })
  }
}

/**
 * Adapt + write the 4 files into yms-home/config.
 * SOCKS mode rewrites Oracle/MySQL hosts to 127.0.0.1:<dbForwardPort> and
 * Redis pools to 127.0.0.1:<redisForwardPort>; direct mode keeps original
 * hosts. ip_node_mapping always points the module at the callback address
 * (serverBindAddress:serverPort).
 * Returns a summary of what was written.
 */
/** Atomic write: tmp file + rename, so a crash mid-write never leaves a truncated live config. */
function atomicWrite(path, text, mode) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { encoding: 'utf8', mode })
  renameSync(tmp, path)
}

/**
 * Write the four YMS config files, adapting every internal endpoint to this
 * machine.
 *
 * `rewrite` decides WHICH adaptation applies:
 *  - true  (fallback): private endpoints are replaced with 127.0.0.1:<localPort>
 *          and the forwarder binds those ports, so a JDBC/Redis client that
 *          cannot speak SOCKS still reaches the real server.
 *  - false (interception): endpoints keep their real host:port because a
 *          system-level redirector (ProxyBridge) already sends the java
 *          process' connections through the tunnel. Nothing is bound locally.
 *
 * Targets are collected either way: the redirector profile needs them.
 * @param {object} cfg - resolved plugin config.
 * @param {Record<string,string>} files - confcenter cache contents.
 * `dir` defaults to `<ymsHome>/config`; the direct-launch copy passes the
 * sibling `config-direct` instead, so the two launch modes never overwrite each
 * other's endpoint addresses.
 * @param {{rewrite?: boolean, dir?: string|null}} [options] - rewrite=false keeps
 *   real addresses; dir overrides the output directory.
 * @returns {{files: object, dbTargets: object[], rewrite: boolean}} outcome.
 */
export function adaptAndWriteConfig(cfg, files, { rewrite = true, dir = null } = {}) {
  const cfgDir = dir ?? join(cfg.ymsHome, 'config')
  mkdirSync(cfgDir, { recursive: true })

  let mw
  try {
    mw = JSON.parse(files['yms_middleware.json'])
  } catch (e) {
    throw new Error(`yms_middleware.json 解析失败: ${e.message}——删除 .dsh-ris-yds/confcenter/ 缓存后重试（yds confcenter）`)
  }

  const dbTargets = [] // { host, port, localPort? } original endpoints for the forwarder
  if (cfg.socks !== null) {
    for (const pool of Object.values(mw.connectionPools ?? {})) {
      if (typeof pool?.url === 'string' && pool.url.startsWith('jdbc:')) {
        const m = parseJdbcEndpoint(pool.url)
        if (m !== null) {
          dbTargets.push({ host: m.host, port: m.port })
          if (rewrite) pool.url = m.rewrite(`127.0.0.1`, cfg.dbForwardPort)
        } else {
          console.warn(`[yds] 警告: 无法解析 JDBC url（未重写、未转发）: ${pool.url}`)
        }
      }
    }
    for (const pool of Object.values(mw['redis.pools'] ?? {})) {
      if (typeof pool?.host === 'string') {
        dbTargets.push({ host: pool.host, port: Number(pool.port) || 6379 })
        if (rewrite) {
          pool.host = '127.0.0.1'
          pool.port = cfg.redisForwardPort
        }
      }
    }
  }
  // 0o600: yms_middleware.json carries DB/Redis credentials.
  atomicWrite(join(cfgDir, 'yms_middleware.json'), JSON.stringify(mw, null, 2), 0o600)

  // module_config / yonbip_config: verbatim (platform global options);
  // in SOCKS mode yonbip_config additionally gets its internal endpoints
  // (kafka / ES / license-server / ...) rewritten to the local tunnel ports.
  for (const name of ['module_config.json', 'yonbip_config.json']) {
    if (typeof files[name] !== 'string') {
      throw new Error(`confcenter 缓存缺 ${name}——先执行 yds confcenter 在线拉取一次`)
    }
  }
  let yonbipText = files['yonbip_config.json']
  if (cfg.socks !== null) {
    let r
    try {
      r = rewriteYonbipInternal(yonbipText)
    } catch (e) {
      throw new Error(`yonbip_config.json 解析失败: ${e.message}——删除 .dsh-ris-yds/confcenter/ 缓存后重试（yds confcenter）`)
    }
    yonbipText = r.text
    dbTargets.push(...r.targets)
  }
  atomicWrite(join(cfgDir, 'module_config.json'), files['module_config.json'], 0o600)
  atomicWrite(join(cfgDir, 'yonbip_config.json'), yonbipText, 0o600)

  // ip_node_mapping: route the module to our callback address. Merge with the
  // existing file (YonCode sync may have written other modules' entries) so a
  // shared workspace keeps working for both sides.
  const mappingPath = join(cfgDir, 'ip_node_mapping.json')
  let mapping = {}
  let source = files['ip_node_mapping.json'] // may be undefined (not served)
  if (source === undefined && existsSync(mappingPath)) source = readFileSync(mappingPath, 'utf8')
  if (source !== undefined) {
    try {
      mapping = JSON.parse(source)
    } catch (e) {
      // malformed existing mapping: back it up, start from an empty mapping,
      // and say so — silently replacing it would wipe other modules' entries.
      try {
        renameSync(mappingPath, `${mappingPath}.bak-${Date.now()}`)
        console.warn(`[yds] 警告: 现有 ip_node_mapping.json 解析失败（${e.message}）——已备份为 .bak-* 并重建，其它模块条目可能丢失`)
      } catch { /* ignore */ }
      mapping = {}
    }
  }
  const entry = mapping[cfg.module] ?? {}
  entry.context = cfg.context
  entry.ip_nodes = [`${cfg.serverBindAddress}:${cfg.serverPort}`]
  mapping[cfg.module] = entry
  const mappingText = JSON.stringify(mapping, null, 2)
  atomicWrite(mappingPath, mappingText, 0o600)
  const filesOut = { ...files, 'ip_node_mapping.json': mappingText }

  // adaptation stamp: prepareStart re-adapts from the cache when this is
  // missing or stale (adapter logic upgrades must not leave old rewrites live).
  writeFileSync(join(cfg.stateDir, 'adapt-version'), adaptMarker(rewrite), 'utf8')

  // variables/default.properties: keep the build's copy; create a minimal one
  // when the build did not ship it (kernel template normally does).
  const variables = join(cfgDir, 'variables', 'default.properties')
  if (!existsSync(variables)) {
    mkdirSync(join(cfgDir, 'variables'), { recursive: true })
    writeFileSync(variables, [
      '# generated by dsh-ris-yds',
      `yms.container.web.port=${cfg.ymsPort}`,
      'yms.container.web.https.port=9443',
      'yms.container.workerThreads=500',
      'yms.container.maxPostSize=11534336',
      '',
    ].join('\n'), 'utf8')
  }

  return { mode: cfg.socks !== null ? 'socks' : 'direct', dbTargets, files: filesOut }
}

/**
 * Parse host:port out of the common JDBC url forms so we can rewrite them
 * for the SOCKS tunnel:
 *   jdbc:oracle:thin:@//host:port/service      (Oracle service form)
 *   jdbc:oracle:thin:@host:port:SID            (Oracle SID form)
 *   jdbc:mysql://host:port/db?params           (MySQL)
 *   jdbc:mysql://host:port                     (MySQL no-db)
 * Returns { host, port, rewrite(host, port) } or null (unknown form).
 */
export function parseJdbcEndpoint(url) {
  let m = /^jdbc:[a-z0-9]+:thin:@\/\/([^/:]+):(\d+)(?=[/\s]|$)/.exec(url)
  if (m !== null) {
    return { host: m[1], port: Number(m[2]), rewrite: (h, p) => url.replace(/(@\/\/)[^/:]+:\d+/, `$1${h}:${p}`) }
  }
  m = /^jdbc:[a-z0-9]+:thin:@([^/:]+):(\d+):/.exec(url) // SID form
  if (m !== null) {
    return { host: m[1], port: Number(m[2]), rewrite: (h, p) => url.replace(/(thin:@)[^/:]+:\d+/, `$1${h}:${p}`) }
  }
  m = /^jdbc:mysql:\/\/([^/:]+):(\d+)(?=[/\s]|$)/.exec(url)
  if (m !== null) {
    return { host: m[1], port: Number(m[2]), rewrite: (h, p) => url.replace(/(jdbc:mysql:\/\/)[^/:]+:\d+/, `$1${h}:${p}`) }
  }
  return null
}

/**
 * Rewrite the internal (RFC1918) endpoints inside yonbip_config.json to
 * 127.0.0.1:<same port> so they traverse the SOCKS forwarder, and collect the
 * tunnel targets. Rules (each backed by a probe of the real dev network):
 *  - host:port with a private IP host and port >= 1024 -> rewrite, tunnel
 *    (kafka 6880, ES 6888, license 30001, ...).
 *  - bare-IP values (e.g. middleware_es.elastic.host) -> 127.0.0.1, but only
 *    when that same host already has a tunneled port (the port comes from a
 *    sibling key).
 *  - *.inner-yonbip-k8s.com (e.g. domain.registry.url) -> NOT rewritten: the
 *    SOCKS server cannot resolve k8s-internal DNS, so rewriting would just
 *    move the failure; warn loudly instead.
 *  - port < 1024 (e.g. objectStorage SFTP :22) -> skipped, cannot bind
 *    privileged local ports; warn.
 *  - non-private hosts (${domain.url} placeholders, public names) -> verbatim.
 * Returns { text, targets } where targets = [{ host, port, localPort }] and
 * localPort === port (deterministic 1:1 mapping, readable in logs).
 */
export function rewriteYonbipInternal(yonbipText) {
  const doc = JSON.parse(yonbipText) // caller handles parse errors
  const targets = []
  const seen = new Set()
  const warned = new Set()
  const warnOnce = (msg) => {
    if (!warned.has(msg)) { warned.add(msg); console.warn(`[yds] ${msg}`) }
  }

  // pass 1: collect eligible host:port targets (also detects k8s-internal
  // hostnames and privileged ports for warnings). Bare private-IP values are
  // NOT collected — they only ride along once their host has a real tunnel.
  const collect = (node) => {
    if (typeof node === 'string') {
      if (UNREACHABLE_HOST.test(node) || (node.includes('://') && UNREACHABLE_HOST.test(node.split('://')[1] ?? ''))) {
        warnOnce(`内网域名 ${node} 无法经 SOCKS 解析/转发（k8s 内部 DNS），保持原值——相关功能（服务注册发现等）将直连失败，属已知限制`)
        return
      }
      for (const m of node.matchAll(HOSTPORT_RE)) {
        const host = m[1]
        const port = Number(m[2])
        if (!PRIVATE_HOST.test(host)) continue
        if (UNREACHABLE_HOST.test(host)) continue
        if (port < 1024) {
          warnOnce(`内网端口 ${host}:${port} < 1024，本地无法监听，未隧道化（保持原值直连）`)
          continue
        }
        const key = `${host}:${port}`
        if (!seen.has(key)) { seen.add(key); targets.push({ host, port, localPort: port }) }
      }
    } else if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node)) collect(v)
    }
  }

  // pass 2: rewrite (order-independent: targets are already known)
  const rewrite = (node) => {
    if (typeof node === 'string') {
      if (PRIVATE_HOST.test(node)) {
        // bare private IP (e.g. middleware_es.elastic.host): its port comes
        // from a sibling key, so rewrite only when the host has a tunnel.
        return seenHosts().has(node) ? '127.0.0.1' : node
      }
      return node.replace(HOSTPORT_RE, (full, host, portStr) => {
        const port = Number(portStr)
        if (!PRIVATE_HOST.test(host) || UNREACHABLE_HOST.test(host) || port < 1024) return full
        if (!seen.has(`${host}:${port}`)) return full
        return `127.0.0.1:${port}`
      })
    }
    if (node !== null && typeof node === 'object') {
      for (const k of Object.keys(node)) node[k] = rewrite(node[k])
    }
    return node
  }
  const hostSetCache = { set: null }
  const seenHosts = () => {
    if (hostSetCache.set === null) {
      hostSetCache.set = new Set([...seen].map((k) => k.split(':')[0]))
    }
    return hostSetCache.set
  }

  collect(doc)
  const text = JSON.stringify(rewrite(doc), null, 2)
  return { text, targets }
}

/**
 * Extract the internal tunnel targets from a CACHED (raw) yonbip_config.json
 * without rewriting anything — used by the forwarder bootstrap when the
 * yms-home copy is already adapted. Same eligibility rules as
 * rewriteYonbipInternal (private host, port >= 1024, not k8s-internal DNS).
 */
export function extractYonbipTargets(yonbipText) {
  const doc = JSON.parse(yonbipText)
  const targets = []
  const seen = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(HOSTPORT_RE)) {
        const host = m[1]
        const port = Number(m[2])
        if (PRIVATE_HOST.test(host) && !UNREACHABLE_HOST.test(host) && port >= 1024) {
          const key = `${host}:${port}`
          if (!seen.has(key)) { seen.add(key); targets.push({ host, port, localPort: port }) }
        }
      }
    } else if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node)) walk(v)
    }
  }
  walk(doc)
  return targets
}
