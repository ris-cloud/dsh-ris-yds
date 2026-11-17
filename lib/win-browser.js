// Picking a browser on WSL, where the good one usually lives on the Windows side.
//
// Why this exists: a WSL Linux install of branded Google Chrome REFUSES the flag the
// dev extension needs — Chrome 137+ prints "--load-extension is not allowed in Google
// Chrome, ignoring." and starts with no extension at all, so nothing gets rewritten
// and the workbench silently loads the platform's bundle. A Windows browser launched
// through WSL interop still honours the flag (Chrome for Testing builds and the
// Chromium-bundled browsers on the Windows side do too), and with
// `networkingMode=mirrored` its DevTools port and 127.0.0.1 services are shared with
// WSL — verified both directions (WSL -> 127.0.0.1:<windows port>, and the Windows
// browser -> the WSL dev server / DSH endpoint).
//
// The Windows side needs Windows paths, though: `--user-data-dir=C:\…` and
// `--load-extension=C:\…`, never `/home/...`. Everything here is pure enough to test.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Is this process a WSL Linux distribution (so the Windows side is reachable)? */
export function isWsl(env = process.env) {
  return String(env?.WSL_DISTRO_NAME ?? '').trim() !== '' || String(env?.WSL_INTEROP ?? '').trim() !== ''
}

/** The Windows-side host of a binary we are about to launch. */
export function hostOf(path) {
  const value = String(path ?? '')
  return /^\/mnt\/[a-z]\//i.test(value) && /\.exe$/i.test(value) ? 'windows' : 'linux'
}

/**
 * A Windows path as a path this Linux process can stat and launch.
 *
 * `C:\Program Files\...` becomes `/mnt/c/Program Files/...`; a `\\wsl$\<distro>\x`
 * path is only trusted for the default distribution (mounted at `/`), and anything
 * unrecognised is returned with its backslashes flipped rather than thrown away.
 * @param {string} raw - Windows or POSIX path.
 * @returns {string} POSIX path ('' for empty input).
 */
export function windowsToPosix(raw) {
  const value = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (value === '') return ''
  if (value.startsWith('/')) return value
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (drive !== null) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  const wsl = /^\\\\wsl\$\\([^\\]+)\\?(.*)$/i.exec(value)
  if (wsl !== null) return `/${wsl[2].replace(/\\/g, '/')}`
  return value.replace(/\\/g, '/')
}

/**
 * A path under `/mnt/<drive>/` expressed the way a Windows program needs to see it.
 * @param {string} raw - POSIX path.
 * @returns {string} `C:\…` form, or '' when the path is not on a Windows drive.
 */
export function posixToWindows(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  if (/^[A-Za-z]:[\\/]/.test(value)) return value
  const mnt = /^\/mnt\/([a-z])\/(.*)$/.exec(value)
  if (mnt === null) return ''
  return `${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`
}

/**
 * Windows user profile directory as a POSIX path.
 *
 * WSL does not export `USERPROFILE`, and the WSL user name is often NOT the Windows
 * one (`wangjun` vs `wangj`) — guessing it creates a junk `C:\\Users\\wangjun` folder
 * that Chrome happily writes a profile into. So ask Windows: `cmd.exe /c echo
 * %USERPROFILE%` runs from a Windows directory (cmd refuses a UNC cwd), and only then
 * fall back to a directory that actually exists.
 * @param {Record<string,string>} [env] - environment.
 * @param {{run?: (file: string, args: string[], options?: object) => string, exists?: (path: string) => boolean}} [options] - injection points for tests.
 * @returns {string} profile dir ('' when nothing plausible is found).
 */
