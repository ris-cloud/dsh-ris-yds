// Cross-platform process helpers.
//
// The Linux implementations read /proc/<pid>/cmdline to prove a pidfile still
// points at OUR process; Windows has no /proc, so the same check must come from
// the Win32 process table (PowerShell CIM). Without this, `yds status` reported
// "not running" on Windows, `yds start` spawned a second YMS and `yds stop`
// could never find the forwarder (review: Windows P0).
//
// Identity checks are THREE-valued on purpose (review D-P1-6): "ours", "gone" and
// "could not tell". Collapsing "could not tell" into "not ours" deleted the pidfile
// after a transient PowerShell/EPERM failure, which is exactly how a second YMS got
// started on top of a live one. Callers must only act destructively on `dead`, only
// signal on `ours`, and keep the pidfile when the answer is `unknown`.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DEFAULT_PLATFORM = process.platform
const WINDOWS_PROBE_OK = 'YDS_PROBE_OK'
const WINDOWS_PROBE_ABSENT = 'YDS_PROBE_ABSENT'

// One PowerShell per identity check costs ~0.5 s on Windows, and `yds status` /
// `yds start` run several checks back to back (pidfile + forwarder). Keep the answers
// for a few seconds so those paths do not spawn four processes (review D-P2-3). The
// cache is only used on the real Windows probe (injected executors stay uncached so
// tests remain deterministic) and `stopPid` invalidates it before/after the kill.
const WINDOWS_PROBE_CACHE_MS = 5000
const WINDOWS_PROBE_CACHE_MAX = 200
const windowsProbeCache = new Map()

/** Forget a cached probe (a stop is authoritative; never answer from before it). */
export function clearProbeCache(pid) {
  const value = Number(pid)
  if (Number.isInteger(value) && value > 0) windowsProbeCache.delete(`win32:${value}`)
}


/**
 * Run a command once and report everything the caller may need: exit code, both
 * streams and the spawn error. Swallowing the exit code made `taskkill` failures
 * look like successes (review D-P1-7).
 * @returns {{code: number|null, stdout: string, stderr: string, error: Error|null}}
 */
export function runCommand(command, args, timeout = 8000) {
  try {
    const out = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true })
    return {
      code: Number.isInteger(out.status) ? out.status : null,
      stdout: String(out.stdout ?? ''),
      stderr: String(out.stderr ?? ''),
      error: out.error ?? null,
    }
  } catch (error) {
    return { code: null, stdout: '', stderr: '', error }
  }
}

/**
 * The PowerShell argument list used to read a pid's command line. Kept separate so a
 * test can assert the WQL quoting without spawning Windows.
 *
 * The pid is the only interpolated value and is validated as a positive integer by
 * `probePid`, so it cannot inject anything. The WQL predicate is single-quoted: the
 * old form embedded double quotes inside `-Command`, which only survived because of
 * one specific argument-quoting rule on Windows (review D-P2).
 */
export function windowsProbeArgs(pid) {
  const value = Number(pid)
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${value}'`,
    `if ($null -eq $p) { '${WINDOWS_PROBE_ABSENT}' } else { '${WINDOWS_PROBE_OK}:' + $p.CommandLine }`,
  ].join('; ')
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

function parseWindowsProbe(result) {
  // Spawn failure/timeout: we cannot tell whether the pid exists.
  if (result?.error !== null && result?.error !== undefined) return { state: 'unknown', commandLine: '' }
  const text = String(result?.stdout ?? '').trim()
  const marker = `${WINDOWS_PROBE_OK}:`
  // The command line is echoed verbatim after the OK marker, so the absent marker
  // must be matched as the WHOLE output: `includes` used to call a live process dead
  // when its own command line contained the marker string (review D-P2-2).
  if (text === WINDOWS_PROBE_ABSENT) return { state: 'dead', commandLine: '' }
  const at = text.indexOf(marker)
  if (at !== -1) return { state: 'alive', commandLine: text.slice(at + marker.length).trim() }
  // Empty output with a non-zero exit code is a permission/availability failure,
  // NOT proof that the process is gone. Keep it unknown.
  return { state: 'unknown', commandLine: '' }
}

