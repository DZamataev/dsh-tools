/**
 * Pure search over one Session log: conversation text extraction and
 * matching. No Node or DSH imports, so the matching half runs unchanged in
 * the worker thread that bounds user-supplied regular expressions.
 */

/**
 * The conversation of one Session log, in log order: human prompts and
 * assistant replies. Only text blocks count, kept verbatim; reasoning, tool
 * calls, tool results, and injected user-role context (`source.kind !==
 * 'user'`) do not. A message whose text blocks are all blank is skipped.
 * @param {readonly { type: string, seq: number, time: number, data: any }[]} events - raw Session events.
 * @returns {{ seq: number, time: number, turn: number | null, role: 'user' | 'assistant', text: string }[]} documents.
 */
export function conversationDocuments(events) {
  const documents = []
  let turn = null
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = typeof event.data?.turn === 'number' ? event.data.turn : null
      continue
    }
    let role
    let content
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      role = 'user'
      content = event.data.content
    } else if (event.type === 'assistant/message') {
      role = 'assistant'
      content = event.data?.message?.content
    } else {
      continue
    }
    const text = textOf(content)
    if (text.trim() === '') continue
    documents.push({ seq: event.seq, time: event.time, turn, role, text })
  }
  return documents
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
    .map(block => block.text)
    .join('\n\n')
}

const SPECIAL = /[\\^$.*+?()[\]{}|/]/g
const escapeWords = text => text.split(/\s+/u).filter(Boolean).map(word => word.replace(SPECIAL, '\\$&')).join('\\s+')

/**
 * Fold ё into е, keeping case. One UTF-16 unit replaces one, so match indices
 * in folded text are indices in the original text.
 * @param {string} text - text or query.
 * @returns {string} folded text of the same length.
 */
export function foldText(text) {
  return text.replace(/[ёЁ]/gu, letter => (letter === 'ё' ? 'е' : 'Е'))
}

/**
 * The index after an empty match: one code point on, so a `u`-flag matcher
 * never restarts inside a surrogate pair (where `exec` would step back and
 * repeat the same empty match forever).
 * @param {string} text - matched text.
 * @param {number} index - index of the empty match.
 * @returns {number} next index to search from.
 */
export function advanceIndex(text, index) {
  const unit = text.charCodeAt(index)
  if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return index + 2
  }
  return index + 1
}

/**
 * Every non-empty match of a global matcher in `text`, as [start, end) pairs.
 * @param {string} text - text to search.
 * @param {RegExp} matcher - global matcher.
 * @returns {Generator<[number, number]>} match bounds.
 */
export function* occurrences(text, matcher) {
  matcher.lastIndex = 0
  let match
  while ((match = matcher.exec(text)) !== null) {
    if (match[0].length === 0) {
      if (match.index >= text.length) return
      matcher.lastIndex = advanceIndex(text, match.index)
      continue
    }
    yield [match.index, match.index + match[0].length]
  }
}

/**
 * Literal query terms: whitespace-separated words, or a "quoted phrase"
 * (an unclosed quote runs to the end of the query).
 * @param {string} query - user query.
 * @returns {string[]} non-empty terms.
 */
export function queryTerms(query) {
  const terms = []
  for (const match of query.matchAll(/"([^"]*)"?|(\S+)/gu)) {
    const term = (match[1] ?? match[2]).trim()
    if (term !== '') terms.push(term)
  }
  return terms
}

/**
 * Compile the query for matching against {@link foldText} output. Literal
 * terms are case-insensitive, a phrase matches any run of whitespace where it
 * has one, and a message matches only when it contains every term, in any
 * order. A regular expression is one term compiled with the `gimu` flags.
 * Both modes treat ё and е as one letter.
 * @param {string} query - user query, already length-checked.
 * @param {boolean} regex - whether the query is a regular expression.
 * @returns {{ all: RegExp[], any: RegExp }} `all`: every term must match; `any`: global matcher of every occurrence of any term.
 * @throws {SyntaxError} when a regular expression is invalid or a literal query has no terms.
 */
export function compileQuery(query, regex) {
  const folded = foldText(query)
  if (regex) {
    const any = new RegExp(folded, 'gimu')
    return { all: [new RegExp(folded, 'imu')], any }
  }
  const sources = queryTerms(folded).map(escapeWords)
  if (sources.length === 0) throw new SyntaxError('empty query')
  // Longer terms first, so an occurrence of "конфиг" is not cut to "кон".
  const unique = [...new Set(sources)].sort((a, b) => b.length - a.length)
  return { all: unique.map(source => new RegExp(source, 'iu')), any: new RegExp(unique.join('|'), 'giu') }
}

/**
 * Find every match, grouped by message, in the order of `documents`.
 * @param {ReturnType<typeof conversationDocuments>} documents - searchable messages, already filtered and ordered.
 * @param {ReturnType<typeof compileQuery>} plan - compiled query.
 * @param {{ maxResults: number, snippetsPerMessage: number, contextBefore: number, contextAfter: number, maxMatchChars: number }} limits - result bounds.
 * @returns {{ results: object[], totalMessages: number, totalMatches: number, truncated: boolean }} matches.
 */
