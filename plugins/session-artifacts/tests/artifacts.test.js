import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EXCLUDE_SEGMENTS,
  DEFAULT_EXTENSIONS,
  DEFAULT_PATCH_TOOLS,
  collectArtifacts,
  extensionKinds,
  extractMentions,
  kindOfPath,
  parsePatchHeaders,
  pathFields,
  planEntry,
  relativeTo,
} from '../artifacts.js'

const CWD = '/repo'
const HOME = '/home/test'
const TIME = 1_700_000_000_000
const CONFIG = {
  extensions: DEFAULT_EXTENSIONS,
  includeMentions: true,
  maxPlanChars: 200_000,
  maxMentionScanChars: 2_000_000,
  maxMentionCandidates: 300,
  patchTools: DEFAULT_PATCH_TOOLS,
  excludeSegments: DEFAULT_EXCLUDE_SEGMENTS,
}

const config = overrides => ({ ...CONFIG, ...overrides })
const event = (seq, type, data) => ({ type, seq, time: TIME + seq, data })
const call = (seq, name, args, turn = 1) => event(seq, 'tool/call', { turn, step: 1, callId: `call-${seq}`, name, arguments: JSON.stringify(args) })
const result = (seq, callSeq, { isError = false, code = undefined, text = '' } = {}) => event(seq, 'tool/result', {
  turn: 1,
  step: 1,
  message: { role: 'tool', toolCallId: `call-${callSeq}`, isError, content: text === '' ? [] : [{ type: 'text', text }] },
  ...code === undefined ? {} : { error: { name: 'ToolError', code } },
})
const presented = (seq, files, turn = 1) => event(seq, 'deliverables/presented', { turn, callId: `present-${seq}`, files })
const assistant = (seq, text, turn = 1) => event(seq, 'assistant/message', {
  turn,
  step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
const collect = (events, overrides = {}, options = {}) => collectArtifacts(events, { cwd: CWD, home: HOME, config: config(overrides), ...options })

test('write creates and edit edits, resolved against the Session cwd', () => {
  const { artifacts, cwd } = collect([
    call(1, 'write', { file_path: 'docs/a.md', content: '# a' }),
    result(2, 1),
    call(3, 'edit', { file_path: '/repo/docs/a.md', old_string: 'a', new_string: 'b' }),
    result(4, 3),
    call(5, 'write', { file_path: '/repo/notes/b.txt', content: '' }),
    result(6, 5),
  ])
  assert.equal(cwd, CWD)
  assert.deepEqual(artifacts.map(artifact => artifact.path), ['/repo/notes/b.txt', '/repo/docs/a.md'])
  assert.deepEqual(artifacts[1], {
    path: '/repo/docs/a.md',
    relPath: 'docs/a.md',
    name: 'a.md',
    ext: 'md',
    kind: 'markdown',
    sources: ['write', 'edit'],
    created: true,
    deleted: false,
    description: null,
    ops: 2,
    firstSeq: 1,
    lastSeq: 3,
    firstTime: TIME + 1,
    lastTime: TIME + 3,
    turns: [1],
  })
  const written = artifacts[0]
  assert.deepEqual([written.kind, written.sources, written.created, written.ops], ['text', ['write'], true, 1])
})

test('a failed or denied tool result drops its call, a call without a result counts', () => {
  const { artifacts } = collect([
    call(1, 'write', { file_path: '/repo/denied.md' }),
    result(2, 1, { isError: true, code: 'FS_SANDBOX_DENIED' }),
    call(3, 'write', { file_path: '/repo/failed.md' }),
    result(4, 3, { isError: true }),
    call(5, 'write', { file_path: '/repo/running.md' }),
  ])
  assert.deepEqual(artifacts.map(artifact => artifact.path), ['/repo/running.md'])
  assert.deepEqual([artifacts[0].sources, artifacts[0].created, artifacts[0].ops], [['write'], true, 1])
})

test('an interrupted turn outcome stays listed because the operation may have happened', () => {
  const { artifacts } = collect([
    call(1, 'write', { file_path: '/repo/maybe.md' }),
    result(2, 1, { isError: true, code: 'TOOL_OUTCOME_UNKNOWN' }),
    call(3, 'write', { file_path: '/repo/never.md' }),
    result(4, 3, { isError: true, code: 'TOOL_NOT_STARTED' }),
  ])
  assert.deepEqual(artifacts.map(artifact => artifact.path), ['/repo/maybe.md'])
})

test('str_replace_editor maps create to write, edits to edit, and ignores view', () => {
  const { artifacts } = collect([
    call(1, 'str_replace_editor', { command: 'create', path: '/repo/notes/new.md', file_text: 'x' }),
    call(2, 'str_replace_editor', { command: 'view', path: '/repo/notes/ignored.md' }),
    call(3, 'str_replace_editor', { command: 'str_replace', path: '/repo/notes/new.md', old_str: 'x', new_str: 'y' }),
    call(4, 'str_replace_editor', { command: 'insert', path: '/repo/notes/inserted.md', insert_line: 1, new_str: 'z' }),
    call(5, 'str_replace_editor', { command: 'undo_edit', path: '/repo/notes/new.md' }),
  ])
  assert.deepEqual(artifacts.map(artifact => [artifact.name, artifact.sources, artifact.created, artifact.ops]), [
    ['new.md', ['write', 'edit'], true, 3],
    ['inserted.md', ['edit'], false, 1],
  ])
  assert.equal(artifacts.some(artifact => artifact.name === 'ignored.md'), false)
})

test('apply_patch headers count only inside a closed envelope', () => {
  const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
  const { artifacts } = collect([
    call(1, 'apply_patch', { input: patch('*** Add File: /repo/a.md', '+x') }),
    call(2, 'apply_patch', { patch: patch('*** Update File: /repo/a.md', '*** Move to: /repo/b.md') }),
    call(3, 'apply_patch', { input: patch('*** Delete File: /repo/c.txt') }),
    call(4, 'apply_patch', { input: '*** Add File: /repo/unclosed.md' }),
    call(5, 'bash', { command: patch('*** Add File: /repo/heredoc.md', '+x') }),
    call(6, 'write', { file_path: '/repo/real.md', content: patch('*** Add File: /repo/phantom.md') }),
  ])
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]))
  assert.deepEqual([...byName.keys()].sort(), ['a.md', 'b.md', 'c.txt', 'heredoc.md', 'real.md'])

  const a = byName.get('a.md')
  assert.deepEqual([a.sources, a.created, a.deleted, a.ops], [['patch'], true, true, 3])
  const b = byName.get('b.md')
  assert.deepEqual([b.sources, b.created, b.deleted, b.ops], [['patch'], false, false, 1])
  const c = byName.get('c.txt')
  assert.deepEqual([c.created, c.deleted, c.ops], [false, true, 1])
  assert.deepEqual([byName.get('heredoc.md').sources, byName.get('heredoc.md').created], [['patch'], true])
  assert.equal(byName.get('unclosed.md'), undefined)
  assert.equal(byName.get('phantom.md'), undefined)
})

