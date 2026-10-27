/**
 * Host half of git-status: authenticated POST routes about the working
 * directory of one Session.
 *
 * `git-status.summary` returns the directory and, inside a repository, the
 * branch, upstream, change counts, a bounded `git status --short` list, the
 * repository root, and the last commit. `git-status.size` returns the
 * directory's disk usage from `du -sk`, cached per directory.
 * `git-status.review` opens the changes against HEAD in one Zed multi-diff
 * window. `git-status.pull` fetches and fast-forwards the current branch to its
 * upstream, and refuses every other outcome.
 *
 * The browser names only a Session; the directory comes from that Session's
 * `workingDirectory` projection (falling back to its header `cwd`), so a
 * request cannot point git, du, or Zed at an arbitrary path. Status reads run
 * with optional locks disabled, so polling never contends with an agent's git.
 */

import { execFile } from 'node:child_process'
import { access, constants, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isNotRepository, overwrittenFiles, parseDuKilobytes, parseLastCommit, parseLeftRight, parseStatusV2, reviewSides } from './git.js'

/** Cordis function-plugin name. */
export const name = 'git-status'
/** The route registry and the Session reader. */
export const inject = ['connection', 'sessionQuery']

/** Summary route; the browser addresses it document-relative as `api/git-status.summary`. */
export const SUMMARY_PATH = '/api/git-status.summary'
/** Size route; the browser addresses it document-relative as `api/git-status.size`. */
export const SIZE_PATH = '/api/git-status.size'
/** Review route; the browser addresses it document-relative as `api/git-status.review`. */
export const REVIEW_PATH = '/api/git-status.review'
/** Pull route; the browser addresses it document-relative as `api/git-status.pull`. */
export const PULL_PATH = '/api/git-status.pull'

/** Zed CLI locations tried when `zedPath` is empty; a Finder-launched Desktop has no /usr/local/bin on PATH. */
export const ZED_CANDIDATES = ['/usr/local/bin/zed', '/opt/homebrew/bin/zed', '/Applications/Zed.app/Contents/MacOS/cli']
/** Parent of the per-review HEAD snapshots; older than a day they are removed on the next review. */
export const REVIEW_ROOT = join(tmpdir(), 'dsh-git-review')
const REVIEW_KEEP_MS = 86_400_000

const DEFAULTS = {
  gitPath: 'git',
  duPath: 'du',
  gitTimeoutMs: 5_000,
  sizeTimeoutMs: 30_000,
  sizeCacheTtlMs: 120_000,
  maxStatusLines: 20,
  pollMs: 10_000,
  zedPath: '',
  zedTimeoutMs: 20_000,
  maxReviewFiles: 300,
  pullTimeoutMs: 60_000,
}

