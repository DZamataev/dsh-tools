// Regressions for the review findings: each case reproduces a reported attack or
// configuration and asserts the harmful effect no longer happens.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config, PULL_PATH, PUSH_PATH, REVIEW_PATH } from '../index.js'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: ENV, stdio: 'pipe', encoding: 'utf8' }).replace(/\n$/, '')
const INDEX = fileURLToPath(new URL('../index.js', import.meta.url))

let root
before(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'git-status-hardening-'))) })
after(() => { rmSync(root, { recursive: true, force: true }) })

function clonePair(name, branch = 'main') {
  const base = join(root, name)
  const origin = join(base, 'origin.git')
  const mine = join(base, 'mine')
  const theirs = join(base, 'theirs')
  mkdirSync(base, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin], { env: ENV })
  execFileSync('git', ['clone', '-q', origin, mine], { env: ENV, stdio: 'pipe' })
  git(mine, 'checkout', '-q', '-B', branch)
  writeFileSync(join(mine, 'a.txt'), 'one\n')
  git(mine, 'add', 'a.txt')
  git(mine, 'commit', '-q', '-m', 'first')
  git(mine, 'push', '-q', '-u', 'origin', branch)
  execFileSync('git', ['clone', '-q', '-b', branch, origin, theirs], { env: ENV, stdio: 'pipe' })
  const theirsCommit = (file, text) => {
    writeFileSync(join(theirs, file), text)
    git(theirs, 'add', file)
    git(theirs, 'commit', '-q', '-m', `theirs ${file}`)
    git(theirs, 'push', '-q', 'origin', branch)
  }
  return { origin, mine, theirs, theirsCommit }
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

test('push never lets a configured remote name become an option', async () => {
  const { origin, mine } = clonePair('inject')
  // The bare repository is one commit ahead of the local branch.
  writeFileSync(join(mine, 'b.txt'), 'b\n')
  git(mine, 'add', 'b.txt')
  git(mine, 'commit', '-q', '-m', 'newer')
  git(mine, 'push', '-q', 'origin', 'main')
  const remoteBefore = git(origin, 'rev-parse', 'main')
  git(mine, 'reset', '-q', '--hard', 'HEAD~1')
  git(mine, 'branch', '-q', '--unset-upstream')
  git(mine, 'remote', 'remove', 'origin')
  git(mine, 'config', 'remote.pushDefault', '--force')
  git(mine, 'config', 'push.default', 'current')
  git(mine, 'config', 'remote.HEAD:refs/heads/main.url', origin)
  const { status, body } = await mount(mine).call(PUSH_PATH)
  assert.equal(status, 409)
  assert.equal(body.error, 'bad-config')
  assert.equal(git(origin, 'rev-parse', 'main'), remoteBefore)
})

test('push refuses an upstream whose remote or merge ref is not ordinary', async () => {
  const { origin, mine } = clonePair('bad-upstream')
  writeFileSync(join(mine, 'b.txt'), 'b\n')
  git(mine, 'add', 'b.txt')
  git(mine, 'commit', '-q', '-m', 'b')
  const remoteBefore = git(origin, 'rev-parse', 'main')
  git(mine, 'config', 'branch.main.merge', 'refs/tags/v1')
  assert.equal((await mount(mine).call(PUSH_PATH)).body.error, 'bad-config')
  assert.equal(git(origin, 'rev-parse', 'main'), remoteBefore)
})

test('a repository path ending in a space is used exactly', async () => {
  const exact = clonePair('trailing ')
  const sibling = clonePair('trailing')
  sibling.theirsCommit('s.txt', 's\n')
  exact.theirsCommit('e.txt', 'e\n')
  const siblingBefore = git(sibling.mine, 'rev-parse', 'HEAD')
  const { status, body } = await mount(exact.mine).call(PULL_PATH)
  assert.equal(status, 200)
  assert.equal(body.result, 'fast-forwarded')
  assert.ok(existsSync(join(exact.mine, 'e.txt')))
  assert.equal(git(sibling.mine, 'rev-parse', 'HEAD'), siblingBefore)
})

