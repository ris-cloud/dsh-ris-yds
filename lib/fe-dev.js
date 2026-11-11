/**
 * Front-end dev-server wiring for the yds project.
 *
 * A yds page loads its extender script from the platform (`/mdf-wh/<domainKey>/…`),
 * but during development it has to come from the local webpack dev server on
 * `http://127.0.0.1:3004/static`. Two ways to get there, and this module serves
 * both:
 *
 * 1. The Resource Override Chrome extension (`yds-chrome-resource-override.crx`)
 *    reads a JSON rule file — {@link writeOverrideRules} generates it from THIS
 *    project's values (module/domainKey, workbench host, dev port) instead of a
 *    hand-edited copy that goes stale the moment the project or the port changes.
 * 2. Without the extension, an agent can intercept requests itself (CDP `Fetch`
 *    domain) — {@link requestRedirects} is the extracted logic of the same rules,
 *    already converted to the regex form a `Fetch.continueRequest({ url })` needs.
 *
 * The regex conversion is a port of the extension's own glob→regex transform, so a
 * rule means the same thing whichever path is used.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's own directory (`lib/` sits directly under it). */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Chrome extension shipped WITH the plugin, so no machine-specific path is needed. */
export const CRX_FILENAME = 'yds-chrome-resource-override.crx'

/** Default webpack dev-server port of the yds front end (`npm run debug:extend`). */
export const DEFAULT_FE_PORT = 3004

/** File the Chrome extension imports (a copy can live anywhere; this is ours). */
export const OVERRIDE_FILENAME = 'resource-override-rules.json'

/**
 * The dynamic half of the override rules, taken from the project's own config.
 *
 * Nothing here is written into the rule text by hand: the module comes from
 * `yonbuilder.json`/the deployed module, the host from `workbenchUrl`, the port
 * from the project (`yds.webConfig` of the front end, else its own override file).
 * @param {object} cfg - resolved yds config.
 * @returns {{module: string, host: string, fePort: number, scriptBase: string, staticBase: string, crxPath: string}} values.
 */
export function feConfig(cfg) {
  const module = typeof cfg?.module === 'string' ? cfg.module : ''
  let host = ''
  try {
    host = new URL(String(cfg?.workbenchUrl ?? '')).host
  } catch {
    host = ''
  }
  const fePort = Number.isInteger(cfg?.fePort) && cfg.fePort > 0 ? cfg.fePort : DEFAULT_FE_PORT
  return {
    module,
    host,
    fePort,
    scriptBase: `http://127.0.0.1:${fePort}/static/javascripts/extend.js`,
    staticBase: `http://127.0.0.1:${fePort}/static`,
    // Shipped inside the plugin: the extension is part of this workflow, so its
    // location is not a machine setting.
    crxPath: existsSync(join(PLUGIN_ROOT, 'assets', CRX_FILENAME)) ? join(PLUGIN_ROOT, 'assets', CRX_FILENAME) : '',
  }
}

/**
 * Escape a glob for a regular expression, keeping `*` as the only wildcard.
 * @param {string} glob - the extension's match text.
 * @returns {string} escaped text.
 */
function escapeGlob(glob) {
  return String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '*')
}

/**
 * Convert one glob to the regex + substitution the browser applies.
 *
 * Ported from the extension (`globMatchToDNRRegex`): the LAST `*` becomes a
 * capture group `(.*)` used by the replacement, the second-to-last becomes
 * `[^/]+` (so a trailing path segment is not swallowed), and any other `*` is a
 * plain `.*`. The replacement's last `*` becomes `\1`.
 * @param {string} glob - match pattern, e.g. `https://*\/mod\/*\/javascripts\/extend*.min.js*`.
 * @param {string} [replace] - replacement, may contain one `*` to reuse the capture.
 * @returns {{regex: string, substitution: string}} DNR-ready pair.
 */
export function globToDnrRegex(glob, replace = '') {
  const escaped = escapeGlob(glob)
  const stars = escaped.match(/(\*+)/g) ?? []
  let pattern = escaped
  let cursor = 0
  stars.forEach((star, index) => {
    const isLast = index === stars.length - 1
    const isSecondLast = index === stars.length - 2
    const replacement = isLast ? '(.*)' : (isSecondLast ? '[^/]+' : '.*')
    const at = pattern.indexOf(star, cursor)
    pattern = pattern.slice(0, at) + replacement + pattern.slice(at + star.length)
    cursor = at + replacement.length
  })
  let substitution = String(replace).replace(/[\\]/g, '\\&')
  if (stars.length > 0) substitution = substitution.replace(stars[stars.length - 1], '\\1')
  // The extension anchors the whole rule (`^…$`); keeping that makes the browser
  // and a CDP interception agree on what matches.
  return { regex: `^${pattern}$`, substitution }
}

