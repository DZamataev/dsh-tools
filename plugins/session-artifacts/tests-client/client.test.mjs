// Behavior tests for client.js.
//
// Loads the browser module through a stub window.__ModuleLoader__, applies it
// against stub Cordis services (sidebarRightTabs, sidebarRight, slots, locale),
// renders the registered tab body in jsdom with real React, and drives the UI.
// React 18.3.1 and jsdom 29.1.1 come from a DeepSeek Harness checkout's pnpm
// store: DSH_REPO, default ~/dev/deepseek-harness.
//
// Run: npm run test:client (node --test tests-client/)
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const repo = process.env.DSH_REPO ?? `${process.env.HOME}/dev/deepseek-harness`
const pnpm = `${repo}/node_modules/.pnpm`
const req = createRequire(`${pnpm}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/package.json`)
const { JSDOM } = createRequire(`${pnpm}/jsdom@29.1.1_@noble+hashes@2.4.0/node_modules/jsdom/package.json`)('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'outside-only' })
const { window } = dom
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'MouseEvent', 'KeyboardEvent', 'AbortController', 'AbortSignal', 'fetch']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = req('react')
const { createRoot } = req('react-dom/client')
const { renderToStaticMarkup } = req('react-dom/server')
const { act } = React

const { fileAddressFor: realFileAddressFor } = await import(pathToFileURL(`${repo}/packages/util/workspace-path/lib/index.js`).href)

// ---- fixtures --------------------------------------------------------------

const NOW = Date.now()
const SESSION = 'session-1'
const CWD = '/w'

const artifact = (overrides) => ({
  path: '/w/docs/spec.md', relPath: 'docs/spec.md', name: 'spec.md', ext: 'md', kind: 'markdown',
  sources: ['write', 'present'], created: true, deleted: false, description: 'Specification v2',
  ops: 1, firstSeq: 10, lastSeq: 40, firstTime: NOW - 3_600_000, lastTime: NOW - 120_000, turns: [1, 4],
  exists: true, size: 1200, mtime: NOW - 120_000,
  ...overrides,
})

const ARTIFACTS = [
  artifact({}),
  artifact({
    path: '/w/notes.txt', relPath: 'notes.txt', name: 'notes.txt', ext: 'txt', kind: 'text',
    sources: ['mention'], created: false, description: null, ops: 0,
    firstSeq: 30, lastSeq: 30, firstTime: NOW - 600_000, lastTime: NOW - 600_000, turns: [3],
    size: 20, mtime: NOW - 600_000,
  }),
  artifact({
    path: '/w/report.pdf', relPath: 'report.pdf', name: 'report.pdf', ext: 'pdf', kind: 'pdf',
    sources: ['write', 'edit'], description: null, ops: 3,
    firstSeq: 5, lastSeq: 20, firstTime: NOW - 7_200_000, lastTime: NOW - 7_200_000, turns: [1, 2],
    exists: false, size: null, mtime: null,
  }),
  artifact({
    path: '/outside/data.csv', relPath: null, name: 'data.csv', ext: 'csv', kind: 'data',
    sources: ['patch'], created: false, deleted: true, description: null, ops: 1,
    firstSeq: 8, lastSeq: 10, firstTime: NOW - 90_000, lastTime: NOW - 90_000, turns: [2],
    size: 40, mtime: NOW - 90_000,
  }),
]

const PLANS = [
  { seq: 50, time: NOW - 240_000, turn: 3, status: 'approved', title: 'Migration plan', text: '## Migration\n\n- step one', truncated: false },
  { seq: 51, time: NOW - 60_000, turn: 4, status: 'rejected', title: '', text: '# second plan', truncated: true },
  { seq: 52, time: NOW - 30_000, turn: 4, status: 'pending', title: 'Third', text: '# third', truncated: false },
]

const LISTING = { ok: true, cwd: CWD, artifacts: ARTIFACTS, plans: PLANS, truncated: false }
const listingOf = (items, plans = []) => ({ ok: true, cwd: CWD, artifacts: items, plans, truncated: false })

// ---- module loading --------------------------------------------------------

function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    set(next) { snapshot = next; for (const fn of listeners) fn() },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

const hookOf = store => selector => React.useSyncExternalStore(
  store.subscribe,
  () => selector(store.getSnapshot()),
  () => selector(store.getSnapshot()),
)

let locale = 'ru'

