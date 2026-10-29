/**
 * Host half of session-artifacts: one authenticated POST route listing the
 * documents the open Session produced or touched, across its whole log.
 *
 * The request reads that one log through `sessionQuery.observeSession` (the
 * live Session when attached, otherwise the stored log); nothing is indexed
 * and no other Session is read. Extraction is the pure `collectArtifacts`, and
 * this module adds the filesystem state: a bounded `stat` per entry decides
 * `exists`/`size`/`mtime` and drops a path that only an assistant mention
 * named and that is not on disk.
 *
 * The listing uses the Host filesystem rather than `ctx.fs`: the log names Host
 * absolute paths, while `ctx.fs` exposes an opaque target key whose metadata is
 * `{version, type, size}` — no mtime — resolved through the backend's sandbox
 * and execution world, so it cannot describe these paths. The request signal is
 * honored between stat batches instead.
 */

import { realpath, stat } from 'node:fs/promises'
import { DEFAULT_EXCLUDE_SEGMENTS, DEFAULT_EXTENSIONS, DEFAULT_PATCH_TOOLS, collectArtifacts, extensionKinds, pathFields, relativeTo } from './artifacts.js'

/** Cordis function-plugin name. */
export const name = 'session-artifacts'
/** The route registry and the Session log reader. */
export const inject = ['connection', 'sessionQuery']

/** Listing route; the browser addresses it document-relative as `api/session-artifacts.list`. */
export const LIST_PATH = '/api/session-artifacts.list'

/** Kind names the config may extend; they are the response's `kind` values. */
const KINDS = Object.keys(DEFAULT_EXTENSIONS)

/** Concurrency of the per-entry `stat` calls: each one holds a descriptor and a thread-pool slot. */
const STAT_CONCURRENCY = 4

/** Sessions whose extraction is reused while their log stays at the same cursor. */
const EXTRACTION_CACHE_SIZE = 8

const DEFAULTS = {
  extensions: DEFAULT_EXTENSIONS,
  includeMentions: true,
  maxArtifacts: 500,
  maxPlanChars: 200_000,
  maxMentionScanChars: 2_000_000,
  maxMentionCandidates: 300,
  patchTools: DEFAULT_PATCH_TOOLS,
  excludeSegments: DEFAULT_EXCLUDE_SEGMENTS,
}

const RANGES = {
  maxArtifacts: [1, 10_000],
  maxPlanChars: [1, 10_000_000],
  maxMentionScanChars: [1_000, 100_000_000],
  maxMentionCandidates: [1, 10_000],
}

const EXTENSION = /^[a-z0-9]+$/

/** Stat failures that only mean the listed path is not a document now. */
const SILENT_STAT_CODES = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ERR_INVALID_ARG_VALUE', 'EACCES'])

/** The filesystem state of a path that cannot be opened as a document now. */
const MISSING = Object.freeze({ exists: false, size: null, mtime: null })

/**
 * Validate the plugin configuration. `extensions` overrides the kinds it names
 * and keeps the defaults for the rest; an unknown kind, an extension claimed by
 * two kinds, a malformed extension, an unknown key, or an out-of-range number
 * fails with issues instead of being ignored.
 * @param {unknown} raw - the Loader-provided config.
 * @returns {{ issues: { path?: (string | number)[], message: string }[] } | { value: typeof DEFAULTS }} validated config or the issues that prevent activation.
 */
function validate(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { issues: [{ message: 'session-artifacts: config must be an object' }] }
  }
  const input = raw ?? {}
  const issues = []
  const pick = key => (key in input ? input[key] : DEFAULTS[key])
  const value = {
    extensions: extensionConfig(input.extensions, issues),
    includeMentions: pick('includeMentions'),
    maxArtifacts: pick('maxArtifacts'),
    maxPlanChars: pick('maxPlanChars'),
    maxMentionScanChars: pick('maxMentionScanChars'),
    maxMentionCandidates: pick('maxMentionCandidates'),
    patchTools: toolNames(input, issues),
    excludeSegments: segments(input, issues),
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
      issues.push({ path: [key], message: `session-artifacts: ${key} must be an integer from ${min} to ${max}` })
    }
  }
  if (typeof value.includeMentions !== 'boolean') {
    issues.push({ path: ['includeMentions'], message: 'session-artifacts: includeMentions must be a boolean' })
  }
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS)) issues.push({ path: [key], message: `session-artifacts: unknown option ${key}` })
  }
  return issues.length > 0 ? { issues } : { value }
}

