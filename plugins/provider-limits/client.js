// Client half of provider-limits: a pill in the composer dock showing each
// provider's remaining 5-hour quota, opening a panel with every window,
// reset times, account breakdowns, and upstream service health.
window.__ModuleLoader__.load({
  id: '@local/dsh-provider-limits',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    const NS = 'provider-limits'
    const ROUTE = 'provider-limits/limits'
    const PANEL_WIDTH = 360
    const PANEL_MARGIN = 12
    const PANEL_GAP = 8
    const WARN_PCT = 25
    const LOW_PCT = 10

    const en = {
      'pill.aria': 'Provider limits: {summary}',
      'pill.unavailable': 'Provider limits unavailable',
      'title': 'Provider limits',
      'legend': '% = left · 100% untouched, 0% exhausted',
      'loading': 'Loading…',
      'loadError': 'Could not load limits: {error}',
      'noProviders': 'No configured provider route has a known quota API (TeamClaude, codex-lb, OpenCode Go).',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'reset.in': 'resets in {time} · {at}',
      'reset.overdue': 'reset overdue · {at}',
      'duration.underMinute': '<1m',
      'duration.minutes': '{n}m',
      'duration.hours': '{n}h',
      'duration.days': '{n}d',
      'pool': 'account pool · {values}',
      'service.incident': 'incident',
      'service.unknown': 'status unavailable',
      'service.unknownWithError': 'status unavailable ({error})',
      'window.1h': 'Hour',
      'window.5h': '5 hours',
      'window.daily': 'Day',
      'window.7d': 'Week',
      'window.monthly': 'Month',
      'windowShort.1h': '1h',
      'windowShort.5h': '5h',
      'windowShort.daily': 'day',
      'windowShort.7d': 'week',
      'windowShort.monthly': 'month',
      'windowName.1h': 'hour',
      'windowName.daily': 'day',
      'windowName.7d': 'week',
      'windowName.monthly': 'month',
      'explain.lead': 'Pill, left to right — each provider\'s 5-hour window: {entries}.',
      'explain.fallback': 'A letter after a number marks a provider without a 5-hour limit, shown at its shortest window ({marks}).',
      'explain.other': 'Other windows are not in those numbers — see the rows above.',
      'explain.dash': '“—” means that provider reported no limit the pill can show.',
      'explain.down': '⚠ {services}: incident reported; remaining quota may not be usable.',
      'tooltip.error': '{label}: {error}',
      'tooltip.none': '{label}: no limit reported',
      'tooltip.value': '{label} · {window}: {value}% left',
    }
    const zh = {
      'pill.aria': '提供方额度：{summary}',
      'pill.unavailable': '提供方额度不可用',
      'title': '提供方额度',
      'legend': '% = 剩余 · 100% 未使用，0% 已耗尽',
      'loading': '加载中…',
      'loadError': '无法加载额度：{error}',
      'noProviders': '已配置的提供方路由中没有支持额度查询的接口（TeamClaude、codex-lb、OpenCode Go）。',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'reset.in': '{time}后重置 · {at}',
      'reset.overdue': '重置已逾期 · {at}',
      'duration.underMinute': '<1分钟',
      'duration.minutes': '{n}分钟',
      'duration.hours': '{n}小时',
      'duration.days': '{n}天',
      'pool': '账号池 · {values}',
      'service.incident': '故障',
      'service.unknown': '状态不可用',
      'service.unknownWithError': '状态不可用（{error}）',
      'window.1h': '1 小时',
      'window.5h': '5 小时',
      'window.daily': '天',
      'window.7d': '周',
      'window.monthly': '月',
      'windowShort.1h': '1h',
      'windowShort.5h': '5h',
      'windowShort.daily': '天',
      'windowShort.7d': '周',
      'windowShort.monthly': '月',
      'windowName.1h': '小时',
      'windowName.daily': '天',
      'windowName.7d': '周',
      'windowName.monthly': '月',
      'explain.lead': '胶囊从左到右为各提供方的 5 小时窗口：{entries}。',
      'explain.fallback': '数字后的字母表示该提供方没有 5 小时额度，改为显示其最短窗口（{marks}）。',
      'explain.other': '其他窗口不计入这些数字，请看上方各行。',
      'explain.dash': '“—”表示该提供方没有可在胶囊中显示的额度。',
      'explain.down': '⚠ {services}：报告了故障，剩余额度可能无法使用。',
      'tooltip.error': '{label}：{error}',
      'tooltip.none': '{label}：未报告额度',
      'tooltip.value': '{label} · {window}：剩余 {value}%',
    }
    const ru = {
      'pill.aria': 'Лимиты провайдеров: {summary}',
      'pill.unavailable': 'Лимиты провайдеров недоступны',
      'title': 'Лимиты провайдеров',
      'legend': '% = остаток · 100% не тронуто, 0% исчерпано',
      'loading': 'Загрузка…',
      'loadError': 'Не удалось загрузить лимиты: {error}',
      'noProviders': 'Ни у одного настроенного провайдера нет известного API квот (TeamClaude, codex-lb, OpenCode Go).',
      'refresh': 'Обновить',
      'refreshing': 'Обновление…',
      'reset.in': 'сброс через {time} · {at}',
      'reset.overdue': 'сброс просрочен · {at}',
      'duration.underMinute': '<1м',
      'duration.minutes': '{n}м',
      'duration.hours': '{n}ч',
      'duration.days': '{n}д',
      'pool': 'пул аккаунтов · {values}',
      'service.incident': 'авария',
      'service.unknown': 'статус недоступен',
      'service.unknownWithError': 'статус недоступен ({error})',
      'window.1h': 'Час',
      'window.5h': '5 часов',
      'window.daily': 'День',
      'window.7d': 'Неделя',
      'window.monthly': 'Месяц',
      'windowShort.1h': '1ч',
      'windowShort.5h': '5ч',
      'windowShort.daily': 'день',
      'windowShort.7d': 'нед',
      'windowShort.monthly': 'мес',
      'windowName.1h': 'час',
      'windowName.daily': 'день',
      'windowName.7d': 'неделя',
      'windowName.monthly': 'месяц',
      'explain.lead': 'Слева направо — 5-часовое окно каждого провайдера: {entries}.',
      'explain.fallback': 'Буква после числа: у провайдера нет 5-часового лимита, показано самое короткое окно ({marks}).',
      'explain.other': 'Остальные окна в эти числа не входят — см. строки выше.',
      'explain.dash': '«—» — провайдер не сообщил лимит, который можно показать.',
      'explain.down': '⚠ {services}: сообщают об аварии, остаток квоты может быть бесполезен.',
      'tooltip.error': '{label}: {error}',
      'tooltip.none': '{label}: лимит не сообщён',
      'tooltip.value': '{label} · {window}: осталось {value}%',
    }

    const CSS = `
.pl-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px))}
.pl-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.pl-pill:hover,.pl-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.pl-pill svg{width:14px;height:14px;flex:none}
.pl-values{display:inline-flex;align-items:baseline;min-width:0;overflow:hidden}
.pl-sep{color:var(--dsw-alias-separator-primary, var(--dsw-alias-border-l2));margin:0 5px}
.pl-item[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.pl-item[data-tone=low]{color:var(--dsw-alias-state-error-primary)}
.pl-item[data-tone=unknown]{color:var(--dsw-alias-state-idle-primary, inherit)}
.pl-alert{color:var(--dsw-alias-state-warn-primary)}
.pl-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(${PANEL_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px));max-height:min(70vh, 560px);overflow-y:auto;overscroll-behavior:contain;padding:16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:default;display:flex;flex-direction:column;gap:10px}
.pl-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;color:var(--dsw-alias-label-primary);font-weight:500}
.pl-head-time{font-weight:400;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.pl-legend{margin-top:-8px;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.pl-rule{border-top:0.5px solid var(--dsw-alias-border-l2)}
.pl-services{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px}
.pl-service{display:inline-flex;align-items:center;gap:5px;min-width:0}
.pl-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}
.pl-service[data-state=down]{color:var(--dsw-alias-state-error-primary)}
.pl-service[data-state=down] .pl-dot{background:var(--dsw-alias-state-error-primary)}
.pl-service[data-state=unknown] .pl-dot{background:var(--dsw-alias-state-idle-primary)}
.pl-note,.pl-incident{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));overflow-wrap:anywhere}
.pl-incident{flex-basis:100%}
.pl-provider{display:flex;flex-direction:column;gap:4px}
.pl-provider-name{display:flex;justify-content:space-between;align-items:baseline;gap:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.pl-kind{font-weight:400;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.pl-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.pl-row{display:grid;grid-template-columns:minmax(84px, auto) minmax(60px, 1fr) 40px;align-items:center;gap:8px}
.pl-row-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pl-bar{position:relative;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}
.pl-bar>span{position:absolute;inset:0 auto 0 0;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.pl-bar[data-tone=warn]>span{background:var(--dsw-alias-state-warn-primary)}
.pl-bar[data-tone=low]>span{background:var(--dsw-alias-state-error-primary)}
.pl-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.pl-reset,.pl-pool{font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}
.pl-accounts{display:flex;flex-direction:column;gap:2px;margin-top:2px;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l2)}
.pl-account{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:0 8px;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.pl-account-name{flex:1 1 auto;min-width:min(100%, 120px);max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pl-account[data-disabled=true]{opacity:.5;text-decoration:line-through}
.pl-account-values{flex:0 1 auto;margin-left:auto;text-align:right;font-variant-numeric:tabular-nums}
.pl-explain{font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.pl-foot{display:flex;justify-content:flex-end}
.pl-button{padding:2px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.pl-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pl-button:disabled{cursor:default;opacity:.6}
`

    // ---- pure helpers -------------------------------------------------------

    const list = value => (Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object') : [])
    const pct = value => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null)
    const tone = value => (value <= LOW_PCT ? 'low' : value <= WARN_PCT ? 'warn' : 'ok')

    function clock24(ms) {
      return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    }

    function absoluteReset(ms) {
      const when = new Date(ms)
      const now = new Date()
      if (when.toDateString() === now.toDateString()) return clock24(ms)
      const date = when.toLocaleDateString(undefined, when.getFullYear() === now.getFullYear()
        ? { day: '2-digit', month: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' })
      return `${date} ${clock24(ms)}`
    }

    function resetCaption(resetAt, t) {
      if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0) return ''
      const at = absoluteReset(resetAt)
      const ms = resetAt - Date.now()
      if (ms <= 0) return t('reset.overdue', { at })
      const minutes = Math.round(ms / 60_000)
      const time = minutes < 1
        ? t('duration.underMinute')
        : minutes < 60
          ? t('duration.minutes', { n: minutes })
          : Math.round(minutes / 60) < 48
            ? t('duration.hours', { n: Math.round(minutes / 60) })
            : t('duration.days', { n: Math.round(minutes / 1440) })
      return t('reset.in', { time, at })
    }

    const KNOWN_WINDOWS = ['1h', '5h', 'daily', '7d', 'monthly']
    function bucketLabel(bucket, t, short) {
      const window = KNOWN_WINDOWS.includes(bucket.window) ? bucket.window : null
      if (window === null) return String(bucket.label ?? 'limit')
      const base = t(`${short ? 'windowShort' : 'window'}.${window}`)
      if (typeof bucket.qualifier !== 'string' || bucket.qualifier === '') return base
      return short ? `${base}/${bucket.qualifier}` : `${base} (${bucket.qualifier})`
    }

    // Shortest window first; 5h carries no letter because it is the pill's own window.
    const PILL_WINDOWS = [
      { window: '5h', mark: '' },
      { window: '1h', mark: 'h' },
      { window: 'daily', mark: 'd' },
      { window: '7d', mark: 'w' },
      { window: 'monthly', mark: 'm' },
    ]

    /** The provider's 5h row, else the tightest row of its shortest known window. */
    function pillBucket(provider) {
      for (const { window, mark } of PILL_WINDOWS) {
        let best = null
        for (const bucket of list(provider.buckets)) {
          if (bucket.window !== window) continue
          const value = pct(bucket.remainingPct)
          if (value !== null && (best === null || value < best.value)) best = { bucket, value, mark, window }
        }
        if (best !== null) return best
      }
      return null
    }

    function pillEntries(providers, t) {
      return list(providers).map((provider) => {
        const best = pillBucket(provider)
        const value = best === null ? null : Math.round(best.value)
        const label = String(provider.label ?? provider.id ?? '?')
        return {
          id: String(provider.id ?? label),
          label,
          value,
          mark: best?.mark ?? '',
          window: best?.window ?? '',
          tone: provider.ok === false || value === null ? 'unknown' : tone(value),
          title: provider.ok === false
            ? t('tooltip.error', { label, error: String(provider.error ?? '?') })
            : value === null
              ? t('tooltip.none', { label })
              : t('tooltip.value', { label, window: bucketLabel(best.bucket, t, false), value }),
        }
      })
    }

    const downServices = services => list(services).filter(service => service.ok === false)

    // ---- components ---------------------------------------------------------

    function FuelIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 2.5, y: 2, width: 7, height: 12, rx: 1.2 }),
        h('rect', { x: 4, y: 3.75, width: 4, height: 3, rx: 0.5 }),
        h('path', { d: 'M9.5 7.5h1.25a1 1 0 0 1 1 1v3.25a1 1 0 0 0 2 0V5.25L11.75 3.5' }))
    }

    function Bar({ value }) {
      return h('div', { className: 'pl-bar', 'data-tone': tone(Math.round(value)) },
        h('span', { style: { width: `${Math.max(2, value)}%` } }))
    }

    function BucketRow({ bucket, t }) {
      const value = pct(bucket.remainingPct)
      if (value === null) return null
      const label = bucketLabel(bucket, t, false)
      const reset = resetCaption(bucket.resetAt, t)
      return h('div', null,
        h('div', { className: 'pl-row' },
          h('span', { className: 'pl-row-label', title: bucket.detail || label }, label),
          h(Bar, { value }),
          h('span', { className: 'pl-value' }, `${Math.round(value)}%`)),
        reset !== '' && h('div', { className: 'pl-reset' }, reset))
    }

    function AccountRow({ account, t }) {
      const values = list(account.buckets)
        .filter(bucket => pct(bucket.remainingPct) !== null)
        .map(bucket => `${bucketLabel(bucket, t, true)} ${Math.round(pct(bucket.remainingPct))}%`)
        .join(' · ')
      return h('div', { className: 'pl-account', 'data-disabled': String(account.disabled === true) },
        h('span', { className: 'pl-account-name', title: account.tier || account.name }, String(account.name ?? '')),
        h('span', { className: 'pl-account-values' }, values || '—'))
    }

    function ProviderBlock({ provider, t }) {
      const pool = list(provider.poolWindows).filter(window => pct(window.remainingPct) !== null)
      const accounts = list(provider.accounts)
      return h('div', { className: 'pl-provider' },
        h('div', { className: 'pl-provider-name' },
          h('span', null, String(provider.label ?? provider.id ?? '')),
          h('span', { className: 'pl-kind' }, String(provider.kind ?? ''))),
        provider.ok === false && h('div', { className: 'pl-error' }, String(provider.error ?? '?')),
        list(provider.buckets).map(bucket => h(BucketRow, { key: bucket.key, bucket, t })),
        pool.length > 0 && h('div', { className: 'pl-pool' }, t('pool', {
          values: pool.map(window => `${bucketLabel(window, t, false)} ${Math.round(pct(window.remainingPct))}%`).join(' · '),
        })),
        accounts.length > 0 && h('div', { className: 'pl-accounts' },
          accounts.map((account, index) => h(AccountRow, { key: `${account.name}#${index}`, account, t }))))
    }

    function ServiceRow({ service, t }) {
      const state = service.ok === true ? 'up' : service.ok === false ? 'down' : 'unknown'
      const note = state === 'down'
        ? String(service.description || t('service.incident'))
        : state === 'unknown'
          ? (service.error ? t('service.unknownWithError', { error: String(service.error) }) : t('service.unknown'))
          : ''
      const title = [
        `${service.label}: ${service.description || state}`,
        service.component ? `${service.component} — ${service.componentStatus || '?'}` : '',
      ].filter(Boolean).join('\n')
      return h('span', { className: 'pl-service', 'data-state': state, title },
        h('span', { className: 'pl-dot' }),
        h('span', null, String(service.label ?? service.id ?? '')),
        note !== '' && h('span', { className: 'pl-note' }, `· ${note}`))
    }

    function Services({ services, t }) {
      const rows = list(services)
      if (rows.length === 0) return null
      const incidents = rows.flatMap(service => (Array.isArray(service.incidents) ? service.incidents : [])
        .map(name => `${service.label}: ${name}`))
      return h('div', { className: 'pl-services' },
        rows.map(service => h(ServiceRow, { key: service.id, service, t })),
        incidents.map((text, index) => h('span', { key: `incident-${index}`, className: 'pl-incident' }, text)))
    }

    function Explainer({ entries, services, t }) {
      if (entries.length === 0) return null
      const lines = [t('explain.lead', {
        entries: entries.map(entry => `${entry.label} ${entry.value === null ? '—' : `${entry.value}%${entry.mark}`}`).join(', '),
      })]
      const fallbacks = entries.filter(entry => entry.mark !== '')
      if (fallbacks.length > 0) {
        const marks = [...new Set(fallbacks.map(entry => `${entry.mark} = ${t(`windowName.${entry.window}`)}`))].join(', ')
        lines.push(t('explain.fallback', { marks }))
      }
      if (entries.some(entry => entry.value !== null)) lines.push(t('explain.other'))
      if (entries.some(entry => entry.value === null)) lines.push(t('explain.dash'))
      const down = downServices(services)
      if (down.length > 0) lines.push(t('explain.down', { services: down.map(service => service.label).join(', ') }))
      return h('div', { className: 'pl-explain' }, lines.join(' '))
    }

    function Panel({ state, entries, refresh, t, panelRef, position }) {
      const data = state.data
      const providers = list(data?.providers)
      return h('div', {
        ref: panelRef,
        className: 'pl-panel',
        role: 'dialog',
        'aria-label': t('title'),
        style: position,
      },
      h(Services, { services: data?.services, t }),
      h('div', { className: 'pl-head' },
        h('span', null, t('title')),
        h('span', { className: 'pl-head-time' }, data?.fetchedAt ? clock24(data.fetchedAt) : '')),
      h('div', { className: 'pl-legend' }, t('legend')),
      h('div', { className: 'pl-rule', 'aria-hidden': true }),
      state.error !== null && h('div', { className: 'pl-error' }, t('loadError', { error: state.error })),
      typeof data?.error === 'string' && data.error !== '' && h('div', { className: 'pl-error' }, data.error),
      data === null && state.error === null && h('div', null, t('loading')),
      data !== null && providers.length === 0 && !data.error && h('div', null, t('noProviders')),
      providers.map(provider => h(ProviderBlock, { key: provider.id, provider, t })),
      providers.length > 0 && h('div', { className: 'pl-rule', 'aria-hidden': true }),
      h(Explainer, { entries, services: data?.services, t }),
      h('div', { className: 'pl-foot' },
        h('button', { type: 'button', className: 'pl-button', disabled: state.loading, onClick: () => { refresh() } },
          state.loading ? t('refreshing') : t('refresh'))))
    }

    function panelPosition(anchor) {
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_MARGIN * 2)
      const left = Math.min(Math.max(PANEL_MARGIN, rect.right - width), window.innerWidth - width - PANEL_MARGIN)
      return { left, bottom: Math.max(PANEL_MARGIN, window.innerHeight - rect.top + PANEL_GAP) }
    }

    function LimitsPill({ useLimits, refresh, t }) {
      const state = useLimits(value => value)
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      // The panel is portaled and fixed, so its placement follows the
      // anchor's viewport rectangle; recomputed on resize and scroll while open.
      React.useEffect(() => {
        if (!open) return undefined
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

      const entries = pillEntries(state.data?.providers, t)
      const down = downServices(state.data?.services)
      const failed = state.data === null && state.error !== null
      const summary = failed
        ? t('pill.unavailable')
        : entries.map(entry => entry.title).concat(down.length > 0 ? [t('explain.down', { services: down.map(s => s.label).join(', ') })] : []).join('\n')
      const values = failed || entries.length === 0
        ? [h('span', { key: 'none', className: 'pl-item', 'data-tone': 'unknown' }, '—')]
        : entries.flatMap((entry, index) => [
          index > 0 && h('span', { key: `sep-${entry.id}`, className: 'pl-sep', 'aria-hidden': true }, '|'),
          h('span', { key: entry.id, className: 'pl-item', 'data-tone': entry.tone }, entry.value === null ? '—' : `${entry.value}%${entry.mark}`),
        ].filter(Boolean))

      return h('span', { ref: rootRef, className: 'pl-anchor', 'data-composer-stat': 'provider-limits' },
        h('button', {
          type: 'button',
          className: 'pl-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('pill.aria', { summary: summary || t('title') }),
          title: summary || t('title'),
          onClick: () => { setOpen(!open) },
        },
        h(FuelIcon),
        down.length > 0 && h('span', { className: 'pl-alert', 'aria-hidden': true }, '⚠'),
        h('span', { className: 'pl-values' }, values)),
        open && createPortal(h(Panel, {
          state, entries, refresh, t, panelRef,
          position: position ?? { visibility: 'hidden', left: 0, bottom: 0 },
        }), document.body))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'provider-limits: dictionaries')
        ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'provider-limits: ru dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'provider-limits: stylesheet')

        const limits = createSnapshotStore({ data: null, error: null, loading: false })
        let disposed = false
        let controller = null
        let timer = null
        let pollMs = 45_000

        const schedule = () => {
          clearTimeout(timer)
          if (!disposed) timer = setTimeout(() => { void load(false) }, pollMs)
        }

        async function load(force) {
          if (disposed) return
          if (!force && document.visibilityState === 'hidden') { schedule(); return }
          controller?.abort()
          const own = new AbortController()
          controller = own
          limits.set({ ...limits.getSnapshot(), loading: true })
          try {
            const response = await fetch(force ? `${ROUTE}?refresh=1` : ROUTE, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
              signal: own.signal,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (disposed || controller !== own) return
            if (typeof data.pollMs === 'number' && data.pollMs >= 1000) pollMs = data.pollMs
            limits.set({ data, error: null, loading: false })
          } catch (error) {
            if (disposed || controller !== own) return
            limits.set({ ...limits.getSnapshot(), error: error instanceof Error ? error.message : String(error), loading: false })
          } finally {
            if (controller === own) {
              controller = null
              schedule()
            }
          }
        }

        const onVisible = () => { if (document.visibilityState === 'visible') void load(false) }
        ctx.effect(() => {
          void load(false)
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            disposed = true
            clearTimeout(timer)
            controller?.abort()
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, 'provider-limits: polling')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'provider-limits',
          order: 2,
          locale: NS,
          inject: () => ({ hooks: { limits }, refresh: () => { void load(true) } }),
        }, LimitsPill))
      },
    }
  },
})