/** Load client.js in the page's VM context and apply it to a recording ctx. */
function loadPlugin({ markdown = null, pathLabel = null, tooltip = null } = {}) {
  const dicts = {}
  const registrations = []
  const tabTypes = []
  const opened = []
  const openTabs = createSnapshotStore([])
  let definition
  window.__ModuleLoader__ = { load(def) { definition = def } }
  vm.runInContext(readFileSync(`${PLUGIN}/client.js`, 'utf8'), dom.getInternalVMContext())
  assert.equal(definition.id, '@local/dsh-session-artifacts')
  const plugin = definition.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: markdown, PathLabel: pathLabel, Tooltip: tooltip }
    throw new Error(`unexpected require ${name}`)
  })
  const disposers = []
  const ctx = {
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    locale: {
      register(ns, a, b) { if (typeof a === 'string') dicts[a] = b; else Object.assign(dicts, a); return () => {} },
      bind: () => (key, params = {}) => ((dicts[locale] ?? dicts.en)[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)),
      getLocale: () => ({ active: locale, locales: [], revision: 0 }),
    },
    slots: {
      inject(_name, cb) { cb() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
    sidebarRightTabs: {
      register(def) { tabTypes.push(def); return () => {} },
    },
    sidebarRight: {
      openTabs,
      openTab(kind) { opened.push(kind) },
    },
  }
  plugin.apply(ctx)
  return {
    definition,
    plugin,
    ctx,
    dicts,
    registrations,
    tabTypes,
    opened,
    openTabs,
    t: ctx.locale.bind('session-artifacts'),
    dispose: () => { for (const dispose of [...disposers].reverse()) dispose?.() },
  }
}

const copied = []
after(() => { window.close() })

// ---- mount -----------------------------------------------------------------

const sessionsStore = createSnapshotStore({
  phase: 'ready',
  ids: [SESSION, 'session-2'],
  byId: {
    [SESSION]: { id: SESSION, displayTitle: 'session', cwd: CWD, running: false, blank: false, updatedAt: NOW, retainedBy: { mainView: 1 } },
    'session-2': { id: 'session-2', displayTitle: 'other', cwd: '/other', running: false, blank: false, updatedAt: NOW, retainedBy: { mainView: 1 } },
  },
  projectionsBySession: {},
})
const statusStore = createSnapshotStore(new Map())
const setRunning = (id, value) => {
  statusStore.set(new Map([...statusStore.getSnapshot().entries(), [id, { running: value, pendingInteraction: undefined, completionUnread: false }]]))
}

async function mount(plugin, options = {}) {
  const sessionId = options.sessionId ?? SESSION
  const entry = plugin.registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  const face = options.face ?? entry.options.inject(sessionId)
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal
  const tab = {
    id: options.tabId ?? 'tab-1',
    kind: 'session-artifacts',
    title: 'Artifacts',
    contentId: 'sidebar://session-artifacts',
    visible: options.visible !== false,
    signal,
    refreshShortcut: { keys: ['⌘', 'R'], aria: 'Meta+R' },
    navigation: { address: 'sidebar://session-artifacts', params: undefined, revision: 0 },
    actions: {
      openResource(address) { openedResources.push(address) },
      bindCommands(commands) { boundCommands = commands; return () => { boundCommands = null } },
      openTab() {},
      close() {},
    },
    ...options.tab,
  }
  const props = {
    useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' }, tab }),
    sessionId,
    useSessions: hookOf(sessionsStore),
    useSessionStatus: hookOf(statusStore),
    useArtifacts: hookOf(face.hooks.artifacts),
    load: face.load,
    cancel: face.cancel,
    remember: face.remember,
    formatters: face.formatters,
    t: plugin.t,
  }
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(entry.component, props)) })
  return {
    container,
    props,
    tab,
    controller,
    face,
    rerender: async (next = {}) => act(async () => { root.render(React.createElement(entry.component, { ...props, ...next })) }),
    unmount: () => act(async () => { root.unmount() }),
  }
}

const openedResources = []
let boundCommands = null

// Fetch stub: every call is recorded; `fetchImpl` decides the response.
const calls = []
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
const realFetch = async (url, init) => {
  const call = { url, body: JSON.parse(init.body), signal: init.signal }
  calls.push(call)
  init.signal.addEventListener('abort', () => { call.aborted = true })
  return fetchImpl(url, init)
}
window.fetch = realFetch
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async (text) => { copied.push(text) } },
  configurable: true,
})

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const click = async el => act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const press = async (el, key) => act(async () => { el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })) })
const type = async (input, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
})
const rows = container => [...container.querySelectorAll('.sa-item')]
const names = container => rows(container).map(row => row.querySelector('.sa-name').textContent)
const chips = container => [...container.querySelectorAll('.sa-chip')].map(chip => `${chip.getAttribute('data-kind')}:${chip.querySelector('.sa-chip-count').textContent}`)
const status = container => container.querySelector('.sa-status')?.textContent ?? ''

// ---- registration ----------------------------------------------------------

test('the factory registers the tab type, both seats, the header button, and three dictionaries', () => {
  const plugin = loadPlugin()
  assert.deepEqual(JSON.parse(JSON.stringify(plugin.plugin.inject)), ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])
  assert.equal(plugin.tabTypes.length, 1)
  const type = plugin.tabTypes[0]
  assert.equal(type.id, '@local/dsh-session-artifacts')
  assert.equal(type.kind, 'session-artifacts')
  assert.equal(type.patterns, undefined, 'a page type claims no address')
  assert.equal(type.title(), 'Артефакты')
  assert.equal(type.guide.length, 1)
  assert.equal(type.guide[0].id, 'artifacts')
  assert.equal(type.guide[0].order, 40)
  assert.equal(type.guide[0].title(), 'Артефакты сессии')
  assert.equal(typeof type.guide[0].description(), 'string')
  assert.equal(typeof type.guide[0].icon, 'function')
  const byName = new Map(plugin.registrations.map(entry => [entry.options.name, entry]))
  assert.deepEqual([...byName.keys()].sort(), ['conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  for (const key of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    assert.equal(byName.get(key).options.key, '@local/dsh-session-artifacts')
    assert.equal(byName.get(key).options.locale, 'session-artifacts')
  }
  assert.equal(byName.get('conversation.session.header.utilities').options.id, 'session-artifacts')
  assert.equal(byName.get('conversation.session.header.utilities').options.order, 16)
  const keys = Object.keys(plugin.dicts.ru).sort()
  assert.ok(keys.length > 60, 'a complete dictionary')
  const category = /\.(one|few|many|other)$/
  const families = new Map()
  for (const key of keys) {
    const match = key.match(category)
    if (match === null) {
      for (const id of ['en', 'zh', 'ru']) assert.equal(typeof plugin.dicts[id][key], 'string', `${id} has ${key}`)
      continue
    }
    const base = key.slice(0, -match[0].length)
    families.set(base, (families.get(base) ?? 0) + 1)
  }
  for (const [base] of families) {
    for (const id of ['en', 'zh', 'ru']) {
      assert.ok(Object.keys(plugin.dicts[id]).some(key => key.startsWith(`${base}.`)), `${id} has a plural family for ${base}`)
    }
  }
  for (const localeId of ['en', 'zh', 'ru']) {
    const meta = JSON.parse(readFileSync(`${PLUGIN}/locale/${localeId}.json`, 'utf8'))
    assert.equal(typeof meta.meta.title, 'string')
    assert.equal(typeof meta.meta.description, 'string')
    assert.doesNotMatch(meta.meta.description, /Host|лог|日志/, 'no implementation detail in the plugin description')
  }
})

