import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileQuery, conversationDocuments, findMatches } from '../search.js'
import { parseRequest } from '../index.js'
import { runSearch, SearchStopped } from '../run.js'

const LIMITS = { maxResults: 100, snippetsPerMessage: 3, contextBefore: 10, contextAfter: 10, maxMatchChars: 50 }

let seq = 0
const ev = (type, data) => ({ type, seq: seq++, time: 1_700_000_000_000 + seq, data })
const user = (text, kind = 'user') => ev('user/message', { role: 'user', source: { kind }, content: [{ type: 'text', text }] })
const assistant = blocks => ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: blocks }, stream: [] })

const LOG = [
  ev('turn/start', { turn: 1 }),
  user('Где лежит конфиг   базы?'),
  user('<system-reminder>конфиг из инструкций</system-reminder>', 'agent-instructions'),
  assistant([
    { type: 'reasoning', text: 'думаю про конфиг' },
    { type: 'text', text: 'Конфиг базы лежит в config/db.yml.' },
    { type: 'tool-call', name: 'read', arguments: '{"path":"config/db.yml"}' },
  ]),
  ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"config/db.yml"}' }),
  ev('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'host: db.local конфиг' }] } }),
  ev('turn/start', { turn: 2 }),
  user('Покажи версию 1.2.3 и 4.5.6'),
  assistant([{ type: 'text', text: '' }]),
]

const search = (query, regex = false, limits = LIMITS) => findMatches(conversationDocuments(LOG), compileQuery(query, regex), limits)

test('only human prompts and assistant text are conversation', () => {
  const documents = conversationDocuments(LOG)
  assert.deepEqual(documents.map(d => [d.role, d.turn, d.text]), [
    ['user', 1, 'Где лежит конфиг   базы?'],
    ['assistant', 1, 'Конфиг базы лежит в config/db.yml.'],
    ['user', 2, 'Покажи версию 1.2.3 и 4.5.6'],
  ])
})

test('literal search ignores case, flexes whitespace, and skips reasoning, tools, and injected context', () => {
  const found = search('конфиг базы')
  assert.equal(found.totalMessages, 2)
  assert.equal(found.totalMatches, 2)
  assert.deepEqual(found.results.map(r => r.role), ['user', 'assistant'])
  assert.equal(found.results[0].snippets[0].match, 'конфиг базы')
})

test('literal search treats regex metacharacters as text', () => {
  assert.equal(search('1.2.3').totalMatches, 1)
  assert.equal(search('1x2x3').totalMatches, 0)
  assert.equal(search('db.yml').totalMatches, 1)
})

test('regex search matches patterns and counts every match in a message', () => {
  const found = search('\\d+\\.\\d+\\.\\d+', true)
  assert.equal(found.totalMessages, 1)
  assert.equal(found.results[0].count, 2)
  assert.deepEqual(found.results[0].snippets.map(s => s.match), ['1.2.3', '4.5.6'])
})

test('zero-length regex matches produce no results and terminate', () => {
  const found = search('x*', true)
  assert.equal(found.totalMatches, 0)
})

test('snippets carry bounded context with cut markers', () => {
  const [snippet] = search('лежит в').results[0].snippets
  assert.equal(snippet.match, 'лежит в')
  assert.equal(snippet.before, 'нфиг базы ')
  assert.equal(snippet.after, ' config/db')
  assert.equal(snippet.cutBefore, true)
  assert.equal(snippet.cutAfter, true)
})

test('results stop at maxResults while totals keep counting', () => {
  const found = search('конфиг', false, { ...LIMITS, maxResults: 1 })
  assert.equal(found.results.length, 1)
  assert.equal(found.totalMessages, 2)
  assert.equal(found.truncated, true)
})

test('request validation rejects empty, long, and invalid regex queries', () => {
  assert.equal(parseRequest({ sessionId: 's', query: '  ', regex: false }, 10).error, 'invalid-query')
  assert.equal(parseRequest({ sessionId: 's', query: 'x'.repeat(11), regex: false }, 10).error, 'invalid-query')
  const invalid = parseRequest({ sessionId: 's', query: '(', regex: true }, 10)
  assert.equal(invalid.error, 'invalid-query')
  assert.match(invalid.message, /Invalid regular expression/)
  assert.equal(parseRequest({ sessionId: '', query: 'a', regex: false }, 10).error, 'bad-request')
  assert.equal(parseRequest({ sessionId: 's', query: '(', regex: false }, 10).ok, true)
})

test('the worker returns matches', async () => {
  const result = await runSearch({ documents: conversationDocuments(LOG), query: 'версию', regex: false, limits: LIMITS }, 5_000)
  assert.equal(result.totalMatches, 1)
})

test('a catastrophic regex is stopped at the deadline', async () => {
  const documents = [{ seq: 0, time: 0, turn: 1, role: 'user', text: `${'a'.repeat(40)}!` }]
  const started = Date.now()
  await assert.rejects(
    runSearch({ documents, query: '^(a+)+$', regex: true, limits: LIMITS }, 300),
    error => error instanceof SearchStopped && error.reason === 'timeout',
  )
  assert.ok(Date.now() - started < 3_000)
})

test('an aborted search stops the worker', async () => {
  const controller = new AbortController()
  const documents = [{ seq: 0, time: 0, turn: 1, role: 'user', text: `${'a'.repeat(40)}!` }]
  const pending = runSearch({ documents, query: '^(a+)+$', regex: true, limits: LIMITS }, 60_000, controller.signal)
  setTimeout(() => { controller.abort() }, 50)
  await assert.rejects(pending, error => error instanceof SearchStopped && error.reason === 'aborted')
})
