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

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'

import { connectCdp } from './browser.js'
import { writeDevExtension, extensionStatus } from './dev-extension.js'
import { listenPid, pidIdentity, stopPid } from './proc.js'

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

/** Where the private browser profile lives (one per machine, shared by workspaces). */
export function browserProfileDir(env = process.env) {
  const override = String(env.YDS_BROWSER_PROFILE ?? '').trim()
  if (override !== '') return override
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
 * Which browser this machine can drive.
 *
 * Explicit beats guessed: `YDS_BROWSER_PATH` (or project `.env` `browser.path`) is
 * honoured verbatim, then the platform candidates, then every `$PATH` entry.
 * @param {{platform?: string, env?: Record<string, string>, exists?: (path: string) => boolean}} [options] - injection points for tests.
 * @returns {{path: string, name: string, source: string} | null} the binary, or null.
 */
export function resolveBrowserBinary(options = {}) {
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
  const found = (path, source) => {
    const real = canonical(path)
    return { path: real, name: basename(real), source }
  }
  const explicit = String(env.YDS_BROWSER_PATH ?? env['browser.path'] ?? '').trim()
  if (explicit !== '') return exists(explicit) ? found(explicit, 'YDS_BROWSER_PATH') : null
  for (const candidate of candidates({ platform, env })) {
    if (exists(candidate)) return found(candidate, 'platform')
  }
  // Last resort: a browser on PATH that this platform usually exposes under these names.
  const pathEntries = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const names = platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome', 'msedge']
  const fromPath = []
  for (const dir of pathEntries) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (exists(candidate)) fromPath.push(found(candidate, 'PATH'))
    }
  }
  if (fromPath.length === 0) return null
  // Prefer a real browser: Playwright/Chrome-for-Testing builds work, but their window
  // carries a "Download Chrome" banner and they are meant for automation, not daily use.
  const isTestBuild = (binary) => /ms-playwright|chrome-linux64|headless_shell|chrome-for-testing/i.test(binary.path)
  return fromPath.find((binary) => !isTestBuild(binary)) ?? fromPath[0]
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
    // Refresh the session snapshot while the window is up (login happens after launch).
    void saveCookies(port, cookieSnapshotPath(cfg))
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
  const extensionDir = extension.dir
  const binary = options.binary ?? resolveBrowserBinary({ env })?.path ?? ''
  if (binary === '') {
    return { ok: false, reason: '未找到 Chrome/Edge（可用环境变量 YDS_BROWSER_PATH 指定浏览器可执行文件）' }
  }
  const profile = options.profile ?? browserProfileDir(env)
  mkdirSync(profile, { recursive: true })
  const lang = options.lang ?? (String(env.YDS_BROWSER_LANG ?? '').trim() || 'zh-CN')
  // With a snapshot on disk, start blank and put the session back before the first
  // navigation; otherwise a redirect to the login page would win the race.
  const snapshot = cookieSnapshotPath(cfg)
  const restoreOnStart = existsSync(snapshot)
  const args = buildLaunchArgs({
    profile,
    extensionDir,
    port,
    url: restoreOnStart ? 'about:blank' : url,
    lang,
    extraArgs: options.extraArgs,
  })
  const child = spawn(binary, args, { detached: true, stdio: 'ignore', env: browserEnv(env, lang) })
  child.unref()
  const waitMs = Number.isInteger(options.waitMs) ? options.waitMs : 15000
  const opened = await waitPortOpen(port, waitMs)
  if (opened && restoreOnStart) {
    await restoreCookies(port, snapshot)
    await openNewTab(port, url)
  }
  mkdirSync(join(cfg?.stateDir ?? join(workspace, '.dsh-ris-yds')), { recursive: true })
  writeFileSync(pidFile(cfg), `${JSON.stringify({
    pid: child.pid ?? 0, port, profile, extension: extensionDir, binary, startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (opened !== true) {
    return {
      ok: false,
      reason: `浏览器已启动但 DevTools 端口 ${port} 未就绪（可能被占用或浏览器不支持该参数）`,
      pid: child.pid, port, profile, extension: extensionDir, url, binary,
    }
  }
  return { ok: true, pid: child.pid, port, profile, extension: extensionDir, url, binary }
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
  const profile = browserProfileDir(options.env ?? process.env)
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
    loadUrl: `http://127.0.0.1:${port}/json/version`,
  }
}