test('parsePatchHeaders reports move sources and ignores unclosed envelopes', () => {
  assert.deepEqual(parsePatchHeaders([
    '*** Begin Patch',
    '*** Update File: a.md',
    '*** Move to: b.md',
    '*** Add File: c.md',
    '*** Delete File: d.md',
    '*** End Patch',
  ].join('\n')), [
    { op: 'edit', path: 'a.md' },
    { op: 'move', path: 'b.md', from: 'a.md' },
    { op: 'create', path: 'c.md' },
    { op: 'delete', path: 'd.md' },
  ])
  assert.deepEqual(parsePatchHeaders('*** Add File: a.md'), [])
  assert.deepEqual(parsePatchHeaders('*** Update File: a.md\n*** Move to: b.md'), [])
})

test('patchTools decides which tool arguments carry a patch', () => {
  const patch = '*** Begin Patch\n*** Add File: /repo/x.md\n*** End Patch'
  const coded = ['*** Begin Patch', '*** Add File: /repo/coded.md', '*** End Patch'].join('\n')
  const events = [
    call(1, 'apply_patch', { input: patch }),
    call(2, 'edit', { file_path: '/repo/y.md', old_string: 'a', new_string: patch }),
    call(3, 'run_code', { code: coded }),
  ]
  const byName = new Map(collect(events).artifacts.map(artifact => [artifact.name, artifact]))
  assert.deepEqual(byName.get('y.md').sources, ['edit'])
  assert.deepEqual([byName.get('x.md').sources, byName.get('x.md').ops], [['patch'], 1])
  assert.deepEqual([byName.get('coded.md').sources, byName.get('coded.md').ops], [['patch'], 1])
  const custom = new Map(collect(events, { patchTools: ['edit'] }).artifacts.map(artifact => [artifact.name, artifact]))
  // Only the edit's own argument text is scanned then: its patch names x.md, and no other tool counts.
  assert.deepEqual([custom.get('x.md').sources, custom.get('x.md').ops], [['patch'], 1])
  assert.deepEqual(custom.get('y.md').sources, ['edit'])
  assert.equal(custom.get('coded.md'), undefined)
})

