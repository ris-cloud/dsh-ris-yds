// A failed lease release must keep the local record: forgetting it turned a
// transient daemon failure into "nobody owns the engine", resolved only by the
// daemon's pid sweep (review D-P2-6).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'yds-lease-'))
const WS = mkdtempSync(join(tmpdir(), 'yds-lease-ws-'))
let mode = 'ok'
let server = null
let port = 0

test.before(async () => {
  server = createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(`${JSON.stringify(payload)}\n`)
    }
    if (req.method === 'GET' && req.url === '/v1/health') {
      return send(200, { ok: true, apiVersion: 1, version: 'test' })
    }
    if (req.method === 'POST' && req.url === '/v1/leases') {
      return send(200, { ok: true, lease: { id: 'lease-1' } })
    }
    if (req.method === 'DELETE' && req.url.startsWith('/v1/leases/')) {
      if (mode === 'fail') return send(500, { ok: false, error: 'daemon broke' })
      return send(200, { ok: true, released: true })
    }
    return send(404, { ok: false })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  writeFileSync(join(home, 'risd.json'), `${JSON.stringify({
    apiVersion: 1, version: 'test', pid: process.pid, port, token: 'test-token',
  })}\n`, { mode: 0o600 })
  process.env.DSH_RIS_IDE_PROXY_HOME = home
  process.env.YDS_IDE_PROXY = 'none'
})

test.after(() => {
  server?.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(join(home, '..', '.dsh-ris-yds'), { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
})

function cfg() {
  return { workspace: WS, socks: { host: '1.2.3.4', port: 1080 }, git: null, proxyJavaRules: true }
}

test('a failed release keeps the lease record so a retry can finish the job', async () => {
  const { holdBorrowedLease, releaseBorrowedLease } = await import('../lib/ide-proxy.js')
  const { readLease } = await import('../lib/risd-peer.js')
  const held = await holdBorrowedLease(cfg(), { ownerPid: process.pid })
  assert.equal(held.ok, true)
  assert.equal(readLease(WS)?.id, 'lease-1')

  mode = 'fail'
  const failed = await releaseBorrowedLease(cfg())
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /daemon broke|释放租约失败/)
  assert.equal(readLease(WS)?.id, 'lease-1', 'the record survives a failed release')

  mode = 'ok'
  const retried = await releaseBorrowedLease(cfg())
  assert.equal(retried.ok, true)
  assert.equal(retried.released, true)
  assert.equal(readLease(WS), null, 'a successful release forgets the record')

  const leases = JSON.parse(readFileSync(join(home, '..', '.dsh-ris-yds', 'risd-leases.json'), 'utf8'))
  assert.equal(leases[WS], undefined)
})
