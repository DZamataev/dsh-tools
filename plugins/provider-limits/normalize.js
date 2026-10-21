/**
 * Pure normalisation of provider quota payloads into one bucket list the
 * Client renders. Every percentage here is the share REMAINING: 100 means
 * untouched, 0 means exhausted.
 *
 * Bucket fields: `key` (stable id), `label` (English fallback text),
 * `window` (machine window class the Client selects on: 1h, 5h, daily, 7d,
 * monthly), `qualifier` (resource name distinguishing rows that share a
 * window, or ''), `remainingPct`, `resetAt` (epoch ms or null), `detail`.
 */

/**
 * A finite number, or null. Booleans are rejected because `Number(true)` is 1,
 * and NaN/Infinity are rejected because clamping turns NaN into a range end.
 * @param {unknown} value - raw payload value.
 * @returns {number | null} finite number or null.
 */
export function finite(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const clamp = value => Math.max(0, Math.min(100, value))
const round1 = value => Math.round(value * 10) / 10

/**
 * Milliseconds since epoch from an epoch number (seconds or ms) or an ISO string.
 * @param {unknown} value - raw timestamp.
 * @returns {number | null} epoch milliseconds or null.
 */
export function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value > 1e11 ? value : value * 1000)
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

function bucket(key, label, window, remainingPct, resetAt, detail = '') {
  if (remainingPct === null) return null
  return { key, label, window, remainingPct: round1(clamp(remainingPct)), resetAt: resetAt ?? null, detail }
}

const asObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
const asList = value => (Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object') : [])

const TEAMCLAUDE_BUCKETS = [
  // payload key, aggregate label, per-account label, window class, qualifier
  ['fiveHour', '5 hours', '5h', '5h', ''],
  ['weeklyShared', 'Week', 'week', '7d', ''],
  ['weeklySonnet', 'Week (Sonnet)', 'week/Sonnet', '7d', 'Sonnet'],
  ['weeklyFable', 'Week (Fable)', 'week/Fable', '7d', 'Fable'],
]

/**
 * TeamClaude `/teamclaude/quota`: the tier-weighted `aggregate` plus one row per account.
 * @param {Record<string, unknown>} data - parsed response body.
 * @returns {{ buckets: object[], accounts: object[], poolWindows: object[] }} normalised payload.
 */
export function teamclaudePayload(data) {
  const aggregate = asObject(data.aggregate)
  const buckets = []
  for (const [key, label, , window, qualifier] of TEAMCLAUDE_BUCKETS) {
    const row = aggregate[key]
    if (row === null || typeof row !== 'object') continue
    const ratio = finite(row.remaining)
    const known = Number.isInteger(row.knownAccounts) ? row.knownAccounts : null
    const made = bucket(key, label, window, ratio === null ? null : ratio * 100, epochMs(row.nextResetAt),
      known === null ? '' : `${known} accounts reporting`)
    if (made) buckets.push({ ...made, qualifier })
  }
  const accounts = asList(data.accounts).map((account) => {
    const rows = asObject(account.buckets)
    const accountBuckets = []
    for (const [key, , short, window, qualifier] of TEAMCLAUDE_BUCKETS) {
      const row = rows[key]
      if (row === null || typeof row !== 'object') continue
      const ratio = finite(row.remaining)
      const made = bucket(key, short, window, ratio === null ? null : ratio * 100, epochMs(row.resetAt))
      if (made) accountBuckets.push({ ...made, qualifier })
    }
    return {
      name: String(account.name ?? 'account'),
      disabled: account.disabled === true,
      tier: String(asObject(account.tier).rateLimitTier ?? ''),
      buckets: accountBuckets,
    }
  })
  return { buckets, accounts, poolWindows: [] }
}

const CODEX_WINDOW_LABELS = { '1h': 'Hour', '5h': '5 hours', daily: 'Day', '7d': 'Week', monthly: 'Month' }
// The same window arrives under different names depending on the list.
const CODEX_WINDOW_ALIASES = { weekly: '7d', hourly: '1h', '5hour': '5h', day: 'daily', month: 'monthly' }
const WINDOW_ORDER = ['1h', '5h', 'daily', '7d', 'monthly']

function codexLimits(rows, source) {
  const out = []
  for (const row of asList(rows)) {
    const max = finite(row.max_value)
    const remaining = finite(row.remaining_value)
    if (max === null || remaining === null) continue
    const rawWindow = String(row.limit_window ?? '')
    const window = CODEX_WINDOW_ALIASES[rawWindow] ?? rawWindow
    const limitType = String(row.limit_type ?? '')
    // A zero ceiling means nothing may be spent: exhausted, not absent.
    const pct = max <= 0 ? 0 : (remaining / max) * 100
    const made = bucket(`${window}:${limitType}`, CODEX_WINDOW_LABELS[window] ?? (window || 'limit'), window, pct,
      epochMs(row.reset_at), `${Math.round(remaining).toLocaleString('en-US')} / ${Math.round(max).toLocaleString('en-US')} ${limitType}`.trim())
    if (made) out.push({ ...made, source, limitType })
  }
  return out
}

/**
 * codex-lb `/v1/usage`: per (window, resource) the binding limit of the key's
 * own `limits` and the pool's `upstream_limits`, plus `account_pool_usage`,
 * which carries REMAINING percentages per window despite its name.
 * @param {Record<string, unknown>} data - parsed response body.
 * @returns {{ buckets: object[], accounts: object[], poolWindows: object[] }} normalised payload.
 */
export function codexPayload(data) {
  const tightest = new Map()
  for (const row of [...codexLimits(data.limits, 'key'), ...codexLimits(data.upstream_limits, 'pool')]) {
    const current = tightest.get(row.key)
    if (current === undefined || row.remainingPct < current.remainingPct) {
      tightest.set(row.key, { ...row, detail: `${row.detail} (${row.source === 'key' ? 'this key' : 'account pool'})` })
    }
  }
  const rows = [...tightest.values()]
  for (const row of rows) {
    const shared = row.limitType !== '' && rows.filter(other => other.window === row.window).length > 1
    row.qualifier = shared ? row.limitType : ''
    if (shared) row.label = `${row.label} (${row.limitType})`
  }
  const rank = window => (WINDOW_ORDER.includes(window) ? WINDOW_ORDER.indexOf(window) : WINDOW_ORDER.length)
  rows.sort((a, b) => rank(a.window) - rank(b.window) || a.limitType.localeCompare(b.limitType))
  const buckets = rows.map(({ source: _source, limitType: _limitType, ...rest }) => rest)

  const pool = asObject(data.account_pool_usage)
  const poolWindows = []
  for (const [slot, label, window] of [['primary', '5 hours', '5h'], ['secondary', 'Week', '7d']]) {
    const remaining = finite(pool[slot])
    if (remaining !== null) poolWindows.push({ key: slot, label, window, remainingPct: round1(clamp(remaining)) })
  }
  return { buckets, accounts: [], poolWindows }
}

const OPENCODE_GO_WINDOWS = [['rolling', '5 hours', '5h'], ['weekly', 'Week', '7d'], ['monthly', 'Month', 'monthly']]

/**
 * OpenCode Go `/zen/go/v1/usage`: `percent` is the share USED, so remaining is
 * `100 - percent`; any `status` other than `ok` is shown as exhausted.
 * @param {Record<string, unknown>} data - parsed response body.
 * @returns {{ buckets: object[], accounts: object[], poolWindows: object[] }} normalised payload.
 */
export function opencodeGoPayload(data) {
  const usage = asObject(data.usage)
  const buckets = []
  for (const [key, label, window] of OPENCODE_GO_WINDOWS) {
    const row = usage[key]
    if (row === null || typeof row !== 'object') continue
    const status = typeof row.status === 'string' ? row.status : ''
    const used = finite(row.percent)
    const remaining = status !== '' && status !== 'ok' ? 0 : used === null ? null : 100 - used
    const detail = used === null ? status : `${status || 'status unknown'} · ${used}% used`
    const made = bucket(key, label, window, remaining, epochMs(row.resetsAt), detail)
    if (made) buckets.push({ ...made, qualifier: '' })
  }
  return { buckets, accounts: [], poolWindows: [] }
}

/** Parsers keyed by adapter kind. */
export const PARSERS = { teamclaude: teamclaudePayload, 'codex-lb': codexPayload, 'opencode-go': opencodeGoPayload }

/**
 * One Statuspage `summary.json` into a three-state health row: `ok` true,
 * false, or null when unknown. The page indicator and the named component
 * both vote; a missing component does not vote; an unknown indicator word
 * counts as trouble.
 * @param {{ id: string, label: string, component: string }} page - configured page.
 * @param {Record<string, unknown>} data - parsed summary.
 * @returns {object} health row.
 */
export function statusPayload(page, data) {
  const status = asObject(data.status)
  const indicator = String(status.indicator ?? '')
  const description = String(status.description ?? '')
  const component = asList(data.components).find(item => item.name === page.component)
  const componentStatus = component === undefined ? '' : String(component.status ?? '')
  const pageOk = indicator === 'none'
  const componentOk = componentStatus === '' ? null : componentStatus === 'operational'
  return {
    id: page.id,
    label: page.label,
    ok: componentOk === null ? pageOk : pageOk && componentOk,
    description,
    component: page.component,
    componentStatus,
    incidents: asList(data.incidents).slice(0, 3).map(incident => String(incident.name ?? 'incident')),
    error: null,
  }
}

/**
 * Whether a URL is on the opencode.ai host (or a subdomain).
 * @param {string} url - absolute URL.
 * @returns {boolean} host match.
 */
export function isOpencodeHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    // Unparseable URL: not an opencode.ai host.
    return false
  }
}

/**
 * The OpenCode Go API root that `/usage` hangs off; `/v1` is appended on
 * opencode.ai hosts because `/zen/go/usage` is a 404.
 * @param {string} url - configured base URL.
 * @returns {string} API root without a trailing slash.
 */
export function opencodeGoApiBase(url) {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (isOpencodeHost(trimmed) && !new URL(trimmed).pathname.replace(/\/+$/, '').endsWith('/v1')) return `${trimmed}/v1`
  return trimmed
}

/**
 * Scheme, host, and port of a URL, or '' when it is not absolute.
 * @param {string} url - configured URL.
 * @returns {string} origin or ''.
 */
export function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    // Not an absolute URL: there is no origin to query.
    return ''
  }
}
