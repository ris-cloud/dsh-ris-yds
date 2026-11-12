/**
 * The tunnel flags we add to .vscode/launch.json: written only while a tunnel
 * exists, and taken back out when the proxy stops.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { LAUNCH_CONFIG, LAUNCH_ENTRY_NAME, applyLaunchConfig, ourLaunchEntry, proxyVmArgs, readLaunchConfig, stripLaunchProxy } from '../lib/ide.js'

/** A project dir with a user-owned launch.json that must survive untouched. */
function project(withEntry = false) {
  const dir = mkdtempSync(join(tmpdir(), 'yds-launch-'))
  mkdirSync(join(dir, '.vscode'), { recursive: true })
  const doc = {
    version: '0.2.0',
    configurations: [{ type: 'java', name: 'MDFApplication', mainClass: 'x.Y', vmArgs: ['-Xmx512m'] }],
  }
  if (withEntry) {
    doc.configurations.push({ type: 'java', name: LAUNCH_ENTRY_NAME, vmArgs: ['-Dyms.dev=true'] })
  }
  writeFileSync(join(dir, LAUNCH_CONFIG), `${JSON.stringify(doc, null, 2)}\n`)
  return dir
}

const cfg = (dir, socks) => ({ projectDir: dir, workspace: dir, socks })

test('proxy flags are derived from .env SOCKS and absent without one', () => {
  assert.deepEqual(proxyVmArgs({ socks: { host: '10.3.91.121', port: 1080 } }), [
    '-DsocksProxyHost=10.3.91.121',
    '-DsocksProxyPort=1080',
    '-Djava.net.useSystemProxies=false',
  ])
  assert.deepEqual(proxyVmArgs({ socks: null }), [], 'no tunnel, no flags')
  assert.deepEqual(proxyVmArgs({}), [])
})

test('apply writes the flags for our entry and leaves other configurations alone', () => {
  const dir = project()
  try {
    const result = applyLaunchConfig(cfg(dir, { host: '10.3.91.121', port: 1080 }))
    assert.equal(result.changed, true)
    const doc = readLaunchConfig(dir).parsed
    const ours = doc.configurations.find((entry) => entry.name === LAUNCH_ENTRY_NAME)
    assert.ok(ours.vmArgs.includes('-DsocksProxyHost=10.3.91.121'))
    const user = doc.configurations.find((entry) => entry.name === 'MDFApplication')
    assert.deepEqual(user.vmArgs, ['-Xmx512m'], 'the user configuration must be byte-identical')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stripping removes exactly the proxy flags and is a no-op afterwards', () => {
  const dir = project()
  try {
    applyLaunchConfig(cfg(dir, { host: '10.3.91.121', port: 1080 }))
    const first = stripLaunchProxy(cfg(dir, null))
    assert.equal(first.changed, true)
    assert.equal(first.action, 'stripped')
    const ours = readLaunchConfig(dir).parsed.configurations.find((entry) => entry.name === LAUNCH_ENTRY_NAME)
    assert.equal(ours.vmArgs.filter((value) => /socksProxy|useSystemProxies/.test(value)).length, 0)
    assert.deepEqual(ours.vmArgs, ourLaunchEntry({}).vmArgs, 'the entry is back to its canonical (proxy-free) form')
    assert.equal(stripLaunchProxy(cfg(dir, null)).changed, false, 'nothing left to strip')
    // The user's configuration is still untouched by either side of the cycle.
    assert.deepEqual(readLaunchConfig(dir).parsed.configurations.find((entry) => entry.name === 'MDFApplication').vmArgs, ['-Xmx512m'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stripping a file without our entry does nothing', () => {
  const dir = project()
  try {
    const result = stripLaunchProxy(cfg(dir, null))
    assert.equal(result.changed, false)
    assert.equal(result.action, 'not-present')
    assert.equal(readFileSync(join(dir, LAUNCH_CONFIG), 'utf8').includes(LAUNCH_ENTRY_NAME), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
