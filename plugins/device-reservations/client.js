// Client half of device-reservations: an icon-only button in the composer
// dock opening a panel that lists rn-looky devices grouped by the project
// (worktree) that reserved them, with live runs and connection state. The
// data is collected each time the panel opens and on its Refresh button.
// Clicking a device shows its actions: reserve for / hand over to a project,
// release the reservation, stop the run (or clear a stale lease).
window.__ModuleLoader__.load({
  id: '@local/dsh-device-reservations',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NS = 'device-reservations'
    const ROUTE = 'device-reservations/devices'
    const ACTION_ROUTE = 'device-reservations/action'
    const CONFIRM_MS = 4000
    const PANEL_WIDTH = 400
    const PANEL_MARGIN = 12
    const PANEL_GAP = 8

    const en = {
      'action.stop': 'Stop run',
      'action.clearLease': 'Clear stale lease',
      'action.unreserve': 'Release',
      'action.reserve': 'Reserve',
      'action.handOver': 'Hand over',
      'action.confirm': 'Sure? {label}',
      'action.pending': 'Working…',
      'action.for': 'Project',
      'action.failed': 'Failed: {error}',
      'action.handOverHint': 'Hand over stops a run on the device, if any.',
      'action.noProjects': 'No other registered project has the rn-looky tooling.',
      'button': 'Device reservations',
      'title': 'Devices',
      'loading': 'Collecting devices…',
      'loadError': 'Could not collect devices: {error}',
      'empty': 'The ledger lists no devices.',
      'refresh': 'Refresh',
      'refreshing': 'Collecting…',
      'group.free': 'Free',
      'group.count': '{n}',
      'holder.gone': '{project} (folder deleted)',
      'state.busy': 'running · {app}',
      'state.busyAgent': 'agent-device · {app}',
      'state.busyNoApp': 'running',
      'state.reserved': 'reserved',
      'state.free': 'free',
      'busyFrom': 'run from {project}',
      'staleLease': 'stale lease: {project}, process ended',
      'connected': 'connected',
      'connectedWifi': 'connected over Wi-Fi',
      'disconnected': 'not connected',
      'simulatorOn': 'booted',
      'simulatorOff': 'shut down',
      'since': 'since {at}',
      'summary': '{busy} running · {reserved} reserved · {free} free',
    }
    const ru = {
      'action.stop': 'Остановить сборку',
      'action.clearLease': 'Убрать зависший лиз',
      'action.unreserve': 'Снять бронь',
      'action.reserve': 'Забронировать',
      'action.handOver': 'Передать',
      'action.confirm': 'Точно? {label}',
      'action.pending': 'Выполняю…',
      'action.for': 'Проект',
      'action.failed': 'Не вышло: {error}',
      'action.handOverHint': 'Передача останавливает идущую на устройстве сборку.',
      'action.noProjects': 'Нет других зарегистрированных проектов с тулингом rn-looky.',
      'button': 'Бронь устройств',
      'title': 'Устройства',
      'loading': 'Собираю устройства…',
      'loadError': 'Не удалось собрать устройства: {error}',
      'empty': 'В реестре нет устройств.',
      'refresh': 'Обновить',
      'refreshing': 'Сбор…',
      'group.free': 'Свободны',
      'group.count': '{n}',
      'holder.gone': '{project} (папка удалена)',
      'state.busy': 'сборка · {app}',
      'state.busyAgent': 'agent-device · {app}',
      'state.busyNoApp': 'сборка идёт',
      'state.reserved': 'бронь',
      'state.free': 'свободно',
      'busyFrom': 'сборка из {project}',
      'staleLease': 'зависший лиз: {project}, процесс завершён',
      'connected': 'подключено',
      'connectedWifi': 'подключено по Wi-Fi',
      'disconnected': 'не подключено',
      'simulatorOn': 'запущен',
      'simulatorOff': 'выключен',
      'since': 'с {at}',
      'summary': 'сборок {busy} · броней {reserved} · свободно {free}',
    }
    const zh = {
      'action.stop': '停止运行',
      'action.clearLease': '清除残留租约',
      'action.unreserve': '取消预留',
      'action.reserve': '预留',
      'action.handOver': '转交',
      'action.confirm': '确定？{label}',
      'action.pending': '执行中…',
      'action.for': '项目',
      'action.failed': '失败：{error}',
      'action.handOverHint': '转交会停止设备上正在进行的运行。',
      'action.noProjects': '没有其他带 rn-looky 工具的已登记项目。',
      'button': '设备预留',
      'title': '设备',
      'loading': '正在收集设备…',
      'loadError': '无法收集设备：{error}',
      'empty': '登记表中没有设备。',
      'refresh': '刷新',
      'refreshing': '收集中…',
      'group.free': '空闲',
      'group.count': '{n}',
      'holder.gone': '{project}（目录已删除）',
      'state.busy': '运行中 · {app}',
      'state.busyAgent': 'agent-device · {app}',
      'state.busyNoApp': '运行中',
      'state.reserved': '已预留',
      'state.free': '空闲',
      'busyFrom': '来自 {project} 的运行',
      'staleLease': '残留租约：{project}，进程已结束',
      'connected': '已连接',
      'connectedWifi': '已通过 Wi-Fi 连接',
      'disconnected': '未连接',
      'simulatorOn': '已启动',
      'simulatorOff': '已关闭',
      'since': '自 {at}',
      'summary': '运行 {busy} · 预留 {reserved} · 空闲 {free}',
    }

    const CSS = `
.dr-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px))}
.dr-button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;padding:1px 6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font:inherit;line-height:inherit;cursor:pointer}
.dr-button:hover,.dr-button[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dr-button svg{width:14px;height:14px;flex:none}
.dr-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(${PANEL_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px));max-height:min(70vh, 600px);overflow-y:auto;overscroll-behavior:contain;padding:16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;display:flex;flex-direction:column;gap:10px}
.dr-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;color:var(--dsw-alias-label-primary);font-weight:500}
.dr-head-time{font-weight:400;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dr-summary{margin-top:-8px;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dr-rule{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dr-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dr-group{display:flex;flex-direction:column;gap:4px}
.dr-group-name{display:flex;justify-content:space-between;align-items:baseline;gap:8px;color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere}
.dr-group-name[data-gone=true]{color:var(--dsw-alias-state-warn-primary)}
.dr-count{font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dr-device{display:flex;flex-direction:column;gap:4px;border-radius:var(--dsw-radius-sm)}
.dr-device[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);padding:4px 6px;margin:0 -6px}
.dr-toggle{display:block;width:100%;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dr-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-left:16px}
.dr-select{max-width:160px;padding:1px 4px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px}
.dr-act{padding:1px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.dr-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dr-act[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.dr-act[data-armed=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:500}
.dr-act:disabled{cursor:default;opacity:.6}
.dr-hint{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dr-row{display:grid;grid-template-columns:8px minmax(0, 1fr) auto;align-items:baseline;column-gap:8px}
.dr-dot{width:6px;height:6px;border-radius:50%;align-self:center;background:var(--dsw-alias-state-idle-primary, var(--dsw-alias-border-l2))}
.dr-dot[data-connected=true]{background:var(--dsw-alias-state-success-primary)}
.dr-name{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dr-details{grid-column:2 / 4;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));overflow-wrap:anywhere}
.dr-note{grid-column:2 / 4;font-size:11px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere}
.dr-state{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.dr-state[data-state=busy]{color:var(--dsw-alias-brand-primary);font-weight:500}
.dr-state[data-state=free]{color:var(--dsw-alias-state-success-primary)}
.dr-foot{display:flex;justify-content:flex-end}
.dr-action{padding:2px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.dr-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dr-action:disabled{cursor:default;opacity:.6}
`

    // ---- pure helpers -------------------------------------------------------

    const list = value => (Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object') : [])

    function clock24(ms) {
      return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    }

    function when(iso) {
      const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
      if (!Number.isFinite(ms)) return ''
      const date = new Date(ms)
      const now = new Date()
      if (date.toDateString() === now.toDateString()) return clock24(ms)
      const day = date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear()
        ? { day: '2-digit', month: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' })
      return `${day} ${clock24(ms)}`
    }

    const holderName = (holder, t) => (holder.gone && holder.path !== null
      ? t('holder.gone', { project: holder.project })
      : String(holder.project ?? '?'))

    /** Groups keyed by the reserving project, else the leasing one; free devices last. */
    function groupsOf(devices) {
      const groups = new Map()
      const free = []
      for (const device of list(devices)) {
        const holder = device.reservation ?? (device.lease?.live ? device.lease : null)
        if (holder === null) { free.push(device); continue }
        const key = String(holder.worktreeId ?? holder.project)
        if (!groups.has(key)) groups.set(key, { key, holder, devices: [] })
        groups.get(key).devices.push(device)
      }
      const sorted = [...groups.values()].sort((a, b) => String(a.holder.project).localeCompare(String(b.holder.project)))
      return { projects: sorted, free }
    }

    // ---- components ---------------------------------------------------------

    function DevicesIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 1.75, y: 1.75, width: 7.5, height: 12.5, rx: 1.5 }),
        h('path', { d: 'M4.5 12h2' }),
        h('path', { d: 'M11.5 4.75h1.5a1.25 1.25 0 0 1 1.25 1.25v7a1.25 1.25 0 0 1-1.25 1.25h-1.5' }))
    }

    function stateLabel(device, t) {
      if (device.state === 'busy') {
        const app = device.lease?.app
        if (!app) return t('state.busyNoApp')
        return t(device.lease?.agentSession ? 'state.busyAgent' : 'state.busy', { app })
      }
      return t(device.state === 'reserved' ? 'state.reserved' : 'state.free')
    }

    /** A button that asks once more before a destructive action. */
    function ConfirmButton({ label, danger, confirm, disabled, onPress, t }) {
      const [armed, setArmed] = React.useState(false)
      React.useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), CONFIRM_MS)
        return () => clearTimeout(timer)
      }, [armed])
      return h('button', {
        type: 'button',
        className: 'dr-act',
        'data-danger': String(danger === true),
        'data-armed': String(armed),
        disabled,
        onClick: (event) => {
          event.stopPropagation()
          if (confirm && !armed) { setArmed(true); return }
          setArmed(false)
          onPress()
        },
      }, armed ? t('action.confirm', { label }) : label)
    }

    function DeviceActions({ device, worktrees, pending, result, act, t }) {
      const busy = pending !== null
      const lease = device.lease
      const holderId = device.reservation?.worktreeId ?? null
      const targets = list(worktrees).filter(item => item.usable === true && item.id !== holderId)
      const [target, setTarget] = React.useState(targets[0]?.id ?? '')
      const chosen = targets.some(item => item.id === target) ? target : (targets[0]?.id ?? '')
      const handOver = device.reservation !== null || device.state === 'busy'
      const label = key => (busy && pending === key ? t('action.pending') : t(key))
      const buttons = []
      if (lease !== null && lease !== undefined) {
        const key = lease.live ? 'action.stop' : 'action.clearLease'
        buttons.push(h(ConfirmButton, { key, label: label(key), danger: lease.live, confirm: lease.live, disabled: busy, t,
          onPress: () => act(key, { action: 'unlease', alias: device.alias }) }))
      }
      if (device.reservation !== null && device.reservation !== undefined) {
        buttons.push(h(ConfirmButton, { key: 'action.unreserve', label: label('action.unreserve'), confirm: false, disabled: busy, t,
          onPress: () => act('action.unreserve', { action: 'unreserve', alias: device.alias }) }))
      }
      const reserveKey = handOver ? 'action.handOver' : 'action.reserve'
      return h('div', { className: 'dr-actions' },
        buttons,
        targets.length > 0 && h('select', {
          className: 'dr-select',
          'aria-label': t('action.for'),
          value: chosen,
          disabled: busy,
          onChange: event => setTarget(event.target.value),
        }, targets.map(item => h('option', { key: item.id, value: item.id, title: item.path }, String(item.project)))),
        targets.length > 0 && h(ConfirmButton, { key: reserveKey, label: label(reserveKey), danger: handOver && device.state === 'busy', confirm: handOver, disabled: busy || chosen === '', t,
          onPress: () => act(reserveKey, { action: 'reserve', alias: device.alias, worktreeId: chosen, force: handOver }) }),
        targets.length === 0 && h('span', { className: 'dr-hint' }, t('action.noProjects')),
        handOver && targets.length > 0 && h('span', { className: 'dr-hint' }, t('action.handOverHint')),
        result !== null && result.ok === false && h('span', { className: 'dr-hint dr-error' }, t('action.failed', { error: String(result.error ?? '?') })))
    }

    function DeviceRow({ device, group, open, onToggle, actions, t }) {
      const connection = device.virtual
        ? t(device.connected ? 'simulatorOn' : 'simulatorOff')
        : t(device.connected ? (device.overWifi ? 'connectedWifi' : 'connected') : 'disconnected')
      const lease = device.lease
      const notes = []
      if (lease?.live && group !== null && lease.worktreeId !== group.holder.worktreeId) {
        notes.push(t('busyFrom', { project: holderName(lease, t) }))
      }
      if (lease !== null && lease !== undefined && !lease.live) notes.push(t('staleLease', { project: holderName(lease, t) }))
      const since = device.state === 'busy' ? when(lease?.since) : when(device.reservation?.since)
      const title = [device.alias, device.details, connection, since !== '' ? t('since', { at: since }) : ''].filter(Boolean).join('\n')
      return h('div', { className: 'dr-device', 'data-open': String(open) },
        h('button', { type: 'button', className: 'dr-toggle', 'aria-expanded': open, title, onClick: onToggle },
          h('span', { className: 'dr-row' },
            h('span', { className: 'dr-dot', 'data-connected': String(device.connected === true), 'aria-hidden': true }),
            h('span', { className: 'dr-name' }, String(device.alias ?? '')),
            h('span', { className: 'dr-state', 'data-state': device.state }, stateLabel(device, t)),
            h('span', { className: 'dr-details' }, [device.details, connection].filter(Boolean).join(' · ')),
            notes.map(text => h('span', { key: text, className: 'dr-note' }, text)))),
        open && actions)
    }

    function Group({ name, title, gone, devices, group, rowProps, t }) {
      return h('div', { className: 'dr-group' },
        h('div', { className: 'dr-group-name', 'data-gone': String(gone), title },
          h('span', null, name),
          h('span', { className: 'dr-count' }, t('group.count', { n: devices.length }))),
        devices.map(device => h(DeviceRow, { key: device.alias, device, group, t, ...rowProps(device) })))
    }

    function Panel({ state, refresh, act, t, panelRef, position }) {
      const data = state.data
      const devices = list(data?.devices)
      const [openAlias, setOpenAlias] = React.useState(null)
      const rowProps = device => ({
        open: openAlias === device.alias,
        onToggle: () => setOpenAlias(openAlias === device.alias ? null : device.alias),
        actions: openAlias === device.alias && h(DeviceActions, {
          device,
          worktrees: data?.worktrees,
          pending: state.pending?.alias === device.alias ? state.pending.key : (state.pending !== null ? '' : null),
          result: state.result?.alias === device.alias ? state.result : null,
          act,
          t,
        }),
      })
      const { projects, free } = groupsOf(devices)
      const count = name => devices.filter(device => device.state === name).length
      const sections = [
        ...projects.map(group => h(Group, {
          key: group.key,
          name: holderName(group.holder, t),
          title: group.holder.path ?? String(group.holder.worktreeId ?? ''),
          gone: group.holder.gone === true,
          devices: group.devices,
          group,
          rowProps,
          t,
        })),
        free.length > 0 && h(Group, { key: '__free', name: t('group.free'), title: '', gone: false, devices: free, group: null, rowProps, t }),
      ].filter(Boolean)
      return h('div', { ref: panelRef, className: 'dr-panel', role: 'dialog', 'aria-label': t('title'), style: position },
        h('div', { className: 'dr-head' },
          h('span', { title: data?.checkout ?? '' }, t('title')),
          h('span', { className: 'dr-head-time' }, data?.fetchedAt ? clock24(data.fetchedAt) : '')),
        devices.length > 0 && h('div', { className: 'dr-summary' }, t('summary', { busy: count('busy'), reserved: count('reserved'), free: count('free') })),
        h('div', { className: 'dr-rule', 'aria-hidden': true }),
        state.error !== null && h('div', { className: 'dr-error' }, t('loadError', { error: state.error })),
        typeof data?.error === 'string' && data.error !== '' && h('div', { className: 'dr-error' }, t('loadError', { error: data.error })),
        data === null && state.error === null && h('div', null, t('loading')),
        data !== null && !data.error && devices.length === 0 && h('div', null, t('empty')),
        sections,
        h('div', { className: 'dr-rule', 'aria-hidden': true }),
        h('div', { className: 'dr-foot' },
          h('button', { type: 'button', className: 'dr-action', disabled: state.loading || state.pending !== null, onClick: () => { refresh() } },
            state.loading ? t('refreshing') : t('refresh'))))
    }

    function panelPosition(anchor) {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_MARGIN * 2)
      const left = Math.min(Math.max(PANEL_MARGIN, rect.right - width), window.innerWidth - width - PANEL_MARGIN)
      return { left, bottom: Math.max(PANEL_MARGIN, window.innerHeight - rect.top + PANEL_GAP) }
    }

    function DevicesButton({ useDevices, refresh, act, t }) {
      const state = useDevices(value => value)
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        refresh()
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
      }, [open])

      return h('span', { ref: rootRef, className: 'dr-anchor', 'data-composer-stat': 'device-reservations' },
        h('button', {
          type: 'button',
          className: 'dr-button',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('button'),
          title: t('button'),
          onClick: () => { setOpen(!open) },
        }, h(DevicesIcon)),
        open && createPortal(h(Panel, {
          state, refresh, act, t, panelRef,
          position: position ?? { visibility: 'hidden', left: 0, bottom: 0 },
        }), document.body))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'device-reservations: dictionaries')
        ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'device-reservations: ru dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'device-reservations: stylesheet')

        const store = createSnapshotStore({ data: null, error: null, loading: false, pending: null, result: null })
        let disposed = false
        let controller = null

        // Collection is on demand only: opening the panel and its Refresh button.
        async function load() {
          if (disposed) return
          controller?.abort()
          const own = new AbortController()
          controller = own
          store.set({ ...store.getSnapshot(), loading: true })
          try {
            const response = await fetch(ROUTE, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: own.signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (disposed || controller !== own) return
            store.set({ ...store.getSnapshot(), data, error: null, loading: false })
          } catch (error) {
            if (disposed || controller !== own) return
            store.set({ ...store.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false })
          } finally {
            if (controller === own) controller = null
          }
        }

        // One action at a time; its response carries the fresh list.
        async function act(key, request) {
          if (disposed || store.getSnapshot().pending !== null) return
          controller?.abort()
          controller = null
          store.set({ ...store.getSnapshot(), loading: false, pending: { alias: request.alias, key }, result: null })
          let result
          try {
            const response = await fetch(ACTION_ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { accept: 'application/json', 'content-type': 'application/json' },
              body: JSON.stringify(request),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (disposed) return
            result = { alias: request.alias, ...(data.action ?? { ok: false, error: 'no action result' }) }
            store.set({ ...store.getSnapshot(), data, error: null, pending: null, result })
          } catch (error) {
            if (disposed) return
            result = { alias: request.alias, ok: false, error: error instanceof Error ? error.message : String(error) }
            store.set({ ...store.getSnapshot(), pending: null, result })
          }
        }

        ctx.effect(() => () => {
          disposed = true
          controller?.abort()
        }, 'device-reservations: abort collection')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'device-reservations',
          order: 3,
          locale: NS,
          inject: () => ({ hooks: { devices: store }, refresh: () => { void load() }, act: (key, request) => { void act(key, request) } }),
        }, DevicesButton))
      },
    }
  },
})