test('a run_code parent does not count the patch its dispatch applied', () => {
  const patch = '*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch'
  const code = `await tools.apply_patch({ input:\n\`\n${patch}\n\`})`
  const dispatch = (seq, subCallId, extra = {}) => event(seq, 'tool/ptc-dispatch-start', {
    subCallId,
    name: 'apply_patch',
    arguments: { input: patch },
    ...extra,
  })
  const events = (...extra) => [
    call(1, 'run_code', { code }),
    dispatch(2, 's1', extra[0]),
    event(3, 'tool/ptc-dispatch', { subCallId: 's1', name: 'apply_patch', arguments: { input: patch }, isError: false, content: [] }),
    result(4, 1),
  ]
  const withoutParent = collect(events()).artifacts
  assert.deepEqual(withoutParent.map(artifact => [artifact.path, artifact.ops, artifact.created]), [['/repo/notes.md', 1, true]])
  const withParent = collect(events({ parentCallId: 'call-1' })).artifacts
  assert.deepEqual(withParent.map(artifact => [artifact.path, artifact.ops]), [['/repo/notes.md', 1]])
  // Without any dispatch, the run_code arguments are the only record of the operation.
  const direct = collect([call(1, 'run_code', { code })]).artifacts
  assert.deepEqual(direct.map(artifact => [artifact.path, artifact.ops]), [['/repo/notes.md', 1]])
})

test('present keeps the latest description and marks the source', () => {
  const { artifacts } = collect([
    presented(1, [{ path: '/repo/a.md', description: 'first' }]),
    presented(2, [{ path: '/repo/a.md', description: 'second' }]),
    presented(3, [{ path: '/repo/b.md' }]),
    presented(4, [{ path: '/repo/a.md' }]),
  ])
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]))
  assert.deepEqual([byName.get('a.md').description, byName.get('a.md').sources, byName.get('a.md').ops], ['second', ['present'], 0])
  assert.deepEqual([byName.get('b.md').description, byName.get('b.md').created], [null, false])
})

test('mentions cover absolute, relative, markdown-link, and backticked paths and drop non-documents', () => {
  const { artifacts } = collect([
    assistant(1, 'Saved /repo/docs/abs.md, docs/rel.md, [link](docs/link.md), and `docs/tick.md`; '
      + 'also docs/ignored.exe, https://example.dev/doc.md, and note:README.md.'),
  ])
  assert.deepEqual(artifacts.map(artifact => artifact.relPath), ['docs/abs.md', 'docs/rel.md', 'docs/link.md', 'docs/tick.md'])
  for (const artifact of artifacts) {
    assert.deepEqual([artifact.sources, artifact.ops, artifact.created], [['mention'], 0, false])
  }
})

