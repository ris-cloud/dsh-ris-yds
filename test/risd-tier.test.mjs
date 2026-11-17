// Tier 1 of the proxy stack: a running risd daemon. These tests run a FAKE daemon
// over HTTP (no real engine, no second tunnel) and assert the contract yds relies
// on: discovery, CAS rule writes with one retry, a lease, and a stop that withdraws
// yds' share WITHOUT stopping the machine-shared engine.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { run } from '../lib/cli.js'

const WS = '/tmp/risd-tier-ws'
const state = {
  revision: 'rev1',
  forcedConflicts: 0,
  posts: [],
  actions: [],
  leases: [],
  nextLease: 1,
  deletes: [],
  // Both are flipped by the tests below to exercise the client's defensive paths.
  omitRevision: false,
  engine: { pid: 4242, running: false, listen: [{ port: 24531, open: true }] },
}
let server
let home
let port

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

before(async () => {
  mkdirSync(WS, { recursive: true })
  home = mkdtempSync(join(tmpdir(), 'yds-risd-tier-'))
  server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return send(res, 200, { ok: true, apiVersion: 1, version: 'test', pid: process.pid, port })
    }
    if (req.method === 'GET' && url.pathname === '/v1/proxy') {
      return send(res, 200, {
        ok: true,
        ...(state.omitRevision === true ? {} : { revision: state.revision }),
        rules: [],
        running: false,
        listenPort: 11081,
      })
    }
    if (req.method === 'POST' && url.pathname === '/v1/proxy') {
      const body = await readBody(req)
      state.posts.push(body)
      if (state.forcedConflicts > 0) {
        state.forcedConflicts -= 1
        state.revision = 'rev2'
        return send(res, 409, { ok: false, conflict: true, code: 'conflict', message: 'conflict', revision: state.revision })
      }
      state.revision = 'rev3'
      return send(res, 200, { ok: true, revision: state.revision, reloadNote: '' })
    }
    if (req.method === 'POST' && url.pathname === '/v1/leases') {
      const body = await readBody(req)
      const id = `lease-${state.nextLease++}`
      state.leases.push({ id, ownerPid: body.ownerPid })
      return send(res, 200, { ok: true, lease: { id } })
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/leases/')) {
      const id = url.pathname.split('/').pop()
      state.deletes.push(id)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/v1/action') {
      const body = await readBody(req)
      state.actions.push(body)
      return send(res, 200, { ok: true, result: { ok: true, pid: 4242 } })
    }
    if (req.method === 'GET' && url.pathname === '/v1/engine') {
      return send(res, 200, { ok: true, engine: state.engine })
    }
    return send(res, 404, { ok: false, code: 'not-found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  writeFileSync(join(home, 'risd.json'), `${JSON.stringify({ apiVersion: 1, version: 'test', pid: process.pid, port, token: 'test-token' })}\n`, { mode: 0o600 })
  // A pre-existing global table: one user row and two yds rows written by an older
  // version (no `owners` — yds rows are not attributed to a project any more).
  writeFileSync(join(home, 'proxy.json'), `${JSON.stringify({
    socks: { host: '10.0.0.1', port: 1080 },
    listenPort: 11081,
    rules: [
      { id: 'user-1', program: 'navicat.exe', hosts: '172.16.0.1', ports: '*', enabled: true, source: 'user', workspace: '/elsewhere' },
      { id: 'yds-old', program: 'java.exe', hosts: '172.16.0.2', ports: '*', enabled: true, source: 'yds', workspace: WS },
      { id: 'yds-other', program: 'java.exe', hosts: '172.17.9.*', ports: '*', enabled: true, source: 'yds', workspace: '/elsewhere' },
    ],
    shadows: [],
  }, null, 2)}\n`, { mode: 0o600 })
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.YDS_IDE_PROXY = 'none'
})

after(() => {
  server.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(join(home, '..', '.dsh-ris-yds'), { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
})

function cfg() {
  return { workspace: WS, socks: { host: '1.2.3.4', port: 1080 }, git: null, proxyJavaRules: true }
}

test('discovery prefers the daemon and honours YDS_RISD=none', async () => {
  const { probeRisd } = await import('../lib/risd-peer.js')
  const found = await probeRisd({ home })
  assert.equal(found.usable, true)
  assert.equal(found.state.port, port)
  process.env.YDS_RISD = 'none'
  const disabled = await probeRisd({ home })
  assert.equal(disabled.usable, false)
  assert.equal(disabled.reason, 'disabled')
  delete process.env.YDS_RISD
})

test('a rule write sends the complete table: user rows kept, every yds row replaced', async () => {
  const { probeRisd, putRules } = await import('../lib/risd-peer.js')
  const { ydsRulesFor } = await import('../lib/ide-proxy.js')
  const found = await probeRisd({ home })
  state.forcedConflicts = 0
  const rules = ydsRulesFor(cfg(), [{ host: '10.0.0.5', port: 1521 }])
  const saved = await putRules(WS, rules, { state: found.state })
  assert.equal(saved.ok, true)
  const posted = state.posts[state.posts.length - 1]
  assert.equal(posted.revision, 'rev1')
  // The daemon replaces the whole table with `config.rules`: there is no per-source
  // retire flag and no workspace share — the payload IS the next table.
  assert.equal('replaceRulesFrom' in posted, false)
  const ids = posted.config.rules.map((rule) => rule.id)
  assert.ok(ids.includes('user-1'), 'the user row is carried by the writer')
  assert.ok(!ids.includes('yds-old'), 'every previous yds row is gone, not unioned')
  assert.ok(!ids.includes('yds-other'))
  assert.ok(ids.includes('yds-java'), 'the fresh yds set is the yds share')
  const java = posted.config.rules.find((rule) => rule.id === 'yds-java')
  assert.equal(java.hosts, '10.0.0.*', 'hosts come from this run only, never from an older row')
  assert.equal(java.side, 'windows')
  if (process.platform !== 'win32') {
    assert.ok(ids.includes('yds-java-local'), 'non-Windows hosts also need the WSL-side row')
    const local = posted.config.rules.find((rule) => rule.id === 'yds-java-local')
    assert.equal(local.program, 'java')
    assert.equal(local.side, 'local')
  }
})

test('a revision conflict is retried once with the fresh revision', async () => {
  const { probeRisd, putRules } = await import('../lib/risd-peer.js')
  const { ydsRulesFor } = await import('../lib/ide-proxy.js')
  const found = await probeRisd({ home })
  state.revision = 'rev1'
  state.forcedConflicts = 1
  state.posts = []
  const saved = await putRules(WS, ydsRulesFor(cfg(), []), { state: found.state, shadows: [] })
  assert.equal(saved.ok, true)
  assert.equal(state.posts.length, 2)
  assert.equal(state.posts[0].revision, 'rev1')
  assert.equal(state.posts[1].revision, 'rev2')
})

test('ensureBorrowedProxy writes rules and starts the daemon engine', async () => {
  const { ensureBorrowedProxy } = await import('../lib/ide-proxy.js')
  state.actions = []
  const result = await ensureBorrowedProxy(cfg(), [{ host: '10.0.0.5', port: 1521 }], { mapping: true })
  assert.equal(result.mode, 'risd')
  assert.equal(result.ok, true)
  assert.equal(result.pid, 4242)
  assert.deepEqual(state.actions.map((action) => action.action), ['start'])
})

test('yds stop releases the lease and removes every yds row, but keeps the shared engine', async () => {
  const { holdBorrowedLease, stopBorrowedProxy } = await import('../lib/ide-proxy.js')
  const held = await holdBorrowedLease(cfg(), { ownerPid: process.pid })
  assert.equal(held.ok, true)
  state.actions = []
  state.posts = []
  state.deletes = []
  const stopped = await stopBorrowedProxy(cfg())
  assert.equal(stopped.engine, 'kept')
  assert.equal(stopped.mode, 'risd')
  assert.deepEqual(state.deletes, [held.id])
  assert.equal(state.actions.length, 0, 'never stops the machine-shared engine')
  const posted = state.posts[state.posts.length - 1]
  // The rule table is one global list: a stop clears the yds rows (including rows an
  // older version wrote without owners) and carries the user's rows through intact.
  // There is no "another project's share" to protect any more (no cross configuration).
  assert.deepEqual(posted.config.rules.map((rule) => rule.id), ['user-1'])
  assert.equal('replaceRulesFrom' in posted, false)
  // The CLI reports what actually changed, not a blanket "rules withdrawn".
  assert.deepEqual(stopped.withdrawn, { rules: 2, hosts: 2 })
  assert.equal(existsSync(join(home, '..', '.dsh-ris-yds', 'risd-leases.json')), true)
  const leases = JSON.parse(readFileSync(join(home, '..', '.dsh-ris-yds', 'risd-leases.json'), 'utf8'))
  assert.equal(leases[WS], undefined)
})

test('a rule write never takes the daemon force path when the view has no revision', async () => {
  const { putRules } = await import('../lib/risd-peer.js')
  state.omitRevision = true
  const posted = state.posts.length
  try {
    const saved = await putRules(WS, [], {})
    assert.equal(saved.ok, false)
    assert.match(saved.error, /revision-missing/)
    assert.equal(state.posts.length, posted, 'no un-CASed write was attempted')
  } finally {
    state.omitRevision = false
  }
})

test('a rule write sends only fields the daemon consumes (no dead shadows field)', async () => {
  const { putRules } = await import('../lib/risd-peer.js')
  const path = join(home, 'proxy.json')
  const original = readFileSync(path, 'utf8')
  const stored = JSON.parse(original)
  stored.shadows = [{ host: '10.0.0.9', port: 1521 }]
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  try {
    state.posts = []
    const saved = await putRules(WS, [], { gitHost: 'git.example.com' })
    assert.equal(saved.ok, true)
    // POST /v1/proxy ignores `config.shadows`; sending it implied a mapping update
    // that could never happen (review D-P2-8).
    assert.equal(state.posts[0].config.shadows, undefined)
    assert.equal(state.posts[0].config.listenPort, 11081, 'other table fields survive')
    assert.ok(Array.isArray(state.posts[0].config.rules), 'rules are still sent')
  } finally {
    writeFileSync(path, original, { mode: 0o600 })
  }
})

test('borrowedProxyStatus reports the engine pid and listeners, not the config port', async () => {
  const { borrowedProxyStatus } = await import('../lib/ide-proxy.js')
  state.engine = { pid: 4242, running: true, listen: [{ port: 24531, open: true }] }
  const st = await borrowedProxyStatus(cfg())
  assert.equal(st.mode, 'risd')
  assert.equal(st.running, true)
  assert.equal(st.pid, 4242)
  assert.deepEqual(st.listenPorts, [24531])
  assert.equal(st.listenPort, 11081, 'the configured listenPort from the view, unchanged')
})

// ---------------------------------------------------------------------------
// CLI-level: what a user sees after `yds start` / `yds stop` in the risd tier.
// The workspace carries a SOCKS config, so the tunnel path is fully exercised.

const CLI_DB_PORT = 24631
const CLI_REDIS_PORT = 26901
const MIDDLEWARE = {
  connectionPools: { pool1: { url: 'jdbc:oracle:thin:@//172.20.235.80:1521/yonbipdev' } },
  'redis.pools': { redis1: { host: '172.20.235.81', port: 6890 } },
}

function cliWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'yds-risd-cli-'))
  mkdirSync(join(dir, '.dsh-ris-yds', 'confcenter'), { recursive: true })
  writeFileSync(join(dir, '.dsh-ris-yds', 'yms-port'), '65002')
  writeFileSync(join(dir, '.dsh-ris-yds', 'confcenter', 'yms_middleware.json'), JSON.stringify(MIDDLEWARE))
  writeFileSync(join(dir, '.env'), [
    'socks.host = 127.0.0.1',
    'socks.port = 1080',
    `socks.dbPort = ${CLI_DB_PORT}`,
    `socks.redisPort = ${CLI_REDIS_PORT}`,
    '',
  ].join('\n'))
  return dir
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

test('status names the risd daemon engine even when this process cannot load dsh-ris-ide', async () => {
  const dir = cliWorkspace()
  try {
    state.engine = { pid: 4242, running: true, listen: [{ port: 24531, open: true }] }
    const status = await run(['status'], { cwd: dir })
    assert.equal(status.exitCode ?? 0, 0, status.text)
    assert.match(status.text, /运行中（risd daemon 引擎 pid 4242）/)
    const proxy = await run(['proxy', 'status'], { cwd: dir })
    assert.equal(proxy.exitCode ?? 0, 0, proxy.text)
    // `loaded.path` is empty here (YDS_IDE_PROXY=none): the engine still has a name.
    assert.match(proxy.text, /引擎: risd:\d+/)
    assert.match(proxy.text, /运行: 是（pid 4242）/)
    assert.match(proxy.text, /引擎监听 24531/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('proxy start names the engine listeners and brings the bundled forwarder up', async () => {
  const dir = cliWorkspace()
  try {
    state.engine = { pid: 4242, running: false, listen: [{ port: 24531, open: true }] }
    const started = await run(['proxy', 'start'], { cwd: dir })
    assert.equal(started.exitCode ?? 0, 0, started.text)
    assert.match(started.text, /引擎监听 1 个端口（24531）/)
    assert.match(started.text, /内置 socks 转发器已启动/)
    assert.equal(await portOpen(CLI_DB_PORT), true, '127.0.0.1 兜底端口由内置转发器监听')
  } finally {
    await run(['proxy', 'stop'], { cwd: dir })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('yds stop --keep-socks still releases the lease and withdraws rules, and defers the bridge reload', async () => {
  const dir = cliWorkspace()
  const { rememberLease } = await import('../lib/risd-peer.js')
  try {
    state.deletes = []
    state.posts = []
    // A lease recorded for this workspace, as `yds start` would have left it.
    assert.equal(rememberLease(dir, { id: 'lease-cli', ownerPid: process.pid, port: 11081 }), true)
    const stopped = await run(['stop', '--keep-socks'], { cwd: dir })
    assert.equal(stopped.exitCode ?? 0, 0, stopped.text)
    // --keep-socks never meant "keep the lease": the YMS pid is gone, so a held
    // lease would keep the daemon's engine alive for a dead owner (D-P2-7).
    assert.deepEqual(state.deletes, ['lease-cli'])
    const posted = state.posts[state.posts.length - 1]
    assert.equal('replaceRulesFrom' in posted, false, 'the save carries the whole table')
    assert.equal(posted.config.rules.some((rule) => rule.source === 'yds'), false, 'the global table keeps no yds rows after a stop')
    assert.match(stopped.text, /内置 socks 转发器：保留（--keep-socks）/)
    // The daemon reloaded the bridge while saving the table; reloading it again
    // from this short-lived CLI would fight the daemon's serialized reload (D-P2-10).
    assert.match(stopped.text, /系统层拦截: 由 risd daemon 管理/)
    assert.doesNotMatch(stopped.text, /未找到 dsh-ris-ide 的 ProxyBridge 适配器/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('holdBorrowedLease drops a dead record for the same workspace before taking a new one', async () => {
  const { readLease, rememberLease } = await import('../lib/risd-peer.js')
  const { holdBorrowedLease } = await import('../lib/ide-proxy.js')
  assert.equal(rememberLease(WS, { id: 'lease-dead', ownerPid: 999999, port: 1 }), true)
  const lines = []
  const held = await holdBorrowedLease(cfg(), { ownerPid: process.pid, log: (line) => lines.push(line) })
  assert.equal(held.ok, true)
  assert.ok(lines.some((line) => /已清理该 workspace 的死租约记录/.test(line)), lines.join('\n'))
  assert.notEqual(readLease(WS)?.id, 'lease-dead', 'the dead record was replaced, not kept')
})
