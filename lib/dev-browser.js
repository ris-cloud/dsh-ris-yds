// A browser this plugin controls, so the dev extension needs no manual install.
//
// The system default browser cannot be given `--load-extension` or a debugging port
// from outside, and a page cannot install an extension at all. So yds launches its
// OWN instance: a private user-data-dir (no touch to the daily profile), the
// generated extension preloaded, and a DevTools port the plugin can talk to
// (`yds browser fix`, CDP `Fetch` injection, the ris-ide open flow).
//
// Values are project-derived where they belong (extension folder), machine-derived
// where they must be (browser binary, profile directory).

import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { connect } from 'node:net'
import { promisify } from 'node:util'

import { connectCdp } from './browser.js'
import { writeDevExtension, extensionStatus } from './dev-extension.js'
import { listenPid, pidIdentity, stopPid } from './proc.js'
import {
  hostOf,
  isWsl,
  materializeExtension,
  posixToWindows,
  projectKey,
  windowsBrowserDirs,
  windowsDefaultBrowser,
  windowsExecutables,
  windowsLocalAppData,
  windowsStopScript,
  windowsUserProfile,
  windowsToPosix,
} from './win-browser.js'

const execFileAsync = promisify(execFile)

/** PowerShell that ships with every Windows install (reachable over interop). */
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** Cookie snapshot file (inside the workspace state dir). */
const COOKIE_FILE = 'browser-cookies.json'

/** Resolve the state dir the same way every other file in this module does. */
function stateDirOf(cfg) {
  const explicit = typeof cfg?.stateDir === 'string' && cfg.stateDir !== '' ? cfg.stateDir : ''
  if (explicit !== '') return explicit
  return join(typeof cfg?.workspace === 'string' && cfg.workspace !== '' ? cfg.workspace : process.cwd(), '.dsh-ris-yds')
}

/** Where the cookie snapshot lives. */
export function cookieSnapshotPath(cfg) {
  return join(stateDirOf(cfg), COOKIE_FILE)
}

/**
 * One background snapshot per DevTools port.
 *
 * A manual login lives in a SESSION cookie (expires=-1): Chrome drops it the moment the
 * window closes, so a crash or a plain window close would log the user out even though
 * the profile itself is persistent. Snapshotting every minute keeps the session cookies
 * recoverable without asking the user to log in again.
 */
const snapshotTimers = new Map()

/**
 * Keep refreshing the cookie snapshot of a running instance (idempotent per port).
 * @param {number} port - DevTools port of OUR instance.
 * @param {string} file - snapshot path.
 * @param {{intervalMs?: number, save?: Function}} [options] - injection points for tests.
 */
export function keepSnapshotFresh(port, file, options = {}) {
  if (snapshotTimers.has(port)) return false
  const save = options.save ?? saveCookies
  const every = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 60_000
  const timer = setInterval(() => {
    // The window may have been closed by the user: stop paying for a dead port.
    void Promise.resolve(save(port, file)).then((count) => {
      if (count === 0) stopSnapshotFresh(port)
    })
  }, every)
  timer.unref?.()
  snapshotTimers.set(port, timer)
  return true
}

/**
 * Stop the background snapshot for one port.
 * @param {number} port - DevTools port.
 */
export function stopSnapshotFresh(port) {
  const timer = snapshotTimers.get(port)
  if (timer === undefined) return
  clearInterval(timer)
  snapshotTimers.delete(port)
}

/** First page target of a live DevTools browser, or undefined. */
async function firstPageTarget(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return Array.isArray(list) ? list.find((tab) => tab?.type === 'page') : undefined
  } catch {
    return undefined
  }
}

/**
 * Remember this browser's cookies so a later launch starts logged in.
 *
 * The workbench login cookie is session-scoped (expires=-1), so closing the browser
 * logs the user out. Saving the set here and restoring it on start makes the private
 * browser behave like a正常 browser that keeps its session.
 * @param {number} port - DevTools port.
 * @param {string} file - snapshot path.
 * @returns {Promise<number>} how many cookies were saved (0 when unavailable).
 */
