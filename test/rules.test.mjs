// The rule table is ONE global list and the panel saves it wholesale. yds owns exactly
// its `source: 'yds'` rows: every save replaces them as a set, a stop removes them all,
// and user/auto rows pass through untouched. The only thing that must not collapse is
// the program identity — `java.exe` (Windows image) and `java` (WSL/Linux process) are
// two different rows, which is what the `side`-aware group key pins down.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  YDS_RULE_SOURCE,
  mergeYdsRules,
  programKeyOf,
  ruleGroupKey,
  withdrawnBetween,
  ydsRowsOf,
} from '../lib/rules.js'

const fresh = (row) => ({ source: YDS_RULE_SOURCE, ports: '*', enabled: true, ...row })

test('program identity: image name, bare name and wildcard patterns', () => {
  assert.equal(programKeyOf('java.exe'), 'java')
  assert.equal(programKeyOf('C:\\Program Files\\YonCode\\devkit\\jdk21\\bin\\java.exe'), 'java')
  assert.equal(programKeyOf('java'), 'java')
  assert.equal(programKeyOf('git.cmd'), 'git')
  assert.equal(programKeyOf('  git  '), 'git')
  // A wildcard has no basename identity: keep the pattern or every wildcard collapses.
  assert.equal(programKeyOf('C:\\devkit\\jdk*\\bin\\*.exe'), 'raw:c:\\devkit\\jdk*\\bin\\*.exe')
  assert.equal(programKeyOf('*.exe'), 'raw:*.exe')
  assert.equal(programKeyOf(''), '')
  assert.equal(programKeyOf(null), '')
})

test('the group key keeps the two sides apart', () => {
  assert.equal(ruleGroupKey({ side: 'windows', program: 'java.exe' }), 'windows|java')
  assert.equal(ruleGroupKey({ side: 'local', program: 'java' }), 'local|java')
  assert.notEqual(ruleGroupKey({ side: 'windows', program: 'java.exe' }), ruleGroupKey({ side: 'local', program: 'java' }))
  // A row written without a side is its own bucket, never silently merged into a side.
  assert.equal(ruleGroupKey({ program: 'git.exe' }), '|git')
  assert.equal(ruleGroupKey({ side: ' WINDOWS ', program: 'git.exe' }), 'windows|git')
})

test('non-yds rows pass through untouched, yds rows are replaced wholesale', () => {
  const user = { id: 'user-1', program: 'navicat.exe', hosts: '10.9.9.*', source: 'user' }
  const auto = { id: 'auto-1', program: 'chrome.exe', hosts: '10.8.8.*', source: 'auto' }
  const stored = [
    user,
    fresh({ id: 'yds-java-old', program: 'java.exe', hosts: '172.20.235.*', side: 'windows' }),
    auto,
  ]
  const table = mergeYdsRules(stored, [
    fresh({ id: 'yds-java', program: 'java.exe', hosts: '172.20.63.*', side: 'windows' }),
  ])
  assert.deepEqual(table[0], user, 'user rows are stored verbatim')
  assert.deepEqual(table[1], auto, 'auto rows are stored verbatim')
  assert.deepEqual(table.slice(2), [{
    id: 'yds-java', program: 'java.exe', side: 'windows', hosts: '172.20.63.*',
    ports: '*', enabled: true, shadow: false, direct: false, source: YDS_RULE_SOURCE,
  }])
  assert.equal(table.some((row) => row.id === 'yds-java-old'), false, 'the old yds row is gone, not unioned')
  // The caller's arrays are not mutated.
  assert.deepEqual(stored.map((row) => row.id), ['user-1', 'yds-java-old', 'auto-1'])
})

test('one row per side+program: java.exe and java stay two rows', () => {
  const table = mergeYdsRules([], [
    fresh({ id: 'yds-java', program: 'java.exe', side: 'windows', hosts: '172.20.235.*' }),
    fresh({ id: 'yds-java-local', program: 'java', side: 'local', hosts: '172.20.235.*' }),
    fresh({ id: 'yds-git', program: 'git.exe', side: 'windows', hosts: 'gitlab.example.com' }),
    fresh({ id: 'yds-git-local', program: 'git', side: 'local', hosts: 'gitlab.example.com' }),
  ])
  assert.deepEqual(table.map((row) => row.id), ['yds-java', 'yds-java-local', 'yds-git', 'yds-git-local'])
  assert.deepEqual(table.map((row) => row.side), ['windows', 'local', 'windows', 'local'])
})

