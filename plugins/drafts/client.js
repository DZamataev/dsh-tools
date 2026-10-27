// Client half of dsh-drafts: a compact "Drafts (N)" button in the New Session
// row (`conversation.hero.options`) that lists other blank Sessions whose
// persisted composer draft is non-empty. Clicking a row opens that Session,
// whose own composer then restores the draft; the archive button archives the
// blank Session. Drafts are only read, never written.
window.__ModuleLoader__.load({
  id: '@local/dsh-drafts',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NS = 'dsh-drafts'
    const SLOT = 'conversation.hero.options'
    /** Composer store persistence prefix owned by ui-conversation (`dsh.conversation.<sessionId>`). */
    const DRAFT_KEY_PREFIX = 'dsh.conversation.'
    /** Automatic title of the first-use Workspace (dsh-api-workspace-controller DEFAULT_WORKSPACE_DIRECTORY). */
    const DEFAULT_WORKSPACE_TITLE = 'default-workspace'
    const PREVIEW_CHARS = 120
    const MENU_MARGIN = 12
    const MENU_GAP = 4

    const en = {
      'button': 'Drafts ({n})',
      'button.aria': 'Unfinished drafts: {n}',
      'title': 'Drafts',
      'row.open': 'Open draft: {text}',
      'archive': 'Delete draft',
      'archive.aria': 'Delete draft (archive the session): {text}',
      'archive.failed': 'Could not archive: {message}',
      'workspace.default': 'Default workspace',
      'ago.now': 'just now',
      'ago.minutes': '{n} min ago',
      'ago.hours': '{n} h ago',
      'ago.days': '{n} d ago',
    }
    const ru = {
      'button': 'Черновики ({n})',
      'button.aria': 'Незаконченные черновики: {n}',
      'title': 'Черновики',
      'row.open': 'Открыть черновик: {text}',
      'archive': 'Удалить черновик',
      'archive.aria': 'Удалить черновик (архивировать сессию): {text}',
      'archive.failed': 'Не удалось архивировать: {message}',
      'workspace.default': 'Рабочая папка по умолчанию',
      'ago.now': 'только что',
      'ago.minutes': '{n} мин назад',
      'ago.hours': '{n} ч назад',
      'ago.days': '{n} дн назад',
    }
    const zh = {
      'button': '草稿 ({n})',
      'button.aria': '未完成的草稿：{n}',
      'title': '草稿',
      'row.open': '打开草稿：{text}',
      'archive': '删除草稿',
      'archive.aria': '删除草稿（归档会话）：{text}',
      'archive.failed': '归档失败：{message}',
      'workspace.default': '默认工作区',
      'ago.now': '刚刚',
      'ago.minutes': '{n} 分钟前',
      'ago.hours': '{n} 小时前',
      'ago.days': '{n} 天前',
    }

    const CSS = `
.dd-trigger{display:inline-flex;align-items:center;gap:4px;max-width:220px;min-height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.dd-trigger:hover,.dd-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dd-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dd-trigger svg{flex:none;width:14px;height:14px}
.dd-trigger .dd-chevron{width:12px;height:12px;color:var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary))}
.dd-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dd-menu{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;width:min(400px, calc(100vw - ${MENU_MARGIN * 2}px));padding:4px;border-radius:var(--dsw-radius-lg);isolation:isolate;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dd-material{position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}
.dd-backing{display:none}
html[data-platform='darwin'] .dd-backing{display:block;position:fixed;top:anchor(top);left:anchor(left);width:anchor-size(width, 0px);height:anchor-size(height, 0px);z-index:-1;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);pointer-events:none}
.dd-heading{padding:6px 8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dd-list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;margin:0;padding:0;list-style:none}
.dd-row{position:relative;display:flex;align-items:stretch;border-radius:var(--dsw-radius-md)}
.dd-row:hover,.dd-row:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.dd-open{display:flex;flex:1;flex-direction:column;align-items:stretch;gap:1px;min-width:0;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dd-open:focus-visible,.dd-archive:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
.dd-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dd-meta{display:flex;gap:6px;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dd-workspace{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-time{flex:none}
.dd-archive{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;margin:4px 4px 4px 0;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-menu-icon, var(--dsw-alias-label-secondary));cursor:pointer;opacity:0}
.dd-row:hover .dd-archive,.dd-row:focus-within .dd-archive,.dd-archive[aria-busy=true]{opacity:1}
.dd-archive:hover:not([aria-disabled=true]){background:var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.dd-archive[aria-disabled=true]{cursor:default;opacity:.4}
.dd-archive svg{width:14px;height:14px}
.dd-error{padding:4px 8px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
@media (hover: none){.dd-archive{opacity:1}}
`

    // ---- pure helpers -------------------------------------------------------

    const isNonNegativeInteger = value => Number.isInteger(value) && value >= 0
    const REFERENCE_APPEARANCES = new Set(['session', 'file', 'folder'])

    function isReference(value) {
      return value !== null && typeof value === 'object'
        && typeof value.source === 'string' && typeof value.ref === 'string'
        && isNonNegativeInteger(value.offset) && Number.isInteger(value.length) && value.length > 0
        && typeof value.label === 'string' && typeof value.clipboardText === 'string'
        && (value.appearance === undefined || REFERENCE_APPEARANCES.has(value.appearance))
        && (value.invalid === undefined || typeof value.invalid === 'boolean')
    }

    /**
     * Mirror of ui-conversation `parseStoredDraft` (draft.ts): a structured draft
     * DSH would reject restores as empty, so it must not be listed. References
     * are inline mentions occupying ordered spans of `text`, after an optional
     * leading `/command` token.
     */
    function isRestorableSnapshot(draft) {
      if (typeof draft.text !== 'string' || !Array.isArray(draft.references)) return false
      if (!draft.references.every(isReference)) return false
      let end = 0
      if (draft.command !== undefined) {
        if (draft.command === null || typeof draft.command !== 'object' || typeof draft.command.token !== 'string') return false
        const spelling = draft.command.token.trimEnd()
        if (!/^\/\S/u.test(spelling) || !draft.text.startsWith(spelling)) return false
        end = spelling.length
      }
      for (const reference of draft.references) {
        if (reference.offset < end || reference.length !== reference.clipboardText.length) return false
        end = reference.offset + reference.length
        if (end > draft.text.length || draft.text.slice(reference.offset, end) !== reference.clipboardText) return false
      }
      return true
    }

    /**
     * Parse one persisted composer value. `draft` is either the legacy string or
     * `{ text, references, command? }` as accepted by DSH; anything else, and
     * whitespace-only text, counts as no draft.
     */
    function readDraft(sessionId) {
      let raw
      try {
        raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${sessionId}`)
      } catch {
        // Storage disabled by the browser: no readable draft.
        return null
      }
      if (raw === null) return null
      let stored
      try {
        stored = JSON.parse(raw)
      } catch {
        // Malformed persisted value: ui-conversation also treats it as empty.
        return null
      }
      const draft = stored !== null && typeof stored === 'object' ? stored.draft : undefined
      if (typeof draft === 'string') return draft.trim() === '' ? null : { text: draft }
      if (draft === null || typeof draft !== 'object' || !isRestorableSnapshot(draft)) return null
      // Every reference spans part of `text`, so a draft is empty exactly when its text is blank.
      return draft.text.trim() === '' ? null : { text: draft.text }
    }

    function firstLine(text) {
      const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part !== '') ?? ''
      return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line
    }

    function basename(path) {
      const trimmed = String(path ?? '').replace(/[\\/]+$/, '')
      const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed
    }

    function ago(time, now, t) {
      const minutes = Math.floor((now - time) / 60_000)
      if (minutes < 1) return t('ago.now')
      if (minutes < 60) return t('ago.minutes', { n: minutes })
      if (minutes < 48 * 60) return t('ago.hours', { n: Math.floor(minutes / 60) })
      return t('ago.days', { n: Math.floor(minutes / 1440) })
    }

    /** Blank, unarchived, top-level Sessions other than the current one, newest first. */
    function collectDrafts(sessionId, sessions, workspaces) {
      const archived = new Set(workspaces.archivedSessionIds ?? [])
      const drafts = []
      for (const id of sessions.ids) {
        if (id === sessionId || archived.has(id)) continue
        const row = sessions.byId[id]
        if (row === undefined || row.blank !== true || row.origin === 'subagent') continue
        const draft = readDraft(id)
        if (draft === null) continue
        const workspace = workspaces.items.find(item => item.sessionIds.includes(id))
        drafts.push({ sessionId: id, draft, updatedAt: row.updatedAt, cwd: row.cwd, workspace })
      }
      drafts.sort((a, b) => b.updatedAt - a.updatedAt)
      return drafts
    }

    function menuPosition(anchor, menuHeight) {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(400, window.innerWidth - MENU_MARGIN * 2)
      const left = Math.min(Math.max(MENU_MARGIN, rect.right - width), window.innerWidth - width - MENU_MARGIN)
      const below = window.innerHeight - rect.bottom - MENU_GAP - MENU_MARGIN
      const above = rect.top - MENU_GAP - MENU_MARGIN
      if (below >= Math.min(menuHeight, 320) || below >= above) {
        return { left, top: rect.bottom + MENU_GAP, maxHeight: Math.max(120, below) }
      }
      return { left, bottom: window.innerHeight - rect.top + MENU_GAP, maxHeight: Math.max(120, above) }
    }

    // ---- icons --------------------------------------------------------------

    function DraftIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M9.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8' }),
        h('path', { d: 'M12.2 2.3a1.1 1.1 0 0 1 1.5 1.5L8.5 9l-2 .5.5-2z' }))
    }

    function ChevronIcon() {
      return h('svg', { className: 'dd-chevron', viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 4.5l3 3 3-3' }))
    }

    function ArchiveIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 5.5h10M6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4.3 5.5l.6 7.1a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-7.1' }))
    }

    // ---- components ---------------------------------------------------------

    function DraftRow({ entry, label, workspaceLabel, timeLabel, busy, onOpen, onArchive, t }) {
      return h('li', { className: 'dd-row' },
        h('button', {
          type: 'button',
          className: 'dd-open',
          'data-dd-focus': '',
          'aria-label': t('row.open', { text: label }),
          title: entry.draft.text.slice(0, 600),
          onClick: onOpen,
        },
        h('span', { className: 'dd-text' }, label),
        h('span', { className: 'dd-meta' },
          workspaceLabel !== null && h('span', { className: 'dd-workspace' }, workspaceLabel),
          workspaceLabel !== null && h('span', { 'aria-hidden': true }, '·'),
          h('span', { className: 'dd-time' }, timeLabel))),
        h('button', {
          type: 'button',
          className: 'dd-archive',
          'data-dd-focus': '',
          'aria-label': t('archive.aria', { text: label }),
          'aria-busy': busy,
          // aria-disabled, not disabled: a disabled button drops keyboard focus to <body>.
          'aria-disabled': busy,
          title: t('archive'),
          onClick: () => { if (!busy) onArchive() },
        }, h(ArchiveIcon)))
    }

    function DraftsMenu({ drafts, currentWorkspaceId, t, menuRef, anchorRef, focusAfterRemoval, onOpen, onArchive, pending, error, onClose }) {
      const [position, setPosition] = React.useState(null)
      const anchorName = `--dd-menu-${React.useId().replaceAll(':', '')}`

      React.useLayoutEffect(() => {
        const place = () => {
          if (anchorRef.current === null || menuRef.current === null) return
          setPosition(menuPosition(anchorRef.current, menuRef.current.scrollHeight))
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [drafts.length])

      // Move focus into the menu once it is placed, so arrow keys work at once.
      const placed = position !== null
      React.useEffect(() => {
        if (placed) menuRef.current?.querySelector('[data-dd-focus]')?.focus()
      }, [placed])

      // An archived row unmounts with the focus it held; hand the focus to the
      // row now at its position (or the new last row) so the keyboard keeps
      // reaching this dialog.
      React.useLayoutEffect(() => {
        const index = focusAfterRemoval.current
        if (index === null) return
        const menu = menuRef.current
        if (menu === null || menu.contains(document.activeElement)) return
        focusAfterRemoval.current = null
        const items = menu.querySelectorAll('.dd-open')
        if (items.length > 0) items[Math.min(index, items.length - 1)].focus()
      }, [drafts])

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose(true)
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
        const items = [...(menuRef.current?.querySelectorAll('.dd-open') ?? [])]
        if (items.length === 0) return
        event.preventDefault()
        const row = document.activeElement?.closest('.dd-row')
        const index = items.findIndex(item => item.closest('.dd-row') === row)
        let next
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = items.length - 1
        else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % items.length
        else next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length
        items[next].focus()
      }

      const now = Date.now()
      const style = {
        ...(position ?? { left: 0, top: 0, visibility: 'hidden' }),
        anchorName,
      }
      return createPortal(h(React.Fragment, null,
        h('div', {
          ref: menuRef,
          className: 'dd-menu',
          role: 'dialog',
          'aria-label': t('title'),
          'data-menu-material': 'translucent',
          style,
          onKeyDown,
        },
        h('div', { className: 'dd-material', 'aria-hidden': true }),
        h('div', { className: 'dd-heading' }, t('title')),
        h('ul', { className: 'dd-list' }, drafts.map((entry) => {
          const workspaceId = entry.workspace?.workspaceId
          const differs = workspaceId !== currentWorkspaceId
          let workspaceLabel = null
          if (differs) {
            const title = entry.workspace?.title
            workspaceLabel = title === undefined
              ? (entry.cwd ? basename(entry.cwd) : null)
              : (title === DEFAULT_WORKSPACE_TITLE ? t('workspace.default') : title)
          }
          return h(DraftRow, {
            key: entry.sessionId,
            entry,
            label: firstLine(entry.draft.text),
            workspaceLabel,
            timeLabel: ago(entry.updatedAt, now, t),
            busy: pending.has(entry.sessionId),
            onOpen: () => { onOpen(entry.sessionId) },
            onArchive: () => { onArchive(entry.sessionId) },
            t,
          })
        })),
        error !== null && h('div', { className: 'dd-error', role: 'alert' }, error)),
        h('div', { className: 'dd-backing', 'aria-hidden': true, style: { positionAnchor: anchorName, visibility: style.visibility } })),
      document.body)
    }

    function DraftsButton({ sessionId, useSessions, useWorkspaces, useDraftsRev, refresh, openSession, archiveSession, t }) {
      const sessions = useSessions(state => state)
      const workspaces = useWorkspaces(state => state)
      const rev = useDraftsRev(state => state.rev)
      const [open, setOpen] = React.useState(false)
      const [pending, setPending] = React.useState(() => new Set())
      const [error, setError] = React.useState(null)
      const anchorRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const focusAfterRemoval = React.useRef(null)

      const drafts = React.useMemo(
        () => collectDrafts(sessionId, sessions, workspaces),
        [sessionId, sessions, workspaces, rev],
      )
      const currentWorkspaceId = React.useMemo(
        () => workspaces.items.find(item => item.sessionIds.includes(sessionId))?.workspaceId,
        [workspaces, sessionId],
      )

      const close = React.useCallback((restoreFocus) => {
        setOpen(false)
        setError(null)
        if (restoreFocus) anchorRef.current?.focus()
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (!(event.target instanceof Node)) return
          if (anchorRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return
          close(false)
        }
        document.addEventListener('pointerdown', onPointer, true)
        return () => { document.removeEventListener('pointerdown', onPointer, true) }
      }, [open, close])

      if (drafts.length === 0) {
        if (open) setOpen(false)
        return null
      }

      const archive = (id) => {
        setError(null)
        setPending(previous => new Set(previous).add(id))
        const index = drafts.findIndex(entry => entry.sessionId === id)
        void archiveSession(id).then(
          () => {
            focusAfterRemoval.current = index
            refresh()
          },
          (reason) => {
            const message = typeof reason?.message === 'string' ? reason.message : String(reason)
            setError(t('archive.failed', { message }))
          },
        ).finally(() => {
          setPending((previous) => {
            const next = new Set(previous)
            next.delete(id)
            return next
          })
        })
      }

      return h(React.Fragment, null,
        h('button', {
          ref: anchorRef,
          type: 'button',
          className: 'dd-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('button.aria', { n: drafts.length }),
          onClick: () => {
            if (open) {
              close(false)
              return
            }
            refresh()
            setOpen(true)
          },
        }, h(DraftIcon), h('span', { className: 'dd-trigger-label' }, t('button', { n: drafts.length })), h(ChevronIcon)),
        open && h(DraftsMenu, {
          drafts,
          currentWorkspaceId,
          t,
          menuRef,
          anchorRef,
          focusAfterRemoval,
          pending,
          error,
          onClose: close,
          onOpen: (id) => {
            close(false)
            openSession(id)
          },
          onArchive: archive,
        }))
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-drafts: dictionaries')
        ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'dsh-drafts: ru dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'dsh-drafts: stylesheet')

        // Invalidation counter for the localStorage read: drafts written by this
        // tab are picked up on open and on Session-list changes; another tab's
        // writes arrive as `storage` events.
        const revision = createSnapshotStore({ rev: 0 })
        const refresh = () => { revision.set({ rev: revision.getSnapshot().rev + 1 }) }
        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key === null || event.key.startsWith(DRAFT_KEY_PREFIX)) refresh()
          }
          const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
          window.addEventListener('storage', onStorage)
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            window.removeEventListener('storage', onStorage)
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, 'dsh-drafts: storage listeners')

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'dsh-drafts',
          order: 10,
          locale: NS,
          label: () => ctx.locale.bind(NS)('title'),
          inject: () => ({
            hooks: { draftsRev: revision },
            refresh,
            openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
            archiveSession: (sessionId) => ctx.uiWorkspace.archiveSession(sessionId),
          }),
        }, DraftsButton))
      },
    }
  },
})
