/**
 * Pure extraction for session-artifacts: the documents one Session log touched,
 * through which operation, plus the plans it presented.
 *
 * Nothing here reads the filesystem. Paths resolve with `node:path` against the
 * Session's effective working directory at the moment of the operation, and
 * mention candidates are returned for the caller to verify on disk — so the
 * whole extraction is unit-testable and the route owns `exists`/`size`/`mtime`.
 */

import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Document kinds and their extensions, the default of the `extensions` config.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DEFAULT_EXTENSIONS = Object.freeze({
  markdown: Object.freeze(['md', 'markdown', 'mdx']),
  text: Object.freeze(['txt', 'rst', 'adoc', 'org', 'log']),
  pdf: Object.freeze(['pdf']),
  html: Object.freeze(['html', 'htm']),
  office: Object.freeze(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf']),
  data: Object.freeze(['csv', 'tsv']),
  image: Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']),
})

/**
 * Tools whose arguments may carry an apply_patch programme, the default of the
 * `patchTools` config. `bash` and `run_code` are included because a patch is
 * often applied through a shell heredoc or a code run rather than a dedicated tool.
 * @type {readonly string[]}
 */
export const DEFAULT_PATCH_TOOLS = Object.freeze(['apply_patch', 'bash', 'run_code'])

/**
 * Path segments no listing covers, the default of the `excludeSegments` config.
 * @type {readonly string[]}
 */
export const DEFAULT_EXCLUDE_SEGMENTS = Object.freeze(['node_modules', '.git'])

/** `str_replace_editor` commands that change a file; `view` only reads it. */
const EDITOR_EDITS = new Set(['str_replace', 'insert', 'undo_edit'])

const PATCH_BEGIN = /^\*\*\* Begin Patch[ \t]*$/
const PATCH_END = /^\*\*\* End Patch[ \t]*$/
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File:[ \t]*(.+?)[ \t]*$/
const PATCH_MOVE = /^\*\*\* Move to:[ \t]*(.+?)[ \t]*$/
const PATCH_OPS = { Add: 'create', Update: 'edit', Delete: 'delete' }

/**
 * A markdown link destination. Both halves are linear: the destination cannot
 * contain whitespace or parentheses outside `<…>`, and every backtracking step
 * either consumes a space or leaves the character class, so hostile text cannot
 * make the engine rescan a long run.
 */
const LINK_TARGET = /\]\([ \t]*(?:<([^<>\n]*)>|([^\s()<>]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/g
const BACKTICKED = /`([^`\n]+)`/g
const BARE_PATH = /[^\s`'"()[\]{}<>]+/g
const LEADING_NOISE = /^[`'"([{<*_]+/
const TRAILING_NOISE = /[`'")\]}>.,;:!?*_]+$/
const STRIKE_OPEN = /^~~+/
const STRIKE_CLOSE = /~~+$/
const URI = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|data|file|tel):|[a-z][a-z0-9+.-]+:(?![\\/]))/i

/** Recovery code of a tool call whose outcome a repaired interrupted turn could not record. */
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** Rendered result text of a dismissed plan review; the only durable signal that the plan was not approved. */
const PLAN_DISMISSED = 'The user dismissed the plan review'

/** Longest plan title kept. */
const MAX_PLAN_TITLE = 200

/**
 * Map every configured extension to its kind. The first kind claiming an
 * extension owns it, matching the order of the `extensions` object.
 * @param {Readonly<Record<string, readonly string[]>>} extensions - kind → extensions, lowercase without dots.
 * @returns {Map<string, string>} extension → kind.
 */
export function extensionKinds(extensions) {
  const kinds = new Map()
  for (const [kind, list] of Object.entries(extensions)) {
    for (const extension of list) {
      const normalized = extension.toLowerCase()
      if (!kinds.has(normalized)) kinds.set(normalized, kind)
    }
  }
  return kinds
}

/**
 * The kind a path is listed under.
 * @param {string} file - absolute or relative path.
 * @param {Map<string, string>} kinds - extension → kind, as built by {@link extensionKinds}.
 * @returns {string | null} the kind, or null when the extension is not a configured document extension.
 */
