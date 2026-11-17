/**
 * The two launch modes must never be mixed:
 *   - proxy  : YonCode's JVM carries -DsocksProxyHost/Port and reads
 *              yms-home/config (rewritten to 127.0.0.1).
 *   - direct : no proxy flag at all; when dsh still tunnels, YonCode reads the
 *              untouched copy in yms-home/config-direct.
 * These tests pin the boundaries: flags, config dirs, mode switching, and the
 * default derived from .env `ide.launch`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { adaptAndWriteConfig } from '../lib/confcenter.js'
import { resolveConfig } from '../lib/config.js'
import { LAUNCH_ENTRY_NAME, applyLaunchConfig, launchModeVmArgs, ourLaunchEntry, readLaunchConfig } from '../lib/ide.js'

const SOCKS = { host: '10.3.91.121', port: 1080 }

function workspace(env = '') {
  const dir = mkdtempSync(join(tmpdir(), 'yds-modes-'))
  if (env !== '') writeFileSync(join(dir, '.env'), env, 'utf8')
  return dir
}

function launchProject() {
  const dir = mkdtempSync(join(tmpdir(), 'yds-launch-mode-'))
  mkdirSync(join(dir, '.vscode'), { recursive: true })
  writeFileSync(join(dir, '.vscode', 'launch.json'), `${JSON.stringify({ version: '0.2.0', configurations: [] }, null, 2)}\n`)
  return dir
}

const entryVmArgs = (dir) => readLaunchConfig(dir).parsed.configurations.find((c) => c.name === LAUNCH_ENTRY_NAME).vmArgs

test('proxy mode: socks flags, no local_conf_path', () => {
  const flags = launchModeVmArgs({ launchMode: 'proxy', socks: SOCKS })
  assert.deepEqual(flags, [
    '-DsocksProxyHost=10.3.91.121',
    '-DsocksProxyPort=1080',
    '-Djava.net.useSystemProxies=false',
  ])
  const entry = ourLaunchEntry({ launchMode: 'proxy', socks: SOCKS })
  assert.ok(entry.vmArgs.includes('-DsocksProxyHost=10.3.91.121'))
  assert.ok(!entry.vmArgs.some((v) => String(v).startsWith('-Dlocal_conf_path=')), 'proxy mode must not read config-direct')
})

test('direct mode on a tunneled machine: local_conf_path only, never socks flags', () => {
  const flags = launchModeVmArgs({ launchMode: 'direct', socks: SOCKS })
  assert.equal(flags.length, 2)
  assert.ok(flags[0].startsWith('-Dlocal_conf_path=') && flags[0].endsWith('/config-direct/'), `unexpected: ${flags[0]}`)
  assert.equal(flags[1], '-Dyms_use_local_conf=true')
  const entry = ourLaunchEntry({ launchMode: 'direct', socks: SOCKS })
  assert.ok(!entry.vmArgs.some((v) => /^-DsocksProxy/.test(String(v))), 'direct mode must never carry proxy flags')
  assert.ok(!entry.vmArgs.includes('-Djava.net.useSystemProxies=false'))
})

test('direct mode without SOCKS needs no override at all', () => {
  assert.deepEqual(launchModeVmArgs({ launchMode: 'direct', socks: null }), [])
  assert.deepEqual(launchModeVmArgs({ launchMode: 'proxy', socks: null }), [])
})

test('switching modes rewrites the entry with no residue from the other mode', () => {
  const dir = launchProject()
  try {
    const proxyCfg = { projectDir: dir, workspace: dir, launchMode: 'proxy', socks: SOCKS }
    applyLaunchConfig(proxyCfg)
    assert.ok(entryVmArgs(dir).includes('-DsocksProxyHost=10.3.91.121'))

    const directCfg = { ...proxyCfg, launchMode: 'direct' }
    applyLaunchConfig(directCfg)
    const direct = entryVmArgs(dir)
    assert.ok(!direct.some((v) => /^-DsocksProxy/.test(String(v))))
    assert.ok(direct.some((v) => String(v).startsWith('-Dlocal_conf_path=')))

    applyLaunchConfig(proxyCfg)
    const back = entryVmArgs(dir)
    assert.ok(back.includes('-DsocksProxyHost=10.3.91.121'))
    assert.ok(!back.some((v) => String(v).startsWith('-Dlocal_conf_path=')), 'stale direct override after switching back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config-direct keeps the real endpoints while config/ stays adapted', () => {
  const dir = workspace()
  try {
    const cfg = {
      workspace: dir,
      stateDir: join(dir, '.dsh-ris-yds'),
      ymsHome: join(dir, 'yms-home'),
      configDir: join(dir, 'yms-home', 'config'),
      configDirectDir: join(dir, 'yms-home', 'config-direct'),
      ymsPort: 8080,
      socks: SOCKS,
      dbForwardPort: 1521,
      redisForwardPort: 6890,
      module: 'c-ass-kk-hans',
      context: '/',
      serverBindAddress: '172.20.63.131',
      serverPort: 31010,
    }
    mkdirSync(cfg.stateDir, { recursive: true })
    const files = {
      'yms_middleware.json': JSON.stringify({
        connectionPools: { pool1: { url: 'jdbc:oracle:thin:@//10.3.91.100:31000/ris' } },
        'redis.pools': { redis1: { host: '172.20.235.81', port: 6890 } },
      }),
      'module_config.json': '{"module":true}',
      'yonbip_config.json': '{"platform":true}',
    }

    adaptAndWriteConfig(cfg, files)
    adaptAndWriteConfig(cfg, files, { rewrite: false, dir: cfg.configDirectDir })

    const adapted = readFileSync(join(cfg.configDir, 'yms_middleware.json'), 'utf8')
    const untouched = readFileSync(join(cfg.configDirectDir, 'yms_middleware.json'), 'utf8')
    assert.ok(adapted.includes('127.0.0.1:1521'), 'proxy config must point at the local forwarder')
    assert.ok(adapted.includes('127.0.0.1'), 'proxy config must not keep the real DB host')
    assert.ok(!adapted.includes('10.3.91.100:31000'))
    assert.ok(untouched.includes('10.3.91.100:31000'), 'direct config must keep the real DB host')
    assert.ok(!untouched.includes('127.0.0.1:1521'))
    // the two writes did not leak into each other's directory
    assert.ok(readFileSync(join(cfg.configDir, 'yms_middleware.json'), 'utf8').includes('127.0.0.1:1521'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ide.launch selects the mode; an invalid value is reported and falls back to proxy', () => {
  const direct = workspace('ide.launch=direct\n')
  const bogus = workspace('ide.launch=both\n')
  try {
    const d = resolveConfig(direct)
    assert.equal(d.config.launchMode, 'direct')
    assert.ok(d.config.configDirectDir.endsWith('config-direct'))
    assert.notEqual(d.config.configDir, d.config.configDirectDir)

    const b = resolveConfig(bogus)
    assert.equal(b.config.launchMode, 'proxy', 'unknown values must not become direct silently')
    assert.ok(b.problems.some((p) => p.includes('ide.launch')), `missing problem: ${b.problems.join(' | ')}`)
  } finally {
    rmSync(direct, { recursive: true, force: true })
    rmSync(bogus, { recursive: true, force: true })
  }
})
