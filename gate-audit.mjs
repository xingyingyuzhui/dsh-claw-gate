import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { filterAudit, normalizeAuditQuery, serializeAudit } from './gate-filter.mjs'

const READ_CAP = 262144
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 2000

export function auditFile(home) {
  return join(home, 'agent-gate', 'audit.jsonl')
}

export function normalizeAudit(row) {
  const value = row && typeof row === 'object' ? row : {}
  const kind = value.kind === 'ask' || value.kind === 'pin' ? value.kind : 'deny'
  return {
    at: typeof value.at === 'string' ? value.at : '',
    kind,
    tool: typeof value.tool === 'string' ? value.tool : '',
    reason: typeof value.reason === 'string' ? value.reason : '',
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    agentId: typeof value.agentId === 'string' ? value.agentId : '',
    agentTitle: typeof value.agentTitle === 'string' ? value.agentTitle : '',
    claw: !!value.claw,
  }
}

export function readAudit(home, limit) {
  const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)))) : DEFAULT_LIMIT
  const file = auditFile(home)
  let text = ''
  let truncated = false
  try {
    const stat = statSync(file)
    const start = stat.size > READ_CAP ? stat.size - READ_CAP : 0
    truncated = start > 0
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = text.split('\n')
  if (truncated && lines.length) lines.shift()
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      rows.push(normalizeAudit(JSON.parse(line)))
    } catch { /* skip bad line */ }
  }
  return enrichAudit(home, rows.slice(-cap).reverse())
}

function loadRegistryAgents(home) {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'workspace-agents', 'registry.json'), 'utf8'))
    return Object.values((raw && raw.agents) || {}).filter((row) => row && row.status !== 'archived')
  } catch {
    return []
  }
}

export function slugFromSessionBucket(name) {
  const text = String(name || '').replace(/\\/g, '/')
  const match = text.match(/DSclaw-([^/]+?)--?$/i)
  return match ? match[1] : ''
}

const INDEX_TTL_MS = 5000
let sessionIndexCache = { home: '', agentsKey: '', at: 0, map: null }

function agentsCacheKey(agents) {
  const list = Array.isArray(agents) ? agents : []
  let key = ''
  for (let i = 0; i < list.length; i++) {
    const agent = list[i]
    if (!agent) continue
    key += (agent.agentId || '') + ':' + (agent.slug || '') + ':' + (agent.title || '') + '|'
  }
  return key
}

export function clearSessionIndexCache() {
  sessionIndexCache = { home: '', agentsKey: '', at: 0, map: null }
}

export function indexSessionAgents(home, agents) {
  const now = Date.now()
  const agentsKey = agentsCacheKey(agents)
  if (
    sessionIndexCache.map
    && sessionIndexCache.home === home
    && sessionIndexCache.agentsKey === agentsKey
    && now - sessionIndexCache.at < INDEX_TTL_MS
  ) {
    return sessionIndexCache.map
  }
  const bySlug = {}
  const list = Array.isArray(agents) ? agents : []
  for (let i = 0; i < list.length; i++) {
    const agent = list[i]
    if (!agent) continue
    if (agent.slug) bySlug[String(agent.slug)] = agent
    if (agent.title) bySlug[String(agent.title)] = agent
  }
  const map = {}
  const root = join(home, 'sessions')
  let buckets = []
  try {
    buckets = readdirSync(root)
  } catch {
    sessionIndexCache = { home, agentsKey, at: now, map }
    return map
  }
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i]
    const slug = slugFromSessionBucket(bucket)
    const agent = slug ? bySlug[slug] : null
    if (!agent) continue
    let sessions = []
    try {
      sessions = readdirSync(join(root, bucket))
    } catch {
      continue
    }
    for (let s = 0; s < sessions.length; s++) {
      const id = sessions[s]
      if (!id || !existsSync(join(root, bucket, id))) continue
      map[id] = agent
    }
  }
  sessionIndexCache = { home, agentsKey, at: now, map }
  return map
}

export function enrichAudit(home, rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return list
  const agents = loadRegistryAgents(home)
  const bySession = indexSessionAgents(home, agents)
  const byRoot = {}
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]
    if (agent && agent.canonicalRoot) byRoot[String(agent.canonicalRoot)] = agent
  }
  return list.map((row) => {
    if (row.agentId && row.agentTitle) return row
    const agent = (row.sessionId && bySession[row.sessionId])
      || (row.cwd && byRoot[row.cwd])
      || null
    if (!agent) return row
    return {
      ...row,
      claw: true,
      agentId: row.agentId || agent.agentId || '',
      agentTitle: row.agentTitle || agent.title || agent.slug || '',
      cwd: row.cwd || agent.canonicalRoot || '',
    }
  })
}

export const EXPORT_LIMIT = 2000

export function exportAudit(home, format, query) {
  const rows = readAudit(home, EXPORT_LIMIT)
  const next = query ? filterAudit(rows, query) : rows
  return serializeAudit(next, format)
}

export function exportFilename(format, now = new Date()) {
  const stamp = now instanceof Date ? now : new Date(now)
  const y = stamp.getFullYear()
  const m = String(stamp.getMonth() + 1).padStart(2, '0')
  const d = String(stamp.getDate()).padStart(2, '0')
  const ext = format === 'md' || format === 'markdown' ? 'md' : 'jsonl'
  return 'dsh-audit-' + y + '-' + m + '-' + d + '.' + ext
}
