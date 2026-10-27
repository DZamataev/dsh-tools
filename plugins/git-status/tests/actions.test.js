import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, PULL_PATH, PUSH_PATH, REVIEW_PATH } from '../index.js'
import { overwrittenFiles, parseLeftRight, parsePushRejection, reviewSides } from '../git.js'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: ENV, stdio: 'pipe', encoding: 'utf8' }).trim()

let root
before(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'git-status-actions-'))) })
after(() => { rmSync(root, { recursive: true, force: true }) })

/** A bare origin, the session's clone, and a second clone that pushes. */
function remoteSetup(name) {
  const base = join(root, name)
  const origin = join(base, 'origin.git')
  const mine = join(base, 'mine')
  const theirs = join(base, 'theirs')
  mkdirSync(base, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: ENV })
  execFileSync('git', ['clone', '-q', origin, mine], { env: ENV, stdio: 'pipe' })
  writeFileSync(join(mine, 'a.txt'), 'one\n')
  git(mine, 'add', 'a.txt')
  git(mine, 'commit', '-q', '-m', 'first')
  git(mine, 'push', '-q', '-u', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, theirs], { env: ENV, stdio: 'pipe' })
  const theirsCommit = (file, text) => {
    writeFileSync(join(theirs, file), text)
    git(theirs, 'add', file)
    git(theirs, 'commit', '-q', '-m', `theirs ${file}`)
    git(theirs, 'push', '-q', 'origin', 'main')
  }
  return { mine, theirs, theirsCommit }
}

function mount(directory, overrides = {}) {
  const { value: config } = Config['~standard'].validate(overrides)
  const routes = new Map()
  const disposers = []
  apply({
    logger: { warn() {} },
    effect: (fn) => { disposers.push(fn()) },
    connection: { fetch: { register: (r) => { routes.set(r.path, r); return async () => {} } } },
    sessionQuery: { observeSession: async () => ({ header: {}, projections: { values: { workingDirectory: directory } }, [Symbol.dispose]() {} }) },
  }, config)
  const call = async (path) => {
    const response = await routes.get(path).fetch(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify({ sessionId: 's' }) }))
    return { status: response.status, body: await response.json() }
  }
  return { call, unload: () => Promise.all(disposers.map(dispose => dispose?.())) }
}

test('pull: up to date, then a fast-forward', async () => {
  const { mine, theirsCommit } = remoteSetup('ff')
  const m = mount(mine)
  const same = await m.call(PULL_PATH)
  assert.equal(same.status, 200)
  assert.deepEqual([same.body.result, same.body.ahead, same.body.upstream], ['up-to-date', 0, 'origin/main'])
  theirsCommit('b.txt', 'b\n')
  theirsCommit('c.txt', 'c\n')
  const before = git(mine, 'rev-parse', '--short=7', 'HEAD')
  const pulled = await m.call(PULL_PATH)
  assert.equal(pulled.status, 200)
  assert.equal(pulled.body.result, 'fast-forwarded')
  assert.equal(pulled.body.commits, 2)
  assert.equal(pulled.body.from, before)
  assert.equal(pulled.body.to, git(mine, 'rev-parse', '--short=7', 'HEAD'))
  assert.ok(existsSync(join(mine, 'c.txt')))
})

test('pull: an unrelated local edit survives a fast-forward', async () => {
  const { mine, theirsCommit } = remoteSetup('dirty-ok')
  writeFileSync(join(mine, 'a.txt'), 'local edit\n')
  theirsCommit('b.txt', 'b\n')
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.equal(status, 200)
  assert.equal(body.result, 'fast-forwarded')
  assert.equal(readFileSync(join(mine, 'a.txt'), 'utf8'), 'local edit\n')
})

