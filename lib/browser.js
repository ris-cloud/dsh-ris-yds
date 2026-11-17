// Workbench browser cookie hygiene.
//
// The gateway only routes a request to the local YMS when the browser carries the
// rdbga cookie whose value is the base64 of "module,/context@bind:port". A stale or
// EMPTY rdbga wins over a good one (host-only beats a domain cookie), and then every
// request silently goes to the remote pod: the page looks fine, the local log stays
// empty and breakpoints never hit. This module inspects and repairs that cookie over
// the browser's own DevTools endpoint, so the failure heals instead of hiding.
//
// Two rules learned the hard way:
//   • never guess the value — a wrong rdbga is worse than a stale one, because the
//     gateway then routes to a different instance; only a value that can be checked
//     against the local configuration is written;
//   • never wait forever — a browser whose DevTools socket accepts but never answers
//     must not hang `yds start`; every command has a deadline.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Cookie name the iuap gateway reads to pick a debug instance. */
export const RDBGA_NAME = 'rdbga'

/** DevTools ports worth probing: YonCode's own browser, then the usual fallbacks. */
export const DEVTOOLS_PORTS = [9222, 9223, 9224, 9333]

/** Deadline for one CDP command and for the WebSocket handshake. */
export const CDP_TIMEOUT_MS = 10_000

/** Deadline for the small HTTP probes against the DevTools endpoint. */
export const HTTP_TIMEOUT_MS = 2_000

