// On WSL the browser that can actually load our extension lives on the Windows side.
// These tests pin the two things that make that work: path translation (Chrome needs
// `C:\…`, we need `/mnt/c/…`) and the preference order the user asked for.
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBrowserBinary, resolveBrowserCandidates } from '../lib/dev-browser.js'
import {
  browserFromProgId,
  hostOf,
  isWsl,
  posixToWindows,
  projectKey,
  windowsBrowserDirs,
  windowsDefaultBrowser,
  windowsExecutables,
  windowsStopScript,
  windowsToPosix,
  windowsUserProfile,
} from '../lib/win-browser.js'

test('a Windows path becomes a path this process can launch', () => {
  assert.equal(windowsToPosix('C:\\Users\\wangj\\.yoncode\\chrome\\Chrome-bin\\chrome.exe'), '/mnt/c/Users/wangj/.yoncode/chrome/Chrome-bin/chrome.exe')
  assert.equal(windowsToPosix('"D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'), '/mnt/d/Program Files/Google/Chrome/Application/chrome.exe')
  assert.equal(windowsToPosix('/usr/bin/chromium'), '/usr/bin/chromium', 'a POSIX path is already usable')
  assert.equal(windowsToPosix(''), '')
})

test('a /mnt path becomes the form a Windows program accepts', () => {
  assert.equal(posixToWindows('/mnt/c/Users/wangj/AppData/Local/dsh-ris-yds/x'), 'C:\\Users\\wangj\\AppData\\Local\\dsh-ris-yds\\x')
  assert.equal(posixToWindows('/home/wangj/.dsh-ris-yds'), '', 'not on a Windows drive')
  assert.equal(posixToWindows('C:\\already\\windows'), 'C:\\already\\windows')
})

test('the Windows default browser is read from the http URL association', () => {
  const chrome = { id: 'chrome', progId: 'ChromeHTML' }
  assert.deepEqual(browserFromProgId('ChromeHTML'), 'chrome')
  assert.deepEqual(browserFromProgId('MSEdgeHTM'), 'edge')
  assert.deepEqual(browserFromProgId('BraveHTML'), 'brave')
  assert.deepEqual(browserFromProgId('FirefoxURL-308046B0AF4A39CB'), 'firefox')
  assert.equal(browserFromProgId('SomeApp.Url.1'), '')
  // ProgId + its open command: the command is what actually gets launched.
  const association = (file, args) => {
    const key = String(args[1] ?? '')
    if (key.includes('UserChoice')) return 'ProgId    REG_SZ    ChromeHTML'
    if (key.includes('ChromeHTML'))
      return 'HKEY_CLASSES_ROOT\\ChromeHTML\\shell\\open\\command\r\n    (Ĭ��)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1'
    throw new Error('no key')
  }
  assert.deepEqual(windowsDefaultBrowser({ run: association }), {
    id: 'chrome', progId: 'ChromeHTML', exe: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  })
  assert.equal(windowsDefaultBrowser({ run: () => 'ProgId    REG_SZ    SomeApp.Url.1' }), null, 'unknown browser')
  assert.equal(windowsDefaultBrowser({ run: () => { throw new Error('reg.exe missing') } }), null, 'no Windows side')
})

test('the Windows home is ASKED for, never guessed from the WSL user name', () => {
  // WSL's USER is `wangjun`, the Windows account is `wangj`: guessing creates a junk
  // C:\\Users\\wangjun profile folder, so cmd.exe is the witness.
  assert.equal(windowsUserProfile({ USER: 'wangjun' }, {
    run: () => 'C:\\Users\\wangj\r\n',
    exists: () => true,
  }), '/mnt/c/Users/wangj')
  // No Windows side: only a directory that really exists is used.
  assert.equal(windowsUserProfile({ USER: 'wangjun' }, { run: () => '', exists: (path) => path === '/mnt/c/Users/wangjun' }), '/mnt/c/Users/wangjun')
  assert.equal(windowsUserProfile({ USER: 'nobody' }, { run: () => '', exists: (path) => path === '/mnt/c/Users/Public' }), '/mnt/c/Users/Public')
})

