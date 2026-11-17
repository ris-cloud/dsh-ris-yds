import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { pidAlive, processCommandLine, stopPid } from '../lib/proc.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('processCommandLine reads the current command line on this platform', () => {
  const line = processCommandLine(process.pid)
  assert.match(line, /node/i, 'contains the node executable')
  assert.equal(processCommandLine(0), '')
  assert.equal(processCommandLine(-1), '')
  assert.equal(processCommandLine('nope'), '')
})

test('pidAlive tells live from gone pids', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(2147480000), false)
})

test('stopPid ends a real child process and tolerates a dead pid', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await sleep(300)
  assert.equal(pidAlive(child.pid), true)
  await stopPid(child.pid, { graceMs: 3000 })
  await sleep(800)
  assert.equal(pidAlive(child.pid), false)
  await stopPid(child.pid, { graceMs: 500 }) // already gone: must not throw
})

// ---- Windows branches, driven through the injectable platform/exec -----------------
// CI runs on Linux, so the Windows path is only exercised when the platform and the
// command runner are injected. These tests pin the two behaviours the review found
// broken: "could not tell" must never become "not ours", and a failed taskkill must
// never be reported as a successful stop.

import { pidIdentity, probePid, signalState, windowsProbeArgs } from '../lib/proc.js'

const WIN = 'win32'
const okOut = (stdout) => ({ code: 0, stdout, stderr: '', error: null })

test('windowsProbeArgs uses a single-quoted WQL predicate and only the integer pid', () => {
  const args = windowsProbeArgs(4242)
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-Command'])
  const script = args.at(-1)
  assert.match(script, /-Filter 'ProcessId=4242'/)
  assert.ok(!script.includes('"ProcessId'), 'no double quotes embedded in -Command')
})

