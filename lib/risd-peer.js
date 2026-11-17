// Talk to the dsh-ris-ide daemon (`risd`) over its HTTP API.
//
// This is the preferred tier: when risd owns the engine, its rule table and the
// system-level intercept, yds must not start or stop anything — it only (a) takes a
// lease so the daemon does not tear the tunnel down while a launch is in flight,
// (b) writes its `source: 'yds'` rules through the daemon's CAS, and (c) releases
// the lease on `yds stop` (the engine stays up: it is machine-wide and an IDE may
// still be using it).
//
// The daemon's state file (`risd.json`) carries a short-lived token; `GET /v1/health`
// is unauthenticated and cheap, so discovery is always "read state + probe health".
import { mergeYdsRules, withdrawnBetween, ydsRowsOf } from './rules.js'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** API version this peer understands. Mirrors the daemon's `RISD_API_VERSION`. */
export const RISD_API_VERSION = 1
/** Header carrying the API version; a mismatch is refused (409) rather than guessed. */
const API_VERSION_HEADER = 'x-risd-api-version'
const REQUEST_TIMEOUT_MS = 2000
const PROBE_TIMEOUT_MS = 700

/** `YDS_RISD=none` is the documented escape hatch (tests, broken install). */
export function risdDisabled() {
  return process.env.YDS_RISD === 'none'
}

/** Where the shared plugin home lives (the daemon writes `risd.json` there). */
export function risdHome() {
  const explicit = process.env.DSH_RIS_IDE_PROXY_HOME || process.env.YDS_RISD_HOME
  return typeof explicit === 'string' && explicit !== '' ? explicit : join(homedir(), '.dsh-ris-ide')
}

export function risdStatePath(home = risdHome()) {
  return join(home, 'risd.json')
}

/** Read the daemon state file; unreadable/partial files mean "not running". */
export function readRisdState(home = risdHome()) {
  const path = risdStatePath(home)
  if (existsSync(path) !== true) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (!Number.isInteger(parsed.port) || parsed.port <= 0) return null
    return parsed
  } catch {
    return null
  }
}

/** One daemon request. Never throws; a transport failure is `{ ok:false, error }`. */
export async function risdRequest(state, path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = { [API_VERSION_HEADER]: String(RISD_API_VERSION) }
  if (typeof state?.token === 'string' && state.token !== '') headers.authorization = `Bearer ${state.token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  let response
  try {
    response = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message ?? error) }
  }
  let payload = null
  try { payload = await response.json() } catch { payload = null }
  return { ok: response.ok === true && (payload === null || payload.ok !== false), status: response.status, body: payload, error: payload !== null && typeof payload.message === 'string' ? payload.message : '' }
}

/**
 * Is a usable daemon running?
 * Unauthenticated health is the liveness signal; a mismatched API version is
 * reported explicitly so an old daemon is not silently half-used.
 */
export async function probeRisd({ home = risdHome() } = {}) {
  if (risdDisabled()) return { usable: false, reason: 'disabled', state: null }
  const state = readRisdState(home)
  if (state === null) return { usable: false, reason: 'absent', state: null }
  const health = await risdRequest(state, '/v1/health', { timeoutMs: PROBE_TIMEOUT_MS })
  if (health.ok !== true) return { usable: false, reason: 'unreachable', state, error: health.error }
  const apiVersion = Number(health.body?.apiVersion)
  if (apiVersion !== RISD_API_VERSION) {
    return { usable: false, reason: 'api-mismatch', state, daemonVersion: apiVersion, version: health.body?.version }
  }
  return { usable: true, reason: '', state, health: health.body }
}

/** Take a lease so the daemon keeps the engine while this launch is in flight. */
export async function acquireLease({ cwd, state = null, ownerPid = process.pid } = {}) {
  const resolved = state ?? (await probeRisd()).state
  if (resolved === null) return { ok: false, error: 'risd 未运行' }
  const result = await risdRequest(resolved, '/v1/leases', {
    method: 'POST',
    body: { ownerPid, sessionId: 'yds', cwd: typeof cwd === 'string' ? cwd : undefined },
  })
  const id = typeof result.body?.lease?.id === 'string' ? result.body.lease.id : ''
  return { ok: result.ok === true && id !== '', id, state: resolved, status: result.status, error: result.error || (id === '' ? 'risd 未返回租约 id' : '') }
}

/** Release one lease (null-safe: nothing to do when none was taken). */
export async function releaseLease(id, { state = null } = {}) {
  if (typeof id !== 'string' || id === '') return { ok: true, released: false }
  const resolved = state ?? (await probeRisd()).state
  if (resolved === null) return { ok: true, released: false }
  const result = await risdRequest(resolved, `/v1/leases/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return { ok: result.ok === true, released: result.ok === true, status: result.status, error: result.error }
}

