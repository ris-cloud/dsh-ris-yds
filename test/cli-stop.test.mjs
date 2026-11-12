// `yds stop` must not tear the tunnel down under a YMS it could not stop, and its
// summary must say how much of the shared rule table actually changed (review
// D-P1-2 / D-P2-7).
import assert from 'node:assert/strict'
import test from 'node:test'

import { stopAbortReason, withdrawnText } from '../lib/cli.js'

test('stop aborts when a live YMS pid could not be stopped', () => {
  const reason = stopAbortReason({ stopped: false, pid: 4242, reason: '停止失败：Access is denied（已保留 pidfile）' })
  assert.match(reason, /4242/)
  assert.match(reason, /已中止/)
  assert.match(reason, /--force/)
  assert.match(reason, /Access is denied/, 'the original failure is surfaced')
})

test('stop continues when nothing is running or the stop succeeded', () => {
  assert.equal(stopAbortReason({ stopped: false, reason: '未在运行' }), '', 'no pid => nothing to protect')
  assert.equal(stopAbortReason({ stopped: false, pid: 0 }), '')
  assert.equal(stopAbortReason({ stopped: true, pid: 4242 }), '')
})

test('--force overrides the guard', () => {
  assert.equal(stopAbortReason({ stopped: false, pid: 4242, reason: 'unknown' }, { force: true }), '')
})

test('the summary reports what was withdrawn instead of a blanket claim', () => {
  assert.match(withdrawnText({ rules: 2, hosts: 3 }), /2 条规则/)
  assert.match(withdrawnText({ rules: 2, hosts: 3 }), /3 个 host/)
  assert.match(withdrawnText({ rules: 2, hosts: 3 }), /全局一张表，不区分 workspace/)
  assert.doesNotMatch(withdrawnText({ rules: 2, hosts: 3 }), /其它 workspace 的规则保留/)
})

test('a stop that changed nothing says so', () => {
  for (const withdrawn of [{ rules: 0, hosts: 0 }, undefined, {}]) {
    const text = withdrawnText(withdrawn)
    assert.match(text, /共享规则表里没有 yds 规则（未改动）/)
    assert.doesNotMatch(text, /已撤掉/)
  }
})
