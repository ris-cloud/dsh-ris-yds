// The shipped dev extension (`assets/dev-extension`) is a thin client: it owns no
// project knowledge, it asks the running plugin for the values and applies them as
// `declarativeNetRequest` rules. This module is the server half of that contract.
//
// Why a generated directory instead of a prebuilt .crx: the browser has to load the
// extension once from a folder, and every value (rdbga, module, workbench host, the
// dev-server port) then follows the project on its own — no re-import when a port
// or workspace changes, no checked-in machine-specific blob.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { feConfig, devExtensionTemplateDir } from './fe-dev.js'
import { resolveConfig } from './config.js'
import { rdbgaValue } from './yms.js'

/** Template files the extension folder is made of (the manifest is the entry). */
const TEMPLATE_FILES = ['manifest.json', 'sw.js', 'popup.html', 'popup.js', 'config.json']

/** Default DSH web port the extension talks back to (the same host serves the route). */
export const DEFAULT_DSH_PORT = 3080

/**
 * The dynamic config payload for the extension.
 *
 * Everything the browser needs, derived from the resolved project config: the
 * module/workbench for the redirect + header rules, the dev-server port for the
 * asset URLs, and the rdbga value the gateway routes by.
 * @param {object} cfg - resolved yds config.
 * @returns {{ok: boolean, module: string, workbenchUrl: string, rdbga: string, fePort: number, staticBase: string, scriptBase: string, reason?: string}} payload.
 */
export function devConfig(cfg) {
  const fe = feConfig(cfg)
  let rdbga = ''
  try {
    rdbga = rdbgaValue(cfg)
  } catch (error) {
    // No serverBindAddress/port yet (project not started): the extension still works
    // for asset redirection, it just cannot route API calls to this machine.
    return {
      ok: false,
      module: fe.module,
      workbenchUrl: String(cfg?.workbenchUrl ?? ''),
      rdbga: '',
      fePort: fe.fePort,
      staticBase: fe.staticBase,
      scriptBase: fe.scriptBase,
      reason: `rdbga 不可用：${String(error?.message ?? error)}`,
    }
  }
  if (fe.module === '' || fe.host === '') {
    return {
      ok: false,
      module: fe.module,
      workbenchUrl: String(cfg?.workbenchUrl ?? ''),
      rdbga,
      fePort: fe.fePort,
      staticBase: fe.staticBase,
      scriptBase: fe.scriptBase,
      reason: '项目缺少模块名或工作台地址（检查 yonbuilder.json / .vscode/settings.json）',
    }
  }
  return {
    ok: true,
    module: fe.module,
    workbenchUrl: String(cfg?.workbenchUrl ?? ''),
    rdbga,
    fePort: fe.fePort,
    staticBase: fe.staticBase,
    scriptBase: fe.scriptBase,
  }
}

/**
 * Resolve a workspace and answer with its extension config.
 *
 * Used by `GET /dsh-ris-yds/dev-config?workspace=…`: the extension sends the path it
 * was generated for, so a restart of the workspace keeps working without re-import.
 * @param {string} workspace - absolute workspace path.
 * @returns {{ok: boolean, reason?: string} & Record<string, unknown>} payload.
 */
export function devConfigForWorkspace(workspace) {
  const { config, problems } = resolveConfig(workspace)
  if (config.projectDir == null) {
    return { ok: false, reason: problems[0] ?? '当前目录不是 yds 项目（缺 .vscode/settings.json 的 yds.* 配置）' }
  }
  const payload = devConfig(config)
  return { ...payload, workspace, projectDir: config.projectDir }
}

/**
 * Where the extension folder for a workspace lives (whether or not it exists yet).
 *
 * Keeping the location in one place means the console page, the CLI and the write
 * call can never disagree about which folder the browser was pointed at.
 * @param {object} cfg - resolved yds config (needs `workspace`).
 * @param {{dir?: string}} [options] - explicit override.
 * @returns {string} absolute folder path.
 */