/** `-Drdbga=<value>` of a running JVM's command line, or '' when it is absent. */
export function rdbgaFromCmdline(commandLine) {
  const text = String(commandLine ?? '')
  const match = text.match(/-Drdbga=([^\s"']+)/)
  return match === null ? '' : match[1]
}

/** A host and the domain-cookie spelling of it (`.host`), lower-cased. */
export function hostVariants(host) {
  const name = String(host ?? '').trim().toLowerCase()
  if (name === '') return []
  return name.startsWith('.') ? [name, name.slice(1)] : [name, `.${name}`]
}

/** Does a cookie's domain belong to one of these hosts? Empty list = no filter. */
export function domainMatches(cookieDomain, hosts) {
  const list = (Array.isArray(hosts) ? hosts : []).map((host) => String(host).toLowerCase().replace(/^\./, ''))
  if (list.length === 0) return true
  const domain = String(cookieDomain ?? '').toLowerCase().replace(/^\./, '')
  return list.some((host) => domain === host || domain.endsWith(`.${host}`))
}

/**
 * A value we are willing to WRITE: base64 of "module,/context@ipv4:port".
 * Anything else (empty, garbage, `null,/@null:31010`) must be refused, because writing
 * it deletes a working cookie and points the gateway at an instance that does not exist.
 */
export function isPlausibleRdbga(value) {
  const text = String(value ?? '').trim()
  if (text === '' || /^[A-Za-z0-9+/]+={0,2}$/.test(text) !== true) return false
  let decoded = ''
  try { decoded = Buffer.from(text, 'base64').toString('utf8') } catch { return false }
  return /^[^,\s]+,\/[^@\s]*@(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(decoded)
}

/**
 * Which rdbga cookies to keep and which to delete.
 *
 * Exactly one cookie may survive, and it has to carry the expected value: an empty
 * host-only cookie shadows the correct domain cookie, and two cookies make the
 * gateway pick whichever the client happens to send first.
 * @param {object[]} cookies CDP cookies
 * @param {string} expected the value the running JVM was launched with
 * @param {string[]|null} hosts restrict to these hosts (null = every domain)
 * @returns {{keep: object[], remove: object[]}}
 */
export function classifyRdbgaCookies(cookies, expected, hosts = null) {
  // Compare as strings on both sides: the cookie store may hand back numbers while the
  // expected value is derived from config, and status/repair must agree on the verdict.
  const wanted = String(expected ?? '')
  const keep = []
  const remove = []
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (cookie?.name !== RDBGA_NAME) continue
    if (domainMatches(cookie.domain, hosts) !== true) continue
    const value = String(cookie.value ?? '')
    if (value !== '' && value === wanted && keep.length === 0) keep.push(cookie)
    else remove.push(cookie)
  }
  return { keep, remove }
}

/** Error raised when the browser answers a command with a CDP error object. */
export class CdpError extends Error {
  constructor(method, detail) {
    super(`${method}: ${detail?.message ?? JSON.stringify(detail)}`)
    this.name = 'CdpError'
    this.method = method
    this.detail = detail
  }
}

function withDeadline(promise, ms, message) {
  let timer = null
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * Minimal CDP client over the WebSocket node ships with (no dependency).
 * Every command settles: resolved with `result`, rejected on CDP error, on a closed
 * socket, or when the deadline passes — a silent browser must not hang the caller.
 */
export async function connectCdp(wsUrl, { timeout = CDP_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('当前 node 没有 WebSocket 实现')
  const socket = new WebSocketImpl(wsUrl)
  const pending = new Map()
  let seq = 0
  let closed = ''

  const failAll = (reason) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  await withDeadline(new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`无法连接 ${wsUrl}`))
  }), timeout, `DevTools 握手超时（${timeout}ms）`).catch((error) => {
    try { socket.close() } catch { /* already gone */ }
    throw error
  })

  socket.onmessage = (event) => {
    let message = null
    try { message = JSON.parse(event.data) } catch { return }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new CdpError(entry.method, message.error))
    else entry.resolve(message.result ?? {})
  }
  socket.onclose = () => {
    closed = 'DevTools 连接已关闭'
    failAll(closed)
  }
  socket.onerror = () => {
    closed = 'DevTools 连接出错'
    failAll(closed)
  }

  const send = (method, params = {}) => {
    if (closed !== '') return Promise.reject(new Error(closed))
    seq += 1
    const id = seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 超时（${timeout}ms）`))
      }, timeout)
      pending.set(id, { resolve, reject, timer, method })
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const close = () => {
    try { socket.close() } catch { /* already gone */ }
  }

  return { send, close }
}

/**
 * GET a DevTools HTTP endpoint with a deadline.
 *
 * The abort signal alone is not enough: a socket that accepts the connection and then
 * never answers keeps `fetch` pending forever, and an injected `fetchImpl` may ignore
 * the signal entirely. The race guarantees this returns even when the fetch never does.
 */
async function devtoolsJson(port, path, { fetchImpl = fetch, timeout = HTTP_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const request = (async () => {
    const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: controller.signal })
    if (response.ok !== true) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  })()
  try {
    return await withDeadline(request, timeout, `${path} 超时（${timeout}ms）`)
  } finally {
    clearTimeout(timer)
    request.catch(() => {})
  }
}

/** First DevTools port that answers `/json/version`, with its browser string. */
export async function probeDevtoolsPorts(ports = DEVTOOLS_PORTS, { fetchImpl = fetch, timeout = HTTP_TIMEOUT_MS } = {}) {
  for (const port of Array.isArray(ports) ? ports : []) {
    try {
      const body = await devtoolsJson(port, '/json/version', { fetchImpl, timeout })
      return { port, browser: String(body?.Browser ?? '') }
    } catch { /* this port has no DevTools endpoint */ }
  }
  return { port: 0, browser: '' }
}

/** URL host of a page target ('' when the URL cannot be parsed). */
function hostOf(targetUrl) {
  try { return new URL(String(targetUrl)).hostname.toLowerCase() } catch { return '' }
}

/**
 * Every page target whose URL HOST is exactly one of `hosts` (empty list = every page).
 *
 * Exact host, not `url.includes(host)`: a substring test matches
 * `srmdev.hanslaser.com.evil.com` and query strings that merely mention the host, and it
 * would also accept any subdomain as "the workbench" — none of those pages carries the
 * cookie the gateway reads.
 */
export async function workbenchTargets(port, { fetchImpl = fetch, hosts = null, timeout = HTTP_TIMEOUT_MS } = {}) {
  let list = null
  try {
    list = await devtoolsJson(port, '/json/list', { fetchImpl, timeout })
  } catch {
    return { ok: false, targets: [], error: '读取浏览器页签列表失败' }
  }
  const wanted = (Array.isArray(hosts) ? hosts : [])
    .map((host) => String(host).toLowerCase().replace(/^\./, '').trim())
    .filter((host) => host !== '')
  const targets = (Array.isArray(list) ? list : []).filter((target) => target?.type === 'page'
    && typeof target.webSocketDebuggerUrl === 'string'
    && (wanted.length === 0 || wanted.includes(hostOf(target.url))))
  return { ok: true, targets, error: '' }
}

/**
 * All cookies the browser holds for the sites of these targets.
 * `Network.getCookies` is called WITHOUT a URL: with a URL it only returns the cookies
 * that would be sent to that exact path, so an rdbga with `path=/c-ass-kk-hans` stays
 * invisible — and several real breakages come from exactly such a stray cookie.
 */
export async function cookiesOfTargets(targets, { connect = connectCdp } = {}) {
  const cookies = []
  for (const target of targets) {
    const cdp = await connect(target.webSocketDebuggerUrl)
    try {
      await cdp.send('Network.enable')
      const result = await cdp.send('Network.getCookies')
      for (const cookie of Array.isArray(result?.cookies) ? result.cookies : []) cookies.push(cookie)
    } finally {
      cdp.close()
    }
  }
  return cookies
}

/**
 * Strip stale/empty rdbga cookies from every workbench tab and set the expected one.
 *
 * `targets` skips the second `/json/list` round-trip when the caller already listed the
 * tabs — two listings can observe different tab sets, and the repair must act on the
 * tabs whose cookies were just reported. `dryRun` only computes the plan; nothing is
 * deleted or written, so it is safe to run before asking the user.
 * @returns {Promise<{ok: boolean, tabs: number, removed: number, wrote: number, set: string, dryRun: boolean, error?: string, failed?: string[]}>}
 */
export async function repairRdbgaCookie({ port, expected, fetchImpl = fetch, connect = connectCdp, hosts = null, targets = null, timeout = CDP_TIMEOUT_MS, dryRun = false } = {}) {
  const value = String(expected ?? '').trim()
  const planned = dryRun === true
  if (isPlausibleRdbga(value) !== true) {
    return { ok: false, tabs: 0, removed: 0, wrote: 0, set: '', dryRun: planned, error: `拒绝写入可疑的 rdbga 值（${value === '' ? '空' : value}）` }
  }
  let tabsHere = Array.isArray(targets) ? targets : null
  if (tabsHere === null) {
    const listed = await workbenchTargets(port, { fetchImpl, hosts })
    if (listed.ok !== true) return { ok: false, tabs: 0, removed: 0, wrote: 0, set: value, dryRun: planned, error: listed.error }
    tabsHere = listed.targets
  }
  if (tabsHere.length === 0) return { ok: false, tabs: 0, removed: 0, wrote: 0, set: value, dryRun: planned, error: '没有找到工作台页面（浏览器未打开工作台？）' }
  let removed = 0
  let wrote = 0
  let tabs = 0
  const failed = []
  for (const target of tabsHere) {
    const host = hostOf(target.url)
    const hostsHere = hostVariants(host)
    let cdp = null
    try {
      cdp = await connect(target.webSocketDebuggerUrl, { timeout })
      await cdp.send('Network.enable')
      const result = await cdp.send('Network.getCookies')
      const cookies = Array.isArray(result?.cookies) ? result.cookies : []
      const verdict = classifyRdbgaCookies(cookies, value, hostsHere)
      const willWrite = verdict.keep.length === 0
      if (planned === true) {
        removed += verdict.remove.length
        if (willWrite) wrote += 1
      } else {
        for (const cookie of verdict.remove) {
          await cdp.send('Network.deleteCookies', {
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path ?? '/',
          })
          removed += 1
        }
        if (willWrite) {
          await cdp.send('Network.setCookie', {
            name: RDBGA_NAME,
            value,
            url: `https://${host}/`,
            path: '/',
          })
          wrote += 1
        }
      }
      tabs += 1
    } catch (error) {
      failed.push(`${target.url}: ${error.message}`)
    } finally {
      if (cdp !== null) cdp.close()
    }
  }
  if (tabs === 0) {
    return {
      ok: false, tabs, removed, wrote, set: value, dryRun: planned, failed,
      error: `所有页签都失败（${failed.length} 个）：${failed.join('; ') || '原因未知'}`,
    }
  }
  if (failed.length > 0) {
    // A tab we could not reach may still hold a stale cookie; the read-back only sees
    // the first tab, so report this as a failure instead of a half-verified success.
    return {
      ok: false, tabs, removed, wrote, set: value, dryRun: planned, failed,
      error: `部分页签失败（成功 ${tabs} 个，失败 ${failed.length} 个）：${failed.join('; ')}`,
    }
  }
  return { ok: true, tabs, removed, wrote, set: value, dryRun: planned, failed }
}