// A lease must outlive the `yds` process that took it (the YMS runtime keeps using
// the tunnel after the CLI exits), so it is recorded on disk keyed by workspace and
// owned by the long-lived pid (the YMS process, or the foreground CLI).

function leasesPath(home = risdHome()) {
  return join(home, '..', '.dsh-ris-yds', 'risd-leases.json')
}

function readLeases(home = risdHome()) {
  const path = leasesPath(home)
  if (existsSync(path) !== true) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const LEASE_LOCK_TIMEOUT_MS = 2000
const LEASE_LOCK_STALE_MS = 5000
const LEASE_LOCK_RETRY_MS = 20

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `fn` while holding a lock beside the lease file.
 *
 * The lease record is a tiny read-modify-write file, and two `yds start/stop` runs in
 * different workspaces could otherwise drop each other's entry (review D-P2-6). The
 * lock is `O_EXCL`, so a crashed writer cannot deadlock us: a lock older than
 * LEASE_LOCK_STALE_MS is treated as abandoned. On timeout we still run `fn` unlocked —
 * losing the lease record is worse than an unlocked write.
 */
function withLeaseLock(path, fn) {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LEASE_LOCK_TIMEOUT_MS
  let held = false
  while (held !== true) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, String(process.pid), 'utf8')
      } finally {
        closeSync(fd)
      }
      held = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LEASE_LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue // raced with the owner releasing it: retry immediately
      }
      if (Date.now() > deadline) return fn()
      sleepSync(LEASE_LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }
}

/** Write the lease map atomically so a crash never leaves half a JSON object. */
function writeLeases(path, all) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Remember a lease id so a later `yds stop` (another process) can release it. */
export function rememberLease(cwd, entry, { home = risdHome() } = {}) {
  const path = leasesPath(home)
  try {
    return withLeaseLock(path, () => {
      const all = readLeases(home)
      all[cwd] = Object.assign({}, entry, { at: new Date().toISOString() })
      writeLeases(path, all)
      return true
    })
  } catch {
    return false
  }
}

/** The lease recorded for this workspace, or null. */
export function readLease(cwd, { home = risdHome() } = {}) {
  const entry = readLeases(home)[cwd]
  return entry !== null && typeof entry === 'object' ? entry : null
}

/** Drop the record (after releasing, or when the daemon says it is gone). */
export function forgetLease(cwd, { home = risdHome() } = {}) {
  const path = leasesPath(home)
  try {
    withLeaseLock(path, () => {
      const all = readLeases(home)
      if (all[cwd] === undefined) return
      delete all[cwd]
      writeLeases(path, all)
    })
  } catch { /* best effort */ }
}

