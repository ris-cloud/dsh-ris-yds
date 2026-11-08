// Tests for the borrowed proxy engine: rule generation, discovery order, and the
// fallback decision when dsh-ris-ide is not installed.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  YDS_RULE_SOURCE, applyGitProxy, ensureBorrowedProxy, gitHostOf, ideProxyCandidates,
  isIpv4Literal, isPrivateIpv4, loadIdeProxy, privateSegmentsOf, proxyRulesFromTargets,
  shadowTargetsFromTargets,
  toProcessPattern, yoncodeRules,
} from '../lib/ide-proxy.js'

test('only a dotted-quad IPv4 literal counts as bindable', () => {
  assert.equal(isIpv4Literal('172.20.235.80'), true)
  assert.equal(isIpv4Literal('172.20.235.*'), false, 'a wildcard cannot be pre-bound')
  assert.equal(isIpv4Literal('srmdev.hanslaser.com'), false)
  assert.equal(isIpv4Literal(''), false)
})

test('rules name real programs: java for the internal segment, git for its remote', () => {
  const rules = proxyRulesFromTargets([
    { host: '172.20.235.80', port: 1521 },
    { host: '172.20.235.81', port: 6890, isRedis: true },
    { host: '172.20.235.81', port: 6880 },
    // duplicates collapse, garbage is dropped
    { host: '172.20.235.81', port: 6880 },
    { host: 'srmdev.hanslaser.com', port: 443 },
    { host: '', port: 1 },
    { host: '10.0.0.1', port: 0 },
    { host: '10.0.0.1', port: 70000 },
  ], '/w', { gitHost: 'gitlab.hanslaser.com', java: true })
  // Endpoints are NOT rows: two rules, both naming a real process.
  // Every axis is explicit: "any port" is spelled `*`, because a blank port no
  // longer makes a rule apply (the dialog rejects half-written rows).
  assert.deepEqual(rules.map((rule) => `${rule.program}|${rule.hosts}|${rule.ports}`), [
    'java|172.20.235.*|*',
    'git|gitlab.hanslaser.com|*',
  ])
  assert.equal(rules.every((rule) => rule.source === YDS_RULE_SOURCE), true)
  assert.equal(rules.every((rule) => rule.program !== 'jdbc'), true, 'jdbc is not a process name')
  assert.equal(rules.every((rule) => rule.shadow === false), true, 'the table holds intent only; no mapping rows')
  assert.equal(rules[0].id, 'yds-java-172-20-235', 'one rule per internal segment, stable id')
  assert.equal(rules[1].id, 'yds-git')
  // Without a git URL there is no git rule to write.
  const noGit = proxyRulesFromTargets([{ host: '172.20.235.80', port: 1521 }], '/w', { gitHost: '', java: true })
  assert.equal(noGit.some((rule) => rule.program === 'git'), false)
})

test('the no-root fallback is a separate listener list, not rules', () => {
  const targets = [
    { host: '172.20.235.80', port: 1521 },
    { host: '172.20.235.81', port: 6890 },
    { host: '172.20.235.81', port: 6890 },
    { host: 'srmdev.hanslaser.com', port: 443 },
    { host: '10.0.0.1', port: 70000 },
  ]
  assert.deepEqual(shadowTargetsFromTargets(targets), [
    { host: '172.20.235.80', port: 1521 },
    { host: '172.20.235.81', port: 6890 },
  ], 'one listener per literal IPv4 endpoint, duplicates collapsed, hostnames skipped')
  assert.deepEqual(shadowTargetsFromTargets([null, undefined, {}]), [])
})


test('the git host comes from the clone URL, never from a guess', () => {
  assert.equal(gitHostOf({ git: { url: 'https://gitlab.hanslaser.com/hans-dev/hans-asset/yonasset.git' } }), 'gitlab.hanslaser.com')
  assert.equal(gitHostOf({ git: { url: 'not a url' } }), '')
  assert.equal(gitHostOf({ git: null }), '')
})

test('candidate locations cover the profile link, a workspace install and a sibling checkout', () => {
  const list = ideProxyCandidates({ workspace: '/w' })
  assert.ok(list.some((path) => path === '/w/node_modules/dsh-ris-ide/lib/proxy.js'))
  assert.ok(list.some((path) => path === '/w/work/dsh-ris-ide/lib/proxy.js'))
  // join() normalizes, so the sibling checkout resolves next to the workspace.
  assert.ok(list.some((path) => path === '/dsh-ris-ide/lib/proxy.js'))
  assert.ok(list.some((path) => path.endsWith('.dsh/profiles/web/node_modules/dsh-ris-ide/lib/proxy.js')))
})

