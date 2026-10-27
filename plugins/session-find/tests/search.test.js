import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceIndex, boundMessages, compileQuery, contextWindow, conversationDocuments, findMatches, foldText, literalMatcher, matchedStrings, occurrences, queryTerms, targetOrdinal } from '../search.js'
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

test('a quoted phrase ignores case, flexes whitespace, and skips reasoning, tools, and injected context', () => {
  const found = search('"конфиг базы"')
  assert.equal(found.totalMessages, 2)
  assert.equal(found.totalMatches, 2)
  assert.deepEqual(found.results.map(r => r.role), ['user', 'assistant'])
  assert.equal(found.results[0].snippets[0].match, 'конфиг   базы'.replace(/\s+/g, ' '))
})

test('unquoted words match in any order and all must be present', () => {
  const found = search('базы конфиг')
  assert.equal(found.totalMessages, 2)
  assert.equal(found.totalMatches, 4)
  assert.equal(search('конфиг версию').totalMessages, 0)
  assert.equal(search('лежит db.yml').totalMessages, 1)
})

test('query terms split words and quoted phrases, including an unclosed quote', () => {
  assert.deepEqual(queryTerms('a "b  c" d'), ['a', 'b  c', 'd'])
  assert.deepEqual(queryTerms('x "y z'), ['x', 'y z'])
  assert.deepEqual(queryTerms('""  '), [])
  assert.throws(() => compileQuery('""', false), SyntaxError)
})

test('a longer term wins over its prefix in one occurrence', () => {
  const [snippet] = search('кон конфиг').results[0].snippets
  assert.equal(snippet.match, 'конфиг')
})

test('literal search treats regex metacharacters as text', () => {
  assert.equal(search('1.2.3').totalMatches, 1)
  assert.equal(search('1x2x3').totalMatches, 0)
  assert.equal(search('db.yml').totalMatches, 1)
})

test('ё and е match each other in both directions and in regexes, keeping the original spelling', () => {
  const documents = [
    { seq: 0, time: 0, turn: 1, role: 'user', text: 'Ёлка стоит, всё ещё зелёная' },
    { seq: 1, time: 0, turn: 1, role: 'assistant', text: 'Елка и все еще зеленая' },
  ]
  const find = (query, regex = false) => findMatches(documents, compileQuery(query, regex), LIMITS)
  assert.equal(find('ёлка').totalMessages, 2)
  assert.equal(find('елка').totalMessages, 2)
  assert.equal(find('всё ещё').totalMessages, 2)
  assert.equal(find('зел[её]ная', true).totalMessages, 2)
  assert.equal(find('^Ёлка', true).totalMessages, 2)
  assert.equal(find('ёлка').results[0].snippets[0].match, 'Ёлка')
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
  const [snippet] = search('"лежит в"').results[0].snippets
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

test('the context window clamps at log edges', () => {
  const documents = conversationDocuments(LOG)
  const window = contextWindow(documents, documents[1].seq, 5, 0)
  assert.deepEqual(window.messages.map(m => m.role), ['user', 'assistant'])
  assert.equal(window.hasEarlier, false)
  assert.equal(window.hasLater, true)
  assert.equal(contextWindow(documents, 9999, 1, 1), null)
})

test('long messages are bounded: neighbours keep their start, the target keeps its match', () => {
  const target = { seq: 1, text: `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}` }
  const neighbour = { seq: 2, text: 'c'.repeat(300) }
  const [cutTarget, cutNeighbour] = boundMessages([target, neighbour], 1, 100, 40)
  assert.ok(cutTarget.text.includes('NEEDLE'))
  assert.equal(cutTarget.text.length, 40)
  assert.deepEqual([cutTarget.cutBefore, cutTarget.cutAfter], [true, true])
  assert.equal(cutNeighbour.text, 'c'.repeat(40))
  assert.deepEqual([cutNeighbour.cutBefore, cutNeighbour.cutAfter], [false, true])
  const [short] = boundMessages([{ seq: 3, text: 'ok' }], 3, 0, 40)
  assert.deepEqual([short.text, short.cutBefore, short.cutAfter], ['ok', false, false])
  const [emoji] = boundMessages([{ seq: 4, text: `${'😀'.repeat(30)}` }], 4, null, 7)
  assert.ok(!/[\ud800-\udbff]$/.test(emoji.text), 'no lone high surrogate at the end')
})

test('message text blocks are kept verbatim, blank-only messages are skipped', () => {
  const code = '    console.log(1)\n    console.log(2)\n'
  const documents = conversationDocuments([
    { type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: code }] } },
    { type: 'user/message', seq: 1, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '  \n ' }] } },
    { type: 'assistant/message', seq: 2, time: 0, data: { message: { content: [{ type: 'text', text: 'a ' }, { type: 'text', text: '   ' }, { type: 'text', text: ' b' }] } } },
  ])
  assert.deepEqual(documents.map(d => d.text), [code, 'a \n\n b'])
})

test('empty regex matches step over surrogate pairs instead of looping', () => {
  const documents = [{ seq: 0, time: 0, turn: 1, role: 'user', text: '😀x😀' }]
  const found = findMatches(documents, compileQuery('x*', true), LIMITS)
  assert.equal(found.totalMatches, 1)
  assert.deepEqual([...occurrences('😀😀', compileQuery('x*', true).any)], [])
  assert.equal(advanceIndex('😀', 0), 2)
  assert.equal(advanceIndex('ab', 0), 1)
})

test('target strings come first, so the string cap cannot drop the target highlight', () => {
  const messages = [{ seq: 1, text: 'alpha' }, { seq: 2, text: 'beta' }]
  const found = matchedStrings(messages, compileQuery('alpha|beta', true), 2, { maxStrings: 1, maxChars: 100 })
  assert.deepEqual(found.strings, ['beta'])
  assert.equal(found.targetFirst, 0)
})

