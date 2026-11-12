#!/usr/bin/env node
// yds — YonBIP YDS local runtime CLI (dsh-ris-yds). Cross-OS node entry.
import { run } from '../lib/cli.js'

const argv = process.argv.slice(2)
try {
  const result = await run(argv, { cwd: process.cwd() })
  if (result !== undefined && result.text !== undefined) {
    process.stdout.write(`${result.text}\n`)
  }
  // run() reports failures instead of setting process.exitCode: the same function is
  // called in-process by the dsh tools, where a leaked exit code would hit the host.
  if (Number.isInteger(result?.exitCode) && result.exitCode !== 0) {
    process.exitCode = result.exitCode
  }
} catch (error) {
  process.stderr.write(`yds: ${error.message}\n`)
  process.exitCode = 1
}
