// Open a yds front-end dev server in the user's own browser, with the two things
// a plain `window.open` cannot give us:
//
//   1. the platform's `extend*.min.js|css` replaced by the local dev server — the
//      job the Resource Override extension does today;
//   2. a YYCToken on every request the page sends to the workbench/gateway.
//
// Neither is possible from outside the page (a browser never lets a bystander add
// a header to a navigation), so the page is served THROUGH this small loopback
// proxy: the HTML gets one injected script, whose runtime rewrites the bundle
// URLs and routes the page's ajax through `/__yds/gw`. There the token is signed
// per request and attached server-side, which also keeps it out of the address
// bar, the history, the Referer and the dev server's access log.
//
// Design rules, learned from the pieces this borrows from:
//   * a proxy must not buffer what it does not understand — only HTML/JS/CSS text
//     is rewritten (they are the only places a URL can appear), everything else is
//     piped straight through;
//   * HMR is a WebSocket: without upgrading it, a save silently stops reloading;
//   * a missing credential must degrade to "open the page anyway", never to a
//     blank tab — the token is an optimisation, the page is the point.

import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Path the injected script is served from. */
export const INJECT_PATH = '/__yds/inject.js'
/** Path the page's remote ajax is rerouted through. */
export const GATEWAY_PATH = '/__yds/gw'
/** Default offset between the dev-server port and this proxy's port. */
export const PORT_OFFSET = 10_000
/** Cap for a text response we are willing to hold in memory to rewrite. */
const MAX_REWRITE_BYTES = 8 * 1024 * 1024
/** How long one signed token is reused for the same URL. */
const TOKEN_TTL_MS = 30_000
/** Headers a proxy must not forward verbatim. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])

/**
 * Where the dev server is and which bundle URLs have to be redirected to it.
 * @param {object} cfg - resolved yds config (`resolveConfig(...).config`).
 * @param {object} [options]
 * @param {string} [options.devUrl] - override the dev server address.
 * @param {Array<{regex: string, substitution: string}>} [options.rules] - override rules.
 * @returns {{ok: boolean, reason?: string, fePort: number, devUrl: string,
 *   workbenchHost: string, module: string, context: string,
 *   rules: Array<{regex: string, substitution: string}>}}
 */
export function openSitePlan(cfg, options = {}) {
  const declaredPort = Number.isInteger(options.fePort) && options.fePort > 0
    ? options.fePort
    : (Number.isInteger(cfg?.fePort) && cfg.fePort > 0 ? cfg.fePort : 0)
  const devUrl = typeof options.devUrl === 'string' && options.devUrl !== ''
    ? options.devUrl
    : (declaredPort > 0 ? `http://127.0.0.1:${declaredPort}` : '')
  // A caller may hand us only the URL; the port then comes from it (the proxy's own
  // port is derived from the dev port, so both halves must agree).
  let fePort = declaredPort
  if (fePort <= 0 && devUrl !== '') {
    try {
      const parsed = new URL(devUrl)
      fePort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    } catch {
      fePort = 0
    }
  }
  let workbenchHost = ''
  try {
    workbenchHost = new URL(String(cfg?.workbenchUrl ?? '')).host
  } catch {
    workbenchHost = ''
  }
  // Rules come from the caller (the CDP plan / extension rules live in fe-dev.js):
  // this proxy only rewrites text a caller already decided to rewrite.
  const rules = Array.isArray(options.rules) ? options.rules : []
  const context = typeof cfg?.context === 'string' && cfg.context !== '' ? cfg.context : '/'
  if (devUrl === '') {
    return { ok: false, reason: '没有前端 dev server 地址（项目里没有可用的 yds.webConfig 端口）', fePort: 0, devUrl, workbenchHost, module: String(cfg?.module ?? ''), context, rules }
  }
  return { ok: true, fePort, devUrl, workbenchHost, module: String(cfg?.module ?? ''), context, rules }
}

/** One signed token per URL per TTL window, so a page with 50 requests signs 50, not 500. */
function createTokenSource(cfg, options) {
  const cache = new Map()
  const token = options.token
  const sign = options.signToken
  if (typeof token === 'string' && token !== '') return async () => token
  if (typeof sign === 'function') return async (url) => String(await sign(url) ?? '')
  const accessKey = cfg?.accessKey
  const accessSecret = cfg?.accessSecret
  if (typeof accessKey !== 'string' || accessKey === '' || typeof accessSecret !== 'string' || accessSecret === '') {
    return async () => ''
  }
  return async (url) => {
    const hit = cache.get(url)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < TOKEN_TTL_MS) return hit.token
    // Imported lazily: a workspace without credentials must not pay the native load.
    const { getYycToken } = await import('./token.js')
    const fresh = await getYycToken(url, accessKey, accessSecret)
    cache.set(url, { token: fresh, at: now })
    return fresh
  }
}