export function windowsUserProfile(env = process.env, options = {}) {
  const fromEnv = windowsToPosix(env?.USERPROFILE ?? '')
  if (fromEnv !== '') return fromEnv
  const run = options.run ?? ((file, args, commandOptions) => execFileSync(file, args, {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], ...commandOptions,
  }))
  try {
    const output = String(run('/mnt/c/Windows/system32/cmd.exe', ['/c', 'echo %USERPROFILE%'], { cwd: '/mnt/c/Windows' }) ?? '').trim()
    const posix = windowsToPosix(output)
    if (posix.startsWith('/mnt/c/Users/')) return posix
  } catch {
    // No Windows side (or cmd.exe unavailable): fall back to a real directory.
  }
  const exists = options.exists ?? existsSync
  const user = String(env?.USER ?? '').trim()
  if (user !== '' && exists(`/mnt/c/Users/${user}`)) return `/mnt/c/Users/${user}`
  return exists('/mnt/c/Users/Public') ? '/mnt/c/Users/Public' : ''
}

/** Per-user app data on the Windows side (where Chrome can read our extension). */
export function windowsLocalAppData(env = process.env) {
  const fromEnv = windowsToPosix(env?.LOCALAPPDATA ?? '')
  if (fromEnv !== '') return fromEnv
  const profile = windowsUserProfile(env)
  return profile === '' ? '' : join(profile, 'AppData', 'Local')
}

/**
 * The browser a `UserChoice\ProgId` names, as one of our short ids.
 * @param {string} progId - e.g. `ChromeHTML`, `MSEdgeHTM`, `BraveHTML`.
 * @returns {'chrome'|'edge'|'brave'|'firefox'|''} short id ('' when unrecognised).
 */
export function browserFromProgId(progId) {
  const value = String(progId ?? '').trim()
  if (/^ChromeHTML/i.test(value)) return 'chrome'
  if (/^MSEdge/i.test(value)) return 'edge'
  if (/^BraveHTML/i.test(value)) return 'brave'
  if (/^FirefoxURL/i.test(value)) return 'firefox'
  return ''
}

/** Executable paths a short browser id maps to on the Windows side. */
export function windowsExecutables(id) {
  if (id === 'chrome') {
    return [
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  }
  if (id === 'edge') {
    return [
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    ]
  }
  if (id === 'brave') {
    return [
      '/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
      '/mnt/c/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
    ]
  }
  if (id === 'firefox') {
    return ['/mnt/c/Program Files/Mozilla Firefox/firefox.exe']
  }
  return []
}

const defaultRun = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
})

/**
 * The executable a ProgId opens with (`"C:\\Program Files\\imput\\Helium\\Application\\chrome.exe" --single-argument %1`).
 *
 * Reading the association instead of hard-coding vendor paths is what lets a Helium /
 * Vivaldi / fork default actually be used: they are Chromium builds and DO accept
 * `--load-extension` (unlike branded Chrome 137+), so skipping them means silently
 * using a browser the user never opens.
 * @param {string} progId - e.g. `HeliumHTM`.
 * @param {{run?: Function}} [options] - reg.exe runner, injectable for tests.
 * @returns {string} POSIX path to the executable, or '' when unreadable.
 */
export function executableForProgId(progId, options = {}) {
  const value = String(progId ?? '').trim()
  if (value === '') return ''
  const run = options.run ?? defaultRun
  const reg = '/mnt/c/Windows/system32/reg.exe'
  const keys = [
    `HKCR\\${value}\\shell\\open\\command`,
    `HKLM\\Software\\Classes\\${value}\\shell\\open\\command`,
    `HKCU\\Software\\Classes\\${value}\\shell\\open\\command`,
  ]
  for (const key of keys) {
    try {
      const output = String(run(reg, ['query', key, '/ve']) ?? '')
      const line = /REG_SZ\s+(.+)$/m.exec(output)
      if (line === null) continue
      const quoted = /^\s*"([^"]+)"/.exec(line[1])
      const exe = quoted !== null ? quoted[1] : line[1].trim().split(/\s+/)[0]
      // A real open command names a path; anything else (a stray ProgId echoed back) is
      // not an executable and must not become one.
      if (exe !== '' && /[\\/]/.test(exe)) return windowsToPosix(exe)
    } catch {
      // Key absent: try the next hive.
    }
  }
  return ''
}

