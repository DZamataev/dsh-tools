// Client half of session-find: Cmd/Ctrl+F and a Session header button open a
// floating panel that searches the open Session's conversation on the Host
// (its log, not the rendered page) as you type and lists the matches. A match
// opens a context view in the same panel: whole messages around it, read from
// the log, with Markdown and highlighted matches. Results do not navigate the
// chat.
window.__ModuleLoader__.load({
  id: '@local/dsh-session-find',
  factory(require) {
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    // The host's Markdown renderer, as in the chat. Its API is not a plugin
    // contract: when it is missing or throws, messages fall back to plain text.
    let MarkdownText = null
    try {
      MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText ?? null
    } catch {
      MarkdownText = null
    }

    const NS = 'session-find'
    const SEARCH_ROUTE = 'api/session-find.search'
    const CONTEXT_ROUTE = 'api/session-find.context'
    const HIGHLIGHT = 'session-find'
    const PREFS_KEY = 'session-find:prefs'
    const HISTORY_KEY = 'session-find:history'
    const HISTORY_MAX = 20
    const TYPE_DELAY_MS = 300
    const TYPE_MIN_CHARS = 2
    const CONTEXT_INITIAL = 3
    const CONTEXT_STEP = 5
    const CONTEXT_MAX = 100
    const ROLES = { all: ['user', 'assistant'], user: ['user'], assistant: ['assistant'] }

    const en = {
      'button.aria': 'Find in conversation',
      'shortcut.label': 'Find in conversation',
      'panel.aria': 'Find in conversation',
      'input.placeholder': 'Find in conversation…',
      'input.aria': 'Search text',
      'regex.aria': 'Regular expression',
      'regex.title': 'Regular expression (case-insensitive, multiline)',
      'close': 'Close',
      'hint': 'Words match in any order; quote a "phrase". ↑/↓ select, Enter opens, ↑ in an empty field recalls history, Esc closes.',
      'role.all': 'All',
      'role.mine': 'Mine',
      'role.assistantOnly': 'Agent',
      'role.aria': 'Whose messages to search',
      'order.newest': 'Newest first',
      'order.oldest': 'Oldest first',
      'status.loading': 'Searching…',
      'status.none': 'No matches in {scanned} messages',
      'status.found': '{matches} matches in {messages} messages',
      'status.truncated': 'showing the first {shown} messages',
      'error.invalid-query': 'Invalid query: {message}',
      'error.timeout': 'The search took too long and was stopped',
      'error.not-found': 'This session has no saved log yet',
      'error.other': 'Search failed: {message}',
      'role.user': 'You',
      'role.assistant': 'Agent',
      'turn': 'turn {n}',
      'count': '×{n}',
      'result.open': 'Show in context',
      'context.back': 'Results',
      'context.position': '{n} / {total}',
      'context.prev': 'Match above (↑, Shift+Enter)',
      'context.next': 'Match below (↓, Enter)',
      'context.earlier': 'Earlier messages',
      'context.later': 'Later messages',
      'context.start': 'Start of the conversation',
      'context.end': 'End of the conversation',
      'context.loading': 'Loading…',
      'context.error': 'Could not load the messages: {message}',
      'context.cutBefore': '…the beginning of this long message is not shown.',
      'context.cutAfter': '…the rest of this long message is not shown.',
      'context.noHighlight': 'Matches are not highlighted: finding them took too long.',
      'context.target': 'found',
      'copy': 'Copy message',
      'copied': 'Copied',
      'copyFailed': 'Copy failed',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.footnotes': 'Footnotes',
    }
    const zh = {
      'button.aria': '在对话中查找',
      'shortcut.label': '在对话中查找',
      'panel.aria': '在对话中查找',
      'input.placeholder': '在对话中查找…',
      'input.aria': '搜索文本',
      'regex.aria': '正则表达式',
      'regex.title': '正则表达式（不区分大小写，多行）',
      'close': '关闭',
      'hint': '词语顺序不限；用引号查找"短语"。↑/↓ 选择，Enter 打开，空输入框中 ↑ 调出历史，Esc 关闭。',
      'role.all': '全部',
      'role.mine': '我的',
      'role.assistantOnly': '智能体',
      'role.aria': '搜索谁的消息',
      'order.newest': '最新在前',
      'order.oldest': '最早在前',
      'status.loading': '搜索中…',
      'status.none': '{scanned} 条消息中没有匹配',
      'status.found': '{messages} 条消息中有 {matches} 处匹配',
      'status.truncated': '仅显示前 {shown} 条消息',
      'error.invalid-query': '查询无效：{message}',
      'error.timeout': '搜索耗时过长，已停止',
      'error.not-found': '该会话尚无已保存的日志',
      'error.other': '搜索失败：{message}',
      'role.user': '你',
      'role.assistant': '智能体',
      'turn': '第 {n} 轮',
      'count': '×{n}',
      'result.open': '查看上下文',
      'context.back': '结果',
      'context.position': '{n} / {total}',
      'context.prev': '上方的匹配（↑，Shift+Enter）',
      'context.next': '下方的匹配（↓，Enter）',
      'context.earlier': '更早的消息',
      'context.later': '更晚的消息',
      'context.start': '对话开头',
      'context.end': '对话末尾',
      'context.loading': '加载中…',
      'context.error': '无法加载消息：{message}',
      'context.cutBefore': '…此长消息的开头未显示。',
      'context.cutAfter': '…此长消息的其余部分未显示。',
      'context.noHighlight': '未高亮匹配：查找耗时过长。',
      'context.target': '命中',
      'copy': '复制消息',
      'copied': '已复制',
      'copyFailed': '复制失败',
      'md.copy': '复制',
      'md.copied': '已复制',
      'md.footnotes': '脚注',
    }
    const ru = {
      'button.aria': 'Найти в переписке',
      'shortcut.label': 'Найти в переписке',
      'panel.aria': 'Поиск в переписке',
      'input.placeholder': 'Найти в переписке…',
      'input.aria': 'Текст поиска',
      'regex.aria': 'Регулярное выражение',
      'regex.title': 'Регулярное выражение (без учёта регистра, многострочное)',
      'close': 'Закрыть',
      'hint': 'Слова — в любом порядке, «фразу» — в кавычках. ↑/↓ — выбор, Enter — открыть, ↑ в пустом поле — история, Esc — закрыть.',
      'role.all': 'Все',
      'role.mine': 'Мои',
      'role.assistantOnly': 'Агент',
      'role.aria': 'Чьи сообщения искать',
      'order.newest': 'Сначала новые',
      'order.oldest': 'Сначала старые',
      'status.loading': 'Ищу…',
      'status.none': 'Совпадений нет (просмотрено сообщений: {scanned})',
      'status.found': 'Совпадений: {matches}, сообщений: {messages}',
      'status.truncated': 'показаны первые {shown}',
      'error.invalid-query': 'Неверный запрос: {message}',
      'error.timeout': 'Поиск шёл слишком долго и был остановлен',
      'error.not-found': 'У этой сессии ещё нет сохранённого лога',
      'error.other': 'Поиск не удался: {message}',
      'role.user': 'Вы',
      'role.assistant': 'Агент',
      'turn': 'ход {n}',
      'count': '×{n}',
      'result.open': 'Показать в контексте',
      'context.back': 'К результатам',
      'context.position': '{n} из {total}',
      'context.prev': 'Найденное выше (↑, Shift+Enter)',
      'context.next': 'Найденное ниже (↓, Enter)',
      'context.earlier': 'Раньше',
      'context.later': 'Позже',
      'context.start': 'Начало переписки',
      'context.end': 'Конец переписки',
      'context.loading': 'Загрузка…',
      'context.error': 'Не удалось загрузить сообщения: {message}',
      'context.cutBefore': '…начало этого длинного сообщения не показано.',
      'context.cutAfter': '…остаток этого длинного сообщения не показан.',
      'context.noHighlight': 'Совпадения не подсвечены: их поиск занял слишком много времени.',
      'context.target': 'найдено',
      'copy': 'Копировать сообщение',
      'copied': 'Скопировано',
      'copyFailed': 'Не удалось скопировать',
      'md.copy': 'Копировать',
      'md.copied': 'Скопировано',
      'md.footnotes': 'Сноски',
    }

    const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
    const CSS = `
.sf-button{flex:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sf-button:hover,.sf-button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}
.sf-button svg{width:15px;height:15px}
.sf-panel{position:fixed;top:52px;right:16px;z-index:1100;box-sizing:border-box;width:min(560px, calc(100vw - 32px));max-height:calc(100vh - 120px);display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.sf-panel[data-view=context]{width:min(760px, calc(100vw - 32px));height:calc(100vh - 120px)}
.sf-bar{display:flex;align-items:center;gap:6px;padding:10px 10px 6px}
.sf-options{display:flex;align-items:center;gap:6px;padding:0 10px 6px}
.sf-segments{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.sf-segments .sf-tool{height:22px;padding:0 8px}
.sf-spacer{flex:1 1 auto}
.sf-input{flex:1 1 auto;min-width:0;box-sizing:border-box;height:30px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.sf-input:focus{border-color:var(--dsw-alias-brand-primary)}
.sf-input[data-regex=true]{font-family:${MONO};font-size:12px}
.sf-tool{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;height:28px;min-width:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.sf-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sf-tool:disabled{cursor:default;opacity:.5}
.sf-tool[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-brand-primary)}
.sf-regex{font-family:${MONO}}
.sf-tool svg{width:14px;height:14px}
.sf-position{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sf-status{padding:0 14px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sf-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.sf-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;border-top:0.5px solid var(--dsw-alias-border-l2);padding:4px 0}
.sf-row{display:block;box-sizing:border-box;width:100%;padding:8px 14px;border:none;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sf-row:last-child{border-bottom:none}
.sf-row:hover,.sf-row:focus-visible,.sf-row[data-selected=true]{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.sf-meta{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}
.sf-role{font-weight:500;color:var(--dsw-alias-label-secondary)}
[data-role=user] .sf-role{color:var(--dsw-alias-brand-primary)}
.sf-count{margin-left:auto}
.sf-snippet{margin-top:2px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.sf-snippet mark{border-radius:2px;padding:0 1px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);color:inherit}
.sf-context{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;border-top:0.5px solid var(--dsw-alias-border-l2);padding:8px 14px 14px;display:flex;flex-direction:column;gap:10px}
.sf-edge{align-self:center;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.sf-message{padding:8px 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l1);user-select:text}
.sf-message[data-role=user]{background:var(--dsw-alias-bg-layer-1)}
.sf-message[data-target=true]{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary)}
.sf-message .sf-meta{margin-bottom:4px}
.sf-copy{margin-left:auto;height:22px;min-width:22px;padding:0 6px;font-size:11px}
.sf-badge{color:var(--dsw-alias-brand-primary)}
.sf-plain{white-space:pre-wrap;overflow-wrap:anywhere}
.sf-cut{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.sf-context-error{color:var(--dsw-alias-state-error-primary)}
`
    // Theme tokens live on <body>; ::highlight() may resolve var() elsewhere,
    // so the highlight rule carries a literal color read from the panel.
    const WARN_TOKEN = '--dsw-alias-state-warn-primary'
    const WARN_FALLBACK = '#f5a524'
    const highlightRule = color => `::highlight(${HIGHLIGHT}){background-color:color-mix(in srgb, ${color} 40%, transparent);color:inherit}`

    // foldText, advanceIndex and queryTerms match the Host's search.js. The
    // browser never runs the user's query on text: it only checks that it
    // compiles, and highlights the literal strings the Host matched.
    const SPECIAL = /[\\^$.*+?()[\]{}|/]/g
    const foldText = text => text.replace(/[ёЁ]/gu, letter => (letter === 'ё' ? 'е' : 'Е'))
    function advanceIndex(text, index) {
      const unit = text.charCodeAt(index)
      if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) return index + 2
      }
      return index + 1
    }
    function queryTerms(query) {
      const terms = []
      for (const match of query.matchAll(/"([^"]*)"?|(\S+)/gu)) {
        const term = (match[1] ?? match[2]).trim()
        if (term !== '') terms.push(term)
      }
      return terms
    }
    /** Throws a SyntaxError for an empty literal query or an invalid regex; compiling runs nothing. */
    function validateQuery(query, regex) {
      if (regex) { new RegExp(foldText(query), 'gimu'); return }
      if (queryTerms(query).length === 0) throw new SyntaxError('empty query')
    }
    /** A matcher of the Host-supplied matched strings as literals (whitespace runs flexible), or null. */
    function literalMatcher(strings) {
      const sources = [...new Set(strings.map(text => text.split(/\s+/u).filter(Boolean).map(word => word.replace(SPECIAL, '\\$&')).join('\\s+')))]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
      return sources.length === 0 ? null : new RegExp(sources.join('|'), 'giu')
    }

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        return raw === null ? fallback : JSON.parse(raw)
      } catch {
        return fallback
      }
    }
    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (error) {
        console.warn(`session-find: cannot save ${key}`, error)
      }
    }

    function SearchIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: 7, cy: 7, r: 4.5 }),
        h('path', { d: 'M10.4 10.4 14 14' }))
    }
    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }
    function ChevronIcon({ d }) {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d }))
    }
    const BACK = 'M9.5 3.5 5 8l4.5 4.5'
    const UP = 'M3.5 9.5 8 5l4.5 4.5'
    const DOWN = 'M3.5 6.5 8 11l4.5-4.5'

    function clock(ms) {
      const when = new Date(ms)
      const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      if (when.toDateString() === new Date().toDateString()) return time
      return `${when.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${time}`
    }

    function Meta({ message, t, children }) {
      return h('div', { className: 'sf-meta' },
        h('span', { className: 'sf-role' }, t(`role.${message.role}`)),
        typeof message.turn === 'number' && h('span', null, t('turn', { n: message.turn })),
        h('span', null, clock(message.time)),
        children)
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

    function ResultRow({ row, index, selected, openContext, t }) {
      return h('button', {
        type: 'button',
        className: 'sf-row',
        'data-role': row.role,
        'data-index': index,
        'data-selected': selected,
        title: t('result.open'),
        onClick: () => { openContext(index) },
      },
      h(Meta, { message: row, t },
        row.count > 1 && h('span', { className: 'sf-count' }, t('count', { n: row.count }))),
      row.snippets.map((snippet, n) => h(Snippet, { key: n, snippet })))
    }

    /** Renders a message body as Markdown, or as plain text when the host renderer fails. */
    class MessageBody extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('session-find: Markdown rendering failed; showing plain text', error)
      }

      render() {
        const { text, labels } = this.props
        if (MarkdownText === null || this.state.failed) return h('div', { className: 'sf-plain' }, text)
        return h(MarkdownText, { text, labels, variant: 'compact' })
      }
    }

    function CopyButton({ text, t }) {
      const [state, setState] = React.useState('idle')
      React.useEffect(() => {
        if (state === 'idle') return undefined
        const timer = setTimeout(() => { setState('idle') }, 1500)
        return () => { clearTimeout(timer) }
      }, [state])
      const label = state === 'copied' ? t('copied') : state === 'failed' ? t('copyFailed') : t('copy')
      return h('button', {
        type: 'button',
        className: 'sf-tool sf-copy',
        title: label,
        'aria-label': label,
        onClick: () => {
          const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard access'))
          write.then(() => { setState('copied') }, (error) => {
            console.error('session-find: clipboard write failed', error)
            setState('failed')
          })
        },
      }, state === 'idle' ? '⧉' : label)
    }

    function ContextMessage({ message, target, labels, t }) {
      return h('div', { className: 'sf-message', 'data-role': message.role, 'data-target': target, 'data-seq': message.seq },
        h(Meta, { message, t },
          target && h('span', { className: 'sf-badge' }, `· ${t('context.target')}`),
          h(CopyButton, { text: message.text, t })),
        message.cutBefore && h('div', { className: 'sf-cut' }, t('context.cutBefore')),
        h(MessageBody, { text: message.text, labels }),
        message.cutAfter && h('div', { className: 'sf-cut' }, t('context.cutAfter')))
    }

    /** Paint every match inside the messages through the CSS Custom Highlight API; returns the ranges inside `target`. */
    function paintMatches(root, matcher, target) {
      const ranges = []
      const inTarget = []
      for (const message of root.querySelectorAll('.sf-message')) {
        const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          // The copy button and meta row carry no message text.
          if (node.parentElement?.closest('.sf-meta') !== null) continue
          const text = foldText(node.nodeValue ?? '')
          matcher.lastIndex = 0
          let match
          while ((match = matcher.exec(text)) !== null) {
            if (match[0].length === 0) {
              if (match.index >= text.length) break
              matcher.lastIndex = advanceIndex(text, match.index)
              continue
            }
            const range = new Range()
            range.setStart(node, match.index)
            range.setEnd(node, match.index + match[0].length)
            ranges.push(range)
            if (target !== null && target.contains(node)) inTarget.push(range)
          }
        }
      }
      if (typeof CSS !== 'undefined' && CSS.highlights !== undefined && typeof Highlight === 'function') {
        CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges))
      } else {
        console.warn('session-find: this browser has no CSS Custom Highlight API; matches stay unhighlighted')
      }
      return { inTarget, count: ranges.length }
    }

    function ContextView({ state, more, t }) {
      const context = state.context
      const scrollRef = React.useRef(null)
      const ruleRef = React.useRef(null)
      const labels = React.useMemo(() => ({
        code: { copyLabel: t('md.copy'), copiedLabel: t('md.copied') },
        footnotes: t('md.footnotes'),
      }), [t])
      const data = context.data

      // After each load: paint matches, then place the view — on the first
      // match in the found message when opened, or on the message that was at
      // the top before earlier messages were prepended. Code blocks re-render
      // their text when syntax highlighting arrives, which detaches painted
      // ranges, so DOM changes inside the messages repaint (without moving
      // the view).
      React.useLayoutEffect(() => {
        const root = scrollRef.current
        if (root === null || data === null) return undefined
        if (ruleRef.current !== null) {
          const color = getComputedStyle(root).getPropertyValue(WARN_TOKEN).trim() || WARN_FALLBACK
          ruleRef.current.textContent = highlightRule(color)
        }
        const matcher = literalMatcher(data.highlights ?? [])
        const target = () => root.querySelector(`[data-seq="${context.seq}"]`)
        const paint = () => (matcher === null ? { inTarget: [], count: 0 } : paintMatches(root, matcher, target()))
        const painted = paint()
        if (data.highlights !== null && painted.count === 0) console.warn('session-find: no match found in the rendered context text')
        if (context.keep !== null) {
          root.querySelector(`[data-seq="${context.keep}"]`)?.scrollIntoView({ block: 'start' })
        } else if (context.placed === false) {
          // Literal highlighting can mark text the query did not match; the Host's
          // ordinal names which highlighted occurrence is the real first match.
          const first = painted.inTarget[data.targetOrdinal ?? 0] ?? painted.inTarget[0] ?? null
          const anchor = first?.startContainer.parentElement ?? target()
          anchor?.scrollIntoView({ block: first === null ? 'start' : 'center' })
        }
        let frame = 0
        const observer = new MutationObserver(() => {
          if (frame !== 0) return
          frame = requestAnimationFrame(() => { frame = 0; paint() })
        })
        for (const message of root.querySelectorAll('.sf-message')) {
          observer.observe(message, { childList: true, subtree: true, characterData: true })
        }
        return () => {
          observer.disconnect()
          cancelAnimationFrame(frame)
          if (typeof CSS !== 'undefined' && CSS.highlights !== undefined) CSS.highlights.delete(HIGHLIGHT)
        }
      }, [data])

      const busy = context.status === 'loading'
      return h('div', { ref: scrollRef, className: 'sf-context' },
        h('style', { ref: ruleRef }),
        context.status === 'error' && h('div', { className: 'sf-context-error' }, t('context.error', { message: context.error })),
        data !== null && data.highlightError !== null && h('div', { className: 'sf-edge' }, t('context.noHighlight')),
        data === null && busy && h('div', { className: 'sf-edge' }, t('context.loading')),
        data !== null && (data.hasEarlier && context.before < CONTEXT_MAX
          ? h('button', { type: 'button', className: 'sf-tool', style: { alignSelf: 'center' }, disabled: busy, onClick: () => { more('before') } }, busy ? t('context.loading') : t('context.earlier'))
          : h('div', { className: 'sf-edge' }, data.hasEarlier ? '…' : t('context.start'))),
        data !== null && data.messages.map(message => h(ContextMessage, { key: message.seq, message, target: message.seq === context.seq, labels, t })),
        data !== null && (data.hasLater && context.after < CONTEXT_MAX
          ? h('button', { type: 'button', className: 'sf-tool', style: { alignSelf: 'center' }, disabled: busy, onClick: () => { more('after') } }, busy ? t('context.loading') : t('context.later'))
          : h('div', { className: 'sf-edge' }, data.hasLater ? '…' : t('context.end'))))
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

    function Panel(props) {
      const { useFinder, setQuery, setRegex, setOrder, setRole, enter, select, openContext, closeContext, step, canStep, more, close, history, t } = props
      const state = useFinder(value => value)
      const inputRef = React.useRef(null)
      const listRef = React.useRef(null)
      const historyIndex = React.useRef(-1)
      const inContext = state.context !== null
      const rows = state.status === 'done' ? state.result.results : []

      // Each open request (button or shortcut) moves focus to the query.
      React.useEffect(() => {
        if (!state.open || inputRef.current === null) return
        inputRef.current.focus()
        inputRef.current.select()
      }, [state.open, state.focus])

      React.useEffect(() => {
        listRef.current?.querySelector(`[data-index="${state.selected}"]`)?.scrollIntoView({ block: 'nearest' })
      }, [state.selected, state.result])

      if (!state.open) return null
      const status = statusOf(state, t)

      const recall = (direction) => {
        const entries = history()
        const next = historyIndex.current + direction
        if (next < -1 || next >= entries.length) return
        historyIndex.current = next
        const entry = next === -1 ? { query: '', regex: state.regex } : entries[next]
        setRegex(entry.regex)
        setQuery(entry.query)
      }

      const onKeyDown = (event) => {
        if (event.nativeEvent.isComposing) return
        const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
        if (vertical !== 0) {
          event.preventDefault()
          if (state.query === '' || historyIndex.current >= 0) recall(-vertical)
          else if (inContext) step(vertical)
          else select(vertical)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          enter(event.shiftKey ? -1 : 1)
        }
      }

      // Counted in conversation order, so ↓ (the match below) always counts up.
      const position = inContext && rows.length > 0
        ? t('context.position', { n: state.searched?.order === 'newest' ? rows.length - state.context.index : state.context.index + 1, total: rows.length })
        : ''
      return h('div', {
        className: 'sf-panel',
        role: 'dialog',
        'aria-label': t('panel.aria'),
        'data-view': inContext ? 'context' : 'list',
        onKeyDown: (event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          if (inContext) closeContext()
          else close()
        },
      },
      h('div', { className: 'sf-bar' },
        inContext && h('button', { type: 'button', className: 'sf-tool', onClick: () => { closeContext() } }, h(ChevronIcon, { d: BACK }), t('context.back')),
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
          onChange: (event) => { historyIndex.current = -1; setQuery(event.target.value) },
          onKeyDown,
        }),
        inContext && h('span', { className: 'sf-position' }, position),
        inContext && h('button', { type: 'button', className: 'sf-tool', title: t('context.prev'), 'aria-label': t('context.prev'), disabled: !canStep(state, -1), onClick: () => { step(-1) } }, h(ChevronIcon, { d: UP })),
        inContext && h('button', { type: 'button', className: 'sf-tool', title: t('context.next'), 'aria-label': t('context.next'), disabled: !canStep(state, 1), onClick: () => { step(1) } }, h(ChevronIcon, { d: DOWN })),
        h('button', {
          type: 'button',
          className: 'sf-tool sf-regex',
          'aria-pressed': state.regex,
          'aria-label': t('regex.aria'),
          title: t('regex.title'),
          onClick: () => { setRegex(!state.regex); inputRef.current?.focus() },
        }, '.*'),
        h('button', { type: 'button', className: 'sf-tool', 'aria-label': t('close'), title: t('close'), onClick: () => { close() } }, h(CloseIcon))),
      !inContext && h('div', { className: 'sf-options' },
        h('div', { className: 'sf-segments', role: 'group', 'aria-label': t('role.aria') },
          [['all', 'role.all'], ['user', 'role.mine'], ['assistant', 'role.assistantOnly']].map(([role, key]) => h('button', {
            key: role,
            type: 'button',
            className: 'sf-tool',
            'aria-pressed': state.role === role,
            onClick: () => { setRole(role); inputRef.current?.focus() },
          }, t(key)))),
        h('span', { className: 'sf-spacer' }),
        h('button', {
          type: 'button',
          className: 'sf-tool',
          onClick: () => { setOrder(state.order === 'newest' ? 'oldest' : 'newest'); inputRef.current?.focus() },
        }, state.order === 'newest' ? `↓ ${t('order.newest')}` : `↑ ${t('order.oldest')}`)),
      !inContext && h('div', { className: 'sf-status', 'data-tone': status.tone, role: 'status', 'aria-live': 'polite' }, status.text),
      !inContext && rows.length > 0 && h('div', { ref: listRef, className: 'sf-list' },
        rows.map((row, index) => h(ResultRow, { key: row.seq, row, index, selected: index === state.selected, openContext, t }))),
      inContext && h(ContextView, { state, more, t }))
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

        const stored = readJson(PREFS_KEY, {})
        const prefs = {
          regex: stored.regex === true,
          order: stored.order === 'oldest' ? 'oldest' : 'newest',
          role: Object.hasOwn(ROLES, stored.role) ? stored.role : 'all',
        }
        const IDLE = { status: 'idle', result: null, error: null, searched: null, selected: 0, context: null }
        const finder = createSnapshotStore({ open: false, sessionId: null, query: '', focus: 0, ...prefs, ...IDLE })
        const update = patch => finder.set({ ...finder.getSnapshot(), ...patch })
        const updateContext = patch => update({ context: { ...finder.getSnapshot().context, ...patch } })
        const savePrefs = () => {
          const { regex, order, role } = finder.getSnapshot()
          writeJson(PREFS_KEY, { regex, order, role })
        }

        const history = () => {
          const value = readJson(HISTORY_KEY, [])
          return Array.isArray(value) ? value.filter(entry => typeof entry?.query === 'string' && typeof entry.regex === 'boolean') : []
        }
        const remember = () => {
          const searched = finder.getSnapshot().searched
          if (searched === null) return
          const entry = { query: searched.query, regex: searched.regex }
          const rest = history().filter(item => item.query !== entry.query || item.regex !== entry.regex)
          writeJson(HISTORY_KEY, [entry, ...rest].slice(0, HISTORY_MAX))
        }

        let controller = null
        let contextController = null
        let timer = 0
        const cancelContext = () => { contextController?.abort(); contextController = null }
        const cancel = () => { clearTimeout(timer); timer = 0; controller?.abort(); controller = null; cancelContext() }
        ctx.effect(() => () => { cancel() }, 'session-find: abort requests and timers')

        const post = (route, body, signal) => fetch(route, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal,
        }).then(async (response) => {
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null) {
            throw Object.assign(new Error(payload?.message ?? `HTTP ${response.status}`), { code: payload?.error ?? `http-${response.status}` })
          }
          return payload
        })

        const sameAsSearched = () => {
          const { query, regex, order, role, searched } = finder.getSnapshot()
          return searched !== null && searched.query === query && searched.regex === regex && searched.order === order && searched.role === role
        }

        const search = async () => {
          clearTimeout(timer)
          timer = 0
          const { sessionId, query, regex, order, role } = finder.getSnapshot()
          if (sessionId === null) return
          cancel()
          try {
            validateQuery(query, regex)
          } catch (error) {
            // An empty or half-typed regex is checked here, without a request.
            if (query.trim() === '') update({ ...IDLE })
            else update({ ...IDLE, status: 'error', error: { code: 'invalid-query', message: error instanceof Error ? error.message : String(error) } })
            return
          }
          const own = new AbortController()
          controller = own
          update({ status: 'loading', error: null, context: null })
          try {
            const result = await post(SEARCH_ROUTE, { sessionId, query, regex, order, roles: ROLES[role] }, own.signal)
            if (controller !== own) return
            update({ status: 'done', result, error: null, selected: 0, searched: { query, regex, order, role } })
          } catch (error) {
            if (controller !== own) return
            update({ status: 'error', result: null, error: { code: error?.code ?? 'network', message: error instanceof Error ? error.message : String(error) } })
          } finally {
            if (controller === own) controller = null
          }
        }

        /** Search after a typing pause; short literal queries wait for Enter. */
        const schedule = () => {
          clearTimeout(timer)
          timer = 0
          const { query, regex } = finder.getSnapshot()
          if (query.trim() === '') { cancel(); update({ ...IDLE }); return }
          if (!regex && query.trim().length < TYPE_MIN_CHARS) return
          timer = setTimeout(() => { void search() }, TYPE_DELAY_MS)
        }

        const open = (sessionId) => {
          const state = finder.getSnapshot()
          if (state.sessionId !== sessionId) cancel()
          update({ open: true, sessionId, focus: state.focus + 1, ...(state.sessionId === sessionId ? {} : IDLE) })
        }
        const close = () => {
          cancel()
          update({ open: false, context: null, ...(finder.getSnapshot().status === 'loading' ? IDLE : {}) })
        }
        const toggle = (sessionId) => {
          const state = finder.getSnapshot()
          if (state.open && state.sessionId === sessionId) close()
          else open(sessionId)
        }
        const setQuery = (query) => { update({ query }); schedule() }
        const setOption = (patch) => { update(patch); savePrefs(); schedule() }

        /** Load the context window; `keep` is the seq to keep at the top after prepending. */
        const loadContext = async (keep) => {
          const { sessionId, context, searched } = finder.getSnapshot()
          if (sessionId === null || context === null || searched === null) return
          cancelContext()
          const own = new AbortController()
          contextController = own
          updateContext({ status: 'loading', error: null })
          try {
            const data = await post(CONTEXT_ROUTE, { sessionId, seq: context.seq, before: context.before, after: context.after, query: searched.query, regex: searched.regex, focus: context.focus }, own.signal)
            if (contextController !== own) return
            const placed = finder.getSnapshot().context.data !== null
            updateContext({ status: 'done', data, keep, placed })
          } catch (error) {
            if (contextController !== own) return
            updateContext({ status: 'error', error: error instanceof Error ? error.message : String(error) })
          } finally {
            if (contextController === own) contextController = null
          }
        }

        const openContext = (index) => {
          const { result, searched } = finder.getSnapshot()
          const row = result?.results[index]
          if (searched === null || row === undefined) return
          remember()
          update({ selected: index, context: { index, seq: row.seq, focus: typeof row.first === 'number' ? row.first : null, before: CONTEXT_INITIAL, after: CONTEXT_INITIAL, status: 'idle', data: null, error: null, keep: null, placed: false } })
          void loadContext(null)
        }
        const closeContext = () => { cancelContext(); update({ context: null }) }
        /**
         * Move to the found message below (+1, later in the conversation) or
         * above (-1). Newest-first results run upwards through the conversation,
         * so the list index moves the other way there.
         */
        const step = (direction) => {
          const { context, result, searched } = finder.getSnapshot()
          if (context === null || result === null) return
          const index = context.index + (searched?.order === 'newest' ? -direction : direction)
          if (index >= 0 && index < result.results.length) openContext(index)
        }
        /** Whether a found message exists above (-1) or below (+1) the open one. */
        const canStep = (state, direction) => {
          if (state.context === null || state.result === null) return false
          const index = state.context.index + (state.searched?.order === 'newest' ? -direction : direction)
          return index >= 0 && index < state.result.results.length
        }
        const select = (delta) => {
          const { selected, result } = finder.getSnapshot()
          const count = result?.results.length ?? 0
          if (count > 0) update({ selected: Math.min(count - 1, Math.max(0, selected + delta)) })
        }
        /** Enter: search now when the shown results are stale, else open or step. */
        const enter = (direction) => {
          const state = finder.getSnapshot()
          if (timer !== 0 || state.status === 'loading' || !sameAsSearched()) {
            void search().then(() => { if (finder.getSnapshot().status === 'done') remember() })
            return
          }
          remember()
          if (state.context !== null) step(direction)
          else if (direction > 0) openContext(state.selected)
        }
        const more = (direction) => {
          const context = finder.getSnapshot().context
          if (context === null || context.data === null) return
          const keep = direction === 'before' ? context.data.messages[0]?.seq ?? null : null
          updateContext({ [direction]: Math.min(CONTEXT_MAX, context[direction] + CONTEXT_STEP) })
          void loadContext(keep)
        }

        const actions = {
          setQuery,
          setRegex: (regex) => { setOption({ regex }) },
          setOrder: (order) => { setOption({ order }) },
          setRole: (role) => { setOption({ role }) },
          enter, select, openContext, closeContext, step, canStep, more, close, history,
        }

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