test('the surroundings of the first target match come from the real match, not a look-alike', () => {
  const found = matchedStrings([{ seq: 1, text: 'bar Ёfoobar tail' }], compileQuery('(?<=foo)bar', true), 1, { maxStrings: 10, maxChars: 100 })
  assert.deepEqual(found.strings, ['bar'])
  assert.equal(found.targetFirst, 8)
  assert.equal(found.targetBefore, 'bar Еfoo')
  assert.equal(found.targetAfter, ' tail')
})

test('the target ordinal is counted in the shown text', () => {
  assert.equal(targetOrdinal('bar foobar', ['bar'], 7), 1)
  assert.equal(targetOrdinal('bar foobar', ['bar'], 99), null)
  assert.equal(targetOrdinal('bar', [], 0), null)
})

test('the browser picks the real match among look-alike highlights in rendered text', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const helpers = src.slice(src.indexOf('    const SPECIAL'), src.indexOf('    function readJson'))
  const anchor = src.slice(src.indexOf('    // Letters and digits only'), src.indexOf('    function ContextView'))
  const { pickAnchor, literalMatcher: matcherOf } = new Function(helpers + anchor + '; return { pickAnchor, literalMatcher }')()
  const candidatesIn = (text, strings) => [...occurrences(foldText(text), matcherOf(strings))].map(([at, end]) => ({ at, end }))
  // Raw Markdown: the link target holds a look-alike the renderer drops.
  const raw = '[bar](https://bar.example) foobar'
  const found = matchedStrings([{ seq: 1, text: raw }], compileQuery('(?<=foo)bar', true), 1, { maxStrings: 10, maxChars: 100 })
  const ordinal = targetOrdinal(raw, found.strings, found.targetFirst)
  const rendered = 'bar foobar'
  const picked = pickAnchor(candidatesIn(rendered, found.strings), rendered, found.targetBefore, found.targetAfter, ordinal)
  assert.equal(picked.at, 7)
  // A long plain message, cropped around the match.
  const long = 'bar '.repeat(500) + 'foobar bar bar'
  const plan = compileQuery('(?<=foo)bar', true)
  const hit = matchedStrings([{ seq: 1, text: long }], plan, 1, { maxStrings: 10, maxChars: 100 })
  const [shown] = boundMessages([{ seq: 1, text: long }], 1, hit.targetFirst, 1_000)
  const shownOrdinal = targetOrdinal(shown.text, hit.strings, hit.targetFirst - shown.offset)
  const choice = pickAnchor(candidatesIn(shown.text, hit.strings), shown.text, hit.targetBefore, hit.targetAfter, shownOrdinal)
  assert.equal(choice.at, hit.targetFirst - shown.offset)
  // Many hidden look-alikes before the match: the ordinal is far off, the scan still finds it.
  const linky = '[x](https://bar.example)\n'.repeat(400) + 'foobar UNIQUEFIRST' + '\nother bar'.repeat(400)
  const far = matchedStrings([{ seq: 1, text: linky }], plan, 1, { maxStrings: 10, maxChars: 100 })
  const farOrdinal = targetOrdinal(linky, far.strings, far.targetFirst)
  const linkyRendered = 'x\n'.repeat(400) + 'foobar UNIQUEFIRST' + '\nother bar'.repeat(400)
  const farChoice = pickAnchor(candidatesIn(linkyRendered, far.strings), linkyRendered, far.targetBefore, far.targetAfter, farOrdinal)
  assert.equal(farOrdinal, 400)
  assert.equal(farChoice.at, linkyRendered.indexOf('foobar') + 3)
  // A full scan stays cheap on a long message with many candidates.
  const huge = 'a bar '.repeat(30_000)
  const started = Date.now()
  pickAnchor(candidatesIn(huge, ['bar']), huge, 'a ', ' a', 29_999)
  assert.ok(Date.now() - started < 1_000, '30k candidates scored within a second')
})

test('search results carry the offset of their first match', () => {
  const [row] = findMatches([{ seq: 0, time: 0, turn: 1, role: 'user', text: 'xx needle needle' }], compileQuery('needle', false), LIMITS).results
  assert.equal(row.first, 3)
})

test('the client builds the same literal highlight matcher as the Host', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const client = new Function(`${src.slice(src.indexOf('    const SPECIAL'), src.indexOf('    function readJson'))}; return { literalMatcher, foldText, advanceIndex }`)()
  for (const strings of [['bar'], ['все  еще', 'a.b', 'needle'], ['  '], []]) {
    assert.equal(String(client.literalMatcher(strings)), String(literalMatcher(strings)))
  }
  assert.equal(client.foldText('Ёлка ёж'), foldText('Ёлка ёж'))
  assert.equal(client.advanceIndex('😀', 0), advanceIndex('😀', 0))
})

test('matched strings for highlighting are distinct, folded, bounded, and locate the target', () => {
  const messages = [
    { seq: 1, text: 'Ёлка, елка и ЁЛКА' },
    { seq: 2, text: 'ещё одна ёлка' },
  ]
  const found = matchedStrings(messages, compileQuery('ёлка', false), 2, { maxStrings: 10, maxChars: 100 })
  assert.deepEqual(found.strings.sort(), ['ЕЛКА', 'Елка', 'елка'])
  assert.equal(found.targetFirst, 9)
  assert.equal(matchedStrings(messages, compileQuery('ёлка', false), 1, { maxStrings: 1, maxChars: 100 }).strings.length, 1)
  assert.deepEqual(matchedStrings(messages, compileQuery('ёлка', false), 1, { maxStrings: 10, maxChars: 3 }).strings, [])
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
