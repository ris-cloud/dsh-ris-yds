// YYCToken generation. The signing key derivation lives in the closed-source
// yds-rust native module, so we load the prebuilt binary per platform from
// native/ (darwin/linux/win32 × x64/arm64 — extracted from the YonCode
// extension, bundled here so the plugin needs no YonCode install).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR } from './config.js'

let cached = null

function loadNative() {
  if (cached !== null) return cached
  const file = join(PLUGIN_DIR, 'native', `yds-rust.${process.platform}-${process.arch}.node`)
  if (!existsSync(file)) {
    throw new Error(`当前平台无 yds-rust 原生模块: ${process.platform}-${process.arch} (${file})`)
  }
  cached = { file, mod: null }
  return cached
}

/**
 * Generate a YYCToken for a URL.
 * @param {string} url - the exact request URL the token will authorize.
 * @param {string} accessKey
 * @param {string} accessSecret
 * @returns {Promise<string>} the token (URL-bound; regenerate per URL).
 */
export async function getYycToken(url, accessKey, accessSecret) {
  const entry = loadNative()
  if (entry.mod === null) entry.mod = await import(pathToFileURL(entry.file).href) // pathToFileURL: survives spaces on Windows
  const fn = entry.mod.getYycToken ?? entry.mod.default?.getYycToken
  if (typeof fn !== 'function') throw new Error('yds-rust 模块缺少 getYycToken 导出')
  return fn(url, accessKey, accessSecret)
}
