import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  applyIdeConfig, belongsToYdsProject, emptyIdeConfigDocument, frontendProjectName, initializeIdeConfig,
  isOurs, javaProjectName, removeIdeConfig, repairFrontendNames, repairYdsRows,
} from '../lib/ide.js'

/** A yds project root: aggregator pom + bootstrap pom with a parent block. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'yds-ide-'))
  mkdirSync(join(root, 'c-ass-kk-hans-be', 'dev-c-ass-kk-hans-bootstrap'), { recursive: true })
  writeFileSync(join(root, 'c-ass-kk-hans-be', 'pom.xml'), '<project><artifactId>c-ass-kk-hans</artifactId></project>')
  writeFileSync(join(root, 'c-ass-kk-hans-be', 'dev-c-ass-kk-hans-bootstrap', 'pom.xml'), `<project>
  <parent>
    <artifactId>c-ass-kk-hans</artifactId>
    <groupId>com.yonyou.ucf</groupId>
  </parent>
  <artifactId>c-ass-kk-hans-bootstrap</artifactId>
</project>`)
  // The yds marker: an ancestor .vscode/settings.json carrying `yds.` settings.
  mkdirSync(join(root, '.vscode'), { recursive: true })
  writeFileSync(join(root, '.vscode', 'settings.json'),
    '{\n  // yds project\n  "yds.accessKey": "k",\n  "yds.webConfig": {}\n}')
  mkdirSync(join(root, 'c-ass-kk-hans-fe'))
  writeFileSync(join(root, 'c-ass-kk-hans-fe', 'package.json'), '{"name":"fe"}')
  writeFileSync(join(root, 'c-ass-kk-hans-fe', 'module.xml'), '<module name="c-ass-kk-hans-fe" description="前端"/>')
  return root
}

test('names come from the project files, not our own bookkeeping', () => {
  const root = makeProject()
  const cfg = { projectDir: root, module: 'c-ass-kk-hans' }
  // java = bootstrap pom's parent.artifactId
  assert.equal(javaProjectName(cfg), 'c-ass-kk-hans')
  // frontend = module.xml beside package.json
  assert.equal(frontendProjectName(cfg), 'c-ass-kk-hans-fe')
  // no files: fall back to the YMS module name
  assert.equal(javaProjectName({ projectDir: '/nonexistent', module: 'm1' }), 'm1')
  rmSync(root, { recursive: true, force: true })
})

test('apply initialises the config file before writing our row', () => {
  const root = makeProject()
  const cfg = { workspace: root, projectDir: root, module: 'c-ass-kk-hans' }
  const first = applyIdeConfig(cfg)
  assert.equal(first.action, 'created')
  assert.equal(first.initialized, true)
  const doc = JSON.parse(readFileSync(first.path, 'utf8').replace(/^\/\/.*$/gm, ''))
  // Same shape ris-ide itself generates, plus our row named after the project.
  assert.deepEqual(doc.defaults, emptyIdeConfigDocument().defaults)
  assert.equal(doc.version, 1)
  assert.equal(doc.programs.length, 1)
  assert.equal(doc.programs[0].name, 'c-ass-kk-hans')
  // Idempotent second pass.
  const second = applyIdeConfig(cfg)
  assert.equal(second.action, 'unchanged')
  assert.equal(second.initialized, false)
  // Removal finds it by identity, not by a hardcoded name.
  assert.equal(removeIdeConfig(cfg).action, 'removed')
  rmSync(root, { recursive: true, force: true })
})

test('our rows are recognised across renames', () => {
  const cfg = { module: 'c-ass-kk-hans', projectDir: '/nonexistent' }
  assert.equal(isOurs({ name: 'yds-yms-c-ass-kk-hans' }, cfg), true)
  assert.equal(isOurs({ name: 'other', startCommand: 'node "/x/bin/yds.js" start' }, cfg), true)
  assert.equal(isOurs({ name: 'other', startCommand: 'npm run dev' }, cfg), false)
  // A frontend row with the same name is NOT ours — deleting it would be data loss.
  assert.equal(isOurs({ name: 'c-ass-kk-hans', kind: 'frontend' }, cfg), false)
  assert.equal(isOurs({ name: 'c-ass-kk-hans', kind: 'spring' }, cfg), true)
})

test('initialise keeps an existing file untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'yds-ide2-'))
  mkdirSync(join(root, '.dsh-ris-ide'), { recursive: true })
  const path = join(root, '.dsh-ris-ide', 'config.json')
  writeFileSync(path, '{ "programs": [{ "name": "user-row" }] }\n')
  assert.deepEqual(initializeIdeConfig(root), { created: false, path })
  assert.match(readFileSync(path, 'utf8'), /user-row/)
  rmSync(root, { recursive: true, force: true })
})

test('a frontend row of this project is renamed after its module.xml', () => {
  const root = makeProject()
  const cfg = { workspace: root, projectDir: root, module: 'c-ass-kk-hans' }
  const programs = [
    // generated before the rule existed: package.json's name == the java project name
    { id: 'frontend:c-ass-kk-hans-fe#start', kind: 'frontend', name: 'c-ass-kk-hans', dir: 'c-ass-kk-hans-fe' },
    // outside the project: never touched
    { id: 'frontend:other/ui#dev', kind: 'frontend', name: 'other-ui', dir: '/tmp/other/ui' },
  ]
  const result = repairFrontendNames(cfg, programs)
  assert.equal(result.programs[0].name, 'c-ass-kk-hans-fe')
  assert.deepEqual(result.renamed, [{ from: 'c-ass-kk-hans', to: 'c-ass-kk-hans-fe' }])
  assert.equal(result.programs[1].name, 'other-ui')
  // Membership is decided by `dir` (walking up to .vscode/settings.json), never by name or kind.
  assert.equal(belongsToYdsProject(cfg, { name: 'x', kind: 'spring', dir: 'c-ass-kk-hans-fe' }), true)
  assert.equal(belongsToYdsProject(cfg, { name: 'x', dir: '../outside' }), false)
  // A row whose directory has no yds ancestor is left alone even if it has a module.xml.
  const outside = join(root, '..', 'plain-npm')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'module.xml'), '<module name="renamed-by-accident"/>')
  const guarded = repairFrontendNames(cfg, [{ name: 'plain', dir: relative(cfg.workspace, outside) }])
  assert.deepEqual(guarded.renamed, [])
  rmSync(outside, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

test('a java row is renamed to its parent artifactId unless the name is taken', () => {
  const root = makeProject()
  const cfg = { workspace: root, projectDir: root, module: 'c-ass-kk-hans' }
  const programs = [
    // ours: keeps the java project name
    { name: 'c-ass-kk-hans', kind: 'spring', dir: '.', startCommand: 'node x/bin/yds.js start' },
    // discovered bootstrap module: would now want the same name -> skipped, not merged
    { name: 'dev-c-ass-kk-hans-bootstrap', kind: 'spring', dir: 'c-ass-kk-hans-be/dev-c-ass-kk-hans-bootstrap' },
  ]
  const result = repairFrontendNames(cfg, programs)
  assert.equal(result.programs[0].name, 'c-ass-kk-hans')
  assert.equal(result.programs[1].name, 'dev-c-ass-kk-hans-bootstrap')
  assert.deepEqual(result.renamed, [])
  assert.deepEqual(result.skipped.map((item) => item.to), ['c-ass-kk-hans'])
  rmSync(root, { recursive: true, force: true })
})

test('the discovered backend row is disabled and a hijacked startCommand is removed', () => {
  const root = makeProject()
  const cfg = { workspace: root, projectDir: root, module: 'c-ass-kk-hans' }
  const ours = { id: `yds:c-ass-kk-hans`, name: 'c-ass-kk-hans', kind: 'spring', dir: '.',
    startCommand: 'node x/bin/yds.js start --foreground' }
  const programs = [
    ours,
    // the row the panel generates for the same backend — must not compete with ours
    { id: 'spring:be/bootstrap#Main', name: 'dev-c-ass-kk-hans-bootstrap', kind: 'spring', dir: 'c-ass-kk-hans-be/dev-c-ass-kk-hans-bootstrap' },
    // a frontend row an older update copied our command onto
    { id: 'frontend:c-ass-kk-hans-fe#start', name: 'c-ass-kk-hans', kind: 'frontend', dir: 'c-ass-kk-hans-fe',
      startCommand: 'node x/bin/yds.js start --foreground' },
  ]
  const result = repairYdsRows(cfg, programs)
  assert.deepEqual(result.renamed.map((item) => item.to), ['c-ass-kk-hans-fe'])
  // The renamed frontend also takes its own log name: the old "<project>-<name>"
  // value collided with the backend row and both wrote the same log/pidfile.
  assert.equal(result.programs[2].logName, 'c-ass-kk-hans-fe')
  assert.deepEqual(result.renamedLogs, [{ name: 'c-ass-kk-hans-fe', from: undefined, to: 'c-ass-kk-hans-fe' }])
  assert.deepEqual(result.disabled.map((item) => item.name), ['dev-c-ass-kk-hans-bootstrap'])
  assert.deepEqual(result.cleaned.map((item) => item.name), ['c-ass-kk-hans-fe'])
  assert.equal(result.programs[0].disabled, undefined, 'our row stays enabled')
  assert.equal(result.programs[1].disabled, true)
  assert.equal(result.programs[2].startCommand, undefined)
  assert.equal(result.programs[2].name, 'c-ass-kk-hans-fe')
  rmSync(root, { recursive: true, force: true })
})