export function kindOfPath(file, kinds) {
  const extension = extensionOf(file)
  return extension === '' ? null : kinds.get(extension) ?? null
}

/**
 * The path-derived response fields of one listed document.
 * @param {string} file - absolute path.
 * @param {Map<string, string>} kinds - extension → kind, as built by {@link extensionKinds}.
 * @returns {{ name: string, ext: string, kind: string }} file name, lowercase extension without the dot, and kind.
 */
export function pathFields(file, kinds) {
  const ext = extensionOf(file)
  return { name: basename(file), ext, kind: kinds.get(ext) }
}

/**
 * The `relPath` of a file inside a directory, in `/` form.
 * @param {string | null} cwd - Session working directory, or null when unknown.
 * @param {string} file - absolute path.
 * @returns {string | null} the relative path, or null when the file lies outside `cwd`.
 */
export function relativeTo(cwd, file) {
  if (cwd === null) return null
  const relPath = relative(cwd, file)
  if (relPath === '' || relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) return null
  return relPath.split(sep).join('/')
}

/**
 * The apply_patch file headers of one `*** Begin Patch` … `*** End Patch`
 * envelope, in the order they appear. Headers outside an envelope and envelopes
 * that never close contribute nothing. `*** Move to:` names the destination of
 * a rename and reports `from` as the file header it follows, so the source can
 * be marked as moved away.
 * @param {string} text - tool argument text, already JSON-decoded.
 * @returns {{ op: 'create' | 'edit' | 'delete' | 'move', path: string, from?: string }[]} operations in line order.
 */
export function parsePatchHeaders(text) {
  const operations = []
  let pending = []
  let inside = false
  let source = null
  for (const line of text.split(/\r?\n/)) {
    if (PATCH_BEGIN.test(line)) {
      inside = true
      pending = []
      source = null
      continue
    }
    if (!inside) continue
    if (PATCH_END.test(line)) {
      operations.push(...pending)
      pending = []
      inside = false
      source = null
      continue
    }
    const file = PATCH_FILE.exec(line)
    if (file !== null) {
      const op = PATCH_OPS[file[1]]
      source = op === 'delete' ? null : file[2]
      pending.push({ op, path: file[2] })
      continue
    }
    const move = PATCH_MOVE.exec(line)
    if (move !== null && source !== null) pending.push({ op: 'move', path: move[1], from: source })
  }
  return operations
}

/**
 * Document paths mentioned in one assistant text block: markdown link targets,
 * backticked spans, and bare path-like tokens, deduplicated in first-seen
 * order. Only paths with a configured document extension survive, URL targets
 * are dropped, internal whitespace is allowed only where the text marked the
 * span as a path (links and backticks), and markdown emphasis, anchors, and
 * `:line:col` suffixes are stripped. The ranges already claimed by links and
 * backticks are blanked before the bare-token pass, so a token inside one is
 * not reported twice. Whether a candidate exists is the caller's decision, so a
 * false positive costs one `stat` call.
 * @param {string} text - assistant text block.
 * @param {Map<string, string>} kinds - extension → kind, as built by {@link extensionKinds}.
 * @returns {string[]} candidate paths, absolute or relative to the Session working directory, with `~/` kept.
 */
export function extractMentions(text, kinds) {
  const seen = new Set()
  const mentions = []
  const consider = (raw, allowSpaces) => {
    const candidate = cleanCandidate(raw, allowSpaces)
    if (candidate === null || seen.has(candidate)) return
    if (kindOfPath(candidate, kinds) === null) return
    seen.add(candidate)
    mentions.push(candidate)
  }
  const found = []
  for (const match of text.matchAll(LINK_TARGET)) {
    const destination = match[1] ?? match[2]
    if (destination !== undefined) found.push({ index: match.index, length: match[0].length, raw: destination, allowSpaces: true })
  }
  for (const match of text.matchAll(BACKTICKED)) {
    found.push({ index: match.index, length: match[0].length, raw: match[1], allowSpaces: true })
  }
  const bare = blankRanges(text, found)
  for (const match of bare.matchAll(BARE_PATH)) {
    found.push({ index: match.index, length: match[0].length, raw: match[0], allowSpaces: false })
  }
  found.sort((left, right) => left.index - right.index)
  for (const match of found) consider(match.raw, match.allowSpaces)
  return mentions
}

