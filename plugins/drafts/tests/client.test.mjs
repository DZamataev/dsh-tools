// Behavior test for client.js: loads the browser module through a stub
// window.__ModuleLoader__, applies it against stub Cordis services, and renders
// the registered component in jsdom with real React.
// Run: DSH_REPO=~/dev/deepseek-harness node --test tests/
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repo = process.env.DSH_REPO ?? `${process.env.HOME}/dev/deepseek-harness`
const pnpm = `${repo}/node_modules/.pnpm`
const req = createRequire(`${pnpm}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/package.json`)
const { JSDOM } = createRequire(`${pnpm}/jsdom@29.1.1_@noble+hashes@2.4.0/node_modules/jsdom/package.json`)('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'outside-only' })
const { window } = dom
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = req('react')
const ReactDOM = req('react-dom')
const { createRoot } = req('react-dom/client')
const { act } = React

function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    set(next) { snapshot = next; for (const fn of listeners) fn() },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

function hookOf(store) {
  return selector => React.useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
}

// ---- load the module -------------------------------------------------------

let definition
window.__ModuleLoader__ = { load(def) { definition = def } }
vm.runInContext(readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8'), dom.getInternalVMContext())
const plugin = definition.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
  throw new Error(`unexpected require ${name}`)
})

const dicts = {}
let registration
let Component
const opened = []
const archived = []
let archiveImpl = async () => {}
const ctx = {
  effect(fn) { fn() },
  locale: {
    register(ns, a, b) { if (typeof a === 'string') dicts[a] = b; else Object.assign(dicts, a); return () => {} },
    bind: () => key => key,
  },
  slots: {
    inject(_name, cb) { cb() },
    register(options, component) { registration = options; Component = component; return () => {} },
  },
  uiWorkspace: {
    openSession(id) { opened.push(id) },
    archiveSession(id) { archived.push(id); return archiveImpl(id) },
  },
}
plugin.apply(ctx)

const t = (key, params = {}) => dicts.ru[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))

// ---- fixtures --------------------------------------------------------------