export function findMatches(documents, plan, limits) {
  const results = []
  let totalMessages = 0
  let totalMatches = 0
  for (const document of documents) {
    const { text } = document
    const folded = foldText(text)
    if (!plan.all.every(term => term.test(folded))) continue
    const snippets = []
    let count = 0
    let first = null
    for (const [start, end] of occurrences(folded, plan.any)) {
      if (first === null) first = start
      count += 1
      if (snippets.length < limits.snippetsPerMessage) snippets.push(snippet(text, start, end, limits))
    }
    if (count === 0) continue
    totalMessages += 1
    totalMatches += count
    if (results.length < limits.maxResults) {
      results.push({ seq: document.seq, time: document.time, turn: document.turn, role: document.role, count, first, snippets })
    }
  }
  return { results, totalMessages, totalMatches, truncated: totalMessages > results.length }
}

/**
 * Matcher of matched strings as literals (whitespace runs flexible), longest
 * first; the browser builds the same matcher to highlight rendered text.
 * @param {string[]} strings - folded matched strings.
 * @returns {RegExp | null} global matcher, or null when nothing is left to match.
 */
export function literalMatcher(strings) {
  const sources = [...new Set(strings.map(escapeWords))].filter(Boolean).sort((a, b) => b.length - a.length)
  return sources.length === 0 ? null : new RegExp(sources.join('|'), 'giu')
}

/**
 * What the browser needs to highlight a context window without running the
 * user's query: the distinct matched strings (folded, at most `maxStrings`,
 * each at most `maxChars` long; the target message's first), the first
 * match in the target message, and its ordinal among the literal occurrences
 * of those strings in the target. Literal highlighting can mark text the
 * query itself did not match (a regex with anchors or lookarounds); the
 * ordinal lets the browser scroll to the real first match.
 * @param {ReturnType<typeof conversationDocuments>} messages - the window's messages, full text.
 * @param {ReturnType<typeof compileQuery>} plan - compiled query.
 * @param {number} targetSeq - seq of the found message.
 * @param {{ maxStrings: number, maxChars: number }} limits - bounds on the returned strings.
 * @returns {{ strings: string[], targetFirst: number | null, targetOrdinal: number | null }} highlight data.
 */
export function matchedStrings(messages, plan, targetSeq, limits) {
  const strings = new Set()
  let targetFirst = null
  const ordered = [...messages.filter(message => message.seq === targetSeq), ...messages.filter(message => message.seq !== targetSeq)]
  for (const message of ordered) {
    const folded = foldText(message.text)
    for (const [start, end] of occurrences(folded, plan.any)) {
      if (message.seq === targetSeq && targetFirst === null) targetFirst = start
      if (strings.size < limits.maxStrings && end - start <= limits.maxChars) strings.add(folded.slice(start, end))
    }
  }
  let targetOrdinal = null
  const literal = literalMatcher([...strings])
  const target = ordered[0]
  if (literal !== null && targetFirst !== null && target?.seq === targetSeq) {
    let ordinal = 0
    for (const [start] of occurrences(foldText(target.text), literal)) {
      if (start >= targetFirst) { targetOrdinal = ordinal; break }
      ordinal += 1
    }
  }
  return { strings: [...strings], targetFirst, targetOrdinal }
}

/**
 * Messages around one conversation message, full text, for reading a match in context.
 * @param {ReturnType<typeof conversationDocuments>} documents - the Session's conversation.
 * @param {number} seq - log seq of the target message.
 * @param {number} before - messages to include before the target.
 * @param {number} after - messages to include after the target.
 * @returns {{ messages: object[], hasEarlier: boolean, hasLater: boolean } | null} the window, or null when no conversation message has `seq`.
 */
export function contextWindow(documents, seq, before, after) {
  const index = documents.findIndex(document => document.seq === seq)
  if (index === -1) return null
  const from = Math.max(0, index - before)
  const to = Math.min(documents.length, index + after + 1)
  return { messages: documents.slice(from, to), hasEarlier: from > 0, hasLater: to < documents.length }
}

/**
 * Bound message texts for the response. A long target message keeps the part
 * around its first match (`focus`); other long messages keep their start.
 * `cutBefore` / `cutAfter` mark the omitted sides.
 * @param {ReturnType<typeof conversationDocuments>} messages - window messages.
 * @param {number} targetSeq - seq of the found message.
 * @param {number | null} focus - index of the first match in the target, when known.
 * @param {number} maxChars - longest text kept per message.
 * @returns {object[]} messages with `text`, `cutBefore` and `cutAfter`.
 */
export function boundMessages(messages, targetSeq, focus, maxChars) {
  return messages.map((message) => {
    const { text } = message
    if (text.length <= maxChars) return { ...message, cutBefore: false, cutAfter: false }
    const center = message.seq === targetSeq && focus !== null ? focus : 0
    let start = Math.max(0, Math.min(center - Math.floor(maxChars / 4), text.length - maxChars))
    // Never split a surrogate pair at either end.
    if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1
    let end = Math.min(text.length, start + maxChars)
    if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1
    return { ...message, text: text.slice(start, end), cutBefore: start > 0, cutAfter: end < text.length }
  })
}

const isLowSurrogate = unit => unit >= 0xdc00 && unit <= 0xdfff

const squash = value => value.replace(/\s+/gu, ' ')

function snippet(text, start, end, limits) {
  const from = Math.max(0, start - limits.contextBefore)
  const to = Math.min(text.length, end + limits.contextAfter)
  const matched = text.slice(start, end)
  return {
    before: squash(text.slice(from, start)),
    match: squash(matched.length > limits.maxMatchChars ? `${matched.slice(0, limits.maxMatchChars)}…` : matched),
    after: squash(text.slice(end, to)),
    cutBefore: from > 0,
    cutAfter: to < text.length,
  }
}
