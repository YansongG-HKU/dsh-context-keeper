/**
 * dsh-context-keeper — Client (browser) half.
 *
 * Hand-written browser plugin artifact: no build tooling, no npm imports, no JSX.
 * It only registers a lazy factory; nothing runs until the module is materialized.
 * Inside the factory it depends on the browser module table for React and
 * contributes two slots through the Host's `slots` service:
 *
 *   - `sidebar.panellist` (id `dsh-context-keeper`, order 20): the sidebar glyph.
 *   - `main` (key `dsh-context-keeper`): the management panel, selected by the
 *     sidebar entry through the same id.
 *
 * Panel data comes from the co-located Host route `GET /context-keeper/api/state`
 * (lib/panel.js). The route is same-origin and additionally gated on the
 * `x-context-keeper: 1` request header, which marks the request as coming from
 * this plugin's own page code.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-keeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this Client half. */
    const NS = 'dshContextKeeper'
    /** Sidebar entry id; it also addresses the `main` panel key. */
    const PANEL_ID = 'dsh-context-keeper'
    /** Host route registered by lib/panel.js. */
    const API_PATH = '/context-keeper/api/state'
    /** Auto-refresh cadence for the panel while it is mounted and visible. */
    const REFRESH_MS = 3000
    /** Accent color used by the glyph; matches icon.svg's blue accent. */
    const ACCENT = '#38bdf8'

    const DICTIONARIES = {
      zh: {
        panel: '上下文管家',
        title: '上下文管家',
        subtitle: '托管会话的上下文预算、折叠节省与自动折叠状态',
        refresh: '刷新',
        refreshing: '刷新中…',
        loading: '正在读取…',
        updated: '更新于 {time}',
        autoRefresh: '每 3 秒自动刷新',
        errorLoad: '读取失败：{message}',
        emptyTitle: '还没有运行中的会话',
        emptyHint: '打开一个会话后，这里会显示它的上下文占用和折叠节省。',
        summarySessions: '托管会话',
        summaryPressure: '总压力',
        summarySaved: '总节省',
        summaryCache: '平均缓存命中率',
        colSession: '会话',
        colPreset: '预设',
        colContext: '上下文占用',
        colSaved: '已压缩节省',
        colFolds: '自动折叠',
        colSkip: '最近跳过原因',
        note: '只折叠可恢复的旧历史；原文仍可用 context_search / context_restore 找回。',
        unknown: '—',
        foldsCount: '{count} 次',
        savedUnit: 'tokens',
        cacheHint: '缓存读取 / 计费输入',
      },
      en: {
        panel: 'Context Keeper',
        title: 'Context Keeper',
        subtitle: 'Context budget, folding savings, and auto-fold state for managed sessions',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        loading: 'Loading…',
        updated: 'Updated {time}',
        autoRefresh: 'Auto-refreshes every 3 s',
        errorLoad: 'Failed to load: {message}',
        emptyTitle: 'No running sessions yet',
        emptyHint: 'Open a session and its context usage and folding savings appear here.',
        summarySessions: 'Managed sessions',
        summaryPressure: 'Total pressure',
        summarySaved: 'Total saved',
        summaryCache: 'Avg cache hit',
        colSession: 'Session',
        colPreset: 'Preset',
        colContext: 'Context usage',
        colSaved: 'Saved by folding',
        colFolds: 'Auto folds',
        colSkip: 'Last skip reason',
        note: 'Only recoverable old history is folded; originals remain retrievable with context_search / context_restore.',
        unknown: '—',
        foldsCount: '{count}',
        savedUnit: 'tokens',
        cacheHint: 'cache read / billed input',
      },
    }

    /**
     * Component-local styles. Rendered as a React `<style>` element inside the
     * panel so unmounting removes them. Only host theme tokens (`--dsw-alias-*`)
     * are used, with neutral fallbacks for hosts that lack a token.
     */
    const STYLES = `
.ck-page {
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  scrollbar-gutter: stable;
  padding: 28px clamp(24px, 4vw, 48px) 40px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}
.ck-column { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.ck-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; }
.ck-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-secondary, #444); }
.ck-subtitle { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #777); }
.ck-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.ck-updated { font-size: 12px; color: var(--dsw-alias-label-caption, #888); font-variant-numeric: tabular-nums; }
.ck-auto { font-size: 11px; color: var(--dsw-alias-label-tertiary, #999); }
.ck-button {
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 5px 12px;
  border-radius: 9px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-secondary, #444);
  cursor: pointer;
}
.ck-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ck-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; }
.ck-button:disabled { opacity: 0.55; cursor: default; }
.ck-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.ck-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.ck-card-label { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #777); }
.ck-card-value {
  font-size: 21px;
  line-height: 28px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.ck-card-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-caption, #888); }
.ck-error {
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  border: 0.5px solid var(--dsw-alias-state-error-primary, #dc2626);
  color: var(--dsw-alias-state-error-primary, #dc2626);
  font-size: 12.5px;
  line-height: 19px;
  overflow-wrap: anywhere;
}
.ck-table-wrap {
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  overflow: auto;
}
.ck-table { width: 100%; border-collapse: collapse; font-size: 12.5px; line-height: 18px; }
.ck-table th {
  text-align: left;
  white-space: nowrap;
  padding: 9px 14px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #777);
  background: var(--dsw-alias-bg-layer-2, transparent);
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
}
.ck-table td {
  padding: 10px 14px;
  vertical-align: middle;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
}
.ck-table tbody tr:last-child td { border-bottom: none; }
.ck-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08)); }
.ck-cell-session { min-width: 132px; }
.ck-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-primary, #1f2328); }
.ck-cwd { margin-top: 1px; font-size: 11px; color: var(--dsw-alias-label-caption, #888); overflow-wrap: anywhere; }
.ck-usage { display: flex; flex-direction: column; gap: 5px; min-width: 168px; }
.ck-usage-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-variant-numeric: tabular-nums; }
.ck-usage-line span:first-child { color: var(--dsw-alias-label-secondary, #444); white-space: nowrap; }
.ck-pct { color: var(--dsw-alias-label-tertiary, #777); }
.ck-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.18)); overflow: hidden; }
.ck-bar-fill { height: 100%; border-radius: 3px; }
.ck-tone-normal { background: var(--dsw-alias-brand-primary, #247bbf); }
.ck-tone-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }
.ck-tone-danger { background: var(--dsw-alias-state-error-primary, #dc2626); }
.ck-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ck-skip { max-width: 260px; color: var(--dsw-alias-label-secondary, #444); }
.ck-skip-inner { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ck-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 40px 24px;
  border: 0.5px dashed var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
  border-radius: 14px;
  text-align: center;
}
.ck-empty-title { font-size: 14px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary, #444); }
.ck-empty-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #777); }
.ck-loading { margin: 0; font-size: 13px; color: var(--dsw-alias-label-tertiary, #777); }
.ck-note {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #777);
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18));
  padding-top: 12px;
}
@media (max-width: 700px) {
  .ck-page { padding: 20px 16px 32px; }
  .ck-cards { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
  .ck-skip { max-width: 180px; }
}
`

    /** Sidebar glyph: document lines in the current color plus the icon.svg blue accent. */
    function KeeperIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      const active = props.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M4 7.5h13', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M4 12h9.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', {
          d: 'M4 16.5h5.5',
          stroke: active ? ACCENT : 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M15.5 14.2 19 17l-3.5 2.8',
          stroke: ACCENT,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 18, cy: 7.5, r: 2.1, fill: ACCENT }),
      )
    }

    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    function unknownText() {
      return '—'
    }

    function numberText(value) {
      return finite(value) ? new Intl.NumberFormat().format(Math.round(value)) : unknownText()
    }

    function percentText(value) {
      return finite(value) ? `${(value * 100).toFixed(1)}%` : unknownText()
    }

    function toneOf(ratio) {
      if (!finite(ratio)) return 'normal'
      if (ratio >= 0.85) return 'danger'
      if (ratio >= 0.6) return 'warn'
      return 'normal'
    }

    function shortId(id) {
      const text = String(id ?? '')
      return text.length > 10 ? `${text.slice(0, 10)}…` : text || unknownText()
    }

    function baseName(path) {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.split(/[\\/]+/).filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : path
    }

    function timeText(timestamp) {
      try {
        return new Date(timestamp).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch {
        return ''
      }
    }

    /** Same-origin GET against the Host route; the custom header marks this page's own requests. */
    async function requestState() {
      const response = await fetch(API_PATH, {
        method: 'GET',
        headers: { 'x-context-keeper': '1' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = await response.json()
      if (value === null || typeof value !== 'object') throw new Error('unexpected response')
      return value
    }

    /** Poll the Host route while mounted; a manual reload reuses the same request path. */
    function useKeeperData() {
      const [snapshot, setSnapshot] = React.useState({
        data: null,
        error: null,
        loading: true,
        updatedAt: null,
      })
      const ticket = React.useRef(0)
      const load = React.useCallback(async () => {
        const current = ++ticket.current
        setSnapshot((previous) => ({ ...previous, loading: true }))
        try {
          const value = await requestState()
          if (current !== ticket.current) return
          setSnapshot({ data: value, error: null, loading: false, updatedAt: Date.now() })
        } catch (error) {
          if (current !== ticket.current) return
          const message = error instanceof Error ? error.message : String(error)
          setSnapshot((previous) => ({ ...previous, error: message, loading: false }))
        }
      }, [])
      React.useEffect(() => {
        let disposed = false
        const tick = () => {
          if (disposed || document.hidden) return
          void load()
        }
        tick()
        const timer = window.setInterval(tick, REFRESH_MS)
        const onVisibility = () => {
          if (!document.hidden) tick()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          disposed = true
          ticket.current += 1
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])
      return { ...snapshot, reload: load }
    }

    function SummaryCard(props) {
      return h(
        'div',
        { className: 'ck-card' },
        h('div', { className: 'ck-card-label' }, props.label),
        h('div', { className: 'ck-card-value' }, props.value),
        props.hint ? h('div', { className: 'ck-card-hint' }, props.hint) : null,
      )
    }

    function UsageCell(props) {
      const row = props.row
      const ratio = finite(row.ratio) ? Math.max(0, Math.min(1, row.ratio)) : null
      const percent = percentText(row.ratio)
      const label = props.t('colContext')
      const pressure = numberText(row.pressureTokens)
      const windowText = numberText(row.contextWindow)
      return h(
        'div',
        { className: 'ck-usage' },
        h(
          'div',
          { className: 'ck-usage-line' },
          h('span', null, `${pressure} / ${windowText}`),
          h('span', { className: 'ck-pct' }, percent),
        ),
        h(
          'div',
          {
            className: 'ck-bar',
            role: 'progressbar',
            'aria-label': label,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': ratio === null ? undefined : Math.round(ratio * 100),
          },
          h('div', {
            className: `ck-bar-fill ck-tone-${toneOf(row.ratio)}`,
            style: { width: ratio === null ? '0%' : `${Math.round(ratio * 1000) / 10}%` },
          }),
        ),
      )
    }

    function SessionTable(props) {
      const t = props.t
      const rows = props.rows
      return h(
        'div',
        { className: 'ck-table-wrap' },
        h(
          'table',
          { className: 'ck-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, t('colSession')),
              h('th', { scope: 'col' }, t('colPreset')),
              h('th', { scope: 'col' }, t('colContext')),
              h('th', { scope: 'col', className: 'ck-num' }, t('colSaved')),
              h('th', { scope: 'col', className: 'ck-num' }, t('colFolds')),
              h('th', { scope: 'col' }, t('colSkip')),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((row, index) =>
              h(
                'tr',
                { key: typeof row.id === 'string' && row.id.length > 0 ? row.id : `session-${index}` },
                h(
                  'td',
                  { className: 'ck-cell-session' },
                  h('div', { className: 'ck-id', title: typeof row.id === 'string' ? row.id : '' }, shortId(row.id)),
                  typeof row.cwd === 'string' && row.cwd.length > 0
                    ? h('div', { className: 'ck-cwd', title: row.cwd }, baseName(row.cwd))
                    : null,
                ),
                h('td', null, typeof row.preset === 'string' && row.preset.length > 0 ? row.preset : t('unknown')),
                h('td', null, h(UsageCell, { row, t })),
                h('td', { className: 'ck-num' }, numberText(row.netSavedTokens)),
                h('td', { className: 'ck-num' }, numberText(row.autoFolds)),
                h(
                  'td',
                  { className: 'ck-skip' },
                  h(
                    'span',
                    { className: 'ck-skip-inner', title: typeof row.lastSkip === 'string' ? row.lastSkip : '' },
                    typeof row.lastSkip === 'string' && row.lastSkip.length > 0 ? row.lastSkip : t('unknown'),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function sum(rows, key) {
      let total = 0
      for (const row of rows) if (finite(row[key])) total += row[key]
      return total
    }

    function average(rows, key) {
      let total = 0
      let count = 0
      for (const row of rows) {
        if (!finite(row[key])) continue
        total += row[key]
        count += 1
      }
      return count > 0 ? total / count : null
    }

    function totalsOf(rows) {
      return {
        sessions: rows.length,
        pressureTokens: sum(rows, 'pressureTokens'),
        netSavedTokens: sum(rows, 'netSavedTokens'),
        cacheHitRatio: average(rows, 'cacheHitRatio'),
      }
    }

    function KeeperPanel(props) {
      const t = props.t
      const keeper = useKeeperData()
      const payload = keeper.data && typeof keeper.data === 'object' ? keeper.data : null
      const rows = payload && Array.isArray(payload.sessions) ? payload.sessions : []
      const totals =
        payload && payload.totals && typeof payload.totals === 'object' ? payload.totals : totalsOf(rows)
      const loading = keeper.loading
      const empty = payload !== null && rows.length === 0

      let body = null
      if (!payload) {
        body = loading ? h('p', { className: 'ck-loading' }, t('loading')) : null
      } else if (empty) {
        body = h(
          'div',
          { className: 'ck-empty' },
          h('div', { className: 'ck-empty-title' }, t('emptyTitle')),
          h('div', { className: 'ck-empty-hint' }, t('emptyHint')),
        )
      } else {
        body = h(SessionTable, { rows, t })
      }

      return h(
        'div',
        { className: 'ck-page' },
        h('style', null, STYLES),
        h(
          'div',
          { className: 'ck-column' },
          h(
            'header',
            { className: 'ck-head' },
            h(
              'div',
              null,
              h('h1', { className: 'ck-title' }, t('title')),
              h('p', { className: 'ck-subtitle' }, t('subtitle')),
            ),
            h(
              'div',
              { className: 'ck-toolbar' },
              keeper.updatedAt
                ? h('span', { className: 'ck-updated' }, t('updated', { time: timeText(keeper.updatedAt) }))
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'ck-button',
                  onClick: () => {
                    void keeper.reload()
                  },
                  disabled: loading,
                },
                loading ? t('refreshing') : t('refresh'),
              ),
              h('span', { className: 'ck-auto' }, t('autoRefresh')),
            ),
          ),
          keeper.error ? h('p', { className: 'ck-error', role: 'alert' }, t('errorLoad', { message: keeper.error })) : null,
          h(
            'section',
            { className: 'ck-cards', 'aria-label': t('title') },
            h(SummaryCard, {
              label: t('summarySessions'),
              value: numberText(totals.sessions),
              hint: null,
            }),
            h(SummaryCard, {
              label: t('summaryPressure'),
              value: `${numberText(totals.pressureTokens)}`,
              hint: t('savedUnit'),
            }),
            h(SummaryCard, {
              label: t('summarySaved'),
              value: `${numberText(totals.netSavedTokens)}`,
              hint: t('savedUnit'),
            }),
            h(SummaryCard, {
              label: t('summaryCache'),
              value: percentText(totals.cacheHitRatio),
              hint: t('cacheHint'),
            }),
          ),
          body,
          h('p', { className: 'ck-note' }, t('note')),
        ),
      )
    }

    return {
      /** Client services this plugin needs before it may activate. */
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-context-keeper: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel'),
              locale: NS,
            },
            KeeperIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            (slotProps) => h(KeeperPanel, { t: typeof slotProps.t === 'function' ? slotProps.t : t }),
          ),
        )
      },
    }
  },
})