test('merge.autostash cannot turn a refused pull into a conflicted one', async () => {
  const { mine, theirsCommit } = clonePair('autostash')
  theirsCommit('a.txt', 'theirs\n')
  writeFileSync(join(mine, 'a.txt'), 'mine\n')
  git(mine, 'config', 'merge.autostash', 'true')
  const head = git(mine, 'rev-parse', 'HEAD')
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.deepEqual([status, body.error, body.files], [409, 'local-changes', ['a.txt']])
  assert.equal(git(mine, 'rev-parse', 'HEAD'), head)
  assert.equal(readFileSync(join(mine, 'a.txt'), 'utf8'), 'mine\n')
  assert.equal(git(mine, 'status', '--porcelain'), ' M a.txt')
  assert.equal(git(mine, 'stash', 'list'), '')
})

test('branch mergeOptions cannot turn the fast-forward into a squash', async () => {
  const { mine, theirsCommit } = clonePair('squash', 'feat.a.b')
  theirsCommit('b.txt', 'b\n')
  git(mine, 'config', 'branch.feat.a.b.mergeOptions', '--squash --no-ff')
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.equal(status, 200)
  assert.equal(body.result, 'fast-forwarded')
  assert.notEqual(body.from, body.to)
  assert.equal(git(mine, 'rev-parse', 'HEAD'), git(mine, 'rev-parse', '@{upstream}'))
  assert.equal(git(mine, 'status', '--porcelain'), '')
})

test('review refuses a review root that is a symlink and deletes nothing outside it', () => {
  const temp = join(root, 'tmp-symlink')
  const outside = join(root, 'outside')
  mkdirSync(join(outside, 'old-unrelated'), { recursive: true })
  writeFileSync(join(outside, 'old-unrelated', 'keep.txt'), 'keep\n')
  mkdirSync(temp, { recursive: true })
  symlinkSync(outside, join(temp, 'dsh-git-review'))
  const { mine } = clonePair('review-root')
  writeFileSync(join(mine, 'a.txt'), 'changed\n')
  const zed = join(root, 'zed-ok.sh')
  writeFileSync(zed, '#!/bin/sh\nexit 0\n')
  chmodSync(zed, 0o755)
  // REVIEW_ROOT is fixed when the module loads, so this runs in a child with its own TMPDIR.
  const script = `
    import { apply, Config } from ${JSON.stringify(INDEX)}
    const routes = new Map()
    apply({ logger: { warn() {} }, effect: fn => fn(),
      connection: { fetch: { register: r => { routes.set(r.path, r); return () => {} } } },
      sessionQuery: { observeSession: async () => ({ header: {}, projections: { values: { workingDirectory: ${JSON.stringify(mine)} } }, [Symbol.dispose]() {} }) },
    }, Config['~standard'].validate({ zedPath: ${JSON.stringify(zed)} }).value)
    const response = await routes.get('/api/git-status.review').fetch(new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 's' }) }))
    console.log(JSON.stringify({ status: response.status, body: await response.json() }))
    process.exit(0)
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...ENV, TMPDIR: temp }, encoding: 'utf8' })
  const { status, body } = JSON.parse(result.stdout.trim().split('\n').pop())
  assert.deepEqual([status, body.error], [500, 'unsafe-temp'])
  assert.equal(readFileSync(join(outside, 'old-unrelated', 'keep.txt'), 'utf8'), 'keep\n')
})

test('review leaves out a file whose HEAD version cannot be read', async () => {
  const { mine } = clonePair('unreadable')
  writeFileSync(join(mine, 'b.txt'), 'b\n')
  git(mine, 'add', 'b.txt')
  git(mine, 'commit', '-q', '-m', 'b')
  writeFileSync(join(mine, 'a.txt'), 'changed\n')
  writeFileSync(join(mine, 'b.txt'), 'changed\n')
  const wrapper = join(root, 'git-no-catfile.sh')
  writeFileSync(wrapper, '#!/bin/sh\nif [ "$3" = cat-file ] && [ "$5" = "HEAD:b.txt" ]; then echo "fatal: bad object" >&2; exit 128; fi\nexec git "$@"\n')
  chmodSync(wrapper, 0o755)
  const log = join(root, 'zed-unreadable.args')
  const zed = join(root, 'zed-unreadable.sh')
  writeFileSync(zed, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`)
  chmodSync(zed, 0o755)
  const { status, body } = await mount(mine, { gitPath: wrapper, zedPath: zed }).call(REVIEW_PATH)
  assert.equal(status, 200)
  assert.deepEqual([body.opened, body.files, body.unreadable], [true, 1, ['b.txt']])
  const args = readFileSync(log, 'utf8')
  assert.ok(args.includes(join(mine, 'a.txt')))
  assert.ok(!args.includes(join(mine, 'b.txt')))
})

