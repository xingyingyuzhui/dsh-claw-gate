import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditAgentKey,
  auditFacets,
  emptyAuditQuery,
  filterAudit,
  normalizeAuditQuery,
} from '../gate-filter.mjs'

const now = new Date(2026, 7, 18, 15, 0).getTime()

function row(partial) {
  return {
    at: new Date(2026, 7, 18, 6, 0).toISOString(),
    kind: 'deny',
    tool: 'bash',
    sessionId: 'session-a',
    ...partial,
  }
}

test('default query is today, not everything', () => {
  assert.deepEqual(emptyAuditQuery(), { range: 'today', kind: 'all', tool: 'all', agent: 'all' })
  assert.equal(normalizeAuditQuery({}).range, 'today')
})

test('filterAudit slices time, kind, tool, and agent', () => {
  const rows = [
    row({ at: new Date(2026, 7, 18, 14, 3).toISOString(), kind: 'pin', tool: '', agentId: 'wa_1', agentTitle: 'test1', claw: true }),
    row({ at: new Date(2026, 7, 18, 13, 41).toISOString(), kind: 'ask', tool: 'bash', agentId: 'wa_1', agentTitle: 'test1', claw: true }),
    row({ at: new Date(2026, 7, 17, 13, 0).toISOString(), kind: 'deny', tool: 'write', agentId: 'wa_2', agentTitle: 'test2', claw: true }),
    row({ at: new Date(2026, 6, 1, 0, 0).toISOString(), kind: 'deny', tool: 'bash' }),
  ]
  assert.equal(filterAudit(rows, { range: 'today' }, now).length, 2)
  assert.equal(filterAudit(rows, { range: 'yesterday' }, now).length, 1)
  assert.equal(filterAudit(rows, { range: 'all', kind: 'deny' }, now).length, 2)
  assert.equal(filterAudit(rows, { range: 'all', tool: 'bash' }, now).length, 2)
  assert.equal(filterAudit(rows, { range: 'all', agent: 'wa_1' }, now).length, 2)
  assert.equal(auditAgentKey(rows[3]), 'official')
  const facets = auditFacets(rows, { official: '官方会话', claw: 'Claw' })
  assert.deepEqual(facets.tools, ['bash', 'write'])
  assert.ok(facets.agents.some((item) => item.title === 'test1'))
  assert.ok(facets.agents.some((item) => item.id === 'official'))
})
