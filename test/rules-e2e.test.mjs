// End-to-end round trip of the global rule table through the daemon contract: rules
// leave yds over HTTP and land in proxy.json. The stub below models the whole-table
// save — whatever `config.rules` the client sends IS the new table, so a yds write has
// to carry the user's rows itself and a stop has to send the table without the yds rows.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'yds-e2e-'))
const WS_A = mkdtempSync(join(tmpdir(), 'yds-e2e-a-'))
const WS_B = mkdtempSync(join(tmpdir(), 'yds-e2e-b-'))
const USER_ROW = { id: 'user-1', program: 'navicat.exe', hosts: '10.9.9.*', ports: '*', source: 'user' }
let revision = 'r1'
let server = null
let lastPost = null

function tablePath() { return join(home, 'proxy.json') }

function writeTable(rules) {
  writeFileSync(tablePath(), `${JSON.stringify({
    socks: { host: '', port: 0 }, listenPort: 11081, rules, shadows: [],
  }, null, 2)}\n`, { mode: 0o600 })
}

function readTable() {
  return existsSync(tablePath())
    ? JSON.parse(readFileSync(tablePath(), 'utf8'))
    : { socks: { host: '', port: 0 }, listenPort: 11081, rules: [], shadows: [] }
}

test.before(async () => {
  writeTable([USER_ROW])
  server = createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(`${JSON.stringify(payload)}\n`)
    }
    if (req.method === 'GET' && req.url === '/v1/health') return send(200, { ok: true, apiVersion: 1, version: 'test' })
    if (req.method === 'GET' && String(req.url).startsWith('/v1/proxy')) {
      return send(200, { ok: true, revision, running: false, listenPort: 11081, rules: readTable().rules })
    }
    if (req.method === 'POST' && req.url === '/v1/proxy') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        lastPost = parsed
        if (String(parsed.revision).trim() !== '' && parsed.revision !== revision) {
          return send(409, { ok: false, code: 'revision-conflict', revision })
        }
        const rules = parsed.config?.rules
        if (!Array.isArray(rules)) return send(400, { ok: false, error: 'rules must be the final table' })
        // Whole-table save: the payload IS the table (no per-source bookkeeping).
        writeTable(rules)
        revision = `r${Number(revision.slice(1)) + 1}`
        return send(200, { ok: true, revision, reloadNote: '' })
      })
      return undefined
    }
    return send(404, { ok: false })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(home, 'risd.json'), `${JSON.stringify({
    apiVersion: 1, version: 'test', pid: process.pid, port: server.address().port, token: 'test-token',
  })}\n`, { mode: 0o600 })
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.YDS_IDE_PROXY = 'none'
})

test.after(() => {
  server?.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(join(home, '..', '.dsh-ris-yds'), { recursive: true, force: true })
  rmSync(WS_A, { recursive: true, force: true })
  rmSync(WS_B, { recursive: true, force: true })
})

function javaRow(hosts, side = 'windows') {
  return { id: side === 'local' ? 'yds-java-local' : 'yds-java', program: side === 'local' ? 'java' : 'java.exe', side, hosts, ports: '*', enabled: true, shadow: false, source: 'yds' }
}

test('a start writes the complete table and a stop removes every yds row', async () => {
  const { putRules } = await import('../lib/risd-peer.js')

  const started = await putRules(WS_A, [javaRow('10.1.1.*')], { home })
  assert.equal(started.ok, true)
  const saved = readTable().rules
  assert.deepEqual(saved.map((row) => row.id), ['user-1', 'yds-java'], 'the user row is still there')
  assert.equal(saved[1].hosts, '10.1.1.*')
  assert.equal('replaceRulesFrom' in (lastPost ?? {}), false, 'the whole-table save needs no per-source flag')
  assert.deepEqual(lastPost.config.rules.map((row) => row.id), ['user-1', 'yds-java'])

  const stopped = await putRules(WS_A, [], { home })
  assert.equal(stopped.ok, true)
  assert.deepEqual(stopped.withdrawn, { rules: 1, hosts: 1 })
  assert.deepEqual(readTable().rules, [USER_ROW], 'the user row survives the stop, the yds rows do not')
})

test('the table is global: the last start wins and a stop clears every yds row', async () => {
  const { putRules } = await import('../lib/risd-peer.js')
  await putRules(WS_A, [javaRow('10.1.1.*')], { home })
  const bStart = await putRules(WS_B, [javaRow('10.2.2.*')], { home })
  assert.equal(bStart.ok, true)
  const table = readTable().rules
  assert.equal(table.filter((row) => row.source === 'yds').length, 1, 'one global java row, not one per project')
  assert.equal(table.find((row) => row.source === 'yds').hosts, '10.2.2.*', 'B replaces A; endpoints are not unioned')

  const aStop = await putRules(WS_A, [], { home })
  assert.equal(aStop.ok, true)
  assert.deepEqual(readTable().rules, [USER_ROW], 'a stop owns every yds row, whichever project saved it')
})

test('a stale revision is rejected and retried with the fresh view', async () => {
  const { putRules } = await import('../lib/risd-peer.js')
  revision = 'bumped-outside'
  const saved = await putRules(WS_A, [javaRow('10.5.5.*')], { home })
  assert.equal(saved.ok, true, 'the retry re-reads the view and lands')
  assert.equal(readTable().rules.find((row) => row.source === 'yds').hosts, '10.5.5.*')
})
