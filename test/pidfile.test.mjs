// Pidfile handling when the process identity cannot be read. "Could not tell" used to
// be treated as "not our process", which deleted the pidfile and either started a
// second YMS/forwarder on top of a live one or left an orphan unreachable by
// `yds stop` (review D-P1-6). These tests drive the Windows/timeout path through the
// injectable probe options so they run on the Linux CI too.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { probeForwarder, socksPidFile, stopForwarder } from '../lib/socks.js'
import { readRunning, stopYms, ymsPidFile } from '../lib/yms.js'

const WIN = 'win32'
const unknownExec = () => ({ code: null, stdout: '', stderr: '', error: new Error('powershell timed out') })
const absentExec = () => ({ code: 0, stdout: 'YDS_PROBE_ABSENT', stderr: '', error: null })
const aliveExec = (commandLine) => () => ({ code: 0, stdout: `YDS_PROBE_OK:${commandLine}`, stderr: '', error: null })

function makeCfg() {
  const stateDir = mkdtempSync(join(tmpdir(), 'yds-pid-'))
  return { stateDir, dbForwardPort: 47431, redisForwardPort: 47432 }
}

function withCfg(fn) {
  return async () => {
    const cfg = makeCfg()
    try { await fn(cfg) } finally { rmSync(cfg.stateDir, { recursive: true, force: true }) }
  }
}

test('yms: an unreadable identity keeps the pidfile and refuses to signal', withCfg(async (cfg) => {
  writeFileSync(ymsPidFile(cfg), '4242')
  const running = await readRunning(cfg, { platform: WIN, exec: unknownExec })
  assert.equal(running.state, 'unknown')
  assert.equal(running.pid, 4242)
  assert.equal(existsSync(ymsPidFile(cfg)), true, 'pidfile must survive a probe failure')
  assert.match(readFileSync(ymsPidFile(cfg), 'utf8'), /4242/)

  const stopped = await stopYms(cfg, { platform: WIN, exec: unknownExec, graceMs: 10 })
  assert.equal(stopped.stopped, false)
  assert.match(String(stopped.reason), /未发送停止信号/)
  assert.equal(existsSync(ymsPidFile(cfg)), true, 'still ours as far as we know: keep the pidfile')
}))

test('yms: a dead or reused pid is cleaned from the pidfile', withCfg(async (cfg) => {
  writeFileSync(ymsPidFile(cfg), '4242')
  assert.equal(await readRunning(cfg, { platform: WIN, exec: absentExec }), null)
  assert.equal(existsSync(ymsPidFile(cfg)), false)

  writeFileSync(ymsPidFile(cfg), '4242')
  // Alive but a completely different command line: the pid was reused after a crash.
  assert.equal(await readRunning(cfg, { platform: WIN, exec: aliveExec('notepad.exe') }), null)
  assert.equal(existsSync(ymsPidFile(cfg)), false)
}))

test('yms: a verified owner is reported, and a failed stop keeps the pidfile', withCfg(async (cfg) => {
  writeFileSync(ymsPidFile(cfg), '4344')
  const owners = aliveExec('java -cp yms.jar iuap.yms.YMSLauncher')
  assert.deepEqual(await readRunning(cfg, { platform: WIN, exec: owners }), { pid: 4344 })

  // taskkill failed but the process is still alive: report the failure, keep the
  // pidfile so `yds status` keeps seeing it (review D-P1-7).
  const denied = () => ({ code: 5, stdout: '', stderr: 'Access is denied.', error: null })
  const failed = await stopYms(cfg, { platform: WIN, exec: denied, probe: () => ({ state: 'alive', commandLine: '' }), graceMs: 10 })
  assert.equal(failed.stopped, false)
  assert.match(String(failed.reason), /已保留 pidfile/)
  assert.equal(existsSync(ymsPidFile(cfg)), true)

  // A successful stop is the only path that unlinks the pidfile. (The same fake exec
  // answers the identity probe and taskkill: both exit 0, and the command line still
  // identifies the YMS.)
  assert.equal((await stopYms(cfg, { platform: WIN, exec: owners })).stopped, true)
  assert.equal(existsSync(ymsPidFile(cfg)), false)
}))

test('socks: an unreadable forwarder identity keeps the pidfile', withCfg(async (cfg) => {
  writeFileSync(socksPidFile(cfg), '4343')
  const probe = probeForwarder(cfg, { platform: WIN, exec: unknownExec })
  assert.equal(probe.state, 'unknown')
  assert.equal(probe.pid, null, 'no pid is handed out while the identity is unreadable')
  assert.equal(existsSync(socksPidFile(cfg)), true)

  const stopped = await stopForwarder(cfg, { platform: WIN, exec: unknownExec })
  assert.equal(stopped.stopped, false)
  assert.equal(existsSync(socksPidFile(cfg)), true)
}))

test('socks: a dead or reused forwarder pid is cleaned', withCfg(async (cfg) => {
  writeFileSync(socksPidFile(cfg), '4343')
  assert.equal(probeForwarder(cfg, { platform: WIN, exec: absentExec }).state, 'stale')
  assert.equal(existsSync(socksPidFile(cfg)), false)

  writeFileSync(socksPidFile(cfg), '4343')
  const foreign = probeForwarder(cfg, { platform: WIN, exec: aliveExec('some-other-daemon') })
  assert.equal(foreign.state, 'stale')
  assert.equal(existsSync(socksPidFile(cfg)), false)
}))

test('socks: the verified forwarder is recognised as ours', withCfg(async (cfg) => {
  writeFileSync(socksPidFile(cfg), '4343')
  const probe = probeForwarder(cfg, { platform: WIN, exec: aliveExec('node yds.js socks-fwd --socks=1.2.3.4:1080') })
  assert.equal(probe.state, 'verified')
  assert.equal(probe.pid, 4343)
}))
