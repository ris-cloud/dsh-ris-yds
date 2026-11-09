/**
 * Watch ris-ide's program config and keep our launcher row in it.
 *
 * ris-ide rewrites `.dsh-ris-ide/config.json` when the panel is initialised or the
 * user clicks "generate/update config". That rewrite is derived from discovery, so
 * the yds launcher row — which ris-ide cannot discover — disappears, and the names
 * of the rows it does generate follow whatever discovery thinks they are. Our row
 * has to be re-injected afterwards.
 *
 * The re-injection lives here, in the yds plugin, as an add-on: ris-ide is never
 * modified and never learns that we exist. We only watch the file it owns and
 * rewrite it *after* it changed, keeping every foreign row byte-for-byte.
 */

import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Where the list of watched workspaces lives (machine level, survives restarts). */
export const WATCH_STATE_FILENAME = '.dsh-ris-yds/ide-watch.json'

/** Debounce after a config write before we reconcile (ris-ide writes once). */
const DEBOUNCE_MS = 400

/** Polling fallback — covers editors/FS where `watch` misses events (network mounts). */
const POLL_MS = 2000

/** @returns {string} machine-level state file. */
export function watchStatePath(home = homedir()) {
  return join(home, WATCH_STATE_FILENAME)
}

/**
 * Register a workspace so the running plugin keeps re-injecting our launcher there.
 * @param workspace - absolute workspace root.
 * @returns {{ok: boolean, workspaces: string[]}} the updated list.
 */
export function registerWorkspace(workspace, home = homedir()) {
  const path = watchStatePath(home)
  const current = listWatched(home)
  const target = resolve(workspace)
  const next = current.includes(target) ? current : [...current, target]
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ workspaces: next }, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, workspaces: next }
  } catch (error) {
    return { ok: false, workspaces: current, error: String(error) }
  }
}

/**
 * Stop watching a workspace (used by `yds ide remove`).
 * @param workspace - absolute workspace root.
 * @returns {{ok: boolean, workspaces: string[]}} the updated list.
 */
export function unregisterWorkspace(workspace, home = homedir()) {
  const path = watchStatePath(home)
  const target = resolve(workspace)
  const next = listWatched(home).filter((item) => item !== target)
  try {
    if (next.length === 0) rmSync(path, { force: true })
    else writeFileSync(path, `${JSON.stringify({ workspaces: next }, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, workspaces: next }
  } catch (error) {
    return { ok: false, workspaces: next, error: String(error) }
  }
}

/**
 * @returns {string[]} workspaces the plugin should keep reconciled.
 */
export function listWatched(home = homedir()) {
  try {
    const parsed = JSON.parse(readFileSync(watchStatePath(home), 'utf8'))
    const list = Array.isArray(parsed?.workspaces) ? parsed.workspaces : []
    return list.filter((item) => typeof item === 'string' && item !== '').map((item) => resolve(item))
  } catch {
    return []
  }
}

/**
 * Reconcile one workspace's config if (and only if) we already own a row in it.
 *
 * Two refusals keep the add-on from fighting the user or ris-ide:
 *   - a workspace where our row was deliberately removed (`yds ide remove`) is left
 *     alone — {@link syncWorkspace} only acts while our row is present or absent
 *     *because ris-ide rewrote the file*;
 *   - a config that does not exist is not created (ris-ide owns the file's birth).
 * @param workspace - absolute workspace root.
 * @param deps - `{readConfig, writeConfig, hasOurRow, repair}` injected to avoid cycles.
 * @returns {Promise<{changed: boolean, reason: string}>} the outcome.
 */
export async function reconcileOnce(workspace, deps, options = {}) {
  const configPath = join(workspace, '.dsh-ris-ide', 'config.json')
  if (existsSync(configPath) !== true) return { changed: false, reason: 'no-config' }
  if (deps === undefined || typeof deps.repair !== 'function') return { changed: false, reason: 'no-repair' }
  let before
  try {
    before = readFileSync(configPath, 'utf8')
  } catch {
    return { changed: false, reason: 'unreadable' }
  }
  const restored = await deps.repair(workspace)
  if (restored?.changed !== true) return { changed: false, reason: restored?.reason ?? 'unchanged' }
  let after
  try {
    after = readFileSync(configPath, 'utf8')
  } catch {
    after = ''
  }
  if (after === before) return { changed: false, reason: 'no-op' }
  if (options.log !== undefined) options.log(`[yds] 已把启动器条目重新注入 ${configPath}`)
  return { changed: true, reason: restored.reason ?? 'injected' }
}

/**
 * Keep one workspace reconciled: `fs.watch` on `.dsh-ris-ide` plus a polling
 * fallback, both funnelled through a debounce. Returns a disposer.
 * @param workspace - absolute workspace root.
 * @param deps - see {@link reconcileOnce}.
 * @param options - `{log}` optional logger.
 * @returns {() => void} disposer.
 */
export function watchWorkspace(workspace, deps, options = {}) {
  const root = resolve(workspace)
  const dir = join(root, '.dsh-ris-ide')
  const configPath = join(dir, 'config.json')
  let timer
  let lastMtime = 0
  let stopped = false
  const run = () => {
    if (stopped) return
    void reconcileOnce(root, deps, options).catch(() => {})
  }
  const schedule = () => {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(run, DEBOUNCE_MS)
    timer.unref?.()
  }
  let watcher = null
  try {
    watcher = watch(dir, { persistent: false }, (event, filename) => {
      if (typeof filename === 'string' && filename !== 'config.json') return
      if (event !== undefined) schedule()
    })
    watcher.on?.('error', () => {})
  } catch {
    watcher = null // the directory may not exist yet; the poller below covers us
  }
  const poll = setInterval(() => {
    if (stopped) return
    try {
      const { mtimeMs } = statSync(configPath)
      if (mtimeMs !== lastMtime) {
        lastMtime = mtimeMs
        schedule()
      }
    } catch {
      // no config yet — nothing to reconcile
    }
  }, POLL_MS)
  poll.unref?.()
  return () => {
    stopped = true
    clearTimeout(timer)
    clearInterval(poll)
    try {
      watcher?.close?.()
    } catch {
      // ignore
    }
  }
}

/**
 * Start watchers for every registered workspace.
 * @param deps - see {@link reconcileOnce}.
 * @param options - `{log, home}` optional.
 * @returns {() => void} disposer stopping all watchers.
 */
export function watchAll(deps, options = {}) {
  const disposers = listWatched(options.home).map((workspace) => watchWorkspace(workspace, deps, options))
  return () => disposers.forEach((dispose) => { try { dispose() } catch { /* ignore */ } })
}