/** Poll until `count` pids are recorded in `file`, for at most `ms`. */
async function readPids(file, count, ms = 10_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const pids = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
    if (pids.length >= count) return pids
    if (Date.now() > deadline) throw new Error(`only ${pids.length} of ${count} processes started`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('unload waits until every child process has exited', async () => {
  const dir = join(root, 'slow')
  mkdirSync(dir, { recursive: true })
  const pids = join(root, 'slow.pids')
  const slowGit = join(root, 'slow-git.sh')
  // Acknowledges SIGTERM, then takes 300 ms to exit.
  writeFileSync(slowGit, `#!/bin/sh\necho $$ >> '${pids}'\ntrap 'sleep 0.3; exit 1' TERM\nwhile :; do sleep 0.05; done\n`)
  chmodSync(slowGit, 0o755)
  const m = mount(dir, { gitPath: slowGit })
  const pending = m.call('/api/git-status.summary').catch(() => null)
  let started = []
  try {
    started = await readPids(pids, 3)
  } finally {
    await m.unload()
  }
  for (const pid of started) assert.equal(alive(pid), false, `pid ${pid} still alive after unload`)
  await pending
})

test('a descendant holding the output pipes after git exits neither hangs a request nor outlives unload', async () => {
  const dir = join(root, 'linger')
  mkdirSync(dir, { recursive: true })
  const kids = join(root, 'linger.kids')
  const lingerGit = join(root, 'linger-git.sh')
  // Exits at once with success but leaves a 60 s child holding stdout and stderr.
  writeFileSync(lingerGit, `#!/bin/sh\nsleep 60 &\necho $! >> '${kids}'\nexit 0\n`)
  chmodSync(lingerGit, 0o755)
  const m = mount(dir, { gitPath: lingerGit })
  const started = Date.now()
  try {
    const { status } = await m.call('/api/git-status.summary')
    assert.equal(status, 200)
    assert.ok(Date.now() - started < 15_000, 'the request settled')
  } finally {
    await m.unload()
  }
  for (const pid of await readPids(kids, 3)) assert.equal(alive(pid), false, `descendant ${pid} survived`)
})

/** A clone at exactly `mine` whose upstream (its own bare origin) is one commit ahead. */
function behindAt(mine, branch = 'main') {
  const origin = `${mine}.origin.git`
  const theirs = `${mine}.theirs`
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin], { env: ENV })
  execFileSync('git', ['clone', '-q', origin, mine], { env: ENV, stdio: 'pipe' })
  git(mine, 'checkout', '-q', '-B', branch)
  writeFileSync(join(mine, 'a.txt'), 'one\n')
  git(mine, 'add', 'a.txt')
  git(mine, 'commit', '-q', '-m', 'first')
  git(mine, 'push', '-q', '-u', 'origin', branch)
  execFileSync('git', ['clone', '-q', '-b', branch, origin, theirs], { env: ENV, stdio: 'pipe' })
  writeFileSync(join(theirs, 'n.txt'), 'n\n')
  git(theirs, 'add', 'n.txt')
  git(theirs, 'commit', '-q', '-m', 'theirs')
  git(theirs, 'push', '-q', 'origin', branch)
  return mine
}

