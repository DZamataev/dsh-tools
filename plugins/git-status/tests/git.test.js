import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNotRepository, parseDuKilobytes, parseLastCommit, parseStatusV2 } from '../git.js'

const z = records => records.join('\0') + '\0'

test('parses branch, upstream, and every change kind', () => {
  const out = z([
    '# branch.oid 413cead350aa',
    '# branch.head feat/x',
    '# branch.upstream origin/feat/x',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a file.js',
    '1 A. N... 000000 100644 100644 000 ccc new.js',
    '1 MM N... 100644 100644 100644 ddd eee both.js',
    '2 R. N... 100644 100644 100644 fff fff R100 renamed.js',
    'old name.js',
    'u UU N... 100644 100644 100644 100644 111 222 333 conflict.js',
    '? untracked dir/',
  ])
  const s = parseStatusV2(out, 10)
  assert.equal(s.branch, 'feat/x')
  assert.equal(s.detached, false)
  assert.equal(s.oid, '413cead350aa')
  assert.equal(s.upstream, 'origin/feat/x')
  assert.deepEqual([s.ahead, s.behind], [2, 1])
  assert.deepEqual([s.staged, s.unstaged, s.untracked, s.conflicted, s.total], [3, 2, 1, 1, 6])
  assert.deepEqual(s.lines, [
    { xy: ' M', path: 'src/a file.js', orig: null },
    { xy: 'A ', path: 'new.js', orig: null },
    { xy: 'MM', path: 'both.js', orig: null },
    { xy: 'R ', path: 'renamed.js', orig: 'old name.js' },
    { xy: 'UU', path: 'conflict.js', orig: null },
    { xy: '??', path: 'untracked dir/', orig: null },
  ])
  assert.equal(s.truncated, false)
})

test('detached and unborn heads', () => {
  const detached = parseStatusV2(z(['# branch.oid abcdef1234', '# branch.head (detached)']), 5)
  assert.deepEqual([detached.branch, detached.detached, detached.oid, detached.upstream, detached.ahead], [null, true, 'abcdef1234', null, null])
  const unborn = parseStatusV2(z(['# branch.oid (initial)', '# branch.head main']), 5)
  assert.deepEqual([unborn.branch, unborn.oid, unborn.total], ['main', null, 0])
})

test('keeps counting past the line limit', () => {
  const s = parseStatusV2(z(['# branch.head main', '? a', '? b', '? c']), 2)
  assert.equal(s.total, 3)
  assert.equal(s.untracked, 3)
  assert.deepEqual(s.lines.map(line => line.path), ['a', 'b'])
  assert.equal(s.truncated, true)
})

test('last commit, du, and repository detection', () => {
  assert.deepEqual(parseLastCommit('413cead\x1ffeat: x · y\x1f1700000000\x1fDenis Z\x1fd@z.dev\n'), { sha: '413cead', subject: 'feat: x · y', time: 1_700_000_000_000, author: 'Denis Z', email: 'd@z.dev' })
  assert.deepEqual(parseLastCommit('abc\x1fold format\x1f1\n'), { sha: 'abc', subject: 'old format', time: 1000, author: '', email: '' })
  assert.equal(parseLastCommit(''), null)
  assert.equal(parseDuKilobytes('1234\t/Users/me/dir\n'), 1234 * 1024)
  assert.equal(parseDuKilobytes('du: cannot read'), null)
  assert.equal(isNotRepository('fatal: not a git repository (or any of the parent directories): .git'), true)
  assert.equal(isNotRepository('fatal: bad object'), false)
})
