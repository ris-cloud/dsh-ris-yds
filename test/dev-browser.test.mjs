// The private debugging browser: yds owns the instance, so the dev extension can be
// preloaded without any manual install and CDP works. These tests pin the flags,
// the binary discovery, and the "only stop what we started" rule.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:net'

import {
  DEFAULT_DEBUG_PORT,
  browserEnv,
  portOpen,
  browserProfileDir,
  buildLaunchArgs,
  debugBrowserStatus,
  readBrowserRecord,
  resolveBrowserBinary,
  startDebugBrowser,
  stopDebugBrowser,
} from '../lib/dev-browser.js'

test('the flags preload the extension and open a debugging port, profile first', () => {
  const args = buildLaunchArgs({
    profile: '/tmp/profile', extensionDir: '/tmp/ext', port: 9333, url: 'https://srmdev.hanslaser.com/',
  })
  assert.ok(args.includes('--user-data-dir=/tmp/profile'))
  assert.ok(args.includes('--load-extension=/tmp/ext'))
  assert.ok(args.includes('--remote-debugging-port=9333'))
  // The URL is last, so Chrome treats the preceding tokens as switches.
  assert.equal(args[args.length - 1], 'https://srmdev.hanslaser.com/')
  assert.ok(args.indexOf('--load-extension=/tmp/ext') < args.indexOf('--remote-debugging-port=9333'))
  assert.equal(DEFAULT_DEBUG_PORT, 9222)
})

test('a symlinked browser is recorded under its real path (the command line shows it)', () => {
  const found = resolveBrowserBinary({
    platform: 'linux',
    env: { YDS_BROWSER_PATH: '/home/me/bin/chromium' },
    exists: () => true,
    realpath: (path) => (path === '/home/me/bin/chromium' ? '/home/me/cache/chrome' : path),
  })
  assert.equal(found.path, '/home/me/cache/chrome')
  assert.equal(found.name, 'chrome')
})

test('an explicit binary wins over the platform guesses', () => {
  const found = resolveBrowserBinary({
    platform: 'linux', env: { YDS_BROWSER_PATH: '/opt/custom/chrome' }, exists: (path) => path === '/opt/custom/chrome',
  })
  assert.equal(found.path, '/opt/custom/chrome')
  assert.equal(found.source, 'YDS_BROWSER_PATH')
  // Missing explicit binary is a hard miss, not a silent fallback to a different one.
  assert.equal(resolveBrowserBinary({ platform: 'linux', env: { YDS_BROWSER_PATH: '/nope' }, exists: () => false }), null)
})