/**
 * The Windows default browser, read from the http URL association.
 *
 * `reg.exe` ships with Windows and is reachable through interop; the ProgId only names
 * the *kind* (`ChromeHTML`), so the caller resolves it to an executable and skips it
 * when that executable is not where we expect.
 * @param {{env?: Record<string,string>, run?: (file: string, args: string[]) => string}} [options] - injection points for tests.
 * @returns {{id: string, progId: string} | null} the browser kind, or null.
 */
export function windowsDefaultBrowser(options = {}) {
  const run = options.run ?? defaultRun
  const reg = '/mnt/c/Windows/system32/reg.exe'
  // Windows keeps this both with and without `CurrentVersion` depending on the build;
  // read whichever one exists instead of assuming.
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
  ]
  for (const key of keys) {
    try {
      const output = String(run(reg, ['query', key, '/v', 'ProgId']) ?? '')
      const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(output)
      if (match === null) continue
      const progId = match[1]
      // The ProgId only names the KIND. Its `shell\open\command` is the ground truth,
      // and it is the only way to launch a browser this module has never heard of
      // (Helium, Vivaldi, a vendor fork) — the user's actual default.
      const exe = executableForProgId(progId, { run })
      const id = browserFromProgId(progId)
      if (exe === '' && id === '') return null
      return { id: id === '' ? 'custom' : id, progId, exe }
    } catch {
      // Key missing on this build: try the next spelling.
    }
  }
  return null
}

/**
 * Where the extension and profile live for a WINDOWS-hosted browser.
 *
 * Chrome cannot read `/home/...` paths, and pointing it at `\\wsl$\…` makes it slow
 * and fragile; the extension is small, so it is materialised next to the profile in
 * `%LOCALAPPDATA%\dsh-ris-yds`.
 * @param {{env?: Record<string,string>, key?: string}} [options] - env + project key.
 * @returns {{root: string, profile: string, extension: string} | null} dirs (null off-WSL).
 */
export function windowsBrowserDirs(options = {}) {
  const env = options.env ?? process.env
  const local = windowsLocalAppData(env)
  if (local === '') return null
  const key = typeof options.key === 'string' && options.key !== '' ? options.key : 'default'
  const root = join(local, 'dsh-ris-yds', key)
  return { root, profile: join(root, 'browser-profile'), extension: join(root, 'dev-extension') }
}

/**
 * The PowerShell that stops OUR Windows browser (matched by its private profile).
 *
 * The interop pid is not the Windows pid, so identity is the unique
 * `--user-data-dir` we passed: no other Chrome process can carry it.
 * @param {string} profileWindows - `C:\…` profile path.
 * @returns {string} PowerShell script.
 */
export function windowsStopScript(profileWindows) {
  const needle = String(profileWindows ?? '').replace(/'/g, "''")
  return [
    `$hit = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') }`,
    'foreach ($p in $hit) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }',
    'if ($hit) { "stopped " + @($hit).Count } else { "none" }',
  ].join('\n')
}

/** Copy the generated extension to a Windows-readable folder. */
export function materializeExtension(sourceDir, targetDir) {
  const source = String(sourceDir ?? '')
  const target = String(targetDir ?? '')
  if (source === '' || target === '' || !existsSync(source)) return false
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    if (!statSync(from).isFile()) continue
    copyFileSync(from, join(target, name))
  }
  return true
}

/** Stable, readable, collision-resistant folder name for a project. */
export function projectKey(projectDir) {
  const value = String(projectDir ?? '').replace(/[/\\]+$/, '')
  const name = value.split(/[/\\]/).filter(Boolean).pop() ?? 'project'
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 0xffffff
  return `${safe}-${hash.toString(36)}`
}