const RANGES = {
  gitTimeoutMs: [100, 120_000],
  sizeTimeoutMs: [100, 600_000],
  sizeCacheTtlMs: [0, 86_400_000],
  maxStatusLines: [0, 1_000],
  pollMs: [1_000, 3_600_000],
  zedTimeoutMs: [1_000, 120_000],
  maxReviewFiles: [1, 10_000],
  pullTimeoutMs: [1_000, 600_000],
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
  if (typeof value.zedPath !== 'string') issues.push({ path: ['zedPath'], message: 'git-status: zedPath must be a string (empty: look in the usual locations)' })
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
function run(file, args, { timeoutMs, signal, env = {}, encoding = 'utf8' }) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      signal,
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr, failure: null })
        return
      }
      const failure = error.code === 'ENOENT' ? 'missing'
        : error.name === 'AbortError' ? 'aborted'
          : error.killed === true ? 'timeout'
            : null
      resolve({ code: typeof error.code === 'number' ? error.code : null, stdout: stdout ?? '', stderr: String(stderr ?? ''), failure })
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

  /** Repository root of a directory, or an error response. */
  const rootOf = async (cwd, signal) => {
    const result = await git(cwd, ['rev-parse', '--show-toplevel'], signal)
    if (result.failure === 'missing') return { ok: false, response: json(503, { error: 'git-missing', message: 'git is not installed' }) }
    if (result.code !== 0) {
      if (isNotRepository(result.stderr)) return { ok: false, response: json(409, { error: 'not-repository', message: 'not a git repository' }) }
      return { ok: false, response: json(500, { error: 'failed', message: firstLine(result.stderr) }) }
    }
    return { ok: true, root: result.stdout.trim() }
  }

  const findZed = async () => {
    for (const candidate of config.zedPath !== '' ? [config.zedPath] : ZED_CANDIDATES) {
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here; try the next location.
      }
    }
    return null
  }

  /** Remove review snapshots older than a day; failures only leave temporary files behind. */
  const pruneReviews = async () => {
    let entries = []
    try {
      entries = await readdir(REVIEW_ROOT, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = Date.now() - REVIEW_KEEP_MS
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
      const path = join(REVIEW_ROOT, entry.name)
      try {
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
      } catch {
        // A snapshot that cannot be inspected or removed stays until reboot.
      }
    }))
  }

  /**
   * Open HEAD against the working tree in one Zed multi-diff window. The right
   * side of every pair is the real working file, so edits there save into the
   * repository; the left side is a HEAD snapshot under REVIEW_ROOT. One pair of
   * empty directories puts Zed in its single-window multi-diff mode.
   */
  const review = async (body, signal) => {
    const directory = await directoryOf(body.sessionId, signal)
    if (!directory.ok) return directory.response
    const found = await rootOf(directory.cwd, signal)
    if (!found.ok) return found.response
    const { root } = found
    const status = await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], signal)
    if (status.code !== 0) return json(500, { error: 'failed', message: firstLine(status.stderr) })
    const parsed = parseStatusV2(status.stdout, config.maxReviewFiles)
    if (parsed.total === 0) return json(200, { opened: false, reason: 'clean', files: 0, total: 0 })
    const zed = await findZed()
    if (zed === null) return json(503, { error: 'zed-missing', message: 'Zed CLI not found; set zedPath' })

    await pruneReviews()
    const base = join(REVIEW_ROOT, `${basename(root) || 'repo'}-${Date.now()}`)
    const snapshot = join(base, 'HEAD')
    const stubs = join(base, 'deleted')
    const emptyLeft = join(base, 'empty-old')
    const emptyRight = join(base, 'empty-new')
    await Promise.all([mkdir(snapshot, { recursive: true }), mkdir(stubs, { recursive: true }), mkdir(emptyLeft, { recursive: true }), mkdir(emptyRight, { recursive: true })])

    const pairs = []
    for (const line of parsed.lines) {
      const { oldPath, newPath } = reviewSides(line)
      const real = join(root, newPath)
      let info
      try {
        info = await lstat(real)
      } catch {
        info = null
      }
      // Submodules and other directories have no file content to compare.
      if (info !== null && info.isDirectory()) continue
      const left = join(snapshot, newPath)
      await mkdir(dirname(left), { recursive: true })
      let content = Buffer.alloc(0)
      if (oldPath !== null) {
        const blob = await run(config.gitPath, ['-C', root, 'show', `HEAD:${oldPath}`], { timeoutMs: config.gitTimeoutMs, signal, encoding: 'buffer' })
        if (blob.code === 0) content = blob.stdout
      }
      await writeFile(left, content)
      let right = real
      if (info === null) {
        right = join(stubs, newPath)
        await mkdir(dirname(right), { recursive: true })
        await writeFile(right, '')
      }
      pairs.push([left, right])
    }
    if (pairs.length === 0) return json(200, { opened: false, reason: 'clean', files: 0, total: parsed.total })
    const args = ['--diff', emptyLeft, emptyRight, ...pairs.flatMap(([left, right]) => ['--diff', left, right])]
    const opened = await run(zed, args, { timeoutMs: config.zedTimeoutMs, signal: lifetime.signal })
    if (opened.failure === 'missing') return json(503, { error: 'zed-missing', message: 'Zed CLI not found; set zedPath' })
    if (opened.failure === 'timeout') return json(504, { error: 'timeout', message: 'Zed did not answer in time' })
    if (opened.code !== 0) return json(500, { error: 'zed-failed', message: firstLine(opened.stderr) || `exit ${opened.code}` })
    return json(200, { opened: true, files: pairs.length, total: parsed.total, truncated: parsed.truncated })
  }

  /** One pull per repository at a time. */
  const pulling = new Set()

  /**
   * Fetch, then fast-forward the current branch to its upstream. A detached
   * HEAD, a missing upstream, a diverged branch, and local changes the merge
   * would overwrite are refused; nothing else is attempted.
   */
  const pull = async (body, signal) => {
    const directory = await directoryOf(body.sessionId, signal)
    if (!directory.ok) return directory.response
    const found = await rootOf(directory.cwd, signal)
    if (!found.ok) return found.response
    const { root } = found
    if (pulling.has(root)) return json(409, { error: 'busy', message: 'a pull is already running in this repository' })
    pulling.add(root)
    try {
      // A started pull ends on its own: closing the panel must not cut a merge short.
      const own = lifetime.signal
      const quick = args => run(config.gitPath, ['-C', root, ...args], { timeoutMs: config.gitTimeoutMs, signal: own })
      const branch = await quick(['symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (branch.code !== 0) return json(409, { error: 'detached', message: 'HEAD is detached' })
      const upstream = await quick(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
      if (upstream.code !== 0) return json(409, { error: 'no-upstream', message: 'the branch has no upstream' })
      const before = (await quick(['rev-parse', 'HEAD'])).stdout.trim()
      // BatchMode keeps ssh from waiting for a passphrase nobody can type.
      const sshEnv = process.env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}
      const fetched = await run(config.gitPath, ['-C', root, 'fetch', '--quiet'], { timeoutMs: config.pullTimeoutMs, signal: own, env: sshEnv })
      if (fetched.failure === 'timeout') return json(504, { error: 'timeout', message: 'git fetch took too long' })
      if (fetched.code !== 0) return json(502, { error: 'fetch-failed', message: firstLine(fetched.stderr) })
      const counts = parseLeftRight((await quick(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout)
      const upstreamName = upstream.stdout.trim()
      if (counts === null) return json(500, { error: 'failed', message: 'could not compare with the upstream' })
      if (counts.behind === 0) return json(200, { result: 'up-to-date', ahead: counts.ahead, upstream: upstreamName })
      if (counts.ahead > 0) return json(409, { error: 'diverged', ahead: counts.ahead, behind: counts.behind, upstream: upstreamName, message: 'the branch has diverged from its upstream' })
      const merged = await run(config.gitPath, ['-C', root, 'merge', '--ff-only', '--quiet', '@{upstream}'], { timeoutMs: config.pullTimeoutMs, signal: own })
      if (merged.failure === 'timeout') return json(504, { error: 'timeout', message: 'git merge took too long' })
      if (merged.code !== 0) {
        const files = overwrittenFiles(merged.stderr)
        if (files.length > 0) return json(409, { error: 'local-changes', files, message: 'local changes would be overwritten' })
        return json(500, { error: 'failed', message: firstLine(merged.stderr) })
      }
      const after = (await quick(['rev-parse', 'HEAD'])).stdout.trim()
      return json(200, { result: 'fast-forwarded', commits: counts.behind, from: before.slice(0, 7), to: after.slice(0, 7), upstream: upstreamName })
    } finally {
      pulling.delete(root)
    }
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

  for (const [path, handler] of [[SUMMARY_PATH, summary], [SIZE_PATH, size], [REVIEW_PATH, review], [PULL_PATH, pull]]) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: owned(handler) }), `git-status: POST ${path}`)
  }
}
