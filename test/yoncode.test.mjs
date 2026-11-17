/**
 * YonCode bundle patch: detection and the patch/restore round trip, done on a
 * fake installation so the real Program Files copy is never touched.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  YONCODE_EXTENSION_RELATIVE,
  detectYoncode,
  patchYoncode,
  restoreYoncode,
  yoncodeWarning,
} from '../lib/yoncode.js'

const SHIPPED_WITH_VMARGS = `const VM_ARGS = \`-Dapp.metainfo.ping_connect_timeout=200 -Dapp.metainfo.preferred-networks=\${command:yds.serverBindAddress} -Dserver.port=\${config:yds.serverPort}\`.replaceAll(/\s+/g, ' ');

function getServerBindAddress() {
    if (!_util.ipv4IsValid(ipv4)) {
        throw new Error("Invalid IP address, no interface found with address " + ipv4 + ".");
    }
}
`

const SHIPPED = `
function getServerBindAddress() {
    let ipv4 = _vscode.workspace.getConfiguration().get(_config.KEY_SERVER_BIND_ADDRESS);
    if (!ipv4) {
        ipv4 = _util.getIpv4Address(pattern);
    } else {
        if (!_util.ipv4IsValid(ipv4)) {
            throw new Error("Invalid IP address, no interface found with address " + ipv4 + ".");
        }
    }
    return ipv4;
}
`

/** Build a fake YonCode install whose bundle holds `text`. */
function fakeInstall(text) {
  const home = mkdtempSync(join(tmpdir(), 'yoncode-'))
  const file = join(home, YONCODE_EXTENSION_RELATIVE)
  mkdirSync(join(home, 'resources/app/extensions/yonbuilder-development-studio-core/dist'), { recursive: true })
  writeFileSync(file, text)
  return { home, file }
}

test('an unpatched bundle is detected as unpatched and reported as a problem', () => {
  const { home } = fakeInstall(SHIPPED)
  try {
    const detected = detectYoncode({ yoncodeHome: home })
    assert.equal(detected.state, 'unpatched')
    assert.match(yoncodeWarning(detected), /YonCode/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('patch turns the throw into a warning, keeps a backup, and is idempotent', () => {
  const { home, file } = fakeInstall(SHIPPED)
  try {
    const first = patchYoncode(detectYoncode({ yoncodeHome: home }))
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    const patched = readFileSync(file, 'utf8')
    assert.match(patched, /yds-patch/)
    assert.doesNotMatch(patched, /throw new Error\("Invalid IP address/)
    assert.equal(existsSync(`${file}.bak`), true, 'the original must be recoverable')
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), SHIPPED)

    const second = patchYoncode(detectYoncode({ yoncodeHome: home }))
    assert.equal(second.ok, true)
    assert.equal(second.changed, false, 'patching twice must be a no-op')

    const detected = detectYoncode({ yoncodeHome: home })
    assert.equal(detected.state, 'patched')
    assert.equal(yoncodeWarning(detected), null, 'no warning once patched')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('restore puts the shipped file back', () => {
  const { home, file } = fakeInstall(SHIPPED)
  try {
    patchYoncode(detectYoncode({ yoncodeHome: home }))
    const restored = restoreYoncode(detectYoncode({ yoncodeHome: home }))
    assert.equal(restored.ok, true)
    assert.equal(readFileSync(file, 'utf8'), SHIPPED)
    assert.equal(detectYoncode({ yoncodeHome: home }).state, 'unpatched')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unknown bundle shape is left alone instead of guessed at', () => {
  const { home, file } = fakeInstall('function somethingElse() { return 1 }\n')
  try {
    const detected = detectYoncode({ yoncodeHome: home })
    assert.equal(detected.state, 'unrecognised')
    const result = patchYoncode(detected)
    assert.equal(result.ok, false)
    assert.equal(readFileSync(file, 'utf8'), 'function somethingElse() { return 1 }\n')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('no installation is reported as absent, not as an error', () => {
  const detected = detectYoncode({ yoncodeHome: join(tmpdir(), 'definitely-not-installed-xyz') })
  assert.equal(detected.found, false)
  assert.equal(detected.state, 'absent')
  assert.equal(yoncodeWarning(detected), null)
})

test('the JVM SOCKS flags are appended to the YMS launch arguments', () => {
  const { home, file } = fakeInstall(SHIPPED_WITH_VMARGS)
  try {
    const socks = { host: '10.3.91.121', port: 1080 }
    const first = patchYoncode(detectYoncode({ yoncodeHome: home }), { socks })
    assert.equal(first.ok, true)
    assert.equal(first.changed, true)
    assert.equal(first.socksState, 'patched')
    const patched = readFileSync(file, 'utf8')
    assert.match(patched, /-Dserver\.port=\$\{config:yds\.serverPort\} -DsocksProxyHost=10\.3\.91\.121 -DsocksProxyPort=1080/)
    assert.match(patched, /yds-patch/, 'the NIC patch lands in the same write')

    const second = patchYoncode(detectYoncode({ yoncodeHome: home }), { socks })
    assert.equal(second.changed, false, 're-patching must not stack flags')
    assert.equal(detectYoncode({ yoncodeHome: home }).socksState, 'patched')

    const moved = patchYoncode(detectYoncode({ yoncodeHome: home }), { socks: { host: '10.0.0.9', port: 7890 } })
    assert.equal(moved.changed, true, 'a different SOCKS server replaces the old flags')
    const replaced = readFileSync(file, 'utf8')
    assert.equal(replaced.includes('10.0.0.9:'), false)
    assert.match(replaced, /-DsocksProxyHost=10\.0\.0\.9 -DsocksProxyPort=7890/)
    assert.equal((replaced.match(/-DsocksProxyHost/g) ?? []).length, 1)

    restoreYoncode(detectYoncode({ yoncodeHome: home }))
    assert.equal(readFileSync(file, 'utf8'), SHIPPED_WITH_VMARGS, 'restore also drops the JVM flags')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a bundle without the vmArgs template reports why the JVM flags were skipped', () => {
  const { home } = fakeInstall(SHIPPED)
  try {
    const r = patchYoncode(detectYoncode({ yoncodeHome: home }), { socks: { host: '10.3.91.121', port: 1080 } })
    assert.equal(r.ok, false)
    assert.equal(r.socksState, 'unrecognised')
    assert.match(r.error, /启动参数模板/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
