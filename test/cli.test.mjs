import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  browserCookieHint,
  expectedRdbga,
  healBrowserCookie,
  noDevtoolsHint,
  run,
} from '../lib/cli.js'
import { rdbgaValue } from '../lib/yms.js'

// The suite runs in its own process but inherits the developer's shell: strip every
// YDS_* override so each case sees only the fixture workspace below.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('YDS_')) delete process.env[key]
}

const WORKBENCH = 'https://srmdev.hanslaser.com'
const WORKBENCH_HOST = 'srmdev.hanslaser.com'
const CFG = {
  module: 'c-ass-kk-hans',
  context: '/',
  serverBindAddress: '172.20.63.131',
  serverPort: 31010,
  workbenchUrl: WORKBENCH,
}
const EXPECTED = rdbgaValue(CFG)
const TARGETS = [{ type: 'page', url: `${WORKBENCH}/`, webSocketDebuggerUrl: 'ws://a' }]
const NO_PORT = { port: 0, targets: [], hosts: [], error: '没有开着工作台页签的 DevTools 端口（浏览器未启动或未打开工作台）' }
const FOUND = { port: 9222, targets: TARGETS, hosts: [WORKBENCH_HOST], error: '' }
const NO_LIVE = async () => ({ ok: false, values: [], error: 'no powershell' })

/**
 * A throwaway workspace with no project config. A remembered yms port keeps config
 * resolution from spawning a child to find a free one.
 */
function emptyWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'yds-cli-'))
  mkdirSync(join(dir, '.dsh-ris-yds'), { recursive: true })
  writeFileSync(join(dir, '.dsh-ris-yds', 'yms-port'), '65000')
  return dir
}

