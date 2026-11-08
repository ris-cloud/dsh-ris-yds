/**
 * YonCode host patching.
 *
 * YonCode derives the address it advertises to the platform (serverBindAddress)
 * from a local NIC. When `.vscode/settings.json` points it at a callback address
 * the machine does not own — the normal case behind NAT, in WSL, or through a
 * port forward — it refuses to launch with
 * "Invalid IP address, no interface found with address <ip>".
 *
 * We cannot fix that from our side: the check lives in YonCode's bundled
 * extension (`resources/app/extensions/yonbuilder-development-studio-core/dist/
 * extension.js`). This module detects whether the check is still active and can
 * turn the throw into a warning — with a `.bak` next to it, so it can be undone
 * and re-applied after a YonCode upgrade rewrites the file.
 *
 * Nothing here touches the project; it is opt-in from the user (the agent asks
 * before writing into a Program Files directory).
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Marker our patch leaves in the bundle (also how a patch is detected). */
export const YONCODE_PATCH_MARKER = '[yds-patch]'

/** The file we patch, relative to the YonCode installation directory. */
export const YONCODE_EXTENSION_RELATIVE = 'resources/app/extensions/yonbuilder-development-studio-core/dist/extension.js'

/** Matches the `if (!ipv4IsValid(ipv4)) { throw … }` block in the shipped bundle. */
const VALIDATION_RE = /if\s*\(\s*!\s*_util\.ipv4IsValid\([^)]*\)\s*\)\s*\{\s*throw new Error\([^;]*?\);\s*\}/

/**
 * The YMS launch `vmArgs` snippet YonCode builds — the anchor we insert the JVM
 * proxy flags after. It is a plain template string in the bundle.
 */
const SOCKS_ANCHOR = /-Dapp\.metainfo\.preferred-networks=\\?\$\{command:yds\.serverBindAddress\} -Dserver\.port=\\?\$\{config:yds\.serverPort\}/

/** Our injected flags, so a re-patch replaces instead of stacking. */
const SOCKS_FLAGS_RE = / -DsocksProxyHost=[^\s"']+ -DsocksProxyPort=\d+/

/**
 * Why this exists: ProxyBridge (WinDivert) breaks the Oracle TNS handshake —
 * the connection is accepted, then reset right after `T2C7Oversion.doOVERSION`,
 * so the YMS module cannot reach its database. A JVM started with
 * `-DsocksProxyHost` opens an ordinary TCP connection through the SOCKS server
 * instead, which is the same path that already works from WSL.
 * @param socks - `{host, port}` from `.env` (`socks.host`/`socks.port`).
 * @returns the flags to append, or null when no SOCKS server is configured.
 */
export function socksFlags(socks) {
  const host = typeof socks?.host === 'string' ? socks.host.trim() : ''
  const port = Number(socks?.port)
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return ` -DsocksProxyHost=${host} -DsocksProxyPort=${port}`
}

/**
 * Where a YonCode install may be, most specific first.
 *
 * `cfg.yoncodeHome` (`.env` `yoncode.home` or `YONCODE_HOME`) wins; otherwise the
 * platform defaults, including the Windows drives WSL can see.
 * @param cfg - resolved plugin config (`cfg.yoncodeHome` optional).
 * @returns candidate installation directories.
 */
export function yoncodeCandidates(cfg = {}) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  // An explicit location is authoritative: if it is wrong we report "absent"
  // rather than silently inspecting some other installation.
  const explicit = typeof cfg.yoncodeHome === 'string' && cfg.yoncodeHome !== ''
    ? cfg.yoncodeHome
    : (typeof process.env.YONCODE_HOME === 'string' && process.env.YONCODE_HOME !== '' ? process.env.YONCODE_HOME : '')
  if (explicit !== '') return [explicit]
  if (process.platform === 'win32') {
    push('C:\\Program Files\\YonCode')
    push('D:\\Program Files\\YonCode')
  }
  if (process.platform === 'darwin') {
    push('/Applications/YonCode.app/Contents/Resources/app')
    push(join(homedir(), 'Applications/YonCode.app/Contents/Resources/app'))
  }
  push('/opt/YonCode')
  push('/usr/share/YonCode')
  push('/usr/local/YonCode')
  // A Windows install reached from WSL.
  for (const drive of ['c', 'd', 'e']) push(`/mnt/${drive}/Program Files/YonCode`)
  return out
}