export async function saveCookies(port, file) {
  const page = await firstPageTarget(port)
  if (page === undefined) return 0
  try {
    const cdp = await connectCdp(page.webSocketDebuggerUrl)
    try {
      await cdp.send('Network.enable', {})
      const { cookies } = await cdp.send('Network.getAllCookies', {})
      if (!Array.isArray(cookies) || cookies.length === 0) return 0
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies }), { mode: 0o600 })
      return cookies.length
    } finally {
      await cdp.close?.()
    }
  } catch {
    return 0
  }
}

/**
 * Reinstate a previously saved cookie set (best effort: the server may have expired it).
 * @param {number} port - DevTools port.
 * @param {string} file - snapshot path from `saveCookies`.
 * @returns {Promise<number>} how many cookies were restored.
 */
export async function restoreCookies(port, file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return 0
  }
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : []
  if (cookies.length === 0) return 0
  const page = await firstPageTarget(port)
  if (page === undefined) return 0
  try {
    const cdp = await connectCdp(page.webSocketDebuggerUrl)
    try {
      await cdp.send('Network.enable', {})
      // Storage.setCookies takes the same shape getAllCookies returned (minus hostOnly).
      const payload = cookies.map((cookie) => {
        const copy = { ...cookie }
        delete copy.hostOnly
        delete copy.session
        return copy
      })
      await cdp.send('Storage.setCookies', { cookies: payload })
      return cookies.length
    } finally {
      await cdp.close?.()
    }
  } catch {
    return 0
  }
}

/** Default DevTools port, the first entry of lib/browser.js DEVTOOLS_PORTS. */
export const DEFAULT_DEBUG_PORT = 9222

/**
 * Environment for the browser process.
 *
 * Chrome on Linux picks its UI language from `LANGUAGE`/`LC_ALL` (gettext), not from
 * `--lang` (that only sets the page Accept-Language). With the usual `LANG=C.UTF-8`
 * the whole window would be English, so the chosen language is exported here.
 * @param {Record<string,string>} env - base environment.
 * @param {string} lang - BCP-47 tag, e.g. `zh-CN`; empty = leave the system setting.
 * @returns {Record<string,string>} environment for spawn.
 */
export function browserEnv(env = process.env, lang = '') {
  const tag = String(lang ?? '').trim()
  if (tag === '') return { ...env }
  const posix = tag.replace(/-/g, '_')
  const next = { ...env, LANGUAGE: posix }
  // Only fill LANG/LC_ALL when the system has no explicit language, so we never
  // override a user's own locale choice.
  const current = String(env.LANG ?? env.LC_ALL ?? '').trim()
  if (current === '' || /^(C|POSIX)(\.|$)/i.test(current)) {
    next.LANG = `${posix}.UTF-8`
    next.LC_ALL = `${posix}.UTF-8`
  }
  return next
}

/**
 * Where the private browser profile lives (one per machine, shared by workspaces).
 *
 * A WINDOWS-hosted browser needs a Windows path, so it keeps its profile in
 * `%LOCALAPPDATA%\dsh-ris-yds\machine\browser-profile`; the WSL one keeps the old
 * `~/.dsh-ris-yds/browser-profile`. `YDS_BROWSER_PROFILE` overrides both verbatim.
 * @param {Record<string,string>} [env] - environment.
 * @param {'linux'|'windows'} [host] - which side of WSL the browser runs on.
 * @returns {string} profile directory.
 */
export function browserProfileDir(env = process.env, host = 'linux') {
  const override = String(env.YDS_BROWSER_PROFILE ?? '').trim()
  if (override !== '') return override
  if (host === 'windows') {
    const dirs = windowsBrowserDirs({ env, key: 'machine' })
    if (dirs !== null) return dirs.profile
  }
  return join(homedir(), '.dsh-ris-yds', 'browser-profile')
}

/** Candidate browser binaries for the current platform, most-specific first. */
function candidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env.LOCALAPPDATA ?? ''
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(localAppData === '' ? [] : [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ]
  }
  return [
    // A user-level Chrome install (no root needed) wins: it is the real browser, while
    // /usr/bin/chromium is usually a Playwright "Chrome for Testing" build, which paints
    // a "Download Chrome" banner across the top of the window.
    join(homedir(), '.local', 'opt', 'google-chrome', 'opt', 'google', 'chrome', 'chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
  ]
}

