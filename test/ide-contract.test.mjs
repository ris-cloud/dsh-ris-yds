// Contract test for the dsh-ris-ide surface this plugin borrows.
//
// yds does not depend on dsh-ris-ide at install time, but at run time it imports
// its `lib/proxy.js` / `lib/redirector.js`, writes rows into its
// `.dsh-ris-ide/config.json`, and calls its risd daemon routes. Every one of those
// was verified by hand on 2026-11-11 (== 0 breakage after the dsh-ris-ide upgrade);
// this file turns that hand check into an executable one, so the next uprev of the
// IDE fails here instead of at the user's first `yds start`.
//
// It skips when no dsh-ris-ide is reachable — the suite has to stay runnable on a
// machine that only has dsh-ris-yds.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { ideProxyCandidates, probeRedirectorStatus } from '../lib/ide-proxy.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** First reachable dsh-ris-ide `lib/` directory, or `null`. */
function findIdeLib() {
  for (const proxyPath of ideProxyCandidates({ workspace: REPO_ROOT })) {
    if (existsSync(proxyPath) && existsSync(join(dirname(proxyPath), 'index.js'))) return dirname(proxyPath)
  }
  return null
}

const IDE_LIB = findIdeLib()
const skip = IDE_LIB === null
  ? 'dsh-ris-ide is not reachable here (set YDS_IDE_PROXY or install it)'
  : false

/** Import one of the IDE's modules by file name. */
function importIde(file) {
  return import(pathToFileURL(join(IDE_LIB, file)).href)
}

/** A temp workspace whose yds project shape makes `dir` checks pass. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'yds-contract-'))
  mkdirSync(join(root, 'proj', 'bootstrap'), { recursive: true })
  writeFileSync(join(root, 'proj', 'pom.xml'), '<project><artifactId>demo</artifactId></project>')
  return root
}

/** The row `yds ide apply` writes into ris-ide's config. */
function launcherRow(workspace) {
  return {
    id: 'yds:demo',
    name: 'demo',
    kind: 'spring',
    dir: workspace,
    startCommand: 'node "/plugins/dsh-ris-yds/bin/yds.js" start --foreground --jvm-args "${JDWP_ARGS}"',
    logName: 'yds-demo.log',
    stopGraceMs: 60000,
  }
}

test('the modules yds imports still export what it calls', { skip }, async () => {
  const proxy = await importIde('proxy.js')
  for (const name of [
    'startProxy', 'stopProxy', 'proxyStatus', 'proxyPid', 'readProxyConfig',
    'writeProxyConfig', 'mergeConfigs', 'gitProxyPlan', 'runWindowsGitConfig', 'proxyHomeDir',
  ]) {
    assert.equal(typeof proxy[name], 'function', `lib/proxy.js no longer exports ${name}()`)
  }
  const redirector = await importIde('redirector.js')
  for (const name of [
    'syncRedirector', 'redirectorStatus', 'startRedirectors',
    'reloadRedirectorsWithProfile', 'stopRedirector', 'localRedirectorRunning',
  ]) {
    assert.equal(typeof redirector[name], 'function', `lib/redirector.js no longer exports ${name}()`)
  }
})

test('mergeConfigs still replaces the whole rule table, keeping the engine settings', { skip }, async () => {
  const { mergeConfigs } = await importIde('proxy.js')
  const stored = {
    socks: { host: '10.0.0.9', port: 1080 },
    listenPort: 10808,
    rules: [{ id: 'foreign', source: 'user', program: 'java', hosts: '10.0.0.1:3306', enabled: true }],
  }
  const merged = mergeConfigs(stored, {
    socks: { host: '10.0.0.9', port: 1080 },
    listenPort: 10808,
    replaceAllRules: true,
    rules: [{ id: 'yds:demo:0', source: 'yds', program: 'java', hosts: '10.0.0.2:3306', enabled: true }],
  })
  assert.deepEqual(merged.rules.map((rule) => rule.id), ['yds:demo:0'], 'a replaceAllRules write must drop rows it does not restate')
  assert.deepEqual(merged.socks, stored.socks, 'the borrowed engine keeps owning socks')
  assert.equal(merged.listenPort, 10808, 'the borrowed engine keeps owning the listen port')
})

