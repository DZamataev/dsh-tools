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
 * upstream, and refuses every other outcome. `git-status.push` pushes the
 * current branch to its upstream (or, without one, to the only remote, setting
 * the upstream) without force, and refuses a branch that is behind.
 *
 * The browser names only a Session; the directory comes from that Session's
 * `workingDirectory` projection (falling back to its header `cwd`), so a
 * request cannot point git, du, or Zed at an arbitrary path. Status reads run
 * with optional locks disabled, so polling never contends with an agent's git.
 */

import { execFile } from 'node:child_process'
import { access, chmod, constants, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isNotRepository, overwrittenFiles, parseDuKilobytes, parseLastCommit, parseLeftRight, parsePushRejection, parseStatusV2, reviewSides } from './git.js'

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
/** Push route; the browser addresses it document-relative as `api/git-status.push`. */
export const PUSH_PATH = '/api/git-status.push'

/** Zed CLI locations tried when `zedPath` is empty; a Finder-launched Desktop has no /usr/local/bin on PATH. */
export const ZED_CANDIDATES = ['/usr/local/bin/zed', '/opt/homebrew/bin/zed', '/Applications/Zed.app/Contents/MacOS/cli']
/** Parent of the per-review HEAD snapshots; older than a day they are removed on the next review. */
export const REVIEW_ROOT = join(tmpdir(), 'dsh-git-review')
const REVIEW_KEEP_MS = 86_400_000
/** File inside every snapshot directory this plugin made; pruning removes only marked directories. */
export const REVIEW_MARKER = '.dsh-git-review'

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
  pushTimeoutMs: 120_000,
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
  pushTimeoutMs: [1_000, 1_800_000],
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

/** One value git printed on a line of its own: only the newline goes, a path may end in spaces. */
const line = text => String(text ?? '').replace(/\r?\n$/, '')

/** First stderr line, bounded, for display. */
const firstLine = text => String(text ?? '').split('\n').map(entry => entry.trim()).find(entry => entry !== '')?.slice(0, 200) ?? ''

/** How long a stopped process group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3_000

/** Signal a child's whole process group (hooks git starts included); a group already gone is fine. */
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* The child has already exited. */ }
  }
}

/**
 * A runner that starts each program without a shell in its own process group
 * and records it in `children` until the process closes. A timeout or abort
 * sends SIGTERM to the group and SIGKILL after KILL_GRACE_MS; the result is
 * reported once the process has closed. Never rejects.
 * @param {Set<{ closed: Promise<void> }>} children - live processes, for unload to await.
 */