test('duplicate fresh rows for one side+program merge their hosts and keep the opt-ins safe', () => {
  const table = mergeYdsRules([], [
    fresh({ id: 'a', program: 'java.exe', side: 'windows', hosts: '10.1.1.*', enabled: true, shadow: true, direct: true }),
    fresh({ id: 'b', program: 'C:\\devkit\\jdk21\\bin\\java.exe', side: 'windows', hosts: '10.2.2.*', enabled: false, shadow: false, direct: true }),
  ])
  assert.equal(table.length, 1)
  assert.equal(table[0].hosts, '10.1.1.*,10.2.2.*')
  assert.equal(table[0].enabled, true, 'either copy enabling the row is enough')
  assert.equal(table[0].shadow, false, 'an opt-in only survives when every copy asked for it')
  assert.equal(table[0].direct, true)
})

test('an empty fresh list removes every yds row and keeps everything else', () => {
  const stored = [
    { id: 'user-1', program: 'navicat.exe', hosts: '10.9.9.*', source: 'user' },
    fresh({ id: 'yds-java', program: 'java.exe', side: 'windows', hosts: '10.1.1.*' }),
    fresh({ id: 'yds-java-local', program: 'java', side: 'local', hosts: '10.1.1.*' }),
  ]
  assert.deepEqual(mergeYdsRules(stored, []), [{ id: 'user-1', program: 'navicat.exe', hosts: '10.9.9.*', source: 'user' }])
  assert.deepEqual(mergeYdsRules(stored, undefined), mergeYdsRules(stored, []))
})

test('invalid fresh rows are dropped and explained', () => {
  const lines = []
  const table = mergeYdsRules([], [
    null,
    'not a row',
    fresh({ id: 'no-program', program: '  ' }),
    fresh({ id: 'no-host', program: 'java.exe', hosts: '', ports: '' }),
    fresh({ id: 'ok', program: 'git.exe', side: 'windows', hosts: 'gitlab.example.com' }),
  ], { log: (line) => lines.push(line) })
  assert.deepEqual(table.map((row) => row.id), ['ok'])
  assert.equal(lines.length, 4, 'each rejected row is logged: null, non-object, no program, no host/port')
  assert.match(lines.join('\n'), /不是对象/)
  assert.match(lines.join('\n'), /没有 program/)
  assert.match(lines.join('\n'), /既没有 host 也没有 port/)
})

test('lists are canonicalized: hosts trimmed, ports unioned, `*` wins', () => {
  const table = mergeYdsRules([], [
    fresh({ id: 'one', program: 'java.exe', side: 'windows', hosts: ' 10.1.1.* , 10.2.2.* ', ports: '1521, 6890' }),
    fresh({ id: 'two', program: 'git.exe', side: 'windows', hosts: 'gitlab.example.com', ports: '*' }),
  ])
  assert.equal(table[0].hosts, '10.1.1.*,10.2.2.*')
  assert.equal(table[0].ports, '1521,6890')
  assert.equal(table[1].ports, '*')
  const wild = mergeYdsRules([], [fresh({ id: 'w', program: 'java.exe', side: 'windows', hosts: '10.1.1.*', ports: '1521,*' })])
  assert.equal(wild[0].ports, '*')
})

test('fresh rows are always marked as yds rows', () => {
  const table = mergeYdsRules([], [{ id: 'x', program: 'java.exe', hosts: '10.1.1.*' }])
  assert.equal(table[0].source, YDS_RULE_SOURCE)
  assert.equal(table[0].enabled, true, 'an omitted switch means enabled')
  assert.equal(table[0].shadow, false)
  assert.equal(table[0].direct, false)
})

test('wildcard programs never collapse onto one identity', () => {
  const table = mergeYdsRules([], [
    fresh({ id: 'star', program: 'C:\\a\\*.exe', hosts: '10.1.1.*' }),
    fresh({ id: 'q', program: 'C:\\b\\?.exe', hosts: '10.2.2.*' }),
  ])
  assert.deepEqual(table.map((row) => row.id), ['star', 'q'])
})

test('ydsRowsOf and withdrawnBetween report the yds share only', () => {
  const user = { id: 'user-1', program: 'navicat.exe', hosts: '10.9.9.*', source: 'user' }
  const before = [
    user,
    fresh({ id: 'yds-java', program: 'java.exe', side: 'windows', hosts: '10.1.1.*,10.2.2.*' }),
    fresh({ id: 'yds-git', program: 'git.exe', side: 'windows', hosts: 'gitlab.example.com' }),
  ]
  const after = [user, fresh({ id: 'yds-java', program: 'java.exe', side: 'windows', hosts: '10.1.1.*' })]
  assert.deepEqual(ydsRowsOf(before).map((row) => row.id), ['yds-java', 'yds-git'])
  assert.deepEqual(withdrawnBetween(before, after), { rules: 1, hosts: 2 })
  assert.deepEqual(withdrawnBetween(before, [user]), { rules: 2, hosts: 3 })
  assert.deepEqual(withdrawnBetween(before, before), { rules: 0, hosts: 0 })
  assert.deepEqual(withdrawnBetween(undefined, undefined), { rules: 0, hosts: 0 })
})
