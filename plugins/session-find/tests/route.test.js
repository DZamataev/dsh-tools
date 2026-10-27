import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, CONTEXT_PATH, SEARCH_PATH } from '../index.js'

const user = (seq, text) => ({ type: 'user/message', seq, time: seq + 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const agent = (seq, text) => ({ type: 'assistant/message', seq, time: seq + 1, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const turn = (seq, n) => ({ type: 'turn/start', seq, time: seq + 1, data: { turn: n } })

const EVENTS = [
  turn(0, 1),
  user(1, 'Найди баг в парсере'),
  agent(2, 'Баг в парсере: off-by-one.'),
  turn(3, 2),
  user(4, 'Почини'),
  agent(5, '## Готово\n\n- поправил индекс'),
]

function mount(overrides = {}, { events = EVENTS, observe } = {}) {
  const { value: config } = Config['~standard'].validate(overrides)
  const routes = new Map()
  const disposers = []
  let disposed = 0
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => { disposers.push(fn()) },
    connection: { fetch: { register: (r) => { routes.set(r.path, r); return async () => { routes.delete(r.path) } } } },
    sessionQuery: {
      observeSession: observe ?? (async (sessionId) => {
        if (sessionId !== 'known') throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { events, [Symbol.dispose]: () => { disposed += 1 } }
      }),
    },
  }
  apply(ctx, config)
  const fetchRoute = (path, body) => routes.get(path).fetch(new Request(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
  const call = async (path, body) => {
    const response = await fetchRoute(path, body)
    return { status: response.status, body: await response.json() }
  }
  const unload = () => Promise.all(disposers.reverse().map(dispose => dispose?.()))
  return { routes, call, fetchRoute, unload, disposed: () => disposed }
}

const ctxBody = (seq, query, regex = false, before = 1, after = 1) => ({ sessionId: 'known', seq, before, after, query, regex })

test('registers the search and context POST routes', () => {
  const { routes } = mount()
  assert.deepEqual([...routes.keys()], ['/api/session-find.search', '/api/session-find.context'])
  for (const route of routes.values()) assert.deepEqual(route.methods, ['POST'])
})

test('search returns grouped conversation matches and releases the observation', async () => {
  const m = mount()
  const { status, body } = await m.call(SEARCH_PATH, { sessionId: 'known', query: '"баг в парсере"', regex: false })
  assert.equal(status, 200)
  assert.equal(body.scanned, 4)
  assert.equal(body.totalMatches, 2)
  assert.deepEqual(body.results.map(r => [r.seq, r.role, r.turn]), [[1, 'user', 1], [2, 'assistant', 1]])
  assert.equal(m.disposed(), 1)
})

test('search filters by role and orders newest first before limiting', async () => {
  const m = mount({ maxResults: 1 })
  const newest = await m.call(SEARCH_PATH, { sessionId: 'known', query: 'а', regex: false, order: 'newest' })
  assert.deepEqual(newest.body.results.map(r => r.seq), [5])
  assert.equal(newest.body.truncated, true)
  const mine = await m.call(SEARCH_PATH, { sessionId: 'known', query: 'и', regex: false, roles: ['user'], order: 'newest' })
  assert.equal(mine.body.scanned, 2)
  assert.deepEqual(mine.body.results.map(r => r.role), ['user'])
  assert.equal((await m.call(SEARCH_PATH, { sessionId: 'known', query: 'а', regex: false, roles: [] })).status, 400)
  assert.equal((await m.call(SEARCH_PATH, { sessionId: 'known', query: 'а', regex: false, order: 'random' })).status, 400)
})

test('search maps request and lookup failures to statuses', async () => {
  const m = mount()
  assert.equal((await m.call(SEARCH_PATH, { sessionId: 'unknown', query: 'x', regex: false })).status, 404)
  const invalid = await m.call(SEARCH_PATH, { sessionId: 'known', query: '[', regex: true })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error, 'invalid-query')
  assert.equal((await m.call(SEARCH_PATH, 'not json')).status, 400)
})

test('a regex past the deadline answers 504', async () => {
  const m = mount({ timeoutMs: 200 }, { events: [turn(0, 1), user(1, `${'a'.repeat(40)}!`)] })
  const { status, body } = await m.call(SEARCH_PATH, { sessionId: 'known', query: '^(a+)+$', regex: true })
  assert.equal(status, 504)
  assert.equal(body.error, 'timeout')
})

test('context returns whole neighbouring messages, edge flags, and the strings to highlight', async () => {
  const m = mount()
  const { status, body } = await m.call(CONTEXT_PATH, ctxBody(2, 'парсере баг'))
  assert.equal(status, 200)
  assert.deepEqual(body.messages.map(message => [message.seq, message.role, message.turn]), [[1, 'user', 1], [2, 'assistant', 1], [4, 'user', 2]])
  assert.equal(body.messages[1].text, 'Баг в парсере: off-by-one.')
  assert.equal(body.hasEarlier, false)
  assert.equal(body.hasLater, true)
  assert.deepEqual([...body.highlights].sort(), ['Баг', 'баг', 'парсере'])
  assert.equal(body.highlightError, null)
  assert.equal(m.disposed(), 1)
})

test('context highlight strings come from the bounded worker, so a catastrophic regex only loses highlights', async () => {
  // Raw text starts with "**" (fast fail); the rendered neighbour would be "aaaa…!".
  const events = [turn(0, 1), user(1, 'needle'), agent(2, `**${'a'.repeat(40)}!**`)]
  const m = mount({ timeoutMs: 300 }, { events })
  const { status, body } = await m.call(CONTEXT_PATH, ctxBody(1, '^(a+)+$|needle', true))
  assert.equal(status, 200)
  assert.deepEqual(body.highlights, ['needle'])
  const slow = await m.call(CONTEXT_PATH, ctxBody(1, '(a+)+!$|needle', true))
  assert.equal(slow.status, 200)
  assert.equal(slow.body.highlights, null)
  assert.equal(slow.body.highlightError, 'timeout')
  assert.equal(slow.body.messages.length, 2)
})

test('an empty-matching regex next to an emoji finishes (mine filter, agent neighbour)', async () => {
  const events = [turn(0, 1), user(1, 'x'), agent(2, '😀 ок 😀')]
  const m = mount({ timeoutMs: 2_000 }, { events })
  const search = await m.call(SEARCH_PATH, { sessionId: 'known', query: 'x*', regex: true, roles: ['user'] })
  assert.equal(search.status, 200)
  assert.deepEqual(search.body.results.map(r => r.seq), [1])
  const context = await m.call(CONTEXT_PATH, ctxBody(1, 'x*', true))
  assert.equal(context.status, 200)
  assert.deepEqual(context.body.highlights, ['x'])
})

test('a long target message is cut around its first match', async () => {
  const events = [turn(0, 1), user(1, `${'a'.repeat(5_000)}NEEDLE${'b'.repeat(5_000)}`)]
  const m = mount({ maxMessageChars: 1_000 }, { events })
  const { body } = await m.call(CONTEXT_PATH, ctxBody(1, 'needle'))
  const [message] = body.messages
  assert.ok(message.text.includes('NEEDLE'))
  assert.ok(message.text.length <= 1_000)
  assert.equal(message.cutBefore, true)
  assert.equal(message.cutAfter, true)
})

test('when highlighting times out, the target is still cropped around the match the search reported', async () => {
  const events = [turn(0, 1), user(1, `${'b'.repeat(5_000)}needle`), agent(2, `${'a'.repeat(40)}!`)]
  const m = mount({ maxMessageChars: 1_000, timeoutMs: 300 }, { events })
  const query = 'needle|^(a+)+$'
  const search = await m.call(SEARCH_PATH, { sessionId: 'known', query, regex: true, roles: ['user'] })
  assert.equal(search.status, 200)
  const [row] = search.body.results
  assert.equal(row.first, 5_000)
  const { status, body } = await m.call(CONTEXT_PATH, { ...ctxBody(1, query, true), focus: row.first })
  assert.equal(status, 200)
  assert.equal(body.highlightError, 'timeout')
  assert.ok(body.messages[0].text.includes('needle'))
  assert.equal(body.messages[0].cutBefore, true)
  assert.equal((await m.call(CONTEXT_PATH, { ...ctxBody(1, 'needle'), focus: -1 })).status, 400)
})

test('the target ordinal points at the real match among literal highlights', async () => {
  const events = [turn(0, 1), user(1, 'bar foobar')]
  const m = mount({}, { events })
  const { body } = await m.call(CONTEXT_PATH, ctxBody(1, '(?<=foo)bar', true))
  assert.deepEqual(body.highlights, ['bar'])
  assert.equal(body.targetOrdinal, 1)
  assert.equal(body.targetBefore, 'bar foo')
})

test('in a cropped target the ordinal counts only the shown occurrences', async () => {
  const text = 'bar '.repeat(500) + 'foobar bar bar'
  const m = mount({ maxMessageChars: 1_000 }, { events: [turn(0, 1), user(1, text)] })
  const { body } = await m.call(CONTEXT_PATH, ctxBody(1, '(?<=foo)bar', true))
  const [shown] = body.messages
  const before = shown.text.slice(0, text.indexOf('foobar') + 3 - shown.offset)
  assert.equal(body.targetOrdinal, before.split('bar').length - 1)
  assert.ok(body.targetOrdinal < 300)
})

test('context rejects unknown messages, out-of-range windows, and missing queries', async () => {
  const m = mount({ maxContextMessages: 5 })
  assert.equal((await m.call(CONTEXT_PATH, ctxBody(3, 'x'))).body.error, 'no-message')
  assert.equal((await m.call(CONTEXT_PATH, ctxBody(2, 'x', false, 6, 1))).status, 400)
  assert.equal((await m.call(CONTEXT_PATH, ctxBody(-1, 'x'))).status, 400)
  assert.equal((await m.call(CONTEXT_PATH, { ...ctxBody(2, 'x'), sessionId: 'unknown' })).status, 404)
  assert.equal((await m.call(CONTEXT_PATH, { sessionId: 'known', seq: 2, before: 1, after: 1 })).status, 400)
  assert.equal((await m.call(CONTEXT_PATH, ctxBody(2, '(', true))).body.error, 'invalid-query')
})

test('unloading the plugin stops a running worker and waits for it', async () => {
  const m = mount({ timeoutMs: 60_000 }, { events: [turn(0, 1), user(1, `${'a'.repeat(40)}!`)] })
  const pending = m.call(SEARCH_PATH, { sessionId: 'known', query: '^(a+)+$', regex: true })
  await new Promise(resolve => setTimeout(resolve, 100))
  const started = Date.now()
  await m.unload()
  assert.ok(Date.now() - started < 3_000)
  const { status, body } = await pending
  assert.equal(status, 499)
  assert.equal(body.error, 'aborted')
})

test('unloading the plugin aborts a pending log read', async () => {
  let seen = null
  const observe = (sessionId, { signal }) => new Promise((resolve, reject) => {
    seen = signal
    signal.addEventListener('abort', () => { reject(Object.assign(new Error('aborted'), { code: 'SESSION_QUERY_ABORTED' })) })
  })
  const m = mount({}, { observe })
  const pending = m.call(SEARCH_PATH, { sessionId: 'known', query: 'x', regex: false })
  await new Promise(resolve => setTimeout(resolve, 20))
  await m.unload()
  assert.equal(seen.aborted, true)
  assert.equal((await pending).status, 499)
})

test('config rejects out-of-range and unknown options', () => {
  assert.ok(Config['~standard'].validate({ timeoutMs: 5 }).issues)
  assert.ok(Config['~standard'].validate({ typo: 1 }).issues)
  assert.equal(Config['~standard'].validate(undefined).value.maxResults, 300)
})