test('platform candidates and $PATH are both searched', () => {
  const mac = resolveBrowserBinary({
    platform: 'darwin',
    env: {},
    exists: (path) => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  assert.equal(mac.name, 'Google Chrome')
  const fromPath = resolveBrowserBinary({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/opt/tools', YDS_BROWSER_PATH: '' },
    exists: (path) => path === '/opt/tools/chromium',
  })
  assert.equal(fromPath.path, '/opt/tools/chromium')
  assert.equal(fromPath.source, 'PATH')
})

test('the profile directory is machine-level, not project-level', () => {
  const dir = browserProfileDir({ YDS_BROWSER_PROFILE: '/tmp/yds-browser' })
  assert.equal(dir, '/tmp/yds-browser')
  assert.match(browserProfileDir({}), /\.dsh-ris-yds[/\\]browser-profile$/)
})

test('a working extension folder is generated on demand and the launch is recorded', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-browser-'))
  const profile = mkdtempSync(join(tmpdir(), 'yds-profile-'))
  const argsFile = join(workspace, 'argv.txt')
  const binary = join(workspace, 'fakebrowser')
  // A fake browser: records its argv, then stays alive like a real window.
  // The recorded pid must keep the script name in its command line, which is how
  // stopDebugBrowser recognises its own launch. A trailing `:` stops dash from
  // exec-optimising the last command (that would rename the pid to "sleep").
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nsleep 5\n:\n`)
  chmodSync(binary, 0o755)
  const cfg = { workspace, stateDir: join(workspace, '.dsh-ris-yds') }
  try {
    // A port returned by close() can still accept a connect() for a few ms (the kernel
    // has not torn the listener down yet), which would look like an existing instance.
    const port = await freePortVerified()
    const result = await startDebugBrowser(cfg, { binary, profile, port, waitMs: 300 })
    // Nothing listens on that port (the fake browser does not serve DevTools), so the
    // call reports the timeout but has still spawned and recorded the instance.
    assert.equal(result.ok, false)
    assert.equal(result.pid > 0, true, `pid ${result.pid}`)
    const record = readBrowserRecord(cfg)
    assert.equal(record.port, port)
    assert.equal(record.binary, binary)
    assert.ok(existsSync(join(result.extension, 'manifest.json')))
    const argv = readFileSync(argsFile, 'utf8')
    assert.match(argv, /--user-data-dir=/)
    assert.match(argv, /--load-extension=/)
    assert.match(argv, /--remote-debugging-port=/)
    // Only our own spawned browser is stopped, and the record is cleaned up.
    const stopped = await stopDebugBrowser(cfg)
    assert.equal(stopped.stopped, true, JSON.stringify(stopped))
    assert.equal(stopped.pid, result.pid)
    assert.equal(readBrowserRecord(cfg), null)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a foreign pid in the record is never killed', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-browser-'))
  const cfg = { workspace, stateDir: join(workspace, '.dsh-ris-yds') }
  try {
    // process.pid is a foreign process for this module (markers cannot match).
    mkdirSync(join(cfg.stateDir), { recursive: true })
    writeFileSync(join(cfg.stateDir, 'browser.pid'), `${JSON.stringify({ pid: process.pid, binary: '/no/such/chrome' })}\n`)
    const stopped = await stopDebugBrowser(cfg)
    assert.equal(stopped.stopped, false)
    assert.match(stopped.reason, /不是本插件启动/)
    // The record survives, so a later legitimate stop can still see it.
    assert.notEqual(readBrowserRecord(cfg), null)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('status reports a running instance when the recorded port has a listener', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-browser-'))
  const cfg = { workspace, stateDir: join(workspace, '.dsh-ris-yds') }
  try {
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(join(cfg.stateDir, 'browser.pid'), `${JSON.stringify({ pid: 4321, port: 9455 })}\n`)
    const status = debugBrowserStatus(cfg, { listen: () => ({ pid: 4321, source: 'ss' }) })
    assert.equal(status.running, true)
    assert.equal(status.pid, 4321)
    assert.equal(status.port, 9455)
    // Nothing listening: not running, and no pid is invented.
    const idle = debugBrowserStatus(cfg, { listen: () => ({ pid: null, reason: 'none' }) })
    assert.equal(idle.running, false)
    assert.equal(idle.pid, undefined)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('status reports the recorded port and the extension folder', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-browser-'))
  const cfg = { workspace, stateDir: join(workspace, '.dsh-ris-yds') }
  try {
    mkdirSync(join(cfg.stateDir), { recursive: true })
    writeFileSync(join(cfg.stateDir, 'browser.pid'), `${JSON.stringify({ pid: 0, port: 9444 })}\n`)
    const status = debugBrowserStatus(cfg)
    assert.equal(status.port, 9444)
    assert.equal(status.extensionDir, join(workspace, '.dsh-ris-yds', 'dev-extension'))
    assert.equal(typeof status.loadUrl, 'string')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

/**
 * A port that is provably not accepting connections: freePort() alone races with the
 * kernel releasing the listener, which the launcher (correctly) reads as a live instance.
 */
async function freePortVerified() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await freePort()
    if (candidate <= 0) continue
    // Re-probe the SAME port: a fresh freePort() is always inside the release window,
    // so only waiting on one candidate tells us the listener is really gone (~25ms).
    for (let probe = 0; probe < 40; probe += 1) {
      if ((await portOpen(candidate)) === false) return candidate
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error('could not find a closed port')
}

/** A port that is free right now (the fake browser must not collide with anything). */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

test('browserEnv exports the UI language (gettext), not just --lang', () => {
  const base = { LANG: 'C.UTF-8', PATH: '/usr/bin' }
  const zh = browserEnv(base, 'zh-CN')
  assert.equal(zh.LANGUAGE, 'zh_CN')
  assert.equal(zh.LANG, 'zh_CN.UTF-8')
  assert.equal(zh.LC_ALL, 'zh_CN.UTF-8')
  // A user's own non-C locale is never overridden.
  const kept = browserEnv({ LANG: 'en_US.UTF-8' }, 'zh-CN')
  assert.equal(kept.LANGUAGE, 'zh_CN')
  assert.equal(kept.LANG, 'en_US.UTF-8')
  // No language requested: environment is copied untouched.
  assert.deepEqual(browserEnv(base, ''), base)
})