test('mention extraction covers the reviewed path forms', () => {
  const kinds = extensionKinds(DEFAULT_EXTENSIONS)
  const cases = [
    ['[spec](docs/spec.md "Title")', ['docs/spec.md']],
    ["[spec](docs/spec.md 'Title')", ['docs/spec.md']],
    ['[spec](<docs/my spec.md>)', ['docs/my spec.md']],
    ['[spec](<docs/my spec.md> "T")', ['docs/my spec.md']],
    ['[x](docs/a.md#L24) and [y](docs/b.md#L24-L30)', ['docs/a.md', 'docs/b.md']],
    ['[a (draft)](docs/a.md)', ['docs/a.md']],
    ['see C:\\Users\\me\\doc.md and C:/x/y.md', ['C:\\Users\\me\\doc.md', 'C:/x/y.md']],
    ['Wrote docs/a.md.', ['docs/a.md']],
    ['Wrote (docs/a.md).', ['docs/a.md']],
    ['"docs/q.md",', ['docs/q.md']],
    ['files: docs/a.md, docs/b.md; docs/c.md!', ['docs/a.md', 'docs/b.md', 'docs/c.md']],
    ['a/b.md:12:3 and a/c.md:L12', ['a/b.md', 'a/c.md']],
    ['/repo/docs/a.md#L4:5', ['/repo/docs/a.md']],
    ['[link](https://x.dev/a.md)', []],
    ['file:///Users/x/a.md', []],
    ['**docs/bold.md**', ['docs/bold.md']],
    ['_docs/it.md_', ['docs/it.md']],
    ['~~docs/strike.md~~', ['docs/strike.md']],
    ['`/abs/with space.md`', ['/abs/with space.md']],
    ['path ~/notes/a.md', ['~/notes/a.md']],
    ['`npm run build` then open `dist/index.html`', ['dist/index.html']],
    ['React.md is not a file; Node.js docs; e.g. index.html', ['React.md', 'index.html']],
    ['a.MD and B.Pdf', ['a.MD', 'B.Pdf']],
  ]
  for (const [text, expected] of cases) {
    assert.deepEqual(extractMentions(text, kinds), expected, text)
  }
})

test('a mention candidate keeps a # or : that precedes the extension', () => {
  const kinds = extensionKinds(DEFAULT_EXTENSIONS)
  assert.deepEqual(extractMentions('C:/x#y/a.md and docs/a.md#L2', kinds), ['C:/x#y/a.md', 'docs/a.md'])
})

test('~/ expands to the home directory when resolving', () => {
  const { artifacts } = collect([call(1, 'write', { file_path: '~/notes/a.md' })])
  assert.deepEqual(artifacts.map(artifact => [artifact.path, artifact.relPath]), [['/home/test/notes/a.md', null]])
})

test('mentions count as touching a file without adding operations, and lastSeq follows operations', () => {
  const { artifacts } = collect([
    call(1, 'write', { file_path: '/repo/a.md' }),
    result(2, 1),
    assistant(3, 'see /repo/a.md'),
  ])
  assert.deepEqual([artifacts[0].sources, artifacts[0].ops, artifacts[0].firstSeq, artifacts[0].lastSeq], [['write', 'mention'], 1, 1, 1])
  assert.deepEqual([artifacts[0].lastTime], [TIME + 1])
  const mentioned = collect([assistant(5, 'see /repo/b.md')]).artifacts[0]
  assert.deepEqual([mentioned.lastSeq, mentioned.lastTime], [5, TIME + 5])
})

test('assistant text is scanned newest-first within maxMentionScanChars', () => {
  const { artifacts } = collect([
    assistant(1, 'old docs/old.md'),
    assistant(2, 'new docs/new.md'),
  ], { maxMentionScanChars: 16 })
  assert.deepEqual(artifacts.map(artifact => artifact.relPath), ['docs/new.md'])
})