test('the header button opens the tab by kind and reflects an open tab of this Session', async () => {
  const plugin = loadPlugin()
  const entry = plugin.registrations.find(item => item.options.name === 'conversation.session.header.utilities')
  const injected = entry.options.inject()
  const container = window.document.createElement('div')
  const root = createRoot(container)
  const render = props => act(async () => {
    root.render(React.createElement(entry.component, {
      sessionId: SESSION, t: plugin.t, open: injected.open, useOpenTabs: hookOf(injected.hooks.openTabs), ...props,
    }))
  })
  await render()
  const button = container.querySelector('button')
  assert.equal(button.getAttribute('aria-label'), 'Артефакты сессии')
  assert.equal(button.getAttribute('aria-pressed'), 'false')
  await click(button)
  assert.deepEqual(plugin.opened, ['session-artifacts'])
  plugin.openTabs.set([{ sessionId: SESSION, tabId: 't1', kind: 'session-artifacts', contentId: 'x' }])
  await render()
  assert.equal(container.querySelector('button').getAttribute('aria-pressed'), 'true')
  plugin.openTabs.set([{ sessionId: 'session-2', tabId: 't2', kind: 'session-artifacts', contentId: 'x' }])
  await render()
  assert.equal(container.querySelector('button').getAttribute('aria-pressed'), 'false', 'another Session’s tab is not this one')
  await act(async () => { root.unmount() })
})

// ---- the list --------------------------------------------------------------

test('the body lists documents newest first, with counts, badges, plans first, and plan outcomes', async () => {
  const plugin = loadPlugin()
  calls.length = 0
  const view = await mount(plugin)
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'api/session-artifacts.list')
  assert.deepEqual(calls[0].body, { sessionId: SESSION })
  assert.equal(view.container.querySelector('.sa-root').getAttribute('data-artifacts-state'), 'ready')
  assert.deepEqual(names(view.container), ['spec.md', 'notes.txt', 'report.pdf', 'data.csv'])
  assert.deepEqual(chips(view.container), ['all:4', 'markdown:1', 'pdf:1', 'text:1', 'data:1'])
  assert.match(status(view.container), /4 документа/)
  assert.match(status(view.container), /3 плана/)
  const first = view.container.querySelector('.sa-scroll').firstElementChild
  assert.ok(first.classList.contains('sa-plans'), 'the plans section leads the scroll area')
  assert.deepEqual([...view.container.querySelectorAll('.sa-plan-badge')].map(node => node.textContent), ['одобрен', 'отклонён', 'ждёт решения'])
  assert.deepEqual([...view.container.querySelectorAll('.sa-plan-badge')].map(node => node.getAttribute('data-status')), ['approved', 'rejected', 'pending'])
  const spec = rows(view.container)[0]
  assert.equal(spec.querySelector('.sa-kind').textContent, 'MD')
  assert.deepEqual([...spec.querySelectorAll('.sa-badge')].map(badge => badge.textContent), ['новый', 'показан'])
  assert.equal(spec.querySelector('.sa-desc').textContent, 'Specification v2')
  assert.match(spec.querySelector('.sa-time').getAttribute('title'), /^Последнее изменение: /)
  assert.equal(rows(view.container)[1].querySelector('.sa-time').getAttribute('title').startsWith('Последнее появление: '), true)
  assert.equal(rows(view.container)[1].querySelector('.sa-dir').textContent, 'корень')
  assert.equal(rows(view.container)[3].querySelector('.sa-dir').textContent, '/outside')
  assert.deepEqual([...rows(view.container)[3].querySelectorAll('.sa-badge')].map(badge => badge.textContent), ['изменён', 'удалён'])
  const missing = rows(view.container)[2]
  assert.equal(missing.getAttribute('data-missing'), 'true')
  assert.equal(missing.querySelector('.sa-open').getAttribute('aria-disabled'), 'true')
  await view.unmount()
})

test('a row opens the file through the sidebar preview at the real file address', async () => {
  const plugin = loadPlugin()
  openedResources.length = 0
  const view = await mount(plugin)
  await settle()
  for (const [index, item] of ARTIFACTS.entries()) {
    openedResources.length = 0
    const button = rows(view.container)[index].querySelector('.sa-open')
    if (button.getAttribute('aria-disabled') === 'true') {
      await click(button)
      assert.deepEqual(openedResources, [], 'a missing row does not open')
      continue
    }
    await click(button)
    assert.deepEqual(openedResources, [realFileAddressFor(SESSION, CWD, item.path)], `address for ${item.path}`)
  }
  await view.unmount()

  const edge = [
    ['/w', '/w/a b#c?.md'], ['/w/', '/w/x.md'], ['/w', '/w'], ['/w', '/wx/y.md'], [null, '/a/%2F.md'],
    ['C:\\w', 'C:\\w\\d\\e.md'], ['C:/w', 'c:/w/d.md'], ['/w', '\\\\srv\\share\\x.md'], ['/w', './rel.md'], ['/w', 'rel/./x.md'],
    ['/w', '/w/ünïcode 文档.md'], ['', '/w/x.md'],
  ]
  for (const [cwd, path] of edge) {
    sessionsStore.set({ ...sessionsStore.getSnapshot(), byId: { ...sessionsStore.getSnapshot().byId, [SESSION]: { ...sessionsStore.getSnapshot().byId[SESSION], cwd } } })
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => listingOf([{ ...ARTIFACTS[0], path, relPath: null, name: path.split('/').pop() }]) })
    const one = await mount(plugin, { tabId: `edge-${path}`, face: view.face })
    await settle()
    openedResources.length = 0
    await click(rows(one.container)[0].querySelector('.sa-open'))
    assert.deepEqual(openedResources, [realFileAddressFor(SESSION, cwd ?? undefined, path)], `${cwd} ${path}`)
    await one.unmount()
  }
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
  sessionsStore.set({ ...sessionsStore.getSnapshot(), byId: { ...sessionsStore.getSnapshot().byId, [SESSION]: { ...sessionsStore.getSnapshot().byId[SESSION], cwd: CWD } } })
})

