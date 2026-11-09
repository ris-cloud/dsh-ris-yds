// Config resolution without any .env: the local listen port is discovered, the
// front-end port comes from the project (yds.webConfig, else the front end's own
// override file), and nothing machine-specific has to be configured by hand.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_FE_PORT,
  discoverFrontend,
  findFreePort,
  isPortFree,
  pickFrontend,
  portOfUrl,
  readRememberedPort,
} from '../lib/config.js'

/** A throwaway project directory; callers remove it in a finally block. */
function tempProject() {
  return mkdtempSync(join(tmpdir(), 'yds-config-'))
}

test('yds.webConfig picks the entry whose domainKey is the module', () => {
  const webConfig = {
    'some-other-fe': { 'yds.domainKey': 'other', 'yds.localDevUrl': 'http://127.0.0.1:9999' },
    'c-ass-kk-hans-fe': { 'yds.domainKey': 'c-ass-kk-hans', 'yds.localDevUrl': 'http://127.0.0.1:3004', 'yds.debugScript': 'debug' },
  }
  const frontend = pickFrontend(webConfig, 'c-ass-kk-hans')
  assert.equal(frontend.code, 'c-ass-kk-hans-fe')
  assert.equal(frontend.port, 3004)
  assert.equal(frontend.debugScript, 'debug')
})

test('a single entry wins even when the domainKey differs', () => {
  const frontend = pickFrontend({ 'x-fe': { 'yds.localDevUrl': 'http://127.0.0.1:4100' } }, 'must-not-matter')
  assert.equal(frontend.port, 4100)
})

test('no webConfig at all still yields the historical default', () => {
  const frontend = pickFrontend(undefined, 'c-ass-kk-hans')
  assert.equal(frontend.port, DEFAULT_FE_PORT)
})

test('discoverFrontend reads the port from the front end own override file', () => {
  const dir = tempProject()
  try {
    mkdirSync(join(dir, 'c-ass-kk-hans-fe'))
    writeFileSync(join(dir, 'c-ass-kk-hans-fe', 'resource_override_rules.json'), JSON.stringify({
      v: 2,
      ruleGroups: [{ rules: [{ replace: 'https://127.0.0.1:4567/static/javascripts/index.js' }] }],
    }))
    const frontend = discoverFrontend(dir, 'c-ass-kk-hans')
    assert.equal(frontend.port, 4567)
    assert.equal(frontend.devUrl, 'http://127.0.0.1:4567')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discoverFrontend falls back when the project has no front end', () => {
  const dir = tempProject()
  try {
    assert.equal(discoverFrontend(dir, 'mod').port, DEFAULT_FE_PORT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('portOfUrl understands dev URLs and gives up quietly', () => {
  assert.equal(portOfUrl('http://127.0.0.1:3004'), 3004)
  assert.equal(portOfUrl('https://127.0.0.1:3004/some/path'), 3004)
  assert.equal(portOfUrl('http://127.0.0.1'), 0)
  assert.equal(portOfUrl(''), 0)
})

test('findFreePort skips a port that is already bound', async () => {
  const { createServer } = await import('node:net')
  const busy = await new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const busyPort = busy.address().port
  try {
    assert.equal(isPortFree(busyPort), false)
    const picked = findFreePort(busyPort)
    assert.equal(picked > busyPort, true, `expected a port above ${busyPort}, got ${picked}`)
    assert.equal(isPortFree(picked), true)
  } finally {
    await new Promise((resolve) => busy.close(resolve))
  }
})

test('the remembered port survives a restart and absent state is null', () => {
  const dir = tempProject()
  try {
    assert.equal(readRememberedPort(dir), null)
    writeFileSync(join(dir, 'yms-port'), '31012\n')
    assert.equal(readRememberedPort(dir), 31012)
    writeFileSync(join(dir, 'yms-port'), 'not-a-port\n')
    assert.equal(readRememberedPort(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
