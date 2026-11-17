// Opening a frontend page in yds' own browser: the 🌐 button in ris-ide asks the
// plugin for this, so the decision (yds project? which page? did it start?) lives
// here instead of inside the HTTP handler — it is the part worth testing.
import { join } from 'node:path'

import { resolveConfig } from './config.js'
import { startDebugBrowser } from './dev-browser.js'

/**
 * Start the private debugging browser for a workspace.
 *
 * Only a yds project has a workbench URL and an extension target; for anything else
 * the caller must fall back to the loopback proxy (never launch a browser at about:blank).
 *
 * @param {string} workspace - absolute project directory.
 * @param {{url?: string, port?: number, start?: Function}} [options]
 *   `start` is injectable so the decision can be tested without spawning a browser.
 * @returns {Promise<object>} `{ok:true, mode:'debug', ...launched}` or
 *   `{ok:false, code:'not-yds-project'|'debug-browser', reason}`.
 */
export async function openDebugForWorkspace(workspace, options = {}) {
  const { config, problems } = resolveConfig(workspace)
  if (config?.projectDir == null) {
    return { ok: false, code: 'not-yds-project', reason: problems[0] ?? '当前目录不是 yds 项目（缺 .vscode/settings.json 的 yds.* 配置）' }
  }
  const explicitUrl = typeof options.url === 'string' ? options.url.trim() : ''
  const target = explicitUrl !== ''
    ? explicitUrl
    : (typeof config.workbenchUrl === 'string' ? config.workbenchUrl : '')
  const start = options.start ?? startDebugBrowser
  // The yds PROJECT is the anchor: the generated extension, the pidfile and the cookie
  // snapshot all live in its `.dsh-ris-yds`. Keying them on the passed workspace would
  // scatter them (the button passes the session cwd, the CLI the project dir) and
  // leave two identical extension folders behind — one of them never loaded.
  const anchor = config.projectDir
  // `chromePath` (the project's `yds.chromePath`, YonCode's own Chrome) travels with the
  // workspace: on WSL it is the browser that can actually load the extension, and it is
  // project configuration, so the anchor config must carry it to the launcher.
  const launched = await start(
    { workspace: anchor, stateDir: join(anchor, '.dsh-ris-yds'), projectDir: anchor, chromePath: config.chromePath },
    { url: target === '' ? undefined : target, port: Number(options.port) > 0 ? Number(options.port) : undefined },
  )
  // Every candidate that failed was stopped again, so a result without `ok` is a real
  // failure (no window was left behind): report its reasons verbatim.
  if (launched?.ok !== true) {
    return { ok: false, code: 'debug-browser', reason: launched?.reason ?? '无法启动调试浏览器' }
  }
  // Spread FIRST: the launch result may carry ok:false (DevTools port still warming up).
  return { ...launched, ok: true, mode: 'debug' }
}