test('addresses use the Session workspace root, not the effective working directory', async () => {
  const plugin = loadPlugin()
  const moved = '/w/sub'
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, cwd: moved, artifacts: [{ ...ARTIFACTS[0], path: `${moved}/x.md`, relPath: 'x.md', name: 'x.md' }], plans: [], truncated: false }),
  })
  openedResources.length = 0
  const view = await mount(plugin)
  await settle()
  await click(rows(view.container)[0].querySelector('.sa-open'))
  assert.deepEqual(openedResources, [`dsh-resource://file/session/${SESSION}/sub/x.md`])
  assert.deepEqual(openedResources, [realFileAddressFor(SESSION, '/w', `${moved}/x.md`)])
  await view.unmount()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

test('the text filter, kind chips, missing toggle, and sort narrow the list and persist', async () => {
  const plugin = loadPlugin()
  window.localStorage.clear()
  const view = await mount(plugin)
  await settle()
  await type(view.container.querySelector('.sa-input'), 'spec')
  assert.deepEqual(names(view.container), ['spec.md'])
  assert.match(status(view.container), /^Показано 1 из 4/)
  await type(view.container.querySelector('.sa-input'), 'zzz')
  assert.deepEqual(names(view.container), [])
  assert.equal(view.container.querySelector('.sa-empty').getAttribute('data-empty'), 'filtered')
  await type(view.container.querySelector('.sa-input'), '')
  assert.equal(names(view.container).length, 4)

  await click(view.container.querySelectorAll('.sa-chip')[2]) // pdf
  assert.deepEqual(names(view.container), ['report.pdf'])
  assert.equal(JSON.parse(window.localStorage.getItem('session-artifacts:prefs')).kind, 'pdf')
  await click(view.container.querySelector('.sa-chip')) // all
  assert.equal(names(view.container).length, 4)

  const hideMissing = [...view.container.querySelectorAll('.sa-option')].find(button => button.textContent === 'Скрыть пропавшие')
  await click(hideMissing)
  assert.equal(names(view.container).includes('report.pdf'), false)
  assert.equal(hideMissing.getAttribute('aria-pressed'), 'true')
  assert.equal(JSON.parse(window.localStorage.getItem('session-artifacts:prefs')).hideMissing, true)
  await click(hideMissing)
  assert.equal(names(view.container).includes('report.pdf'), true)

  const sort = [...view.container.querySelectorAll('.sa-option')].find(button => button.getAttribute('aria-label')?.startsWith('Порядок:'))
  await click(sort)
  assert.deepEqual(names(view.container), ['data.csv', 'notes.txt', 'report.pdf', 'spec.md'])
  assert.equal(JSON.parse(window.localStorage.getItem('session-artifacts:prefs')).sort, 'name')
  await view.unmount()
})

test('a persisted chip whose kind is gone falls back to all, without overwriting the choice', async () => {
  const plugin = loadPlugin()
  window.localStorage.clear()
  window.localStorage.setItem('session-artifacts:prefs', JSON.stringify({ kind: 'image', hideMissing: false, sort: 'recent' }))
  const view = await mount(plugin)
  await settle()
  assert.equal(names(view.container).length, 4)
  assert.equal(view.container.querySelector('.sa-chip[data-kind=all]').getAttribute('aria-pressed'), 'true')
  assert.equal(JSON.parse(window.localStorage.getItem('session-artifacts:prefs')).kind, 'image')
  await view.unmount()
  window.localStorage.clear()
})

test('an unknown kind becomes the "other" chip; localStorage garbage is tolerated', async () => {
  const plugin = loadPlugin()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => listingOf([{ ...ARTIFACTS[0], path: '/w/x.xyz', relPath: 'x.xyz', name: 'x.xyz', ext: 'xyz', kind: 'spreadsheet' }]) })
  for (const [index, raw] of ['{bad', 'null', '[]', '5', '"x"', '{"kind":"__proto__","sort":"name","hideMissing":"yes"}', '{"kind":"toString"}'].entries()) {
    window.localStorage.setItem('session-artifacts:prefs', raw)
    const view = await mount(plugin, { tabId: `ls-${index}` })
    await settle()
    assert.ok(view.container.querySelector('.sa-root'))
    assert.deepEqual(chips(view.container), ['all:1', 'other:1'])
    assert.equal(view.container.querySelector('.sa-chip[data-kind=other]').textContent.startsWith('Другое'), true)
    await view.unmount()
  }
  window.localStorage.clear()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

test('counts use the language plural categories', async () => {
  const plugin = loadPlugin()
  const one = [ARTIFACTS[0]]
  const five = [0, 1, 2, 3, 4].map(index => ({ ...ARTIFACTS[0], path: `/w/f${index}.md`, relPath: `f${index}.md`, name: `f${index}.md`, lastSeq: 10 + index }))
  const cases = [
    [one, {}, '1 документ'],
    [one, { status: 'approved' }, '1 документ'],
    [five, {}, '5 документов'],
    [five, {}, '5 документов'],
  ]
  for (const [index, [items, plan, expected]] of cases.entries()) {
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => listingOf(items, plan === undefined ? [] : [{ ...PLANS[0], ...plan }]) })
    const view = await mount(plugin, { tabId: `plural-${index}` })
    await settle()
    assert.equal(status(view.container).startsWith(expected), true, `${items.length} → ${status(view.container)}`)
    await view.unmount()
  }
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

// ---- copy, plans, states ---------------------------------------------------