test('ris-ide reads the yds launcher row, and its config merge keeps it', { skip }, async () => {
  const ide = await importIde('index.js')
  const workspace = makeWorkspace()
  try {
    const configDir = join(workspace, '.dsh-ris-ide')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      version: 1,
      defaults: { jvmArgs: [] },
      programs: [launcherRow(workspace)],
    }))
    const read = await ide.readProgramConfig(workspace)
    assert.equal(read.exists, true)
    assert.equal(read.error, undefined)
    assert.equal(read.entries.length, 1)
    const row = read.entries[0]
    assert.equal(row.id, 'yds:demo')
    assert.equal(row.kind, 'spring')
    assert.match(row.startCommand, /\$\{JDWP_ARGS\}/, 'the debug placeholder must survive ris-ide parsing')

    // The panel's "update config" path must not drop a row it cannot discover.
    const discovered = ide.buildConfigDocument([], workspace)
    const merged = ide.mergeConfigDocuments(discovered, read.entries, workspace)
    assert.equal(merged.programs.length, 1, 'an update merge must keep the yds launcher row')
    assert.equal(merged.programs[0].startCommand, row.startCommand)

    // ...and the config must count as in sync, or the panel would rewrite it on
    // every poll and the watcher would have to fight it.
    assert.equal(ide.configMatchesWorkspace(workspace, read.entries), true)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('ris-ide still reads launch.json (JSONC) without matching our entry to a program', { skip }, async () => {
  const ide = await importIde('index.js')
  const workspace = makeWorkspace()
  try {
    mkdirSync(join(workspace, '.vscode'), { recursive: true })
    writeFileSync(join(workspace, '.vscode', 'launch.json'), `{
  // written by yds: same shape as YonCode's entry
  "version": "0.2.0",
  "configurations": [
    {
      "type": "java",
      "name": "yms-middleware-cloudnative-jdk-21",
      "request": "launch",
      "mainClass": "iuap.yms.YMSLauncher",
      "cwd": "\${config:yds.ymsHome}",
      "args": [],
    },
  ],
}`)
    const configs = await ide.readLaunchConfigs(workspace)
    assert.equal(configs.length, 1)
    assert.equal(configs[0].mainClass, 'iuap.yms.YMSLauncher')
    // `${config:...}` cannot be resolved into a workspace path, so this entry must
    // never be picked as "the launch config for program dir X" — yds runs through
    // `startCommand`, not through a launch config.
    assert.equal(ide.launchFor(configs, join(workspace, 'proj'), workspace), undefined)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('the risd routes and version header yds calls still exist in the daemon source', { skip }, () => {
  const source = readFileSync(join(IDE_LIB, 'risd', 'server.js'), 'utf8')
  for (const route of ['/v1/health', '/v1/leases', '/v1/proxy', '/v1/action', '/v1/engine']) {
    assert.match(source, new RegExp(`'${route}'`), `risd no longer routes ${route}`)
  }
  assert.match(source, /API_VERSION_HEADER = 'x-risd-api-version'/, 'the risd version header changed')
  assert.match(source, /RISD_API_VERSION/, 'the daemon no longer pins an apiVersion')
})

test('a leaked ris-ide probe stub cannot make yds think the bridge is down', () => {
  const key = 'DSH_RIS_IDE_STUB_PROBES'
  const before = process.env[key]
  const fake = {
    redirectorStatus: () => ({ running: process.env[key] !== '1' }),
  }
  try {
    process.env[key] = '1'
    assert.deepEqual(probeRedirectorStatus(fake), { running: true }, 'the probe must not see the stub')
    assert.equal(process.env[key], '1', 'the variable is restored for the rest of the process')
  } finally {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
  // No stub in the environment: the call is a straight pass-through, and a missing
  // module degrades to "not running" instead of throwing.
  delete process.env[key]
  assert.deepEqual(probeRedirectorStatus(fake), { running: true })
  assert.deepEqual(probeRedirectorStatus(null), { running: false })
  assert.deepEqual(probeRedirectorStatus({}), { running: false })
})