test('an unknown default browser is skipped, and both registry spellings are read', () => {
  // Windows 11 keeps UserChoice WITHOUT `CurrentVersion`; older builds keep it with.
  const withoutCurrentVersion = (file, args) => {
    const key = String(args[1] ?? '')
    if (key.includes('CurrentVersion')) throw new Error('missing key')
    if (key.includes('UserChoice')) return 'ProgId    REG_SZ    MSEdgeHTM'
    if (key.startsWith('HKCR')) return 'REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" -- "%1"'
    throw new Error('missing key')
  }
  assert.deepEqual(windowsDefaultBrowser({ run: withoutCurrentVersion }), {
    id: 'edge', progId: 'MSEdgeHTM', exe: '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  })
  // A niche Chromium fork (Helium) IS the user's default on this machine: its ProgId is
  // unknown, but its open command names the executable, and that is what must launch.
  const helium = (file, args) => {
    const key = String(args[1] ?? '')
    if (key.includes('UserChoice')) return 'ProgId    REG_SZ    HeliumHTM'
    if (key.startsWith('HKCR')) return 'REG_SZ    "C:\\Program Files\\imput\\Helium\\Application\\chrome.exe" --single-argument %1'
    throw new Error('missing')
  }
  assert.deepEqual(windowsDefaultBrowser({ run: helium }), {
    id: 'custom', progId: 'HeliumHTM', exe: '/mnt/c/Program Files/imput/Helium/Application/chrome.exe',
  })
  // No association readable anywhere: nothing to launch, and no guessing.
  assert.equal(windowsDefaultBrowser({
    run: (file, args) => {
      if (String(args[1] ?? '').includes('UserChoice')) return 'ProgId    REG_SZ    HeliumHTM'
      throw new Error('missing')
    },
  }), null, 'an unknown ProgId with no readable command is skipped, not guessed')
})

test('WSL preference order: override, project Chrome, Windows default, YonCode, Chrome, Edge, then Linux', () => {
  const chromePath = 'C:\\Users\\tester\\.yoncode\\chrome\\Chrome-bin\\chrome.exe'
  const profile = '/mnt/c/Users/tester'
  const present = new Set([
    '/mnt/c/Users/tester/.yoncode/chrome/Chrome-bin/chrome.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
  ])
  const env = {
    WSL_DISTRO_NAME: 'Ubuntu-24.04',
    USERPROFILE: 'C:\\Users\\tester',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    PATH: '/usr/local/bin',
  }
  const found = resolveBrowserCandidates({
    platform: 'linux', env, chromePath, exists: (path) => present.has(path),
    defaultBrowser: { id: 'edge', progId: 'MSEdgeHTM' }, realpath: (path) => path,
  })
  assert.deepEqual(found.map((binary) => binary.source), [
    'yds.chromePath',
    'windows-default:MSEdgeHTM',
    'windows-chrome',
    'linux-extension-safe',
  ])
  assert.equal(found[0].host, 'windows')
  assert.equal(found[3].host, 'linux')
  assert.equal(windowsUserProfile(env), profile)
  assert.equal(windowsBrowserDirs({ env, key: 'k' }).profile, '/mnt/c/Users/tester/AppData/Local/dsh-ris-yds/k/browser-profile')
})

test('an explicit override is a decision, not a hint', () => {
  const found = resolveBrowserCandidates({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', YDS_BROWSER_PATH: '/opt/only/chrome' },
    exists: (path) => path === '/opt/only/chrome' || path === '/usr/bin/chromium',
    realpath: (path) => path,
  })
  assert.deepEqual(found.map((binary) => binary.path), ['/opt/only/chrome'])
  assert.equal(resolveBrowserBinary({ platform: 'linux', env: { YDS_BROWSER_PATH: '/opt/only/chrome' }, exists: (path) => path === '/opt/only/chrome' }).source, 'YDS_BROWSER_PATH')
})

test('a Windows binary is recognised as such, a Linux one is not', () => {
  assert.equal(hostOf('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'), 'windows')
  assert.equal(hostOf('/usr/bin/chromium'), 'linux')
  assert.equal(isWsl({ WSL_DISTRO_NAME: 'Ubuntu-24.04' }), true)
  assert.equal(isWsl({}), false)
  assert.deepEqual(windowsExecutables('edge'), [
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  ])
})

test('stopping a Windows browser is matched by its private profile, never by pid', () => {
  const script = windowsStopScript('C:\\Users\\tester\\AppData\\Local\\dsh-ris-yds\\p\\browser-profile')
  assert.match(script, /Get-CimInstance Win32_Process/)
  assert.match(script, /dsh-ris-yds\\p\\browser-profile/, 'the profile is the identity')
  assert.match(script, /Stop-Process/)
  // A quote in the path must not end the PowerShell literal.
  assert.match(windowsStopScript("C:\\it's\\here"), /it''s/)
})

test('the Windows-side folder name is readable and stable', () => {
  const key = projectKey('/home/wangjun/wsdzjg/yonasset')
  assert.match(key, /^yonasset-[a-z0-9]+$/)
  assert.equal(projectKey('/home/wangjun/wsdzjg/yonasset/'), key, 'a trailing slash does not change it')
  assert.notEqual(projectKey('/a/proj'), projectKey('/b/proj'))
})
