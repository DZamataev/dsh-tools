// Client half of session-find: Cmd/Ctrl+F and a Session header button open a
// floating panel that searches the open Session's conversation on the Host
// (its log, not the rendered page) and lists the matches. Results do not
// navigate the chat.
window.__ModuleLoader__.load({
  id: '@local/dsh-session-find',
  factory(require) {
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NS = 'session-find'
    const ROUTE = 'api/session-find.search'

    const en = {
      'button.aria': 'Find in conversation',
      'shortcut.label': 'Find in conversation',
      'panel.aria': 'Find in conversation',
      'input.placeholder': 'Find in conversation…',
      'input.aria': 'Search text',
      'regex.aria': 'Regular expression',
      'regex.title': 'Regular expression (case-insensitive, multiline)',
      'search': 'Find',
      'close': 'Close',
      'hint': 'Searches your messages and assistant replies in the whole session log. Enter to search, Esc to close.',
      'status.loading': 'Searching…',
      'status.none': 'No matches in {scanned} messages',
      'status.found': '{matches} matches in {messages} messages',
      'status.truncated': 'showing the first {shown} messages',
      'error.invalid-query': 'Invalid query: {message}',
      'error.timeout': 'The search took too long and was stopped',
      'error.not-found': 'This session has no saved log yet',
      'error.other': 'Search failed: {message}',
      'role.user': 'You',
      'role.assistant': 'Assistant',
      'turn': 'turn {n}',
      'count': '×{n}',
    }
    const zh = {
      'button.aria': '在对话中查找',
      'shortcut.label': '在对话中查找',
      'panel.aria': '在对话中查找',
      'input.placeholder': '在对话中查找…',
      'input.aria': '搜索文本',
      'regex.aria': '正则表达式',
      'regex.title': '正则表达式（不区分大小写，多行）',
      'search': '查找',
      'close': '关闭',
      'hint': '在整个会话日志中搜索你的消息和助手回复。Enter 搜索，Esc 关闭。',
      'status.loading': '搜索中…',
      'status.none': '{scanned} 条消息中没有匹配',
      'status.found': '{messages} 条消息中有 {matches} 处匹配',
      'status.truncated': '仅显示前 {shown} 条消息',
      'error.invalid-query': '查询无效：{message}',
      'error.timeout': '搜索耗时过长，已停止',
      'error.not-found': '该会话尚无已保存的日志',
      'error.other': '搜索失败：{message}',
      'role.user': '你',
      'role.assistant': '助手',
      'turn': '第 {n} 轮',
      'count': '×{n}',
    }
    const ru = {
      'button.aria': 'Найти в переписке',
      'shortcut.label': 'Найти в переписке',
      'panel.aria': 'Поиск в переписке',
      'input.placeholder': 'Найти в переписке…',
      'input.aria': 'Текст поиска',
      'regex.aria': 'Регулярное выражение',
      'regex.title': 'Регулярное выражение (без учёта регистра, многострочное)',
      'search': 'Найти',
      'close': 'Закрыть',
      'hint': 'Ищет по вашим сообщениям и ответам ассистента во всём логе сессии. Enter — искать, Esc — закрыть.',
      'status.loading': 'Ищу…',
      'status.none': 'Совпадений нет (просмотрено сообщений: {scanned})',
      'status.found': 'Совпадений: {matches}, сообщений: {messages}',
      'status.truncated': 'показаны первые {shown}',
      'error.invalid-query': 'Неверный запрос: {message}',
      'error.timeout': 'Поиск шёл слишком долго и был остановлен',
      'error.not-found': 'У этой сессии ещё нет сохранённого лога',
      'error.other': 'Поиск не удался: {message}',
      'role.user': 'Вы',
      'role.assistant': 'Ассистент',
      'turn': 'ход {n}',
      'count': '×{n}',
    }

    const CSS = `
.sf-button{flex:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sf-button:hover,.sf-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.sf-button svg{width:15px;height:15px}
.sf-panel{position:fixed;top:52px;right:16px;z-index:1100;box-sizing:border-box;width:min(560px, calc(100vw - 32px));max-height:calc(100vh - 120px);display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.sf-bar{display:flex;align-items:center;gap:6px;padding:10px 10px 8px}
.sf-input{flex:1 1 auto;min-width:0;box-sizing:border-box;height:30px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.sf-input:focus{border-color:var(--dsw-alias-brand-primary)}
.sf-input[data-regex=true]{font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px}
.sf-tool{flex:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:28px;min-width:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.sf-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sf-tool:disabled{cursor:default;opacity:.5}
.sf-tool[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-brand-primary)}
.sf-regex{font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)}
.sf-tool svg{width:14px;height:14px}
.sf-status{padding:0 14px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sf-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.sf-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;border-top:0.5px solid var(--dsw-alias-border-l2);padding:4px 0}
.sf-row{padding:8px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.sf-row:last-child{border-bottom:none}
.sf-meta{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}
.sf-role{font-weight:500;color:var(--dsw-alias-label-secondary)}
.sf-row[data-role=user] .sf-role{color:var(--dsw-alias-brand-primary)}
.sf-count{margin-left:auto}
.sf-snippet{margin-top:2px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);user-select:text}
.sf-snippet mark{border-radius:2px;padding:0 1px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);color:inherit}
`

    function SearchIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: 7, cy: 7, r: 4.5 }),
        h('path', { d: 'M10.4 10.4 14 14' }))
    }

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    function clock(ms) {
      const when = new Date(ms)
      const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      if (when.toDateString() === new Date().toDateString()) return time
      return `${when.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${time}`
    }

    function HeaderButton({ sessionId, useFinder, toggle, t }) {
      const pressed = useFinder(state => state.open && state.sessionId === sessionId)
      return h('button', {
        type: 'button',
        className: 'sf-button',
        'aria-label': t('button.aria'),
        title: t('button.aria'),
        'aria-pressed': pressed,
        onClick: () => { toggle(sessionId) },
      }, h(SearchIcon))
    }

    function Snippet({ snippet }) {
      return h('div', { className: 'sf-snippet' },
        snippet.cutBefore ? '…' : '',
        snippet.before,
        h('mark', null, snippet.match),
        snippet.after,
        snippet.cutAfter ? '…' : '')
    }

    function ResultRow({ row, t }) {
      return h('div', { className: 'sf-row', 'data-role': row.role },
        h('div', { className: 'sf-meta' },
          h('span', { className: 'sf-role' }, t(`role.${row.role}`)),
          typeof row.turn === 'number' && h('span', null, t('turn', { n: row.turn })),
          h('span', null, clock(row.time)),
          row.count > 1 && h('span', { className: 'sf-count' }, t('count', { n: row.count }))),
        row.snippets.map((snippet, index) => h(Snippet, { key: index, snippet })))
    }

    function statusOf(state, t) {
      if (state.status === 'loading') return { tone: 'info', text: t('status.loading') }
      if (state.status === 'error') {
        const key = ['invalid-query', 'timeout', 'not-found'].includes(state.error.code) ? `error.${state.error.code}` : 'error.other'
        return { tone: 'error', text: t(key, { message: state.error.message }) }
      }
      if (state.status === 'done') {
        const r = state.result
        if (r.totalMatches === 0) return { tone: 'info', text: t('status.none', { scanned: r.scanned }) }
        const found = t('status.found', { matches: r.totalMatches, messages: r.totalMessages })
        return { tone: 'info', text: r.truncated ? `${found} · ${t('status.truncated', { shown: r.results.length })}` : found }
      }
      return { tone: 'info', text: t('hint') }
    }

    function Panel({ useFinder, setQuery, toggleRegex, search, close, t }) {
      const state = useFinder(value => value)
      const inputRef = React.useRef(null)

      // Each open request (button or shortcut) moves focus to the query.
      React.useEffect(() => {
        if (!state.open || inputRef.current === null) return
        inputRef.current.focus()
        inputRef.current.select()
      }, [state.open, state.focus])

      if (!state.open) return null
      const status = statusOf(state, t)
      const rows = state.status === 'done' ? state.result.results : []
      return h('div', {
        className: 'sf-panel',
        role: 'dialog',
        'aria-label': t('panel.aria'),
        onKeyDown: (event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          close()
        },
      },
      h('div', { className: 'sf-bar' },
        h('input', {
          ref: inputRef,
          className: 'sf-input',
          type: 'text',
          spellCheck: false,
          autoComplete: 'off',
          'data-regex': state.regex,
          placeholder: t('input.placeholder'),
          'aria-label': t('input.aria'),
          value: state.query,
          onChange: (event) => { setQuery(event.target.value) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            search()
          },
        }),
        h('button', {
          type: 'button',
          className: 'sf-tool sf-regex',
          'aria-pressed': state.regex,
          'aria-label': t('regex.aria'),
          title: t('regex.title'),
          onClick: () => { toggleRegex(); inputRef.current?.focus() },
        }, '.*'),
        h('button', {
          type: 'button',
          className: 'sf-tool',
          disabled: state.query.trim() === '' || state.status === 'loading',
          onClick: () => { search() },
        }, t('search')),
        h('button', { type: 'button', className: 'sf-tool', 'aria-label': t('close'), title: t('close'), onClick: () => { close() } }, h(CloseIcon))),
      h('div', { className: 'sf-status', 'data-tone': status.tone, role: 'status', 'aria-live': 'polite' }, status.text),
      rows.length > 0 && h('div', { className: 'sf-list' },
        rows.map(row => h(ResultRow, { key: row.seq, row, t }))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-find: dictionaries')
        ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'session-find: ru dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'session-find: stylesheet')

        const IDLE = { status: 'idle', result: null, error: null }
        const finder = createSnapshotStore({ open: false, sessionId: null, query: '', regex: false, focus: 0, ...IDLE })
        const update = patch => finder.set({ ...finder.getSnapshot(), ...patch })
        let controller = null
        const cancel = () => { controller?.abort(); controller = null }

        const open = (sessionId) => {
          const state = finder.getSnapshot()
          if (state.sessionId !== sessionId) cancel()
          update({ open: true, sessionId, focus: state.focus + 1, ...(state.sessionId === sessionId ? {} : IDLE) })
        }
        const close = () => { cancel(); update({ open: false, ...(finder.getSnapshot().status === 'loading' ? IDLE : {}) }) }
        const toggle = (sessionId) => {
          const state = finder.getSnapshot()
          if (state.open && state.sessionId === sessionId) close()
          else open(sessionId)
        }
        const setQuery = (query) => { update({ query }) }
        const toggleRegex = () => { update({ regex: !finder.getSnapshot().regex }) }

        const search = async () => {
          const { sessionId, query, regex } = finder.getSnapshot()
          if (sessionId === null || query.trim() === '') return
          cancel()
          const own = new AbortController()
          controller = own
          update({ status: 'loading', error: null })
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionId, query, regex }),
              signal: own.signal,
            })
            const body = await response.json().catch(() => null)
            if (controller !== own) return
            if (!response.ok || body === null) {
              update({ status: 'error', result: null, error: { code: body?.error ?? `http-${response.status}`, message: body?.message ?? `HTTP ${response.status}` } })
              return
            }
            update({ status: 'done', result: body, error: null })
          } catch (error) {
            if (controller !== own) return
            update({ status: 'error', result: null, error: { code: 'network', message: error instanceof Error ? error.message : String(error) } })
          } finally {
            if (controller === own) controller = null
          }
        }

        ctx.effect(() => () => { cancel() }, 'session-find: abort search')

        const actions = { setQuery, toggleRegex, search: () => { void search() }, close }

        // Cmd+F (macOS) / Ctrl+F elsewhere while a Session is open; elsewhere the
        // browser keeps its own find. A fixed action, so Desktop delivers it to
        // the page like any key without an editable binding.
        ctx.inject(['shortcuts', 'sessions'], (scope) => {
          const t = ctx.locale.bind(NS)
          const mainSession = () => Object.values(scope.sessions.list.getSnapshot().byId)
            .find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? null
          const keys = scope.shortcuts.describeBinding({ code: 'KeyF', modifiers: ['primary'] }).keys
          scope.effect(() => scope.shortcuts.registerFixed({
            id: 'session-find.open',
            label: () => t('shortcut.label'),
            keys,
            bindings: [{ code: 'KeyF', modifiers: ['primary'] }],
            group: 'application',
          }), 'session-find: fixed shortcut reference')
          scope.effect(() => scope.shortcuts.observeFixedInput((input) => {
            if (input.type !== 'keydown') return
            const g = input.gesture
            if (g.code !== 'KeyF' || g.composing || g.defaultPrevented || g.repeat || g.alt || g.shift) return
            const mac = scope.shortcuts.platform === 'macos'
            if (mac ? !(g.meta && !g.control) : !(g.control && !g.meta)) return
            if (input.context.region === 'terminal' || input.context.modal !== null) return
            const sessionId = mainSession()
            if (sessionId === null) return
            input.consume()
            open(sessionId)
          }), 'session-find: Cmd+F')
          // The panel belongs to one Session; switching the main view closes it.
          scope.effect(() => scope.sessions.list.subscribe(() => {
            const state = finder.getSnapshot()
            if (state.open && state.sessionId !== mainSession()) close()
          }), 'session-find: follow the main Session')
        })

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'session-find',
          order: 15,
          locale: NS,
          inject: () => ({ hooks: { finder }, toggle }),
        }, HeaderButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-find',
          locale: NS,
          inject: () => ({ hooks: { finder }, ...actions }),
        }, Panel))
      },
    }
  },
})
