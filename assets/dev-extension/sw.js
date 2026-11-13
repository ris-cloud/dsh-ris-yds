// ris-yds-extension — keeps the browser pointed at THIS machine's dev instance.
//
// Two jobs, both driven by the project config that yds serves on loopback:
//
//   1. add the `rdbga` request header to `/c-ass-kk-hans/**` calls, so the gateway
//      routes them to the local YMS (the gateway honours the header even when no
//      cookie is present — verified on 2026-11-12);
//   2. redirect the platform's extender assets (`extend*.min.js|css`) to the local
//      webpack dev server, so front-end edits hot-reload.
//
// Values are NEVER hard-coded: `config.json` (written by `yds fe extension`) only
// carries the workspace + DSH port; the real values are fetched from
// `http://127.0.0.1:<dshPort>/dsh-ris-yds/dev-config` on install/startup and every
// couple of minutes, and a stale copy is kept in storage for offline starts.

const DEFAULT_DSH_PORT = 3080
const STORAGE_KEY = 'ydsConfig'
const ALARM_NAME = 'yds-dev-sync'
const RULE_ID_BASE = 100
const HEADER_RULE_ID = 900

const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet',
  'image', 'font', 'media', 'websocket', 'other', 'ping', 'csp_report',
  'object', 'dtd', 'webbundle',
]

/** Read the bundled config.json (workspace + DSH port, written by `yds fe extension`). */
async function readBundled() {
  try {
    const response = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/** Seed config: last live copy from storage, else the bundled one. */
async function seedConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return stored?.[STORAGE_KEY] ?? await readBundled()
}

/** Ask the running yds plugin for the current values. */
async function fetchLive(seed) {
  const port = Number(seed?.dshPort) > 0 ? Number(seed.dshPort) : DEFAULT_DSH_PORT
  const workspace = typeof seed?.workspace === 'string' ? seed.workspace : ''
  const query = workspace === '' ? '' : `?workspace=${encodeURIComponent(workspace)}`
  const response = await fetch(`http://127.0.0.1:${port}/dsh-ris-yds/dev-config${query}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`dev-config HTTP ${response.status}`)
  const body = await response.json()
  if (body?.ok !== true) throw new Error(body?.reason ?? 'dev-config returned ok:false')
  return body
}

/** Escape a literal for a regular expression. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the DNR rules for one config snapshot.
 * @param {{workbenchUrl: string, module: string, staticBase: string, fePort: number, rdbga: string}} config
 * @returns {Array<object>} rules (header injection + asset redirects).
 */
export function buildRules(config) {
  const host = escapeRegExp(new URL(config.workbenchUrl).host)
  const module = escapeRegExp(config.module)
  const staticBase = String(config.staticBase ?? `http://127.0.0.1:${config.fePort}/static`).replace(/\/+$/, '')
  const js = `${staticBase}/javascripts/extend.js`
  const css = `${staticBase}/stylesheets/extend.css`
  const rules = [
    {
      id: RULE_ID_BASE + 1,
      priority: 2,
      action: { type: 'redirect', redirect: { url: js } },
      // Covers both `/mod/<ver>/javascripts/extend*.min.js` and `/mod//javascripts/extend.min.js`.
      condition: {
        regexFilter: `^https://${host}/${module}/[^/]*/javascripts/extend[^/]*\\.min\\.js(?:\\?.*)?$`,
        resourceTypes: ['script', 'stylesheet'],
      },
    },
    {
      id: RULE_ID_BASE + 2,
      priority: 2,
      action: { type: 'redirect', redirect: { url: css } },
      condition: {
        regexFilter: `^https://${host}/${module}/[^/]*/stylesheets/extend[^/]*\\.min\\.css(?:\\?.*)?$`,
        resourceTypes: ['script', 'stylesheet'],
      },
    },
    {
      id: RULE_ID_BASE + 3,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${staticBase}/\\1` } },
      condition: {
        regexFilter: `^https://${host}/${module}-festatic/(.*)$`,
        resourceTypes: ['script', 'stylesheet', 'image', 'font', 'other'],
      },
    },
  ]
  const rdbga = typeof config.rdbga === 'string' ? config.rdbga.trim() : ''
  if (rdbga !== '') {
    rules.push({
      id: HEADER_RULE_ID,
      priority: 3,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'rdbga', operation: 'set', value: rdbga }],
      },
      // Only the module's own paths: those are what the gateway routes by rdbga.
      condition: { regexFilter: `^https://${host}/${module}/.*`, resourceTypes: RESOURCE_TYPES },
    })
  }
  return rules
}

/** Badge text/color, so the toolbar shows whether the wiring is live. */
async function setBadge(text, color, title) {
  try {
    await chrome.action.setBadgeText({ text })
    await chrome.action.setBadgeBackgroundColor({ color })
    await chrome.action.setTitle({ title })
  } catch {
    /* badge is cosmetic */
  }
}

/** Fetch config + replace the dynamic rules. Never throws to the caller. */
async function sync(reason) {
  const seed = await seedConfig()
  let live = null
  let error = ''
  try {
    live = await fetchLive(seed)
  } catch (failure) {
    error = String(failure?.message ?? failure)
  }
  const config = live ?? seed
  if (config == null || typeof config.workbenchUrl !== 'string' || config.workbenchUrl === ''
    || typeof config.module !== 'string' || config.module === '') {
    await setBadge('?', '#b3261e', `yds: 没有可用配置（${reason}）${error === '' ? '' : ` · ${error}`}`)
    return { ok: false, reason: 'no-config', error }
  }
  let rules = []
  try {
    rules = buildRules(config)
    const existing = await chrome.declarativeNetRequest.getDynamicRules()
    const keep = new Set(rules.map((rule) => rule.id))
    const removeRuleIds = [...existing.map((rule) => rule.id).filter((id) => !keep.has(id)), ...rules.map((rule) => rule.id)]
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules })
  } catch (failure) {
    error = String(failure?.message ?? failure)
    await setBadge('!', '#b3261e', `yds: 规则写入失败 · ${error}`)
    return { ok: false, reason: 'rules-failed', error }
  }
  const record = { ...config, source: live === null ? 'bundled' : 'live', syncedAt: new Date().toISOString(), error, rules: rules.length }
  await chrome.storage.local.set({ [STORAGE_KEY]: record })
  const rdbgaOn = rules.some((rule) => rule.id === HEADER_RULE_ID)
  await setBadge(
    live === null ? 'OFF' : 'ON',
    live === null ? '#b3261e' : '#1e6f2e',
    `yds: ${config.module} · ${live === null ? '用本地缓存' : '已同步'} · rdbga ${rdbgaOn ? 'on' : 'off'}`
      + `${error === '' ? '' : ` · ${error}`}`,
  )
  return { ok: true, config: record, rules: rules.length, reason }
}

async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM_NAME)
    if (existing == null) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 2 })
  } catch {
    /* alarms are best-effort */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm()
  sync('installed')
})

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm()
  sync('startup')
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === ALARM_NAME) sync('alarm')
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'yds-sync') {
    sync('popup').then(sendResponse)
    return true
  }
  return false
})

// The service worker may be restarted without install/startup events.
ensureAlarm()
sync('wake')