test('includeMentions false leaves assistant text unscanned', () => {
  const { artifacts } = collect([assistant(1, 'see /repo/a.md')], { includeMentions: false })
  assert.deepEqual(artifacts, [])
})

test('mention-only entries are cut to the newest maxMentionCandidates', () => {
  const { artifacts } = collect([
    assistant(1, 'docs/one.md'),
    assistant(2, 'docs/two.md'),
    assistant(3, 'docs/three.md'),
    assistant(4, 'docs/four.md'),
  ], { maxMentionCandidates: 2 })
  assert.deepEqual(artifacts.map(artifact => artifact.name), ['four.md', 'three.md'])
})

test('only configured document extensions are listed, and excluded segments are skipped', () => {
  const { artifacts } = collect([
    call(1, 'write', { file_path: '/repo/scripts/build.sh' }),
    call(2, 'write', { file_path: '/repo/node_modules/pkg/README.md' }),
    call(3, 'write', { file_path: '/repo/.git/notes.md' }),
    call(4, 'write', { file_path: '/repo/README' }),
    call(5, 'write', { file_path: '/repo/output.bin' }),
    call(6, 'write', { file_path: '/repo/vendor/lib.md' }),
    call(7, 'write', { file_path: '/repo/ok.md' }),
  ])
  assert.deepEqual(artifacts.map(artifact => artifact.path), ['/repo/ok.md', '/repo/vendor/lib.md'])
  const excluded = collect([
    call(1, 'write', { file_path: '/repo/vendor/lib.md' }),
    call(2, 'write', { file_path: '/repo/ok.md' }),
  ], { excludeSegments: ['vendor'] })
  assert.deepEqual(excluded.artifacts.map(artifact => artifact.name), ['ok.md'])
})

test('extensions config decides which paths count', () => {
  const { artifacts } = collect([
    call(1, 'write', { file_path: '/repo/build.sh' }),
    call(2, 'write', { file_path: '/repo/page.md' }),
  ], { extensions: { text: ['sh'] } })
  assert.deepEqual(artifacts.map(artifact => [artifact.name, artifact.kind]), [['build.sh', 'text']])
})

test('kindOfPath, pathFields, extensionKinds, and relativeTo follow the configured map', () => {
  const kinds = extensionKinds({ markdown: ['md'], data: ['csv'] })
  assert.equal(kinds.get('md'), 'markdown')
  assert.equal(kindOfPath('/repo/a.md', kinds), 'markdown')
  assert.equal(kindOfPath('/repo/a.CSV', kinds), 'data')
  assert.equal(kindOfPath('/repo/a.bin', kinds), null)
  assert.equal(kindOfPath('/repo/README', kinds), null)
  assert.deepEqual(pathFields('/repo/docs/a.MD', kinds), { name: 'a.MD', ext: 'md', kind: 'markdown' })
  assert.equal(relativeTo('/repo', '/repo/a.md'), 'a.md')
  assert.equal(relativeTo('/repo', '/other/a.md'), null)
  assert.equal(relativeTo(null, '/repo/a.md'), null)
})

test('a working-directory/change moves later resolutions and relPath', () => {
  const { artifacts, cwd } = collect([
    call(1, 'write', { file_path: 'before.md' }),
    event(2, 'working-directory/change', { cwd: '/repo/sub' }),
    call(3, 'write', { file_path: 'after.md' }),
    assistant(4, 'see relative.md'),
    event(5, 'working-directory/change', { cwd: '/repo' }),
    call(6, 'write', { file_path: 'final.md' }),
  ])
  assert.equal(cwd, '/repo')
  // The mention resolves against the directory in force at its own seq.
  assert.deepEqual(artifacts.map(artifact => [artifact.path, artifact.relPath]), [
    ['/repo/final.md', 'final.md'],
    ['/repo/sub/relative.md', 'sub/relative.md'],
    ['/repo/sub/after.md', 'sub/after.md'],
    ['/repo/before.md', 'before.md'],
  ])
})

