// The injecting proxy: what it rewrites, and what it must not break.
//
// The interesting failures here are silent ones — a page that opens but whose
// bundle comes from the platform (rules not applied), or whose gateway calls go
// out without a token (401s that look like a login problem). So every assertion
// below is about the bytes that leave the proxy, not about its internals.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createProbe } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOpenSite, injectScript, rewriteText, injectIntoHtml, INJECT_PATH, GATEWAY_PATH, PORT_OFFSET } from '../lib/open-site.js'
import { openSite, probeWorkspace } from '../lib/open-serve.js'
import { globToDnrRegex } from '../lib/fe-dev.js'

const REMOTE_BUNDLE = 'https://srmdev.hanslaser.com/c-ass-kk-hans/mdf-wh/javascripts/extend.min.js'
const localBundleFor = (port) => `http://127.0.0.1:${port}/static/javascripts/extend.js`

/** A dev server whose HTML mentions the remote bundle, plus a JS file doing the same. */
async function fakeDevServer() {
  const server = createServer((req, res) => {
    if (req.url === '/static/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end(`var boot = "${REMOTE_BUNDLE}"`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<html><head><title>dev</title></head><body><script src="${REMOTE_BUNDLE}"></script></body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

/** The gateway: records the headers of what it receives, so tests can assert on them. */
async function fakeGateway() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'JSESSIONID=abc123; Path=/' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, seen }
}

function rulesFor(devUrl) {
  return [
    globToDnrRegex('https://*/c-ass-kk-hans/*/javascripts/extend*.min.js', `${devUrl}/static/javascripts/extend.js`),
  ]
}

test('the plan refuses a workspace without a dev-server port', async () => {
  const { openSitePlan } = await import('../lib/open-site.js')
  const plan = openSitePlan({ workbenchUrl: 'https://srmdev.hanslaser.com/c-ass-kk-hans' })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /dev server/)
})

test('openSite injects only the yds front-end the caller names (m00555)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yds-open-named-'))
  try {
    await mkdir(join(dir, '.vscode'), { recursive: true })
    await writeFile(join(dir, '.vscode', 'settings.json'), JSON.stringify({
      'yds.webConfig': {
        'c-ass-kk-hans-fe': { 'yds.domainKey': 'c-ass-kk-hans', 'yds.localDevUrl': 'http://127.0.0.1:3004' },
        'ynf-c-ass-kk-hans-fe': { 'yds.domainKey': 'ynf', 'yds.localDevUrl': 'http://127.0.0.1:3005' },
      },
    }))
    const probe = probeWorkspace(dir)
    assert.equal(probe.yds, true)
    assert.deepEqual([...probe.frontends].sort(), ['c-ass-kk-hans-fe', 'ynf-c-ass-kk-hans-fe'])
    // Not a declared yds front-end: refuse, never proxy it.
    const undeclared = await openSite(dir, { devUrl: 'http://127.0.0.1:5173', frontend: { code: 'plain-npm-app' } })
    assert.equal(undeclared.ok, false)
    assert.equal(undeclared.code, 'not-yds-frontend')
    // Declared, but the page belongs to another front-end's port: refuse too.
    const foreignPort = await openSite(dir, { devUrl: 'http://127.0.0.1:5173', frontend: { code: 'c-ass-kk-hans-fe' } })
    assert.equal(foreignPort.ok, false)
    assert.equal(foreignPort.code, 'not-yds-frontend')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the proxy serves the page from its own origin with the bundle pointed at the dev server', async () => {
  const dev = await fakeDevServer()
  const cfg = {
    workbenchUrl: 'https://srmdev.hanslaser.com/c-ass-kk-hans',
    accessKey: 'ak',
    accessSecret: 'sk',
    fePort: dev.port,
    context: '/',
  }
  const site = await startOpenSite(cfg, { token: 'fixed-token', rules: rulesFor(`http://127.0.0.1:${dev.port}`) })
  try {
    const res = await fetch(site.url)
    const html = await res.text()
    assert.equal(res.status, 200)
    // 1) the page is proxied, not redirected, so the origin stays ours
    assert.equal(new URL(site.url).origin, new URL(site.url).origin)
    // 2) the injected script runs before anything else in <head>
    const scriptAt = html.indexOf(INJECT_PATH)
    assert.ok(scriptAt > 0, 'the injected script must be in the document')
    assert.ok(scriptAt < html.indexOf('<body'), 'the injected script must come first')
    // 3) the platform bundle now points at the local dev server
    assert.ok(html.includes(localBundleFor(dev.port)), `expected the local bundle, got:\n${html}`)
    assert.ok(!html.includes(REMOTE_BUNDLE), 'the remote bundle must be gone')
  } finally {
    await site.close()
    dev.server.close()
  }
})