/**
 * Linux browsers ordered so the ones that still honour `--load-extension` come first.
 *
 * Branded Chrome on Linux (137+) prints "… is not allowed in Google Chrome, ignoring."
 * and starts WITHOUT the extension, which silently breaks injection; Chromium and
 * Chrome-for-Testing builds keep working. On WSL, `~/.local/bin/chromium` is usually
 * the `Chrome for Testing` build, so it sits near the top here.
 * @param {Record<string,string>} [env] - environment.
 * @returns {string[]} candidate paths.
 */
function linuxCandidates(env = process.env) {
  const home = homedir()
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    join(home, '.local', 'bin', 'chromium'),
    join(home, '.local', 'bin', 'google-chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    join(home, '.local', 'opt', 'google-chrome', 'opt', 'google', 'chrome', 'chrome'),
    '/usr/bin/microsoft-edge',
  ]
}

/**
 * Every browser this machine could drive, best first.
 *
 * On WSL the order is: `YDS_BROWSER_PATH` -> the project's `yds.chromePath` (YonCode's
 * Chrome — the one that can load an unpacked extension) -> the Windows default browser
 * -> YonCode's bundled Chrome -> Windows Chrome -> Windows Edge -> Linux
 * Chromium/Chrome-for-Testing -> Linux branded Chrome. Elsewhere the platform order is
 * unchanged. An explicit override is a decision: it is returned alone, never padded
 * with guesses.
 * @param {{platform?: string, env?: Record<string, string>, exists?: (path: string) => boolean, chromePath?: string, defaultBrowser?: {id: string} | null, run?: Function}} [options] - injection points for tests.
 * @returns {Array<{path: string, name: string, source: string, host: 'linux'|'windows'}>} candidates in preference order.
 */
export function resolveBrowserCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  // Symlinks are common (playwright/brew/apt wrappers): the process command line shows
  // the REAL file, so record the canonical path or the stop-path identity check fails.
  const realpath = options.realpath ?? ((path) => realpathSync(path))
  const canonical = (path) => {
    try {
      return realpath(path)
    } catch {
      return path
    }
  }
  const out = []
  const seen = new Set()
  const add = (path, source) => {
    if (typeof path !== 'string' || path === '') return false
    const real = canonical(path)
    if (seen.has(real) || !exists(real)) return false
    seen.add(real)
    out.push({ path: real, name: basename(real), source, host: hostOf(real) })
    return true
  }
  const explicit = String(env.YDS_BROWSER_PATH ?? env['browser.path'] ?? '').trim()
  if (explicit !== '') {
    add(platform === 'win32' ? explicit : windowsToPosix(explicit), 'YDS_BROWSER_PATH')
    return out
  }
  const configured = windowsToPosix(options.chromePath ?? '')
  if (configured !== '') add(configured, 'yds.chromePath')
  if (platform === 'linux' && isWsl(env)) {
    const run = options.run
    const preferred = options.defaultBrowser !== undefined
      ? options.defaultBrowser
      : windowsDefaultBrowser({ env, ...(run === undefined ? {} : { run }) })
    if (preferred !== null) {
      // The ProgId's own open command first: it is the browser the user actually uses,
      // even when that is a fork this module has no path table for (Helium, Vivaldi).
      const label = `windows-default:${preferred.progId ?? preferred.id}`
      const resolved = windowsToPosix(preferred.exe ?? '')
      if (resolved === '' || !add(resolved, label)) {
        for (const exe of windowsExecutables(preferred.id)) if (add(exe, label)) break
      }
    }
    // No hard-coded YonCode bundle here: that browser IS what `yds.chromePath` points at
    // in a YonCode project, so guessing its install path only makes the fallback order
    // resurrect it after the user deliberately removed the setting (m00805).
    for (const exe of windowsExecutables('chrome')) if (add(exe, 'windows-chrome')) break
    for (const exe of windowsExecutables('edge')) if (add(exe, 'windows-edge')) break
    const local = windowsLocalAppData(env)
    if (local !== '') add(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'windows-chrome')
    for (const candidate of linuxCandidates(env)) add(candidate, 'linux-extension-safe')
    return out
  }
  for (const candidate of candidates({ platform, env })) add(candidate, 'platform')
  // Last resort: a browser on PATH that this platform usually exposes under these names.
  const pathEntries = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const names = platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge']
  for (const dir of pathEntries) {
    for (const name of names) add(join(dir, name), 'PATH')
  }
  return out
}

