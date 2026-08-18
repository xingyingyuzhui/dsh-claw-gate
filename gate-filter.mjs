export const TIME_RANGES = ['today', 'yesterday', 'week', 'month', 'all']
export const KIND_IDS = ['all', 'deny', 'ask', 'pin']

export function emptyAuditQuery() {
  return { range: 'today', kind: 'all', tool: 'all', agent: 'all' }
}

export function normalizeAuditQuery(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const range = TIME_RANGES.indexOf(value.range) >= 0 ? value.range : 'today'
  const kind = KIND_IDS.indexOf(value.kind) >= 0 ? value.kind : 'all'
  const tool = typeof value.tool === 'string' && value.tool ? value.tool : 'all'
  const agent = typeof value.agent === 'string' && value.agent ? value.agent : 'all'
  return { range, kind, tool, agent }
}

export function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function rangeBounds(range, now = Date.now()) {
  const today = startOfDay(now)
  if (range === 'all') return { from: 0, to: Number.POSITIVE_INFINITY }
  if (range === 'yesterday') return { from: today - 86400000, to: today }
  if (range === 'week') return { from: today - 6 * 86400000, to: Number.POSITIVE_INFINITY }
  if (range === 'month') return { from: today - 29 * 86400000, to: Number.POSITIVE_INFINITY }
  return { from: today, to: Number.POSITIVE_INFINITY }
}

export function auditAgentKey(row) {
  if (!row) return 'official'
  if (row.agentId) return String(row.agentId)
  if (row.agentTitle) return 'title:' + String(row.agentTitle)
  if (row.claw) return 'claw'
  return 'official'
}

export function auditAgentLabel(row, labels) {
  const names = labels || {}
  if (row && row.agentTitle) return row.agentTitle
  const key = auditAgentKey(row)
  if (key === 'official') return names.official || 'official'
  if (key === 'claw') return names.claw || 'Claw'
  return key
}

export function filterAudit(rows, query, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : []
  const q = normalizeAuditQuery(query)
  const bounds = rangeBounds(q.range, now)
  const out = []
  for (let i = 0; i < list.length; i++) {
    const row = list[i]
    if (!row) continue
    const at = Date.parse(row.at)
    if (Number.isFinite(at) && (at < bounds.from || at >= bounds.to)) continue
    if (q.kind !== 'all' && row.kind !== q.kind) continue
    if (q.tool !== 'all' && row.tool !== q.tool) continue
    if (q.agent !== 'all' && auditAgentKey(row) !== q.agent) continue
    out.push(row)
  }
  return out
}

export function auditFacets(rows, labels) {
  const list = Array.isArray(rows) ? rows : []
  const tools = []
  const toolSeen = new Set()
  const agents = []
  const agentSeen = new Set()
  for (let i = 0; i < list.length; i++) {
    const row = list[i]
    if (!row) continue
    if (row.tool && !toolSeen.has(row.tool)) {
      toolSeen.add(row.tool)
      tools.push(row.tool)
    }
    const key = auditAgentKey(row)
    if (!agentSeen.has(key)) {
      agentSeen.add(key)
      agents.push({ id: key, title: auditAgentLabel(row, labels) })
    }
  }
  tools.sort()
  agents.sort((a, b) => String(a.title).localeCompare(String(b.title)))
  return { tools, agents }
}

export function serializeAudit(rows, format) {
  const list = Array.isArray(rows) ? rows : []
  if (format === 'md' || format === 'markdown') {
    const lines = [
      '# Agent gate audit',
      '',
      '| Time | Kind | Tool | Agent | Session | Reason |',
      '| --- | --- | --- | --- | --- | --- |',
    ]
    for (let i = 0; i < list.length; i++) {
      const row = list[i] || {}
      const cell = (value) => String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
      lines.push([
        '',
        cell(row.at),
        cell(row.kind),
        cell(row.tool),
        cell(row.agentTitle || auditAgentKey(row)),
        cell(row.sessionId),
        cell(row.reason),
        '',
      ].join(' | ').trim())
    }
    return lines.join('\n') + '\n'
  }
  return list.map((row) => JSON.stringify(row)).join('\n') + (list.length ? '\n' : '')
}
