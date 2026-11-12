// `yds start --restart`, plus the case that used to break start: a live YMS whose
// pidfile was lost (the foreground CLI unlinks it on exit). Before this, `yds start`
// spawned a second Liberty, Liberty refused with CWWKE0029E, and the live instance
// stayed unmanaged. Identity checks stay three-valued: an unreadable pid is never
// signalled and a busy-but-unidentified port is never treated as "free".
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  listenPid, parseLsofPid, parseNetstatListenPid, parseSsListenPid,
} from '../lib/proc.js'
import { detectRunningOnPort, startDetached, stopForRestart, waitPortClosed, ymsPidFile } from '../lib/yms.js'

const WIN = 'win32'
const YMS_LINE = 'java -cp /w/yms.jar iuap.yms.YMSLauncher -DYMS-DEV=true'

/** exec stub: netstat for listenPid, powershell for the identity probe. */
const exe = (command) => {
  if (command === 'netstat') {
    return { code: 0, stdout: '  TCP    0.0.0.0:31012    0.0.0.0:0    LISTENING    4242\n', stderr: '', error: null }
  }
  return { code: 0, stdout: `YDS_PROBE_OK:${YMS_LINE}`, stderr: '', error: null }
}

function makeCfg() {
  return { stateDir: mkdtempSync(join(tmpdir(), 'yds-restart-')), ymsPort: 31012 }
}
function withCfg(fn) {
  return async () => {
    const cfg = makeCfg()
    try { await fn(cfg) } finally { rmSync(cfg.stateDir, { recursive: true, force: true }) }
  }
}

const open = async () => true

test('listenPid: parses ss, lsof and netstat listings', () => {
  assert.equal(parseSsListenPid('LISTEN 0 511 *:31012 *:* users:(("java",pid=379600,fd=140))').pid, 379600)
  assert.equal(parseSsListenPid('Local Address:Port\n').pid, null)
  assert.equal(parseLsofPid('4242\n4344\n').pid, 4242)
  assert.equal(parseLsofPid('').pid, null)
  assert.equal(parseNetstatListenPid('  TCP    0.0.0.0:31012    0.0.0.0:0    LISTENING    4242', 31012).pid, 4242)
  assert.equal(parseNetstatListenPid('  TCP    0.0.0.0:31012    0.0.0.0:0    LISTENING    4242', 31013).pid, null)
})

test('listenPid: platform commands, with the linux lsof fallback', () => {
  assert.equal(listenPid(31012, { platform: WIN, exec: exe }).pid, 4242)
  const linuxSs = () => ({ code: 0, stdout: 'LISTEN 0 511 *:31012 *:* users:(("java",pid=555,fd=1))', stderr: '', error: null })
  assert.equal(listenPid(31012, { platform: 'linux', exec: linuxSs }).pid, 555)
  // ss present but without pid (permissions) -> lsof decides
  const ssNoPid = (command) => command === 'ss'
    ? { code: 0, stdout: 'LISTEN 0 511 *:31012 *:*', stderr: '', error: null }
    : { code: 0, stdout: '777\n', stderr: '', error: null }
  assert.equal(listenPid(31012, { platform: 'linux', exec: ssNoPid }).pid, 777)
  const nothing = () => ({ code: 1, stdout: '', stderr: 'no such command', error: null })
  assert.equal(listenPid(31012, { platform: 'linux', exec: nothing }).pid, null)
})

test('detectRunningOnPort: ours / foreign / unidentified', async () => {
  const ours = await detectRunningOnPort({ ymsPort: 31012 }, { open, listen: () => ({ pid: 4242 }), platform: WIN, exec: exe })
  assert.deepEqual([ours.state, ours.pid, ours.port], ['ours', 4242, 31012])

  const foreignExec = (command) => command === 'netstat'
    ? exe(command)
    : { code: 0, stdout: 'YDS_PROBE_OK:notepad.exe', stderr: '', error: null }
  const foreign = await detectRunningOnPort({ ymsPort: 31012 }, { open, listen: () => ({ pid: 4242 }), platform: WIN, exec: foreignExec })
  assert.equal(foreign.state, 'foreign')

  const blind = await detectRunningOnPort({ ymsPort: 31012 }, { open, listen: () => ({ pid: null, reason: 'no pid' }), platform: WIN, exec: exe })
  assert.equal(blind.state, 'unknown')
  assert.match(blind.reason, /no pid/)

  const closed = await detectRunningOnPort({ ymsPort: 31012 }, { open: async () => false, listen: () => ({ pid: 4242 }) })
  assert.equal(closed, null)
})

test('startDetached adopts an unregistered live YMS instead of spawning a second one', withCfg(async (cfg) => {
  const result = await startDetached(cfg, { open, listen: () => ({ pid: 4242 }), platform: WIN, exec: exe })
  assert.equal(result.started, false)
  assert.equal(result.alreadyRunning, true)
  assert.equal(result.adopted, true)
  assert.equal(result.pid, 4242)
  assert.equal(readFileSync(ymsPidFile(cfg), 'utf8'), '4242', 'the lost pidfile is restored')
}))

test('startDetached refuses a busy port it cannot attribute', withCfg(async (cfg) => {
  const result = await startDetached(cfg, {
    open,
    listen: () => ({ pid: null, reason: 'ss 无法读取 pid' }),
    platform: WIN,
    exec: exe,
  })
  assert.equal(result.portBlocked, true)
  assert.match(result.reason, /ss 无法读取 pid/)
  assert.equal(existsSync(ymsPidFile(cfg)), false, 'nothing was registered')
}))

test('startDetached --restart stops an adopted instance, then starts (spawn not reached here)', withCfg(async (cfg) => {
  const result = await startDetached(cfg, { restart: true, open, listen: () => ({ pid: null }) })
  assert.equal(result.restartFailed, true)
  assert.match(result.reason, /无法确认持有者/)
}))

test('stopForRestart: adopts then stops the port owner; keeps the pidfile when identity is unknown', async () => {
  let alive = true
  const killed = []
  const options = {
    open,
    listen: () => ({ pid: 4344 }),
    platform: 'linux',
    signal: () => (alive ? 'alive' : 'dead'),
    commandLine: () => YMS_LINE,
    kill: (pid) => { killed.push(pid); alive = false; return { ok: true } },
  }
  const logs = []
  const ok = await stopForRestart(makeCfg(), options, (line) => logs.push(line))
  assert.equal(ok.ok, true)
  assert.equal(ok.adopted, true)
  assert.deepEqual(killed, [4344])
  assert.match(logs.join('\n'), /未登记/)

  const blind = await stopForRestart(makeCfg(), {
    open,
    listen: () => ({ pid: 4344 }),
    platform: 'linux',
    signal: () => 'alive',
    commandLine: () => '',
  })
  assert.equal(blind.ok, false)
  assert.match(blind.reason, /无法确认持有者|无法确认/)
})

test('waitPortClosed gives up after its budget', async () => {
  const cfg = makeCfg()
  const started = Date.now()
  const closed = await waitPortClosed(cfg, { open: async () => true, budgetMs: 600 })
  assert.equal(closed, false)
  assert.ok(Date.now() - started >= 500)
  rmSync(cfg.stateDir, { recursive: true, force: true })
})
