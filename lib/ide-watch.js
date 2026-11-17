/**
 * Watch ris-ide's program config and keep our launcher row in it.
 *
 * ris-ide owns `.dsh-ris-ide/config.json` and rebuilds it from discovery when the
 * panel is initialised or the user clicks "generate/overwrite config" (builds before
 * the 2026-11-11 upgrade also rebuilt it on every "update config"). A discovery
 * rebuild drops the yds launcher row — ris-ide cannot discover a `startCommand`
 * program — and renames the rows it does generate to whatever discovery thinks they
 * are, so our row has to be re-injected afterwards.
 *
 * Current ris-ide keeps a foreign row that carries `startCommand`
 * (`mergeConfigDocuments`), so a plain "update config" no longer drops us: the
 * watcher is now a safety net for generate/overwrite and for older IDE builds, not
 * the only thing keeping the row alive.
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

/** ris-ide's workspace mirror: every workspace a dsh window has open right now. */
export const DSH_WINDOW_STATE = '.dsh-ris-ide/dsh-window.json'

/** How often the watcher picks up newly opened workspaces and new suppressions. */
const RESCAN_MS = 10_000

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
    // An explicit re-apply IS the consent: drop an earlier `yds ide remove`.
    const suppressed = listSuppressed(home).filter((item) => item !== target)
    writeFileSync(path, `${JSON.stringify({ workspaces: next, suppressed }, null, 2)}\n`, { mode: 0o600 })
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
    const suppressed = listSuppressed(home)
    if (next.length === 0 && suppressed.length === 0) rmSync(path, { force: true })
    else writeFileSync(path, `${JSON.stringify({ workspaces: next, suppressed }, null, 2)}\n`, { mode: 0o600 })
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
 * Workspaces the user told us to leave alone (`yds ide remove`).
 * @param home - machine home directory.
 * @returns {string[]} absolute paths.
 */
export function listSuppressed(home = homedir()) {
  try {
    const parsed = JSON.parse(readFileSync(watchStatePath(home), 'utf8'))
    const list = Array.isArray(parsed?.suppressed) ? parsed.suppressed : []
    return list.filter((item) => typeof item === 'string' && item !== '').map((item) => resolve(item))
  } catch {
    return []
  }
}

/**
 * Remember that a workspace's launcher row was removed on purpose, so the
 * self-healing watcher does not put it back.
 * @param workspace - absolute workspace root.
 * @param home - machine home directory.
 * @returns {{ok: boolean, suppressed: string[]}} the new suppression list.
 */
export function suppressWorkspace(workspace, home = homedir()) {
  const path = watchStatePath(home)
  const target = resolve(workspace)
  const current = listSuppressed(home)
  const next = current.includes(target) ? current : [...current, target]
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ workspaces: listWatched(home), suppressed: next }, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, suppressed: next }
  } catch (error) {
    return { ok: false, suppressed: current, error: String(error) }
  }
}

/**
 * Workspaces a dsh window has open right now, from ris-ide's own mirror.
 *
 * The state file only knows workspaces where `yds ide apply` ran; that misses the
 * case that actually hurt (m04506): a yds project opened later, its launcher row
 * dropped by a ris-ide config rebuild, and nobody registered it. The mirror is
 * written by ris-ide for every window/workspace, so it is the honest answer to
 * "which configs might need us".
 * @param home - machine home directory.
 * @returns {string[]} absolute workspace paths (deduplicated).
 */
export function discoverWorkspaces(home = homedir()) {
  const out = new Set()
  try {
    const parsed = JSON.parse(readFileSync(join(home, DSH_WINDOW_STATE), 'utf8'))
    for (const row of Array.isArray(parsed?.windows) ? parsed.windows : []) {
      if (typeof row?.cwd === 'string' && row.cwd.startsWith('/')) out.add(resolve(row.cwd))
    }
    for (const row of Array.isArray(parsed?.workspaces) ? parsed.workspaces : []) {
      if (typeof row?.cwd === 'string' && row.cwd.startsWith('/')) out.add(resolve(row.cwd))
    }
  } catch {
    // no mirror yet (ris-ide never ran) — nothing to discover
  }
  return [...out]
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
  const running = new Map()
  const home = options.home
  const wanted = () => {
    const roots = new Set([...listWatched(home), ...discoverWorkspaces(home)])
    for (const root of listSuppressed(home)) roots.delete(root)
    return roots
  }
  const sync = () => {
    for (const root of wanted()) {
      if (running.has(root)) continue
      running.set(root, watchWorkspace(root, deps, options))
    }
  }
  sync()
  // New dsh window / new project / new `yds ide remove` mid-session: re-read both
  // lists instead of trusting the ones present at plugin load (m04506).
  const rescan = setInterval(sync, RESCAN_MS)
  rescan.unref?.()
  return () => {
    clearInterval(rescan)
    for (const dispose of running.values()) { try { dispose() } catch { /* ignore */ } }
    running.clear()
  }
}