export function extensionFolder(cfg, options = {}) {
  const explicit = typeof options.dir === 'string' ? options.dir.trim() : ''
  if (explicit !== '') return explicit
  const workspace = typeof cfg?.workspace === 'string' ? cfg.workspace : ''
  return join(workspace, '.dsh-ris-yds', 'dev-extension')
}

/**
 * Status of the extension folder for one workspace, plus what the user must do.
 *
 * The browser cannot install an extension from a web page (Chrome requires the
 * user to load an unpacked folder from chrome://extensions, or a signed store
 * package), so the honest answer is "one button generates the folder, then drag it
 * in": this object carries both the folder and the exact steps.
 * @param {object} cfg - resolved yds config.
 * @param {{dir?: string, dshPort?: number}} [options] - target folder / DSH port.
 * @returns {{ok: boolean, workspace: string, dir: string, exists: boolean, files: string[], dshPort: number, loadUrl: string, steps: string[]}} status.
 */
export function extensionStatus(cfg, options = {}) {
  const dir = extensionFolder(cfg, options)
  const exists = existsSync(join(dir, 'manifest.json'))
  const workspace = typeof cfg?.workspace === 'string' ? cfg.workspace : ''
  const dshPort = Number.isInteger(options.dshPort) && options.dshPort > 0 ? options.dshPort : DEFAULT_DSH_PORT
  return {
    ok: true,
    workspace,
    dir,
    exists,
    files: exists ? readdirSync(dir).filter((name) => TEMPLATE_FILES.includes(name)) : [],
    dshPort,
    loadUrl: 'chrome://extensions',
    steps: [
      '打开 chrome://extensions（或 Edge 的 edge://extensions），右上角开启「开发者模式」',
      `点「加载已解压的扩展程序」，选择目录：${dir}`,
      '回到工作台页面刷新一次；扩展会自行向本机 yds 取值（rdbga / 前端端口 / 工作台）',
    ],
  }
}