/**
 * Which browser this machine can drive (the best single answer).
 *
 * Kept for callers that need one: `resolveBrowserCandidates` is the full fallback
 * order, and `startDebugBrowser` walks it when a browser starts without the extension.
 * @param {{platform?: string, env?: Record<string, string>, exists?: (path: string) => boolean, chromePath?: string}} [options] - injection points for tests.
 * @returns {{path: string, name: string, source: string, host: 'linux'|'windows'} | null} the binary, or null.
 */
export function resolveBrowserBinary(options = {}) {
  return resolveBrowserCandidates(options)[0] ?? null
}

/**
 * The arguments for the private instance.
 *
 * Kept pure so the flags (and their order) are testable: the profile must come
 * before the URL, and the extension must be loaded for the session to be useful.
 * @param {{profile: string, extensionDir: string, port: number, url: string, extraArgs?: string[]}} options - launch inputs.
 * @returns {string[]} argv (without the binary).
 */
export function buildLaunchArgs({ profile, extensionDir, port, url, lang = 'zh-CN', extraArgs = [] }) {
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    // The workbench is a Chinese enterprise UI; without this a non-Chinese system locale
    // renders the whole browser chrome (menus, infobar buttons) in English.
    ...(lang === '' ? [] : [`--lang=${lang}`]),
  ]
  for (const extra of extraArgs) args.push(String(extra))
  args.push(url)
  return args
}

/** Is something already accepting connections on this port? */
/**
 * Open a URL as a new tab in a live DevTools browser (PUT /json/new).
 *
 * Used when the debug browser is already up: clicking 🌐 again must show the page,
 * not silently reuse a window that is sitting on some other tab.
 * @param {number} port - DevTools port.
 * @param {string} url - page to open.
 * @returns {Promise<boolean>} true when the browser accepted the tab.
 */
export async function openNewTab(port, url) {
  if (typeof url !== 'string' || url === '' || url === 'about:blank') return false
  try {
    // Already open? Focus it instead of piling up tabs on repeated clicks.
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const hit = Array.isArray(list)
      ? list.find((tab) => tab?.type === 'page' && typeof tab.url === 'string' && tab.url === url)
      : undefined
    if (hit !== undefined) {
      const activated = await fetch(`http://127.0.0.1:${port}/json/activate/${hit.id}`)
      return activated.ok
    }
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    return response.ok
  } catch {
    return false
  }
}

export function portOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Poll until the DevTools port answers (the browser was already up: no spawn). */
async function waitPortOpen(port, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * The profile and extension arguments for one side of WSL.
 *
 * A Windows browser must be given Windows paths (`C:\…`) or it silently starts with
 * a temporary profile and no extension at all.
 * @param {'linux'|'windows'} side - where the browser runs.
 * @param {string} profile - POSIX profile dir.
 * @param {string} extensionDir - POSIX extension dir.
 * @returns {{profile: string, extension: string, ok: boolean}} argv paths.
 */
export function launchPaths(side, profile, extensionDir) {
  if (side !== 'windows') {
    return { profile: String(profile ?? ''), extension: String(extensionDir ?? ''), ok: profile !== '' && extensionDir !== '' }
  }
  const profileWin = posixToWindows(profile)
  const extensionWin = posixToWindows(extensionDir)
  return { profile: profileWin, extension: extensionWin, ok: profileWin !== '' && extensionWin !== '' }
}

/**
 * Did this browser refuse `--load-extension`? Read its stderr (the only witness).
 * @param {string} file - stderr capture path.
 * @returns {boolean} true when Chrome said it ignores the flag.
 */
function extensionRefused(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return /--load-extension is not allowed|is not allowed in Google Chrome|--load-extension is not supported/i.test(text)
  } catch {
    return false
  }
}

/**
 * Is the dev extension's service worker visible on the DevTools port?
 *
 * The SW runs on demand, so an absent target means "not started yet", not "missing";
 * this is reported (never used to reject a browser) because the stderr signal is the
 * authoritative refusal check.
 * @param {number} port - DevTools port.
 * @param {number} [budgetMs] - how long to look.
 * @returns {Promise<boolean>} true when a `…/sw.js` service worker is listed.
 */