const now = Date.now()
const sessionsStore = createSnapshotStore({
  phase: 'ready',
  ids: ['cur', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
  byId: {
    cur: { id: 'cur', blank: true, updatedAt: now, cwd: '/w1' },
    a: { id: 'a', blank: true, updatedAt: now - 5 * 60_000, cwd: '/w1' }, // object draft, same workspace
    b: { id: 'b', blank: true, updatedAt: now - 3 * 3600_000, cwd: '/w2' }, // legacy string draft, other workspace
    c: { id: 'c', blank: true, updatedAt: now, cwd: '/w1' }, // empty draft
    d: { id: 'd', blank: false, updatedAt: now, cwd: '/w1' }, // not blank
    e: { id: 'e', blank: true, updatedAt: now, cwd: '/w1' }, // archived
    f: { id: 'f', blank: true, updatedAt: now - 60_000, cwd: '/w1' }, // malformed JSON
    g: { id: 'g', blank: true, updatedAt: now - 2 * 86400_000, cwd: '/w3' }, // valid inline reference, default workspace
    h: { id: 'h', blank: true, updatedAt: now, cwd: '/w1' }, // references DSH rejects (missing fields)
    i: { id: 'i', blank: true, updatedAt: now, cwd: '/w1' }, // command token not at the start of the text
    j: { id: 'j', blank: true, updatedAt: now, cwd: '/w1' }, // reference span does not match the text
  },
  projectionsBySession: {},
})
const workspacesStore = createSnapshotStore({
  phase: 'ready',
  items: [
    { workspaceId: 'W1', title: 'one', path: '/w1', sessionIds: ['cur', 'a', 'c', 'd', 'e', 'f', 'h', 'i', 'j'] },
    { workspaceId: 'W2', title: 'two', path: '/w2', sessionIds: ['b'] },
    { workspaceId: 'W3', title: 'default-workspace', path: '/w3', sessionIds: ['g'] },
  ],
  archivedSessionIds: ['e'],
  pinnedSessionIds: [],
})

function seedStorage() {
  localStorage.clear()
  localStorage.setItem('dsh.conversation.cur', JSON.stringify({ draft: { text: 'current text', references: [] }, view: null, viewRequest: null }))
  localStorage.setItem('dsh.conversation.a', JSON.stringify({ draft: { text: '\n  Fix the login bug\nsecond line', references: [] }, view: null, viewRequest: null }))
  localStorage.setItem('dsh.conversation.b', JSON.stringify({ draft: 'legacy draft text', view: null, viewRequest: null }))
  localStorage.setItem('dsh.conversation.c', JSON.stringify({ draft: { text: '   ', references: [] }, view: null, viewRequest: null }))
  localStorage.setItem('dsh.conversation.d', JSON.stringify({ draft: 'sent already', view: null, viewRequest: null }))
  localStorage.setItem('dsh.conversation.e', JSON.stringify({ draft: 'archived one', view: null, viewRequest: null }))
  localStorage.setItem('dsh.conversation.f', '{not json')
  const readme = { source: 'file', ref: 'README.md', offset: 4, length: 10, label: 'README.md', clipboardText: '@README.md', appearance: 'file' }
  const store = draft => JSON.stringify({ draft, view: null, viewRequest: null })
  localStorage.setItem('dsh.conversation.g', store({ text: '/review See @README.md please', references: [{ ...readme, offset: 12 }], command: { token: '/review ' } }))
  localStorage.setItem('dsh.conversation.h', store({ text: 'Bad references', references: [{ source: 'file' }] }))
  localStorage.setItem('dsh.conversation.i', store({ text: 'hello /review', references: [], command: { token: '/review' } }))
  localStorage.setItem('dsh.conversation.j', store({ text: 'See @README.md', references: [{ ...readme, offset: 3 }] }))
}

async function render(sessionId = 'cur') {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const injected = registration.inject()
  const props = {
    sessionId,
    t,
    useSessions: hookOf(sessionsStore),
    useWorkspaces: hookOf(workspacesStore),
    useDraftsRev: hookOf(injected.hooks.draftsRev),
    refresh: injected.refresh,
    openSession: injected.openSession,
    archiveSession: injected.archiveSession,
  }
  await act(async () => { root.render(React.createElement(Component, props)) })
  return { container, root, unmount: () => act(() => root.unmount()) }
}

const click = async el => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const menu = () => document.querySelector('.dd-menu')

// ---- tests -----------------------------------------------------------------

after(() => { window.close() })

test('registers into conversation.hero.options with the three locales', () => {
  assert.equal(registration.name, 'conversation.hero.options')
  assert.equal(registration.locale, 'dsh-drafts')
  assert.equal(JSON.stringify(plugin.inject), JSON.stringify(['slots', 'locale', 'uiWorkspace']))
  assert.ok(dicts.en && dicts.zh && dicts.ru)
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.ru).sort())
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort())
})

test('lists only other unarchived blank Sessions with a non-empty draft, newest first', async () => {
  seedStorage()
  const view = await render()
  const trigger = view.container.querySelector('.dd-trigger')
  assert.equal(trigger.textContent, 'Черновики (3)')
  await click(trigger)
  const rows = [...menu().querySelectorAll('.dd-row')]
  assert.deepEqual(rows.map(row => row.querySelector('.dd-text').textContent), [
    'Fix the login bug',
    'legacy draft text',
    '/review See @README.md please',
  ])
  // Workspace shown only when it differs from the current one.
  assert.deepEqual(rows.map(row => row.querySelector('.dd-workspace')?.textContent ?? null), [null, 'two', 'Рабочая папка по умолчанию'])
  assert.deepEqual(rows.map(row => row.querySelector('.dd-time').textContent), ['5 мин назад', '3 ч назад', '2 дн назад'])
  await view.unmount()
})

