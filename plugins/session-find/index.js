/**
 * Host half of session-find: two authenticated POST routes over the
 * conversation (human prompts and assistant replies) of one Session log.
 * `session-find.search` lists matches; `session-find.context` returns whole
 * messages around one of them.
 *
 * Each request reads that one log through `sessionQuery.observeSession` (the
 * live Session when attached, otherwise the stored log); nothing is indexed
 * and no other Session is read. Matching runs in a worker thread with a
 * deadline, so a slow regular expression cannot block the Host.
 */

import { boundMessages, compileQuery, contextWindow, conversationDocuments, targetOrdinal } from './search.js'
import { runSearch, SearchStopped } from './run.js'

/** Cordis function-plugin name. */
export const name = 'session-find'
/** The route registry and the Session log reader. */
export const inject = ['connection', 'sessionQuery']

/** Search route; the browser addresses it document-relative as `api/session-find.search`. */
export const SEARCH_PATH = '/api/session-find.search'
/** Context route; the browser addresses it document-relative as `api/session-find.context`. */
export const CONTEXT_PATH = '/api/session-find.context'

const DEFAULTS = {
  maxQueryLength: 1000,
  maxResults: 300,
  snippetsPerMessage: 3,
  contextBefore: 60,
  contextAfter: 140,
  maxMatchChars: 200,
  timeoutMs: 10_000,
  maxContextMessages: 100,
  maxMessageChars: 200_000,
  maxHighlightStrings: 200,
  maxHighlightChars: 1_000,
}

const RANGES = {
  maxQueryLength: [1, 100_000],
  maxResults: [1, 10_000],
  snippetsPerMessage: [1, 50],
  contextBefore: [0, 2_000],
  contextAfter: [0, 2_000],
  maxMatchChars: [1, 10_000],
  timeoutMs: [100, 600_000],
  maxContextMessages: [1, 10_000],
  maxMessageChars: [1_000, 10_000_000],
  maxHighlightStrings: [1, 10_000],
  maxHighlightChars: [1, 100_000],
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

const rejection = (error, message) => ({ ok: false, error, message })

function sessionIdOf(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return rejection('bad-request', 'body must be a JSON object')
  const { sessionId } = body
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 512) return rejection('bad-request', 'sessionId must be a non-empty string')
  return { ok: true, sessionId }
}

const ROLES = ['user', 'assistant']
const ORDERS = ['oldest', 'newest']

/**
 * Validate one search request body. `order` (`oldest` | `newest`, default
 * `oldest`) and `roles` (non-empty subset of `user`, `assistant`, default
 * both) are optional.
 * @param {unknown} body - parsed JSON body.
 * @param {number} maxQueryLength - query length bound in UTF-16 code units.
 * @returns {{ ok: true, sessionId: string, query: string, regex: boolean, order: string, roles: string[] } | { ok: false, error: string, message: string }} request or rejection.
 */
export function parseRequest(body, maxQueryLength) {
  const session = sessionIdOf(body)
  if (!session.ok) return session
  const query = queryOf(body, maxQueryLength)
  if (!query.ok) return query
  const { order = 'oldest', roles = ROLES } = body
  if (!ORDERS.includes(order)) return rejection('bad-request', `order must be one of ${ORDERS.join(', ')}`)
  if (!Array.isArray(roles) || roles.length === 0 || roles.some(role => !ROLES.includes(role))) {
    return rejection('bad-request', `roles must be a non-empty subset of ${ROLES.join(', ')}`)
  }
  return { ok: true, sessionId: session.sessionId, query: query.query, regex: query.regex, order, roles: [...new Set(roles)] }
}

/** The `query` and `regex` fields of a request body, validated and compilable. */
function queryOf(body, maxQueryLength) {
  const { query, regex } = body
  if (typeof regex !== 'boolean') return rejection('bad-request', 'regex must be a boolean')
  if (typeof query !== 'string' || query.trim() === '') return rejection('invalid-query', 'empty query')
  if (query.length > maxQueryLength) return rejection('invalid-query', `query longer than ${maxQueryLength} characters`)
  try {
    compileQuery(query, regex)
  } catch (error) {
    return rejection('invalid-query', error instanceof Error ? error.message : String(error))
  }
  return { ok: true, query, regex }
}

/**
 * Validate one context request body. `query` and `regex` are the search the
 * window was opened from; the Host uses them to find what to highlight.
 * Optional `focus` is the target's first match offset from the search
 * result, used to crop a long target when the highlight stage fails.
 * @param {unknown} body - parsed JSON body.
 * @param {number} maxContextMessages - bound on `before` and on `after`.
 * @param {number} maxQueryLength - query length bound in UTF-16 code units.
 * @returns {{ ok: true, sessionId: string, seq: number, before: number, after: number, query: string, regex: boolean, focus: number | null } | { ok: false, error: string, message: string }} request or rejection.
 */
export function parseContextRequest(body, maxContextMessages, maxQueryLength) {
  const session = sessionIdOf(body)
  if (!session.ok) return session
  const { seq, before, after } = body
  if (!Number.isSafeInteger(seq) || seq < 0) return rejection('bad-request', 'seq must be a non-negative integer')
  for (const [key, value] of [['before', before], ['after', after]]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maxContextMessages) {
      return rejection('bad-request', `${key} must be an integer from 0 to ${maxContextMessages}`)
    }
  }
  const { focus = null } = body
  if (focus !== null && (!Number.isSafeInteger(focus) || focus < 0)) return rejection('bad-request', 'focus must be a non-negative integer')
  const query = queryOf(body, maxQueryLength)
  if (!query.ok) return query
  return { ok: true, sessionId: session.sessionId, seq, before, after, query: query.query, regex: query.regex, focus }
}