test('the copy control names its file, confirms it, and announces once', async () => {
  const plugin = loadPlugin()
  const view = await mount(plugin)
  await settle()
  copied.length = 0
  const copy = rows(view.container)[1].querySelector('.sa-copy')
  assert.equal(copy.getAttribute('aria-label'), 'Копировать путь: notes.txt')
  assert.equal(copy.getAttribute('title'), 'Копировать путь: notes.txt', 'the title fallback when Tooltip is unavailable')
  await click(copy)
  await settle()
  assert.deepEqual(copied, ['/w/notes.txt'])
  assert.equal(view.container.querySelector('.sa-sr').textContent, 'Путь скопирован: notes.txt')
  await view.unmount()
})

test('plans expand to Markdown or plain text, keep unique keys, and the section collapses', async () => {
  const plain = loadPlugin()
  const view = await mount(plain)
  await settle()
  const heads = () => [...view.container.querySelectorAll('.sa-plan-head')]
  assert.equal(heads().length, 3)
  assert.equal(heads()[0].getAttribute('aria-expanded'), 'false')
  await click(heads()[0])
  assert.equal(heads()[0].getAttribute('aria-expanded'), 'true')
  assert.equal(view.container.querySelector('.sa-plan-body .sa-plain').textContent, '## Migration\n\n- step one')
  await click(heads()[1])
  assert.equal(view.container.querySelectorAll('.sa-plan-title')[1].textContent, 'План без названия')
  assert.match(view.container.querySelectorAll('.sa-plan-body .sa-note')[0].textContent, /длиннее/)
  const section = view.container.querySelector('.sa-section')
  assert.equal(section.getAttribute('aria-expanded'), 'true')
  await click(section)
  assert.equal(section.getAttribute('aria-expanded'), 'false')
  assert.equal(view.container.querySelectorAll('.sa-plan').length, 0)
  await click(section)
  assert.equal(view.container.querySelectorAll('.sa-plan').length, 3)
  await view.unmount()
  // Expanded rows survive a remount of a new body over the same face + tab.
  const again = await mount(plain, { face: view.face, tabId: view.tab.id })
  await settle()
  assert.equal(again.container.querySelectorAll('.sa-plan-head[aria-expanded=true]').length, 2)
  await again.unmount()

  const Markdown = ({ text }) => React.createElement('div', { className: 'fake-md' }, text)
  const rendered = loadPlugin({ markdown: Markdown })
  const second = await mount(rendered, { tabId: 'md' })
  await settle()
  await click(second.container.querySelector('.sa-plan-head'))
  assert.equal(second.container.querySelector('.sa-plan-body .fake-md').textContent, '## Migration\n\n- step one')
  await second.unmount()
})

test('the query, scroll offset, and open rows live in the per-tab record', async () => {
  const plugin = loadPlugin()
  const view = await mount(plugin, { tabId: 'persist' })
  await settle()
  await type(view.container.querySelector('.sa-input'), 'spec')
  const scroller = view.container.querySelector('.sa-scroll')
  await act(async () => {
    scroller.scrollTop = 120
    scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
  })
  await click(view.container.querySelector('.sa-plan-head'))
  const record = view.face.hooks.artifacts.getSnapshot().byTab.persist
  assert.equal(record.query, 'spec')
  assert.deepEqual([...record.openPlans], ['50:0'])
  await view.unmount()
  const saved = view.face.hooks.artifacts.getSnapshot().byTab.persist
  assert.equal(saved.query, 'spec')
  assert.equal(saved.scrollTop, 120)
  const again = await mount(plugin, { tabId: 'persist', face: view.face })
  await settle()
  assert.equal(again.container.querySelector('.sa-input').value, 'spec')
  assert.equal(again.container.querySelector('.sa-plan-head').getAttribute('aria-expanded'), 'true')
  assert.equal(again.container.querySelector('.sa-scroll').scrollTop, 120)
  await again.unmount()
})

