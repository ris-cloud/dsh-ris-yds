// Failures an agent reads must carry the command that fixes them: yds can start the
// local runtime (and the forwarded tunnel) itself, so the message says so.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const cli = readFileSync(new URL('../lib/cli.js', import.meta.url), 'utf8')

test('status and doctor point at `yds start` when the runtime is not running', () => {
  assert.match(cli, /提示: 运行 yds start 可拉起本地运行时（YMS）/, 'doctor hints the start command')
  assert.match(cli, /YMS 进程: .*提示: 运行 yds start 可拉起本地运行时（YMS）/, 'status does too')
  assert.match(cli, /未运行（yds start \/ yds proxy start 会拉起）/, 'the tunnel path keeps its hint')
})