for (const [label, suffix] of [['space', ' '], ['carriage return', '\r']]) {
  test(`a repository root whose own name ends in a ${label} is not confused with its sibling`, async () => {
    const base = join(root, `leaf-${label.replace(' ', '-')}`)
    mkdirSync(base)
    const exact = behindAt(join(base, `repo${suffix}`))
    const sibling = behindAt(join(base, 'repo'))
    const siblingBefore = git(sibling, 'rev-parse', 'HEAD')
    const { status, body } = await mount(exact).call(PULL_PATH)
    assert.deepEqual([status, body.result], [200, 'fast-forwarded'])
    assert.ok(existsSync(join(exact, 'n.txt')))
    assert.equal(git(sibling, 'rev-parse', 'HEAD'), siblingBefore)
  })
}

test('a branch name containing = still has its mergeOptions cleared', async () => {
  const mine = behindAt(join(root, 'eq-branch'), 'foo=bar')
  git(mine, 'config', 'branch.foo=bar.mergeOptions', '--squash --no-ff')
  const cleared = execFileSync('git', ['-C', mine, 'config', '--get', 'branch.foo=bar.mergeOptions'], {
    env: { ...ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'branch.foo=bar.mergeOptions', GIT_CONFIG_VALUE_0: '' }, encoding: 'utf8',
  })
  assert.equal(cleared, '\n')
  const { status, body } = await mount(mine).call(PULL_PATH)
  assert.deepEqual([status, body.result], [200, 'fast-forwarded'])
  assert.equal(git(mine, 'rev-parse', 'HEAD'), git(mine, 'rev-parse', '@{upstream}'))
  assert.equal(git(mine, 'status', '--porcelain'), '')
})

test('review keeps a file replaced by a directory and a directory replaced by a file', async () => {
  const mine = join(root, 'replace')
  mkdirSync(mine)
  git(mine, 'init', '-q', '-b', 'main')
  mkdirSync(join(mine, 'd'))
  writeFileSync(join(mine, 'd', 'b'), 'in dir\n')
  writeFileSync(join(mine, 'f'), 'a file\n')
  git(mine, 'add', '.')
  git(mine, 'commit', '-q', '-m', 'tree')
  git(mine, 'rm', '-q', '-r', 'd', 'f')
  writeFileSync(join(mine, 'd'), 'now a file\n')
  mkdirSync(join(mine, 'f'))
  writeFileSync(join(mine, 'f', 'c'), 'now in a dir\n')
  const log = join(root, 'zed-replace.args')
  const zed = join(root, 'zed-replace.sh')
  writeFileSync(zed, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\n`)
  chmodSync(zed, 0o755)
  const { status, body } = await mount(mine, { zedPath: zed }).call(REVIEW_PATH)
  assert.equal(status, 200)
  assert.deepEqual([body.opened, body.files, body.unreadable], [true, 4, []])
  const args = readFileSync(log, 'utf8').trimEnd().split('\n')
  const pairs = []
  for (let i = 3; i < args.length; i += 3) pairs.push([args[i + 1], args[i + 2]])
  const leftOf = suffix => pairs.find(([left]) => left.endsWith(suffix))
  assert.equal(readFileSync(leftOf('/d/b')[0], 'utf8'), 'in dir\n')
  assert.equal(readFileSync(leftOf('/f')[0], 'utf8'), 'a file\n')
  assert.ok(pairs.some(([, right]) => right === join(mine, 'd')))
  assert.ok(pairs.some(([, right]) => right === join(mine, 'f', 'c')))
})
