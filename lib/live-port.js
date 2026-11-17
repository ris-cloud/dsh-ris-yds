// WHERE a project's dev server actually listens, as opposed to where the project
// says it should.
//
// `.vscode/settings.json` declares `yds.webConfig[...].yds.localDevUrl` (port 3004 in
// one real project), but the running dev server had taken the next free port (3003):
// webpack/mdf-node fall forward when the declared port is busy. The extension rewrites
// the module's `extend*.min.js` to the dev-server URL, so a stale port means the
// workbench loads a bundle that answers 404 — the page renders, the module is dead.
//
// The observation comes from the program's own log: the ris-ide 🌐 button starts the
// debugging browser and passes along the URL that log announced, which is the live
// server. It is kept in MEMORY only, because a port is true exactly as long as that
// dev server runs: a restart announces a new one, and a stale memory would be worse
// than no memory.

/** How long an observation stays believable without being re-observed. */
export const LIVE_PORT_TTL_MS = 6 * 60 * 60 * 1000

/** @type {Map<string, {port: number, at: number}>} projectDir → last live port. */
const observed = new Map()

/**
 * Record the port a project's dev server is actually listening on.
 *
 * @param {string} projectDir - absolute yds project directory (the map key).
 * @param {number} port - the live dev-server port; anything invalid is ignored.
 * @param {number} [now] - clock, injectable for tests.
 * @returns {void}
 */
export function rememberLiveDevPort(projectDir, port, now = Date.now()) {
  if (typeof projectDir !== 'string' || projectDir === '') return
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return
  observed.set(projectDir, { port, at: Number.isFinite(now) ? now : Date.now() })
}

/**
 * The last observed live dev-server port for a project, or undefined when unknown.
 *
 * @param {string} projectDir - absolute yds project directory.
 * @param {number} [now] - clock, injectable for tests.
 * @returns {number|undefined} the port, or undefined when never/too long ago observed.
 */
export function liveDevPort(projectDir, now = Date.now()) {
  if (typeof projectDir !== 'string' || projectDir === '') return undefined
  const entry = observed.get(projectDir)
  if (entry === undefined) return undefined
  if ((Number.isFinite(now) ? now : Date.now()) - entry.at > LIVE_PORT_TTL_MS) {
    observed.delete(projectDir)
    return undefined
  }
  return entry.port
}

/**
 * The port of a `http://127.0.0.1:<port>/…` URL, or undefined.
 *
 * The URL comes from a program's log (arbitrary text), so nothing is assumed about
 * its shape beyond "it parses as a URL and carries a port".
 * @param {string} raw - the URL a dev server announced.
 * @returns {number|undefined} its port.
 */
export function portOfUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const port = Number(new URL(raw.trim()).port)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}

/** Forget a project's observation (tests, and any explicit reset). */
export function forgetLiveDevPort(projectDir) {
  observed.delete(projectDir)
}
