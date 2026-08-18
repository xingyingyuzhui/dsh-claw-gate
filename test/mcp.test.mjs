import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPreset, normalizePolicy } from '../../dsh-agent-policy/policy-schema.mjs'
import { deniedMcpNames, hideDeniedMcp } from '../gate-mcp.mjs'

test('deniedMcpNames keeps allowed servers and drops the rest', () => {
  const policy = normalizePolicy({
    preset: 'developer',
    mcp: 'explicit',
    servers: { allow: ['github'], deny: [] },
  })
  assert.deepEqual(deniedMcpNames(policy, [
    { name: 'mcp__github__search' },
    { name: 'mcp__slack__post' },
    { name: 'read' },
  ]), ['mcp__slack__post'])
  assert.deepEqual(deniedMcpNames(applyPreset('research'), [
    { name: 'mcp__github__search' },
  ]), [])
})

test('hideDeniedMcp restricts only new unauthorized names', () => {
  const denied = []
  const agent = {
    ctx: {
      tools: {
        schemas() {
          return [{ name: 'mcp__github__search' }, { name: 'mcp__slack__post' }]
        },
        restrict(filter) { denied.push(filter) },
      },
    },
  }
  const policy = normalizePolicy({
    preset: 'developer',
    mcp: 'explicit',
    servers: { allow: ['github'], deny: [] },
  })
  const seen = new Set()
  assert.deepEqual(hideDeniedMcp(agent, policy, seen), ['mcp__slack__post'])
  assert.deepEqual(hideDeniedMcp(agent, policy, seen), [])
  assert.deepEqual(denied, [{ deny: ['mcp__slack__post'] }])
})