/**
 * Read the bundle and classify it.
 *
 * States: `patched` (our warning is in place), `unpatched` (the throw is still
 * there), `unrecognised` (file exists but has neither shape — a different
 * YonCode version we refuse to guess about), `absent` (no installation found),
 * `incomplete` (directory exists without the bundle).
 * @param cfg - resolved plugin config.
 * @returns `{ found, home, file, state, backup, detail }`.
 */
export function detectYoncode(cfg = {}) {
  let seenIncomplete = null
  for (const home of yoncodeCandidates(cfg)) {
    const file = join(home, YONCODE_EXTENSION_RELATIVE)
    if (!existsSync(file)) {
      if (seenIncomplete === null && existsSync(home)) seenIncomplete = home
      continue
    }
    let text = ''
    try {
      if (statSync(file).size > 32 * 1024 * 1024) return { found: true, home, file, state: 'unrecognised', backup: null, detail: '文件过大，跳过' }
      text = readFileSync(file, 'utf8')
    } catch (error) {
      return { found: true, home, file, state: 'unrecognised', backup: null, detail: `无法读取：${error instanceof Error ? error.message : String(error)}` }
    }
    const backup = `${file}.bak`
    const hasBackup = existsSync(backup)
    const socksMatch = SOCKS_FLAGS_RE.exec(text)
    const socksValue = socksMatch === null ? '' : socksMatch[0].trim()
    const socksState = socksMatch !== null ? 'patched' : SOCKS_ANCHOR.test(text) ? 'unpatched' : 'unrecognised'
    const withSocks = (result) => ({ ...result, found: true, home, file, socksState, socksValue, backup: hasBackup ? backup : null })
    if (text.includes(YONCODE_PATCH_MARKER)) {
      return withSocks({ state: 'patched', detail: '网卡 IP 校验已改为告警' })
    }
    if (VALIDATION_RE.test(text)) {
      return withSocks({ state: 'unpatched', detail: '网卡 IP 校验仍在（serverBindAddress 不是本机网卡时拒绝启动）' })
    }
    return withSocks({ state: 'unrecognised', detail: '找不到校验代码，可能是不认识的 YonCode 版本' })
  }
  if (seenIncomplete !== null) {
    return { found: true, home: seenIncomplete, file: join(seenIncomplete, YONCODE_EXTENSION_RELATIVE), state: 'incomplete', backup: null, detail: '安装目录存在但没找到 YonCode 扩展包' }
  }
  return { found: false, home: null, file: null, state: 'absent', backup: null, detail: '没有找到 YonCode 安装（可用 .env 的 yoncode.home 指定）' }
}

/** True when the failure was a permission problem, i.e. elevation would help. */
function isPermissionError(error) {
  const code = error?.code ?? ''
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || /permission denied/i.test(error?.message ?? '')
}

/**
 * Patch the bundle: turn the NIC check into a warning, and (optionally) append the
 * JVM SOCKS flags to the YMS launch arguments.
 *
 * Both edits share one `.bak` of the untouched file, so {@link restoreYoncode}
 * undoes them together. Idempotent: an already patched bundle reports
 * `changed: false`.
 * @param detected - the result of {@link detectYoncode}.
 * @param {{socks?: {host: string, port: number}}} [options] - SOCKS server to inject.
 * @returns `{ ok, changed, state, socksState, error?, needElevation? }`.
 */
