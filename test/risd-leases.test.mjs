// The lease record on disk is how a short-lived CLI hands a long-lived tunnel
// ownership to the YMS process, so it must survive two `yds start` runs in
// different workspaces and a writer that died between read and write.
//
// Review D-P2-6: the file used to be a bare read-modify-write (a lost update
// dropped the other workspace's lease, leaving the daemon to reap an engine a
// live YMS still needed) and a leftover `.lock` had no recovery path.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import { dropDeadLease, forgetLease, readLease, rememberLease } from '../lib/risd-peer.js'

const PEER = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'risd-peer.js')).href

let root
let home

before(() => {
  root = mkdtempSync(join(tmpdir(), 'yds-risd-leases-'))
  home = join(root, '.dsh-ris-ide')
  mkdirSync(home, { recursive: true })
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

function leasesFile() {
  return join(root, '.dsh-ris-yds', 'risd-leases.json')
}

test('a lease round-trips and is written 0600 without leaving temp files', () => {
  const cwd = '/ws/one'
  assert.equal(rememberLease(cwd, { id: 'lease-1', ownerPid: process.pid, port: 11081 }, { home }), true)
  const entry = readLease(cwd, { home })
  assert.equal(entry.id, 'lease-1')
  assert.equal(entry.ownerPid, process.pid)
  assert.equal(typeof entry.at, 'string', 'timestamp for debugging a stale record')
  assert.equal(statSync(leasesFile()).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(join(root, '.dsh-ris-yds')).filter((name) => name.endsWith('.tmp')), [])
  forgetLease(cwd, { home })
  assert.equal(readLease(cwd, { home }), null)
  assert.equal(existsSync(join(root, '.dsh-ris-yds', 'risd-leases.json.lock')), false, 'lock released')
})

test('a stale lease is dropped only when its owner is gone', () => {
  const live = '/ws/live'
  const dead = '/ws/dead'
  rememberLease(live, { id: 'lease-live', ownerPid: process.pid, port: 1 }, { home })
  rememberLease(dead, { id: 'lease-dead', ownerPid: 999999, port: 1 }, { home })
  assert.equal(dropDeadLease(live, { home }), false)
  assert.notEqual(readLease(live, { home }), null, 'a live owner keeps its lease')
  assert.equal(dropDeadLease(dead, { home }), true)
  assert.equal(readLease(dead, { home }), null, 'a dead owner does not keep the engine alive')
})

test('an abandoned lock file is stolen instead of blocking every later start', () => {
  const cwd = '/ws/stale-lock'
  const lock = `${leasesFile()}.lock`
  mkdirSync(join(root, '.dsh-ris-yds'), { recursive: true })
  writeFileSync(lock, '12345')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  assert.equal(rememberLease(cwd, { id: 'lease-stale', ownerPid: process.pid, port: 1 }, { home }), true)
  assert.notEqual(readLease(cwd, { home }), null)
  assert.equal(existsSync(lock), false)
})

test('a held lock degrades to a bounded unlocked write instead of hanging yds', () => {
  const cwd = '/ws/held-lock'
  const lock = `${leasesFile()}.lock`
  mkdirSync(join(root, '.dsh-ris-yds'), { recursive: true })
  const fd = openSync(lock, 'wx')
  const started = Date.now()
  try {
    // The holder is this very process (never released), so the client must give up
    // on the lock and still record the lease: a missing record is worse.
    assert.equal(rememberLease(cwd, { id: 'lease-held', ownerPid: process.pid, port: 1 }, { home }), true)
    const waited = Date.now() - started
    assert.ok(waited < 4000, `bounded wait (waited ${waited}ms)`)
    assert.notEqual(readLease(cwd, { home }), null)
  } finally {
    closeSync(fd)
    rmSync(lock, { force: true })
  }
})

test('concurrent writers in different workspaces never drop each other', async () => {
  const count = 6
  const code = `import { rememberLease } from ${JSON.stringify(PEER)};
rememberLease(process.argv[1], { id: process.argv[2], ownerPid: process.pid, port: 1 }, { home: process.argv[3] })`
  const children = Array.from({ length: count }, (_, index) => new Promise((resolve) => {
    const cwd = `/ws/concurrent-${index}`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, cwd, `lease-c${index}`, home], { stdio: 'ignore' })
    child.once('exit', (code_) => resolve({ cwd, id: `lease-c${index}`, code: code_ }))
  }))
  const results = await Promise.all(children)
  assert.deepEqual(results.filter((row) => row.code !== 0), [], 'every writer exited cleanly')
  const all = JSON.parse(readFileSync(leasesFile(), 'utf8'))
  for (const row of results) {
    assert.equal(all[row.cwd]?.id, row.id, `${row.cwd} kept its lease`)
  }
  assert.equal(readdirSync(join(root, '.dsh-ris-yds')).filter((name) => name.endsWith('.tmp')).length, 0)
})