test('a machine without dsh-ris-ide reports unavailable instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yds-proxy-'))
  const previous = process.env.YDS_IDE_PROXY
  try {
    // The documented off switch: no search at all, so the machine's real install
    // cannot leak into the test.
    process.env.YDS_IDE_PROXY = 'none'
    const loaded = await loadIdeProxy({ workspace: dir })
    assert.equal(loaded.available, false)
    assert.match(loaded.error, /YDS_IDE_PROXY=none/)
  } finally {
    if (previous === undefined) delete process.env.YDS_IDE_PROXY
    else process.env.YDS_IDE_PROXY = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('direct mode never touches the proxy engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yds-proxy-'))
  try {
    const result = await ensureBorrowedProxy({ workspace: dir, socks: null, proxyEngine: 'auto' }, [{ host: '10.0.0.1', port: 1521 }])
    assert.equal(result.mode, 'none')
    // …and the git helper refuses politely instead of writing a broken entry.
    const git = await applyGitProxy({ workspace: dir, socks: null }, { enabled: true })
    assert.equal(git.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('proxy.engine=self disables the borrow even when the engine is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yds-proxy-'))
  try {
    const result = await ensureBorrowedProxy(
      { workspace: dir, socks: { host: '10.3.91.121', port: 1080 }, proxyEngine: 'self' },
      [{ host: '172.20.235.80', port: 1521 }],
    )
    assert.equal(result.mode, 'unavailable')
    assert.match(result.error, /proxy\.engine=self/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken engine module is reported, not fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yds-proxy-'))
  const previous = process.env.YDS_IDE_PROXY
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'proxy.js'), 'export default {}\n')
    process.env.YDS_IDE_PROXY = join(dir, 'lib', 'proxy.js')
    const loaded = await loadIdeProxy({ workspace: dir })
    assert.equal(loaded.available, false)
    assert.match(loaded.error, /不完整/)
  } finally {
    if (previous === undefined) delete process.env.YDS_IDE_PROXY
    else process.env.YDS_IDE_PROXY = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('YonCode own executables get their own labelled rules', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'yds-yoncode-'))
  mkdirSync(join(home, 'devkit', 'jdk21.0.7', 'bin'), { recursive: true })
  writeFileSync(join(home, 'devkit', 'jdk21.0.7', 'bin', 'java.exe'), '')
  const gitDir = mkdtempSync(join(tmpdir(), 'yds-git-'))
  const gitExe = join(gitDir, 'git.exe')
  writeFileSync(gitExe, '')
  // A POSIX home keeps the pattern POSIX; /mnt/<drive>/ paths are rewritten to a
  // drive letter, which is what ProxyBridge on Windows compares against.
  const rules = yoncodeRules({ workspace: '/w' }, {
    homes: [home],
    gitPaths: [gitExe],
    gitHost: 'gitlab.example.com',
    hosts: ['172.20.235.*', '172.20.63.*'],
  })
  assert.deepEqual(rules.map((rule) => rule.id), ['yds-yoncode-java', 'yds-yoncode-git'])
  assert.deepEqual(rules.map((rule) => rule.label), ['YonCode java', 'YonCode git'])
  // `jdk*\bin\*.exe`: scoped to the JDK trees (devkit also holds maven/node) and
  // covering java.exe/javaw.exe, so a JDK upgrade does not invalidate the rule.
  assert.equal(rules[0].program, join(home, 'devkit', 'jdk*', 'bin', '*.exe'))
  // The range comes from the endpoints we resolved, never from a hardcoded vendor range.
  assert.equal(rules[0].hosts, '172.20.235.*,172.20.63.*')
  assert.equal(rules[0].ports, '*')
  assert.equal(rules[0].shadow, false)
  assert.equal(rules[1].program, gitExe)
  assert.equal(rules[1].hosts, 'gitlab.example.com')
  assert.equal(rules.every((rule) => rule.source === 'yds'), true)
  // No YonCode install and no git: no rows invented.
  assert.deepEqual(yoncodeRules({}, { homes: [home], gitPaths: [], gitHost: 'x', hosts: ['10.0.0.*'] }).map((r) => r.id), ['yds-yoncode-java'])
  // No resolved endpoint range = no java row invented (a row with an empty host list
  // would match nothing, and a guessed range would redirect the wrong traffic).
  assert.deepEqual(yoncodeRules({}, { homes: [home], gitPaths: [], gitHost: 'x' }), [])
  assert.deepEqual(yoncodeRules({}, { homes: [], gitPaths: [], gitHost: 'x' }), [])
})

test('executable rows inherit the private ranges of the resolved endpoints', () => {
  const segments = privateSegmentsOf(
    [{ host: '172.20.235.80', port: 1521 }, { host: '172.20.235.81', port: 6890 }, { host: 'gitlab.example.com', port: 443 }],
    ['172.20.63.131'],
  )
  assert.deepEqual(segments, ['172.20.235.*', '172.20.63.*'])
  assert.deepEqual(privateSegmentsOf([], []), [])
})

test('a mounted YonCode path becomes a drive-letter pattern', () => {
  assert.equal(toProcessPattern('/mnt/d/Program Files/YonCode/devkit/x/bin/java.exe'), 'D:\\Program Files\\YonCode\\devkit\\x\\bin\\java.exe')
  assert.equal(toProcessPattern('C:\\Program Files\\YonCode\\x\\java.exe'), 'C:\\Program Files\\YonCode\\x\\java.exe')
  assert.equal(toProcessPattern('/opt/YonCode/devkit/x/bin/java'), '/opt/YonCode/devkit/x/bin/java')
})
