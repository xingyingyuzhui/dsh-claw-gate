import { NS } from './gate-i18n.mjs'
import { auditFacets, emptyAuditQuery, filterAudit, serializeAudit } from './gate-filter.mjs'

function rangeLabel(t, range) {
  if (range === 'yesterday') return t('rangeYesterday')
  if (range === 'week') return t('rangeWeek')
  if (range === 'month') return t('rangeMonth')
  if (range === 'all') return t('rangeAll')
  return t('rangeToday')
}

function kindLabel(t, kind) {
  if (kind === 'ask') return t('kindAsk')
  if (kind === 'pin') return t('kindPin')
  if (kind === 'deny') return t('kindDeny')
  return t('kindAll')
}

export function createAuditPage(React, t, post, toast, subscribeLocale, ReactDOM) {
  return function AuditPage() {
    const el = React.createElement
    const [, setLocaleTick] = React.useState(0)
    React.useEffect(() => {
      if (typeof subscribeLocale !== 'function') return undefined
      return subscribeLocale(() => setLocaleTick((n) => n + 1))
    }, [subscribeLocale])
    const [rows, setRows] = React.useState([])
    const [query, setQuery] = React.useState(emptyAuditQuery)
    const [openPick, setOpenPick] = React.useState('')
    const [menuBox, setMenuBox] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const labels = { official: t('officialAgent'), claw: t('clawAgent') }
    const facets = auditFacets(rows, labels)
    const visible = filterAudit(rows, query)

    const load = React.useCallback(() => {
      setBusy(true)
      return post('/dsh-agent-gate/audit', { limit: 500 }).then((data) => {
        setRows(Array.isArray(data.items) ? data.items : [])
      }).catch((err) => {
        toast(String(err.message || t('fail')))
      }).finally(() => setBusy(false))
    }, [])

    React.useEffect(() => { load() }, [load])

    React.useEffect(() => {
      if (!openPick) return undefined
      const onDown = (event) => {
        const target = event.target
        if (target && target.closest && (target.closest('[data-dag-pick]') || target.closest('[data-dag-menu]'))) return
        setOpenPick('')
      }
      document.addEventListener('mousedown', onDown, true)
      return () => document.removeEventListener('mousedown', onDown, true)
    }, [openPick])

    const download = React.useCallback((format) => {
      const text = serializeAudit(visible, format)
      if (typeof document === 'undefined') return
      const blob = new Blob([text], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/jsonl;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = format === 'md' ? 'dsh-audit.md' : 'dsh-audit.jsonl'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => { URL.revokeObjectURL(url) }, 3000)
      toast(t('exported'))
    }, [visible])

    function when(at) {
      if (!at) return ''
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return at
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function shortSession(id) {
      if (!id) return ''
      return id.length > 18 ? id.slice(0, 8) + '…' + id.slice(-6) : id
    }

    function pick(id, label, value, options) {
      return el('button', {
        type: 'button',
        className: 'dag-pick',
        'data-dag-pick': id,
        'data-open': openPick === id ? 'true' : 'false',
        onClick: (event) => {
          if (openPick === id) {
            setOpenPick('')
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setMenuBox({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width })
          setOpenPick(id)
        },
      },
        el('span', { className: 'dag-pick-k' }, label),
        el('span', { className: 'dag-pick-v' }, value),
      )
    }

    function menu(id, options, current, onSelect) {
      if (openPick !== id || !menuBox) return null
      const node = el('div', {
        className: 'dag-menu',
        'data-dag-menu': id,
        style: { top: menuBox.top, left: menuBox.left, minWidth: menuBox.minWidth },
      }, options.map((option) => el('button', {
        key: option.id,
        type: 'button',
        'data-on': option.id === current ? 'true' : 'false',
        onClick: () => {
          onSelect(option.id)
          setOpenPick('')
        },
      }, option.label)))
      if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
        return ReactDOM.createPortal(node, document.body)
      }
      return node
    }

    const toolLabel = query.tool === 'all' ? t('toolAll') : query.tool
    const agentFacet = facets.agents.find((row) => row.id === query.agent)
    const agentValue = query.agent === 'all' ? t('agentAll') : (agentFacet && agentFacet.title) || query.agent

    const emptyText = rows.length === 0 ? t('empty') : t('emptyFilter')

    return el('div', { className: 'dag-page' },
      el('div', { className: 'dag-filters' },
        pick('range', t('filterTime'), rangeLabel(t, query.range)),
        pick('kind', t('filterKind'), kindLabel(t, query.kind)),
        pick('tool', t('filterTool'), toolLabel),
        pick('agent', t('filterAgent'), agentValue),
      ),
      menu('range', [
        { id: 'today', label: t('rangeToday') },
        { id: 'yesterday', label: t('rangeYesterday') },
        { id: 'week', label: t('rangeWeek') },
        { id: 'month', label: t('rangeMonth') },
        { id: 'all', label: t('rangeAll') },
      ], query.range, (id) => setQuery({ ...query, range: id })),
      menu('kind', [
        { id: 'all', label: t('kindAll') },
        { id: 'deny', label: t('kindDeny') },
        { id: 'ask', label: t('kindAsk') },
        { id: 'pin', label: t('kindPin') },
      ], query.kind, (id) => setQuery({ ...query, kind: id })),
      menu('tool', [{ id: 'all', label: t('toolAll') }].concat(facets.tools.map((name) => ({ id: name, label: name }))), query.tool, (id) => setQuery({ ...query, tool: id })),
      menu('agent', [{ id: 'all', label: t('agentAll') }].concat(facets.agents.map((row) => ({ id: row.id, label: row.title }))), query.agent, (id) => setQuery({ ...query, agent: id })),
      el('div', { className: 'dag-toolbar' },
        el('span', { className: 'dag-count' }, t('count', { shown: visible.length, total: rows.length })),
        el('button', { type: 'button', className: 'dag-btn', disabled: busy, onClick: load }, t('refresh')),
        el('button', { type: 'button', className: 'dag-btn', disabled: busy || visible.length === 0, onClick: () => download('jsonl') }, t('exportJson')),
        el('button', { type: 'button', className: 'dag-btn', disabled: busy || visible.length === 0, onClick: () => download('md') }, t('exportMd')),
      ),
      visible.length === 0
        ? el('p', { className: 'dag-empty' }, emptyText)
        : el('div', { className: 'dag-list' }, visible.map((row, index) => el('div', {
          key: (row.at || '') + index,
          className: 'dag-row',
        },
          el('div', { className: 'dag-head' },
            el('span', { className: 'dag-kind', 'data-kind': row.kind }, kindLabel(t, row.kind)),
            el('span', { className: 'dag-tool' }, row.tool || '—'),
          ),
          el('div', { className: 'dag-meta' }, [
            when(row.at),
            row.agentTitle || (row.claw ? t('clawAgent') : ''),
            shortSession(row.sessionId),
          ].filter(Boolean).join(' · ')),
          row.reason ? el('div', { className: 'dag-meta' }, row.reason) : null,
        ))),
    )
  }
}

export function registerSettings(ctx, React, t, Page) {
  const slots = ctx.get('slots')
  if (slots == null || React == null) return function () {}
  return slots.inject('settings.section', function () {
    return slots.register({
      name: 'settings.section',
      id: 'dsh-agent-gate',
      order: 21,
      locale: NS,
      label() { return t('nav') },
    }, Page)
  })
}