/**
 * One plan presented by `exit_plan_mode`.
 * @param {unknown} plan - the tool's `plan` argument.
 * @param {{ seq: number, time: number, turn: number | null, maxPlanChars: number, status: 'approved' | 'rejected' | 'pending' }} placement - where the call sits in the log, how much plan text to keep, and the review outcome.
 * @returns {{ seq: number, time: number, turn: number | null, status: string, title: string, text: string, truncated: boolean } | null} the plan, or null for blank text.
 */
export function planEntry(plan, { seq, time, turn, maxPlanChars, status }) {
  if (typeof plan !== 'string') return null
  const text = plan.slice(0, maxPlanChars)
  if (text.trim() === '') return null
  return {
    seq,
    time,
    turn: typeof turn === 'number' ? turn : null,
    status,
    title: planTitle(text),
    text,
    truncated: plan.length > maxPlanChars,
  }
}

/**
 * The documents and plans of one Session log.
 *
 * Sources are `write` (`write`, and `str_replace_editor create`), `edit`
 * (`edit`, and `str_replace` / `insert` / `undo_edit`), `patch` (apply_patch
 * headers inside a closed envelope, for `patchTools` only; a `run_code` parent
 * whose nested dispatches carry the patch is not scanned twice), `present`
 * (`deliverables/presented`), and `mention` (assistant text). Tool calls,
 * nested `run_code` dispatches, and their results follow the same rules; a call
 * whose result reports `isError: true` contributes no operation, except that an
 * interrupted turn's `TOOL_OUTCOME_UNKNOWN` outcome counts because the operation
 * may have happened. A call without a result yet counts.
 *
 * `working-directory/change` moves the directory later relative paths resolve
 * against, including `relPath`, which is relative to the last effective
 * directory. `~/` expands to `home`. Assistant text is scanned newest-first
 * within `maxMentionScanChars`, and mention-only entries are cut to the newest
 * `maxMentionCandidates`. `created` is true when the first operation created the
 * path (`write`, `str_replace_editor create`, or an `Add File` header), and
 * `deleted` when the last operation removed it (`Delete File`, or the source of
 * a move). `lastSeq` / `lastTime` are the last write/edit/patch operation when
 * the entry has one, otherwise its last present or mention, and entries sort by
 * that `lastSeq` descending. Plans keep log order; a plan's
 * `status` is `rejected` for a failed or dismissed review, `pending` without a
 * result, and `approved` otherwise.
 * @param {readonly { type: string, seq: number, time: number, data: any }[]} events - raw Session log events (the Session header is not one of them).
 * @param {{ cwd?: string | null, home?: string, config: { extensions: Readonly<Record<string, readonly string[]>>, includeMentions: boolean, maxPlanChars: number, maxMentionScanChars: number, maxMentionCandidates: number, patchTools: readonly string[], excludeSegments: readonly string[] } }} options - the Session's initial working directory, the directory `~/` expands to, and the validated config.
 * @returns {{ cwd: string | null, artifacts: object[], plans: object[] }} extraction result; the caller stats `artifacts`, drops missing mention-only entries, and cuts the list.
 */