test('pull: refuses when the merge would overwrite local changes', async () => {
  const { mine, theirsCommit } = remoteSetup('overwrite')
  theirsCommit('a.txt', 'theirs\n')
  writeFileSync(join(mine, 'a.txt'), 'mine\n')
  const head = git(mine, 'rev-parse', 'HEAD')
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.equal(status, 409)
  assert.equal(body.error, 'local-changes')
  assert.deepEqual(body.files, ['a.txt'])
  assert.equal(git(mine, 'rev-parse', 'HEAD'), head)
  assert.equal(readFileSync(join(mine, 'a.txt'), 'utf8'), 'mine\n')
})

test('pull: refuses a diverged branch without touching it', async () => {
  const { mine, theirsCommit } = remoteSetup('diverged')
  theirsCommit('b.txt', 'b\n')
  writeFileSync(join(mine, 'local.txt'), 'l\n')
  git(mine, 'add', 'local.txt')
  git(mine, 'commit', '-q', '-m', 'local')
  const head = git(mine, 'rev-parse', 'HEAD')
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.equal(status, 409)
  assert.deepEqual([body.error, body.ahead, body.behind, body.upstream], ['diverged', 1, 1, 'origin/main'])
  assert.equal(git(mine, 'rev-parse', 'HEAD'), head)
})

test('pull: detached HEAD, a branch without upstream, and a plain directory', async () => {
  const { mine } = remoteSetup('refusals')
  git(mine, 'checkout', '-q', '-b', 'local-only')
  assert.equal((await mount(mine).call(PULL_PATH)).body.error, 'no-upstream')
  git(mine, 'checkout', '-q', '--detach')
  assert.equal((await mount(mine).call(PULL_PATH)).body.error, 'detached')
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  const outside = await mount(plain).call(PULL_PATH)
  assert.deepEqual([outside.status, outside.body.error], [409, 'not-repository'])
})

test('pull: a fetch failure is reported', async () => {
  const { mine } = remoteSetup('fetch-fail')
  git(mine, 'remote', 'set-url', 'origin', join(root, 'no-such-remote.git'))
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.equal(status, 502)
  assert.equal(body.error, 'fetch-failed')
})

