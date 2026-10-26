import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, SEARCH_PATH } from '../index.js'

const EVENTS = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Найди баг в парсере' }] } },
  { type: 'assistant/message', seq: 2, time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Баг в парсере: off-by-one.' }] } } },
]

function mount(overrides = {}) {
  const { value: config } = Config['~standard'].validate(overrides)
  let route
  let disposed = 0
  const effects = []
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => { effects.push(fn()) },
    connection: { fetch: { register: (r) => { route = r; return async () => { route = undefined } } } },
    sessionQuery: {
      observeSession: async (sessionId) => {
        if (sessionId !== 'known') throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { events: EVENTS, [Symbol.dispose]: () => { disposed += 1 } }
      },
    },
  }
  apply(ctx, config)
  const call = async (body) => {
    const response = await route.fetch(new Request(`http://localhost${SEARCH_PATH}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  return { route: () => route, call, disposed: () => disposed, effects }
}

test('registers one POST route on the shared API channel', () => {
  const { route } = mount()
  assert.equal(route().path, '/api/session-find.search')
  assert.deepEqual(route().methods, ['POST'])
})

test('returns grouped conversation matches and releases the observation', async () => {
  const m = mount()
  const { status, body } = await m.call({ sessionId: 'known', query: 'баг в парсере', regex: false })
  assert.equal(status, 200)
  assert.equal(body.scanned, 2)
  assert.equal(body.totalMatches, 2)
  assert.deepEqual(body.results.map(r => [r.seq, r.role, r.turn]), [[1, 'user', 1], [2, 'assistant', 1]])
  assert.equal(m.disposed(), 1)
})

test('maps request and lookup failures to statuses', async () => {
  const m = mount()
  assert.equal((await m.call({ sessionId: 'unknown', query: 'x', regex: false })).status, 404)
  const invalid = await m.call({ sessionId: 'known', query: '[', regex: true })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error, 'invalid-query')
  assert.equal((await m.call('not json')).status, 400)
})

test('a regex past the deadline answers 504', async () => {
  const m = mount({ timeoutMs: 200 })
  const original = EVENTS[1].data.content[0].text
  EVENTS[1].data.content[0].text = `${'a'.repeat(40)}!`
  try {
    const { status, body } = await m.call({ sessionId: 'known', query: '^(a+)+$', regex: true })
    assert.equal(status, 504)
    assert.equal(body.error, 'timeout')
  } finally {
    EVENTS[1].data.content[0].text = original
  }
})

test('config rejects out-of-range and unknown options', () => {
  assert.ok(Config['~standard'].validate({ timeoutMs: 5 }).issues)
  assert.ok(Config['~standard'].validate({ typo: 1 }).issues)
  assert.equal(Config['~standard'].validate(undefined).value.maxResults, 300)
})
