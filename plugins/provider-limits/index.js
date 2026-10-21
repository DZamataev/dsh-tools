/**
 * Host half of provider-limits: one authenticated GET route on the Web server
 * returning the remaining quota of every configured LLM provider route that
 * exposes a quota API, plus upstream Statuspage health.
 *
 * Provider routes are read from the live `providers` config of the LLM entry
 * named by `llmEntry` (llm-pi-ai by default), so a new route appears without
 * editing this plugin. API keys resolve through the credentials service and
 * are sent only to that provider's own upstream; responses and error strings
 * never contain them (failures are `HTTP <status>` or an error code/name).
 */

import { PARSERS, isOpencodeHost, opencodeGoApiBase, originOf, statusPayload } from './normalize.js'

/** Cordis function-plugin name. */
export const name = 'provider-limits'
/** The route carrier and the browser trust fence guarding the route. */
export const inject = ['webServer', 'connection']

/** GET route returning the limits payload; `?refresh=1` bypasses both caches. */
export const LIMITS_PATH = '/provider-limits/limits'

const KINDS = ['teamclaude', 'codex-lb', 'opencode-go', 'none']

const DEFAULTS = {
  llmEntry: '@deepseek-ai/dsh-llm-pi-ai',
  routes: {},
  opencodeGoBaseURL: 'https://opencode.ai/zen/go/v1',
  cacheTtlMs: 60_000,
  requestTimeoutMs: 12_000,
  pollMs: 45_000,
  statusCacheTtlMs: 120_000,
  statusTimeoutMs: 8_000,
  statusPages: [
    { id: 'anthropic', label: 'Anthropic', url: 'https://status.claude.com/api/v2/summary.json', component: 'Claude API (api.anthropic.com)' },
    { id: 'openai', label: 'OpenAI', url: 'https://status.openai.com/api/v2/summary.json', component: 'Codex API' },
  ],
}

function validate(raw) {
  const issues = []
  const value = { ...DEFAULTS, ...(raw ?? {}) }
  const issue = (path, message) => issues.push({ path: [path], message: `provider-limits: ${path} ${message}` })
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { issues: [{ message: 'provider-limits: config must be an object' }] }
  }
  if (typeof value.llmEntry !== 'string' || value.llmEntry === '') issue('llmEntry', 'must be a non-empty package name')
  if (typeof value.opencodeGoBaseURL !== 'string' || originOf(value.opencodeGoBaseURL) === '') issue('opencodeGoBaseURL', 'must be an absolute URL')
  for (const key of ['cacheTtlMs', 'requestTimeoutMs', 'pollMs', 'statusCacheTtlMs', 'statusTimeoutMs']) {
    if (!Number.isInteger(value[key]) || value[key] < 1_000 || value[key] > 3_600_000) issue(key, 'must be an integer from 1000 to 3600000')
  }
  if (value.routes === null || typeof value.routes !== 'object' || Array.isArray(value.routes)) issue('routes', 'must map route ids to an adapter kind')
  else {
    for (const [route, kind] of Object.entries(value.routes)) {
      if (!KINDS.includes(kind)) issue('routes', `.${route} must be one of ${KINDS.join(', ')}`)
    }
  }
  if (!Array.isArray(value.statusPages)) issue('statusPages', 'must be a list')
  else {
    value.statusPages.forEach((page, index) => {
      const ok = page !== null && typeof page === 'object'
        && ['id', 'label', 'url', 'component'].every(field => typeof page[field] === 'string' && page[field] !== '')
        && originOf(page.url) !== ''
      if (!ok) issue('statusPages', `[${index}] needs string id, label, absolute url, and component`)
    })
  }
  return issues.length > 0 ? { issues } : { value }
}

/** Plugin configuration validated at activation (Standard Schema form). */
export const Config = { '~standard': { version: 1, vendor: 'provider-limits', validate } }

/**
 * Adapter kind for one configured provider route, or null when it has no known quota API.
 * @param {string} id - route id.
 * @param {Record<string, unknown>} profile - route profile.
 * @param {Record<string, string>} overrides - `routes` config.
 * @returns {string | null} adapter kind.
 */
export function kindOf(id, profile, overrides) {
  const forced = overrides[id]
  if (forced !== undefined) return forced === 'none' ? null : forced
  const base = typeof profile.baseURL === 'string' ? profile.baseURL : ''
  let url = null
  try { url = base === '' ? null : new URL(base) } catch { /* Malformed baseURL: matched by route id only. */ }
  if (id === 'opencode-go' || (url !== null && isOpencodeHost(base) && /^\/zen\/go(\/|$)/.test(url.pathname))) return 'opencode-go'
  if (url !== null && /\/backend-api\/codex\/?$/.test(url.pathname)) return 'codex-lb'
  const anthropicFamily = id === 'anthropic' || profile.api === 'anthropic-messages'
  if (anthropicFamily && url !== null && url.hostname !== 'api.anthropic.com') return 'teamclaude'
  return null
}

function endpointOf(kind, profile, config) {
  const base = typeof profile.baseURL === 'string' ? profile.baseURL : ''
  if (kind === 'opencode-go') return `${opencodeGoApiBase(base || config.opencodeGoBaseURL)}/usage`
  const origin = originOf(base)
  if (origin === '') return ''
  return kind === 'teamclaude' ? `${origin}/teamclaude/quota` : `${origin}/v1/usage`
}