async function waitServiceWorker(port, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (Array.isArray(list) && list.some((target) => target?.type === 'service_worker'
        && typeof target.url === 'string' && /\/sw\.js$/.test(target.url))) return true
    } catch {
      // Port not answering yet: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/** Wait until a just-killed browser releases the DevTools port. */
async function waitPortClosed(port, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * Stop the browser a candidate launch produced (never a browser we did not start).
 * @param {'linux'|'windows'} side - which side it runs on.
 * @param {import('node:child_process').ChildProcess} child - the spawned process.
 * @param {number} port - DevTools port to wait on.
 * @param {string} profile - POSIX profile path (identifies the Windows instance).
 */
async function stopAttempt(side, child, port, profile) {
  if (side === 'windows') {
    const winProfile = posixToWindows(profile)
    if (winProfile !== '') {
      try {
        await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', windowsStopScript(winProfile)], { timeout: 20000 })
      } catch {
        // Nothing to kill is fine: fall through to the port wait.
      }
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  await waitPortClosed(port)
}

/** Pidfile for the launched instance (one per workspace). */
function pidFile(cfg) {
  return join(cfg?.stateDir ?? join(process.cwd(), '.dsh-ris-yds'), 'browser.pid')
}

/**
 * Launch (or reuse) the private debugging browser.
 *
 * Reuses an instance already listening on the port, so calling it twice does not
 * open two windows. The extension folder is generated on demand, so a fresh
 * checkout needs no separate step.
 * @param {object} cfg - resolved yds config (workspace/stateDir).
 * @param {{url?: string, port?: number, binary?: string, profile?: string, waitMs?: number, extraArgs?: string[], env?: Record<string,string>}} [options] - overrides.
 * @returns {Promise<{ok: boolean, reason?: string, pid?: number, port?: number, profile?: string, extension?: string, url?: string, binary?: string, reused?: boolean}>} result.
 */
export async function startDebugBrowser(cfg, options = {}) {
  const env = options.env ?? process.env
  const port = Number.isInteger(options.port) && options.port > 0 ? options.port : DEFAULT_DEBUG_PORT
  const workspace = typeof cfg?.workspace === 'string' ? cfg.workspace : ''
  if (workspace === '') return { ok: false, reason: '缺少 workspace' }
  const url = typeof options.url === 'string' && options.url !== ''
    ? options.url
    : (typeof cfg?.workbenchUrl === 'string' ? cfg.workbenchUrl : 'about:blank')
  // A browser is already listening on the DevTools port (ours from a previous click,
  // or YonCode's own): reuse it instead of launching a second profile. This is what
  // makes repeated 🌐 clicks land in the same logged-in window.
  if (await portOpen(port)) {
    // Refresh the session snapshot while the window is up (login happens after launch),
    // and keep refreshing it: the login cookie is session-scoped.
    void saveCookies(port, cookieSnapshotPath(cfg))
    keepSnapshotFresh(port, cookieSnapshotPath(cfg))
    const listener = await listenPid(port)
    const openedTab = options.openTab === false ? false : await openNewTab(port, url)
    const status = extensionStatus(cfg, {})
    return {
      ok: true,
      reused: true,
      port,
      pid: Number(listener?.pid) > 0 ? listener.pid : undefined,
      profile: options.profile ?? browserProfileDir(env),
      extension: status.exists === true ? status.dir : undefined,
      url,
      openedTab,
    }
  }
  let extension = extensionStatus(cfg, {})
  if (extension.exists !== true) {
    writeDevExtension(cfg, {})
    extension = extensionStatus(cfg, {})
    if (extension.exists !== true) return { ok: false, reason: '扩展目录生成失败' }
  }
  const sourceExtension = extension.dir
  const binaries = typeof options.binary === 'string' && options.binary !== ''
    ? [{ path: options.binary, name: basename(options.binary), source: 'options', host: hostOf(options.binary) }]
    : resolveBrowserCandidates({ env, ...(typeof cfg?.chromePath === 'string' && cfg.chromePath !== '' ? { chromePath: cfg.chromePath } : {}) })
  if (binaries.length === 0) {
    return { ok: false, reason: '未找到 Chrome/Edge（可用环境变量 YDS_BROWSER_PATH 或项目配置 yds.chromePath 指定浏览器可执行文件）' }
  }
  const lang = options.lang ?? (String(env.YDS_BROWSER_LANG ?? '').trim() || 'zh-CN')
  // With a snapshot on disk, start blank and put the session back before the first
  // navigation; otherwise a redirect to the login page would win the race.
  const snapshot = cookieSnapshotPath(cfg)
  const restoreOnStart = existsSync(snapshot)
  const waitMs = Number.isInteger(options.waitMs) ? options.waitMs : 15000
  const attempts = []
  for (const binary of binaries) {
    const side = binary.host === 'windows' ? 'windows' : 'linux'
    const profile = options.profile ?? browserProfileDir(env, side)
    let extensionDir = sourceExtension
    if (side === 'windows') {
      // Chrome cannot read /home/…, and \\wsl$\… is slow and flaky: the extension (a
      // few small files) is copied next to the profile in %LOCALAPPDATA% instead.
      const dirs = windowsBrowserDirs({ env, key: projectKey(cfg?.projectDir ?? workspace) })
      if (dirs === null) return { ok: false, reason: '无法定位 Windows 用户目录（%LOCALAPPDATA%）' }
      try {
        mkdirSync(dirs.profile, { recursive: true })
        if (!materializeExtension(sourceExtension, dirs.extension)) {
          attempts.push(`${binary.name}: 扩展目录复制到 Windows 失败`)
          continue
        }
      } catch (error) {
        // Locked folder, missing drive: this browser cannot be used, try the next one.
        attempts.push(`${binary.name}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      extensionDir = dirs.extension
    } else {
      mkdirSync(profile, { recursive: true })
    }
    const paths = launchPaths(side, profile, extensionDir)
    if (paths.ok !== true) {
      attempts.push(`${binary.name}: 路径无法转换成 Windows 形式`)
      continue
    }
    const args = buildLaunchArgs({
      profile: paths.profile,
      extensionDir: paths.extension,
      port,
      url: restoreOnStart ? 'about:blank' : url,
      lang,
      extraArgs: options.extraArgs,
    })
    // stderr is the only witness when Chrome refuses the extension: it prints
    // "--load-extension is not allowed in Google Chrome, ignoring." and starts
    // without it, on an otherwise perfectly healthy DevTools port.
    const stderrFile = join(stateDirOf(cfg), `browser-${side}.log`)
    mkdirSync(stateDirOf(cfg), { recursive: true })
    const child = spawn(binary.path, args, {
      detached: true,
      stdio: ['ignore', 'ignore', openSync(stderrFile, 'w')],
      env: browserEnv(env, lang),
    })
    child.unref()
    const opened = await waitPortOpen(port, waitMs)
    const refused = opened === true ? extensionRefused(stderrFile) : false
    if (opened === true && refused === false) {
      if (restoreOnStart) {
        await restoreCookies(port, snapshot)
        await openNewTab(port, url)
      }
      keepSnapshotFresh(port, cookieSnapshotPath(cfg))
      const extensionLoaded = await waitServiceWorker(port)
      mkdirSync(join(cfg?.stateDir ?? join(workspace, '.dsh-ris-yds')), { recursive: true })
      writeFileSync(pidFile(cfg), `${JSON.stringify({
        pid: child.pid ?? 0, port, profile, extension: extensionDir, binary: binary.path, host: side,
        source: binary.source, extensionLoaded, startedAt: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      return {
        ok: true, pid: child.pid, port, profile, extension: extensionDir, url, binary: binary.path,
        host: side, source: binary.source, extensionLoaded,
      }
    }
    // Unusable for injection: stop it before the next candidate, or two windows pile
    // up and the DevTools port stays taken by the one we just rejected.
    await stopAttempt(side, child, port, profile)
    attempts.push(opened !== true
      ? `${binary.name}: DevTools 端口 ${port} 未就绪`
      : `${binary.name}: 已拒绝加载扩展（Chrome 137+ 忽略 --load-extension）`)
  }
  return {
    ok: false,
    reason: `没有可用的浏览器：${attempts.join('；')}`,
    attempts,
    tried: binaries.map((binary) => binary.path),
  }
}

/** Read the instance record, if any (a bare pid from older versions is still read). */
export function readBrowserRecord(cfg) {
  const file = pidFile(cfg)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed != null && typeof parsed === 'object' ? parsed : null
  } catch {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? { pid } : null
  }
}

/**
 * Stop the instance this module launched (never another browser).
 *
 * Identity matters: the pidfile is only trusted when /proc says the process command
 * line contains the binary we launched; a stale/foreign pid is dropped or refused
 * instead of killed.
 * @param {object} cfg - resolved yds config.
 * @returns {{stopped: boolean, pid?: number, reason?: string}} result.
 */
export async function stopDebugBrowser(cfg) {
  const record = readBrowserRecord(cfg)
  const file = pidFile(cfg)
  if (record == null) {
    const listener = listenPid(DEFAULT_DEBUG_PORT)
    const detected = Number(listener?.pid) > 0 ? listener.pid : undefined
    if (detected !== undefined) {
      return { stopped: false, pid: detected, reason: '端口上有一个不是本插件启动的浏览器实例，未停止' }
    }
    return { stopped: false, reason: '未运行（没有 pidfile）' }
  }
  // A Windows-hosted browser has no Linux pid to check: it is identified by the
  // private --user-data-dir we gave it, and stopped through PowerShell.
  if (record.host === 'windows') {
    const pid = Number(record.pid)
    stopSnapshotFresh(Number(record.port) > 0 ? Number(record.port) : DEFAULT_DEBUG_PORT)
    await saveCookies(Number(record.port) > 0 ? Number(record.port) : DEFAULT_DEBUG_PORT, cookieSnapshotPath(cfg))
    const winProfile = posixToWindows(String(record.profile ?? ''))
    if (winProfile === '') return { stopped: false, pid, reason: 'Windows 实例的 profile 路径无法转换成 Windows 形式' }
    try {
      const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', windowsStopScript(winProfile)], { timeout: 30000 })
      if (!/stopped/.test(String(stdout))) return { stopped: false, pid, reason: '没有找到该实例的 Windows 进程（可能已退出）' }
      rmSync(file, { force: true })
      return { stopped: true, pid }
    } catch (error) {
      return { stopped: false, pid, reason: `停止失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const pid = Number(record.pid)
  const markers = typeof record.binary === 'string' && record.binary !== '' ? [basename(record.binary)] : []
  const identity = Number.isInteger(pid) && pid > 0 ? pidIdentity(pid, markers) : { state: 'dead' }
  if (identity.state === 'dead') {
    rmSync(file, { force: true })
    return { stopped: false, reason: 'pidfile 指向的进程已不存在，已清理' }
  }
  if (identity.state !== 'ours') {
    return { stopped: false, pid, reason: `pid ${pid} 不是本插件启动的浏览器（${identity.state}），未停止` }
  }
  // Keep the login: session cookies die with the browser, so snapshot them first.
  stopSnapshotFresh(Number(record.port) > 0 ? Number(record.port) : DEFAULT_DEBUG_PORT)
  await saveCookies(Number(record.port) > 0 ? Number(record.port) : DEFAULT_DEBUG_PORT, cookieSnapshotPath(cfg))
  // stopPid reports { ok, code, error } — read the flag, do not compare the object to true.
  const result = await stopPid(pid, { graceMs: 5000 })
  if (result?.ok !== true) {
    return { stopped: false, pid, reason: `停止失败${result?.error ? `：${result.error}` : ''}` }
  }
  rmSync(file, { force: true })
  return { stopped: true, pid }
}

/** Status of the private browser: profile, extension folder, port. */
export function debugBrowserStatus(cfg, options = {}) {
  // listenPid reports { pid, source|reason }; treat a missing/foreign answer as "not running".
  const listen = options.listen ?? listenPid
  const recorded = readBrowserRecord(cfg)
  const port = Number.isInteger(options.port) && options.port > 0
    ? options.port
    : (Number(recorded?.port) > 0 ? Number(recorded.port) : DEFAULT_DEBUG_PORT)
  const side = recorded?.host === 'windows' ? 'windows' : 'linux'
  const profile = typeof recorded?.profile === 'string' && recorded.profile !== ''
    ? recorded.profile
    : browserProfileDir(options.env ?? process.env, side)
  const extension = extensionStatus(cfg, {})
  const listener = listen(port)
  const pid = Number(listener?.pid) > 0 ? listener.pid : undefined
  return {
    ok: true,
    running: pid !== undefined,
    pid,
    port,
    profile,
    profileExists: existsSync(profile),
    extensionDir: extension.dir,
    extensionExists: extension.exists,
    host: side,
    binary: typeof recorded?.binary === 'string' ? recorded.binary : undefined,
    extensionLoaded: recorded?.extensionLoaded === true,
    loadUrl: `http://127.0.0.1:${port}/json/version`,
  }
}
