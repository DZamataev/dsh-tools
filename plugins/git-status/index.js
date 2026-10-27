/**
 * Host half of git-status: two authenticated POST routes about the working
 * directory of one Session.
 *
 * `git-status.summary` returns the directory and, inside a repository, the
 * branch, upstream, change counts, a bounded `git status --short` list, the
 * repository root, and the last commit. `git-status.size` returns the
 * directory's disk usage from `du -sk`, cached per directory.
 *
 * The browser names only a Session; the directory comes from that Session's
 * `workingDirectory` projection (falling back to its header `cwd`), so a
 * request cannot point git or du at an arbitrary path. git runs read-only with
 * optional locks disabled, so polling never contends with an agent's git.
 */

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { isNotRepository, parseDuKilobytes, parseLastCommit, parseStatusV2 } from './git.js'

/** Cordis function-plugin name. */
export const name = 'git-status'
/** The route registry and the Session reader. */
export const inject = ['connection', 'sessionQuery']

/** Summary route; the browser addresses it document-relative as `api/git-status.summary`. */
export const SUMMARY_PATH = '/api/git-status.summary'
/** Size route; the browser addresses it document-relative as `api/git-status.size`. */
export const SIZE_PATH = '/api/git-status.size'

const DEFAULTS = {
  gitPath: 'git',
  duPath: 'du',
  gitTimeoutMs: 5_000,
  sizeTimeoutMs: 30_000,
  sizeCacheTtlMs: 120_000,
  maxStatusLines: 20,
  pollMs: 10_000,
}

const RANGES = {
  gitTimeoutMs: [100, 120_000],
  sizeTimeoutMs: [100, 600_000],
  sizeCacheTtlMs: [0, 86_400_000],
  maxStatusLines: [0, 1_000],
  pollMs: [1_000, 3_600_000],
}

function validate(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { issues: [{ message: 'git-status: config must be an object' }] }
  }
  const value = { ...DEFAULTS, ...(raw ?? {}) }
  const issues = []
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) {
      issues.push({ path: [key], message: `git-status: ${key} must be an integer from ${min} to ${max}` })
    }
  }
  for (const key of ['gitPath', 'duPath']) {
    if (typeof value[key] !== 'string' || value[key] === '') issues.push({ path: [key], message: `git-status: ${key} must be a non-empty string` })
  }
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULTS)) issues.push({ path: [key], message: `git-status: unknown option ${key}` })
  }
  return issues.length > 0 ? { issues } : { value }
}

/** Plugin configuration validated at activation (Standard Schema form). */
export const Config = { '~standard': { version: 1, vendor: 'git-status', validate } }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

/** First stderr line, bounded, for display. */
const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(line => line !== '')?.slice(0, 200) ?? ''

/**
 * Run one program without a shell; never rejects.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, failure: 'missing' | 'timeout' | 'aborted' | null }>}
 */
function run(file, args, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      signal,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr, failure: null })
        return
      }
      const failure = error.code === 'ENOENT' ? 'missing'
        : error.name === 'AbortError' ? 'aborted'
          : error.killed === true ? 'timeout'
            : null
      resolve({ code: typeof error.code === 'number' ? error.code : null, stdout: stdout ?? '', stderr: stderr ?? '', failure })
    })
  })
}

/**
 * Register the summary and size routes; requests in flight end with the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {typeof DEFAULTS} config - validated configuration.
 */
