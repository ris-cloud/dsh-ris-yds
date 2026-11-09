import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { readFileSync as readFile } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWatched, reconcileOnce, registerWorkspace, unregisterWorkspace, watchWorkspace } from '../lib/ide-watch.js'

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'yds-watch-'))
}

test('registration survives in the state file and remove takes it out', () => {
  const home = sandbox()
  const ws = sandbox()
  assert.deepEqual(listWatched(home), [])
  const added = registerWorkspace(ws, home)
  assert.equal(added.ok, true)
  assert.deepEqual(added.workspaces, [ws])
  assert.deepEqual(listWatched(home), [ws])
  registerWorkspace(ws, home)
  assert.equal(listWatched(home).length, 1, 'registering twice keeps one entry')
  const removed = unregisterWorkspace(ws, home)
  assert.deepEqual(removed.workspaces, [])
  assert.equal(existsSync(join(home, '.dsh-ris-yds', 'ide-watch.json')), false, 'last removal drops the file')
  rmSync(home, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

test('nothing happens without a config file or without a repair step', async () => {
  const ws = sandbox()
  let calls = 0
  const repair = async () => { calls += 1; return { changed: true } }
  assert.deepEqual(await reconcileOnce(ws, { repair }), { changed: false, reason: 'no-config' })
  mkdirSync(join(ws, '.dsh-ris-ide'), { recursive: true })
  writeFileSync(join(ws, '.dsh-ris-ide', 'config.json'), '{"programs":[]}')
  assert.deepEqual(await reconcileOnce(ws, {}), { changed: false, reason: 'no-repair' })
  assert.equal(calls, 0)
  rmSync(ws, { recursive: true, force: true })
})

test('a restore that writes nothing is reported as a no-op', async () => {
  const ws = sandbox()
  mkdirSync(join(ws, '.dsh-ris-ide'), { recursive: true })
  writeFileSync(join(ws, '.dsh-ris-ide', 'config.json'), '{"programs":[]}')
  const result = await reconcileOnce(ws, { repair: async () => ({ changed: true, reason: 'unchanged' }) })
  assert.deepEqual(result, { changed: false, reason: 'no-op' })
  rmSync(ws, { recursive: true, force: true })
})

test('a rewrite by ris-ide triggers the repair and the row comes back', async () => {
  const ws = sandbox()
  mkdirSync(join(ws, '.dsh-ris-ide'), { recursive: true })
  const configPath = join(ws, '.dsh-ris-ide', 'config.json')
  writeFileSync(configPath, '{"programs":[]}')
  // minimal stand-in for applyIdeConfig: put our row back
  const repair = async () => {
    const doc = JSON.parse(readFileSync(configPath, 'utf8'))
    doc.programs = [{ id: 'yds:demo', name: 'demo', kind: 'spring' }]
    writeFileSync(configPath, JSON.stringify(doc))
    return { changed: true, reason: 'added' }
  }
  const stop = watchWorkspace(ws, { repair })
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    // ris-ide regenerates the file without our row
    writeFileSync(configPath, '{"programs":[{"id":"frontend:x#start","name":"x","kind":"frontend"}]}')
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const rows = JSON.parse(readFileSync(configPath, 'utf8')).programs
      if (rows.some((row) => row.id === 'yds:demo')) break
    }
    const rows = JSON.parse(readFile(configPath, 'utf8')).programs
    assert.ok(rows.some((row) => row.id === 'yds:demo'), 'the launcher row is back')
  } finally {
    stop()
    rmSync(ws, { recursive: true, force: true })
  }
})