async function runInEmptyWorkspace(argv) {
  const dir = emptyWorkspace()
  try {
    return await run(argv, { cwd: dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('an unknown browser action is rejected before any port is probed', async () => {
  const result = await runInEmptyWorkspace(['browser', 'frobnicate'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /未知动作: frobnicate/)
  assert.match(result.text, /用法: yds browser/)
})

test('extra positional arguments are reported, not silently ignored', async () => {
  const result = await runInEmptyWorkspace(['browser', 'status', 'extra'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /多余参数: extra/)
})

test('an unknown option is reported, not silently ignored', async () => {
  const result = await runInEmptyWorkspace(['browser', 'status', '--bogus'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /未知选项: --bogus/)
})

test('an empty --rdbga is rejected instead of silently falling back', async () => {
  const result = await runInEmptyWorkspace(['browser', 'status', '--rdbga='])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /--rdbga 需要一个 base64 值/)
})

test('--dry-run is refused for the read-only action', async () => {
  const result = await runInEmptyWorkspace(['browser', 'status', '--dry-run'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /--dry-run 只用于 fix/)
})

test('an unknown command exits non-zero and prints the usage', async () => {
  const result = await runInEmptyWorkspace(['frobnicate'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /用法: node yds\.js <command>/)
})

test('unknown actions of the other commands are rejected as well', async () => {
  for (const argv of [['fe', 'bogus'], ['yoncode', 'bogus'], ['proxy', 'bogus'], ['ide', 'bogus']]) {
    const result = await runInEmptyWorkspace(argv)
    assert.equal(result.exitCode, 1, argv.join(' '))
    assert.match(result.text, /未知动作/)
  }
})

test('a missing workbench URL is named, and no sentence gets a double space', async () => {
  const result = await runInEmptyWorkspace(['browser', 'status'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /workbenchUrl 未配置/)
  assert.match(result.text, /无法从 workbenchUrl 推断工作台域名/)
  assert.doesNotMatch(result.text, /在\s{2,}域/)
  assert.doesNotMatch(result.text, /手工在 {2,}/)
})

test('cookie hints degrade gracefully without a workbench URL', () => {
  assert.match(browserCookieHint({ workbenchUrl: '' }, EXPECTED), /workbenchUrl 未配置/)
  assert.ok(browserCookieHint({ workbenchUrl: '' }, EXPECTED).includes(`rdbga=${EXPECTED}`))
  assert.ok(browserCookieHint({ workbenchUrl: WORKBENCH }, EXPECTED).includes(`在 ${WORKBENCH} 域下种 cookie`))
  assert.doesNotMatch(browserCookieHint({}, EXPECTED), /在 {2,}域/)

  assert.match(noDevtoolsHint({ workbenchUrl: '' }), /workbenchUrl 未配置/)
  assert.doesNotMatch(noDevtoolsHint({}), /在\s{2,}域/)
  assert.ok(noDevtoolsHint({ workbenchUrl: WORKBENCH }).includes(`在 ${WORKBENCH} 域下`))
})

test('the expected value comes only from what can be verified', async () => {
  const own = rdbgaValue(CFG)
  assert.deepEqual(
    await expectedRdbga(CFG, '', { liveQuery: NO_LIVE }),
    { ok: true, value: own, source: '本机配置', hint: 'no powershell' },
  )
  const agree = await expectedRdbga(CFG, '', { liveQuery: async () => ({ ok: true, values: [own], error: '' }) })
  assert.equal(agree.source, '运行中的 JVM')
  assert.equal(agree.value, own)

  const other = Buffer.from('other,/@1.2.3.4:1').toString('base64')
  const disagree = await expectedRdbga(CFG, '', {
    liveQuery: async () => ({ ok: true, values: [other, 'Zm9v'], error: '' }),
  })
  assert.equal(disagree.ok, false)
  // The rule must be explainable: how many JVMs were seen, which values, and that none
  // matches the configured one.
  assert.match(disagree.reason, /2 个实例/)
  assert.ok(disagree.reason.includes(`${other.slice(0, 10)}…`))
  assert.match(disagree.reason, /都不一致/)
  assert.match(disagree.reason, /--rdbga/)

  const override = await expectedRdbga(CFG, own, { liveQuery: async () => ({ ok: true, values: ['x'], error: '' }) })
  assert.deepEqual({ ok: override.ok, value: override.value, source: override.source }, { ok: true, value: own, source: '命令行指定' })

  const bad = await expectedRdbga(CFG, 'not base64 !!', { liveQuery: NO_LIVE })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /base64|解码/)

  const noModule = await expectedRdbga({ ...CFG, module: null }, '', { liveQuery: NO_LIVE })
  assert.match(noModule.reason, /模块名/)
  const badBind = await expectedRdbga({ ...CFG, serverBindAddress: 'localhost' }, '', { liveQuery: NO_LIVE })
  assert.match(badBind.reason, /serverBindAddress/)
  const badPort = await expectedRdbga({ ...CFG, serverPort: 70000 }, '', { liveQuery: NO_LIVE })
  assert.match(badPort.reason, /serverPort/)
})

test('a dry run plans the repair but never reads back or writes', async () => {
  const logged = []
  let reads = 0
  const result = await healBrowserCookie(CFG, {
    log: (line) => logged.push(line),
    dryRun: true,
    findPort: async () => FOUND,
    liveQuery: NO_LIVE,
    repair: async ({ dryRun }) => ({ ok: true, tabs: 1, removed: 2, wrote: 1, set: EXPECTED, dryRun }),
    read: async () => { reads += 1; return { ok: true, cookies: [] } },
  })
  assert.deepEqual(
    { ok: result.ok, dryRun: result.dryRun, removed: result.removed, wrote: result.wrote, source: result.source },
    { ok: true, dryRun: true, removed: 2, wrote: 1, source: '本机配置' },
  )
  assert.equal(reads, 0)
  assert.match(logged.join('\n'), /预览/)
})

test('the port is probed before the PowerShell query: no port, no cost', async () => {
  const order = []
  const noPort = await healBrowserCookie(CFG, {
    findPort: async () => { order.push('find'); return NO_PORT },
    liveQuery: async () => { order.push('live'); return { ok: false, values: [], error: '' } },
  })
  assert.equal(noPort.ok, false)
  assert.match(noPort.reason, /没有开着工作台页签/)
  assert.deepEqual(order, ['find'])

  order.length = 0
  const healed = await healBrowserCookie(CFG, {
    findPort: async () => { order.push('find'); return FOUND },
    liveQuery: async () => { order.push('live'); return { ok: false, values: [], error: 'no powershell' } },
    repair: async () => ({ ok: true, tabs: 1, removed: 0, wrote: 0, set: EXPECTED }),
    read: async () => ({
      ok: true,
      cookies: [{ name: 'rdbga', value: EXPECTED, domain: `.${WORKBENCH_HOST}`, path: '/' }],
    }),
  })
  assert.deepEqual(order, ['find', 'live'])
  assert.deepEqual({ ok: healed.ok, port: healed.port, source: healed.source }, { ok: true, port: 9222, source: '本机配置' })
})

test('a repair that leaves a wrong cookie behind is a failure, not a success', async () => {
  const result = await healBrowserCookie(CFG, {
    findPort: async () => FOUND,
    liveQuery: NO_LIVE,
    repair: async () => ({ ok: true, tabs: 1, removed: 1, wrote: 1, set: EXPECTED }),
    read: async () => ({
      ok: true,
      cookies: [
        { name: 'rdbga', value: EXPECTED, domain: `.${WORKBENCH_HOST}`, path: '/' },
        { name: 'rdbga', value: '', domain: WORKBENCH_HOST, path: '/' },
      ],
    }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /写入后仍有多个/)
})

test('an unreadable cookie store after the repair is a failure, not a fake success', async () => {
  const result = await healBrowserCookie(CFG, {
    findPort: async () => FOUND,
    liveQuery: NO_LIVE,
    repair: async () => ({ ok: true, tabs: 1, removed: 1, wrote: 1, set: EXPECTED }),
    read: async () => ({ ok: false, cookies: [], error: 'CDP 断开' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /回读 cookie 失败: CDP 断开/)
})

test('a failed repair is reported with the browser error text', async () => {
  const result = await healBrowserCookie(CFG, {
    findPort: async () => FOUND,
    liveQuery: NO_LIVE,
    repair: async () => ({ ok: false, error: '所有页签都失败' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /所有页签都失败/)
})

test('the budget cuts off a browser that keeps the repair hanging', async () => {
  const started = Date.now()
  const result = await healBrowserCookie(CFG, { budgetMs: 30, findPort: () => new Promise(() => {}) })
  assert.equal(result.ok, false)
  assert.match(result.reason, /超时/)
  assert.ok(Date.now() - started < 1000)
})
