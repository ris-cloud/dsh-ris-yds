import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SW = join(here, '..', 'assets', 'dev-extension', 'sw.js')

// Chrome's DeclarativeNetRequest.ResourceType, as the stable protocol enumerates
// them. The list is validated strictly: ONE member Chrome does not know makes the
// whole `updateDynamicRules` call throw "Value must be one of …", and the extension
// ends up with ZERO rules (that is exactly what the stray `dtd` did on Chrome 136).
const KNOWN = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webbundle',
  'webtransport', 'other',
])

function assertKnown(list, where) {
  const types = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(types.length > 0, `${where}: expected at least one resource type`)
  for (const type of types) {
    assert.ok(KNOWN.has(type), `${where}: "${type}" is not a DeclarativeNetRequest ResourceType`)
  }
}

test('the extension only names resource types Chrome knows (one bad member kills every rule)', () => {
  const source = readFileSync(SW, 'utf8')
  const constant = /const RESOURCE_TYPES = \[([\s\S]*?)\]/.exec(source)
  assert.ok(constant !== null, 'RESOURCE_TYPES must stay a literal array so this test can check it')
  assertKnown(constant[1], 'RESOURCE_TYPES')
  for (const inline of source.matchAll(/resourceTypes: \[([^\]]*)\]/g)) assertKnown(inline[1], 'inline resourceTypes')
})