export function patchYoncode(detected, options = {}) {
  if (!detected.found) return { ok: false, changed: false, state: detected.state, socksState: detected.socksState, error: detected.detail }
  const flags = socksFlags(options.socks)
  const wantsSocks = flags !== null
  const needsValidation = detected.state === 'unpatched'
  // Same flags already in place → nothing to do; a *different* SOCKS server must
  // replace the old pair instead of stacking a second one.
  const needsSocks = wantsSocks && (detected.socksState !== 'patched' || (detected.socksValue ?? '') !== flags.trim())
  if (!needsValidation && !needsSocks) {
    // `ok` means "the bundle has every edit this call asked for": the NIC check
    // when it was still active, the JVM flags when a SOCKS server was given.
    const ok = detected.state === 'patched' && (!wantsSocks || detected.socksState === 'patched')
    const error = ok
      ? undefined
      : detected.socksState === 'unrecognised' && wantsSocks
        ? '找不到 YMS 启动参数模板，无法注入 JVM 代理参数'
        : detected.detail
    return { ok, changed: false, state: detected.state, socksState: detected.socksState, error }
  }
  try {
    let text = readFileSync(detected.file, 'utf8')
    if (needsValidation && !VALIDATION_RE.test(text)) return { ok: false, changed: false, state: 'unrecognised', socksState: detected.socksState, error: '文件内容已变化，无法定位校验代码' }
    if (needsSocks && !SOCKS_FLAGS_RE.test(text) && !SOCKS_ANCHOR.test(text)) {
      return { ok: false, changed: false, state: detected.state, socksState: 'unrecognised', error: '找不到 YMS 启动参数模板，无法注入 JVM 代理参数' }
    }
    if (!existsSync(`${detected.file}.bak`)) copyFileSync(detected.file, `${detected.file}.bak`)
    if (needsValidation) {
      text = text.replace(VALIDATION_RE, (block) => {
        const match = /ipv4IsValid\(([^)]*)\)/.exec(block)
        const argument = match === null ? 'ipv4' : match[1].trim()
        return `if (!_util.ipv4IsValid(${argument})) {\n            console.warn("${YONCODE_PATCH_MARKER} serverBindAddress " + ${argument} + " is not a local NIC IP, skip validation");\n        }`
      })
    }
    if (needsSocks) {
      text = SOCKS_FLAGS_RE.test(text)
        ? text.replace(SOCKS_FLAGS_RE, flags)
        : text.replace(SOCKS_ANCHOR, (anchor) => anchor + flags)
    }
    writeFileSync(detected.file, text)
    return {
      ok: true,
      changed: true,
      state: needsValidation ? 'patched' : detected.state,
      socksState: needsSocks ? 'patched' : detected.socksState,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, changed: false, state: detected.state, socksState: detected.socksState, error: message, needElevation: isPermissionError(error) }
  }
}

/**
 * Put the original bundle back from `.bak`.
 * @param detected - the result of {@link detectYoncode}.
 * @returns `{ ok, changed, state, error?, needElevation? }`.
 */
export function restoreYoncode(detected) {
  const backup = detected.backup ?? (detected.file === null ? null : `${detected.file}.bak`)
  if (backup === null || !existsSync(backup)) {
    return { ok: false, changed: false, state: detected.state, error: '没有 .bak 备份，无法还原（重装 YonCode 也会恢复原文件）' }
  }
  try {
    copyFileSync(backup, detected.file)
    return { ok: true, changed: true, state: 'unpatched' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, changed: false, state: detected.state, error: message, needElevation: isPermissionError(error) }
  }
}

/**
 * One-line summary for `yds doctor` and the CLI.
 * @param detected - the result of {@link detectYoncode}.
 * @returns human readable line.
 */
export function describeYoncode(detected) {
  if (!detected.found) return `yoncode: ${detected.detail}`
  const where = detected.home ?? detected.file
  const socks = detected.socksState === 'patched' ? '，JVM 代理参数已注入' : ''
  return `yoncode: ${detected.state}（${detected.detail}${socks}）${where === null ? '' : ` · ${where}`}`
}

/**
 * Should we warn the user about the launch configuration we are about to write?
 *
 * Only when YonCode is installed AND its check is active: an absent YonCode is
 * not a problem (we run standalone), and a patched one is already fine.
 * @param detected - the result of {@link detectYoncode}.
 * @returns the warning text, or null.
 */
export function yoncodeWarning(detected) {
  if (!detected.found || detected.state !== 'unpatched') return null
  return 'YonCode 仍在校验 serverBindAddress 必须是本机网卡 IP；用外网/端口转发/回调地址启动会失败。'
    + '可以让 ris-yds 把该校验改成告警（需写 YonCode 安装目录的权限），运行 `yds yoncode patch` 或让我代做。'
}