/** Default POSIX liveness probe: EPERM means the pid exists but is not ours. */
export function signalState(pid) {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead'
    if (error?.code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

/**
 * Identify a pid: `state` is `alive`, `dead` or `unknown`, plus its command line when
 * it can be read. Everything else (pidfiles, markers, stop) is built on this.
 * @param {number} pid - process id.
 * @param {{platform?: NodeJS.Platform, exec?: Function, signal?: Function,
 *          commandLine?: Function}} [options] - injectable for tests.
 * @returns {{state: 'alive'|'dead'|'unknown', commandLine: string}}
 */
export function probePid(pid, { platform = DEFAULT_PLATFORM, exec = runCommand, signal = signalState, commandLine = null } = {}) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return { state: 'dead', commandLine: '' }
  if (platform === 'win32') {
    // Cached only for the real probe: tests inject `exec` and must see every call.
    const cacheable = exec === runCommand
    const cacheKey = `win32:${value}`
    if (cacheable) {
      const hit = windowsProbeCache.get(cacheKey)
      if (hit !== undefined && Date.now() - hit.at <= WINDOWS_PROBE_CACHE_MS) {
        return { state: hit.state, commandLine: hit.commandLine }
      }
    }
    const probe = parseWindowsProbe(exec('powershell.exe', windowsProbeArgs(value), 8000))
    if (cacheable) {
      if (windowsProbeCache.size >= WINDOWS_PROBE_CACHE_MAX) windowsProbeCache.clear()
      windowsProbeCache.set(cacheKey, { at: Date.now(), state: probe.state, commandLine: probe.commandLine })
    }
    return probe
  }
  const state = signal(value)
  if (state === 'dead') return { state: 'dead', commandLine: '' }
  if (state !== 'alive') return { state: 'unknown', commandLine: '' }
  let line = ''
  if (typeof commandLine === 'function') {
    line = String(commandLine(value) ?? '').trim()
  } else {
    try { line = readFileSync(`/proc/${value}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch { line = '' }
  }
  return { state: 'alive', commandLine: line }
}

/**
 * The full command line of a live process, or '' when it cannot be read.
 * Windows: one CIM query per call (~0.5 s); Linux/WSL: /proc.
 * @param {number} pid - process id.
 * @returns {string} NUL/space-joined command line.
 */
export function processCommandLine(pid, options = {}) {
  return probePid(pid, options).commandLine
}

/** Is the pid alive? `false` also covers "could not tell" — use probePid for a
 *  three-valued answer. */
export function pidAlive(pid, options = {}) {
  return probePid(pid, options).state === 'alive'
}

/**
 * Which of OUR processes a pid belongs to, without ever confusing "unreadable" with
 * "not ours":
 *   - `ours`    - alive and its command line contains one of the markers
 *   - `foreign` - alive, command line readable, marker absent (pid was reused or the
 *                 pidfile is stale; safe to unlink the pidfile)
 *   - `dead`    - definitely gone
 *   - `unknown` - could not probe / could not read the command line: keep the pidfile
 * @returns {{state: 'ours'|'foreign'|'dead'|'unknown', commandLine: string}}
 */
export function pidIdentity(pid, markers, options = {}) {
  const list = (Array.isArray(markers) ? markers : [markers]).filter((marker) => typeof marker === 'string' && marker !== '')
  const probe = probePid(pid, options)
  if (probe.state === 'dead') return { state: 'dead', commandLine: '' }
  if (probe.state === 'unknown') return { state: 'unknown', commandLine: probe.commandLine }
  if (probe.commandLine === '') return { state: 'unknown', commandLine: '' }
  return {
    state: list.some((marker) => probe.commandLine.includes(marker)) ? 'ours' : 'foreign',
    commandLine: probe.commandLine,
  }
}

/** Default POSIX kill used by `stopPid`; injectable so the signal path is testable. */
function defaultKill(pid, sig) {
  try {
    process.kill(pid, sig)
    return { ok: true }
  } catch (error) {
    // Already gone is success for a stop request.
    if (error?.code === 'ESRCH') return { ok: true }
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Stop a process, preferring a clean signal. Windows has no SIGTERM: use
 * `taskkill /T /F` so the whole tree (java + helpers) goes away and the pidfile
 * cannot be left pointing at an orphan.
 *
 * The result is REPORTED, not assumed: callers must only unlink the pidfile (and
 * tell the user "stopped") when `ok === true` (review D-P1-7).
 * @param {number} pid - process id.
 * @param {{force?: boolean, graceMs?: number, platform?: NodeJS.Platform,
 *          exec?: Function, signal?: Function, probe?: Function,
 *          kill?: (pid: number, sig: string) => {ok: boolean, error?: string},
 *          group?: boolean}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, error?: string}>}
 */
export async function stopPid(pid, {
  force = false,
  graceMs = 30000,
  platform = DEFAULT_PLATFORM,
  exec = runCommand,
  signal = signalState,
  probe = probePid,
  kill = defaultKill,
  group = false,
} = {}) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return { ok: false, code: null, error: 'invalid pid' }
  if (platform === 'win32') {
    // A stop invalidates every cached answer: the pre-kill state must not leak into
    // the post-kill verification below.
    clearProbeCache(value)
    const result = exec('taskkill', ['/PID', String(value), '/T', '/F'], 30000)
    clearProbeCache(value)
    if (result?.code === 0) return { ok: true, code: 0 }
    // taskkill also fails when the process exited between probe and kill: that is
    // success for our purposes, so verify instead of trusting the message.
    const after = probe(value, { platform, exec, signal })
    if (after.state === 'dead') return { ok: true, code: result?.code ?? null }
    return {
      ok: false,
      code: result?.code ?? null,
      error: String(result?.stderr ?? '').trim() || `taskkill exited with ${String(result?.code ?? 'no status')}`,
    }
  }
  // A detached child (YMS) is its own group leader: signalling -pid also stops the
  // helpers it spawned. Windows does the same via `taskkill /T`.
  const target = group ? -value : value
  if (force) {
    const killed = kill(target, 'SIGKILL')
    if (killed.ok !== true) return { ok: false, code: null, error: killed.error }
    // SIGKILL is not instantly observable: verify instead of claiming success.
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (probe(value, { platform, exec, signal }).state === 'dead') return { ok: true, code: null }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return { ok: false, code: null, error: 'SIGKILL 后进程仍存活' }
  }
  const term = kill(target, 'SIGTERM')
  if (term.ok !== true) return { ok: false, code: null, error: term.error }
  const deadline = Date.now() + Math.max(0, Number(graceMs) || 0)
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (probe(value, { platform, exec, signal }).state === 'dead') return { ok: true, code: null }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const killed = kill(target, 'SIGKILL')
  if (killed.ok !== true) return { ok: false, code: null, error: killed.error }
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (probe(value, { platform, exec, signal }).state === 'dead') return { ok: true, code: null }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { ok: false, code: null, error: 'SIGKILL 后进程仍存活' }
}

// ---------------------------------------------------------------------------
// Who owns a listening port. Needed when the pidfile is gone but a YMS is still
// up (e.g. the foreground CLI unlinked it on exit): without this, `yds start`
// spawned a second Liberty that died with CWWKE0029E and the live instance stayed
// unmanaged (restart support).
// ---------------------------------------------------------------------------

/** Parse `ss -H -lntp 'sport = :PORT'`: the first `pid=N` on a LISTEN row. */
export function parseSsListenPid(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    if (!/\bLISTEN\b/.test(line)) continue
    const match = /pid=(\d+)/.exec(line)
    if (match !== null) return { pid: Number(match[1]), source: 'ss' }
  }
  return { pid: null, source: 'ss', reason: 'ss 输出里没有 pid（权限不足或格式不同）' }
}

/** Parse `lsof -t` output: one pid per line. */
export function parseLsofPid(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    const pid = Number(line.trim())
    if (Number.isInteger(pid) && pid > 0) return { pid, source: 'lsof' }
  }
  return { pid: null, source: 'lsof', reason: 'lsof 没有返回 pid' }
}

/** Parse Windows `netstat -ano -p TCP` for the LISTENING row of `port`. */
export function parseNetstatListenPid(stdout, port) {
  const wanted = Number(port)
  for (const line of String(stdout ?? '').split('\n')) {
    if (!/LISTENING/i.test(line)) continue
    const cols = line.trim().split(/\s+/)
    // Proto  Local Address  Foreign Address  State  PID
    if (cols.length < 5) continue
    const local = cols[1]
    const localPort = Number(local.slice(local.lastIndexOf(':') + 1))
    if (localPort !== wanted) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid > 0) return { pid, source: 'netstat' }
  }
  return { pid: null, source: 'netstat', reason: `netstat 里没有端口 ${wanted} 的监听 pid` }
}

/**
 * Best-effort owner of a listening TCP port.
 * @param {number} port
 * @param {{platform?: NodeJS.Platform, exec?: Function}} [options] - injectable for tests.
 * @returns {{pid: number|null, source?: string, reason?: string}}
 */
export function listenPid(port, { platform = DEFAULT_PLATFORM, exec = runCommand } = {}) {
  const value = Number(port)
  if (!Number.isInteger(value) || value <= 0) return { pid: null, reason: `非法端口: ${port}` }
  if (platform === 'win32') {
    const res = exec('netstat', ['-ano', '-p', 'TCP'], 8000)
    if (String(res.stdout ?? '').trim() === '' && res.code !== 0) {
      return { pid: null, reason: `netstat 失败: ${res.error?.message ?? res.code}` }
    }
    return parseNetstatListenPid(res.stdout, value)
  }
  if (platform === 'darwin') {
    return parseLsofPid(exec('lsof', ['-nP', `-iTCP:${value}`, '-sTCP:LISTEN', '-t'], 8000).stdout)
  }
  // linux: ss is usually present and cheaper; lsof is the fallback when ss cannot
  // show the pid (or the box has no ss).
  const ss = exec('ss', ['-H', '-lntp', `sport = :${value}`], 8000)
  if (ss.code === 0 && /LISTEN/.test(String(ss.stdout ?? ''))) {
    const parsed = parseSsListenPid(ss.stdout)
    if (parsed.pid !== null) return parsed
  }
  const lsof = parseLsofPid(exec('lsof', ['-nP', `-iTCP:${value}`, '-sTCP:LISTEN', '-t'], 8000).stdout)
  if (lsof.pid !== null) return lsof
  return { pid: null, reason: `无法确定端口 ${value} 的监听进程（ss/lsof 均未返回 pid）` }
}