/** A cookie jar keyed by host: the gateway may hand out a session, and it must survive. */
function createCookieJar() {
  const jars = new Map()
  const jarOf = (host) => {
    let jar = jars.get(host)
    if (jar === undefined) {
      jar = new Map()
      jars.set(host, jar)
    }
    return jar
  }
  return {
    header(host) {
      const jar = jars.get(host)
      if (jar === undefined || jar.size === 0) return ''
      return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    },
    remember(host, setCookies) {
      const list = Array.isArray(setCookies) ? setCookies : (typeof setCookies === 'string' ? [setCookies] : [])
      if (list.length === 0) return
      const jar = jarOf(host)
      for (const line of list) {
        const head = String(line).split(';', 1)[0]
        const at = head.indexOf('=')
        if (at <= 0) continue
        jar.set(head.slice(0, at).trim(), head.slice(at + 1).trim())
      }
    },
    snapshot() {
      const out = {}
      for (const [host, jar] of jars) out[host] = Object.fromEntries(jar)
      return out
    },
  }
}

/**
 * The script injected into the page. Kept as a plain string (no template engine)
 * so what runs in the browser is exactly what the tests assert on.
 * @param {{rules: Array<{regex: string, substitution: string}>, workbenchHost: string,
 *   devOrigins: string[]}} spec - what to rewrite and where the page came from.
 * @returns {string} javascript source.
 */
export function injectScript(spec) {
  const rules = JSON.stringify(Array.isArray(spec?.rules) ? spec.rules : [])
  const workbenchHost = JSON.stringify(String(spec?.workbenchHost ?? ''))
  const devOrigins = JSON.stringify(Array.isArray(spec?.devOrigins) ? spec.devOrigins : [])
  return `(function () {
  'use strict'
  var RULES = ${rules}
  var WORKBENCH_HOST = ${workbenchHost}
  var DEV_ORIGINS = ${devOrigins}
  var GW = ${JSON.stringify(GATEWAY_PATH)}

  function absolute(text) {
    try { return new URL(String(text), location.href) } catch (error) { return null }
  }

  // A dev-server absolute URL becomes relative, so the browser keeps talking to the
  // proxy (this is what keeps the page's own assets on the injected origin).
  function localize(url) {
    var parsed = absolute(url)
    if (parsed === null) return url
    if (DEV_ORIGINS.indexOf(parsed.origin) !== -1) return parsed.pathname + parsed.search + parsed.hash
    return url
  }

  // The extension's rules, applied to any URL string we can see (bundle URLs are
  // absolute in the platform's config, which is why a path-only rewrite is not enough).
  function rewrite(url) {
    var text = String(url)
    for (var i = 0; i < RULES.length; i += 1) {
      var rule = RULES[i]
      try {
        var re = new RegExp(rule.regex)
        if (re.test(text)) return text.replace(re, rule.substitution)
      } catch (error) { /* a malformed rule must not break the page */ }
    }
    return text
  }

  function route(url) {
    var parsed = absolute(url)
    if (parsed === null) return url
    var host = parsed.host
    if (WORKBENCH_HOST !== '' && (host === WORKBENCH_HOST || host.slice(-(WORKBENCH_HOST.length + 1)) === '.' + WORKBENCH_HOST)) {
      return GW + '?u=' + encodeURIComponent(parsed.href)
    }
    return url
  }

  function transform(url) { return localize(route(rewrite(url))) }

  // 1) Assignments the platform makes at runtime (it inserts the extender script
  //    from its own boot code, so intercepting the property setter covers it).
  function patchUrlProperty(proto, prop) {
    if (proto === undefined || proto === null) return
    var descriptor = Object.getOwnPropertyDescriptor(proto, prop)
    if (descriptor === undefined || typeof descriptor.set !== 'function') return
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: function (value) { descriptor.set.call(this, transform(value)) }
    })
  }
  patchUrlProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src')
  patchUrlProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href')
  patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, 'src')

  var setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    var key = String(name).toLowerCase()
    if (key === 'src' || key === 'href') return setAttribute.call(this, name, transform(value))
    return setAttribute.call(this, name, value)
  }

  // 2) ajax: fetch and XHR are how a dev page reaches the gateway.
  var nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      if (typeof input === 'string') return nativeFetch.call(this, transform(input), init)
      if (input && typeof input.url === 'string') {
        var moved = transform(input.url)
        if (moved !== input.url) return nativeFetch.call(this, new Request(moved, input), init)
      }
      return nativeFetch.call(this, input, init)
    }
  }
  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments)
    args[1] = transform(url)
    return nativeOpen.apply(this, args)
  }

  // 3) The initial HTML can only be rewritten server-side; expose the helper so a
  //    page that builds its own DOM can reuse exactly the same rules.
  window.__ydsRewriteUrl = transform
})()
`
}