export function collectArtifacts(events, { cwd = null, home = homedir(), config }) {
  const kinds = extensionKinds(config.extensions)
  const excluded = new Set(config.excludeSegments)
  const patchTools = new Set(config.patchTools)
  const { failed, planResults, dispatches, ptcParents } = scan(events)
  const records = new Map()
  const plans = []
  const mentionWork = []
  let effectiveCwd = typeof cwd === 'string' && cwd !== '' ? cwd : null
  let turn = null
  let order = 0

  /**
   * Record one operation, presentation, or mention against a file; a path that
   * is not a listable document, or a relative path with no working directory,
   * is skipped.
   */
  const note = (candidate, source, { seq, time, at, op = null, description = null, base = effectiveCwd }) => {
    const file = listablePath(candidate, base, kinds, excluded, home)
    if (file === null) return
    let record = records.get(file)
    if (record === undefined) {
      record = {
        path: file,
        sourceSeq: {},
        firstOp: null,
        lastOp: null,
        ops: 0,
        description: null,
        descriptionSeq: -1,
        firstSeq: seq,
        firstTime: time,
        lastTouchSeq: seq,
        lastTouchTime: time,
        lastOpSeq: 0,
        lastOpTime: 0,
        turns: [],
      }
      records.set(file, record)
    }
    record.sourceSeq[source] ??= seq
    if (op !== null) {
      record.ops += 1
      record.firstOp ??= op
      record.lastOp = op
      record.lastOpSeq = Math.max(record.lastOpSeq, seq)
      record.lastOpTime = Math.max(record.lastOpTime, time)
    }
    // A present without a description must not erase the last one given.
    if (typeof description === 'string' && description.trim() !== '' && seq > record.descriptionSeq) {
      record.description = description
      record.descriptionSeq = seq
    }
    record.firstSeq = Math.min(record.firstSeq, seq)
    record.firstTime = Math.min(record.firstTime, time)
    record.lastTouchSeq = Math.max(record.lastTouchSeq, seq)
    record.lastTouchTime = Math.max(record.lastTouchTime, time)
    if (typeof at === 'number' && !record.turns.includes(at)) record.turns.push(at)
  }

  /**
   * Record every operation one tool call or nested dispatch performed. A call
   * that dispatched the work itself (`run_code`) is not scanned for a patch
   * programme: its children's arguments are the operations that ran.
   */
  const applyTool = (name, args, { seq, time, at, scanPatch = true }) => {
    const filePath = args.value?.file_path
    const editorPath = args.value?.path
    if (name === 'write' && typeof filePath === 'string') {
      note(filePath, 'write', { seq, time, at, op: 'create' })
    } else if (name === 'edit' && typeof filePath === 'string') {
      note(filePath, 'edit', { seq, time, at, op: 'edit' })
    } else if (name === 'str_replace_editor' && typeof editorPath === 'string') {
      if (args.value.command === 'create') note(editorPath, 'write', { seq, time, at, op: 'create' })
      else if (EDITOR_EDITS.has(args.value.command)) note(editorPath, 'edit', { seq, time, at, op: 'edit' })
    }
    if (!scanPatch || !patchTools.has(name)) return
    for (const text of args.strings) {
      for (const header of parsePatchHeaders(text)) {
        if (header.op === 'move') {
          if (typeof header.from === 'string') note(header.from, 'patch', { seq, time, at, op: 'move-from' })
          note(header.path, 'patch', { seq, time, at, op: 'move-to' })
        } else {
          note(header.path, 'patch', { seq, time, at, op: header.op })
        }
      }
    }
  }

  /** Record one presented plan with the review outcome that is determinable from the log. */
  const collectPlan = (name, args, { seq, time, at, result }) => {
    if (name !== 'exit_plan_mode' || typeof args.value?.plan !== 'string') return
    const status = result === undefined ? 'pending' : planStatus(result)
    const entry = planEntry(args.value.plan, { seq, time, turn: at, maxPlanChars: config.maxPlanChars, status })
    if (entry !== null) plans.push(entry)
  }

  for (const event of events) {
    // The Session header line carries no seq; it reaches the caller as `header`.
    if (!Number.isSafeInteger(event.seq)) continue
    const seq = event.seq
    const time = typeof event.time === 'number' ? event.time : 0

    if (event.type === 'turn/start') {
      if (typeof event.data?.turn === 'number') turn = event.data.turn
      continue
    }
    if (event.type === 'working-directory/change') {
      if (typeof event.data?.cwd === 'string' && event.data.cwd !== '') effectiveCwd = event.data.cwd
      continue
    }
    if (event.type === 'tool/call') {
      const data = event.data
      const callId = typeof data?.callId === 'string' ? data.callId : null
      const isFailed = callId !== null && failed.has(callId)
      const args = argumentInfo(data?.arguments)
      const at = atOf(data, turn)
      if (!isFailed) applyTool(data?.name, args, { seq, time, at, scanPatch: callId === null || !ptcParents.has(callId) })
      const result = callId === null ? undefined : planResults.get(callId)
      collectPlan(data?.name, args, { seq, time, at, result: isFailed ? result ?? { isError: true } : result })
      continue
    }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const data = event.data
      const state = dispatches.get(data?.subCallId)
      // A started dispatch is processed through its start event, which carries the start time.
      if (event.type === 'tool/ptc-dispatch' && state?.started === true) continue
      const args = argumentInfo(data?.arguments)
      const at = atOf(data, turn)
      const result = state?.settled === true ? { isError: state.isError, code: state.code, text: state.text } : undefined
      const subCallId = data?.subCallId
      if (result?.isError !== true) {
        applyTool(data?.name, args, { seq, time, at, scanPatch: typeof subCallId !== 'string' || !ptcParents.has(subCallId) })
      }
      collectPlan(data?.name, args, { seq, time, at, result })
      continue
    }
    if (event.type === 'deliverables/presented') {
      const at = atOf(event.data, turn)
      for (const file of event.data?.files ?? []) {
        if (file === null || typeof file !== 'object') continue
        note(file.path, 'present', {
          seq,
          time,
          at,
          description: typeof file.description === 'string' ? file.description : null,
        })
      }
      continue
    }
    if (event.type === 'assistant/message' && config.includeMentions) {
      const at = atOf(event.data, turn)
      for (const text of textBlocks(event.data?.message?.content)) {
        mentionWork.push({ seq, time, at, order: order++, base: effectiveCwd, text })
      }
    }
  }

  // The most recent assistant text spends the scan budget first, then every
  // block is recorded in log order so `sources` keeps first-seen order.
  if (mentionWork.length > 0) {
    const newestFirst = [...mentionWork].sort((left, right) => right.seq - left.seq || right.order - left.order)
    const selected = []
    let budget = config.maxMentionScanChars
    for (const item of newestFirst) {
      if (budget <= 0) break
      const text = item.text.length <= budget ? item.text : item.text.slice(0, budget)
      budget -= text.length
      selected.push({ ...item, text })
    }
    selected.sort((left, right) => left.seq - right.seq || left.order - right.order)
    for (const item of selected) {
      for (const mention of extractMentions(item.text, kinds)) {
        note(mention, 'mention', { seq: item.seq, time: item.time, at: item.at, base: item.base })
      }
    }
  }

  // A mention is a guess until the file is found: bound how many guesses reach the stat pass.
  const mentionOnly = [...records.values()].filter((record) => {
    const sources = sourcesOf(record)
    return sources.length === 1 && sources[0] === 'mention'
  })
  if (mentionOnly.length > config.maxMentionCandidates) {
    mentionOnly.sort((left, right) => right.lastTouchSeq - left.lastTouchSeq)
    for (const record of mentionOnly.slice(config.maxMentionCandidates)) records.delete(record.path)
  }

  const artifacts = [...records.values()]
    .map(record => artifactOf(record, effectiveCwd, kinds))
    .sort((left, right) => right.lastSeq - left.lastSeq)

  return { cwd: effectiveCwd, artifacts, plans }
}