test('the loading state is one skeleton, with no loading text', async () => {
  const plugin = loadPlugin()
  let release
  const pending = new Promise((resolve) => { release = resolve })
  fetchImpl = async () => {
    await pending
    return { ok: true, status: 200, json: async () => LISTING }
  }
  const view = await mount(plugin)
  assert.ok(view.container.querySelector('.sa-skeleton'), 'a skeleton stands in for the list')
  assert.equal(view.container.textContent.includes('Загружаю'), false, 'no loading sentence')
  assert.equal(view.container.querySelector('.sa-root').getAttribute('aria-busy'), 'true')
  release()
  await settle()
  assert.equal(view.container.querySelector('.sa-skeleton'), null)
  await view.unmount()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

test('a failed read keeps its alert mounted until a success, and retries', async () => {
  const plugin = loadPlugin()
  setRunning(SESSION, true)
  fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not-found', message: 'session not found' }) })
  const view = await mount(plugin)
  await settle()
  const error = view.container.querySelector('.sa-error')
  assert.equal(error.getAttribute('role'), 'alert')
  assert.equal(error.querySelector('.sa-error-title').textContent, 'Не удалось загрузить список')
  assert.equal(error.querySelector('.sa-error-text').textContent, 'Журнал этой сессии не найден')
  // The same failure repeated keeps the very same alert node: nothing is re-announced.
  await view.rerender()
  await settle()
  assert.equal(view.container.querySelector('.sa-error'), error)
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
  await click(error.querySelector('.sa-retry'))
  await settle()
  assert.equal(view.container.querySelector('.sa-error'), null)
  assert.equal(names(view.container).length, 4)
  setRunning(SESSION, false)
  await view.unmount()
})

test('a plain-text 404 (no route in the Host) asks for a restart', async () => {
  const plugin = loadPlugin()
  fetchImpl = async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token < in JSON') } })
  const view = await mount(plugin, { tabId: 'no-route' })
  await settle()
  assert.equal(view.container.querySelector('.sa-error-text').textContent, 'Серверная часть плагина не загружена — перезапустите DSH')
  await view.unmount()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

test('a network failure and an unloaded plugin each get their own message', async () => {
  const plugin = loadPlugin()
  fetchImpl = async () => { throw new TypeError('Failed to fetch') }
  const view = await mount(plugin, { tabId: 'network' })
  await settle()
  assert.equal(view.container.querySelector('.sa-error-text').textContent, 'Нет связи с сервером')
  await view.unmount()
  fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({ error: 'unloading', message: 'unloading' }) })
  const second = await mount(plugin, { tabId: 'unloading' })
  await settle()
  assert.equal(second.container.querySelector('.sa-error-text').textContent, 'Плагин выгружается — попробуйте ещё раз')
  await second.unmount()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

test('an empty session explains itself; a filtered empty state says so', async () => {
  const plugin = loadPlugin()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, cwd: CWD, artifacts: [], plans: [], truncated: false }) })
  const view = await mount(plugin)
  await settle()
  assert.equal(view.container.querySelector('.sa-empty').getAttribute('data-empty'), 'session')
  assert.equal(view.container.querySelector('.sa-chips'), null)
  await view.unmount()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

// ---- requests --------------------------------------------------------------

test('P0 regression: two Sessions sharing a TabId never share rows or records', async () => {
  const plugin = loadPlugin()
  calls.length = 0
  window.fetch = async (url, init) => {
    const call = { url, body: JSON.parse(init.body), signal: init.signal }
    calls.push(call)
    if (call.body.sessionId === 'session-1') return { ok: true, status: 200, json: async () => listingOf([{ ...ARTIFACTS[0], path: '/a/secret-a.md', relPath: null, name: 'secret-a.md' }]) }
    return { ok: false, status: 404, json: async () => ({ error: 'not-found', message: 'session not found' }) }
  }
  const a = await mount(plugin, { sessionId: 'session-1', tabId: 'tab2' })
  await settle()
  assert.deepEqual(names(a.container), ['secret-a.md'])
  await a.unmount()
  const b = await mount(plugin, { sessionId: 'session-2', tabId: 'tab2' })
  assert.equal(calls.at(-1).body.sessionId, 'session-2')
  assert.deepEqual(names(b.container), [], 'Session B starts empty instead of showing Session A rows')
  await settle()
  assert.deepEqual(names(b.container), [], 'a failed read leaves no foreign rows')
  assert.ok(b.container.querySelector('.sa-error'))
  await b.unmount()
  window.fetch = realFetch
})

test('P1 regression: an explicit trigger replaces a request in flight instead of being dropped', async () => {
  const plugin = loadPlugin()
  calls.length = 0
  setRunning(SESSION, true)
  const queue = []
  window.fetch = (url, init) => new Promise((resolve, reject) => {
    const call = { url, body: JSON.parse(init.body), signal: init.signal }
    calls.push(call)
    init.signal.addEventListener('abort', () => { call.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
    queue.push({ call, resolve: payload => resolve({ ok: true, status: 200, json: async () => payload }) })
  })
  const view = await mount(plugin, { tabId: 'force' })
  queue.shift().resolve(listingOf([{ ...ARTIFACTS[0], path: '/a/one.md', relPath: null, name: 'one.md' }]))
  await settle()
  // A poll starts ...
  view.face.load('force', view.tab.signal)
  assert.equal(calls.length, 2)
  const poll = queue.shift()
  // ... the turn ends: the stale poll is aborted and a fresh read starts.
  await act(async () => { setRunning(SESSION, false) })
  await settle()
  assert.equal(poll.call.aborted, true, 'the poll was aborted')
  assert.equal(queue.length, 1, 'a new request was started by the turn end')
  queue.shift().resolve(listingOf([
    { ...ARTIFACTS[0], path: '/a/one.md', relPath: null, name: 'one.md' },
    { ...ARTIFACTS[0], path: '/a/two.md', relPath: null, name: 'two.md', lastSeq: 41 },
  ]))
  await settle()
  assert.deepEqual(names(view.container), ['two.md', 'one.md'])
  await view.unmount()
  window.fetch = realFetch
})

test('P1 regression: a closed tab forgets its record even when its body is unmounted', async () => {
  const plugin = loadPlugin()
  const controller = new AbortController()
  const view = await mount(plugin, { tabId: 't-leak', signal: controller.signal })
  await settle()
  assert.notEqual(view.face.hooks.artifacts.getSnapshot().byTab['t-leak'], undefined)
  await view.unmount()
  await act(async () => { controller.abort() })
  assert.equal(view.face.hooks.artifacts.getSnapshot().byTab['t-leak'], undefined)
})

test('unloading the plugin leaves no listener on a tab the Sidebar still holds', async () => {
  const counting = () => {
    const listeners = new Set()
    const signal = {
      aborted: false,
      addEventListener(type, handler) { if (type === 'abort') listeners.add(handler) },
      removeEventListener(type, handler) { if (type === 'abort') listeners.delete(handler) },
      close() { signal.aborted = true; for (const handler of [...listeners]) handler() },
      count: () => listeners.size,
    }
    return signal
  }
  const plugin = loadPlugin()
  const live = counting()
  const view = await mount(plugin, { tabId: 't-unload', signal: live })
  await settle()
  assert.equal(live.count(), 1, 'the occurrence is watched while the plugin lives')
  assert.notEqual(view.face.hooks.artifacts.getSnapshot().byTab['t-unload'], undefined)
  await view.unmount()
  await act(async () => { plugin.dispose() })
  assert.equal(live.count(), 0, 'unload removes the listener from the signal the Sidebar still holds')
  assert.equal(view.face.hooks.artifacts.getSnapshot().byTab['t-unload'], undefined, 'and drops its record')
  // The Sidebar may still close the occurrence afterwards: the dead generation must not react.
  live.close()
  assert.equal(live.count(), 0)
  assert.equal(view.face.hooks.artifacts.getSnapshot().byTab['t-unload'], undefined)
})

test('a reload over a tab signal the Sidebar kept watches it again, once', async () => {
  const listeners = new Set()
  const live = {
    aborted: false,
    addEventListener(type, handler) { if (type === 'abort') listeners.add(handler) },
    removeEventListener(type, handler) { if (type === 'abort') listeners.delete(handler) },
  }
  const first = loadPlugin()
  const one = await mount(first, { tabId: 't-reload', signal: live })
  await settle()
  assert.equal(listeners.size, 1)
  await one.unmount()
  await act(async () => { first.dispose() })
  assert.equal(listeners.size, 0)
  const second = loadPlugin()
  const two = await mount(second, { tabId: 't-reload', signal: live })
  await settle()
  assert.equal(listeners.size, 1, 'the new generation watches it exactly once')
  assert.equal(names(two.container).length, 4)
  await two.unmount()
  await act(async () => { second.dispose() })
  assert.equal(listeners.size, 0)
})

test('P1 regression: a hidden body does not read at the end of a turn', async () => {
  const plugin = loadPlugin()
  calls.length = 0
  setRunning(SESSION, true)
  const view = await mount(plugin, { tabId: 'hidden', visible: false })
  assert.equal(calls.length, 0)
  await act(async () => { setRunning(SESSION, false) })
  await settle()
  assert.equal(calls.length, 0, 'a pane nobody can see is not read')
  await view.unmount()
  setRunning(SESSION, false)
})

test('the refresh command, the refresh button, and the end of a turn each refetch', async () => {
  const plugin = loadPlugin()
  calls.length = 0
  const view = await mount(plugin)
  await settle()
  assert.equal(calls.length, 1)
  assert.ok(boundCommands?.refresh)
  await act(async () => { boundCommands.refresh() })
  await settle()
  assert.equal(calls.length, 2)
  await click(view.container.querySelector('.sa-tool[data-busy]'))
  await settle()
  assert.equal(calls.length, 3)
  await act(async () => { setRunning(SESSION, true) })
  await settle()
  await act(async () => { setRunning(SESSION, false) })
  await settle()
  assert.equal(calls.length, 4)
  await view.unmount()
})

test('only a user-initiated read shows the busy state, and only it stays out of the live region', async () => {
  const plugin = loadPlugin()
  const pending = []
  fetchImpl = async () => {
    await new Promise((resolve) => { pending.push(resolve) })
    return { ok: true, status: 200, json: async () => LISTING }
  }
  const view = await mount(plugin, { tabId: 'busy' })
  pending.shift()()
  await settle()
  const refresh = () => view.container.querySelector('.sa-tool[data-busy]')
  assert.equal(refresh().getAttribute('data-busy'), 'false')
  // A turn-end read is not a user gesture: no spinner, and the status keeps its counts.
  await act(async () => { setRunning(SESSION, true) })
  await settle()
  await act(async () => { setRunning(SESSION, false) })
  await settle()
  pending.shift()()
  await settle()
  assert.equal(refresh().getAttribute('data-busy'), 'false')
  assert.match(status(view.container), /4 документа/)
  // The refresh button starts an interactive read.
  await click(refresh())
  assert.equal(refresh().getAttribute('data-busy'), 'true')
  pending.shift()()
  await settle()
  assert.equal(refresh().getAttribute('data-busy'), 'false')
  assert.equal(status(view.container).includes('обновляю'), false, 'the busy text never enters the live region')
  setRunning(SESSION, false)
  await view.unmount()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

test('unloading the plugin aborts a read in flight, with or without AbortSignal.any', async () => {
  for (const useAny of [true, false]) {
    const plugin = loadPlugin()
    const any = window.AbortSignal.any
    if (!useAny) window.AbortSignal.any = undefined
    try {
      let release
      fetchImpl = async () => {
        await new Promise((resolve) => { release = resolve })
        return { ok: true, status: 200, json: async () => LISTING }
      }
      const view = await mount(plugin, { tabId: `unload-${useAny}` })
      await settle()
      const last = calls.at(-1)
      assert.equal(last.signal.aborted, false)
      await act(async () => { plugin.dispose() })
      assert.equal(last.signal.aborted, true, useAny ? 'AbortSignal.any link' : 'relay fallback')
      release()
      await settle()
      await view.unmount()
    } finally {
      window.AbortSignal.any = any
      fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
    }
  }
})

test('an unchanged payload is not written again', async () => {
  const plugin = loadPlugin()
  const view = await mount(plugin, { tabId: 'same' })
  await settle()
  const before = view.face.hooks.artifacts.getSnapshot().byTab.same.data
  view.face.load('same', view.tab.signal, { force: true })
  await settle()
  const after = view.face.hooks.artifacts.getSnapshot().byTab.same.data
  assert.equal(before, after, 'identical data keeps its reference')
  await view.unmount()
})

test('unmounting aborts the request in flight', async () => {
  const plugin = loadPlugin()
  let release
  const pending = new Promise((resolve) => { release = resolve })
  fetchImpl = async () => {
    await pending
    return { ok: true, status: 200, json: async () => LISTING }
  }
  const view = await mount(plugin, { tabId: 'abort' })
  await settle()
  const last = calls.at(-1)
  assert.equal(last.aborted, undefined)
  await view.unmount()
  assert.equal(last.signal.aborted, true)
  release()
  await settle()
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
})

// ---- keyboard, locale, primitives ------------------------------------------

test('rows are one tab stop and move with the arrow keys', async () => {
  const plugin = loadPlugin()
  const view = await mount(plugin, { tabId: 'keys' })
  await settle()
  const buttons = () => rows(view.container).map(row => row.querySelector('.sa-open'))
  const copies = () => rows(view.container).map(row => row.querySelector('.sa-copy'))
  assert.deepEqual(buttons().map(button => button.tabIndex), [0, -1, -1, -1])
  assert.deepEqual(copies().map(button => button.tabIndex), [0, -1, -1, -1], 'the roving row carries its copy control')
  buttons()[0].focus()
  await press(view.container.querySelector('.sa-list'), 'ArrowDown')
  assert.equal(document.activeElement, buttons()[1])
  assert.deepEqual(buttons().map(button => button.tabIndex), [-1, 0, -1, -1])
  assert.deepEqual(copies().map(button => button.tabIndex), [-1, 0, -1, -1])
  await press(view.container.querySelector('.sa-list'), 'ArrowDown')
  assert.equal(document.activeElement, buttons()[2])
  await press(view.container.querySelector('.sa-list'), 'ArrowUp')
  assert.equal(document.activeElement, buttons()[1])
  await view.unmount()
})

test('a roving row that leaves the list hands the tab stop to the first survivor', async () => {
  const plugin = loadPlugin()
  const view = await mount(plugin, { tabId: 'roving-gone' })
  await settle()
  const buttons = () => rows(view.container).map(row => row.querySelector('.sa-open'))
  const copies = () => rows(view.container).map(row => row.querySelector('.sa-copy'))
  buttons()[0].focus()
  await press(view.container.querySelector('.sa-list'), 'ArrowDown')
  assert.deepEqual(buttons().map(button => button.tabIndex), [-1, 0, -1, -1])

  // The text filter drops the roving row.
  await type(view.container.querySelector('.sa-input'), 'spec')
  assert.deepEqual(names(view.container), ['spec.md'])
  assert.equal(buttons()[0].tabIndex, 0, 'Tab reaches the surviving row')
  assert.equal(copies()[0].tabIndex, 0)

  // A chip does the same from a fresh roving row.
  await type(view.container.querySelector('.sa-input'), '')
  buttons()[1].focus()
  await press(view.container.querySelector('.sa-list'), 'ArrowDown')
  assert.deepEqual(buttons().map(button => button.tabIndex), [-1, -1, 0, -1])
  await click(view.container.querySelector('.sa-chip[data-kind=markdown]'))
  assert.deepEqual(names(view.container), ['spec.md'])
  assert.equal(buttons()[0].tabIndex, 0)

  // So does a refetch that no longer lists it.
  await click(view.container.querySelector('.sa-chip[data-kind=all]'))
  assert.equal(names(view.container).length, 4)
  buttons()[2].focus()
  await press(view.container.querySelector('.sa-list'), 'ArrowDown')
  assert.deepEqual(buttons().map(button => button.tabIndex), [-1, -1, -1, 0])
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => listingOf([ARTIFACTS[0]]) })
  await act(async () => { view.face.load('roving-gone', view.tab.signal, { force: true }) })
  await settle()
  assert.deepEqual(names(view.container), ['spec.md'])
  assert.equal(buttons()[0].tabIndex, 0)
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => LISTING })
  await view.unmount()
})

test('relative time and name order follow the active language', async () => {
  const plugin = loadPlugin()
  locale = 'ru'
  const view = await mount(plugin, { tabId: 'locale' })
  await settle()
  assert.match(rows(view.container)[0].querySelector('.sa-time').textContent, /назад|минут|ч|дн/u)
  assert.equal(view.container.querySelector('.sa-status').textContent.startsWith('4 документа'), true)
  locale = 'en'
  await view.rerender()
  assert.match(rows(view.container)[0].querySelector('.sa-time').textContent, /ago|in /u)
  assert.equal(view.container.querySelector('.sa-status').textContent.startsWith('4 documents'), true)
  locale = 'zh'
  await view.rerender()
  assert.equal(view.container.querySelector('.sa-status').textContent.startsWith('4 个文档'), true)
  locale = 'ru'
  await view.unmount()
})

test('the primitives are optional: PathLabel, Tooltip, and MarkdownText each fall back', async () => {
  const plain = loadPlugin()
  const view = await mount(plain)
  await settle()
  const dir = view.container.querySelector('.sa-dir')
  assert.equal(dir.hasAttribute('data-path-label'), false)
  assert.equal(dir.getAttribute('title'), 'docs')
  assert.equal(view.container.querySelector('.sa-tool[data-busy]').getAttribute('title'), 'Обновить', 'a short tooltip without the primitive')
  assert.equal(view.container.querySelector('.sa-tool[data-busy]').getAttribute('aria-label'), 'Обновить список документов')
  assert.equal(view.container.querySelector('.sa-tool[data-busy]').getAttribute('aria-keyshortcuts'), 'Meta+R')
  await view.unmount()

  const pathLabel = ({ path, className }) => React.createElement('span', { className, 'data-path-label': true }, path)
  const tooltip = ({ label, children }) => React.createElement(React.Fragment, null, React.cloneElement(children, { 'data-tooltip': label }))
  const fancy = loadPlugin({ pathLabel, tooltip })
  const second = await mount(fancy, { tabId: 'fancy' })
  await settle()
  assert.equal(second.container.querySelector('.sa-dir').getAttribute('data-path-label'), 'true')
  assert.equal(second.container.querySelector('.sa-tool[data-busy]').getAttribute('data-tooltip'), 'Обновить')
  await second.unmount()
})

test('the body renders through react-dom/server without a browser store', async () => {
  const plugin = loadPlugin()
  const entry = plugin.registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  const face = entry.options.inject(SESSION)
  const props = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: { id: 'tab-1', kind: 'session-artifacts', title: 'Artifacts', contentId: 'x', visible: true, signal: new AbortController().signal, navigation: { address: 'x', params: undefined, revision: 0 }, actions: { openResource() {}, bindCommands() { return () => {} }, openTab() {}, close() {} } },
    }),
    sessionId: SESSION,
    useSessions: hookOf(sessionsStore),
    useSessionStatus: hookOf(statusStore),
    useArtifacts: hookOf(face.hooks.artifacts),
    load: face.load,
    cancel: face.cancel,
    remember: face.remember,
    formatters: face.formatters,
    t: plugin.t,
  }
  const markup = renderToStaticMarkup(React.createElement(entry.component, props))
  assert.match(markup, /class="sa-root"/)
  assert.match(markup, /sa-skeleton/)
  const title = renderToStaticMarkup(React.createElement(
    plugin.registrations.find(item => item.options.name === 'sidebar.right.pane.tab.title').component,
    { t: plugin.t },
  ))
  assert.match(title, /Артефакты/)
})