test('probePid distinguishes absent, readable and unknowable on Windows', () => {
  assert.deepEqual(probePid(11, { platform: WIN, exec: () => okOut('YDS_PROBE_ABSENT\n') }), { state: 'dead', commandLine: '' })
  const alive = probePid(11, { platform: WIN, exec: () => okOut('YDS_PROBE_OK:C:\\jdk\\bin\\java.exe -jar yms.jar') })
  assert.equal(alive.state, 'alive')
  assert.match(alive.commandLine, /yms\.jar/)
  // Empty output / access denied / timeout: cannot tell => unknown (never dead).
  assert.equal(probePid(11, { platform: WIN, exec: () => okOut('') }).state, 'unknown')
  assert.equal(probePid(11, { platform: WIN, exec: () => ({ code: 1, stdout: '', stderr: 'Access is denied.', error: null }) }).state, 'unknown')
  assert.equal(probePid(11, { platform: WIN, exec: () => ({ code: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') }) }).state, 'unknown')
  // An invalid pid is dead without spawning anything.
  let spawned = 0
  assert.equal(probePid(0, { platform: WIN, exec: () => { spawned += 1; return okOut('') } }).state, 'dead')
  assert.equal(spawned, 0)
})

test('pidIdentity separates ours/foreign/dead/unknown on Windows', () => {
  const markers = ['yms.jar']
  const identity = (stdout) => pidIdentity(7, markers, { platform: WIN, exec: () => okOut(stdout) }).state
  assert.equal(identity('YDS_PROBE_OK:java -jar yms.jar'), 'ours')
  assert.equal(identity('YDS_PROBE_OK:notepad.exe'), 'foreign')
  assert.equal(identity('YDS_PROBE_ABSENT'), 'dead')
  assert.equal(identity('YDS_PROBE_OK:'), 'unknown', 'alive but unreadable command line is NOT foreign')
  assert.equal(identity('garbage'), 'unknown')
})

test('a readable process with no command line is unknown, not foreign (POSIX too)', () => {
  const base = { platform: 'linux', signal: () => 'alive' }
  assert.equal(pidIdentity(7, ['yms.jar'], { ...base, commandLine: () => '' }).state, 'unknown')
  assert.equal(pidIdentity(7, ['yms.jar'], { ...base, commandLine: () => '/usr/bin/java -jar yms.jar' }).state, 'ours')
})

test('signalState maps EPERM to alive and ESRCH to dead', () => {
  // pid 1 always exists; as an unprivileged user kill(1,0) throws EPERM, which must
  // count as alive (the old code mapped every error to "dead").
  assert.equal(signalState(1), 'alive')
  assert.equal(signalState(2147480000), 'dead')
})

test('stopPid consumes the taskkill exit code instead of assuming success', async () => {
  const calls = []
  const execOk = (command, args) => { calls.push([command, args]); return { code: 0, stdout: '', stderr: '', error: null } }
  assert.deepEqual(await stopPid(555, { platform: WIN, exec: execOk }), { ok: true, code: 0 })
  assert.deepEqual(calls[0], ['taskkill', ['/PID', '555', '/T', '/F']])

  // The process exited between probe and taskkill: nonzero exit, but it is gone.
  const execGone = () => ({ code: 128, stdout: '', stderr: 'not found', error: null })
  assert.equal((await stopPid(555, { platform: WIN, exec: execGone, probe: () => ({ state: 'dead' }) })).ok, true)

  // A real failure must be reported with the reason, and the caller keeps the pidfile.
  const execDenied = () => ({ code: 5, stdout: '', stderr: 'Access is denied.', error: null })
  const failed = await stopPid(555, { platform: WIN, exec: execDenied, probe: () => ({ state: 'alive', commandLine: '' }) })
  assert.equal(failed.ok, false)
  assert.match(String(failed.error), /Access is denied/)
})

test('the absent marker is matched exactly, never as a substring of a command line', async () => {
  const { probePid } = await import('../lib/proc.js')
  const WIN = 'win32'
  const okOut = (stdout) => ({ code: 0, stdout, stderr: '', error: null })
  // A live java process whose own command line quotes the probe marker must stay alive.
  const alive = probePid(11, { platform: WIN, exec: () => okOut('YDS_PROBE_OK:java -Dtag=YDS_PROBE_ABSENT -jar yms.jar') })
  assert.equal(alive.state, 'alive')
  assert.match(alive.commandLine, /YDS_PROBE_ABSENT/)
  // Extra noise around the absent marker is not proof: only the exact output is dead.
  assert.equal(probePid(11, { platform: WIN, exec: () => okOut('YDS_PROBE_ABSENT\nsome warning') }).state, 'unknown')
})

test('probe results are only cached for the real Windows probe', async () => {
  const { probePid, clearProbeCache } = await import('../lib/proc.js')
  const WIN = 'win32'
  let calls = 0
  const exec = () => { calls += 1; return { code: 0, stdout: 'YDS_PROBE_ABSENT', stderr: '', error: null } }
  probePid(4242, { platform: WIN, exec })
  probePid(4242, { platform: WIN, exec })
  assert.equal(calls, 2, 'an injected executor is never cached (tests must see every probe)')
  clearProbeCache(4242)
  assert.equal(typeof clearProbeCache, 'function')
})

test('a forced stop signals through the injected kill and verifies the result', async () => {
  const { stopPid } = await import('../lib/proc.js')
  const POSIX = 'linux'
  const signals = []
  const kill = (pid, sig) => { signals.push([pid, sig]); return { ok: true } }
  // Gone after SIGKILL: success.
  assert.deepEqual(
    await stopPid(777, { force: true, platform: POSIX, kill, probe: () => ({ state: 'dead' }) }),
    { ok: true, code: null },
  )
  assert.deepEqual(signals, [[777, 'SIGKILL']], 'the injected kill is used, not process.kill')

  // SIGKILL did not work (uninterruptible/foreign): report failure instead of claiming it.
  const stubborn = await stopPid(778, { force: true, platform: POSIX, kill, probe: () => ({ state: 'alive', commandLine: '' }) })
  assert.equal(stubborn.ok, false)
  assert.match(String(stubborn.error), /SIGKILL 后进程仍存活/)

  // A kill that fails outright also reports its reason.
  const denied = await stopPid(779, {
    force: true, platform: POSIX, kill: () => ({ ok: false, error: 'operation not permitted' }), probe: () => ({ state: 'alive' }),
  })
  assert.equal(denied.ok, false)
  assert.match(String(denied.error), /not permitted/)
})

test('a graceful stop skips the kill when the injected TERM already succeeded', async () => {
  const { stopPid } = await import('../lib/proc.js')
  const POSIX = 'linux'
  const signals = []
  const kill = (pid, sig) => { signals.push(sig); return { ok: true } }
  const result = await stopPid(780, { platform: POSIX, graceMs: 300, kill, probe: () => ({ state: 'dead' }) })
  assert.deepEqual(result, { ok: true, code: null })
  assert.deepEqual(signals, ['SIGTERM'])
})

test('a detached child is stopped as a process group', async () => {
  const { stopPid } = await import('../lib/proc.js')
  const signals = []
  const kill = (pid, sig) => { signals.push([pid, sig]); return { ok: true } }
  const result = await stopPid(781, { force: true, group: true, platform: 'linux', kill, probe: () => ({ state: 'dead' }) })
  assert.equal(result.ok, true)
  assert.deepEqual(signals, [[-781, 'SIGKILL']], 'the group leader pid is negated')
})