test('a JS response is rewritten too — the bundle URL also lives in config strings', async () => {
  const dev = await fakeDevServer()
  const cfg = { workbenchUrl: 'https://srmdev.hanslaser.com/c-ass-kk-hans', fePort: dev.port, accessKey: 'ak', accessSecret: 'sk', context: '/' }
  const site = await startOpenSite(cfg, { token: 'fixed-token', rules: rulesFor(`http://127.0.0.1:${dev.port}`) })
  try {
    const res = await fetch(`${site.url}static/app.js`)
    const body = await res.text()
    assert.ok(body.includes(localBundleFor(dev.port)), body)
    assert.ok(!body.includes(REMOTE_BUNDLE), body)
  } finally {
    await site.close()
    dev.server.close()
  }
})

test('the injected script rewrites, localizes and routes — in that order', () => {
  const script = injectScript({
    rules: [{ regex: '^https://.*/extend\\.min\\.js$', substitution: 'http://127.0.0.1:3004/static/javascripts/extend.js' }],
    workbenchHost: 'srmdev.hanslaser.com',
    devOrigins: ['http://127.0.0.1:3004'],
  })
  assert.match(script, /patchUrlProperty/)
  assert.match(script, /XMLHttpRequest\.prototype\.open/)
  assert.match(script, /WORKBENCH_HOST = "srmdev\.hanslaser\.com"/)
  assert.match(script, new RegExp(GATEWAY_PATH))
})

test('gateway calls carry a freshly signed YYCToken and survive a session cookie', async () => {
  const dev = await fakeDevServer()
  const gateway = await fakeGateway()
  const cfg = {
    workbenchUrl: 'https://srmdev.hanslaser.com/c-ass-kk-hans',
    fePort: dev.port,
    accessKey: 'ak',
    accessSecret: 'sk',
    context: '/',
  }
  const site = await startOpenSite(cfg, { rules: rulesFor(`http://127.0.0.1:${dev.port}`), signToken: async (url) => `token-for:${url}` })
  try {
    const first = `${site.url.replace(/\/$/, '')}${GATEWAY_PATH}?u=${encodeURIComponent(`http://127.0.0.1:${gateway.port}/session`)}`
    const res = await fetch(first)
    assert.equal(res.status, 200)
    assert.equal(gateway.seen[0].headers.yyctoken, `token-for:http://127.0.0.1:${gateway.port}/session`)

    // The gateway handed out a cookie; the next call must present it, otherwise a
    // login-free page would still lose its session on the second request.
    const second = `${site.url.replace(/\/$/, '')}${GATEWAY_PATH}?u=${encodeURIComponent(`http://127.0.0.1:${gateway.port}/echo`)}`
    const again = await fetch(second)
    assert.equal(again.status, 200)
    assert.match(String(gateway.seen[1].headers.cookie), /JSESSIONID=abc123/)
    // The workbench pages read the credential from a cookie, so the token is sent
    // both ways: header (JWT-aware gateways) and cookie (page/jar readers).
    assert.match(String(gateway.seen[1].headers.cookie), /YYCToken=token-for:http:\/\/127\.0\.0\.1:\d+\/echo/)
    assert.equal(gateway.seen[1].headers.yyctoken, `token-for:http://127.0.0.1:${gateway.port}/echo`)
    assert.equal(site.cookies()[`127.0.0.1:${gateway.port}`].JSESSIONID, 'abc123')
  } finally {
    await site.close()
    gateway.server.close()
    dev.server.close()
  }
})

test('a missing credential degrades to opening the page without a token', async () => {
  const dev = await fakeDevServer()
  const cfg = { workbenchUrl: 'https://srmdev.hanslaser.com/c-ass-kk-hans', fePort: dev.port, context: '/' }
  const site = await startOpenSite(cfg, { rules: [] })
  try {
    const res = await fetch(site.url)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /__yds\/inject\.js/)
  } finally {
    await site.close()
    dev.server.close()
  }
})