test('relative paths without a Session cwd are dropped, absolute ones stay', () => {
  const { artifacts, cwd } = collect([
    call(1, 'write', { file_path: 'relative.md' }),
    call(2, 'write', { file_path: '/repo/absolute.md' }),
  ], {}, { cwd: null })
  assert.equal(cwd, null)
  assert.deepEqual(artifacts.map(artifact => [artifact.path, artifact.relPath]), [['/repo/absolute.md', null]])
})

test('entries sort by lastSeq descending', () => {
  const { artifacts } = collect([
    call(1, 'write', { file_path: '/repo/first.md' }),
    call(3, 'write', { file_path: '/repo/second.md' }),
    call(5, 'write', { file_path: '/repo/third.md' }),
    assistant(7, 'see /repo/first.md'),
  ])
  assert.deepEqual(artifacts.map(artifact => artifact.name), ['third.md', 'second.md', 'first.md'])
  assert.equal(artifacts[2].lastSeq, 1)
})

test('plans keep log order with an approved, rejected, pending, or dismissed review', () => {
  const dismissed = 'The user dismissed the plan review to reply in their own words; plan mode remains active.'
  const { plans } = collect([
    call(1, 'exit_plan_mode', { plan: '# Plan A\n\nbody' }, 2),
    result(2, 1, { text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }),
    call(3, 'exit_plan_mode', { plan: '# Plan B' }, 3),
    result(4, 3, { isError: true, code: 'PLAN_MODE_INACTIVE' }),
    call(5, 'exit_plan_mode', { plan: '# Plan C' }, 3),
    call(6, 'exit_plan_mode', { plan: '# Plan D' }, 4),
    result(7, 6, { text: dismissed }),
  ])
  assert.deepEqual(plans.map(plan => [plan.seq, plan.turn, plan.status, plan.title]), [
    [1, 2, 'approved', 'Plan A'],
    [3, 3, 'rejected', 'Plan B'],
    [5, 3, 'pending', 'Plan C'],
    [6, 4, 'rejected', 'Plan D'],
  ])
  assert.deepEqual(plans[0], {
    seq: 1,
    time: TIME + 1,
    turn: 2,
    status: 'approved',
    title: 'Plan A',
    text: '# Plan A\n\nbody',
    truncated: false,
  })
})

test('plans report an unknown outcome as pending', () => {
  const { plans } = collect([
    call(1, 'exit_plan_mode', { plan: '# Unknown' }),
    result(2, 1, { isError: true, code: 'TOOL_OUTCOME_UNKNOWN' }),
  ])
  assert.deepEqual([plans.length, plans[0].status], [1, 'pending'])
})

test('planEntry truncates the text and titles the kept part, capped', () => {
  const cut = planEntry(`# ${'x'.repeat(1_000)}\n${'y'.repeat(1_000)}`, { seq: 1, time: 2, turn: 1, maxPlanChars: 40, status: 'pending' })
  assert.equal(cut.text.length, 40)
  assert.equal(cut.truncated, true)
  assert.equal(cut.title, 'x'.repeat(38))

  const long = planEntry(`# ${'z'.repeat(1_000)}`, { seq: 1, time: 1, turn: null, maxPlanChars: 5_000, status: 'approved' })
  assert.equal(long.title.length, 200)
  assert.equal(planEntry('   \n\n', { seq: 1, time: 1, turn: 1, maxPlanChars: 10, status: 'pending' }), null)
  assert.equal(planEntry(42, { seq: 1, time: 1, turn: 1, maxPlanChars: 10, status: 'pending' }), null)
})

