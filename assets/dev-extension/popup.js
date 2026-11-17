// Popup: show the last synced values and offer a manual resync. All logic lives in
// the service worker (`sw.js`); this page only renders and asks it to sync again.

const STORAGE_KEY = 'ydsConfig'

const fields = {
  state: document.getElementById('state'),
  module: document.getElementById('module'),
  workbench: document.getElementById('workbench'),
  fePort: document.getElementById('fePort'),
  rdbga: document.getElementById('rdbga'),
  source: document.getElementById('source'),
  syncedAt: document.getElementById('syncedAt'),
  error: document.getElementById('error'),
  sync: document.getElementById('sync'),
}

function setState(live, text) {
  fields.state.textContent = text
  fields.state.className = `state ${live ? 'on' : 'off'}`
}

function shortRdbga(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return '—（接口不会回到本机）'
  return `${text.slice(0, 10)}…${text.slice(-6)}`
}

function render(config) {
  if (config == null) {
    setState(false, '未配置')
    fields.module.textContent = '—'
    fields.workbench.textContent = '先运行 yds fe extension'
    fields.fePort.textContent = '—'
    fields.rdbga.textContent = '—'
    fields.source.textContent = '—'
    fields.syncedAt.textContent = '—'
    fields.error.hidden = true
    return
  }
  const live = config.source === 'live'
  setState(live, live ? '已同步' : '本地缓存')
  fields.module.textContent = config.module || '—'
  try {
    fields.workbench.textContent = config.workbenchUrl ? new URL(config.workbenchUrl).host : '—'
  } catch {
    fields.workbench.textContent = config.workbenchUrl || '—'
  }
  fields.fePort.textContent = config.fePort ? String(config.fePort) : '—'
  fields.rdbga.textContent = shortRdbga(config.rdbga)
  fields.source.textContent = live ? '本机 yds' : '扩展内置缓存（yds 未运行？）'
  fields.syncedAt.textContent = config.syncedAt ? new Date(config.syncedAt).toLocaleString() : '—'
  if (typeof config.error === 'string' && config.error !== '') {
    fields.error.hidden = false
    fields.error.textContent = config.error
  } else {
    fields.error.hidden = true
  }
}

async function refresh() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  render(stored?.[STORAGE_KEY])
}

fields.sync.addEventListener('click', async () => {
  fields.sync.disabled = true
  fields.sync.textContent = '同步中…'
  try {
    const result = await chrome.runtime.sendMessage({ type: 'yds-sync' })
    if (result?.ok !== true) {
      fields.error.hidden = false
      fields.error.textContent = result?.error ?? result?.reason ?? '同步失败'
    }
    await refresh()
  } finally {
    fields.sync.disabled = false
    fields.sync.textContent = '立即同步（从本机 yds 重新取值）'
  }
})

refresh()