/** The `extensions` config, defaulted per kind and checked for unknown kinds and duplicates. */
function extensionConfig(raw, issues) {
  const extensions = cloneExtensions(DEFAULTS.extensions)
  if (raw === undefined) return extensions
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: ['extensions'], message: 'session-artifacts: extensions must be a kind → extensions object' })
    return extensions
  }
  for (const [kind, list] of Object.entries(raw)) {
    if (!KINDS.includes(kind)) {
      issues.push({ path: ['extensions', kind], message: `session-artifacts: unknown document kind ${kind}` })
      continue
    }
    if (!Array.isArray(list) || list.some(entry => typeof entry !== 'string' || !EXTENSION.test(entry.toLowerCase()))) {
      issues.push({
        path: ['extensions', kind],
        message: `session-artifacts: ${kind} extensions must be strings of letters and digits, without a dot`,
      })
      continue
    }
    extensions[kind] = list.map(entry => entry.toLowerCase())
  }
  const claimed = new Map()
  for (const [kind, list] of Object.entries(extensions)) {
    for (const extension of list) {
      const owner = claimed.get(extension)
      if (owner !== undefined && owner !== kind) {
        issues.push({
          path: ['extensions', kind],
          message: `session-artifacts: extension ${extension} is claimed by both ${owner} and ${kind}`,
        })
      } else {
        claimed.set(extension, kind)
      }
    }
  }
  return extensions
}

/** The `patchTools` config: tool names whose arguments may carry an apply_patch programme. */
function toolNames(input, issues) {
  if (!('patchTools' in input)) return [...DEFAULTS.patchTools]
  const raw = input.patchTools
  if (!Array.isArray(raw) || raw.some(name => typeof name !== 'string' || name === '' || /\s/.test(name))) {
    issues.push({ path: ['patchTools'], message: 'session-artifacts: patchTools must be an array of tool names without whitespace' })
    return [...DEFAULTS.patchTools]
  }
  return [...raw]
}

/** The `excludeSegments` config: path segment names no listing covers. */
function segments(input, issues) {
  if (!('excludeSegments' in input)) return [...DEFAULTS.excludeSegments]
  const raw = input.excludeSegments
  if (!Array.isArray(raw) || raw.some(segment => typeof segment !== 'string' || segment === '' || /[\\/]/.test(segment))) {
    issues.push({ path: ['excludeSegments'], message: 'session-artifacts: excludeSegments must be an array of path segment names without slashes' })
    return [...DEFAULTS.excludeSegments]
  }
  return [...raw]
}

/** A detached copy of a kind → extensions map. */
function cloneExtensions(extensions) {
  return Object.fromEntries(Object.entries(extensions).map(([kind, list]) => [kind, [...list]]))
}

/** Plugin configuration validated at activation (Standard Schema form). */
export const Config = { '~standard': { version: 1, vendor: 'session-artifacts', validate } }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

const rejection = (error, message) => ({ ok: false, error, message })

/**
 * Validate one listing request body.
 * @param {unknown} body - parsed JSON body.
 * @returns {{ ok: true, sessionId: string } | { ok: false, error: string, message: string }} request or rejection.
 */
export function parseRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return rejection('bad-request', 'body must be a JSON object')
  const { sessionId } = body
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 512) {
    return rejection('bad-request', 'sessionId must be a non-empty string')
  }
  return { ok: true, sessionId }
}

/** Whether an entry came only from assistant text, so its absence on disk leaves nothing worth listing. */
const isMentionOnly = artifact => artifact.sources.length === 1 && artifact.sources[0] === 'mention'

/**
 * The canonical spelling of a path, or the path itself when it cannot be
 * resolved after a successful stat (a raced unlink, a symlink loop, or a
 * permission change).
 * @param {string} file - absolute path.
 * @returns {Promise<string>} the canonical path.
 */
async function canonicalOf(file) {
  try {
    return await realpath(file)
  } catch {
    // ENOENT, ELOOP, or EACCES: the spelled path stays the identity of the entry.
    return file
  }
}

/** Distinct values in first-seen order. */
function uniqueInOrder(values) {
  return [...new Set(values)]
}

