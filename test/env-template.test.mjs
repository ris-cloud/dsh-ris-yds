import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureEnvTemplate, envPendingKeys, ENV_TEMPLATE_ACK, ENV_TEMPLATE_SECTION } from '../lib/config.js'
import { run } from '../lib/cli.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'yds-env-template-'))

test('creates the shared .env as a commented template', () => {
  const dir = workspace()
  const result = ensureEnvTemplate(dir)
  assert.equal(result.created, true)
  assert.deepEqual(result.added, ['git.url', 'socks.host', 'socks.port', 'proxy.javaRules'])
  assert.equal(result.path, join(dir, '.env'))
  const text = readFileSync(result.path, 'utf8')
  assert.ok(text.startsWith(ENV_TEMPLATE_SECTION))
  for (const line of ['#git.url=', '#socks.host=', '#socks.port=', '#proxy.javaRules=on']) {
    assert.ok(text.includes(line), `template has ${line}`)
  }
})

test('is idempotent and never duplicates a key', () => {
  const dir = workspace()
  const first = ensureEnvTemplate(dir)
  const before = readFileSync(first.path, 'utf8')
  const second = ensureEnvTemplate(dir)
  assert.deepEqual(second.added, [])
  assert.equal(readFileSync(first.path, 'utf8'), before)
})

test('keeps configured values and only appends the missing keys', () => {
  const dir = workspace()
  writeFileSync(join(dir, '.env'), 'socks.host=10.3.91.121\nsocks.port=1080\n')
  const result = ensureEnvTemplate(dir)
  assert.deepEqual(result.added, ['git.url', 'proxy.javaRules'])
  const text = readFileSync(result.path, 'utf8')
  assert.ok(text.startsWith('socks.host=10.3.91.121\nsocks.port=1080\n'), 'existing lines untouched')
  assert.ok(!text.includes('#socks.host='), 'no commented duplicate of a live key')
  assert.ok(text.includes('#git.url='))
})

test('finds an existing .env in a parent directory instead of creating a new one', () => {
  const dir = workspace()
  const parentEnv = join(dir, '.env')
  writeFileSync(parentEnv, 'git.url=http://gogs.example/x.git\n')
  const result = ensureEnvTemplate(join(dir, 'sub', 'project'))
  assert.equal(result.path, parentEnv)
  assert.deepEqual(result.added, ['socks.host', 'socks.port', 'proxy.javaRules'])
})

test('treats an existing commented placeholder as configured', () => {
  const dir = workspace()
  writeFileSync(join(dir, '.env'), `${ENV_TEMPLATE_SECTION}\n#git.url=\n#socks.host=\n#socks.port=\n#proxy.javaRules=on\n`)
  const result = ensureEnvTemplate(dir)
  assert.deepEqual(result.added, [])
})

test('reports documented keys that still have no active value', () => {
  const dir = workspace()
  const created = ensureEnvTemplate(dir)
  assert.deepEqual(created.pending, ['git.url', 'socks.host', 'socks.port', 'proxy.javaRules'])
  writeFileSync(join(dir, '.env'), 'git.url=http://gogs.example/x.git\nsocks.host=10.0.0.9\nsocks.port=1080\nproxy.javaRules=on\n')
  assert.deepEqual(envPendingKeys(dir).keys, [])
})

test('an explicit acknowledgement stops the prompt without hiding missing keys', () => {
  const dir = workspace()
  writeFileSync(join(dir, '.env'), `socks.host=10.0.0.9\n${ENV_TEMPLATE_ACK}\n`)
  const result = ensureEnvTemplate(dir)
  assert.deepEqual(result.pending, [])
  assert.equal(result.acknowledged, true)
  assert.ok(readFileSync(result.path, 'utf8').includes('#git.url='), 'missing key is still documented')
  assert.deepEqual(envPendingKeys(dir).keys, [])
})

test('only a confirmed yds project (settings.json with yds.* keys) gets the template', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'yds-scratch-'))
  await run(['doctor'], { cwd: scratch })
  assert.equal(existsSync(join(scratch, '.env')), false, 'a non-yds directory is left untouched')

  const ws = mkdtempSync(join(tmpdir(), 'yds-project-'))
  mkdirSync(join(ws, 'proj', '.vscode'), { recursive: true })
  writeFileSync(join(ws, 'proj', '.vscode', 'settings.json'), JSON.stringify({
    'yds.workbenchUrl': 'https://srmdev.hanslaser.com',
    'yds.accessKey': 'ak',
    'yds.accessSecret': 'as',
    'yds.serverBindAddress': '127.0.0.1',
    'yds.serverPort': 31010,
  }))
  await run(['doctor'], { cwd: ws })
  assert.equal(existsSync(join(ws, '.env')), true, 'a yds project gets the documented template')
})
