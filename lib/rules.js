// The proxy rule table is machine-wide AND global: there is exactly one table for the
// whole box, and the panel saves it wholesale ("全局一张表、保存即整表覆盖"). The daemon's
// `POST /v1/proxy` mirrors that contract, so yds owns its share outright:
//
//   * `yds start` writes the COMPLETE set of yds rows (whatever yds rows were there
//     before — from any workspace — are replaced),
//   * `yds stop` removes EVERY `source: 'yds'` row.
//
// There is no cross-workspace bookkeeping any more: no `owners` map, no per-workspace
// subtraction. Two projects that both run `yds start` do not merge their endpoints;
// the last save simply wins, which is exactly what "没有交叉配置" means.
//
// The only identity that must stay distinct is the program: `java.exe` is the Windows
// image and `java` is the process name a WSL/Linux side matches, so the group key is
// `side|program` and the two live side by side instead of collapsing into one row.
export const YDS_RULE_SOURCE = 'yds'

/** Program identity for duplicate detection: basename, lower-case, no script suffix. */
export function programKeyOf(program) {
  if (typeof program !== 'string') return ''
  const text = program.trim()
  if (text === '') return ''
  // A wildcard program (`C:\devkit\jdk*\bin\*.exe`) has no basename identity: its
  // basename is `*.exe`, which would collapse EVERY wildcard program into one row.
  // Keep the whole pattern as the key instead.
  if (/[*?]/.test(text)) return `raw:${text.toLowerCase()}`
  const base = text.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.(exe|cmd|bat|sh)$/, '')
}

/**
 * Identity of one rule inside the yds share: the side it applies to plus the program.
 * `windows|java` and `local|java` are different rows on purpose (the Windows engine
 * matches `java.exe`, the WSL/Linux side matches `java`).
 * @param {{side?: string, program?: string}} rule
 * @returns {string}
 */
export function ruleGroupKey(rule) {
  const side = typeof rule?.side === 'string' ? rule.side.trim().toLowerCase() : ''
  return `${side}|${programKeyOf(rule?.program)}`
}

function hostList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function portList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function uniquePush(target, values) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value)
  }
}

function hostText(hosts) {
  return hosts.join(',')
}

/** A rule allows every port when any caller says `*`: keep the wildcard form. */
function portText(ports) {
  return ports.includes('*') ? '*' : ports.join(',')
}

/**
 * Validate one fresh row and canonicalize the fields the engine reads. Unknown fields
 * (id, label, side, ...) are kept as they came; only the list/boolean fields are
 * normalized so a hand-written value cannot reach the engine half-parsed.
 * @returns {object|null} null when the row cannot be a rule (logged).
 */
function normalizeFreshRow(row, { log } = {}) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    log?.('代理规则：忽略一条不是对象的规则')
    return null
  }
  const program = typeof row.program === 'string' ? row.program.trim() : ''
  if (program === '') {
    log?.(`代理规则：忽略一条没有 program 的规则（id=${String(row.id ?? '?')}）`)
    return null
  }
  const hosts = hostList(row.hosts)
  const ports = portList(row.ports)
  if (hosts.length === 0 && ports.length === 0) {
    log?.(`代理规则：忽略一条既没有 host 也没有 port 的规则（id=${String(row.id ?? '?')}）`)
    return null
  }
  return {
    ...row,
    program,
    hosts: hostText(hosts),
    ports: portText(ports),
    enabled: row.enabled !== false,
    shadow: row.shadow === true,
    direct: row.direct === true,
    source: YDS_RULE_SOURCE,
  }
}

/** Union two fresh rows that name the same side+program (a caller bug, not the norm). */
function mergeFreshRows(into, extra) {
  const hosts = hostList(into.hosts)
  uniquePush(hosts, hostList(extra.hosts))
  const ports = portList(into.ports)
  uniquePush(ports, portList(extra.ports))
  return {
    ...into,
    hosts: hostText(hosts),
    ports: portText(ports),
    // Lists union; `enabled` is satisfied by either row; the opt-ins only survive if
    // every copy asked for them (a stray duplicate must not turn interception off).
    enabled: into.enabled === true || extra.enabled === true,
    shadow: into.shadow === true && extra.shadow === true,
    direct: into.direct === true && extra.direct === true,
  }
}

/**
 * Build the table to save: every non-yds row is passed through untouched, then the
 * fresh yds rows are appended (one row per side+program, ids preserved).
 *
 * This is a WHOLE-TABLE function: the return value is the complete rule list, so the
 * caller can PUT it to the daemon as-is. An empty `freshRules` array therefore removes
 * every yds row (that is `yds stop`) and leaves the non-yds rows alone.
 * @param {object[]} existingRules - rows currently stored (any source).
 * @param {object[]} freshRules - the yds rows to own; empty = remove them all.
 * @param {{log?: (line: string) => void}} [options]
 * @returns {object[]} the complete table, non-yds rows first.
 */
export function mergeYdsRules(existingRules, freshRules, { log } = {}) {
  const rows = []
  for (const row of Array.isArray(existingRules) ? existingRules : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    // The yds share is rebuilt from `freshRules` below, never inherited: a row that
    // is not regenerated must disappear (an endpoint that moved, or another
    // workspace's rows, which the global table replaces wholesale).
    if (row.source === YDS_RULE_SOURCE) continue
    rows.push(row)
  }
  const fresh = new Map()
  const order = []
  for (const row of Array.isArray(freshRules) ? freshRules : []) {
    const normalized = normalizeFreshRow(row, { log })
    if (normalized === null) continue
    const key = ruleGroupKey(normalized)
    const existing = fresh.get(key)
    if (existing === undefined) {
      fresh.set(key, normalized)
      order.push(key)
      continue
    }
    fresh.set(key, mergeFreshRows(existing, normalized))
  }
  for (const key of order) rows.push(fresh.get(key))
  return rows
}

/** Just the yds rows of a stored table (for counts and withdrawal math). */
export function ydsRowsOf(existingRules) {
  return (Array.isArray(existingRules) ? existingRules : [])
    .filter((row) => row !== null && typeof row === 'object' && row.source === YDS_RULE_SOURCE)
}

/**
 * How many yds rows and distinct hosts disappear between two table snapshots, for the
 * CLI text. Counts yds rows only: the non-yds rows are never ours to report on.
 * @returns {{rules: number, hosts: number}}
 */
export function withdrawnBetween(beforeRules, afterRules) {
  const hosts = (rows) => {
    const out = new Set()
    for (const row of ydsRowsOf(rows)) {
      for (const host of hostList(row.hosts)) out.add(host)
    }
    return out
  }
  const before = hosts(beforeRules)
  const after = hosts(afterRules)
  let removed = 0
  for (const host of before) {
    if (!after.has(host)) removed += 1
  }
  return {
    rules: Math.max(0, ydsRowsOf(beforeRules).length - ydsRowsOf(afterRules).length),
    hosts: removed,
  }
}
