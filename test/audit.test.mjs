import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { auditFile, enrichAudit, exportAudit, exportFilename, readAudit, slugFromSessionBucket } from '../gate-audit.mjs'

test('readAudit returns newest first and skips bad lines', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dag-'))
  const file = auditFile(home)
  await mkdir(join(home, 'agent-gate'), { recursive: true })
  await writeFile(file, [
    '{"kind":"deny","tool":"bash","reason":"old","sessionId":"session-a","at":"2026-01-01T00:00:00.000Z"}',
    'not-json',
    '{"kind":"ask","tool":"write","reason":"new","sessionId":"session-b","at":"2026-01-02T00:00:00.000Z"}',
    '',
  ].join('\n'))
  const rows = readAudit(home, 10)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'ask')
  assert.equal(rows[0].tool, 'write')
  assert.equal(rows[1].kind, 'deny')
  assert.equal(rows[1].tool, 'bash')
})

test('readAudit is empty when the file is missing', () => {
  assert.deepEqual(readAudit(join(tmpdir(), 'missing-dag-home'), 10), [])
})

test('exportAudit writes jsonl and markdown without leaking a missing file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dag-ex-'))
  assert.equal(exportAudit(home, 'jsonl'), '')
  const file = auditFile(home)
  await mkdir(join(home, 'agent-gate'), { recursive: true })
  await writeFile(file, '{"kind":"deny","tool":"bash","reason":"BLOCKED","sessionId":"session-a","at":"2026-01-02T00:00:00.000Z"}\n')
  const jsonl = exportAudit(home, 'jsonl')
  assert.match(jsonl, /"tool":"bash"/)
  const md = exportAudit(home, 'md')
  assert.match(md, /# Agent gate audit/)
  assert.match(md, /bash/)
  assert.match(md, /BLOCKED/)
  assert.match(exportFilename('md', new Date(2026, 7, 18)), /dsh-audit-2026-08-18\.md/)
})

test('slugFromSessionBucket reads DSclaw folders', () => {
  assert.equal(slugFromSessionBucket('--Users-qin-.dsh-DSclaw-test1--'), 'test1')
  assert.equal(slugFromSessionBucket('--Users-qin-DSH--'), '')
})

test('enrichAudit fills agent title from the session bucket', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dag-en-'))
  const bucket = join(home, 'sessions', '--Users-qin-.dsh-DSclaw-test1--', 'session-old')
  await mkdir(bucket, { recursive: true })
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    version: 1,
    agents: {
      wa_1: { agentId: 'wa_1', title: 'test1', slug: 'test1', status: 'active', canonicalRoot: '/tmp/DSclaw/test1' },
    },
  }))
  const rows = enrichAudit(home, [
    { kind: 'pin', sessionId: 'session-old', tool: '', reason: '', at: '2026-08-18T00:00:00.000Z', agentId: '', agentTitle: '', claw: true },
  ])
  assert.equal(rows[0].agentTitle, 'test1')
  assert.equal(rows[0].agentId, 'wa_1')
})