test('the port is the dev port plus an offset, so the address is predictable', async () => {
  // The default pair (3004 → 13004) is only predictable while 13004 is free: on a
  // machine where another open-site already listens there the proxy rightly falls
  // back to an ephemeral port. Pick a base whose offset port is free so this test
  // checks the contract (fePort + PORT_OFFSET) instead of the machine's state.
  const basePort = await freeBasePort()
  const cfg = { workbenchUrl: 'https://srmdev.hanslaser.com/c-ass-kk-hans', fePort: basePort, context: '/' }
  const site = await startOpenSite(cfg, { rules: [], token: 't' })
  try {
    assert.equal(site.port, basePort + PORT_OFFSET)
  } finally {
    await site.close()
  }
})

/** A port below 55535 whose offset twin is also free right now. */
async function freeBasePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    if (await portIsFree(port) && await portIsFree(port + PORT_OFFSET)) return port
  }
  throw new Error('no free dev/offset port pair found')
}

/** Can this port be bound on 127.0.0.1 right now? */
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

test('rewriteText applies every rule and tolerates a malformed one', () => {
  const out = rewriteText('a https://x/extend.min.js b https://y/extend.min.css', [
    { regex: '^https://x/extend\\.min\\.js$', substitution: 'http://127.0.0.1:1/x.js' },
    { regex: '([unclosed', substitution: 'never' },
    { regex: '^https://y/extend\\.min\\.css$', substitution: 'http://127.0.0.1:1/x.css' },
  ])
  assert.equal(out, 'a http://127.0.0.1:1/x.js b http://127.0.0.1:1/x.css')
})

test('injectIntoHtml puts the tag right after <head>, else after <html>, else first', () => {
  assert.match(injectIntoHtml('<html><head><meta/></head></html>'), /<head><script src="\/__yds\/inject\.js"><\/script>/)
  assert.match(injectIntoHtml('<html><body></body></html>'), /<html><script src="\/__yds\/inject\.js"><\/script>/)
  assert.equal(injectIntoHtml('plain').startsWith('<script'), true)
})

test('the plugin exposes the open route: loopback only, POST only, JSON in (m03945)', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // The route is what dsh-ris-ide calls when its 🌐 button is clicked; if it
  // disappears the button silently falls back to the bare dev-server URL (no token).
  assert.match(source, /const ROUTE_PREFIX = '\/dsh-ris-yds'/)
  assert.match(source, /url\.pathname !== `\$\{ROUTE_PREFIX\}\/open`/)
  // A page on another origin must not be able to make this plugin open listeners.
  assert.match(source, /function isLoopbackRequest\(req\)/)
  assert.match(source, /this route answers loopback requests only/)
  assert.match(source, /closeOpenSites\(\)/)
  // The console asks "is this a yds project?" before it may show token wording.
  assert.match(source, /url\.pathname === `\$\{ROUTE_PREFIX\}\/probe`/)
  assert.match(source, /probeWorkspace\(workspace\)/)
})

test('the yds probe answers nothing for an ordinary workspace (m04354)', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'yds-probe-plain-'))
  try {
    await mkdir(join(plain, 'app'), { recursive: true })
    await writeFile(join(plain, 'app', 'package.json'), '{}\n')
    const answer = probeWorkspace(plain)
    assert.equal(answer.yds, false)
    assert.equal(answer.projectDir, null)
    assert.deepEqual(answer.frontends, [])
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})

test('the yds probe reports a project dir and its frontends (m04354)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yds-probe-project-'))
  try {
    const project = join(root, 'yonasset')
    await mkdir(join(project, '.vscode'), { recursive: true })
    await writeFile(join(project, '.vscode', 'settings.json'), JSON.stringify({
      'yds.moduleDependency': { deploy: [], externals: [] },
      'yds.webConfig': { 'c-ass-kk-hans-fe': { port: 3004 }, 'yds.localWorkbenchPort': 4000 },
    }))
    const answer = probeWorkspace(root)
    assert.equal(answer.yds, true)
    assert.equal(answer.projectDir, project)
    assert.deepEqual(answer.frontends, ['c-ass-kk-hans-fe'], 'the workbench-port pseudo key is not a frontend')
    const inside = probeWorkspace(project)
    assert.equal(inside.yds, true, 'a workspace opened inside the project tree still counts')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