/**
 * The extension of a path as the config spells it: lowercase, without the dot.
 * @param {string} file - path or file name.
 * @returns {string} the extension, or '' when the name has none.
 */
function extensionOf(file) {
  const extension = extname(file)
  return extension === '' ? '' : extension.slice(1).toLowerCase()
}

/** Whether any segment of a path is excluded from the listing. */
function isExcludedPath(file, excluded) {
  return file.split(/[\\/]+/).some(segment => excluded.has(segment))
}

/** `~/` expanded to the home directory, other candidates unchanged. */
function expandHome(candidate, home) {
  if (candidate === '~') return home
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) return join(home, candidate.slice(2))
  return candidate
}

/**
 * The absolute path of a candidate, or null when it cannot be listed here:
 * no document extension, an excluded segment, or a relative path without a
 * working directory to resolve it against.
 */
function listablePath(candidate, base, kinds, excluded, home) {
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (trimmed === '') return null
  const expanded = expandHome(trimmed, home)
  const absolute = isAbsolute(expanded) ? resolve(expanded) : base === null ? null : resolve(base, expanded)
  if (absolute === null || kindOfPath(absolute, kinds) === null) return null
  return isExcludedPath(absolute, excluded) ? null : absolute
}

/** The sources of one entry, in the log order of their first occurrence. */
function sourcesOf(record) {
  return Object.keys(record.sourceSeq).sort((left, right) => record.sourceSeq[left] - record.sourceSeq[right])
}