test('clicking a row opens that Session and closes the menu; storage stays untouched', async () => {
  seedStorage()
  const before = JSON.stringify({ ...localStorage })
  const view = await render()
  await click(view.container.querySelector('.dd-trigger'))
  await click(menu().querySelector('.dd-open'))
  assert.deepEqual(opened, ['a'])
  assert.equal(menu(), null)
  assert.equal(JSON.stringify({ ...localStorage }), before)
  await view.unmount()
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

test('archive keeps keyboard focus in the menu while pending and after the row disappears', async () => {
  seedStorage()
  const workspacesBefore = workspacesStore.getSnapshot()
  let finish
  // Like uiWorkspace: the Host-confirmed archive set lands before the promise resolves.
  archiveImpl = id => new Promise((resolve) => {
    finish = () => {
      const snapshot = workspacesStore.getSnapshot()
      workspacesStore.set({ ...snapshot, archivedSessionIds: [...snapshot.archivedSessionIds, id] })
      resolve()
    }
  })
  const view = await render()
  await click(view.container.querySelector('.dd-trigger'))
  const button = menu().querySelectorAll('.dd-archive')[1]
  button.focus()
  await click(button)
  assert.deepEqual(archived.slice(-1), ['b'])
  assert.equal(button.getAttribute('aria-disabled'), 'true')
  assert.equal(document.activeElement, button, 'a pending archive keeps its focus')
  await click(button)
  assert.deepEqual(archived.slice(-1), ['b'], 'a pending archive ignores repeated clicks')
  assert.equal(archived.filter(id => id === 'b').length, 1)
  await act(async () => {
    finish()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const texts = [...menu().querySelectorAll('.dd-text')].map(node => node.textContent)
  assert.deepEqual(texts, ['Fix the login bug', '/review See @README.md please'])
  assert.equal(document.activeElement, menu().querySelectorAll('.dd-open')[1], 'focus moves to the row now at that position')
  await act(async () => { document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(menu(), null, 'Escape still reaches the dialog')
  archiveImpl = async () => {}
  await view.unmount()
  workspacesStore.set(workspacesBefore)
})

test('a failed archive is reported inline and keeps the row', async () => {
  seedStorage()
  archiveImpl = async () => { throw new Error('workspace/session-active') }
  const view = await render()
  await click(view.container.querySelector('.dd-trigger'))
  await click(menu().querySelectorAll('.dd-archive')[0])
  await settle()
  assert.match(menu().querySelector('.dd-error').textContent, /Не удалось архивировать: workspace\/session-active/)
  assert.equal(menu().querySelectorAll('.dd-row').length, 3)
  archiveImpl = async () => {}
  await view.unmount()
})

test('Escape closes the menu', async () => {
  seedStorage()
  const view = await render()
  await click(view.container.querySelector('.dd-trigger'))
  await act(async () => { menu().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(menu(), null)
  await view.unmount()
})

test('renders nothing without drafts and appears after the list changes', async () => {
  localStorage.clear()
  const view = await render()
  assert.equal(view.container.innerHTML, '')
  localStorage.setItem('dsh.conversation.a', JSON.stringify({ draft: 'new draft', view: null, viewRequest: null }))
  await act(async () => { sessionsStore.set({ ...sessionsStore.getSnapshot() }) })
  assert.equal(view.container.querySelector('.dd-trigger').textContent, 'Черновики (1)')
  await view.unmount()
})

test('a storage event from another tab refreshes the count', async () => {
  localStorage.clear()
  const view = await render()
  localStorage.setItem('dsh.conversation.b', JSON.stringify({ draft: 'from another tab', view: null, viewRequest: null }))
  await act(async () => { window.dispatchEvent(new window.StorageEvent('storage', { key: 'dsh.conversation.b' })) })
  assert.equal(view.container.querySelector('.dd-trigger').textContent, 'Черновики (1)')
  await view.unmount()
})
