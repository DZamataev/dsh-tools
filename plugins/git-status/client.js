// Client half of git-status: a pill in the composer dock naming the session's
// git branch (or its directory outside a repository), opening a panel with the
// directory, its size, a copy-path button, and a short git status.
window.__ModuleLoader__.load({
  id: '@local/dsh-git-status',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NS = 'git-status'
    const SUMMARY_ROUTE = 'api/git-status.summary'
    const SIZE_ROUTE = 'api/git-status.size'
    const DEFAULT_POLL_MS = 10_000
    const PANEL_WIDTH = 400
    const PANEL_MARGIN = 12
    const PANEL_GAP = 8
    const COPIED_MS = 1_500

    const en = {
      'pill.aria': 'Branch {branch} in {path}',
      'pill.ariaDir': 'Directory {path}',
      'pill.detached': 'detached {sha}',
      'pill.noCommits': 'no commits',
      'title': 'Working directory',
      'copy': 'Copy path',
      'copied': 'Copied',
      'copyFailed': 'Copy failed',
      'size': 'Size',
      'size.measuring': 'measuring…',
      'size.partial': '{size} (some folders unreadable)',
      'size.timeout': 'took too long',
      'size.unavailable': 'unavailable',
      'size.recalculate': 'Recalculate',
      'missing': 'This directory no longer exists.',
      'loading': 'Loading…',
      'loadError': 'Could not read the directory: {error}',
      'notRepo': 'Not a git repository.',
      'git.missing': 'git is not installed or not on PATH.',
      'git.timeout': 'git status took too long.',
      'git.failed': 'git status failed: {message}',
      'branch': 'Branch',
      'branch.detached': 'detached at {sha}',
      'branch.unborn': '{branch} (no commits yet)',
      'upstream': 'Upstream',
      'upstream.none': 'none',
      'upstream.sync': 'up to date',
      'upstream.ab': '↑{ahead} ↓{behind}',
      'commit': 'Last commit',
      'repository': 'Repository',
      'changes.clean': 'Working tree clean',
      'changes.staged': '{n} staged',
      'changes.unstaged': '{n} modified',
      'changes.untracked': '{n} untracked',
      'changes.conflicted': '{n} conflicted',
      'changes.more': '… and {n} more',
      'refresh': 'Refresh',
      'ago.now': 'just now',
      'ago.minutes': '{n} min ago',
      'ago.hours': '{n} h ago',
      'ago.days': '{n} d ago',
    }
    const ru = {
      'pill.aria': 'Ветка {branch} в {path}',
      'pill.ariaDir': 'Папка {path}',
      'pill.detached': 'detached {sha}',
      'pill.noCommits': 'нет коммитов',
      'title': 'Рабочая папка',
      'copy': 'Копировать путь',
      'copied': 'Скопировано',
      'copyFailed': 'Не удалось скопировать',
      'size': 'Размер',
      'size.measuring': 'считаю…',
      'size.partial': '{size} (часть папок недоступна)',
      'size.timeout': 'слишком долго',
      'size.unavailable': 'недоступен',
      'size.recalculate': 'Пересчитать',
      'missing': 'Этой папки больше нет.',
      'loading': 'Загрузка…',
      'loadError': 'Не удалось прочитать папку: {error}',
      'notRepo': 'Не git-репозиторий.',
      'git.missing': 'git не установлен или не найден в PATH.',
      'git.timeout': 'git status выполнялся слишком долго.',
      'git.failed': 'git status завершился с ошибкой: {message}',
      'branch': 'Ветка',
      'branch.detached': 'detached на {sha}',
      'branch.unborn': '{branch} (коммитов ещё нет)',
      'upstream': 'Upstream',
      'upstream.none': 'нет',
      'upstream.sync': 'синхронизирована',
      'upstream.ab': '↑{ahead} ↓{behind}',
      'commit': 'Последний коммит',
      'repository': 'Репозиторий',
      'changes.clean': 'Изменений нет',
      'changes.staged': 'в индексе: {n}',
      'changes.unstaged': 'изменено: {n}',
      'changes.untracked': 'новых: {n}',
      'changes.conflicted': 'конфликтов: {n}',
      'changes.more': '… и ещё {n}',
      'refresh': 'Обновить',
      'ago.now': 'только что',
      'ago.minutes': '{n} мин назад',
      'ago.hours': '{n} ч назад',
      'ago.days': '{n} дн назад',
    }
    const zh = {
      'pill.aria': '{path} 中的分支 {branch}',
      'pill.ariaDir': '目录 {path}',
      'pill.detached': '游离 {sha}',
      'pill.noCommits': '无提交',
      'title': '工作目录',
      'copy': '复制路径',
      'copied': '已复制',
      'copyFailed': '复制失败',
      'size': '大小',
      'size.measuring': '计算中…',
      'size.partial': '{size}（部分文件夹不可读）',
      'size.timeout': '耗时过长',
      'size.unavailable': '不可用',
      'size.recalculate': '重新计算',
      'missing': '该目录已不存在。',
      'loading': '加载中…',
      'loadError': '无法读取目录：{error}',
      'notRepo': '不是 git 仓库。',
      'git.missing': '未安装 git 或不在 PATH 中。',
      'git.timeout': 'git status 耗时过长。',
      'git.failed': 'git status 失败：{message}',
      'branch': '分支',
      'branch.detached': '游离于 {sha}',
      'branch.unborn': '{branch}（尚无提交）',
      'upstream': '上游',
      'upstream.none': '无',
      'upstream.sync': '已同步',
      'upstream.ab': '↑{ahead} ↓{behind}',
      'commit': '最近提交',
      'repository': '仓库',
      'changes.clean': '工作区干净',
      'changes.staged': '已暂存 {n}',
      'changes.unstaged': '已修改 {n}',
      'changes.untracked': '未跟踪 {n}',
      'changes.conflicted': '冲突 {n}',
      'changes.more': '… 另有 {n} 项',
      'refresh': '刷新',
      'ago.now': '刚刚',
      'ago.minutes': '{n} 分钟前',
      'ago.hours': '{n} 小时前',
      'ago.days': '{n} 天前',
    }

    const CSS = `
.gs-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px))}
.gs-pill{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;min-width:0;max-width:240px;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font:inherit;line-height:inherit;white-space:nowrap;cursor:pointer}
.gs-pill:hover,.gs-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.gs-pill svg{width:14px;height:14px;flex:none}
.gs-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.gs-dirty{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warn-primary)}
.gs-ab{flex:none;font-variant-numeric:tabular-nums}
.gs-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(${PANEL_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px));max-height:min(70vh, 560px);overflow-y:auto;overscroll-behavior:contain;padding:16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;display:flex;flex-direction:column;gap:10px}
.gs-head{display:flex;justify-content:space-between;align-items:center;gap:12px}
.gs-dir{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-primary);font-weight:500;font-size:13px}
.gs-dir svg{width:16px;height:16px;flex:none;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.gs-dir span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gs-path{margin-top:-6px;font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));overflow-wrap:anywhere;user-select:text}
.gs-rule{border-top:0.5px solid var(--dsw-alias-border-l2)}
.gs-grid{display:grid;grid-template-columns:auto minmax(0, 1fr);gap:4px 12px;align-items:baseline}
.gs-key{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.gs-val{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.gs-val-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.gs-mono{font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)}
.gs-muted{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.gs-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.gs-counts{display:flex;flex-wrap:wrap;gap:2px 10px}
.gs-count[data-kind=staged]{color:var(--dsw-alias-state-success-primary)}
.gs-count[data-kind=unstaged]{color:var(--dsw-alias-state-warn-primary)}
.gs-count[data-kind=conflicted]{color:var(--dsw-alias-state-error-primary)}
.gs-status{margin:0;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1, transparent);font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:11px;line-height:16px;white-space:pre;overflow-x:auto;color:var(--dsw-alias-label-secondary);user-select:text}
.gs-xy-staged{color:var(--dsw-alias-state-success-primary)}
.gs-xy-unstaged{color:var(--dsw-alias-state-warn-primary)}
.gs-xy-conflict{color:var(--dsw-alias-state-error-primary)}
.gs-foot{display:flex;justify-content:flex-end}
.gs-button{display:inline-flex;align-items:center;gap:4px;flex:none;padding:2px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:nowrap}
.gs-button svg{width:14px;height:14px;flex:none}
.gs-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.gs-button:disabled{cursor:default;opacity:.6}
.gs-button[data-done=true]{color:var(--dsw-alias-state-success-primary)}
.gs-link{padding:0 4px;font-size:11px}
`

    // ---- pure helpers -------------------------------------------------------

    function abbreviate(path, home) {
      if (typeof home !== 'string' || home === '' || typeof path !== 'string') return path ?? ''
      if (path === home) return '~'
      return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
    }

    function basename(path) {
      const trimmed = String(path ?? '').replace(/[\\/]+$/, '')
      const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed
    }

    const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte']
    function formatBytes(bytes) {
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024
        unit += 1
      }
      try {
        return new Intl.NumberFormat(undefined, { style: 'unit', unit: UNITS[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)
      } catch {
        return `${value.toFixed(unit === 0 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
      }
    }

    function ago(time, t) {
      const minutes = Math.floor((Date.now() - time) / 60_000)
      if (minutes < 1) return t('ago.now')
      if (minutes < 60) return t('ago.minutes', { n: minutes })
      if (minutes < 48 * 60) return t('ago.hours', { n: Math.floor(minutes / 60) })
      return t('ago.days', { n: Math.floor(minutes / 1440) })
    }

    const shortSha = oid => (typeof oid === 'string' ? oid.slice(0, 7) : '')

    /** Pill caption: branch, detached sha, or the directory name outside a repository. */
    function pillLabel(data, cwd, t) {
      const git = data?.git
      if (git !== null && git !== undefined && git.error === null) {
        if (git.branch !== null) return { kind: 'branch', text: git.branch }
        if (git.detached) return { kind: 'branch', text: t('pill.detached', { sha: shortSha(git.oid) }) }
        return { kind: 'branch', text: t('pill.noCommits') }
      }
      return { kind: 'dir', text: data?.name ?? basename(cwd) }
    }

    /** The two status columns, colored like `git status --short`: index green, worktree warn, conflicts red. */
    function StatusCode({ xy }) {
      if (xy === '??') return h('span', { className: 'gs-xy-unstaged' }, '??')
      if (/U/.test(xy) || xy === 'AA' || xy === 'DD') return h('span', { className: 'gs-xy-conflict' }, xy)
      return h(React.Fragment, null,
        h('span', { className: 'gs-xy-staged' }, xy[0]),
        h('span', { className: 'gs-xy-unstaged' }, xy[1]))
    }

    // ---- icons --------------------------------------------------------------

    function BranchIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('circle', { cx: 4.5, cy: 3.5, r: 1.6 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.6 }),
        h('circle', { cx: 11.5, cy: 5, r: 1.6 }),
        h('path', { d: 'M4.5 5.1v5.8M11.5 6.6c0 2.6-2.2 3.4-5.4 4.3' }))
    }

    function FolderIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M2 4.5a1 1 0 0 1 1-1h3.2l1.4 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z' }))
    }

    function CopyIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
        h('path', { d: 'M10.5 3.5v-.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5' }))
    }

    // ---- components ---------------------------------------------------------

    async function writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // Fallback for contexts where the async clipboard is unavailable.
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.append(area)
        area.select()
        let ok = false
        try { ok = document.execCommand('copy') } catch { ok = false }
        area.remove()
        return ok
      }
    }

    function CopyButton({ text, t }) {
      const [state, setState] = React.useState('idle')
      React.useEffect(() => {
        if (state === 'idle') return undefined
        const timer = setTimeout(() => { setState('idle') }, COPIED_MS)
        return () => { clearTimeout(timer) }
      }, [state])
      const label = state === 'done' ? t('copied') : state === 'failed' ? t('copyFailed') : t('copy')
      return h('button', {
        type: 'button',
        className: 'gs-button',
        'data-done': String(state === 'done'),
        onClick: () => { void writeClipboard(text).then(ok => { setState(ok ? 'done' : 'failed') }) },
      }, h(CopyIcon), label)
    }

    function SizeRow({ size, remeasure, t }) {
      let value
      if (size === undefined || (size.loading && size.bytes == null)) value = h('span', { className: 'gs-muted' }, t('size.measuring'))
      else if (size.error === 'timeout') value = h('span', { className: 'gs-muted' }, t('size.timeout'))
      else if (size.error !== null && size.error !== undefined) value = h('span', { className: 'gs-muted', title: size.message || size.error }, t('size.unavailable'))
      else value = size.partial ? t('size.partial', { size: formatBytes(size.bytes) }) : formatBytes(size.bytes)
      return [
        h('span', { key: 'k', className: 'gs-key' }, t('size')),
        h('span', { key: 'v', className: 'gs-val gs-val-row' },
          h('span', null, value),
          h('button', {
            type: 'button',
            className: 'gs-button gs-link',
            disabled: size?.loading === true,
            onClick: () => { remeasure() },
          }, t('size.recalculate'))),
      ]
    }

    function GitSection({ git, home, cwd, t }) {
      if (git === null) return h('div', { className: 'gs-muted' }, t('notRepo'))
      if (git.error === 'git-missing') return h('div', { className: 'gs-error' }, t('git.missing'))
      if (git.error === 'timeout') return h('div', { className: 'gs-error' }, t('git.timeout'))
      if (git.error !== null) return h('div', { className: 'gs-error' }, t('git.failed', { message: git.message || git.error }))

      const branch = git.branch !== null
        ? (git.oid === null ? t('branch.unborn', { branch: git.branch }) : git.branch)
        : t('branch.detached', { sha: shortSha(git.oid) })
      const upstream = git.upstream === null
        ? h('span', { className: 'gs-muted' }, t('upstream.none'))
        : h('span', null, git.upstream, ' ',
          h('span', { className: 'gs-muted' }, git.ahead === 0 && git.behind === 0
            ? `· ${t('upstream.sync')}`
            : `· ${t('upstream.ab', { ahead: git.ahead ?? 0, behind: git.behind ?? 0 })}`))
      const counts = [
        ['staged', git.staged], ['unstaged', git.unstaged], ['untracked', git.untracked], ['conflicted', git.conflicted],
      ].filter(([, n]) => n > 0)
      const hidden = git.total - git.lines.length

      return h(React.Fragment, null,
        h('div', { className: 'gs-grid' },
          h('span', { className: 'gs-key' }, t('branch')),
          h('span', { className: 'gs-val gs-mono' }, branch),
          h('span', { className: 'gs-key' }, t('upstream')),
          h('span', { className: 'gs-val' }, upstream),
          git.lastCommit !== null && h('span', { className: 'gs-key' }, t('commit')),
          git.lastCommit !== null && h('span', { className: 'gs-val', title: git.lastCommit.subject },
            h('span', { className: 'gs-mono' }, git.lastCommit.sha), ' ', git.lastCommit.subject, ' ',
            h('span', { className: 'gs-muted' }, `· ${ago(git.lastCommit.time, t)}`)),
          git.root !== null && git.root !== cwd && h('span', { className: 'gs-key' }, t('repository')),
          git.root !== null && git.root !== cwd && h('span', { className: 'gs-val gs-mono' }, abbreviate(git.root, home))),
        h('div', { className: 'gs-rule', 'aria-hidden': true }),
        counts.length === 0
          ? h('div', { className: 'gs-muted' }, t('changes.clean'))
          : h('div', { className: 'gs-counts' }, counts.map(([kind, n]) =>
            h('span', { key: kind, className: 'gs-count', 'data-kind': kind }, t(`changes.${kind}`, { n })))),
        git.lines.length > 0 && h('pre', { className: 'gs-status' },
          git.lines.map((line, index) => h('div', { key: index },
            h(StatusCode, { xy: line.xy }), ' ',
            line.orig === null ? line.path : `${line.orig} -> ${line.path}`)),
          hidden > 0 && h('div', { className: 'gs-muted' }, t('changes.more', { n: hidden }))))
    }

    function Panel({ entry, cwd, refresh, remeasure, t, panelRef, position }) {
      const data = entry?.data ?? null
      const path = data?.cwd ?? cwd ?? ''
      const home = data?.home
      return h('div', { ref: panelRef, className: 'gs-panel', role: 'dialog', 'aria-label': t('title'), style: position },
        h('div', { className: 'gs-head' },
          h('span', { className: 'gs-dir', title: path }, h(FolderIcon), h('span', null, data?.name ?? basename(path))),
          path !== '' && h(CopyButton, { text: path, t })),
        h('div', { className: 'gs-path' }, abbreviate(path, home)),
        entry?.error != null && h('div', { className: 'gs-error' }, t('loadError', { error: entry.error })),
        data === null && entry?.error == null && h('div', { className: 'gs-muted' }, t('loading')),
        data !== null && data.exists === false && h('div', { className: 'gs-error' }, t('missing')),
        data !== null && data.exists !== false && h(React.Fragment, null,
          h('div', { className: 'gs-grid' }, h(SizeRow, { size: entry.size, remeasure, t })),
          h('div', { className: 'gs-rule', 'aria-hidden': true }),
          h(GitSection, { git: data.git, home, cwd: data.cwd, t })),
        h('div', { className: 'gs-foot' },
          h('button', { type: 'button', className: 'gs-button', disabled: entry?.loading === true, onClick: () => { refresh() } }, t('refresh'))))
    }

    function panelPosition(anchor) {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_MARGIN * 2)
      const left = Math.min(Math.max(PANEL_MARGIN, rect.left), window.innerWidth - width - PANEL_MARGIN)
      return { left, bottom: Math.max(PANEL_MARGIN, window.innerHeight - rect.top + PANEL_GAP) }
    }

    function GitPill({ sessionId, useProjection, useSession, useGit, watch, refresh, measure, t }) {
      const cwd = useProjection('workingDirectory') ?? undefined
      const running = useSession(session => session.running === true)
      const entry = useGit(state => state.sessions[sessionId])
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => watch(sessionId), [sessionId])
      // A directory switch or a finished turn (the agent may have committed or
      // checked out) refreshes at once instead of waiting for the next poll.
      React.useEffect(() => { refresh(sessionId) }, [sessionId, cwd, running])

      React.useEffect(() => {
        if (!open) return undefined
        measure(sessionId, false)
        refresh(sessionId)
        const place = () => { if (rootRef.current) setPosition(panelPosition(rootRef.current)) }
        place()
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        const onPointer = (event) => {
          if (!(event.target instanceof Node)) return
          if (rootRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return
          setOpen(false)
        }
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [open, sessionId])

      // The data answers for the directory it was read in; after a switch the
      // previous directory's branch is not shown under the new path.
      const data = entry?.data !== undefined && entry.data !== null && (cwd === undefined || entry.data.cwd === cwd) ? entry.data : null
      if (data === null && cwd === undefined) return null
      const label = pillLabel(data, cwd, t)
      const git = data?.git
      const dirty = git !== null && git !== undefined && git.error === null && git.total > 0
      const ahead = git?.error === null ? (git.ahead ?? 0) : 0
      const behind = git?.error === null ? (git.behind ?? 0) : 0
      const path = data?.cwd ?? cwd ?? ''
      const shownPath = abbreviate(path, data?.home)
      const title = label.kind === 'branch' ? `${label.text}\n${shownPath}` : shownPath

      return h('span', { ref: rootRef, className: 'gs-anchor', 'data-composer-stat': 'git-status' },
        h('button', {
          type: 'button',
          className: 'gs-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': label.kind === 'branch' ? t('pill.aria', { branch: label.text, path: shownPath }) : t('pill.ariaDir', { path: shownPath }),
          title,
          onClick: () => { setOpen(!open) },
        },
        label.kind === 'branch' ? h(BranchIcon) : h(FolderIcon),
        h('span', { className: 'gs-name' }, label.text),
        dirty && h('span', { className: 'gs-dirty', 'aria-hidden': true }),
        (ahead > 0 || behind > 0) && h('span', { className: 'gs-ab' }, [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].filter(Boolean).join(' '))),
        open && createPortal(h(Panel, {
          entry: entry === undefined ? undefined : { ...entry, data },
          cwd,
          refresh: () => { refresh(sessionId); measure(sessionId, true) },
          remeasure: () => { measure(sessionId, true) },
          t,
          panelRef,
          position: position ?? { visibility: 'hidden', left: 0, bottom: 0 },
        }), document.body))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'git-status: dictionaries')
        ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'git-status: ru dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'git-status: stylesheet')

        // One entry per displayed Session: summary, size, and request state.
        const store = createSnapshotStore({ sessions: {} })
        const watchers = new Map()
        const controllers = new Map()
        const sizeControllers = new Map()
        let disposed = false
        let pollMs = DEFAULT_POLL_MS

        const patch = (sessionId, change) => {
          const state = store.getSnapshot()
          const previous = state.sessions[sessionId] ?? { data: null, error: null, loading: false, size: undefined }
          store.set({ sessions: { ...state.sessions, [sessionId]: { ...previous, ...change(previous) } } })
        }

        const post = async (route, body, signal) => {
          const response = await fetch(route, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal,
          })
          const data = await response.json().catch(() => null)
          if (!response.ok) throw new Error(data?.message || data?.error || `HTTP ${response.status}`)
          return data
        }

        async function refresh(sessionId) {
          if (disposed) return
          controllers.get(sessionId)?.abort()
          const own = new AbortController()
          controllers.set(sessionId, own)
          patch(sessionId, () => ({ loading: true }))
          try {
            const data = await post(SUMMARY_ROUTE, { sessionId }, own.signal)
            if (disposed || controllers.get(sessionId) !== own) return
            if (typeof data.pollMs === 'number' && data.pollMs >= 1000) pollMs = data.pollMs
            patch(sessionId, previous => ({
              data,
              error: null,
              loading: false,
              // A size measured for another directory is stale.
              size: previous.size?.cwd === data.cwd ? previous.size : undefined,
            }))
          } catch (error) {
            if (disposed || controllers.get(sessionId) !== own) return
            patch(sessionId, () => ({ error: error instanceof Error ? error.message : String(error), loading: false }))
          } finally {
            if (controllers.get(sessionId) === own) controllers.delete(sessionId)
          }
        }

        async function measure(sessionId, force) {
          if (disposed) return
          const current = store.getSnapshot().sessions[sessionId]?.size
          if (!force && current !== undefined && (current.loading || current.error == null)) return
          sizeControllers.get(sessionId)?.abort()
          const own = new AbortController()
          sizeControllers.set(sessionId, own)
          patch(sessionId, previous => ({ size: { ...(previous.size ?? { bytes: null, error: null }), loading: true } }))
          try {
            const data = await post(SIZE_ROUTE, { sessionId, refresh: force }, own.signal)
            if (disposed || sizeControllers.get(sessionId) !== own) return
            patch(sessionId, () => ({ size: { ...data, loading: false } }))
          } catch (error) {
            if (disposed || sizeControllers.get(sessionId) !== own) return
            patch(sessionId, previous => ({ size: { ...(previous.size ?? {}), bytes: null, error: 'failed', message: error instanceof Error ? error.message : String(error), loading: false } }))
          } finally {
            if (sizeControllers.get(sessionId) === own) sizeControllers.delete(sessionId)
          }
        }

        // Poll each displayed Session while the page is visible.
        let timer = null
        const tick = () => {
          clearTimeout(timer)
          if (disposed) return
          if (document.visibilityState !== 'hidden') for (const sessionId of watchers.keys()) void refresh(sessionId)
          timer = setTimeout(tick, pollMs)
        }
        const watch = (sessionId) => {
          watchers.set(sessionId, (watchers.get(sessionId) ?? 0) + 1)
          return () => {
            const count = (watchers.get(sessionId) ?? 1) - 1
            if (count > 0) {
              watchers.set(sessionId, count)
              return
            }
            watchers.delete(sessionId)
            controllers.get(sessionId)?.abort()
            controllers.delete(sessionId)
          }
        }
        const onVisible = () => { if (document.visibilityState === 'visible') tick() }
        ctx.effect(() => {
          timer = setTimeout(tick, pollMs)
          document.addEventListener('visibilitychange', onVisible)
          window.addEventListener('focus', onVisible)
          return () => {
            disposed = true
            clearTimeout(timer)
            for (const controller of [...controllers.values(), ...sizeControllers.values()]) controller.abort()
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('focus', onVisible)
          }
        }, 'git-status: polling')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'git-status',
          // Before the activity pill (0), like the branch in an editor status bar.
          order: -1,
          locale: NS,
          inject: () => ({
            hooks: { git: store },
            watch,
            refresh: (sessionId) => { void refresh(sessionId) },
            measure: (sessionId, force) => { void measure(sessionId, force) },
          }),
        }, GitPill))
      },
    }
  },
})