/** A stand-in Zed CLI that records its arguments, one per line. */
function fakeZed(name) {
  const log = join(root, `${name}.args`)
  const script = join(root, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`)
  chmodSync(script, 0o755)
  return { script, args: () => readFileSync(log, 'utf8').trimEnd().split('\n') }
}

test('review: one multi-diff of HEAD against the real working files', async () => {
  const { mine } = remoteSetup('review')
  writeFileSync(join(mine, 'gone.txt'), 'gone\n')
  writeFileSync(join(mine, 'old name.txt'), 'renamed\n')
  git(mine, 'add', '.')
  git(mine, 'commit', '-q', '-m', 'more')
  writeFileSync(join(mine, 'a.txt'), 'two\n')
  rmSync(join(mine, 'gone.txt'))
  git(mine, 'mv', 'old name.txt', 'new name.txt')
  mkdirSync(join(mine, 'dir'))
  writeFileSync(join(mine, 'dir', 'new.txt'), 'new\n')
  const zed = fakeZed('review')
  const { status, body } = await mount(mine, { zedPath: zed.script }).call(REVIEW_PATH)
  assert.equal(status, 200)
  assert.deepEqual([body.opened, body.files, body.total, body.truncated], [true, 4, 4, false])

  const args = zed.args()
  const pairs = []
  for (let i = 0; i < args.length; i += 3) {
    assert.equal(args[i], '--diff')
    pairs.push([args[i + 1], args[i + 2]])
  }
  // The first pair is two empty directories: Zed's single-window switch.
  assert.deepEqual(readdirSync(pairs[0][0]), [])
  assert.deepEqual(readdirSync(pairs[0][1]), [])
  const byRight = new Map(pairs.slice(1).map(([left, right]) => [right, left]))
  const modified = byRight.get(join(mine, 'a.txt'))
  assert.equal(readFileSync(modified, 'utf8'), 'one\n')
  assert.equal(readFileSync(byRight.get(join(mine, 'new name.txt')), 'utf8'), 'renamed\n')
  assert.equal(readFileSync(byRight.get(join(mine, 'dir', 'new.txt')), 'utf8'), '')
  const deleted = pairs.slice(1).find(([left]) => left.endsWith('gone.txt'))
  assert.equal(readFileSync(deleted[0], 'utf8'), 'gone\n')
  assert.ok(!deleted[1].startsWith(mine))
  assert.equal(readFileSync(deleted[1], 'utf8'), '')
})

test('review: clean tree, missing Zed, file limit, and a plain directory', async () => {
  const { mine } = remoteSetup('review-edges')
  const zed = fakeZed('edges')
  assert.deepEqual((await mount(mine, { zedPath: zed.script }).call(REVIEW_PATH)).body, { opened: false, reason: 'clean', files: 0, total: 0 })
  for (const n of [1, 2, 3]) writeFileSync(join(mine, `n${n}.txt`), `${n}\n`)
  const limited = await mount(mine, { zedPath: zed.script, maxReviewFiles: 2 }).call(REVIEW_PATH)
  assert.deepEqual([limited.body.files, limited.body.total, limited.body.truncated], [2, 3, true])
  const missing = await mount(mine, { zedPath: join(root, 'no-zed') }).call(REVIEW_PATH)
  assert.deepEqual([missing.status, missing.body.error], [503, 'zed-missing'])
  const plain = join(root, 'plain-review')
  mkdirSync(plain, { recursive: true })
  assert.equal((await mount(plain, { zedPath: zed.script }).call(REVIEW_PATH)).body.error, 'not-repository')
})

test('git helpers for pull and review', () => {
  assert.deepEqual(parseLeftRight('2\t5\n'), { ahead: 2, behind: 5 })
  assert.equal(parseLeftRight(''), null)
  const stderr = 'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tdir/b.txt\nPlease commit your changes or stash them before you merge.\nAborting\n'
  assert.deepEqual(overwrittenFiles(stderr), ['a.txt', 'dir/b.txt'])
  assert.deepEqual(overwrittenFiles('fatal: other'), [])
  assert.deepEqual(reviewSides({ xy: ' M', path: 'a', orig: null }), { oldPath: 'a', newPath: 'a' })
  assert.deepEqual(reviewSides({ xy: 'R ', path: 'b', orig: 'a' }), { oldPath: 'a', newPath: 'b' })
  assert.deepEqual(reviewSides({ xy: '??', path: 'n', orig: null }), { oldPath: null, newPath: 'n' })
  assert.deepEqual(reviewSides({ xy: 'A ', path: 'n', orig: null }), { oldPath: null, newPath: 'n' })
})

test('config accepts the new options and rejects bad ones', () => {
  const ok = Config['~standard'].validate({ zedPath: '/x/zed', pullTimeoutMs: 5000, maxReviewFiles: 10 })
  assert.equal(ok.value.zedPath, '/x/zed')
  assert.ok(Config['~standard'].validate({ zedPath: 3 }).issues)
  assert.ok(Config['~standard'].validate({ maxReviewFiles: 0 }).issues)
})

const commitIn = (dir, file, text) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', `commit ${file}`)
}
const originHead = (theirs, ref = 'main') => {
  git(theirs, 'fetch', '-q', 'origin')
  return git(theirs, 'rev-parse', `origin/${ref}`)
}

test('push: nothing to push, then one local commit', async () => {
  const { mine, theirs } = remoteSetup('push-ff')
  const m = mount(mine)
  const nothing = await m.call(PUSH_PATH)
  assert.deepEqual([nothing.status, nothing.body.result, nothing.body.upstream], [200, 'nothing', 'origin/main'])
  commitIn(mine, 'b.txt', 'b\n')
  const pushed = await m.call(PUSH_PATH)
  assert.equal(pushed.status, 200)
  assert.deepEqual([pushed.body.result, pushed.body.commits, pushed.body.setUpstream], ['pushed', 1, false])
  assert.equal(originHead(theirs), git(mine, 'rev-parse', 'HEAD'))
})

test('push: refuses a branch that is behind or diverged, touching nothing', async () => {
  const { mine, theirs, theirsCommit } = remoteSetup('push-behind')
  theirsCommit('t.txt', 't\n')
  const behind = await mount(mine).call(PUSH_PATH)
  assert.deepEqual([behind.status, behind.body.error, behind.body.behind], [409, 'behind', 1])
  commitIn(mine, 'm.txt', 'm\n')
  const remoteBefore = originHead(theirs)
  const diverged = await mount(mine).call(PUSH_PATH)
  assert.deepEqual([diverged.status, diverged.body.error, diverged.body.ahead, diverged.body.behind], [409, 'diverged', 1, 1])
  assert.equal(originHead(theirs), remoteBefore)
})

test('push: a remote refusal is reported with its reason', async () => {
  const { mine } = remoteSetup('push-hook')
  const hook = join(root, 'push-hook', 'origin.git', 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  commitIn(mine, 'b.txt', 'b\n')
  const { status, body } = await mount(mine).call(PUSH_PATH)
  assert.equal(status, 409)
  assert.equal(body.error, 'rejected')
  assert.match(body.message, /remote rejected/)
})

test('push: a new branch is published to the only remote and tracked', async () => {
  const { mine, theirs } = remoteSetup('push-new')
  git(mine, 'checkout', '-q', '-b', 'feature/x')
  commitIn(mine, 'f.txt', 'f\n')
  const { status, body } = await mount(mine).call(PUSH_PATH)
  assert.equal(status, 200)
  assert.deepEqual([body.result, body.setUpstream, body.upstream, body.commits], ['pushed', true, 'origin/feature/x', 1])
  assert.equal(git(mine, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/x')
  assert.equal(originHead(theirs, 'feature/x'), git(mine, 'rev-parse', 'HEAD'))
})

test('push: several remotes, no remote, a separate push remote, and a detached HEAD', async () => {
  const { mine } = remoteSetup('push-refusals')
  git(mine, 'remote', 'add', 'other', join(root, 'push-refusals', 'origin.git'))
  git(mine, 'checkout', '-q', '-b', 'loose')
  const choose = await mount(mine).call(PUSH_PATH)
  assert.deepEqual([choose.body.error, choose.body.branch, choose.body.remotes], ['choose-remote', 'loose', ['origin', 'other']])
  git(mine, 'checkout', '-q', 'main')
  git(mine, 'config', 'branch.main.pushRemote', 'other')
  const triangular = await mount(mine).call(PUSH_PATH)
  assert.deepEqual([triangular.body.error, triangular.body.pushRemote, triangular.body.upstream], ['triangular', 'other', 'origin/main'])
  git(mine, 'checkout', '-q', '--detach')
  assert.equal((await mount(mine).call(PUSH_PATH)).body.error, 'detached')
  const lonely = join(root, 'lonely')
  mkdirSync(lonely)
  git(lonely, 'init', '-q', '-b', 'main')
  commitIn(lonely, 'a.txt', 'a\n')
  assert.equal((await mount(lonely).call(PUSH_PATH)).body.error, 'no-remote')
})

test('pull and push share one lock per repository', async () => {
  const { mine } = remoteSetup('push-lock')
  const hook = join(root, 'push-lock', 'origin.git', 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\nsleep 1\nexit 0\n')
  chmodSync(hook, 0o755)
  commitIn(mine, 'b.txt', 'b\n')
  const m = mount(mine)
  const pushing = m.call(PUSH_PATH)
  await new Promise(resolve => setTimeout(resolve, 300))
  const pulling = await m.call(PULL_PATH)
  assert.deepEqual([pulling.status, pulling.body.error], [409, 'busy'])
  assert.equal((await pushing).body.result, 'pushed')
})

test('push rejection parsing', () => {
  assert.equal(parsePushRejection('To /x\n!\tHEAD:refs/heads/main\t[remote rejected]\t(pre-receive hook declined)\nDone\n'), '[remote rejected] (pre-receive hook declined)')
  assert.equal(parsePushRejection('To /x\n \tHEAD:refs/heads/main\ta..b\nDone\n'), null)
})
