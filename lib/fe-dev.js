/**
 * Front-end dev-server wiring for the yds project.
 *
 * A yds page loads its extender script from the platform (`/mdf-wh/<domainKey>/…`),
 * but during development it has to come from the local webpack dev server on
 * `http://127.0.0.1:3004/static`. This module answers two questions from the
 * project's own config, so nothing here is machine-specific:
 *
 * 1. {@link assetRules} — which platform URLs map to which local files. The
 *    shipped dev extension (`assets/dev-extension`) turns the same pairs into
 *    `declarativeNetRequest` redirect rules at runtime.
 * 2. {@link requestRedirects} — the same pairs converted to the regex form a
 *    browser CDP `Fetch.continueRequest({ url })` needs, for an agent that
 *    intercepts requests itself without installing anything.
 *
 * The glob→regex conversion is a port of the (former) Resource Override
 * extension's transform, so a rule means the same thing whichever path is used.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's own directory (`lib/` sits directly under it). */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Default webpack dev-server port of the yds front end (`npm run debug:extend`). */
export const DEFAULT_FE_PORT = 3004

/**
 * The dynamic half of the wiring, taken from the project's own config.
 *
 * Nothing here is written by hand: the module comes from `yonbuilder.json`/the
 * deployed module, the host from `workbenchUrl`, the port from the project
 * (`yds.webConfig` of the front end, else its own override file).
 * @param {object} cfg - resolved yds config.
 * @returns {{module: string, host: string, fePort: number, scriptBase: string, staticBase: string}} values.
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
  }
}

/**
 * Escape a glob for a regular expression, keeping `*` as the only wildcard.
 * @param {string} glob - the match text.
 * @returns {string} escaped text.
 */
function escapeGlob(glob) {
  return String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '*')
}

/**
 * Convert one glob to the regex + substitution a browser applies.
 *
 * The LAST `*` becomes a capture group `(.*)` used by the replacement, the
 * second-to-last becomes `[^/]+` (so a trailing path segment is not swallowed),
 * and any other `*` is a plain `.*`. The replacement's last `*` becomes `\1`.
 * @param {string} glob - match pattern, e.g. `https://*\/mod\/*\/javascripts\/extend*.min.js*`.
 * @param {string} [replace] - replacement, may contain one `*` to reuse the capture.
 * @returns {{regex: string, substitution: string}} CDP-ready pair.
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
  // Anchoring the whole rule (`^…$`) keeps the browser and a CDP interception
  // agreeing on what matches.
  return { regex: `^${pattern}$`, substitution }
}

/**
 * The seven URL pairs, generated for THIS project.
 *
 * Both the query-string and the plain URL shapes are covered because the platform
 * loads the extender with a cache-busting query in prod and without one in some
 * builds; the `//` shape appears when a domain builds the URL from an empty
 * version segment.
 * @param {object} cfg - resolved yds config.
 * @returns {Array<{id: number, match: string, replace: string}>} rules.
 */
export function assetRules(cfg) {
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
  return rules.map((rule, index) => ({ id: index + 1, ...rule }))
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
  return assetRules(cfg).map((rule) => {
    const converted = globToDnrRegex(rule.match, rule.replace)
    return { ...rule, regex: converted.regex, substitution: converted.substitution }
  })
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

/** Absolute path of the shipped dev-extension template (implies no build step). */
export function devExtensionTemplateDir() {
  const dir = join(PLUGIN_ROOT, 'assets', 'dev-extension')
  return existsSync(dir) ? dir : ''
}