/**
 * Register the search and context routes; they are removed with the plugin.
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

  const bodyOf = async (request) => {
    try {
      return { ok: true, body: await request.json() }
    } catch {
      return { ok: false, response: json(400, { error: 'bad-request', message: 'body is not JSON' }) }
    }
  }

  /** The Session's conversation, or the error response for a failed read. */
  const readConversation = async (sessionId, signal) => {
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
      return { ok: true, documents: conversationDocuments(observation.events) }
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { ok: false, response: json(404, { error: 'not-found', message: 'session not found' }) }
      if (error?.code === 'SESSION_QUERY_ABORTED') return { ok: false, response: json(499, { error: 'aborted', message: 'request aborted' }) }
      ctx.logger.warn(`session-find: cannot read session ${sessionId}: ${error?.code ?? error?.name ?? 'Error'}`)
      return { ok: false, response: json(500, { error: 'read-failed', message: 'could not read the session log' }) }
    } finally {
      observation?.[Symbol.dispose]()
    }
  }

  const search = async (request, signal) => {
    const read = await bodyOf(request)
    if (!read.ok) return read.response
    const parsed = parseRequest(read.body, config.maxQueryLength)
    if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message })
    const started = Date.now()
    const conversation = await readConversation(parsed.sessionId, signal)
    if (!conversation.ok) return conversation.response
    const { documents } = conversation
    // Filter and order before matching, so maxResults keeps the requested end.
    const searched = documents.filter(document => parsed.roles.includes(document.role))
    if (parsed.order === 'newest') searched.reverse()
    try {
      const result = await runSearch({ kind: 'search', documents: searched, query: parsed.query, regex: parsed.regex, limits }, config.timeoutMs, signal)
      return json(200, { sessionId: parsed.sessionId, scanned: searched.length, order: parsed.order, roles: parsed.roles, elapsedMs: Date.now() - started, ...result })
    } catch (error) {
      if (error instanceof SearchStopped && error.reason === 'timeout') {
        return json(504, { error: 'timeout', message: `search took longer than ${config.timeoutMs} ms` })
      }
      if (error instanceof SearchStopped && error.reason === 'aborted') return json(499, { error: 'aborted', message: 'request aborted' })
      ctx.logger.warn(`session-find: search failed: ${error instanceof Error ? error.message : String(error)}`)
      return json(500, { error: 'failed', message: 'search failed' })
    }
  }

  // The browser never runs the user's query: the matched strings of the
  // window come from the bounded worker and are highlighted as literals.
  const context = async (request, signal) => {
    const read = await bodyOf(request)
    if (!read.ok) return read.response
    const parsed = parseContextRequest(read.body, config.maxContextMessages, config.maxQueryLength)
    if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message })
    const conversation = await readConversation(parsed.sessionId, signal)
    if (!conversation.ok) return conversation.response
    const window = contextWindow(conversation.documents, parsed.seq, parsed.before, parsed.after)
    if (window === null) return json(404, { error: 'no-message', message: `no conversation message at seq ${parsed.seq}` })
    let highlight = { strings: null, targetFirst: null, targetBefore: '', targetAfter: '', error: null }
    try {
      const found = await runSearch({
        kind: 'highlight',
        documents: window.messages,
        query: parsed.query,
        regex: parsed.regex,
        targetSeq: parsed.seq,
        limits: { maxStrings: config.maxHighlightStrings, maxChars: config.maxHighlightChars },
      }, config.timeoutMs, signal)
      highlight = { ...found, error: null }
    } catch (error) {
      if (error instanceof SearchStopped && error.reason === 'aborted') return json(499, { error: 'aborted', message: 'request aborted' })
      // The messages are still worth showing without highlights.
      highlight.error = error instanceof SearchStopped ? error.reason : 'failed'
      if (highlight.error !== 'timeout') ctx.logger.warn(`session-find: highlight failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const messages = boundMessages(window.messages, parsed.seq, highlight.targetFirst ?? parsed.focus, config.maxMessageChars)
    // Counted in the text the browser receives, not the full message.
    const shown = messages.find(message => message.seq === parsed.seq)
    const ordinal = highlight.strings !== null && highlight.targetFirst !== null && shown !== undefined
      ? targetOrdinal(shown.text, highlight.strings, highlight.targetFirst - shown.offset)
      : null
    return json(200, {
      sessionId: parsed.sessionId,
      seq: parsed.seq,
      messages,
      hasEarlier: window.hasEarlier,
      hasLater: window.hasLater,
      highlights: highlight.strings,
      targetOrdinal: ordinal,
      targetBefore: highlight.targetBefore,
      targetAfter: highlight.targetAfter,
      highlightError: highlight.error,
    })
  }

  // Requests in flight end with the plugin: each gets a signal that also
  // fires on unload, and unload waits for them (and their workers) to settle.
  const lifetime = new AbortController()
  const inflight = new Set()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...inflight])
  }, 'session-find: stop requests in flight')
  const owned = handler => async (request) => {
    if (lifetime.signal.aborted) return json(503, { error: 'unloading', message: 'session-find is unloading' })
    const work = handler(request, AbortSignal.any([request.signal, lifetime.signal]))
    inflight.add(work)
    try {
      return await work
    } finally {
      inflight.delete(work)
    }
  }

  for (const [path, handler] of [[SEARCH_PATH, search], [CONTEXT_PATH, context]]) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: owned(handler) }), `session-find: POST ${path}`)
  }
}