/** The response entry of one recorded file, without filesystem state. */
function artifactOf(record, cwd, kinds) {
  return {
    path: record.path,
    relPath: relativeTo(cwd, record.path),
    ...pathFields(record.path, kinds),
    sources: sourcesOf(record),
    created: record.firstOp === 'create',
    deleted: record.lastOp === 'delete' || record.lastOp === 'move-from',
    description: record.description,
    ops: record.ops,
    firstSeq: record.firstSeq,
    lastSeq: record.ops > 0 ? record.lastOpSeq : record.lastTouchSeq,
    firstTime: record.firstTime,
    lastTime: record.ops > 0 ? record.lastOpTime : record.lastTouchTime,
    turns: record.turns,
  }
}

/** The turn a tool or message event belongs to. */
function atOf(data, turn) {
  return typeof data?.turn === 'number' ? data.turn : turn
}

/**
 * Failure, plan-review, and nested-dispatch facts a second pass needs.
 * @param {readonly { type: string, seq: number, time: number, data: any }[]} events - raw Session log events.
 * @returns {{ failed: Set<string>, planResults: Map<string, { isError: boolean, code: string | undefined, text: string }>, dispatches: Map<string, { started: boolean, settled: boolean, isError: boolean, code: string | undefined, text: string }> }} one-pass facts.
 */
function scan(events) {
  const failed = new Set()
  const planCalls = new Set()
  const planResults = new Map()
  const dispatches = new Map()
  const ptcParents = new Set()
  // Tool calls that have started but not settled, so a dispatch without a
  // `parentCallId` still names the call that is executing it.
  const openCalls = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      const callId = event.data?.callId
      if (typeof callId !== 'string') continue
      openCalls.push(callId)
      if (event.data?.name === 'exit_plan_mode') planCalls.add(callId)
      continue
    }
    if (event.type === 'tool/result') {
      const callId = callIdOf(event.data)
      if (callId === null) continue
      const open = openCalls.indexOf(callId)
      if (open !== -1) openCalls.splice(open, 1)
      const isError = event.data?.message?.isError === true
      const code = typeof event.data?.error?.code === 'string' ? event.data.error.code : undefined
      // An interrupted turn records "outcome unknown": the operation may have happened.
      if (isError && code !== TOOL_OUTCOME_UNKNOWN) failed.add(callId)
      // Only a plan outcome needs its rendered text; copying every tool result would retain the whole log.
      if (planCalls.has(callId)) planResults.set(callId, { isError, code, text: messageText(event.data?.message) })
      continue
    }
    if (event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') continue
    const subCallId = event.data?.subCallId
    if (typeof subCallId !== 'string') continue
    const parentCallId = event.data?.parentCallId
    const parent = typeof parentCallId === 'string' ? parentCallId : openCalls.at(-1)
    if (typeof parent === 'string') ptcParents.add(parent)
    const state = dispatches.get(subCallId) ?? { started: false, settled: false, isError: false, code: undefined, text: '' }
    if (event.type === 'tool/ptc-dispatch-start') {
      state.started = true
    } else {
      state.settled = true
      state.isError = event.data?.isError === true
      state.code = typeof event.data?.error?.code === 'string' ? event.data.error.code : undefined
      state.text = event.data?.name === 'exit_plan_mode' ? messageText({ content: event.data?.content }) : ''
    }
    dispatches.set(subCallId, state)
  }
  return { failed, planResults, dispatches, ptcParents }
}

/** The call id a `tool/result` payload names, or null. */
function callIdOf(data) {
  const callId = data?.message?.toolCallId ?? data?.message?.source?.callId
  return typeof callId === 'string' ? callId : null
}