function pidIsAlive(pid) {
  if (Number.isInteger(pid) !== true || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Drop a recorded lease whose owner process is gone (YMS killed with -9).
 *
 * The daemon only reaps by pid, so a dead owner keeps the engine alive until the
 * 3 s sweep — clearing our own record first means `yds stop` will not try to release
 * a lease the daemon already forgot (review D-P2-6).
 */
export function dropDeadLease(cwd, { home = risdHome(), isAlive = pidIsAlive } = {}) {
  const entry = readLease(cwd, { home })
  if (entry === null) return false
  if (isAlive(Number(entry.ownerPid)) === true) return false
  forgetLease(cwd, { home })
  return true
}

/** The daemon's own view of the rule table (carries the CAS revision). */
export async function getView(cwd, { state = null } = {}) {
  const resolved = state ?? (await probeRisd()).state
  if (resolved === null) return { ok: false, error: 'risd 未运行' }
  const result = await risdRequest(resolved, `/v1/proxy?cwd=${encodeURIComponent(cwd)}`)
  return { ok: result.ok === true, view: result.body, status: result.status, error: result.error }
}

/**
 * Replace the `source: 'yds'` rows of the global rule table through the daemon.
 *
 * The table is one machine-wide list and the panel saves it wholesale, so the
 * payload below is the COMPLETE table: every non-yds row read from proxy.json is
 * passed through unchanged and the yds rows are exactly `rules` (an empty array
 * therefore removes them all). The file is read directly for the other sources'
 * rows: the daemon's view omits them on purpose (the plugin decorates the table per
 * session), and a blind write would drop user/auto rules. A revision conflict is
 * retried once with the fresh revision — another dsh window may have saved in between.
 */
export async function putRules(cwd, rules, { gitHost = '', home = risdHome(), attempts = 2, log } = {}) {
  const state = readRisdState(home)
  if (state === null) return { ok: false, error: 'risd 未运行' }
  let lastError = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const view = await getView(cwd, { state })
    if (view.ok !== true) return { ok: false, status: view.status, error: view.error || '读取 risd 视图失败' }
    // An empty revision is the daemon's deliberate "force" path. yds must never take
    // it silently: if the view carries no revision we cannot tell whether somebody
    // else wrote in between, so fail instead of clobbering their change (D-P2-8).
    const baseRevision = String(view.view?.revision ?? '').trim()
    if (baseRevision === '') {
      return {
        ok: false,
        status: 0,
        error: 'revision-missing：risd 未返回规则表 revision（旧版/异常 daemon），已拒绝无 CAS 的强写，请升级 dsh-ris-ide 后重试',
      }
    }
    const stored = readStoredConfig(home)
    // Whole-table save: non-yds rows are preserved, the yds rows become exactly the
    // set this run generated (global table, no cross-workspace bookkeeping).
    const before = ydsRowsOf(stored.rules, { log })
    const table = mergeYdsRules(stored.rules, rules, { log })
    // Only the fields the daemon actually consumes are sent. `shadows` used to be
    // included, but POST /v1/proxy reads socks/listenPort/rules only, so a value here
    // could never take effect and looked like a successful mapping update
    // (review D-P2-8). The daemon keeps the stored shadow list itself.
    const merged = {
      socks: stored.socks ?? { host: '', port: 0 },
      listenPort: stored.listenPort,
      rules: table,
    }
    const result = await risdRequest(state, '/v1/proxy', {
      method: 'POST',
      body: {
        cwd,
        config: merged,
        revision: baseRevision,
        gitHost,
      },
      timeoutMs: 8000,
    })
    if (result.ok === true) {
      return {
        ok: true,
        revision: result.body?.revision,
        reloadNote: result.body?.reloadNote ?? '',
        withdrawn: withdrawnBetween(before, table),
        status: result.status,
      }
    }
    lastError = result.error || `risd 保存失败（${result.status}）`
    if (result.status !== 409) return { ok: false, status: result.status, error: lastError }
  }
  return { ok: false, status: 409, error: lastError }
}

function readStoredConfig(home) {
  const path = join(home, 'proxy.json')
  if (existsSync(path) !== true) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Ensure the daemon owns a running engine for this workspace. */
export async function startEngine(cwd, { state = null } = {}) {
  const resolved = state ?? (await probeRisd()).state
  if (resolved === null) return { ok: false, error: 'risd 未运行' }
  const result = await risdRequest(resolved, '/v1/action', { method: 'POST', body: { action: 'start', cwd }, timeoutMs: 30000 })
  return { ok: result.ok === true, status: result.status, result: result.body?.result, error: result.error }
}

/** Read the daemon engine's status (pid, listen ports, log path). */
export async function engineStatus(cwd, { state = null } = {}) {
  const resolved = state ?? (await probeRisd()).state
  if (resolved === null) return { ok: false, error: 'risd 未运行' }
  const response = await risdRequest(resolved, `/v1/engine?cwd=${encodeURIComponent(cwd)}`)
  return { ok: response.ok === true, status: response.status, engine: response.body?.engine ?? null, error: response.error }
}
