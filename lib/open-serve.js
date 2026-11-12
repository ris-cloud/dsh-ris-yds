// Per-process registry of the injecting proxies one workspace can need.
//
// A dev server is a long-lived thing and so is the tab that talks to it: the proxy
// must be reused (a new port per click would lose the page's cookies and its HMR
// socket), and it must be closed when the plugin unloads (a stray listener on a
// 13xxx port survives a reload and then blocks the next one).

import { findProjectDir, resolveConfig } from './config.js'
import { requestRedirects } from './fe-dev.js'
import { startOpenSite } from './open-site.js'

/** devUrl -> { url, port, site, at } */
const running = new Map()

/** Everything a caller needs to show "open in browser", without starting anything. */
export function openSiteStatus(workspace) {
  const { config } = resolveConfig(workspace)
  const devUrl = typeof config?.frontend?.devUrl === 'string' ? config.frontend.devUrl : ''
  const key = siteKey(devUrl, config?.workbenchUrl)
  const hit = running.get(key)
  return {
    devUrl,
    workbenchUrl: String(config?.workbenchUrl ?? ''),
    module: String(config?.module ?? ''),
    fePort: Number.isInteger(config?.fePort) ? config.fePort : 0,
    open: hit === undefined ? null : { url: hit.url, port: hit.port },
  }
}

/**
 * Is this workspace a yds project, and if so which frontends does it declare?
 *
 * Cheap on purpose: it reads `.vscode/settings.json` (no port probing, no `.env`,
 * no config resolution), because the ris-ide console calls it on every refresh to
 * decide whether a row may promise a token. `findProjectDir` returns the project
 * root whose settings carry `yds.*` keys, or null for an ordinary workspace.
 * @param {string} workspace - absolute workspace path.
 */
export function probeWorkspace(workspace) {
  const found = findProjectDir(workspace)
  if (found === null) return { ok: true, yds: false, projectDir: null, frontends: [] }
  const webConfig = found.settings?.['yds.webConfig']
  const frontends = webConfig !== null && typeof webConfig === 'object'
    ? Object.keys(webConfig).filter((key) => key !== 'yds.localWorkbenchPort' && webConfig[key] !== null && typeof webConfig[key] === 'object')
    : []
  return { ok: true, yds: true, projectDir: found.dir, frontends }
}

function siteKey(devUrl, workbenchUrl) {
  return `${String(devUrl)}|${String(workbenchUrl ?? '')}`
}

/**
 * Start (or reuse) the injecting proxy for one workspace's dev server.
 *
 * The proxy rewrites the platform's `extend*.min.js|css` to the dev server (what
 * the Resource Override extension does) and attaches a fresh YYCToken to the page's
 * gateway calls, so a yds page opens without a login round-trip.
 * @param {string} workspace - absolute workspace path.
 * @param {object} [options]
 * @param {string} [options.devUrl] - override the dev server address.
 * @returns {Promise<{ok: boolean, code?: string, reason?: string, url?: string,
 *   port?: number, devUrl?: string, reused?: boolean, rules?: number}>}
 */
export async function openSite(workspace, options = {}) {
  const { config } = resolveConfig(workspace)
  const devUrl = typeof options.devUrl === 'string' && options.devUrl !== ''
    ? options.devUrl
    : (typeof config?.frontend?.devUrl === 'string' ? config.frontend.devUrl : '')
  if (devUrl === '') {
    return { ok: false, code: 'no-dev-server', reason: '这个工作区没有前端 dev server 地址（项目里没有 yds.webConfig 的端口）' }
  }
  const key = siteKey(devUrl, config?.workbenchUrl)
  const hit = running.get(key)
  if (hit !== undefined) {
    return { ok: true, url: hit.url, port: hit.port, devUrl, reused: true, rules: hit.rules }
  }
  const rules = requestRedirects(config)
  const site = await startOpenSite(config, { devUrl, rules })
  running.set(key, { url: site.url, port: site.port, site, at: Date.now(), rules: rules.length })
  return { ok: true, url: site.url, port: site.port, devUrl, reused: false, rules: rules.length }
}

/** Close every proxy this process started (plugin unload / test teardown). */
export async function closeOpenSites() {
  const sites = [...running.values()]
  running.clear()
  for (const item of sites) {
    try {
      await item.site.close()
    } catch {
      // A listener that already went away is not an error worth surfacing.
    }
  }
}
