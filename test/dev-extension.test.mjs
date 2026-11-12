// The dev extension is a thin browser client; the plugin is its config server.
// These tests pin the contract between the two (values follow the project) and the
// generated folder layout the browser loads.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_DSH_PORT,
  devConfig,
  devConfigForWorkspace,
  extensionFolder,
  extensionPageHtml,
  extensionStatus,
  extensionStatusForWorkspace,
  writeDevExtension,
  writeDevExtensionForWorkspace,
} from '../lib/dev-extension.js'

const baseCfg = {
  workspace: '',
  module: 'c-ass-kk-hans',
  context: '/',
  workbenchUrl: 'https://srmdev.hanslaser.com',
  serverBindAddress: '172.20.63.131',
  serverPort: 31010,
  fePort: 3004,
}

const expectedRdbga = Buffer.from('c-ass-kk-hans,/@172.20.63.131:31010', 'utf8').toString('base64')

test('devConfig carries the project values, including rdbga', () => {
  const payload = devConfig(baseCfg)
  assert.equal(payload.ok, true)
  assert.equal(payload.module, 'c-ass-kk-hans')
  assert.equal(payload.workbenchUrl, 'https://srmdev.hanslaser.com')
  assert.equal(payload.rdbga, expectedRdbga)
  assert.equal(payload.fePort, 3004)
  assert.equal(payload.staticBase, 'http://127.0.0.1:3004/static')
})

test('devConfig still answers when rdbga cannot be built (assets still redirect)', () => {
  const payload = devConfig({ ...baseCfg, serverBindAddress: 'local' })
  assert.equal(payload.ok, false)
  assert.match(payload.reason, /rdbga/)
  assert.equal(payload.fePort, 3004)
})

test('the folder location is derived from the workspace, not hard-coded', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-ext-'))
  try {
    assert.equal(extensionFolder({ workspace }), join(workspace, '.dsh-ris-yds', 'dev-extension'))
    assert.equal(extensionFolder({ workspace }, { dir: '/tmp/explicit' }), '/tmp/explicit')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('writeDevExtension materializes a loadable folder with a bootstrap config', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-ext-'))
  try {
    const written = writeDevExtension({ workspace }, { dshPort: 3080 })
    assert.equal(written.path, join(workspace, '.dsh-ris-yds', 'dev-extension'))
    assert.equal(written.dshPort, 3080)
    for (const file of ['manifest.json', 'sw.js', 'popup.html', 'popup.js', 'config.json']) {
      assert.ok(existsSync(join(written.path, file)), `${file} missing`)
    }
    const manifest = JSON.parse(readFileSync(join(written.path, 'manifest.json'), 'utf8'))
    assert.equal(manifest.manifest_version, 3)
    assert.ok(manifest.permissions.includes('declarativeNetRequest'))
    const bootstrap = JSON.parse(readFileSync(join(written.path, 'config.json'), 'utf8'))
    // Only the two bootstrap values: everything else is fetched live.
    assert.deepEqual(bootstrap, { workspace, dshPort: 3080 })
    // The default DSH port is used when the caller does not pass one.
    assert.equal(DEFAULT_DSH_PORT, 3080)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('extensionStatus reports the folder, its files and the manual install steps', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-ext-'))
  try {
    const before = extensionStatus({ ...baseCfg, workspace })
    assert.equal(before.exists, false)
    assert.equal(before.loadUrl, 'chrome://extensions')
    assert.ok(before.steps.some((step) => step.includes('chrome://extensions')))
    writeDevExtension({ workspace })
    const after = extensionStatus({ ...baseCfg, workspace })
    assert.equal(after.exists, true)
    assert.ok(after.files.includes('manifest.json'))
    assert.ok(after.steps.some((step) => step.includes(after.dir)))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('a non-yds directory is refused instead of receiving an extension folder', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'yds-plain-'))
  try {
    const status = extensionStatusForWorkspace(scratch)
    assert.equal(status.ok, false)
    assert.equal(existsSync(join(scratch, '.dsh-ris-yds', 'dev-extension')), false)
    const written = writeDevExtensionForWorkspace(scratch)
    assert.equal(written.ok, false)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('dev-config for a workspace without a project answers ok:false', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'yds-plain-'))
  try {
    const payload = devConfigForWorkspace(scratch)
    assert.equal(payload.ok, false)
    assert.equal(typeof payload.reason, 'string')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the console page embeds the workspace and does not need any build step', () => {
  const html = extensionPageHtml('/home/user/wsdzjg')
  assert.match(html, /yds 浏览器扩展/)
  assert.match(html, /chrome:\/\/extensions/)
  assert.ok(html.includes('/home/user/wsdzjg'))
  // Self-contained: no external script/style references.
  assert.equal(/<script[^>]+src=/.test(html), false)
})
