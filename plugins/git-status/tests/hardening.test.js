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
  await new Promise(resolve => setTimeout(resolve, 300))
  const started = readFileSync(pids, 'utf8').trim().split('\n').map(Number)
  assert.equal(started.length, 3)
  await m.unload()
  for (const pid of started) assert.throws(() => process.kill(pid, 0), /ESRCH/)
  await pending
})
