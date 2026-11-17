// The live dev-server port comes from a program's log, not from `yds.webConfig`:
// the declared port goes stale when the bundler falls forward to the next free one,
// and the extension rewrites the module bundle to whichever port this answers.
import assert from 'node:assert/strict'
import test from 'node:test'

import { forgetLiveDevPort, LIVE_PORT_TTL_MS, liveDevPort, portOfUrl, rememberLiveDevPort } from '../lib/live-port.js'

test('a remembered port is answered back, and forgotten on request', () => {
  const dir = '/tmp/yds-live-a'
  forgetLiveDevPort(dir)
  assert.equal(liveDevPort(dir), undefined, 'nothing observed yet')
  rememberLiveDevPort(dir, 3003)
  assert.equal(liveDevPort(dir), 3003)
  rememberLiveDevPort(dir, 3004)
  assert.equal(liveDevPort(dir), 3004, 'the newest observation wins')
  forgetLiveDevPort(dir)
  assert.equal(liveDevPort(dir), undefined)
})

test('an observation goes stale instead of lying about a dead port', () => {
  const dir = '/tmp/yds-live-b'
  const at = 1_000_000
  rememberLiveDevPort(dir, 3003, at)
  assert.equal(liveDevPort(dir, at + LIVE_PORT_TTL_MS), 3003, 'still fresh at the boundary')
  assert.equal(liveDevPort(dir, at + LIVE_PORT_TTL_MS + 1), undefined, 'stale after the TTL')
  // The stale entry is dropped, so a later read does not re-check the clock.
  assert.equal(liveDevPort(dir, at), undefined)
  forgetLiveDevPort(dir)
})

test('nonsense is never remembered (a bad port would break the injection)', () => {
  const dir = '/tmp/yds-live-c'
  for (const port of [0, -1, 65536, 3.5, Number.NaN, '3003']) rememberLiveDevPort(dir, port)
  assert.equal(liveDevPort(dir), undefined)
  rememberLiveDevPort('', 3003)
  rememberLiveDevPort(undefined, 3003)
  assert.equal(liveDevPort(''), undefined)
})

test('portOfUrl reads an explicit port and nothing else', () => {
  assert.equal(portOfUrl('http://127.0.0.1:3003/'), 3003)
  assert.equal(portOfUrl('  http://localhost:5199/menu  '), 5199)
  assert.equal(portOfUrl('https://srmdev.hanslaser.com/mod'), undefined, 'no port means no answer')
  assert.equal(portOfUrl('not a url'), undefined)
  assert.equal(portOfUrl(''), undefined)
  assert.equal(portOfUrl(undefined), undefined)
})
