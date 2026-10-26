/**
 * Host half of session-find: one authenticated POST route that searches the
 * conversation (human prompts and assistant replies) of one Session log.
 *
 * Each request reads that one log through `sessionQuery.observeSession` (the
 * live Session when attached, otherwise the stored log); nothing is indexed
 * and no other Session is read. Matching runs in a worker thread with a
 * deadline, so a slow regular expression cannot block the Host.
 */

import { compileQuery, conversationDocuments } from './search.js'
import { runSearch, SearchStopped } from './run.js'

/** Cordis function-plugin name. */
export const name = 'session-find'
/** The route registry and the Session log reader. */
export const inject = ['connection', 'sessionQuery']

/** Absolute route path; the browser addresses it document-relative as `api/session-find.search`. */
export const SEARCH_PATH = '/api/session-find.search'

const DEFAULTS = {
  maxQueryLength: 1000,
  maxResults: 300,
  snippetsPerMessage: 3,
  contextBefore: 60,
  contextAfter: 140,
  maxMatchChars: 200,
  timeoutMs: 10_000,
}

const RANGES = {
  maxQueryLength: [1, 100_000],
  maxResults: [1, 10_000],
  snippetsPerMessage: [1, 50],
  contextBefore: [0, 2_000],
  contextAfter: [0, 2_000],
  maxMatchChars: [1, 10_000],
  timeoutMs: [100, 600_000],
}

function validate(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { issues: [{ message: 'session-find: config must be an object' }] }
  }
  const value = { ...DEFAULTS, ...(raw ?? {}) }
  const issues = []
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
      issues.push({ path: [key], message: `session-find: ${key} must be an integer from ${min} to ${max}` })
    }
  }
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULTS)) issues.push({ path: [key], message: `session-find: unknown option ${key}` })
  }
  return issues.length > 0 ? { issues } : { value }
}

/** Plugin configuration validated at activation (Standard Schema form). */
export const Config = { '~standard': { version: 1, vendor: 'session-find', validate } }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

/**
 * Validate one request body.
 * @param {unknown} body - parsed JSON body.
 * @param {number} maxQueryLength - query length bound in UTF-16 code units.
 * @returns {{ ok: true, sessionId: string, query: string, regex: boolean } | { ok: false, error: string, message: string }} request or rejection.
 */
export function parseRequest(body, maxQueryLength) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'bad-request', message: 'body must be a JSON object' }
  const { sessionId, query, regex } = body
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 512) return { ok: false, error: 'bad-request', message: 'sessionId must be a non-empty string' }
  if (typeof regex !== 'boolean') return { ok: false, error: 'bad-request', message: 'regex must be a boolean' }
  if (typeof query !== 'string' || query.trim() === '') return { ok: false, error: 'invalid-query', message: 'empty query' }
  if (query.length > maxQueryLength) return { ok: false, error: 'invalid-query', message: `query longer than ${maxQueryLength} characters` }
  try {
    compileQuery(query, regex)
  } catch (error) {
    return { ok: false, error: 'invalid-query', message: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, sessionId, query, regex }
}

/**
 * Register the search route; it is removed with the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {typeof DEFAULTS} config - validated configuration.
 */
export function apply(ctx, config) {
  const limits = {
    maxResults: config.maxResults,
    snippetsPerMessage: config.snippetsPerMessage,
    contextBefore: config.contextBefore,
    contextAfter: config.contextAfter,
    maxMatchChars: config.maxMatchChars,
  }

  const search = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { error: 'bad-request', message: 'body is not JSON' })
    }
    const parsed = parseRequest(body, config.maxQueryLength)
    if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message })

    const started = Date.now()
    let documents
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(parsed.sessionId, { signal: request.signal, projectionMode: 'none' })
      documents = conversationDocuments(observation.events)
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return json(404, { error: 'not-found', message: 'session not found' })
      if (error?.code === 'SESSION_QUERY_ABORTED') return json(499, { error: 'aborted', message: 'request aborted' })
      ctx.logger.warn(`session-find: cannot read session ${parsed.sessionId}: ${error?.code ?? error?.name ?? 'Error'}`)
      return json(500, { error: 'read-failed', message: 'could not read the session log' })
    } finally {
      observation?.[Symbol.dispose]()
    }

    try {
      const result = await runSearch({ documents, query: parsed.query, regex: parsed.regex, limits }, config.timeoutMs, request.signal)
      return json(200, { sessionId: parsed.sessionId, scanned: documents.length, elapsedMs: Date.now() - started, ...result })
    } catch (error) {
      if (error instanceof SearchStopped && error.reason === 'timeout') {
        return json(504, { error: 'timeout', message: `search took longer than ${config.timeoutMs} ms` })
      }
      if (error instanceof SearchStopped && error.reason === 'aborted') return json(499, { error: 'aborted', message: 'request aborted' })
      ctx.logger.warn(`session-find: search failed: ${error instanceof Error ? error.message : String(error)}`)
      return json(500, { error: 'failed', message: 'search failed' })
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: SEARCH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: search,
  }), `session-find: POST ${SEARCH_PATH}`)
}
