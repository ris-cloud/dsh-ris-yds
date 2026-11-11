import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

import { run } from '../lib/cli.js'

// The suite inherits the developer's shell: strip every YDS_* override, then
// force the "dsh-ris-ide is not installed" path — the bundled SOCKS forwarder
// is the only tunnel left, which is exactly the standalone (public plugin)
// shape.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('YDS_')) delete process.env[key]
}
process.env.YDS_IDE_PROXY = 'none'
// The risd tier reads `~/.dsh-ris-ide` by default; a developer's daemon running on
// the machine must not decide this test's outcome. Point it at a fresh home.
process.env.DSH_RIS_IDE_PROXY_HOME = mkdtempSync(join(tmpdir(), 'yds-standalone-risd-'))

const DB_PORT = 24531
const REDIS_PORT = 26891

const MIDDLEWARE = {
  connectionPools: {
    pool1: { url: 'jdbc:oracle:thin:@//172.20.235.80:1521/yonbipdev' },
  },
  'redis.pools': {
    redis1: { host: '172.20.235.81', port: 6890 },
  },
}

function ok(result) {
  // text() reports success without an exitCode; fail() sets 1.
  assert.equal(result.exitCode ?? 0, 0, result.text)
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** A workspace with a cached confcenter pull; `socks` adds the tunnel .env. */
function workspace({ socks }) {
  const dir = mkdtempSync(join(tmpdir(), 'yds-standalone-'))
  mkdirSync(join(dir, '.dsh-ris-yds', 'confcenter'), { recursive: true })
  writeFileSync(join(dir, '.dsh-ris-yds', 'yms-port'), '65001')
  writeFileSync(join(dir, '.dsh-ris-yds', 'confcenter', 'yms_middleware.json'), JSON.stringify(MIDDLEWARE))
  if (socks === true) {
    writeFileSync(join(dir, '.env'), [
      'socks.host = 127.0.0.1',
      'socks.port = 1080',
      `socks.dbPort = ${DB_PORT}`,
      `socks.redisPort = ${REDIS_PORT}`,
      '',
    ].join('\n'))
  }
  return dir
}

test('without dsh-ris-ide a direct workspace needs no tunnel at all', async () => {
  const dir = workspace({ socks: false })
  try {
    const sync = await run(['proxy', 'sync'], { cwd: dir })
    ok(sync)
    assert.match(sync.text, /直连模式/)
    const status = await run(['proxy', 'status'], { cwd: dir })
    ok(status)
    assert.match(status.text, /代理引擎不可用/)
    assert.match(status.text, /不适用（未配置 SOCKS，直连模式）/)
    // No tunnel => the sibling plugin has nothing to offer, so no hint either.
    const doctor = await run(['doctor'], { cwd: dir })
    ok(doctor)
    assert.doesNotMatch(doctor.text, /未检测到 dsh-ris-ide/)
    assert.equal(await portOpen(DB_PORT), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without dsh-ris-ide the bundled forwarder replaces the borrowed engine', async () => {
  const dir = workspace({ socks: true })
  try {
    const sync = await run(['proxy', 'sync'], { cwd: dir })
    ok(sync)
    assert.match(sync.text, /代理引擎不可用/)
    assert.match(sync.text, /内置 socks 转发器已启动/)
    assert.equal(await portOpen(DB_PORT), true, 'Oracle 兜底端口由内置转发器监听')
    assert.equal(await portOpen(REDIS_PORT), true, 'Redis 兜底端口由内置转发器监听')

    const status = await run(['proxy', 'status'], { cwd: dir })
    ok(status)
    assert.match(status.text, /内置转发器: 运行中/)
    assert.match(status.text, /172\.20\.235\.80:1521/)

    // Tunnel without the borrowed engine: recommend the sibling plugin once, as
    // an optional upgrade — never as a broken setup.
    const doctor = await run(['doctor'], { cwd: dir })
    ok(doctor)
    assert.match(doctor.text, /未检测到 dsh-ris-ide（可选）/)
    assert.match(doctor.text, /启停本地服务/)

    // Starting twice is idempotent (no duplicate process / EADDRINUSE).
    const again = await run(['proxy', 'start'], { cwd: dir })
    ok(again)
    assert.match(again.text, /已在运行/)

    const stop = await run(['proxy', 'stop'], { cwd: dir })
    ok(stop)
    assert.match(stop.text, /内置转发器已停止/)
    assert.equal(await portOpen(DB_PORT), false)
    assert.equal(await portOpen(REDIS_PORT), false)
  } finally {
    await run(['proxy', 'stop'], { cwd: dir }).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