/** Every absolute http(s) URL in a text body (they are the only thing a rule targets). */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()\\]+/g

/**
 * Apply the rule substitutions to a text body (HTML/JS/CSS).
 *
 * The rules are anchored (`^…$`) because that is how the browser extension and the
 * CDP path both evaluate them: they match a whole request URL. In a document the
 * URLs are embedded in text, so the text is scanned for URLs and each one is put
 * through the rules — applying the anchored regex to the whole document would
 * never match, which is exactly the silent failure this function exists to avoid.
 * @param {string} text - response body.
 * @param {Array<{regex: string, substitution: string}>} rules - override rules.
 * @returns {string} the body with matching URLs replaced.
 */
export function rewriteText(text, rules) {
  const list = Array.isArray(rules) ? rules : []
  if (list.length === 0) return String(text)
  return String(text).replace(URL_IN_TEXT, (url) => {
    for (const rule of list) {
      try {
        const re = new RegExp(rule.regex)
        if (re.test(url)) return url.replace(re, rule.substitution)
      } catch {
        // A malformed rule is a configuration problem the caller reports; it must
        // never turn into a 500 for the page.
      }
    }
    return url
  })
}

/** Insert the injected script as early as possible in an HTML document. */
export function injectIntoHtml(html, scriptUrl = INJECT_PATH) {
  const tag = `<script src="${scriptUrl}"></script>`
  const text = String(html)
  const head = /<head[^>]*>/i.exec(text)
  if (head !== null) {
    const at = head.index + head[0].length
    return `${text.slice(0, at)}${tag}${text.slice(at)}`
  }
  const htmlTag = /<html[^>]*>/i.exec(text)
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length
    return `${text.slice(0, at)}${tag}${text.slice(at)}`
  }
  return tag + text
}

function forwardHeaders(headers, extra = {}) {
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return Object.assign(out, extra)
}

function copyResponseHeaders(headers, res) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    res.setHeader(name, value)
  }
}

/**
 * Start the injecting proxy for one dev server.
 * @param {object} cfg - resolved yds config.
 * @param {object} [options]
 * @param {number} [options.port] - 0/absent ⇒ `fePort + PORT_OFFSET`, then any free port.
 * @param {string} [options.host] - bind address (default 127.0.0.1).
 * @param {string} [options.token] - fixed token (tests / debugging).
 * @param {function(string): Promise<string>} [options.signToken] - custom signer.
 * @param {boolean} [options.verbose] - log each proxied request to stderr.
 * @returns {Promise<{url: string, port: number, plan: object, cookies: () => object, close: () => Promise<void>}>}
 */