/**
 * Fold entries that name one file through different spellings: sources merge in
 * first-seen order, bounds widen, and the newest spelling decides the current
 * state, description, and size.
 * @param {object[]} group - entries of one canonical file, at least two.
 * @returns {object} the merged entry.
 */
function mergeEntries(group) {
  const byFirst = [...group].sort((left, right) => left.firstSeq - right.firstSeq)
  const byLast = [...group].sort((left, right) => right.lastSeq - left.lastSeq)
  const described = byLast.find(entry => entry.description !== null)
  const existing = byLast.find(entry => entry.exists)
  return {
    ...byLast[0],
    sources: uniqueInOrder(byFirst.flatMap(entry => entry.sources)),
    created: byFirst[0].created,
    deleted: byLast[0].deleted,
    description: described === undefined ? null : described.description,
    ops: group.reduce((sum, entry) => sum + entry.ops, 0),
    firstSeq: byFirst[0].firstSeq,
    firstTime: byFirst[0].firstTime,
    lastSeq: byLast[0].lastSeq,
    lastTime: byLast[0].lastTime,
    turns: [...new Set(byFirst.flatMap(entry => entry.turns))].sort((left, right) => left - right),
    exists: existing !== undefined,
    size: existing === undefined ? null : existing.size,
    mtime: existing === undefined ? null : existing.mtime,
  }
}

/**
 * Register the listing route; it is removed with the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {typeof DEFAULTS} config - validated configuration.
 */