/** The text of a message's content blocks, joined. */
function messageText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * The review outcome of one settled plan call. A dismissed review renders its
 * own sentence, which is the only durable record that the user did not approve.
 * @param {{ isError: boolean, code: string | undefined, text: string }} result - the settled call's outcome.
 * @returns {'approved' | 'rejected' | 'pending'} the outcome.
 */
function planStatus(result) {
  if (result.isError) return result.code === TOOL_OUTCOME_UNKNOWN ? 'pending' : 'rejected'
  return result.text.includes(PLAN_DISMISSED) ? 'rejected' : 'approved'
}

/** Text blocks of one message's content, verbatim. */
function textBlocks(content) {
  if (!Array.isArray(content)) return []
  const texts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      texts.push(block.text)
    }
  }
  return texts
}

/**
 * The parsed value of one tool argument payload and every string it carries, in
 * the order the patch scanner must read them. `tool/call` stores the raw JSON
 * string, a nested PTC dispatch stores the already-parsed value.
 * @param {unknown} raw - the call's `arguments` value.
 * @returns {{ value: any, strings: string[] }} the object value when the arguments parse to one, and their string leaves.
 */
function argumentInfo(raw) {
  if (typeof raw !== 'string') {
    if (raw === null || typeof raw !== 'object') return { value: null, strings: [] }
    return { value: Array.isArray(raw) ? null : raw, strings: stringLeaves(raw) }
  }
  try {
    const value = JSON.parse(raw)
    return {
      value: value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null,
      strings: stringLeaves(value),
    }
  } catch {
    // Arguments are JSON by contract; a malformed value is still scanned as literal text,
    // where a patch programme written with real newlines remains readable.
    return { value: null, strings: [raw] }
  }
}

/** Every string leaf of a parsed JSON value, in document order. */
function stringLeaves(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringLeaves)
  return []
}

/**
 * The text with the ranges already claimed by links and backticks replaced by
 * spaces, keeping every index, so the bare-token pass cannot re-report an inner
 * token of a path it already found.
 */
function blankRanges(text, ranges) {
  if (ranges.length === 0) return text
  const ordered = [...ranges].sort((left, right) => left.index - right.index)
  let masked = ''
  let cursor = 0
  for (const range of ordered) {
    const start = Math.max(range.index, cursor)
    const end = range.index + range.length
    if (end <= start) continue
    masked += text.slice(cursor, start) + ' '.repeat(end - start)
    cursor = end
  }
  return masked + text.slice(cursor)
}

/**
 * A mention candidate without surrounding markup, markdown emphasis, or a
 * trailing `#anchor` / `:line:col` suffix, or null when it is a URI or, for a
 * bare token, carries whitespace.
 */
function cleanCandidate(raw, allowSpaces) {
  if (typeof raw !== 'string') return null
  let candidate = raw.trim()
  if (candidate === '') return null
  candidate = candidate.replace(LEADING_NOISE, '').replace(TRAILING_NOISE, '')
  candidate = candidate.replace(STRIKE_OPEN, '').replace(STRIKE_CLOSE, '')
  candidate = stripSuffix(candidate)
  if (candidate === '') return null
  if (URI.test(candidate)) return null
  if (!allowSpaces && /\s/.test(candidate)) return null
  return candidate
}

/**
 * A candidate without a trailing anchor or line suffix. `#` and `:` count only
 * after the last dot, so a directory or name that contains one keeps it.
 */
function stripSuffix(candidate) {
  const dot = candidate.lastIndexOf('.')
  if (dot === -1) return candidate
  const hash = candidate.indexOf('#', dot)
  const colon = candidate.indexOf(':', dot)
  let cut = candidate.length
  if (hash !== -1) cut = Math.min(cut, hash)
  if (colon !== -1) cut = Math.min(cut, colon)
  return cut === candidate.length ? candidate : candidate.slice(0, cut)
}

/** The plan's first markdown heading, else its first non-blank line, capped. */
function planTitle(text) {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (heading !== null) return heading[1].slice(0, MAX_PLAN_TITLE)
  }
  const first = lines.find(line => line.trim() !== '')
  return (first === undefined ? '' : first.trim()).slice(0, MAX_PLAN_TITLE)
}