export async function startOpenSite(cfg, options = {}) {
  const plan = openSitePlan(cfg, options)
  if (plan.ok !== true) throw new Error(plan.reason)
  const signToken = createTokenSource(cfg, options)
  const jar = createCookieJar()
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : '127.0.0.1'
  const devOrigin = new URL(plan.devUrl).origin
  const devPort = Number(new URL(plan.devUrl).port)
  const rules = Array.isArray(plan.rules) ? plan.rules : []
  const script = injectScript({
    rules,
    workbenchHost: plan.workbenchHost,
    devOrigins: [devOrigin, `http://localhost:${devPort}`],
  })

  /** Forward one request to a target URL and stream the answer back. */
  async function forward(req, res, target, { token = false } = {}) {
    const parsed = new URL(target)
    const isHttps = parsed.protocol === 'https:'
    const headers = forwardHeaders(req.headers)
    if (token === true) {
      let signed = ''
      try {
        signed = await signToken(parsed.href)
      } catch {
        // A gateway that rejects a missing token answers 401 — the same as a page
        // opened without this proxy, so a signing failure never makes things worse.
      }
      if (signed !== '') headers.YYCToken = signed
      // Some gateways read the credential from the cookie jar rather than the header
      // (the workbench pages do), and we cannot tell which one this deployment is
      // from here: send both. A cookie the gateway ignores costs nothing.
      const parts = []
      const cookie = jar.header(parsed.host)
      if (cookie !== '') parts.push(cookie)
      if (signed !== '') parts.push(`YYCToken=${signed}`)
      if (parts.length > 0) headers.cookie = parts.join('; ')
    }
    const outgoing = (isHttps ? httpsRequest : httpRequest)({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port === '' ? (isHttps ? 443 : 80) : Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers,
    }, (upstream) => {
      if (token === true) jar.remember(parsed.host, upstream.headers['set-cookie'])
      const type = String(upstream.headers['content-type'] ?? '')
      // A compressed body cannot be rewritten without decoding it; piping it through
      // untouched is always correct (the browser decompresses it itself).
      const encoded = String(upstream.headers['content-encoding'] ?? '')
      const rewritable = encoded === '' && /text\/html|text\/css|(java|ecma)script|application\/json/i.test(type)
      if (rewritable !== true) {
        res.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream.headers))
        upstream.pipe(res)
        return
      }
      const chunks = []
      let size = 0
      let aborted = false
      upstream.on('data', (chunk) => {
        if (aborted) return
        size += chunk.length
        if (size > MAX_REWRITE_BYTES) {
          // Too big to rewrite: answer with what we have and let the rest stream.
          aborted = true
          res.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream.headers))
          res.write(Buffer.concat(chunks))
          upstream.pipe(res)
          return
        }
        chunks.push(chunk)
      })
      upstream.on('end', () => {
        if (aborted) return
        let text = Buffer.concat(chunks).toString('utf8')
        text = rewriteText(text, rules)
        if (/text\/html/i.test(type)) text = injectIntoHtml(text)
        const body = Buffer.from(text, 'utf8')
        const headersOut = forwardHeaders(upstream.headers, { 'content-length': String(body.length) })
        delete headersOut['content-encoding']
        res.writeHead(upstream.statusCode ?? 502, headersOut)
        res.end(body)
      })
      upstream.on('error', () => { if (!aborted) res.destroy() })
    })
    outgoing.on('error', () => {
      if (res.headersSent !== true) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`[dsh-ris-yds] 无法连接 ${target}\n`)
      } else {
        res.destroy()
      }
    })
    if (req.method === 'GET' || req.method === 'HEAD') outgoing.end()
    else req.pipe(outgoing)
  }

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${host}`)
    if (requestUrl.pathname === INJECT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(script)
      return
    }
    if (requestUrl.pathname === GATEWAY_PATH) {
      const raw = requestUrl.searchParams.get('u')
      if (raw === null || raw === '') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('missing u\n')
        return
      }
      let target = ''
      try {
        target = new URL(raw).href
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad u\n')
        return
      }
      if (options.verbose === true) console.error(`[dsh-ris-yds] gw ${target}`)
      forward(req, res, target, { token: true }).catch(() => res.destroy())
      return
    }
    const target = `${plan.devUrl}${req.url ?? '/'}`
    if (options.verbose === true) console.error(`[dsh-ris-yds] dev ${target}`)
    forward(req, res, target).catch(() => res.destroy())
  })

  // HMR is a WebSocket to the dev server: pipe the raw socket or a save stops reloading.
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(plan.devUrl)
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      path: req.url ?? '/',
      method: 'GET',
      headers: forwardHeaders(req.headers, { connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' }),
    })
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const headerLines = [`HTTP/1.1 101 Switching Protocols`]
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        headerLines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`)
      }
      socket.write(`${headerLines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  const port = await new Promise((resolve, reject) => {
    const want = Number.isInteger(options.port) && options.port > 0
      ? options.port
      : (plan.fePort > 0 ? plan.fePort + PORT_OFFSET : 0)
    const listen = (candidate) => {
      server.once('error', (error) => {
        if (candidate > 0 && candidate === want && error.code === 'EADDRINUSE') {
          listen(0)
          return
        }
        reject(error)
      })
      server.listen(candidate, host, () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : candidate)
      })
    }
    listen(want)
  })

  const url = `http://${host}:${port}/`
  return {
    url,
    port,
    plan: Object.assign({}, plan, { devPort }),
    cookies: () => jar.snapshot(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
