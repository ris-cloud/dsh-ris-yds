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
  toProcessPattern, yoncodeRules, programKeyOf, ydsRulesFor,
} from '../lib/ide-proxy.js'
import { mergeYdsRules } from '../lib/rules.js'

test('only a dotted-quad IPv4 literal counts as bindable', () => {
  assert.equal(isIpv4Literal('172.20.235.80'), true)
  assert.equal(isIpv4Literal('172.20.235.*'), false, 'a wildcard cannot be pre-bound')
  assert.equal(isIpv4Literal('srmdev.hanslaser.com'), false)
  assert.equal(isIpv4Literal(''), false)
})

test('rules name real programs on both sides: java/git and their WSL-side twins', () => {
  const targets = [
    { host: '172.20.235.80', port: 1521 },
    { host: '172.20.235.81', port: 6890, isRedis: true },
    { host: '172.20.235.81', port: 6880 },
    // a second internal /24 must fold into the SAME java row
    { host: '172.20.63.131', port: 31010 },
    // duplicates collapse, garbage is dropped
    { host: '172.20.235.81', port: 6880 },
    { host: 'srmdev.hanslaser.com', port: 443 },
    { host: '', port: 1 },
    { host: '10.0.0.1', port: 0 },
    { host: '10.0.0.1', port: 70000 },
  ]
  // On a WSL/Linux host the WSL side is the one that matters: `java.exe` is the Windows
  // image, `java` is the process name ProxyBridge matches on the Linux side, and the
  // missing local rows were why a WSL JVM was never intercepted.
  const rules = proxyRulesFromTargets(targets, { gitHost: 'gitlab.hanslaser.com', java: true, platform: 'linux' })
  assert.deepEqual(rules.map((rule) => `${rule.id}|${rule.side}|${rule.program}|${rule.hosts}|${rule.ports}`), [
    'yds-java|windows|java.exe|172.20.235.*,172.20.63.*|*',
    'yds-git|windows|git.exe|gitlab.hanslaser.com|*',
    'yds-java-local|local|java|172.20.235.*,172.20.63.*|*',
    'yds-git-local|local|git|gitlab.hanslaser.com|*',
  ])
  assert.equal(rules.every((rule) => rule.source === YDS_RULE_SOURCE), true)
  assert.equal(rules.every((rule) => rule.program !== 'jdbc'), true, 'jdbc is not a process name')
  assert.equal(programKeyOf(rules[0].program), 'java')
  assert.equal(programKeyOf(rules[2].program), 'java', 'the local row names the same program on its side')
  assert.equal(rules.every((rule) => rule.shadow === false), true, 'the table holds intent only; no mapping rows')
  assert.equal(rules.every((rule) => rule.workspace === undefined), true, 'the table is global: workspace is not part of a row')
  // Windows has no Linux side: only the `.exe` rows are generated there.
  const windows = proxyRulesFromTargets(targets, { gitHost: 'gitlab.hanslaser.com', java: true, platform: 'win32' })
  assert.deepEqual(windows.map((rule) => rule.id), ['yds-java', 'yds-git'])
  // Without a git URL there is no git rule to write (on either side).
  const noGit = proxyRulesFromTargets([{ host: '172.20.235.80', port: 1521 }], { gitHost: '', java: true, platform: 'linux' })
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
  // The image name, not a file under the devkit: a JDK upgrade keeps working and
  // every java.exe on the machine is covered.
  assert.equal(rules[0].program, 'java.exe')
  // The range comes from the endpoints we resolved, never from a hardcoded vendor range.
  assert.equal(rules[0].hosts, '172.20.235.*,172.20.63.*')
  assert.equal(rules[0].ports, '*')
  assert.equal(rules[0].shadow, false)
  assert.equal(rules[1].program, 'git.exe')
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

test('the yds rows are a whole-table write: the global set replaces the old yds rows', () => {
  // The table is one global list. A save carries the complete table: the user's rows
  // pass through, the previous yds rows are replaced by this run's set (never unioned
  // with another project's, because there is no other project's share any more).
  const merged = mergeYdsRules(
    [
      { id: 'user-1', program: 'navicat.exe', hosts: '10.9.9.*', source: 'user' },
      { id: 'yds-java-old', program: 'java.exe', hosts: '172.20.235.*', ports: '*', enabled: true, source: 'yds', workspace: '/ws-a' },
      { id: 'yds-git-old', program: 'git.exe', hosts: 'gitlab.example.com', ports: '*', enabled: true, source: 'yds', workspace: '/ws-a' },
    ],
    [
      { id: 'yds-java', program: 'java.exe', side: 'windows', hosts: '172.20.235.*,172.20.63.*', ports: '*', enabled: true, source: 'yds' },
      { id: 'yds-java-local', program: 'java', side: 'local', hosts: '172.20.235.*,172.20.63.*', ports: '*', enabled: true, source: 'yds' },
    ],
  )
  assert.deepEqual(merged.map((row) => row.id), ['user-1', 'yds-java', 'yds-java-local'])
  assert.equal(merged.filter((row) => row.source === 'yds').length, 2, 'one row per side, not per workspace')
  assert.equal(merged[1].hosts, '172.20.235.*,172.20.63.*')
  assert.equal(merged.every((row) => row.workspace === undefined || row.source !== 'yds'), true, 'no workspace column on global rows')
})

test('the rules this project writes are the full side-aware set', () => {
  const rows = ydsRulesFor(
    { workspace: '/w', proxyJavaRules: true, git: { url: 'https://gitlab.hanslaser.com/x/y.git' } },
    [{ host: '172.20.235.80', port: 1521 }],
    { platform: 'linux' },
  )
  assert.deepEqual(rows.map((row) => row.id), ['yds-java', 'yds-git', 'yds-java-local', 'yds-git-local'])
  assert.deepEqual(rows.map((row) => row.side), ['windows', 'windows', 'local', 'local'])
  // A second start from another workspace produces the same shape: the last save wins.
  const again = ydsRulesFor(
    { workspace: '/other', proxyJavaRules: true, git: { url: 'https://gitlab.hanslaser.com/x/y.git' } },
    [{ host: '172.20.63.131', port: 1521 }],
    { platform: 'linux' },
  )
  assert.equal(again.find((row) => row.id === 'yds-java').hosts, '172.20.63.*', 'the fresh run owns the row')
})

test('a mounted YonCode path becomes a drive-letter pattern', () => {
  assert.equal(toProcessPattern('/mnt/d/Program Files/YonCode/devkit/x/bin/java.exe'), 'D:\\Program Files\\YonCode\\devkit\\x\\bin\\java.exe')
  assert.equal(toProcessPattern('C:\\Program Files\\YonCode\\x\\java.exe'), 'C:\\Program Files\\YonCode\\x\\java.exe')
  assert.equal(toProcessPattern('/opt/YonCode/devkit/x/bin/java'), '/opt/YonCode/devkit/x/bin/java')
})

test('duplicates collapse only within one side+program, never across programs', () => {
  const rows = mergeYdsRules([], [
    { id: 'a', program: 'java.exe', side: 'windows', hosts: '10.0.0.*' },
    { id: 'b', program: 'C:\\Program Files\\YonCode\\devkit\\jdk21\\bin\\java.exe', side: 'windows', hosts: '10.0.0.*' },
    { id: 'c', program: 'git.exe', side: 'windows', hosts: 'gitlab.example.com' },
    { id: 'd', program: 'git', side: 'local', hosts: 'gitlab.example.com' },
    { id: 'e', program: '' },
  ])
  assert.deepEqual(rows.map((row) => row.id), ['a', 'c', 'd'])
  assert.equal(rows[0].hosts, '10.0.0.*', 'the duplicate spelling contributes no new host')
  assert.equal(programKeyOf('C:\\Program Files\\Git\\bin\\git.exe'), 'git')
  assert.equal(programKeyOf('java'), 'java')
})