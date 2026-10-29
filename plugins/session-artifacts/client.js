// Client half of session-artifacts: the right Sidebar page tab "Artifacts" lists
// the documents the open Session produced or touched — written, edited, patched,
// presented or mentioned — read from the Session's durable log on the server, plus
// the plans it presented and their review outcome. A row opens the file in the
// Sidebar's own preview tab; a secondary control copies the absolute path.
//
// State lives per Session: the renderer calls the injected face once for each
// Session binding, so two Sessions whose tabs happen to share an id keep separate
// records and separate requests.
window.__ModuleLoader__.load({
  id: '@local/dsh-session-artifacts',
  factory(require) {
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const h = React.createElement

    // Host renderers, as in the chat. Their APIs are not a plugin contract: each
    // is optional, and the list falls back to plain text and plain titles.
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
      } catch {
        return {}
      }
    })()
    const MarkdownText = primitives.MarkdownText ?? null
    const PathLabel = primitives.PathLabel ?? null
    const Tooltip = primitives.Tooltip ?? null

    const NS = 'session-artifacts'
    const ID = '@local/dsh-session-artifacts'
    const KIND = 'session-artifacts'
    const LIST_ROUTE = 'api/session-artifacts.list'
    const PREFS_KEY = 'session-artifacts:prefs'
    const POLL_MS = 5000
    const NOW_TICK_MS = 60000
    // Kinds the Host reports, in the order the filter chips list them. `other`
    // is the defensive bucket for a kind this build does not know.
    const KINDS = ['markdown', 'pdf', 'html', 'office', 'text', 'data', 'image', 'other']
    const PLAN_STATUSES = ['approved', 'rejected', 'pending']
    const SORTS = ['recent', 'name']
    const DEFAULT_PREFS = { kind: 'all', hideMissing: false, sort: 'recent' }
    // Host failures the panel names. A plain-text 404 has no JSON body, so it
    // arrives as `http-404` and means the route itself is missing.
    const ERROR_TEXT = {
      'not-found': 'error.not-found',
      'bad-request': 'error.bad-request',
      'read-failed': 'error.read-failed',
      'unloading': 'error.unloading',
      'network': 'error.network',
      'http-404': 'error.restart',
    }

    const en = {
      'type.label': 'Artifacts',
      'guide.title': 'Session artifacts',
      'guide.description': 'Documents this session wrote, edited, presented or mentioned',
      'button.aria': 'Session artifacts',
      'filter.placeholder': 'Filter by name or path',
      'filter.aria': 'Filter documents by name or path',
      'filter.clear': 'Clear the filter',
      'chips.aria': 'Document types',
      'chip.all': 'All',
      'toggle.hideMissing': 'Hide missing',
      'sort.aria': 'Sort: {mode}',
      'sort.recent': 'Recent first',
      'sort.name': 'By name',
      'sort.switch': 'Change the sort order',
      'refresh': 'Refresh',
      'refresh.aria': 'Refresh the document list',
      'status.documents.one': '{documents} document',
      'status.documents.other': '{documents} documents',
      'status.plans.one': '{plans} plan',
      'status.plans.other': '{plans} plans',
      'status.shown': '{shown} of {total} shown',
      'status.truncated': 'first {n} listed',
      'empty.title': 'This session has no documents yet',
      'empty.hint': 'Files the agent writes, edits, presents or mentions appear here.',
      'empty.filtered': 'Nothing matches the filter',
      'empty.filtered.hint': 'Change the query or pick another type.',
      'error.title': 'Could not load the list',
      'error.not-found': "This session's log was not found",
      'error.bad-request': 'The server rejected the request',
      'error.read-failed': 'Could not read the session log',
      'error.unloading': 'The plugin is being unloaded — try again',
      'error.network': 'No connection to the server',
      'error.restart': 'The plugin is not fully loaded — restart DSH',
      'error.other': 'Something went wrong while loading the list. Try again.',
      'error.retry': 'Retry',
      'row.copy': 'Copy the path of {name}',
      'row.copied': 'Path copied: {name}',
      'row.copyFailed': 'Could not copy the path of {name}',
      'row.missing': 'The file is no longer on disk',
      'row.rootDir': 'root',
      'badge.created': 'new',
      'badge.edited': 'edited',
      'badge.presented': 'presented',
      'badge.missing': 'missing',
      'badge.deleted': 'deleted',
      'time.lastChange': 'Last change: {time}',
      'time.lastTouch': 'Last seen: {time}',
      'plans.title': 'Plans',
      'plans.turn': 'turn {n}',
      'plans.untitled': 'Untitled plan',
      'plans.truncated': 'The plan is longer than the stored limit',
      'planStatus.approved': 'approved',
      'planStatus.rejected': 'rejected',
      'planStatus.pending': 'awaiting approval',
      'kind.markdown': 'Markdown',
      'kind.pdf': 'PDF',
      'kind.html': 'HTML',
      'kind.office': 'Office',
      'kind.text': 'Text',
      'kind.data': 'Data',
      'kind.image': 'Images',
      'kind.other': 'Other',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.footnotes': 'Footnotes',
    }
    const zh = {
      'type.label': '产物',
      'guide.title': '会话产物',
      'guide.description': '本会话创建、修改、交付或提到的文档',
      'button.aria': '会话产物',
      'filter.placeholder': '按名称或路径筛选',
      'filter.aria': '按名称或路径筛选文档',
      'filter.clear': '清除筛选',
      'chips.aria': '文档类型',
      'chip.all': '全部',
      'toggle.hideMissing': '隐藏缺失文件',
      'sort.aria': '排序：{mode}',
      'sort.recent': '最新优先',
      'sort.name': '按名称',
      'sort.switch': '切换排序',
      'refresh': '刷新',
      'refresh.aria': '刷新文档列表',
      'status.documents.other': '{documents} 个文档',
      'status.plans.other': '{plans} 个计划',
      'status.shown': '已显示 {shown} / {total}',
      'status.truncated': '仅列出前 {n} 条',
      'empty.title': '此会话尚无文档',
      'empty.hint': '智能体写入、修改、交付或提到的文件会出现在这里',
      'empty.filtered': '没有符合筛选条件的文档',
      'empty.filtered.hint': '修改关键词或选择其他类型',
      'error.title': '无法加载列表',
      'error.not-found': '未找到该会话的日志',
      'error.bad-request': '服务器拒绝了请求',
      'error.read-failed': '无法读取会话日志',
      'error.unloading': '插件正在卸载，请稍后再试',
      'error.network': '无法连接服务器',
      'error.restart': '插件未完整加载，请重启 DSH',
      'error.other': '加载列表时出错，请重试',
      'error.retry': '重试',
      'row.copy': '复制路径：{name}',
      'row.copied': '已复制路径：{name}',
      'row.copyFailed': '复制失败：{name}',
      'row.missing': '文件已不在磁盘上',
      'row.rootDir': '根目录',
      'badge.created': '新建',
      'badge.edited': '已修改',
      'badge.presented': '已交付',
      'badge.missing': '缺失',
      'badge.deleted': '已删除',
      'time.lastChange': '最后修改：{time}',
      'time.lastTouch': '最近出现：{time}',
      'plans.title': '计划',
      'plans.turn': '第 {n} 轮',
      'plans.untitled': '未命名计划',
      'plans.truncated': '计划超出保存上限',
      'planStatus.approved': '已批准',
      'planStatus.rejected': '已拒绝',
      'planStatus.pending': '待批准',
      'kind.markdown': 'Markdown',
      'kind.pdf': 'PDF',
      'kind.html': 'HTML',
      'kind.office': 'Office',
      'kind.text': '文本',
      'kind.data': '数据',
      'kind.image': '图片',
      'kind.other': '其他',
      'md.copy': '复制',
      'md.copied': '已复制',
      'md.footnotes': '脚注',
    }
    const ru = {
      'type.label': 'Артефакты',
      'guide.title': 'Артефакты сессии',
      'guide.description': 'Документы, которые сессия создала, изменила, показала или упомянула',
      'button.aria': 'Артефакты сессии',
      'filter.placeholder': 'Фильтр по имени или пути',
      'filter.aria': 'Фильтр документов по имени или пути',
      'filter.clear': 'Очистить фильтр',
      'chips.aria': 'Типы документов',
      'chip.all': 'Все',
      'toggle.hideMissing': 'Скрыть пропавшие',
      'sort.aria': 'Порядок: {mode}',
      'sort.recent': 'Сначала свежие',
      'sort.name': 'По имени',
      'sort.switch': 'Сменить порядок сортировки',
      'refresh': 'Обновить',
      'refresh.aria': 'Обновить список документов',
      'status.documents.one': '{documents} документ',
      'status.documents.few': '{documents} документа',
      'status.documents.many': '{documents} документов',
      'status.plans.one': '{plans} план',
      'status.plans.few': '{plans} плана',
      'status.plans.many': '{plans} планов',
      'status.shown': 'Показано {shown} из {total}',
      'status.truncated': 'показаны первые {n}',
      'empty.title': 'В этой сессии ещё нет документов',
      'empty.hint': 'Сюда попадут файлы, которые агент записал, изменил, показал или упомянул.',
      'empty.filtered': 'Под фильтр ничего не подходит',
      'empty.filtered.hint': 'Измените запрос или выберите другой тип.',
      'error.title': 'Не удалось загрузить список',
      'error.not-found': 'Журнал этой сессии не найден',
      'error.bad-request': 'Сервер отклонил запрос',
      'error.read-failed': 'Не удалось прочитать лог сессии',
      'error.unloading': 'Плагин выгружается — попробуйте ещё раз',
      'error.network': 'Нет связи с сервером',
      'error.restart': 'Серверная часть плагина не загружена — перезапустите DSH',
      'error.other': 'При загрузке списка что-то пошло не так. Попробуйте ещё раз.',
      'error.retry': 'Повторить',
      'row.copy': 'Копировать путь: {name}',
      'row.copied': 'Путь скопирован: {name}',
      'row.copyFailed': 'Не удалось скопировать путь: {name}',
      'row.missing': 'Файла больше нет на диске',
      'row.rootDir': 'корень',
      'badge.created': 'новый',
      'badge.edited': 'изменён',
      'badge.presented': 'показан',
      'badge.missing': 'пропал',
      'badge.deleted': 'удалён',
      'time.lastChange': 'Последнее изменение: {time}',
      'time.lastTouch': 'Последнее появление: {time}',
      'plans.title': 'Планы',
      'plans.turn': 'ход {n}',
      'plans.untitled': 'План без названия',
      'plans.truncated': 'План длиннее сохранённого предела',
      'planStatus.approved': 'одобрен',
      'planStatus.rejected': 'отклонён',
      'planStatus.pending': 'ждёт решения',
      'kind.markdown': 'Markdown',
      'kind.pdf': 'PDF',
      'kind.html': 'HTML',
      'kind.office': 'Office',
      'kind.text': 'Текст',
      'kind.data': 'Данные',
      'kind.image': 'Картинки',
      'kind.other': 'Другое',
      'md.copy': 'Копировать',
      'md.copied': 'Скопировано',
      'md.footnotes': 'Сноски',
    }

    const CSS = `
.sa-root{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;container-type:inline-size;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary, 13px);line-height:1.5}
.sa-toolbar{display:flex;flex:none;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 6px 0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.sa-search{position:relative;display:flex;flex:1 1 auto;align-items:center;min-width:0}
.sa-input{flex:1 1 auto;min-width:0;box-sizing:border-box;height:26px;padding:0 26px 0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:24px;outline-style:none}
.sa-input:focus{border-color:var(--dsw-alias-brand-primary)}
.sa-input:focus-visible{outline-style:solid;outline-offset:1px}
.sa-input::placeholder{color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.sa-clear{position:absolute;right:3px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));cursor:pointer}
.sa-clear:focus-visible{outline-style:solid;outline-offset:1px}
.sa-clear svg{width:11px;height:11px}
.sa-tool{display:inline-flex;flex:none;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}
.sa-tool:focus-visible{outline-style:solid;outline-offset:-2px}
.sa-tool:disabled{cursor:default;opacity:.45}
.sa-tool[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-brand-primary)}
.sa-tool svg{width:15px;height:15px}
.sa-tool[data-busy=true] svg{animation:sa-spin 1s linear infinite}
.sa-copy{align-self:center;margin-right:2px}
.sa-chips{display:flex;flex:none;flex-wrap:wrap;gap:4px;padding:7px 8px 1px}
.sa-chip{display:inline-flex;flex:none;align-items:center;gap:4px;box-sizing:border-box;height:22px;padding:0 8px;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;white-space:nowrap;cursor:pointer}
.sa-chip:focus-visible{outline-style:solid;outline-offset:1px}
.sa-chip[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-brand-primary)}
.sa-chip-count{font-variant-numeric:tabular-nums;opacity:.72}
.sa-options{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:4px;padding:5px 8px}
.sa-option{display:inline-flex;flex:none;align-items:center;gap:4px;box-sizing:border-box;height:22px;padding:0 7px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;white-space:nowrap;cursor:pointer}
.sa-option:focus-visible{outline-style:solid;outline-offset:1px}
.sa-option[aria-pressed=true]{color:var(--dsw-alias-brand-primary)}
.sa-option svg{width:11px;height:11px}
.sa-spacer{flex:1 1 auto}
.sa-status{padding:0 14px 7px;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sa-error{margin:0 10px 8px;padding:8px 10px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);font-size:11px}
.sa-error-title{margin:0;font-weight:500;color:var(--dsw-alias-state-error-primary)}
.sa-error-text{margin:2px 0 0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sa-retry{margin-top:6px;background:var(--dsw-alias-bg-layer-1)}
.sa-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;margin-right:2px;padding:0 0 14px;scrollbar-gutter:stable}
.sa-skeleton{margin:0;padding:6px 8px}
.sa-skeleton-row{display:flex;gap:8px;align-items:center;padding:7px 6px}
.sa-skeleton-bar{height:9px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);animation:sa-pulse 1.4s ease-in-out infinite}
.sa-skeleton-bar[data-w=kind]{width:34px;height:18px;border-radius:var(--dsw-radius-sm)}
.sa-skeleton-bar[data-w=name]{width:46%}
.sa-skeleton-bar[data-w=dir]{width:64%}
.sa-list{margin:0;padding:0;list-style:none}
.sa-item{padding:0 8px}
.sa-row{display:flex;align-items:stretch;border-bottom:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}
.sa-item:last-child .sa-row{border-bottom:none}
.sa-open{display:flex;flex:1 1 auto;gap:8px;min-width:0;padding:7px 6px 7px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sa-open:focus-visible{outline-style:solid;outline-offset:-2px}
.sa-open[aria-disabled=true]{cursor:default;opacity:.6}
.sa-kind{display:inline-flex;flex:none;align-items:center;justify-content:center;box-sizing:border-box;min-width:34px;height:18px;margin-top:2px;padding:0 5px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:500;line-height:1;letter-spacing:.03em;text-transform:uppercase}
.sa-kind[data-kind=markdown]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.sa-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.sa-name{display:block;overflow:hidden;font-size:inherit;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.sa-dir-line{display:flex;gap:6px;align-items:baseline;min-width:0}

.sa-dir{flex:1 1 auto;min-width:0;overflow:hidden;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));white-space:nowrap}
.sa-dir-fallback{display:block;text-overflow:ellipsis}
.sa-dir[data-path-label] span,
.sa-dir[data-path-label] span:last-child,
.sa-dir [data-path-label] span,
.sa-dir [data-path-label] span:last-child{color:inherit;font-weight:inherit}
.sa-time-inline{display:none;flex:none;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;white-space:nowrap}
.sa-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.sa-badge{padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:15px}
.sa-badge[data-tone=created]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);color:var(--dsw-alias-state-success-primary)}
.sa-badge[data-tone=presented]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary)}
.sa-badge[data-tone=missing]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.sa-badge[data-tone=deleted]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.sa-desc{margin:2px 0 0;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.sa-time{flex:none;align-self:flex-start;max-width:40%;overflow:hidden;margin-top:9px;padding-right:2px;text-overflow:ellipsis;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;white-space:nowrap}
.sa-empty{display:flex;flex-direction:column;gap:3px;padding:18px 16px}
.sa-empty-title{margin:0;font-size:inherit;color:var(--dsw-alias-label-secondary)}
.sa-empty-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.sa-plans{margin:0 0 10px;padding:6px 8px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.sa-section{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;margin:0;padding:4px 8px 6px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font:inherit;font-size:11px;font-weight:500;line-height:14px;letter-spacing:.04em;text-transform:uppercase;text-align:left;cursor:pointer}
.sa-section:focus-visible{outline-style:solid;outline-offset:1px}
.sa-section-count{margin-left:auto;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums}
.sa-chevron{flex:none;display:inline-flex;color:inherit;transition:transform .12s ease}
.sa-chevron svg{display:block;width:11px;height:11px}
.sa-chevron[data-open=true]{transform:rotate(90deg)}
.sa-plan-list{margin:0;padding:0 0 4px;list-style:none}
.sa-plan-head{display:flex;align-items:flex-start;gap:6px;box-sizing:border-box;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.sa-plan-head:focus-visible{outline-style:solid;outline-offset:-2px}
.sa-plan-title{flex:1 1 auto;min-width:0;overflow:hidden;font-size:inherit;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.sa-plan-meta{flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;white-space:nowrap}
.sa-plan-badge{flex:none;margin-top:1px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:15px}
.sa-plan-badge[data-status=approved]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);color:var(--dsw-alias-state-success-primary)}
.sa-plan-badge[data-status=rejected]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent);color:var(--dsw-alias-state-error-primary)}
.sa-plan-body{padding:2px 8px 10px 24px;font-size:inherit;line-height:1.55;overflow-wrap:anywhere}
.sa-plain{margin:0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.sa-note{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))}
.sa-title-icon{display:inline-flex;flex:none;align-items:center;color:inherit}
.sa-title-icon svg{display:block}
.sa-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@keyframes sa-spin{to{transform:rotate(360deg)}}
@keyframes sa-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@container (max-width:260px){.sa-time{display:none}.sa-time-inline{display:inline}}
@media (hover:hover){
.sa-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sa-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.sa-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sa-option:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sa-open:not([aria-disabled=true]):hover{background:var(--dsw-alias-interactive-bg-hover)}
.sa-plan-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sa-section:hover{color:var(--dsw-alias-label-primary)}
}
@media (prefers-reduced-motion: reduce){.sa-tool[data-busy=true] svg,.sa-skeleton-bar{animation:none}.sa-chevron{transition:none}}
`

    // One motif everywhere: a page with a folded corner, three text lines, and a
    // small badge at the bottom-right. The monochrome glyph serves the chip and
    // the header; the fixed-palette artwork serves the guide; icon.svg is the
    // same drawing at 24 units with the brand background.
    function ArtifactsGlyph({ size = 16, className } = {}) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className,
        'aria-hidden': true,
      },
      h('path', { d: 'M7.1 3.4h5.4l3.9 3.9v10.2a2 2 0 0 1-2 2H7.1a2 2 0 0 1-2-2V5.4a2 2 0 0 1 2-2z' }),
      h('path', { d: 'M12.5 3.4v4h4z' }),
      h('path', { d: 'M8 10.3h5M8 13.3h5M8 16.3h3.1' }),
      h('circle', { cx: 17.9, cy: 17.9, r: 2.9, fill: 'currentColor', stroke: 'none' }))
    }

    /** The guide's entry artwork: the same page-and-badge drawing, filled. */
    function ArtifactsArtwork({ size = 36, className } = {}) {
      return h('svg', {
        viewBox: '0 0 36 36',
        width: size,
        height: size,
        className,
        fill: 'none',
        'aria-hidden': true,
      },
      h('path', { d: 'M11.4 5.6h9.6l6.2 6.2v16.4a3 3 0 0 1-3 3H11.4a3 3 0 0 1-3-3V8.6a3 3 0 0 1 3-3z', fill: '#4A9BD1' }),
      h('path', { d: 'M21 5.6l6.2 6.2H21z', fill: '#2D6A8F' }),
      h('path', { d: 'M13.6 16.4h8.8M13.6 20.9h8.8M13.6 25.4h5.4', stroke: '#ffffff', strokeWidth: 2.2, strokeLinecap: 'round' }),
      h('circle', { cx: 27.6, cy: 27.6, r: 4.4, fill: '#2D6A8F', stroke: '#ffffff', strokeWidth: 2 }))
    }

    function RefreshIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M13.2 6.5A5.4 5.4 0 0 0 3.6 5.1L2 6.9' }),
        h('path', { d: 'M2 3.2v3.7h3.7' }),
        h('path', { d: 'M2.8 9.5a5.4 5.4 0 0 0 9.6 1.4l1.6-1.8' }),
        h('path', { d: 'M14 12.8V9.1h-3.7' }))
    }

    function CopyIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 5.6, y: 5.6, width: 7.6, height: 7.6, rx: 1.4 }),
        h('path', { d: 'M10.6 3.9a1.4 1.4 0 0 0-1.4-1.4H4.2a1.4 1.4 0 0 0-1.4 1.4v5a1.4 1.4 0 0 0 1.4 1.4' }))
    }

    function CheckIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M2.9 8.4 6.1 11.6 13.1 4.6' }))
    }

    function ClearIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    function ChevronIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M6 3.5 10.5 8 6 12.5' }))
    }

    function SortIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4.5 3v10M4.5 3 2.2 5.3M4.5 3l2.3 2.3' }),
        h('path', { d: 'M11.5 13V3M11.5 13l-2.3-2.3M11.5 13l2.3-2.3' }))
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
        console.warn(`session-artifacts: cannot save ${key}`, error)
      }
    }

    /**
     * The tab's persisted filters. Only the chip, the missing toggle and the sort
     * order persist; the text query and the open rows belong to one tab record.
     * @returns {{ kind: string, hideMissing: boolean, sort: string }} validated preferences.
     */
    function readPrefs() {
      const stored = readJson(PREFS_KEY, null)
      if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return { ...DEFAULT_PREFS }
      const kind = stored.kind === 'all' || KINDS.includes(stored.kind) ? stored.kind : 'all'
      return {
        kind,
        hideMissing: stored.hideMissing === true,
        sort: SORTS.includes(stored.sort) ? stored.sort : 'recent',
      }
    }

    // fileAddressFor / sessionFileAddress, copied from
    // packages/util/workspace-path/src/{index.ts,file-address.ts}: the package is
    // not in the browser module table, so a plain-JS plugin cannot require it,
    // and an address the document preview refuses is worse than a copy. Keep the
    // two in step.
    const encodeSegment = segment => encodeURIComponent(segment).replace(/%3A/gi, ':')
    const encodePath = path => path.split('/').map(encodeSegment).join('/')

    /** @param {string} sessionId @param {string} path @returns {string} the session-scoped file address. */
    function sessionFileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
    }

    /** @param {string} sessionId @param {string | null | undefined} cwd @param {string} path @returns {string} the address the Sidebar's preview opens. */
    function fileAddressFor(sessionId, cwd, path) {
      const normalized = path.replace(/\\/g, '/')
      const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
      if (!absolute) return sessionFileAddress(sessionId, normalized)
      const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
      if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
      return sessionFileAddress(sessionId, normalized)
    }

    /** @param {string} path @returns {string} the last `/`-separated segment. */
    function baseName(path) {
      const normalized = String(path).replace(/\\/g, '/')
      return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
    }

    /**
     * Shorten a path from the middle, keeping its root hint and its tail. Used
     * only when the primitives' PathLabel is unavailable.
     * @param {string} text - the path to shorten.
     * @param {number} max - the longest text to return.
     * @returns {string} the text, or its head and tail joined by an ellipsis.
     */
    function middleEllipsis(text, max) {
      if (text.length <= max) return text
      const head = Math.ceil((max - 1) / 3)
      const tail = max - 1 - head
      return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
    }

    /** @param {number} ms @returns {boolean} whether the time is a usable number. */
    const isTime = ms => typeof ms === 'number' && Number.isFinite(ms) && ms > 0

    const UNITS = [
      ['year', 31536000], ['month', 2592000], ['week', 604800],
      ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
    ]

    /**
     * Formatters bound to one language. The face caches one set per active
     * locale, so a language switch rebinds them with the next render.
     * @param {string} locale - the active locale id (`en`, `zh`, `ru`).
     * @returns {{ tag: string, relative: Intl.RelativeTimeFormat | null, collator: Intl.Collator, plural: Intl.PluralRules | null }} the set.
     */
    function makeFormatters(locale) {
      const tag = typeof locale === 'string' && locale !== '' ? locale : undefined
      return {
        tag: tag ?? '',
        relative: typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }) : null,
        collator: new Intl.Collator(tag, { numeric: true, sensitivity: 'base' }),
        plural: typeof Intl.PluralRules === 'function' ? new Intl.PluralRules(tag) : null,
      }
    }

    /**
     * Localized "5 minutes ago".
     * @param {number} time - event time in ms.
     * @param {number} now - the current time in ms.
     * @param {{ relative: Intl.RelativeTimeFormat | null }} formatters - the active language's set.
     * @returns {string} the relative time, or an empty string for an unusable time.
     */
    function relativeTime(time, now, formatters) {
      if (!isTime(time)) return ''
      if (formatters.relative === null) return new Date(time).toLocaleString()
      const seconds = Math.round((time - now) / 1000)
      for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size || unit === 'second') return formatters.relative.format(Math.round(seconds / size), unit)
      }
      return formatters.relative.format(0, 'second')
    }

    /** @param {number} time @returns {string} the absolute local time for a tooltip. */
    function absoluteTime(time) {
      return isTime(time) ? new Date(time).toLocaleString() : ''
    }

    /**
     * A count in the reader's plural category.
     * @param {(key: string, params?: Record<string, unknown>) => string} t - namespace-bound translate.
     * @param {string} base - the key family (`status.documents`).
     * @param {string} param - the placeholder the number fills.
     * @param {number} count - the number to name.
     * @param {Intl.PluralRules | null} rules - the active language's rules.
     * @returns {string} the translated count.
     */
    function plural(t, base, param, count, rules) {
      const category = rules === null ? 'other' : rules.select(count)
      const candidates = [`${base}.${category}`, `${base}.other`, base]
      const key = candidates.find(candidate => t(candidate) !== candidate) ?? base
      return t(key, { [param]: String(count) })
    }

    /**
     * The directory a row shows: the relative one the Host reported, or the
     * absolute one when the file lies outside the directory it reported.
     * @param {{ relPath: string | null, path: string }} artifact - the row.
     * @param {(key: string) => string} t - namespace-bound translate.
     * @returns {string} the directory text.
     */
    function directoryOf(artifact, t) {
      const relative = artifact.relPath
      if (typeof relative === 'string' && relative !== '') {
        const cut = relative.lastIndexOf('/')
        return cut > 0 ? relative.slice(0, cut) : t('row.rootDir')
      }
      const normalized = String(artifact.path).replace(/\\/g, '/')
      const cut = normalized.lastIndexOf('/')
      return cut > 0 ? normalized.slice(0, cut) : normalized
    }

    /**
     * The type badge: the extension, or the kind's name when the file has none.
     * @param {{ ext: string, kind: string }} artifact - the row.
     * @param {(key: string) => string} t - namespace-bound translate.
     * @returns {string} at most four characters.
     */
    function badgeText(artifact, t) {
      const text = artifact.ext !== '' ? artifact.ext : t(`kind.${artifact.kind}`)
      return text.slice(0, 4).toUpperCase()
    }

    /** @param {{ sources: string[], created: boolean, ops: number }} artifact @returns {boolean} whether the file changed after it appeared. */
    function wasEdited(artifact) {
      if (artifact.sources.includes('edit')) return true
      return artifact.ops > (artifact.created ? 1 : 0)
    }

    /**
     * The row's badges in display order. A file whose last operation removed it
     * shows the neutral "deleted" badge instead of the red "missing" one.
     * @param {object} artifact - the normalized row.
     * @param {(key: string) => string} t - namespace-bound translate.
     * @returns {{ tone: string, text: string }[]} the badges.
     */
    function artifactBadges(artifact, t) {
      const badges = []
      if (artifact.created) badges.push({ tone: 'created', text: t('badge.created') })
      if (wasEdited(artifact)) badges.push({ tone: 'edited', text: t('badge.edited') })
      if (artifact.sources.includes('present')) badges.push({ tone: 'presented', text: t('badge.presented') })
      if (artifact.deleted) badges.push({ tone: 'deleted', text: t('badge.deleted') })
      else if (!artifact.exists) badges.push({ tone: 'missing', text: t('badge.missing') })
      return badges
    }

    /**
     * Normalize one artifact from the Host's JSON. The route is a wire boundary,
     * so every field is checked once here and the list code can trust its rows.
     * @param {unknown} row - one `artifacts[]` entry.
     * @returns {object | null} the normalized row, or null when it names no path.
     */
    function normalizeArtifact(row) {
      if (row === null || typeof row !== 'object' || typeof row.path !== 'string' || row.path === '') return null
      const numberOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
      const textOrNull = value => (typeof value === 'string' && value.trim() !== '' ? value : null)
      const sources = Array.isArray(row.sources)
        ? [...new Set(row.sources.filter(source => typeof source === 'string'))]
        : []
      const ext = typeof row.ext === 'string' ? row.ext.toLowerCase() : ''
      return {
        path: row.path,
        relPath: typeof row.relPath === 'string' && row.relPath !== '' ? row.relPath : null,
        name: typeof row.name === 'string' && row.name !== '' ? row.name : baseName(row.path),
        ext,
        kind: KINDS.includes(row.kind) ? row.kind : 'other',
        sources,
        created: row.created === true,
        deleted: row.deleted === true,
        description: textOrNull(row.description),
        ops: numberOr(row.ops, 0),
        firstSeq: numberOr(row.firstSeq, 0),
        lastSeq: numberOr(row.lastSeq, 0),
        firstTime: numberOr(row.firstTime, 0),
        lastTime: numberOr(row.lastTime, 0),
        turns: Array.isArray(row.turns) ? row.turns.filter(turn => Number.isSafeInteger(turn)) : [],
        exists: row.exists !== false,
        size: typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : null,
        mtime: typeof row.mtime === 'number' && Number.isFinite(row.mtime) ? row.mtime : null,
      }
    }

    /**
     * Normalize one plan from the Host's JSON.
     * @param {unknown} row - one `plans[]` entry.
     * @returns {object | null} the normalized plan, or null when it carries no text.
     */
    function normalizePlan(row) {
      if (row === null || typeof row !== 'object' || typeof row.text !== 'string') return null
      return {
        seq: typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : 0,
        time: typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : 0,
        turn: typeof row.turn === 'number' && Number.isFinite(row.turn) ? row.turn : null,
        status: PLAN_STATUSES.includes(row.status) ? row.status : 'pending',
        title: typeof row.title === 'string' ? row.title : '',
        text: row.text,
        truncated: row.truncated === true,
      }
    }

    /**
     * Normalize the listing response.
     * @param {object} payload - the parsed 200 body.
     * @returns {{ cwd: string | null, artifacts: object[], plans: object[], truncated: boolean }} the listing.
     */
    function normalizeListing(payload) {
      const artifacts = Array.isArray(payload.artifacts)
        ? payload.artifacts.map(normalizeArtifact).filter(artifact => artifact !== null)
        : []
      const plans = Array.isArray(payload.plans) ? payload.plans.map(normalizePlan).filter(plan => plan !== null) : []
      return {
        cwd: typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : null,
        artifacts,
        plans,
        truncated: payload.truncated === true,
      }
    }

    /**
     * Read the Session's artifact listing from the server.
     * @param {string} sessionId - the Session to read.
     * @param {AbortSignal} signal - aborts the request.
     * @returns {Promise<object>} the normalized listing.
     */
    async function requestListing(sessionId, signal) {
      let response
      try {
        response = await fetch(LIST_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId }),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw Object.assign(new Error('network request failed'), { code: 'network' })
      }
      const payload = await response.json().catch(() => null)
      if (payload === null) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: `http-${response.status}` })
      }
      if (!response.ok || payload.ok === false) {
        throw Object.assign(new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`), {
          code: typeof payload.error === 'string' ? payload.error : `http-${response.status}`,
        })
      }
      return normalizeListing(payload)
    }

    /** @param {object} data @returns {string} a compact digest used to skip identical writes. */
    function listingSignature(data) {
      return JSON.stringify(data)
    }

    /**
     * Filter and order the rows the list draws.
     * @param {object | null} data - the listing.
     * @param {{ kind: string, hideMissing: boolean, sort: string, query: string }} prefs - the reader's choices.
     * @param {Intl.Collator} collator - name order for the active language.
     * @returns {object[]} the rows to draw, in display order.
     */
    function visibleArtifacts(data, prefs, collator) {
      if (data === null) return []
      const query = prefs.query.trim().toLowerCase()
      const rows = data.artifacts.filter((artifact) => {
        if (prefs.hideMissing && !artifact.exists) return false
        if (prefs.kind !== 'all' && artifact.kind !== prefs.kind) return false
        if (query === '') return true
        const haystack = `${artifact.name}\n${artifact.relPath ?? ''}\n${artifact.path}`.toLowerCase()
        return haystack.includes(query)
      })
      if (prefs.sort === 'name') {
        return rows.sort((left, right) => collator.compare(left.name, right.name) || collator.compare(left.path, right.path))
      }
      return rows.sort((left, right) => (right.lastSeq - left.lastSeq) || (right.lastTime - left.lastTime))
    }

    /**
     * Count the rows of every kind the text filter and the missing toggle leave.
     * @param {object | null} data - the listing.
     * @param {{ hideMissing: boolean, query: string }} prefs - the reader's choices, without the kind.
     * @param {Intl.Collator} collator - name order for the active language.
     * @returns {{ byKind: Record<string, number>, present: string[] }} the counts per chip, and the kinds this Session has at all.
     */
    function countByKind(data, prefs, collator) {
      const base = visibleArtifacts(data, { ...prefs, kind: 'all' }, collator)
      const byKind = { all: base.length }
      for (const kind of KINDS) byKind[kind] = 0
      for (const artifact of base) byKind[artifact.kind] = (byKind[artifact.kind] ?? 0) + 1
      const present = data === null
        ? []
        : KINDS.filter(kind => data.artifacts.some(artifact => artifact.kind === kind))
      return { byKind, present }
    }

    /** @param {{ seq: number }} plan @param {number} index @returns {string} a stable identity for one listed plan. */
    const planKey = (plan, index) => `${plan.seq}:${index}`

    /**
     * One request's abort signal: the request's own controller plus the plugin
     * lifetime, so unloading ends every read without a registry of faces.
     * @param {AbortSignal} mine - this request's controller.
     * @param {AbortSignal} lifetime - the plugin's own signal.
     * @returns {{ signal: AbortSignal, release: () => void }} the combined signal, and the listener cleanup for the fallback path.
     */
    function linkAbort(mine, lifetime) {
      if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([mine, lifetime]), release: () => {} }
      // Without AbortSignal.any: relay either abort to one controller, and drop
      // the listeners when the request settles so they cannot pile up.
      const controller = new AbortController()
      const relay = () => { controller.abort() }
      const sources = []
      for (const source of [mine, lifetime]) {
        if (source.aborted) { relay(); break }
        source.addEventListener('abort', relay, { once: true })
        sources.push(source)
      }
      return { signal: controller.signal, release: () => { for (const source of sources) source.removeEventListener('abort', relay) } }
    }

    /** One tab's record before its first read, and the base every patch spreads. */
    const EMPTY_TAB = Object.freeze({
      phase: 'loading',
      data: null,
      signature: '',
      error: null,
      refreshing: false,
      query: '',
      scrollTop: 0,
      openPlans: [],
      plansCollapsed: false,
    })

    /** Wraps an icon button in the host Tooltip when it is available, else its title carries the label. */
    function withTooltip(button, { label, shortcutKeys, side = 'bottom', portal = false }) {
      if (label === '' || label === undefined) return button
      if (Tooltip === null) return React.cloneElement(button, { title: label })
      return h(Tooltip, { label, shortcutKeys, side, delayMs: 400, portal }, button)
    }

    /**
     * An icon-only control with a localized accessible name and a short tooltip.
     * @param props.label - the tooltip text.
     * @param props.ariaLabel - the accessible name, when it should be longer than the tooltip.
     * @param props.shortcut - this control's effective binding, shown in the tooltip and named for assistive technology.
     */
    function IconButton({ label, ariaLabel, shortcut, side, portal, className, busy, disabled, tabIndex, onClick, children }) {
      return withTooltip(h('button', {
        type: 'button',
        className,
        'aria-label': ariaLabel ?? label,
        'aria-keyshortcuts': shortcut?.aria,
        'data-busy': busy,
        disabled,
        tabIndex,
        onClick,
      }, children), { label, shortcutKeys: shortcut?.keys, side, portal })
    }

    /** Renders Markdown, or plain text when the host renderer is missing or throws. */
    class Markdown extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('session-artifacts: Markdown rendering failed; showing plain text', error)
      }

      render() {
        const { text, labels } = this.props
        if (MarkdownText === null || this.state.failed) return h('pre', { className: 'sa-plain' }, text)
        return h(MarkdownText, { text, labels, variant: 'compact' })
      }
    }

    /**
     * The directory line: the host PathLabel clips a long path at its start and
     * keeps the tail, which reads as a middle ellipsis; without the primitive the
     * row shortens the text itself. PathLabel colours its last segment as a file
     * name, so `.sa-dir[data-path-label] span` puts every segment back on the
     * directory's colour.
     */
    function DirectoryLabel({ path, className }) {
      if (PathLabel !== null) return h(PathLabel, { path, className })
      return h('span', { className: `${className} sa-dir-fallback`, title: path }, middleEllipsis(path, 56))
    }

    /** One document: type, name, directory, badges, and the way into the preview. */
    const ArtifactRow = React.memo(function ArtifactRow({
      artifact, dir, timeText, timeTitle, tabIndex, copied, onOpen, onCopy, t,
    }) {
      const gone = !artifact.exists
      const badges = artifactBadges(artifact, t)
      return h('li', { className: 'sa-item', 'data-missing': !artifact.exists, 'data-kind': artifact.kind },
        h('div', { className: 'sa-row' },
          h('button', {
            type: 'button',
            className: 'sa-open',
            'data-path': artifact.path,
            'aria-disabled': gone,
            tabIndex,
            title: gone ? `${artifact.path}\n${t('row.missing')}` : artifact.path,
            onClick: () => { if (!gone) onOpen(artifact) },
          },
          h('span', { className: 'sa-kind', 'data-kind': artifact.kind, 'aria-hidden': true }, badgeText(artifact, t)),
          h('span', { className: 'sa-main' },
            h('span', { className: 'sa-name' }, artifact.name),
            h('span', { className: 'sa-dir-line' },
              h(DirectoryLabel, { path: dir, className: 'sa-dir' }),
              h('span', { className: 'sa-time-inline', title: timeTitle }, timeText)),
            badges.length > 0 && h('span', { className: 'sa-badges' },
              badges.map(badge => h('span', { key: badge.tone, className: 'sa-badge', 'data-tone': badge.tone }, badge.text))),
            artifact.description !== null && h('span', { className: 'sa-desc', title: artifact.description }, artifact.description)),
          h('span', { className: 'sa-time', title: timeTitle }, timeText)),
          h(IconButton, {
            label: t('row.copy', { name: artifact.name }),
            side: 'top',
            portal: true,
            className: 'sa-tool sa-copy',
            // The list keeps one Tab stop per row; the roving row's copy control
            // follows it, so a keyboard reader reaches the action without walking
            // every row.
            tabIndex,
            onClick: () => { onCopy(artifact) },
          }, copied ? h(CheckIcon) : h(CopyIcon))))
    })

    /** One plan: its outcome, its head, and its Markdown once expanded. */
    function PlanRow({ plan, now, formatters, open, toggle, labels, t }) {
      const title = plan.title !== '' ? plan.title : t('plans.untitled')
      const when = relativeTime(plan.time, now, formatters)
      const meta = plan.turn === null ? [] : [t('plans.turn', { n: plan.turn })]
      if (when !== '') meta.push(when)
      return h('li', { className: 'sa-plan' },
        h('button', {
          type: 'button',
          className: 'sa-plan-head',
          'aria-expanded': open,
          onClick: toggle,
        },
        h('span', { className: 'sa-chevron', 'data-open': open, 'aria-hidden': true }, h(ChevronIcon)),
        h('span', { className: 'sa-plan-title', title }, title),
        h('span', { className: 'sa-plan-badge', 'data-status': plan.status }, t(`planStatus.${plan.status}`)),
        h('span', { className: 'sa-plan-meta', title: absoluteTime(plan.time) }, meta.join(' · '))),
        open && h('div', { className: 'sa-plan-body' },
          h(Markdown, { text: plan.text, labels }),
          plan.truncated && h('p', { className: 'sa-note' }, t('plans.truncated'))))
    }

    /** The plans of this Session, collapsible, above the documents. */
    function PlansSection({ plans, openPlans, collapsed, now, formatters, labels, toggleSection, togglePlan, t }) {
      return h('section', { className: 'sa-plans', 'data-collapsed': collapsed },
        h('button', {
          type: 'button',
          className: 'sa-section',
          'aria-expanded': !collapsed,
          onClick: toggleSection,
        },
        h('span', { className: 'sa-chevron', 'data-open': !collapsed, 'aria-hidden': true }, h(ChevronIcon)),
        t('plans.title'),
        h('span', { className: 'sa-section-count' }, String(plans.length))),
        !collapsed && h('ul', { className: 'sa-plan-list' },
          plans.map((plan, index) => {
            const key = planKey(plan, index)
            return h(PlanRow, {
              key,
              plan,
              now,
              formatters,
              open: openPlans.includes(key),
              toggle: () => { togglePlan(key) },
              labels,
              t,
            })
          })))
    }

    /** The error panel: what failed, and the way to try again. */
    function ErrorPanel({ error, busy, retry, t }) {
      const text = t(ERROR_TEXT[error.code] ?? 'error.other')
      return h('div', { className: 'sa-error', role: 'alert' },
        h('p', { className: 'sa-error-title' }, t('error.title')),
        h('p', { className: 'sa-error-text' }, text),
        h('button', { type: 'button', className: 'sa-option sa-retry', disabled: busy, onClick: retry }, t('error.retry')))
    }

    /** The empty state: nothing is listed, either because the Session has none or because the filter hides them. */
    function EmptyState({ filtered, t }) {
      return h('div', { className: 'sa-empty', 'data-empty': filtered ? 'filtered' : 'session' },
        h('p', { className: 'sa-empty-title' }, t(filtered ? 'empty.filtered' : 'empty.title')),
        h('p', { className: 'sa-empty-hint' }, t(filtered ? 'empty.filtered.hint' : 'empty.hint')))
    }

    /** The one loading indicator: three skeleton rows, hidden from assistive technology. */
    function Skeleton() {
      return h('div', { className: 'sa-skeleton', 'aria-hidden': true },
        [0, 1, 2].map(index => h('div', { key: index, className: 'sa-skeleton-row' },
          h('span', { className: 'sa-skeleton-bar', 'data-w': 'kind' }),
          h('span', { className: 'sa-skeleton-bar', 'data-w': index === 1 ? 'dir' : 'name' }))))
    }

    /**
     * The tab's body: toolbar, chips, plans, and the document list.
     * @param props - the slot's session, hooks, copy, and the face this plugin injects.
     * @returns the pane's content.
     */
    function ArtifactsBody({ useTabInfo, sessionId, useSessions, useSessionStatus, useArtifacts, load, cancel, remember, formatters, t }) {
      const { tab } = useTabInfo()
      const { visible, signal, actions: tabActions } = tab
      const record = useArtifacts(state => state.byTab[tab.id])
      const rowCwd = useSessions(state => state.byId[sessionId]?.cwd)
      const running = useSessionStatus(status => status.get(sessionId)?.running) === true
      const [prefs, setPrefs] = React.useState(readPrefs)
      const [now, setNow] = React.useState(() => Date.now())
      const [roving, setRoving] = React.useState(null)
      const [copied, setCopied] = React.useState(null)
      const wasRunning = React.useRef(running)
      const scrollRef = React.useRef(null)
      const scrollTop = React.useRef(0)
      const restored = React.useRef(null)

      const applyPrefs = (patch) => {
        setPrefs((current) => {
          const next = { ...current, ...patch }
          writeJson(PREFS_KEY, { kind: next.kind, hideMissing: next.hideMissing, sort: next.sort })
          return next
        })
      }

      // Read on becoming visible, and again whenever the Session or the tab's
      // occurrence changes. The request is the face's; the effect only owns
      // when it may run and stops it when the body goes away.
      React.useEffect(() => {
        if (!visible) return undefined
        load(tab.id, signal)
        return () => { cancel(tab.id) }
      }, [visible, sessionId, tab.id, signal, load, cancel])

      // The refresh command of the Sidebar's own control and shortcut: an
      // explicit gesture always starts a fresh read, even over a poll in flight.
      React.useEffect(() => tabActions.bindCommands({
        refresh: () => { load(tab.id, signal, { force: true, interactive: true }) },
      }), [tabActions, tab.id, signal, load])

      // A finished turn is new evidence, but only while the pane can show it;
      // while one runs, poll: the list follows the files the agent keeps writing.
      React.useEffect(() => {
        const was = wasRunning.current
        wasRunning.current = running
        if (was && !running && visible) load(tab.id, signal, { force: true })
      }, [running, visible, tab.id, signal, load])
      React.useEffect(() => {
        if (!visible || !running) return undefined
        const timer = setInterval(() => { load(tab.id, signal) }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [visible, running, tab.id, signal, load])

      // Relative times stay honest without a request.
      React.useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()) }, NOW_TICK_MS)
        return () => { clearInterval(timer) }
      }, [])

      // The copy answer is announced once through a polite live region.
      React.useEffect(() => {
        if (copied === null) return undefined
        const timer = setTimeout(() => { setCopied(null) }, 1500)
        return () => { clearTimeout(timer) }
      }, [copied])

      const listing = record?.data ?? null
      const phase = record?.phase ?? 'loading'
      const error = record?.error ?? null
      const query = record?.query ?? ''
      const openPlans = record?.openPlans ?? []
      const plansCollapsed = record?.plansCollapsed === true
      const busy = record?.refreshing === true
      const formatter = formatters()
      // Addressing uses the Session's workspace root, which is what the file
      // protocol resolves a relative path against; the listing's `cwd` is the
      // agent's effective directory after a `working-directory/change`, and a
      // relative address built from it would resolve against the wrong root.
      const cwd = rowCwd ?? null
      const counts = React.useMemo(
        () => countByKind(listing, { hideMissing: prefs.hideMissing, query }, formatter.collator),
        [listing, prefs.hideMissing, query, formatter],
      )
      // A stored chip whose kind this Session no longer has falls back to "all"
      // for the list too, so the pressed chip and the rows never disagree.
      const kind = prefs.kind !== 'all' && !counts.present.includes(prefs.kind) ? 'all' : prefs.kind
      const rows = React.useMemo(
        () => visibleArtifacts(listing, { kind, hideMissing: prefs.hideMissing, sort: prefs.sort, query }, formatter.collator),
        [listing, kind, prefs.hideMissing, prefs.sort, query, formatter],
      )
      const plans = listing?.plans ?? []
      const total = listing?.artifacts.length ?? 0
      const filtering = query.trim() !== '' || kind !== 'all' || prefs.hideMissing
      // The roving row can vanish under a filter, a chip, or a refetch; the tab
      // stop then belongs to the first row still on screen.
      const activePath = rows.some(row => row.path === roving) ? roving : rows[0]?.path

      const labels = React.useMemo(() => ({
        code: { copyLabel: t('md.copy'), copiedLabel: t('md.copied') },
        footnotes: t('md.footnotes'),
      }), [t])

      const open = React.useCallback((artifact) => {
        tabActions.openResource(fileAddressFor(sessionId, cwd, artifact.path))
      }, [tabActions, sessionId, cwd])

      const copy = React.useCallback((artifact) => {
        const write = navigator.clipboard?.writeText(artifact.path) ?? Promise.reject(new Error('no clipboard access'))
        write.then(
          () => { setCopied({ path: artifact.path, name: artifact.name, ok: true }) },
          (failure) => {
            console.error('session-artifacts: clipboard write failed', failure)
            setCopied({ path: artifact.path, name: artifact.name, ok: false })
          },
        )
      }, [])

      // Remember where the reader was, and put the list back there on return.
      React.useLayoutEffect(() => {
        const node = scrollRef.current
        if (node === null || listing === null || restored.current === tab.id) return
        restored.current = tab.id
        node.scrollTop = record?.scrollTop ?? 0
        scrollTop.current = node.scrollTop
      }, [listing, tab.id, record])
      React.useEffect(() => () => {
        if (signal.aborted) return
        remember(tab.id, { scrollTop: scrollTop.current })
      }, [signal, tab.id, remember])

      const togglePlan = React.useCallback((key) => {
        const current = record?.openPlans ?? []
        const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key]
        remember(tab.id, { openPlans: next })
      }, [record, remember, tab.id])

      const toggleSection = React.useCallback(() => {
        remember(tab.id, { plansCollapsed: record?.plansCollapsed !== true })
      }, [record, remember, tab.id])

      const onListKeyDown = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const buttons = [...event.currentTarget.querySelectorAll('.sa-open')]
        const index = buttons.indexOf(document.activeElement)
        if (index === -1) return
        event.preventDefault()
        const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
        next?.focus()
        if (next !== undefined) setRoving(next.getAttribute('data-path'))
      }

      const shown = rows.length === total
        ? plural(t, 'status.documents', 'documents', rows.length, formatter.plural)
        : t('status.shown', { shown: rows.length, total })
      const status = listing === null
        ? ''
        : [
          shown,
          plans.length > 0 ? plural(t, 'status.plans', 'plans', plans.length, formatter.plural) : null,
          listing.truncated ? t('status.truncated', { n: total }) : null,
        ].filter(part => part !== null).join(' · ')

      const copyMessage = copied === null ? '' : t(copied.ok ? 'row.copied' : 'row.copyFailed', { name: copied.name })
      const copyState = copied === null ? null : copied.path

      return h('div', {
        className: 'sa-root',
        'data-artifacts-state': listing === null ? phase : 'ready',
        'aria-busy': listing === null && phase !== 'error',
      },
      h('div', { className: 'sa-toolbar' },
        h('div', { className: 'sa-search' },
          h('input', {
            className: 'sa-input',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            value: query,
            placeholder: t('filter.placeholder'),
            'aria-label': t('filter.aria'),
            onChange: (event) => { remember(tab.id, { query: event.target.value }) },
          }),
          query !== '' && h('button', {
            type: 'button',
            className: 'sa-clear',
            'aria-label': t('filter.clear'),
            onClick: () => { remember(tab.id, { query: '' }) },
          }, h(ClearIcon))),
        h(IconButton, {
          label: t('refresh'),
          ariaLabel: t('refresh.aria'),
          shortcut: tab.refreshShortcut,
          side: 'bottom',
          className: 'sa-tool',
          busy,
          onClick: () => { load(tab.id, signal, { force: true, interactive: true }) },
        }, h(RefreshIcon))),
      listing !== null && counts.present.length > 0 && h('div', { className: 'sa-chips', role: 'group', 'aria-label': t('chips.aria') },
        ['all', ...counts.present].map(option => h('button', {
          key: option,
          type: 'button',
          className: 'sa-chip',
          'data-kind': option,
          'aria-pressed': kind === option,
          onClick: () => { applyPrefs({ kind: option }) },
        },
        t(option === 'all' ? 'chip.all' : `kind.${option}`),
        h('span', { className: 'sa-chip-count' }, String(counts.byKind[option] ?? 0))))),
      listing !== null && total > 0 && h('div', { className: 'sa-options' },
        h('button', {
          type: 'button',
          className: 'sa-option',
          'aria-pressed': prefs.hideMissing,
          onClick: () => { applyPrefs({ hideMissing: !prefs.hideMissing }) },
        }, t('toggle.hideMissing')),
        h('span', { className: 'sa-spacer' }),
        h('button', {
          type: 'button',
          className: 'sa-option',
          'aria-label': t('sort.aria', { mode: t(`sort.${prefs.sort}`) }),
          title: t('sort.switch'),
          onClick: () => { applyPrefs({ sort: prefs.sort === 'recent' ? 'name' : 'recent' }) },
        }, h(SortIcon), t(`sort.${prefs.sort}`))),
      status !== '' && h('div', { className: 'sa-status', role: 'status', 'aria-live': 'polite' }, status),
      error !== null && h(ErrorPanel, { error, busy, retry: () => { load(tab.id, signal, { force: true, interactive: true }) }, t }),
      h('div', {
        ref: scrollRef,
        className: 'sa-scroll',
        onScroll: (event) => { scrollTop.current = event.currentTarget.scrollTop },
      },
      listing === null
        ? (phase === 'error' ? null : h(Skeleton))
        : h(React.Fragment, null,
          plans.length > 0 && h(PlansSection, {
            plans,
            openPlans,
            collapsed: plansCollapsed,
            now,
            formatters: formatter,
            labels,
            toggleSection,
            togglePlan,
            t,
          }),
          rows.length === 0
            ? h(EmptyState, { filtered: filtering, t })
            : h('ul', { className: 'sa-list', 'aria-label': t('type.label'), onKeyDown: onListKeyDown },
              rows.map(artifact => h(ArtifactRow, {
                key: artifact.path,
                artifact,
                dir: directoryOf(artifact, t),
                timeText: relativeTime(artifact.lastTime, now, formatter),
                timeTitle: isTime(artifact.lastTime)
                  ? t(artifact.ops > 0 ? 'time.lastChange' : 'time.lastTouch', { time: absoluteTime(artifact.lastTime) })
                  : '',
                tabIndex: artifact.path === activePath ? 0 : -1,
                copied: copyState === artifact.path,
                onOpen: open,
                onCopy: copy,
                t,
              }))))),
      h('span', { className: 'sa-sr', role: 'status', 'aria-live': 'polite' }, copyMessage))
    }

    /** The tab's chip: the glyph, then the type's live label. */
    function ArtifactsTitle({ t }) {
      return h(React.Fragment, null,
        h('span', { className: 'sa-title-icon' }, h(ArtifactsGlyph, { size: 16 })),
        t('type.label'))
    }

    /** The Session header's button: opens the tab, and reports when this Session has one open. */
    function HeaderButton({ sessionId, useOpenTabs, open, t }) {
      const pressed = useOpenTabs(tabs => tabs.some(entry => entry.sessionId === sessionId && entry.kind === KIND))
      return withTooltip(h('button', {
        type: 'button',
        className: 'sa-tool',
        'aria-label': t('button.aria'),
        'aria-pressed': pressed,
        onClick: () => { open() },
      }, h(ArtifactsGlyph, { size: 15 })), { label: t('button.aria') })
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-artifacts: dictionaries')
        ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'session-artifacts: ru dictionary')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'session-artifacts: stylesheet')

        const t = ctx.locale.bind(NS)

        // The type is a page: it claims no address, the file rows open through
        // the Sidebar's preview type.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: () => t('type.label'),
          guide: [{
            id: 'artifacts',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: ArtifactsArtwork,
          }],
        }), 'session-artifacts: tab type')

        // One face per Session binding: its own records and its own requests,
        // because a TabId identifies a tab only within its Session. The
        // renderer caches the face per Session, so this runs once per Session.
        const lifetime = new AbortController()
        // One disposer per live tab occurrence: it removes the abort listener and
        // drops the record. A Sidebar keeps occurrences alive after a type
        // unregisters, so unload must take these listeners with it.
        const watchers = new Set()
        const makeFace = (sessionId) => {
          const store = createSnapshotStore({ byTab: {} })
          const requests = new Map()
          const watched = new Map()

          const patchTab = (tabId, patch) => {
            const state = store.getSnapshot()
            const current = state.byTab[tabId] ?? EMPTY_TAB
            store.set({ ...state, byTab: { ...state.byTab, [tabId]: { ...current, ...patch } } })
          }
          const cancel = (tabId) => {
            const controller = requests.get(tabId)
            if (controller === undefined) return
            requests.delete(tabId)
            controller.abort()
          }
          /** Stop watching one tab's occurrence; idempotent. */
          const dropWatch = (tabId) => {
            const remove = watched.get(tabId)
            watched.delete(tabId)
            remove?.()
          }
          const forget = (tabId) => {
            dropWatch(tabId)
            cancel(tabId)
            const state = store.getSnapshot()
            if (state.byTab[tabId] === undefined) return
            const byTab = { ...state.byTab }
            delete byTab[tabId]
            store.set({ ...state, byTab })
          }

          /** Remember one tab's reader state — the query, open rows, or scroll offset. */
          const remember = (tabId, patch) => { patchTab(tabId, patch) }

          /**
           * Read one tab's listing. A poll yields to a request already in flight;
           * an explicit gesture replaces it. The tab's own signal ends its record,
           * and a tab that already ended is never seeded again.
           * @param {string} tabId - the tab being drawn.
           * @param {AbortSignal} signal - the tab occurrence's lifetime.
           * @param {{ force?: boolean, interactive?: boolean }} [options] - replace an in-flight read, and show its spinner.
           */
          const load = (tabId, signal, options = {}) => {
            if (signal.aborted) return
            const interactive = options.interactive === true
            const running = requests.get(tabId)
            if (running !== undefined) {
              if (options.force !== true) return
              requests.delete(tabId)
              running.abort()
            }
            const controller = new AbortController()
            requests.set(tabId, controller)
            if (!watched.has(tabId)) {
              // The listener outlives the body, so its disposer is registered with
              // the plugin: a later unload removes it instead of leaving the face
              // reachable through a signal the Sidebar still holds.
              const onAbort = () => { watchers.delete(dispose); forget(tabId) }
              const remove = () => { signal.removeEventListener('abort', onAbort) }
              const dispose = () => { watchers.delete(dispose); forget(tabId) }
              watched.set(tabId, remove)
              watchers.add(dispose)
              signal.addEventListener('abort', onAbort, { once: true })
            }
            const current = store.getSnapshot().byTab[tabId]
            const hasData = current !== undefined && current.data !== null
            const hasError = current !== undefined && current.error !== null
            patchTab(tabId, {
              phase: hasData ? 'ready' : hasError ? 'error' : 'loading',
              refreshing: interactive,
            })
            const link = linkAbort(controller.signal, lifetime.signal)
            const settle = (patch) => {
              if (link.signal.aborted || requests.get(tabId) !== controller) return
              patchTab(tabId, patch)
            }
            void (async () => {
              try {
                const data = await requestListing(sessionId, link.signal)
                const signature = listingSignature(data)
                const latest = store.getSnapshot().byTab[tabId]
                const unchanged = latest !== undefined
                  && latest.data !== null
                  && latest.signature === signature
                  && latest.error === null
                  && latest.refreshing === false
                if (!unchanged) settle({ phase: 'ready', data, signature, error: null, refreshing: false })
              } catch (failure) {
                if (link.signal.aborted) return
                const code = typeof failure?.code === 'string' ? failure.code : 'other'
                const latest = store.getSnapshot().byTab[tabId]
                const repeated = latest !== undefined
                  && latest.error !== null
                  && latest.error.code === code
                  && latest.refreshing === false
                if (!repeated) {
                  if (latest === undefined || latest.error === null) {
                    console.warn(`session-artifacts: cannot list the session's documents (${code})`)
                  }
                  settle({
                    phase: hasData ? 'ready' : 'error',
                    error: { code },
                    refreshing: false,
                  })
                }
              } finally {
                link.release()
                if (requests.get(tabId) === controller) requests.delete(tabId)
              }
            })()
          }

          // Formatters follow the active language; a switch rebinds them on the
          // next render, which the locale seat already schedules.
          let cached = null
          const formatters = () => {
            const active = ctx.locale.getLocale().active
            if (cached === null || cached.tag !== active) cached = makeFormatters(active)
            return cached
          }

          return { hooks: { artifacts: store }, load, cancel, forget, remember, formatters }
        }

        // Unloading ends every read and forgets every watched tab: the lifetime
        // aborts linked requests, and each disposer removes its listener and drops
        // the record, so a Sidebar occurrence cannot keep this generation alive.
        ctx.effect(() => () => {
          lifetime.abort()
          for (const dispose of [...watchers]) dispose()
          watchers.clear()
        }, 'session-artifacts: end requests on unload')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
          inject: makeFace,
        }, ArtifactsBody)), 'session-artifacts: tab body')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: ID,
          locale: NS,
        }, ArtifactsTitle)), 'session-artifacts: tab title')

        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'session-artifacts',
          order: 16,
          locale: NS,
          inject: () => ({
            hooks: { openTabs: ctx.sidebarRight.openTabs },
            open: () => {
              try {
                ctx.sidebarRight.openTab(KIND)
              } catch (error) {
                // A click can outrun the Session surface while Sessions switch;
                // the button is not a wiring site, so the miss stays a warning.
                console.warn('session-artifacts: cannot open the tab', error)
              }
            },
          }),
        }, HeaderButton)), 'session-artifacts: header button')
      },
    }
  },
})
