// Front-end dev-server wiring: both rules and the CDP plan are generated from the
// project config, so one edit (port, module, host) changes every surface at once.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FE_PORT,
  assetRules,
  feConfig,
  globToDnrRegex,
  pageUrlWithScriptUrl,
  requestRedirects,
} from '../lib/fe-dev.js'

const cfg = {
  workspace: '',
  module: 'c-ass-kk-hans',
  workbenchUrl: 'https://srmdev.hanslaser.com',
  fePort: 3004,
}

test('the rules follow the project, not a hand-edited copy', () => {
  const rules = assetRules(cfg)
  assert.equal(rules.length, 7)
  // The two dynamic values: module and workbench host.
  assert.match(rules[0].match, /c-ass-kk-hans/)
  assert.match(rules[6].match, /^https:\/\/srmdev\.hanslaser\.com\/c-ass-kk-hans-festatic\/\*$/)
  assert.equal(rules[0].replace, 'http://127.0.0.1:3004/static/javascripts/extend.js')
  assert.equal(rules[6].replace, 'http://127.0.0.1:3004/static/*')
  // A different project/port produces different rules with no other edits.
  const other = assetRules({ module: 'st-storein', workbenchUrl: 'https://tj.example.com', fePort: 4321 })
  assert.match(other[0].match, /st-storein/)
  assert.equal(other[0].replace, 'http://127.0.0.1:4321/static/javascripts/extend.js')
  assert.match(other[6].match, /tj\.example\.com/)
})

test('feConfig falls back to the documented defaults', () => {
  const bare = feConfig({})
  assert.equal(bare.module, '')
  assert.equal(bare.host, '')
  assert.equal(bare.fePort, DEFAULT_FE_PORT)
  const configured = feConfig({ module: 'mod', workbenchUrl: 'https://m.example.com/x', fePort: 4567 })
  assert.equal(configured.host, 'm.example.com')
  assert.equal(configured.staticBase, 'http://127.0.0.1:4567/static')
})

test('glob → regex keeps the capture semantics', () => {
  // Last star becomes a capture group (used by \1), the second-to-last becomes
  // [^/]+ so a trailing segment is not swallowed, the rest are .*
  const withSuffix = globToDnrRegex('https://*/mod/*/js/extend*.min.js*', 'http://127.0.0.1:3004/static/js/extend.js')
  assert.equal(withSuffix.regex, '^https://.*/mod/.*/js/extend[^/]+\\.min\\.js(.*)$')
  const filePrefix = globToDnrRegex('https://host/mod-festatic/*', 'http://127.0.0.1:3004/static/*')
  assert.equal(filePrefix.regex, '^https://host/mod-festatic/(.*)$')
  assert.equal(filePrefix.substitution, 'http://127.0.0.1:3004/static/\\1')
  // Anchored, because the browser's DNR match is anchored too.
  assert.ok(filePrefix.regex.startsWith('^') && filePrefix.regex.endsWith('$'))
})

test('the plan is the same seven rules as redirects an agent can apply', () => {
  const redirects = requestRedirects(cfg)
  assert.equal(redirects.length, 7)
  for (const item of redirects) {
    assert.equal(typeof item.regex, 'string')
    assert.ok(item.regex.length > 2)
    assert.equal(typeof item.substitution, 'string')
    // The regex must actually match the glob's own URL shape.
    const sample = item.match.replace('*', 'srmdev.hanslaser.com')
    const probe = sample.replace(/\*/g, 'x')
    assert.match(probe, new RegExp(item.regex), item.regex)
  }
})

test('scriptUrl is appended to a page without any extension', () => {
  const url = pageUrlWithScriptUrl(cfg, '/mdf-node/meta/voucherlist/st_purchaseorderlist?domainKey=upu')
  const parsed = new URL(url)
  assert.equal(parsed.host, 'srmdev.hanslaser.com')
  assert.equal(parsed.searchParams.get('scriptUrl'), 'http://127.0.0.1:3004/static')
  // The page's own parameters survive.
  assert.equal(parsed.searchParams.get('domainKey'), 'upu')
})

test('no page means no URL (rather than a bare workspace link)', () => {
  assert.equal(pageUrlWithScriptUrl(cfg, ''), '')
})