/** Minimal HTML page: status, the three steps, and a "generate/refresh folder" button. */
export function extensionPageHtml(workspace) {
  const escape = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ris-yds-extension · yds 浏览器扩展</title>
<style>
 :root{color-scheme:light dark} body{margin:0;padding:24px;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:760px}
 h1{font-size:17px;margin:0 0 4px} p.sub{margin:0 0 18px;opacity:.65}
 .box{border:1px solid #8884;border-radius:10px;padding:14px 16px;margin:0 0 14px}
 dl{display:grid;grid-template-columns:96px 1fr;gap:4px 10px;margin:0} dt{opacity:.65} dd{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;word-break:break-all}
 ol{margin:8px 0 0;padding-left:20px} code{background:#8881;border-radius:4px;padding:1px 5px;font-size:12.5px}
 button{padding:7px 14px;font:inherit;border-radius:7px;border:1px solid #8884;background:#8881;cursor:pointer}
 button:disabled{opacity:.5;cursor:default} .ok{color:#1e6f2e} .bad{color:#b3261e}
 .note{font-size:12px;opacity:.6;margin-top:10px}
</style></head><body>
<h1>ris-yds-extension</h1>
<p class="sub">让浏览器页面里的接口回到本机，并把 extend 资源换成本地 dev server。值由本机 yds 动态提供，跟随项目。</p>
<div class="box"><dl>
  <dt>工作区</dt><dd id="workspace">${escape(workspace)}</dd>
  <dt>扩展目录</dt><dd id="dir">读取中…</dd>
  <dt>状态</dt><dd id="state">…</dd>
</dl>
<ol id="steps"></ol>
<div class="note">Chrome 不允许网页直接安装扩展：点下面的按钮生成目录，然后在 chrome://extensions 里「加载已解压的扩展程序」选择该目录。之后升级 yds 插件只要回来点一次「重新生成」（Service Worker 有改动时还需在扩展页点一次刷新）。</div>
</div>
<button id="write" type="button">生成 / 更新扩展目录</button>
<p id="msg" class="note"></p>
<script>
 const ws = ${JSON.stringify(workspace)}
 const $ = (id) => document.getElementById(id)
 function render(info) {
   $('dir').textContent = info.dir || '—'
   $('state').textContent = info.exists ? '已生成（可在 chrome://extensions 加载）' : '尚未生成'
   $('state').className = info.exists ? 'ok' : 'bad'
   $('steps').innerHTML = (info.steps || []).map((s) => '<li>' + s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</li>').join('')
 }
 async function load() {
   const res = await fetch('/dsh-ris-yds/extension?workspace=' + encodeURIComponent(ws))
   render(await res.json())
 }
 $('write').addEventListener('click', async () => {
   $('write').disabled = true; $('msg').textContent = '生成中…'
   try {
     const res = await fetch('/dsh-ris-yds/extension', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: ws }) })
     const body = await res.json()
     if (body.ok) { render(body); $('msg').textContent = '已生成：' + body.dir } else { $('msg').textContent = '失败：' + (body.reason || '未知原因') }
   } catch (error) { $('msg').textContent = '失败：' + error }
   finally { $('write').disabled = false }
 })
 load()
</script>
</body></html>`
}

/**
 * Materialize the extension folder for a workspace path (console/CLI convenience).
 *
 * Thin wrapper over {@link writeDevExtension} so the HTTP routes never have to know
 * how a workspace turns into a config.
 * @param {string} workspace - absolute workspace path.
 * @param {{dir?: string, dshPort?: number}} [options] - target folder / DSH port.
 * @returns {{ok: boolean, path?: string, files?: string[], dshPort?: number, workspace?: string, reason?: string}} result.
 */
export function writeDevExtensionForWorkspace(workspace, options = {}) {
  const { config, problems } = resolveConfig(workspace)
  if (config.projectDir == null) return { ok: false, reason: problems[0] ?? '当前目录不是 yds 项目' }
  try {
    const written = writeDevExtension(config, options)
    return { ok: true, ...written }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Extension folder status for a workspace path (console page convenience).
 * @param {string} workspace - absolute workspace path.
 * @param {{dir?: string, dshPort?: number}} [options] - target folder / DSH port.
 * @returns {{ok: boolean, dir?: string, exists?: boolean, steps?: string[], reason?: string}} status.
 */
export function extensionStatusForWorkspace(workspace, options = {}) {
  const { config, problems } = resolveConfig(workspace)
  if (config.projectDir == null) return { ok: false, reason: problems[0] ?? '当前目录不是 yds 项目' }
  return extensionStatus(config, options)
}

/**
 * Materialize a loadable extension folder for one workspace.
 *
 * Copies the shipped template next to the workspace (`.dsh-ris-yds/dev-extension`)
 * and writes `config.json` with just the two bootstrap values: the workspace the
 * extension asks about, and the DSH port serving `/dsh-ris-yds/dev-config`.
 * @param {object} cfg - resolved yds config (needs `workspace`).
 * @param {{dir?: string, dshPort?: number}} [options] - target folder / DSH port.
 * @returns {{path: string, files: string[], dshPort: number, workspace: string}} result.
 */
export function writeDevExtension(cfg, options = {}) {
  const template = devExtensionTemplateDir()
  if (template === '') throw new Error('未找到 assets/dev-extension 模板（插件安装不完整）')
  const workspace = typeof cfg?.workspace === 'string' ? cfg.workspace : ''
  if (workspace === '') throw new Error('缺少 workspace，无法确定扩展所属项目')
  const target = extensionFolder(cfg, options)
  const dshPort = Number.isInteger(options.dshPort) && options.dshPort > 0 ? options.dshPort : DEFAULT_DSH_PORT
  mkdirSync(target, { recursive: true })
  const files = []
  for (const name of TEMPLATE_FILES) {
    const source = join(template, name)
    if (!existsSync(source)) continue
    writeFileSync(join(target, name), readFileSync(source))
    files.push(name)
  }
  writeFileSync(
    join(target, 'config.json'),
    `${JSON.stringify({ workspace, dshPort }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  )
  return { path: target, files: [...new Set([...files, 'config.json'])], dshPort, workspace }
}