/**
 * Read (never modify) the rdbga cookies of the first workbench tab.
 * `targets` is reused from the caller for the same reason as in repairRdbgaCookie.
 */
export async function readRdbgaCookies({ port, fetchImpl = fetch, connect = connectCdp, hosts = null, targets = null, timeout = CDP_TIMEOUT_MS } = {}) {
  let tabsHere = Array.isArray(targets) ? targets : null
  if (tabsHere === null) {
    const listed = await workbenchTargets(port, { fetchImpl, hosts })
    if (listed.ok !== true) return { ok: false, cookies: [], error: listed.error }
    tabsHere = listed.targets
  }
  if (tabsHere.length === 0) return { ok: false, cookies: [], error: '没有工作台页签' }
  try {
    const cookies = await cookiesOfTargets([tabsHere[0]], { connect })
    return { ok: true, cookies, error: '' }
  } catch (error) {
    return { ok: false, cookies: [], error: error.message }
  }
}

/**
 * `-Drdbga=` values of the running JVMs.
 * `ok:false` means "the question could not be asked" (no PowerShell, no interop, not
 * Windows) — not "there is no JVM". Both are told apart so the caller never mistakes an
 * unreadable value for confirmation of its own guess.
 * Async on purpose: the PowerShell query takes 1–2s and must not block the event loop
 * (and with it the DevTools probes and the CDP deadlines).
 * @returns {Promise<{ok: boolean, values: string[], error: string}>}
 */
