// The ris-ide 🌐 button asks yds to open the frontend. For a yds project that means
// yds' own debugging browser (extension preloaded, CDP on) — the page there carries
// rdbga, so its requests come back to this machine. Other projects fall back to the
// loopback proxy; opening a browser at about:blank for them would be a bug.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openDebugForWorkspace } from '../lib/dev-open.js'

/** A minimal yds project: settings.json with the `yds.*` keys is the marker. */
function ydsProject() {
  const dir = mkdtempSync(join(tmpdir(), 'yds-open-'))
  mkdirSync(join(dir, '.vscode'), { recursive: true })
  writeFileSync(join(dir, '.vscode', 'settings.json'), JSON.stringify({
    'yds.workbenchUrl': 'https://srmdev.hanslaser.com',
    'yds.module': 'c-ass-kk-hans',
    'yds.accessKey': 'ak',
    'yds.accessSecret': 'as',
    'yds.serverBindAddress': '127.0.0.1',
    'yds.serverPort': 31010,
  }))
  return dir
}

test('a yds project opens its workbench in the private browser', async () => {
  const dir = ydsProject()
  try {
    const calls = []
    const result = await openDebugForWorkspace(dir, {
      start: async (cfg, options) => {
        calls.push({ cfg, options })
        return { ok: true, pid: 1234, port: 9222, profile: '/tmp/profile', extension: '/tmp/ext', url: options.url }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'debug')
    assert.equal(result.pid, 1234)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cfg.stateDir, join(dir, '.dsh-ris-yds'))
    assert.equal(calls[0].options.url, 'https://srmdev.hanslaser.com')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit url wins over the workbench url', async () => {
  const dir = ydsProject()
  try {
    let seen
    await openDebugForWorkspace(dir, {
      url: 'https://srmdev.hanslaser.com/mdf-node/meta/VoucherList/T55253_HansBankStatementList',
      start: async (_cfg, options) => {
        seen = options.url
        return { ok: true, pid: 1, port: 9222 }
      },
    })
    assert.equal(seen, 'https://srmdev.hanslaser.com/mdf-node/meta/VoucherList/T55253_HansBankStatementList')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory that is not a yds project is refused, without launching anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yds-plain-'))
  try {
    let started = false
    const result = await openDebugForWorkspace(dir, {
      start: async () => {
        started = true
        return { ok: true, pid: 1, port: 9222 }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-yds-project')
    assert.equal(started, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a browser that failed to start is reported, not claimed as opened', async () => {
  const dir = ydsProject()
  try {
    const result = await openDebugForWorkspace(dir, {
      start: async () => ({ ok: false, reason: '找不到 Chrome/Edge' }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'debug-browser')
    assert.match(result.reason, /Chrome/)
    // A window that did open (DevTools not ready yet) is still a success.
    const opened = await openDebugForWorkspace(dir, {
      start: async () => ({ ok: false, reason: 'DevTools 端口未就绪', pid: 777 }),
    })
    assert.equal(opened.ok, true)
    assert.equal(opened.mode, 'debug')
    assert.equal(opened.pid, 777)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
