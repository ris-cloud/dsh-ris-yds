// Front-end dev-server wiring: the override rules are generated from the project
// config, and the same rules are exposed as regex+substitution pairs so an agent
// can redirect requests through CDP instead of installing the extension.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_FE_PORT,
  globToDnrRegex,
  overrideRules,
  pageUrlWithScriptUrl,
  requestRedirects,
  writeOverrideRules,
} from '../lib/fe-dev.js'

const cfg = {
  workspace: '',
  module: 'c-ass-kk-hans',
  workbenchUrl: 'https://srmdev.hanslaser.com',
  fePort: 3004,
}

test('the rules follow the project, not the copy that was hand-edited', () => {
  const rules = overrideRules(cfg)
  const list = rules.ruleGroups[0].rules
  assert.equal(rules.v, 2)
  assert.equal(list.length, 7)
  // The three dynamic values: module, workbench host, dev port.
  assert.match(list[0].match, /c-ass-kk-hans/)
  assert.match(list[6].match, /^https:\/\/srmdev\.hanslaser\.com\/c-ass-kk-hans-festatic\/\*$/)
  assert.match(list[0].replace, /^http:\/\/127\.0\.0\.1:3004\/static\/javascripts\/extend\.js$/)
  // A different project/port produces different rules with no other edits.
  const other = overrideRules({ module: 'st-storein', workbenchUrl: 'https://tj.example.com', fePort: 4321 })
  assert.match(other.ruleGroups[0].rules[0].match, /st-storein/)
  assert.match(other.ruleGroups[0].rules[0].replace, /127\.0\.0\.1:4321/)
  assert.match(other.ruleGroups[0].rules[6].match, /tj\.example\.com/)
})

test('glob → regex keeps the extension’s capture semantics', () => {
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

test('the rule file is written where the extension can import it', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'yds-fe-'))
  try {
    const written = writeOverrideRules({ ...cfg, workspace })
    assert.equal(written.path, join(workspace, '.dsh-ris-yds', 'resource-override-rules.json'))
    assert.equal(written.rules, 7)
    assert.equal(written.module, 'c-ass-kk-hans')
    assert.equal(written.fePort, DEFAULT_FE_PORT)
    assert.ok(existsSync(written.path))
    const parsed = JSON.parse(readFileSync(written.path, 'utf8'))
    assert.equal(parsed.ruleGroups[0].rules.length, 7)
    assert.equal(parsed.ruleGroups[0].rules[0].type, 'normalOverride')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('scriptUrl is appended to a page without any extension', () => {
  const url = pageUrlWithScriptUrl(cfg, '/mdf-node/meta/voucherlist/st_purchaseorderlist?domainKey=upu')
  const parsed = new URL(url)
  assert.equal(parsed.host, 'srmdev.hanslaser.com')
  assert.equal(parsed.searchParams.get('scriptUrl'), 'http://127.0.0.1:3004/static')
  // The page's own parameters survive.
  assert.equal(parsed.searchParams.get('domainKey'), 'upu')
  assert.equal(pageUrlWithScriptUrl(cfg, ''), '')
})
