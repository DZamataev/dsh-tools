import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, SIZE_PATH, SUMMARY_PATH } from '../index.js'

let root
let repo
let plain
const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  stdio: 'pipe',
})

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-status-test-')))
  repo = join(root, 'repo')
  plain = join(root, 'plain')
  mkdirSync(repo)
  mkdirSync(plain)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first commit')
  git('checkout', '-q', '-b', 'feat/demo')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  writeFileSync(join(repo, 'new.txt'), 'new\n')
  writeFileSync(join(plain, 'f.bin'), Buffer.alloc(64 * 1024))
})

after(() => { rmSync(root, { recursive: true, force: true }) })

function mount(overrides = {}) {
  const { value: config } = Config['~standard'].validate(overrides)
  const routes = new Map()
  const disposers = []
  let observed = 0
  let disposed = 0
  const directories = { repo: () => repo, plain: () => plain, gone: () => join(root, 'missing') }
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => { disposers.push(fn()) },
    connection: { fetch: { register: (r) => { routes.set(r.path, r); return async () => { routes.delete(r.path) } } } },
    sessionQuery: {
      observeSession: async (sessionId) => {
        observed += 1
        if (sessionId === 'header-only') return { header: { cwd: plain }, projections: { values: { workingDirectory: null } }, [Symbol.dispose]: () => { disposed += 1 } }
        if (!(sessionId in directories)) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { header: { cwd: '/elsewhere' }, projections: { values: { workingDirectory: directories[sessionId]() } }, [Symbol.dispose]: () => { disposed += 1 } }
      },
    },
  }
  apply(ctx, config)
  const call = async (path, body) => {
    const response = await routes.get(path).fetch(new Request(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  const unload = () => Promise.all(disposers.reverse().map(dispose => dispose?.()))
  return { routes, call, unload, counts: () => ({ observed, disposed }) }
}

test('registers both POST routes and removes them on unload', async () => {
  const m = mount()
  assert.deepEqual([...m.routes.keys()], [SUMMARY_PATH, SIZE_PATH])
  for (const route of m.routes.values()) assert.deepEqual(route.methods, ['POST'])
  await m.unload()
  assert.equal(m.routes.size, 0)
})

test('summary reads the projected directory, branch, changes, and last commit', async () => {
  const m = mount()
  const { status, body } = await m.call(SUMMARY_PATH, { sessionId: 'repo' })
  assert.equal(status, 200)
  assert.equal(body.cwd, repo)
  assert.equal(body.name, 'repo')
  assert.equal(body.exists, true)
  assert.equal(body.git.error, null)
  assert.equal(body.git.branch, 'feat/demo')
  assert.equal(body.git.upstream, null)
  assert.deepEqual([body.git.unstaged, body.git.untracked, body.git.total], [1, 1, 2])
  assert.deepEqual(body.git.lines.map(line => `${line.xy} ${line.path}`), [' M a.txt', '?? new.txt'])
  assert.equal(body.git.root, repo)
  assert.equal(body.git.lastCommit.subject, 'first commit')
  assert.deepEqual([body.git.lastCommit.author, body.git.lastCommit.email], ['t', 't@t'])
  assert.deepEqual(m.counts(), { observed: 1, disposed: 1 })
})

test('summary outside a repository, for a missing directory, and with the header fallback', async () => {
  const m = mount()
  const plainBody = (await m.call(SUMMARY_PATH, { sessionId: 'plain' })).body
  assert.deepEqual([plainBody.exists, plainBody.git], [true, null])
  const gone = (await m.call(SUMMARY_PATH, { sessionId: 'gone' })).body
  assert.deepEqual([gone.exists, gone.git, gone.name], [false, null, 'missing'])
  const fallback = (await m.call(SUMMARY_PATH, { sessionId: 'header-only' })).body
  assert.equal(fallback.cwd, plain)
})

test('a missing git binary is reported, not thrown', async () => {
  const m = mount({ gitPath: join(root, 'no-such-git') })
  const { body } = await m.call(SUMMARY_PATH, { sessionId: 'repo' })
  assert.equal(body.git.error, 'git-missing')
})

test('size measures with du and caches per directory', async () => {
  const m = mount()
  const first = await m.call(SIZE_PATH, { sessionId: 'plain' })
  assert.equal(first.status, 200)
  assert.equal(first.body.error, null)
  assert.ok(first.body.bytes >= 64 * 1024)
  const second = await m.call(SIZE_PATH, { sessionId: 'plain' })
  assert.equal(second.body.measuredAt, first.body.measuredAt)
  const forced = await m.call(SIZE_PATH, { sessionId: 'plain', refresh: true })
  assert.ok(forced.body.measuredAt >= first.body.measuredAt)
  const missing = mount({ duPath: join(root, 'no-such-du') })
  assert.equal((await missing.call(SIZE_PATH, { sessionId: 'plain' })).body.error, 'du-missing')
})

test('rejects bad bodies and unknown sessions', async () => {
  const m = mount()
  assert.equal((await m.call(SUMMARY_PATH, 'not json')).status, 400)
  assert.equal((await m.call(SUMMARY_PATH, [])).status, 400)
  assert.equal((await m.call(SUMMARY_PATH, { sessionId: '' })).status, 400)
  assert.equal((await m.call(SIZE_PATH, { sessionId: 'nobody' })).status, 404)
})

test('config validation', () => {
  assert.ok(Config['~standard'].validate({ pollMs: 10 }).issues)
  assert.ok(Config['~standard'].validate({ bogus: 1 }).issues)
  assert.ok(Config['~standard'].validate({ gitPath: '' }).issues)
  assert.ok(Config['~standard'].validate('x').issues)
  assert.equal(Config['~standard'].validate(undefined).value.maxStatusLines, 20)
})
