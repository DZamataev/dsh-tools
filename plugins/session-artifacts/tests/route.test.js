import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, LIST_PATH, apply } from '../index.js'

const TIME = 1_700_000_000_000
const event = (seq, type, data) => ({ type, seq, time: TIME + seq, data })
const call = (seq, name, args) => event(seq, 'tool/call', { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: JSON.stringify(args) })
const result = (seq, callSeq, { isError = false, text = '' } = {}) => event(seq, 'tool/result', {
  turn: 1,
  step: 1,
  message: { role: 'tool', toolCallId: `call-${callSeq}`, isError, content: text === '' ? [] : [{ type: 'text', text }] },
})
const assistant = (seq, text) => event(seq, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })

const lastSeqOf = events => events.at(-1)?.seq ?? -1

function mount(overrides = {}, { events = [], cwd = '/repo', observe, cursor = lastSeqOf(events) } = {}) {
  const { value: config, issues } = Config['~standard'].validate(overrides)
  assert.equal(issues, undefined)
  const routes = new Map()
  const warnings = []
  const disposers = []
  let disposed = 0
  let currentCursor = cursor
  const sessions = new Map()
  const ctx = {
    logger: { warn: (message) => { warnings.push(String(message)) } },
    effect: (fn) => { disposers.push(fn()) },
    connection: { fetch: { register: (r) => { routes.set(r.path, r); return async () => { routes.delete(r.path) } } } },
    sessionQuery: {
      observeSession: observe ?? (async (sessionId) => {
        if (sessionId !== 'known' && !sessions.has(sessionId)) throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        const session = sessions.get(sessionId) ?? { events, header: { cwd } }
        return {
          events: session.events,
          header: session.header,
          cursor: session.cursor ?? currentCursor,
          source: session.source ?? 'live',
          ...session.revision === undefined ? {} : { revision: session.revision },
          [Symbol.dispose]: () => { disposed += 1 },
        }
      }),
    },
  }
  apply(ctx, config)
  const post = async (body) => {
    const response = await routes.get(LIST_PATH).fetch(new Request(`http://localhost${LIST_PATH}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  const unload = () => Promise.all(disposers.reverse().map(dispose => dispose?.()))
  return {
    routes,
    post,
    unload,
    warnings,
    disposed: () => disposed,
    setCursor: (value) => { currentCursor = value },
    addSession: (id, session) => { sessions.set(id, session) },
  }
}

test('registers the listing POST route', () => {
  const { routes } = mount()
  assert.deepEqual([...routes.keys()], [LIST_PATH])
  assert.deepEqual(routes.get(LIST_PATH).methods, ['POST'])
})

test('a malformed body answers 400', async () => {
  const m = mount()
  for (const body of ['not json', {}, [], { sessionId: 5 }, { sessionId: '' }]) {
    const { status, body: answer } = await m.post(body)
    assert.equal(status, 400)
    assert.equal(answer.error, 'bad-request')
    assert.equal(typeof answer.message, 'string')
  }
})

test('an unknown session answers 404 and an unreadable log answers 500', async () => {
  const missing = mount()
  assert.equal((await missing.post({ sessionId: 'unknown' })).status, 404)
  assert.equal((await missing.post({ sessionId: 'unknown' })).body.error, 'not-found')
  const broken = mount({}, { observe: async () => { throw Object.assign(new Error('boom'), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }) } })
  const { status, body } = await broken.post({ sessionId: 'known' })
  assert.equal(status, 500)
  assert.equal(body.error, 'read-failed')
})

test('lists artifacts with their current filesystem state and drops missing mention-only paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-artifacts-')))
  try {
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'plan.md'), '# plan\n')
    await writeFile(join(root, 'docs', 'notes.md'), 'note\n')
    const events = [
      call(1, 'write', { file_path: 'docs/plan.md' }),
      result(2, 1),
      call(3, 'write', { file_path: 'docs/gone.md' }),
      result(4, 3),
      assistant(5, 'I left docs/ghost.md and docs/notes.md here.'),
      call(6, 'exit_plan_mode', { plan: '# Kept\n\nbody' }),
      result(7, 6, { text: 'Plan approved — plan mode exited.' }),
    ]
    const m = mount({}, { events, cwd: root })
    const { status, body } = await m.post({ sessionId: 'known' })
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(body), ['ok', 'cwd', 'artifacts', 'plans', 'truncated'])
    assert.equal(body.ok, true)
    assert.equal(body.cwd, root)
    assert.equal(body.truncated, false)
    assert.deepEqual(body.plans.map(plan => [plan.status, plan.title]), [['approved', 'Kept']])
    assert.deepEqual(body.artifacts.map(artifact => [artifact.relPath, artifact.exists]), [
      ['docs/notes.md', true],
      ['docs/gone.md', false],
      ['docs/plan.md', true],
    ])
    const [notes, gone, plan] = body.artifacts
    assert.deepEqual(Object.keys(plan), [
      'path', 'relPath', 'name', 'ext', 'kind', 'sources', 'created', 'deleted', 'description',
      'ops', 'firstSeq', 'lastSeq', 'firstTime', 'lastTime', 'turns', 'exists', 'size', 'mtime',
    ])
    assert.deepEqual([notes.sources, notes.ops, notes.exists, notes.size], [['mention'], 0, true, 5])
    assert.deepEqual([gone.size, gone.mtime], [null, null])
    assert.deepEqual([plan.sources, plan.created, plan.exists, plan.size], [['write'], true, true, 7])
    assert.ok(plan.mtime > 0)
    assert.equal(body.artifacts.some(artifact => artifact.name === 'ghost.md'), false)
    assert.deepEqual(m.warnings, [])
    assert.equal(m.disposed(), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing mention-only paths do not consume the artifact budget', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-artifacts-')))
  try {
    await writeFile(join(root, 'real.md'), 'x')
    const events = [
      call(1, 'write', { file_path: 'real.md' }),
      result(2, 1),
      assistant(3, 'see ghost1.md ghost2.md ghost3.md'),
    ]
    const { body } = await mount({ maxArtifacts: 2 }, { events, cwd: root }).post({ sessionId: 'known' })
    assert.deepEqual(body.artifacts.map(artifact => artifact.name), ['real.md'])
    assert.equal(body.truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('truncated reports log entries beyond maxArtifacts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-artifacts-')))
  try {
    for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(join(root, name), name)
    const events = [
      call(1, 'write', { file_path: 'a.md' }),
      call(2, 'write', { file_path: 'b.md' }),
      call(3, 'write', { file_path: 'c.md' }),
    ]
    const { body } = await mount({ maxArtifacts: 2 }, { events, cwd: root }).post({ sessionId: 'known' })
    assert.deepEqual(body.artifacts.map(artifact => artifact.name), ['c.md', 'b.md'])
    assert.equal(body.truncated, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a symlinked Session directory keeps the spelling the agent used', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-artifacts-')))
  try {
    await mkdir(join(root, 'real'), { recursive: true })
    await writeFile(join(root, 'real', 'Doc.md'), 'x')
    await symlink('real', join(root, 'link'))
    const events = [call(1, 'write', { file_path: 'Doc.md' })]
    const { body } = await mount({}, { events, cwd: join(root, 'link') }).post({ sessionId: 'known' })
    assert.deepEqual(body.artifacts.map(artifact => [artifact.path, artifact.relPath]), [[join(root, 'link', 'Doc.md'), 'Doc.md']])
    assert.equal(body.artifacts[0].exists, true)
    assert.equal(body.artifacts[0].size, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two spellings of one file merge and keep a logged spelling', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-artifacts-')))
  try {
    await writeFile(join(root, 'real.md'), 'x')
    await symlink('real.md', join(root, 'alias.md'))
    const events = [
      call(1, 'write', { file_path: 'alias.md' }),
      assistant(2, 'also see real.md'),
    ]
    const { body } = await mount({}, { events, cwd: root }).post({ sessionId: 'known' })
    assert.equal(body.artifacts.length, 1)
    const [artifact] = body.artifacts
    assert.deepEqual([artifact.path, artifact.relPath, artifact.name], [join(root, 'real.md'), 'real.md', 'real.md'])
    assert.deepEqual([artifact.sources, artifact.ops, artifact.created, artifact.exists], [['write', 'mention'], 1, true, true])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the extraction is reused while the Session cursor is unchanged', async () => {
  const m = mount()
  const events = [call(1, 'write', { file_path: '/repo/a.md' })]
  m.addSession('known', { events, header: { cwd: '/repo' }, cursor: 1 })
  assert.deepEqual((await m.post({ sessionId: 'known' })).body.artifacts.map(artifact => artifact.name), ['a.md'])
  events.push(call(2, 'write', { file_path: '/repo/b.md' }))
  assert.deepEqual((await m.post({ sessionId: 'known' })).body.artifacts.map(artifact => artifact.name), ['a.md'])
  m.addSession('known', { events, header: { cwd: '/repo' }, cursor: 2 })
  assert.deepEqual((await m.post({ sessionId: 'known' })).body.artifacts.map(artifact => artifact.name), ['b.md', 'a.md'])
})

test('the extraction cache key covers the observation source and revision', async () => {
  const m = mount()
  const first = [call(1, 'write', { file_path: '/repo/a.md' })]
  m.addSession('known', { events: first, header: { cwd: '/repo' }, cursor: 1, source: 'prepared', revision: 'r1' })
  assert.deepEqual((await m.post({ sessionId: 'known' })).body.artifacts.map(artifact => artifact.name), ['a.md'])
  const changed = [call(1, 'write', { file_path: '/repo/a.md' }), call(2, 'write', { file_path: '/repo/b.md' })]
  m.addSession('known', { events: changed, header: { cwd: '/repo' }, cursor: 1, source: 'prepared', revision: 'r2' })
  assert.deepEqual((await m.post({ sessionId: 'known' })).body.artifacts.map(artifact => artifact.name), ['b.md', 'a.md'])
  // The revision changed again but the events did not: the r2 extraction is reused.
  m.addSession('known', { events: changed, header: { cwd: '/repo' }, cursor: 1, source: 'live', revision: undefined })
  assert.deepEqual((await m.post({ sessionId: 'known' })).body.artifacts.map(artifact => artifact.name), ['b.md', 'a.md'])
})

test('the extraction cache keeps the eight most recently used Sessions', async () => {
  const m = mount()
  for (let index = 0; index < 8; index += 1) {
    m.addSession(`s${index}`, { events: [call(1, 'write', { file_path: `/repo/s${index}.md` })], header: { cwd: '/repo' }, cursor: 1 })
    await m.post({ sessionId: `s${index}` })
  }
  // A hit reuses the cached extraction: changed history under the same cursor is invisible.
  m.addSession('s0', {
    events: [call(1, 'write', { file_path: '/repo/s0.md' }), call(2, 'write', { file_path: '/repo/s0-extra.md' })],
    header: { cwd: '/repo' },
    cursor: 1,
  })
  assert.deepEqual((await m.post({ sessionId: 's0' })).body.artifacts.map(artifact => artifact.name), ['s0.md'])
  // The ninth Session evicts s1, the least recently used at that point.
  m.addSession('s8', { events: [call(1, 'write', { file_path: '/repo/s8.md' })], header: { cwd: '/repo' }, cursor: 1 })
  await m.post({ sessionId: 's8' })
  m.addSession('s1', {
    events: [call(1, 'write', { file_path: '/repo/s1.md' }), call(2, 'write', { file_path: '/repo/s1-extra.md' })],
    header: { cwd: '/repo' },
    cursor: 1,
  })
  assert.deepEqual((await m.post({ sessionId: 's1' })).body.artifacts.map(artifact => artifact.name), ['s1-extra.md', 's1.md'])
})

test('expected stat failures stay silent, unexpected ones log codes and counts only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'session-artifacts-')))
  try {
    await symlink('loop-b.md', join(root, 'loop-a.md'))
    await symlink('loop-a.md', join(root, 'loop-b.md'))
    const longName = `${'x'.repeat(300)}.md`
    const events = [
      call(1, 'write', { file_path: longName }),
      call(2, 'write', { file_path: 'loop-a.md' }),
    ]
    const m = mount({}, { events, cwd: root })
    const { status, body } = await m.post({ sessionId: 'known' })
    assert.equal(status, 200)
    assert.deepEqual(body.artifacts.map(artifact => artifact.exists), [false, false])
    assert.equal(m.warnings.length, 1)
    assert.match(m.warnings[0], /ELOOP=1/)
    assert.equal(m.warnings[0].includes(root), false)
    assert.equal(m.warnings[0].includes('loop-a.md'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unloading the plugin answers 503 to requests it interrupts', async () => {
  let seen = null
  const observe = (sessionId, { signal }) => new Promise((resolve, reject) => {
    seen = signal
    signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { code: 'SESSION_QUERY_ABORTED' })) })
  })
  const m = mount({}, { observe })
  const pending = m.post({ sessionId: 'known' })
  for (let tick = 0; tick < 100 && seen === null; tick += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.notEqual(seen, null)
  await m.unload()
  assert.equal(seen.aborted, true)
  const { status, body } = await pending
  assert.equal(status, 503)
  assert.equal(body.error, 'unloading')
})

test('config rejects unknown keys, bad types, and bad values', () => {
  const issues = raw => Config['~standard'].validate(raw).issues
  assert.ok(issues({ typo: 1 }))
  assert.ok(issues({ maxArtifacts: 0 }))
  assert.ok(issues({ maxArtifacts: 1.5 }))
  assert.ok(issues({ maxPlanChars: '200000' }))
  assert.ok(issues({ maxMentionCandidates: 0 }))
  assert.ok(issues({ maxArtifacts: null }))
  assert.ok(issues({ includeMentions: null }))
  assert.ok(issues({ includeMentions: 'yes' }))
  assert.ok(issues({ extensions: { nope: ['x'] } }))
  assert.ok(issues({ extensions: { markdown: ['m d'] } }))
  assert.ok(issues({ extensions: { markdown: ['.md'] } }))
  assert.ok(issues({ extensions: { markdown: ['md', 7] } }))
  assert.ok(issues({ extensions: ['md'] }))
  assert.ok(issues({ extensions: { text: ['md'] } }))
  assert.ok(issues({ patchTools: 'apply_patch' }))
  assert.ok(issues({ patchTools: ['apply patch'] }))
  assert.ok(issues({ patchTools: [''] }))
  assert.ok(issues({ excludeSegments: 'node_modules' }))
  assert.ok(issues({ excludeSegments: ['node_modules/.git'] }))
  assert.ok(issues({ excludeSegments: [''] }))
  assert.ok(issues('nope'))
})

test('config defaults every kind and overrides the named ones', () => {
  const { value } = Config['~standard'].validate(undefined)
  assert.deepEqual(
    [value.maxArtifacts, value.includeMentions, value.maxPlanChars, value.maxMentionScanChars, value.maxMentionCandidates],
    [500, true, 200_000, 2_000_000, 300],
  )
  assert.deepEqual(value.extensions.markdown, ['md', 'markdown', 'mdx'])
  assert.deepEqual(value.extensions.image, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
  assert.deepEqual(value.patchTools, ['apply_patch', 'bash', 'run_code'])
  assert.deepEqual(value.excludeSegments, ['node_modules', '.git'])
  const merged = Config['~standard'].validate({ extensions: { image: ['heic'] } }).value
  assert.deepEqual([merged.extensions.image, merged.extensions.markdown], [['heic'], ['md', 'markdown', 'mdx']])
  const bare = Config['~standard'].validate({ patchTools: [], excludeSegments: [] }).value
  assert.deepEqual([bare.patchTools, bare.excludeSegments], [[], []])
})
