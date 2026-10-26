/**
 * Pure search over one Session log: conversation text extraction and
 * matching. No Node or DSH imports, so the matching half runs unchanged in
 * the worker thread that bounds user-supplied regular expressions.
 */

/**
 * The conversation of one Session log, in log order: human prompts and
 * assistant replies. Only text blocks count; reasoning, tool calls, tool
 * results, and injected user-role context (`source.kind !== 'user'`) do not.
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
    if (text === '') continue
    documents.push({ seq: event.seq, time: event.time, turn, role, text })
  }
  return documents
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

const SPECIAL = /[\\^$.*+?()[\]{}|/]/g

/**
 * Compile the query. A literal query is case-insensitive and matches any run
 * of whitespace where it has one; a regular expression is compiled with the
 * `gimu` flags.
 * @param {string} query - user query, already length-checked.
 * @param {boolean} regex - whether the query is a regular expression.
 * @returns {RegExp} global matcher.
 * @throws {SyntaxError} when a regular expression is invalid.
 */
export function compileQuery(query, regex) {
  if (regex) return new RegExp(query, 'gimu')
  const words = query.trim().split(/\s+/u).filter(Boolean).map(word => word.replace(SPECIAL, '\\$&'))
  return new RegExp(words.join('\\s+'), 'giu')
}

/**
 * Find every match, grouped by message.
 * @param {ReturnType<typeof conversationDocuments>} documents - searchable messages.
 * @param {RegExp} matcher - global matcher from {@link compileQuery}.
 * @param {{ maxResults: number, snippetsPerMessage: number, contextBefore: number, contextAfter: number, maxMatchChars: number }} limits - result bounds.
 * @returns {{ results: object[], totalMessages: number, totalMatches: number, truncated: boolean }} matches.
 */
export function findMatches(documents, matcher, limits) {
  const results = []
  let totalMessages = 0
  let totalMatches = 0
  for (const document of documents) {
    const { text } = document
    const snippets = []
    let count = 0
    matcher.lastIndex = 0
    let match
    while ((match = matcher.exec(text)) !== null) {
      if (match[0].length === 0) {
        // Zero-length matches carry no text to show; step past them.
        matcher.lastIndex += 1
        if (matcher.lastIndex > text.length) break
        continue
      }
      count += 1
      if (snippets.length < limits.snippetsPerMessage) snippets.push(snippet(text, match.index, match.index + match[0].length, limits))
    }
    if (count === 0) continue
    totalMessages += 1
    totalMatches += count
    if (results.length < limits.maxResults) {
      results.push({ seq: document.seq, time: document.time, turn: document.turn, role: document.role, count, snippets })
    }
  }
  return { results, totalMessages, totalMatches, truncated: totalMessages > results.length }
}

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