function createRunner(children) {
  /**
   * @returns {Promise<{ code: number | null, stdout: string | Buffer, stderr: string, failure: 'missing' | 'timeout' | 'aborted' | null }>}
   */
  return function run(file, args, { timeoutMs, signal, env = {}, encoding = 'utf8' }) {
    return new Promise((resolve) => {
      let stopped = null
      let timer
      let grace
      const onAbort = () => { stop('aborted') }
      const settle = (result) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      let child
      try {
        child = execFile(file, args, {
          encoding,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          detached: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
        }, (error, stdout, stderr) => {
          const missing = error?.code === 'ENOENT'
          settle({
            code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
            stdout: stdout ?? '',
            stderr: String(stderr ?? ''),
            failure: missing ? 'missing' : stopped,
          })
        })
      } catch (error) {
        settle({ code: null, stdout: '', stderr: String(error), failure: error?.code === 'ENOENT' ? 'missing' : null })
        return
      }
      const entry = { closed: new Promise((done) => { child.once('close', done); child.once('error', done) }) }
      children.add(entry)
      void entry.closed.then(() => {
        clearTimeout(grace)
        children.delete(entry)
      })
      function stop(reason) {
        if (stopped !== null || child.exitCode !== null || child.signalCode !== null) return
        stopped = reason
        killGroup(child, 'SIGTERM')
        grace = setTimeout(() => { killGroup(child, 'SIGKILL') }, KILL_GRACE_MS)
        grace.unref?.()
      }
      timer = setTimeout(() => { stop('timeout') }, timeoutMs)
      timer.unref?.()
      if (signal?.aborted) stop('aborted')
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
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
  const children = new Set()
  const run = createRunner(children)

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
      root: root.code === 0 ? line(root.stdout) : null,
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
    return { ok: true, root: line(result.stdout) }
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

  /**
   * The snapshot root, created 0700 when missing. It must be a real directory (not a symlink)
   * owned by this user: anything else could redirect snapshots and pruning outside it.
   * @returns {Promise<boolean>} whether the root is safe to use.
   */
  const secureReviewRoot = async () => {
    try {
      await mkdir(REVIEW_ROOT, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
    }
    let info
    try {
      info = await lstat(REVIEW_ROOT)
    } catch {
      return false
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) return false
    // An earlier version created the root with the default mode; it is ours, so narrow it.
    if ((info.mode & 0o077) !== 0) {
      try {
        await chmod(REVIEW_ROOT, 0o700)
      } catch {
        return false
      }
    }
    return true
  }

  /** Remove this plugin's snapshots older than a day; failures only leave temporary files behind. */
  const pruneReviews = async () => {
    let entries = []
    try {
      entries = await readdir(REVIEW_ROOT, { withFileTypes: true })
    } catch {
      return
    }
    const cutoff = Date.now() - REVIEW_KEEP_MS
    // Dirent types come from lstat, so a symlink is never a directory here; rm does not follow
    // symlinks inside the directories it removes.
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async (entry) => {
      const path = join(REVIEW_ROOT, entry.name)
      try {
        const [info, marker] = await Promise.all([lstat(path), lstat(join(path, REVIEW_MARKER))])
        if (info.isDirectory() && marker.isFile() && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
      } catch {
        // Unmarked, unreadable, or already gone: left alone.
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

    if (!(await secureReviewRoot())) return json(500, { error: 'unsafe-temp', message: `${REVIEW_ROOT} is not a private directory of this user` })
    await pruneReviews()
    const label = (basename(root) || 'repo').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
    const base = await mkdtemp(join(REVIEW_ROOT, `${label}-`))
    await writeFile(join(base, REVIEW_MARKER), '')
    const snapshot = join(base, 'HEAD')
    const stubs = join(base, 'deleted')
    const emptyLeft = join(base, 'empty-old')
    const emptyRight = join(base, 'empty-new')
    await Promise.all([mkdir(snapshot, { recursive: true }), mkdir(stubs, { recursive: true }), mkdir(emptyLeft, { recursive: true }), mkdir(emptyRight, { recursive: true })])

    const pairs = []
    // HEAD versions that could not be read (timeout, oversized, corrupt object) are left out
    // and reported, never shown as an empty baseline.
    const unreadable = []
    for (const change of parsed.lines) {
      const { oldPath, newPath } = reviewSides(change)
      const real = join(root, newPath)
      let info
      try {
        info = await lstat(real)
      } catch {
        info = null
      }
      // Submodules and other directories have no file content to compare.
      if (info !== null && info.isDirectory()) continue
      let content = Buffer.alloc(0)
      if (oldPath !== null) {
        // cat-file prints the stored bytes; no textconv, filter, or pager applies.
        const blob = await run(config.gitPath, ['-C', root, 'cat-file', 'blob', `HEAD:${oldPath}`], { timeoutMs: config.gitTimeoutMs, signal, encoding: 'buffer' })
        if (blob.code !== 0 || blob.failure !== null) {
          unreadable.push(oldPath)
          continue
        }
        content = blob.stdout
      }
      const left = join(snapshot, newPath)
      await mkdir(dirname(left), { recursive: true })
      await writeFile(left, content)
      let right = real
      if (info === null) {
        right = join(stubs, newPath)
        await mkdir(dirname(right), { recursive: true })
        await writeFile(right, '')
      }
      pairs.push([left, right])
    }
    if (pairs.length === 0) {
      if (unreadable.length > 0) return json(500, { error: 'unreadable', files: unreadable, message: `could not read ${unreadable.length} file(s) from HEAD` })
      return json(200, { opened: false, reason: 'clean', files: 0, total: parsed.total })
    }
    const args = ['--diff', emptyLeft, emptyRight, ...pairs.flatMap(([left, right]) => ['--diff', left, right])]
    const opened = await run(zed, args, { timeoutMs: config.zedTimeoutMs, signal: lifetime.signal })
    if (opened.failure === 'missing') return json(503, { error: 'zed-missing', message: 'Zed CLI not found; set zedPath' })
    if (opened.failure === 'timeout') return json(504, { error: 'timeout', message: 'Zed did not answer in time' })
    if (opened.code !== 0) return json(500, { error: 'zed-failed', message: firstLine(opened.stderr) || `exit ${opened.code}` })
    return json(200, { opened: true, files: pairs.length, total: parsed.total, truncated: parsed.truncated, unreadable })
  }

  /** One pull or push per repository at a time. */
  const syncing = new Set()
  /** BatchMode keeps ssh from waiting for a passphrase nobody can type. */
  const sshEnv = () => (process.env.GIT_SSH_COMMAND === undefined ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {})

  /**
   * Run one pull or push under the per-repository lock. A started operation
   * ends on its own: closing the panel must not cut a merge or push short.
   */
  const synced = async (body, signal, operation) => {
    const directory = await directoryOf(body.sessionId, signal)
    if (!directory.ok) return directory.response
    const found = await rootOf(directory.cwd, signal)
    if (!found.ok) return found.response
    const { root } = found
    if (syncing.has(root)) return json(409, { error: 'busy', message: 'a pull or push is already running in this repository' })
    syncing.add(root)
    try {
      const own = lifetime.signal
      const quick = args => run(config.gitPath, ['-C', root, ...args], { timeoutMs: config.gitTimeoutMs, signal: own })
      const branch = await quick(['symbolic-ref', '--quiet', '--short', 'HEAD'])
      if (branch.code !== 0) return json(409, { error: 'detached', message: 'HEAD is detached' })
      return await operation({ root, own, quick, branch: line(branch.stdout) })
    } finally {
      syncing.delete(root)
    }
  }

  /**
   * Fetch, then fast-forward the current branch to its upstream. A detached
   * HEAD, a missing upstream, a diverged branch, and local changes the merge
   * would overwrite are refused; nothing else is attempted.
   */
  const pull = (body, signal) => synced(body, signal, async ({ root, own, quick, branch }) => {
    const upstream = await quick(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    if (upstream.code !== 0) return json(409, { error: 'no-upstream', message: 'the branch has no upstream' })
    const before = line((await quick(['rev-parse', 'HEAD'])).stdout)
    const fetched = await run(config.gitPath, ['-C', root, 'fetch', '--quiet'], { timeoutMs: config.pullTimeoutMs, signal: own, env: sshEnv() })
    if (fetched.failure === 'timeout') return json(504, { error: 'timeout', message: 'git fetch took too long' })
    if (fetched.code !== 0) return json(502, { error: 'fetch-failed', message: firstLine(fetched.stderr) })
    const counts = parseLeftRight((await quick(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout)
    const upstreamName = line(upstream.stdout)
    if (counts === null) return json(500, { error: 'failed', message: 'could not compare with the upstream' })
    if (counts.behind === 0) return json(200, { result: 'up-to-date', ahead: counts.ahead, upstream: upstreamName })
    if (counts.ahead > 0) return json(409, { error: 'diverged', ahead: counts.ahead, behind: counts.behind, upstream: upstreamName, message: 'the branch has diverged from its upstream' })
    const target = line((await quick(['rev-parse', '--verify', '--quiet', '@{upstream}^{commit}'])).stdout)
    if (!/^[0-9a-f]{40,64}$/.test(target)) return json(500, { error: 'failed', message: 'could not resolve the upstream commit' })
    // Configuration can turn a merge into something else (merge.autostash, or branch.<b>.mergeOptions
    // such as --squash or --no-ff); the overrides and explicit flags pin a plain fast-forward to the
    // exact commit compared above, and HEAD is checked afterwards.
    const merged = await run(config.gitPath, [
      '-C', root, '-c', 'merge.autostash=false', '-c', `branch.${branch}.mergeOptions=`,
      'merge', '--ff-only', '--no-autostash', '--no-squash', '--no-stat', '--quiet', target,
    ], { timeoutMs: config.pullTimeoutMs, signal: own })
    if (merged.failure === 'timeout') return json(504, { error: 'timeout', message: 'git merge took too long' })
    if (merged.code !== 0) {
      const files = overwrittenFiles(merged.stderr)
      if (files.length > 0) return json(409, { error: 'local-changes', files, message: 'local changes would be overwritten' })
      return json(500, { error: 'failed', message: firstLine(merged.stderr) })
    }
    const after = line((await quick(['rev-parse', 'HEAD'])).stdout)
    if (after !== target) return json(500, { error: 'failed', message: `HEAD is ${after.slice(0, 7)} after the merge, not ${target.slice(0, 7)}` })
    return json(200, { result: 'fast-forwarded', commits: counts.behind, from: before.slice(0, 7), to: after.slice(0, 7), upstream: upstreamName })
  })

  /**
   * Push the current branch without force. With an upstream: fetch its remote,
   * refuse when the branch is behind it (or pushes to a different push remote),
   * then push HEAD to the upstream branch. Without one: push to the only remote
   * (or `remote.pushDefault`) under the same branch name and set the upstream.
   */
  const push = (body, signal) => synced(body, signal, async ({ root, own, quick, branch }) => {
    const configValue = async key => {
      const result = await quick(['config', '--get', key])
      return result.code === 0 ? line(result.stdout) : ''
    }
    const remotes = (await quick(['remote'])).stdout.split('\n').filter(Boolean)
    // A remote name or merge ref comes from repository configuration, which git does not
    // validate on `git config`: only an existing, ordinary remote and a valid branch ref are used.
    const usableRemote = name => name === '.' || (remotes.includes(name) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..'))
    const usableRef = async ref => ref.startsWith('refs/heads/') && (await quick(['check-ref-format', ref])).code === 0
    // Explicit flags keep push.followTags and push.recurseSubmodules from adding refs or pushes;
    // `--` ends options before the remote and refspec.
    const pushRun = (options, remote, refspec) => run(config.gitPath, [
      '-C', root, 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', ...options, '--', remote, refspec,
    ], { timeoutMs: config.pushTimeoutMs, signal: own, env: sshEnv() })
    const outcome = (pushed) => {
      if (pushed.failure === 'timeout') return json(504, { error: 'timeout', message: 'git push took too long' })
      if (pushed.code === 0) return null
      const reason = parsePushRejection(pushed.stdout)
      if (reason !== null) return json(409, { error: 'rejected', message: reason })
      return json(502, { error: 'failed', message: firstLine(pushed.stderr) || `exit ${pushed.code}` })
    }
    const pushRemote = (await configValue(`branch.${branch}.pushRemote`)) || (await configValue('remote.pushDefault'))
    const upstream = await quick(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const head = line((await quick(['rev-parse', 'HEAD'])).stdout)

    if (upstream.code === 0) {
      const upstreamName = line(upstream.stdout)
      const remote = await configValue(`branch.${branch}.remote`)
      const mergeRef = await configValue(`branch.${branch}.merge`)
      if (remote === '' || mergeRef === '') return json(409, { error: 'no-upstream', message: 'the branch has no upstream' })
      if (!usableRemote(remote) || !(await usableRef(mergeRef))) {
        return json(409, { error: 'bad-config', message: `unusable upstream configuration: remote "${remote}", ref "${mergeRef}"` })
      }
      if (pushRemote !== '' && pushRemote !== remote) {
        return json(409, { error: 'triangular', pushRemote, upstream: upstreamName, message: 'the push remote differs from the upstream remote' })
      }
      if (remote !== '.') {
        const fetched = await run(config.gitPath, ['-C', root, 'fetch', '--quiet', '--', remote], { timeoutMs: config.pullTimeoutMs, signal: own, env: sshEnv() })
        if (fetched.failure === 'timeout') return json(504, { error: 'timeout', message: 'git fetch took too long' })
        if (fetched.code !== 0) return json(502, { error: 'fetch-failed', message: firstLine(fetched.stderr) })
      }
      const counts = parseLeftRight((await quick(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout)
      if (counts === null) return json(500, { error: 'failed', message: 'could not compare with the upstream' })
      if (counts.behind > 0) {
        return json(409, { error: counts.ahead > 0 ? 'diverged' : 'behind', ahead: counts.ahead, behind: counts.behind, upstream: upstreamName, message: 'the branch is behind its upstream' })
      }
      if (counts.ahead === 0) return json(200, { result: 'nothing', upstream: upstreamName })
      const failed = outcome(await pushRun([], remote, `HEAD:${mergeRef}`))
      if (failed !== null) return failed
      return json(200, { result: 'pushed', commits: counts.ahead, upstream: upstreamName, to: head.slice(0, 7), setUpstream: false })
    }

    // A configured upstream that no longer resolves (its remote branch was deleted, or the config
    // names something else) is not "no upstream": publishing anew would rewrite the tracking.
    const configuredRemote = await configValue(`branch.${branch}.remote`)
    const configuredMerge = await configValue(`branch.${branch}.merge`)
    if (configuredRemote !== '' || configuredMerge !== '') {
      return json(409, { error: 'bad-config', message: `upstream ${configuredRemote || '?'} ${configuredMerge || '?'} does not resolve` })
    }
    if (remotes.length === 0) return json(409, { error: 'no-remote', message: 'the repository has no remote' })
    const remote = pushRemote !== '' ? pushRemote : remotes.length === 1 ? remotes[0] : ''
    if (remote === '') return json(409, { error: 'choose-remote', branch, remotes, message: 'several remotes and no upstream' })
    if (remote === '.' || !usableRemote(remote) || !(await usableRef(`refs/heads/${branch}`))) {
      return json(409, { error: 'bad-config', message: `unusable push remote "${remote}"` })
    }
    const ahead = Number(line((await quick(['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`])).stdout)) || 0
    const failed = outcome(await pushRun(['--set-upstream'], remote, `HEAD:refs/heads/${branch}`))
    if (failed !== null) return failed
    return json(200, { result: 'pushed', commits: ahead, upstream: `${remote}/${branch}`, remote, to: head.slice(0, 7), setUpstream: true })
  })

  // Unload stops every process group and waits until each process has closed, not only the requests.
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...inflight])
    await Promise.allSettled([...children].map(child => child.closed))
  }, 'git-status: stop requests and processes in flight')

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

  for (const [path, handler] of [[SUMMARY_PATH, summary], [SIZE_PATH, size], [REVIEW_PATH, review], [PULL_PATH, pull], [PUSH_PATH, push]]) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch: owned(handler) }), `git-status: POST ${path}`)
  }
}