test('nested run_code dispatches follow the same tool rules', () => {
  const dispatch = (seq, subCallId, data) => event(seq, 'tool/ptc-dispatch', {
    rootCallId: 'root',
    parentCallId: 'parent',
    subCallId,
    content: [],
    ...data,
  })
  const start = (seq, subCallId, data) => event(seq, 'tool/ptc-dispatch-start', {
    rootCallId: 'root',
    parentCallId: 'parent',
    subCallId,
    ...data,
  })
  const { artifacts } = collect([
    start(1, 's1', { name: 'write', arguments: { file_path: '/repo/one.md' } }),
    dispatch(2, 's1', { name: 'write', arguments: { file_path: '/repo/one.md' }, isError: false }),
    start(3, 's2', { name: 'write', arguments: { file_path: '/repo/two.md' } }),
    dispatch(4, 's2', { name: 'write', arguments: { file_path: '/repo/two.md' }, isError: true }),
    start(5, 's3', { name: 'edit', arguments: { file_path: '/repo/three.md' } }),
  ])
  assert.deepEqual(artifacts.map(artifact => [artifact.name, artifact.sources, artifact.ops]), [
    ['three.md', ['edit'], 1],
    ['one.md', ['write'], 1],
  ])
})

test('a nested exit_plan_mode contributes a plan with its dispatch outcome', () => {
  const dispatch = (seq, subCallId, isError, content = []) => event(seq, 'tool/ptc-dispatch', {
    rootCallId: 'root',
    parentCallId: 'parent',
    subCallId,
    name: 'exit_plan_mode',
    arguments: { plan: '# Nested plan' },
    isError,
    content,
  })
  const start = (seq, subCallId) => event(seq, 'tool/ptc-dispatch-start', {
    rootCallId: 'root',
    parentCallId: 'parent',
    subCallId,
    name: 'exit_plan_mode',
    arguments: { plan: '# Nested plan' },
  })
  const { plans } = collect([
    start(1, 'p1'),
    dispatch(2, 'p1', false, [{ type: 'text', text: 'Plan approved — plan mode exited.' }]),
    start(3, 'p2'),
    dispatch(4, 'p2', true),
  ])
  assert.deepEqual(plans.map(plan => [plan.seq, plan.status, plan.title]), [
    [1, 'approved', 'Nested plan'],
    [3, 'rejected', 'Nested plan'],
  ])
})

test('a nested dispatch without a result is pending and counts as running', () => {
  const { plans, artifacts } = collect([
    event(1, 'tool/ptc-dispatch-start', {
      rootCallId: 'root',
      parentCallId: 'parent',
      subCallId: 'p1',
      name: 'exit_plan_mode',
      arguments: { plan: '# Pending plan' },
    }),
    event(2, 'tool/ptc-dispatch-start', {
      rootCallId: 'root',
      parentCallId: 'parent',
      subCallId: 'p2',
      name: 'write',
      arguments: { file_path: '/repo/from-code.md' },
    }),
  ])
  assert.deepEqual([plans.length, plans[0].status], [1, 'pending'])
  assert.deepEqual(artifacts.map(artifact => artifact.name), ['from-code.md'])
})

test('hostile text stays linear', () => {
  const kinds = extensionKinds(DEFAULT_EXTENSIONS)
  const budget = 100
  const run = (label, work) => {
    const started = performance.now()
    work()
    const elapsed = performance.now() - started
    assert.ok(elapsed < budget, `${label}: ${elapsed.toFixed(0)}ms`)
  }
  for (const [label, text] of [
    ['link with spaces and no close', '[a](' + ' '.repeat(100_000)],
    ['open brackets', '['.repeat(100_000)],
    ['single long token', 'a'.repeat(2_000_000)],
    ['backticks', '`'.repeat(100_000)],
    ['link starts without close', '[a](x '.repeat(20_000)],
  ]) {
    run(label, () => extractMentions(text, kinds))
  }
  run('unterminated patch line', () => parsePatchHeaders(`*** Begin Patch\n*** Add File: ${'a'.repeat(2_000_000)}\n*** End Patch`))
  run('long plan title', () => planEntry(`# ${'a'.repeat(2_000_000)}`, { seq: 1, time: 1, turn: 1, maxPlanChars: 2_000_000, status: 'pending' }))
})