export function apply(ctx, config) {
  const kinds = extensionKinds(config.extensions)
  /** Extraction by Session id, keyed by the observation cut that produced it. */
  const cache = new Map()
  // Unload must win over the cancellation it causes: a request interrupted by
  // the plugin lifetime is "unloading", not a client abort.
  const lifetime = new AbortController()
  const unloading = () => json(503, { error: 'unloading', message: 'session-artifacts is unloading' })

  const bodyOf = async (request) => {
    try {
      return { ok: true, body: await request.json() }
    } catch {
      return { ok: false, response: json(400, { error: 'bad-request', message: 'body is not JSON' }) }
    }
  }

  /** The displayed fields of one row under a chosen spelling, without the internal canonical key. */
  const describeAs = (entry, path, cwd) => {
    const fields = { ...entry }
    delete fields.canonical
    if (fields.path === path) return fields
    return { ...fields, path, relPath: relativeTo(cwd, path), ...pathFields(path, kinds) }
  }

  /**
   * Collapse groups of one canonical file into response rows. The canonical path
   * was only the grouping key: the row keeps a logged spelling — the newest one
   * inside the Session directory when there is one — so `path`, its preview
   * address, and `relPath` stay what the agent used. A group of one is never
   * rewritten.
   */
  const canonicalize = (groups, cwd) => {
    const merged = []
    for (const group of groups.values()) {
      if (group.length === 1) {
        merged.push(describeAs(group[0], group[0].path, cwd))
        continue
      }
      const newestFirst = [...group].sort((left, right) => right.lastSeq - left.lastSeq)
      const spelling = newestFirst.find(entry => entry.relPath !== null) ?? newestFirst[0]
      merged.push(describeAs(mergeEntries(group), spelling.path, cwd))
    }
    return merged.sort((left, right) => right.lastSeq - left.lastSeq)
  }

  /** The observation cut an extraction describes: a changed source, revision, or cursor invalidates it. */
  const cacheKeyOf = observation => `${observation.source ?? ''}|${observation.revision ?? ''}|${observation.cursor ?? ''}`

  /** The Session's extraction, or the error response for a failed read. */
  const readArtifacts = async (sessionId, signal) => {
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    } catch (error) {
      if (lifetime.signal.aborted) return { ok: false, response: unloading() }
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { ok: false, response: json(404, { error: 'not-found', message: 'session not found' }) }
      if (error?.code === 'SESSION_QUERY_ABORTED') return { ok: false, response: json(499, { error: 'aborted', message: 'request aborted' }) }
      ctx.logger.warn(`session-artifacts: cannot read session ${sessionId}: ${error?.code ?? error?.name ?? 'Error'}`)
      return { ok: false, response: json(500, { error: 'read-failed', message: 'could not read the session log' }) }
    }
    try {
      const key = cacheKeyOf(observation)
      const cached = cache.get(sessionId)
      if (cached !== undefined && cached.key === key) {
        cache.delete(sessionId)
        cache.set(sessionId, cached)
        return { ok: true, ...cached.extracted }
      }
      const collected = collectArtifacts(observation.events, { cwd: observation.header?.cwd ?? null, config })
      cache.delete(sessionId)
      cache.set(sessionId, { key, extracted: collected })
      if (cache.size > EXTRACTION_CACHE_SIZE) cache.delete(cache.keys().next().value)
      return { ok: true, ...collected }
    } catch (error) {
      ctx.logger.warn(`session-artifacts: cannot extract session ${sessionId}: ${error?.code ?? error?.name ?? 'Error'}`)
      return { ok: false, response: json(500, { error: 'read-failed', message: 'could not read the session log' }) }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  /** Current filesystem state of one listed path; every failure means "not openable now". */
  const statOf = async (file, failures, signal) => {
    if (signal.aborted) return MISSING
    try {
      const info = await stat(file)
      if (!info.isFile()) return MISSING
      return { exists: true, size: info.size, mtime: info.mtimeMs, canonical: await canonicalOf(file) }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'Error'
      if (!SILENT_STAT_CODES.has(code)) failures.set(code, (failures.get(code) ?? 0) + 1)
      return MISSING
    }
  }

  /**
   * Stat entries in `lastSeq`-descending order, drop mention-only entries that
   * are not on disk, and merge aliases as they arrive, so the stop counts
   * distinct canonical files rather than rows: `maxArtifacts` slots are never
   * spent on a second spelling of a file already listed. Logs unexpected stat
   * codes and their counts only, never paths.
   */
  const visible = async (artifacts, signal) => {
    const limit = config.maxArtifacts + 1
    const failures = new Map()
    const groups = new Map()
    for (let start = 0; start < artifacts.length && groups.size < limit; start += STAT_CONCURRENCY) {
      if (signal.aborted) break
      const chunk = artifacts.slice(start, start + STAT_CONCURRENCY)
      const states = await Promise.all(chunk.map(artifact => statOf(artifact.path, failures, signal)))
      for (const [index, artifact] of chunk.entries()) {
        const state = states[index]
        if (!state.exists && isMentionOnly(artifact)) continue
        const entry = { ...artifact, ...state }
        const identity = entry.canonical ?? entry.path
        const group = groups.get(identity)
        if (group === undefined) groups.set(identity, [entry])
        else group.push(entry)
      }
    }
    if (failures.size > 0) {
      const detail = [...failures].map(([code, count]) => `${code}=${count}`).join(' ')
      const total = [...failures.values()].reduce((sum, count) => sum + count, 0)
      ctx.logger.warn(`session-artifacts: ${total} paths could not be checked (${detail})`)
    }
    return { groups, truncated: groups.size > config.maxArtifacts }
  }

  const list = async (request, signal) => {
    const read = await bodyOf(request)
    if (!read.ok) return read.response
    const parsed = parseRequest(read.body)
    if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message })
    const extracted = await readArtifacts(parsed.sessionId, signal)
    if (!extracted.ok) return extracted.response
    const { groups, truncated } = await visible(extracted.artifacts, signal)
    if (lifetime.signal.aborted) return unloading()
    if (signal.aborted) return json(499, { error: 'aborted', message: 'request aborted' })
    return json(200, {
      ok: true,
      cwd: extracted.cwd,
      artifacts: canonicalize(groups, extracted.cwd).slice(0, config.maxArtifacts),
      plans: extracted.plans,
      truncated,
    })
  }

  // Requests in flight end with the plugin: each gets a signal that also
  // fires on unload, and unload waits for them to settle.
  const inflight = new Set()
  ctx.effect(() => async () => {
    cache.clear()
    lifetime.abort()
    await Promise.allSettled([...inflight])
  }, 'session-artifacts: stop requests in flight')
  const owned = handler => async (request) => {
    if (lifetime.signal.aborted) return unloading()
    const work = handler(request, AbortSignal.any([request.signal, lifetime.signal]))
    inflight.add(work)
    try {
      return await work
    } finally {
      inflight.delete(work)
    }
  }

  ctx.effect(
    () => ctx.connection.fetch.register({ path: LIST_PATH, methods: ['POST'], requestBody: 'buffered', fetch: owned(list) }),
    `session-artifacts: POST ${LIST_PATH}`,
  )
}