export async function rdbgaFromRunningJvm() {
  if (process.platform !== 'win32' && process.env.WSL_DISTRO_NAME === undefined) {
    return { ok: false, values: [], error: '只有 Windows/WSL 能查询 Windows 侧的 java 进程' }
  }
  try {
    const script = '@(Get-CimInstance Win32_Process -Filter "Name=\'java.exe\'") | ForEach-Object { $_.CommandLine }'
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    })
    const values = []
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const value = rdbgaFromCmdline(line)
      if (value !== '' && values.includes(value) !== true) values.push(value)
    }
    return { ok: true, values, error: '' }
  } catch (error) {
    return { ok: false, values: [], error: `查询不到运行中的 JVM（${error.message}）` }
  }
}

/** 前 10 + 尾 6 + 总长：rdbga 尾部含回调端口，同前缀的两个值只能靠尾部区分。 */
function shortRdbga(value) {
  const text = String(value ?? '')
  if (text.length <= 24) return text
  return `${text.slice(0, 10)}…${text.slice(-6)}（${text.length} 字符）`
}

/** Human-readable one-liner per rdbga cookie for `yds browser status`. */
export function describeRdbgaCookies(cookies, expected, hosts = null) {
  const wanted = String(expected ?? '')
  const found = (Array.isArray(cookies) ? cookies : []).filter((cookie) => cookie?.name === RDBGA_NAME)
  const verdict = classifyRdbgaCookies(cookies, wanted, hosts)
  if (found.length === 0) return `未找到 ${RDBGA_NAME} cookie（网关会按普通请求路由到远端）`
  const lines = [`${RDBGA_NAME} cookie: ${found.length} 个（期望 ${wanted === '' ? '(无法确定)' : shortRdbga(wanted)}）`]
  found.forEach((cookie, index) => {
    const value = String(cookie.value ?? '')
    // An unknown expectation cannot call anything "wrong": say so instead of guessing.
    const state = value === '' ? '空值' : wanted === '' ? '值未知' : (value === wanted ? '正确' : '值不匹配')
    lines.push(`${index + 1}. ${value === '' ? '(空)' : shortRdbga(value)} @ ${cookie.domain}${cookie.path ?? '/'} → ${state}`)
  })
  if (wanted !== '' && verdict.remove.length > 0) lines.push(`需要清理 ${verdict.remove.length} 个（空值/重复/不匹配）`)
  return lines.join('\n')
}