function failureText(error) {
  // Error codes and names only: messages can echo request details.
  const code = error?.cause?.code ?? error?.code
  return typeof code === 'string' ? code : String(error?.name ?? 'Error')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Register the limits route; caches and in-flight requests end with the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {typeof DEFAULTS} config - validated configuration.
 */
export function apply(ctx, config) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'provider-limits: abort upstream requests')

  /** Configured routes with a known adapter, in config order. */
  const targets = () => {
    const loader = ctx.get('loader')
    const entry = loader === undefined
      ? undefined
      : [...loader.entries()].find(candidate => candidate.options.name === config.llmEntry && candidate.options.disabled !== true)
    if (entry === undefined) {
      throw new Error(`no active "${config.llmEntry}" entry; set llmEntry to the package that owns provider routes`)
    }
    const providers = entry.options.config?.providers
    if (providers === null || typeof providers !== 'object') return []
    const out = []
    for (const [id, profile] of Object.entries(providers)) {
      if (profile === null || typeof profile !== 'object') continue
      const kind = kindOf(id, profile, config.routes)
      if (kind === null) continue
      out.push({
        id,
        label: typeof profile.displayName === 'string' && profile.displayName !== '' ? profile.displayName : id,
        kind,
        url: endpointOf(kind, profile, config),
        keyRef: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : '',
      })
    }
    return out
  }

  const resolveKey = async (ref) => {
    if (ref === '') return ''
    const credentials = ctx.get('credentials')
    const value = credentials === undefined ? process.env[ref] : (await credentials.resolve(ref))?.value
    return typeof value === 'string' ? value.trim() : ''
  }

  const empty = { buckets: [], accounts: [], poolWindows: [] }

  const fetchTarget = async (target) => {
    const base = { id: target.id, label: target.label, kind: target.kind }
    if (target.url === '') return { ...base, ok: false, error: 'no baseURL configured', ...empty }
    let key
    try {
      key = await resolveKey(target.keyRef)
    } catch (error) {
      return { ...base, ok: false, error: `credential lookup failed (${failureText(error)})`, ...empty }
    }
    if (key === '') return { ...base, ok: false, error: 'no API key configured', ...empty }
    const headers = target.kind === 'teamclaude' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }
    let data
    try {
      const response = await fetch(target.url, {
        headers: { ...headers, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs)]),
      })
      if (!response.ok) {
        const hint = target.kind === 'opencode-go' && response.status === 403 ? ' (no OpenCode Go subscription)' : ''
        return { ...base, ok: false, error: `HTTP ${response.status}${hint}`, ...empty }
      }
      data = await response.json()
    } catch (error) {
      return { ...base, ok: false, error: failureText(error), ...empty }
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ...base, ok: false, error: 'unexpected payload', ...empty }
    try {
      return { ...base, ok: true, error: null, ...PARSERS[target.kind](data) }
    } catch (error) {
      ctx.logger.warn(`provider-limits: could not parse the ${target.id} payload: ${failureText(error)}`)
      return { ...base, ok: false, error: 'unparseable payload', ...empty }
    }
  }

  const fetchStatus = async (page) => {
    const base = { id: page.id, label: page.label, component: page.component, description: '', componentStatus: '', incidents: [] }
    try {
      const response = await fetch(page.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.statusTimeoutMs)]),
      })
      if (!response.ok) return { ...base, ok: null, error: `HTTP ${response.status}` }
      const data = await response.json()
      if (data === null || typeof data !== 'object') return { ...base, ok: null, error: 'unexpected payload' }
      return statusPayload(page, data)
    } catch (error) {
      return { ...base, ok: null, error: failureText(error) }
    }
  }

  /** A TTL cache sharing one in-flight load among concurrent callers. */
  const cached = (ttlMs, load) => {
    let value, expiresAt = 0, inflight
    return (force) => {
      if (!force && value !== undefined && Date.now() < expiresAt) return Promise.resolve(value)
      if (inflight !== undefined) return inflight
      inflight = load().then((next) => {
        value = next
        expiresAt = Date.now() + ttlMs
        return next
      }).finally(() => { inflight = undefined })
      return inflight
    }
  }

  const statuses = cached(config.statusCacheTtlMs, () => Promise.all(config.statusPages.map(fetchStatus)))
  const quotas = cached(config.cacheTtlMs, async () => {
    let list
    try {
      list = targets()
    } catch (error) {
      return { providers: [], error: error instanceof Error ? error.message : String(error) }
    }
    return { providers: await Promise.all(list.map(fetchTarget)), error: null }
  })

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LIMITS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const force = new URL(String(req.url), 'http://localhost').searchParams.get('refresh') === '1'
      try {
        const [quota, services] = await Promise.all([quotas(force), statuses(force)])
        sendJson(res, 200, { fetchedAt: Date.now(), pollMs: config.pollMs, ...quota, services })
      } catch (error) {
        if (lifetime.signal.aborted) return
        ctx.logger.warn(`provider-limits: limits request failed: ${failureText(error)}`)
        sendJson(res, 500, { error: failureText(error) })
      }
    },
  }), `provider-limits: GET ${LIMITS_PATH}`)
}