/**
 * The seven rules, generated for THIS project.
 *
 * Both the query-string and the plain URL shapes are covered because the platform
 * loads the extender with a cache-busting query in prod and without one in some
 * builds; the `//` shape appears when a domain builds the URL from an empty
 * version segment.
 * @param {object} cfg - resolved yds config.
 * @returns {object} the extension's file format: v=2 with one rule group.
 */
export function overrideRules(cfg) {
  const fe = feConfig(cfg)
  const module = fe.module === '' ? 'c-ass-kk-hans' : fe.module
  const host = fe.host === '' ? 'srmdev.hanslaser.com' : fe.host
  const js = fe.scriptBase
  const css = `${fe.staticBase}/stylesheets/extend.css`
  const rules = [
    { match: `https://*/${module}/*/javascripts/extend*.min.js*`, replace: js },
    { match: `https://*/${module}/*/stylesheets/extend*.min.css*`, replace: css },
    { match: `https://*/${module}/*/javascripts/extend*.min.js`, replace: js },
    { match: `https://*/${module}/*/stylesheets/extend*.min.css`, replace: css },
    { match: `https://*/${module}//javascripts/extend.min.js`, replace: js },
    { match: `https://*/${module}//stylesheets/extend.min.css`, replace: css },
    { match: `https://${host}/${module}-festatic/*`, replace: `${fe.staticBase}/*` },
  ]
  return {
    v: 2,
    ruleGroups: [{
      id: 1,
      matchUrl: '*',
      on: true,
      rules: rules.map((rule, index) => ({
        id: index + 1,
        match: rule.match,
        on: true,
        replace: rule.replace,
        type: 'normalOverride',
      })),
    }],
  }
}

/**
 * The same rules as plain redirects (the logic, without the extension).
 *
 * An agent driving the browser itself needs `{regex, substitution}` pairs: enable
 * the CDP `Fetch` domain, and for every paused request whose URL matches, continue
 * it at the substituted URL. No extension, no 3004 CORS surprises.
 * @param {object} cfg - resolved yds config.
 * @returns {Array<{id: number, match: string, replace: string, regex: string, substitution: string}>} redirects.
 */
export function requestRedirects(cfg) {
  const file = overrideRules(cfg)
  return file.ruleGroups[0].rules.map((rule) => {
    const converted = globToDnrRegex(rule.match, rule.replace)
    return { id: rule.id, match: rule.match, replace: rule.replace, regex: converted.regex, substitution: converted.substitution }
  })
}

/**
 * Write the rule file where the extension can import it.
 * @param {object} cfg - resolved yds config.
 * @param {{path?: string}} [options] - destination override.
 * @returns {{path: string, module: string, host: string, fePort: number, rules: number}} summary.
 */
export function writeOverrideRules(cfg, options = {}) {
  const fe = feConfig(cfg)
  const workspace = typeof cfg?.workspace === 'string' && cfg.workspace !== '' ? cfg.workspace : process.cwd()
  const path = options.path ?? join(workspace, '.dsh-ris-yds', OVERRIDE_FILENAME)
  const file = overrideRules(cfg)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' })
  return { path, module: fe.module, host: fe.host, fePort: fe.fePort, rules: file.ruleGroups[0].rules.length }
}

/**
 * A page URL that loads the local extender without any extension.
 *
 * The yds front end honours `scriptUrl=…` (its own documented debug switch), so
 * this is the zero-setup path: open the workbench page with the parameter appended.
 * @param {object} cfg - resolved yds config.
 * @param {string} page - a workbench page URL (absolute or root-relative).
 * @returns {string} URL with `scriptUrl` set, or '' when no page/workbench is known.
 */
export function pageUrlWithScriptUrl(cfg, page) {
  const fe = feConfig(cfg)
  const base = typeof cfg?.workbenchUrl === 'string' ? cfg.workbenchUrl : ''
  const raw = typeof page === 'string' ? page.trim() : ''
  // No page means the caller has nothing to open: hand back an empty string so the
  // CLI prints usage instead of a bare workspace URL nobody asked for.
  if (raw === '') return ''
  let url
  try {
    url = new URL(raw, base === '' ? undefined : base)
  } catch {
    return ''
  }
  url.searchParams.set('scriptUrl', fe.staticBase)
  return url.toString()
}
