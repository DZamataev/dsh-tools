import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bootIdOf, deviceRows, devicesOf, planAction, projectName, sameBoot } from '../normalize.js'
import { Config } from '../index.js'

const raw = readFileSync(new URL('./fixtures/device-list.json', import.meta.url), 'utf8')
const worktrees = [
  { id: '192975ec-d9cf-4031-9144-de987e00797e', path: '/Users/frenzy/dev/rn-looky2' },
  { id: '804f7fca-cd1a-4ee9-8137-fa0ce7b72f87', path: '/Users/frenzy/dev/rn-looky' },
  { id: 'eceeae6a-e882-4a99-bb60-aa1af0e1d66c', path: '/Users/frenzy/dev/rn-looky3' },
]
const exists = path => path !== '/Users/frenzy/dev/rn-looky'
const rows = live => Object.fromEntries(deviceRows(devicesOf(raw), worktrees, live, exists).map(row => [row.alias, row]))

test('rows name the reserving project machine-wide, not relative to the tooling checkout', () => {
  const byAlias = rows(() => true)
  assert.equal(byAlias['текно'].state, 'reserved')
  assert.equal(byAlias['текно'].reservation.project, 'rn-looky')
  assert.equal(byAlias['текно'].reservation.gone, true)
  assert.equal(byAlias['айфон13'].state, 'free')
  assert.equal(byAlias['айфон13'].reservation, null)
  assert.equal(byAlias['iPhone Air'].reservation.project, 'rn-looky3')
  assert.equal(byAlias['iPhone Air'].virtual, true)
  assert.equal(byAlias['самсунг'].details, 'SM-S937B, Android 17')
})

test('a live lease makes the device busy with its app; an ended one stays visible as stale', () => {
  const busy = rows(() => true)['iPhone Air']
  assert.equal(busy.state, 'busy')
  assert.deepEqual([busy.lease.project, busy.lease.app, busy.lease.live], ['rn-looky3', 'looky', true])
  const ended = rows(() => false)['iPhone Air']
  assert.equal(ended.state, 'reserved')
  assert.equal(ended.lease.live, false)
})

test('a lease without a worktree id and a worktree missing from the registry are still reported', () => {
  const [row] = deviceRows([{ alias: 'x', platform: 'android', lease: { pid: 1 }, reservation: { worktreeId: 'deadbeef-0000' } }], worktrees, () => true, exists)
  assert.equal(row.state, 'busy')
  assert.equal(row.lease.worktreeId, null)
  assert.deepEqual([row.reservation.project, row.reservation.path, row.reservation.gone], ['deadbeef', null, true])
})

test('a failed envelope surfaces the tooling message', () => {
  assert.throws(() => devicesOf(JSON.stringify({ ok: false, error: { code: 'LEDGER_LOCKED', message: 'ledger is locked' } })), /ledger is locked/)
  assert.throws(() => devicesOf('Usage: …'), /no JSON envelope/)
})

test('boot ids compare with the tooling tolerance', () => {
  assert.equal(bootIdOf('{ sec = 1792685426, usec = 12 } Thu Oct  1 10:10:26 2026\n'), 'boot-1792685426')
  assert.ok(sameBoot('boot-1792685426', 'boot-1792685427'))
  assert.ok(!sameBoot('boot-1792685426', 'boot-1792685430'))
  assert.ok(!sameBoot(undefined, 'boot-1'))
  assert.equal(projectName('/Users/frenzy/dev/rn-looky3/'), 'rn-looky3')
})

test('config expands ~ and rejects relative paths and bad timeouts', () => {
  const { validate } = Config['~standard']
  assert.equal(validate({}).value.checkout, '')
  const ok = validate({ checkout: '~/dev/rn-looky3' })
  assert.ok(ok.value.checkout.endsWith('/dev/rn-looky3') && ok.value.checkout.startsWith('/'))
  assert.ok(ok.value.ledgerPath.endsWith('/.looky/ledger.json'))
  assert.ok(validate({ checkout: 'dev/rn-looky' }).issues)
  assert.ok(validate({ timeoutMs: 10 }).issues)
  assert.ok(validate([]).issues)
})

const usable = worktrees.map(item => ({ ...item, usable: exists(item.path) }))
const RN2 = '192975ec-d9cf-4031-9144-de987e00797e'
const RN3 = 'eceeae6a-e882-4a99-bb60-aa1af0e1d66c'
const plan = (request, live = () => true) => planAction(request, deviceRows(devicesOf(raw), worktrees, live, exists), usable)
const code = (fn) => { try { fn() } catch (error) { return error.code } return null }

test('reserving a free device runs reserve from the target project', () => {
  assert.deepEqual(plan({ action: 'reserve', alias: 'айфон13', worktreeId: RN2 }), {
    cwd: '/Users/frenzy/dev/rn-looky2', args: ['device', 'reserve', '--alias', 'айфон13'],
  })
})

test('taking over a held device needs force and then passes --force with the alias confirmation', () => {
  assert.equal(code(() => plan({ action: 'reserve', alias: 'самсунг', worktreeId: RN2 })), 'takeover-needed')
  assert.deepEqual(plan({ action: 'reserve', alias: 'самсунг', worktreeId: RN2, force: true }).args,
    ['device', 'reserve', '--alias', 'самсунг', '--force', '--confirmation', 'самсунг'])
  assert.equal(code(() => plan({ action: 'reserve', alias: 'iPhone Air', worktreeId: RN3 })), 'unchanged')
  assert.equal(code(() => plan({ action: 'reserve', alias: 'самсунг', worktreeId: RN2 }, () => false)), null)
})

test('releasing runs from the holder, or forced from another worktree when the holder is gone', () => {
  assert.deepEqual(plan({ action: 'unreserve', alias: 'iPhone Air' }), {
    cwd: '/Users/frenzy/dev/rn-looky3', args: ['device', 'unreserve', '--alias', 'iPhone Air'],
  })
  const gone = plan({ action: 'unreserve', alias: 'текно' })
  assert.notEqual(gone.cwd, '/Users/frenzy/dev/rn-looky')
  assert.deepEqual(gone.args.slice(-3), ['--force', '--confirmation', 'текно'])
  assert.deepEqual(plan({ action: 'unlease', alias: 'самсунг' }), {
    cwd: '/Users/frenzy/dev/rn-looky3', args: ['device', 'unlease', '--alias', 'самсунг'],
  })
})

test('requests the ledger cannot satisfy are refused before any command', () => {
  assert.equal(code(() => plan({ action: 'unlease', alias: 'айфон13' })), 'unchanged')
  assert.equal(code(() => plan({ action: 'reserve', alias: 'ghost', worktreeId: RN2 })), 'unknown-device')
  assert.equal(code(() => plan({ action: 'reserve', alias: 'айфон13', worktreeId: 'nope' })), 'unknown-worktree')
  assert.equal(code(() => plan({ action: 'rename', alias: 'айфон13' })), 'invalid')
})