export function apply(ctx, config) {
  const home = homedir()
  const lifetime = new AbortController()
  const inflight = new Set()

  /** The Session's effective directory, or an error response. */
  const directoryOf = async (sessionId, signal) => {
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(sessionId, { signal })
      const cwd = observation.projections?.values?.workingDirectory ?? observation.header?.cwd ?? null
      if (typeof cwd !== 'string' || cwd === '') return { ok: false, response: json(404, { error: 'no-directory', message: 'the session records no working directory' }) }
      return { ok: true, cwd }
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { ok: false, response: json(404, { error: 'not-found', message: 'session not found' }) }
      if (error?.code === 'SESSION_QUERY_ABORTED' || signal.aborted) return { ok: false, response: json(499, { error: 'aborted', message: 'request aborted' }) }
      ctx.logger.warn(`git-status: cannot read session ${sessionId}: ${error?.code ?? error?.name ?? 'Error'}`)
      return { ok: false, response: json(500, { error: 'read-failed', message: 'could not read the session' }) }
    } finally {
      observation?.[Symbol.dispose]()
    }
  }

  const git = (cwd, args, signal) => run(config.gitPath, ['--no-optional-locks', '-C', cwd, ...args], { timeoutMs: config.gitTimeoutMs, signal })

  /** Repository facts for one directory; null outside a repository. */
  const repository = async (cwd, signal) => {
    const [status, root, commit] = await Promise.all([
      git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], signal),
      git(cwd, ['rev-parse', '--show-toplevel'], signal),
      git(cwd, ['log', '-1', '--format=%h%x1f%s%x1f%ct%x1f%an%x1f%ae'], signal),
    ])
    if (status.failure === 'missing') return { error: 'git-missing' }
    if (status.failure === 'timeout') return { error: 'timeout' }
    if (status.failure === 'aborted') return { error: 'aborted' }
    if (status.code !== 0) {
      if (isNotRepository(status.stderr)) return null
      return { error: 'failed', message: firstLine(status.stderr) }
    }
    return {
      error: null,
      ...parseStatusV2(status.stdout, config.maxStatusLines),
      root: root.code === 0 ? root.stdout.trim() : null,
      // An empty repository has no commit; `git log` then fails.
      lastCommit: commit.code === 0 ? parseLastCommit(commit.stdout) : null,
    }
  }

  const summary = async (body, signal) => {
    const directory = await directoryOf(body.sessionId, signal)
    if (!directory.ok) return directory.response
    const { cwd } = directory
    const base = { sessionId: body.sessionId, cwd, name: basename(cwd) || cwd, home, pollMs: config.pollMs, fetchedAt: Date.now() }
    let info
    try {
      info = await stat(cwd)
    } catch {
      return json(200, { ...base, exists: false, git: null })
    }
    if (!info.isDirectory()) return json(200, { ...base, exists: false, git: null })
    const repo = await repository(cwd, signal)
    if (repo?.error === 'aborted') return json(499, { error: 'aborted', message: 'request aborted' })
    return json(200, { ...base, exists: true, git: repo })
  }

  /** Per-directory size cache sharing one in-flight `du` among callers. */
  const sizes = new Map()
  const measure = (cwd, force) => {
    const now = Date.now()
    const entry = sizes.get(cwd)
    if (entry?.inflight !== undefined) return entry.inflight
    if (!force && entry?.value !== undefined && now < entry.expiresAt) return Promise.resolve(entry.value)
    const inflight = run(config.duPath, ['-sk', cwd], { timeoutMs: config.sizeTimeoutMs, signal: lifetime.signal }).then((result) => {
      const bytes = parseDuKilobytes(result.stdout)
      const value = result.failure === 'timeout' ? { bytes: null, partial: false, error: 'timeout', measuredAt: Date.now() }
        : result.failure === 'missing' ? { bytes: null, partial: false, error: 'du-missing', measuredAt: Date.now() }
          : bytes === null ? { bytes: null, partial: false, error: 'failed', message: firstLine(result.stderr), measuredAt: Date.now() }
            // du exits 1 after unreadable subdirectories but still prints a total.
            : { bytes, partial: result.code !== 0, error: null, measuredAt: Date.now() }
      sizes.set(cwd, { value, expiresAt: value.error === null ? Date.now() + config.sizeCacheTtlMs : 0 })
      return value
    })
    sizes.set(cwd, { ...entry, inflight })
    return inflight
  }

  const size = async (body, signal) => {
    const directory = await directoryOf(body.sessionId, signal)
    if (!directory.ok) return directory.response
    // du keeps running when this request is cancelled, so a reopened panel finds its result cached.
    const value = await measure(directory.cwd, body.refresh === true)
    if (signal.aborted) return json(499, { error: 'aborted', message: 'request aborted' })
    return json(200, { sessionId: body.sessionId, cwd: directory.cwd, ...value })
  }

  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...inflight])
  }, 'git-status: stop requests in flight')

  const owned = handler => async (request) => {
    if (lifetime.signal.aborted) return json(503, { error: 'unloading', message: 'git-status is unloading' })
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { error: 'bad-request', message: 'body is not JSON' })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad-request', message: 'body must be a JSON object' })
    if (typeof body.sessionId !== 'string' || body.sessionId === '' || body.sessionId.length > 512) {
      return json(400, { error: 'bad-request', message: 'sessionId must be a non-empty string' })
    }
    const work = handler(body, AbortSignal.any([request.signal, lifetime.signal]))
    inflight.add(work)
    try {
      return await work
    } finally {
      inflight.delete(work)
    }
  }

  for (const [path, handler] of [[SUMMARY_PATH, summary], [SIZE_PATH, size]]) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: owned(handler) }), `git-status: POST ${path}`)
  }
}
