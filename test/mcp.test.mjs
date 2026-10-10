import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPreset, normalizePolicy } from 'dsh-claw-policy/schema'
import { deniedMcpNames, emptyMcpState, hideDeniedMcp } from '../gate-mcp.mjs'

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
        restrict(filter) { denied.push(filter); return () => {} },
      },
    },
  }
  const policy = normalizePolicy({
    preset: 'developer',
    mcp: 'explicit',
    servers: { allow: ['github'], deny: [] },
  })
  const state = emptyMcpState()
  assert.deepEqual(hideDeniedMcp(agent, policy, state), ['mcp__slack__post'])
  assert.deepEqual(hideDeniedMcp(agent, policy, state), [])
  assert.deepEqual(denied, [{ deny: ['mcp__slack__post'] }])
})

test('hideDeniedMcp lifts a previous deny when policy is relaxed', () => {
  const denied = []
  const lifted = []
  const agent = {
    ctx: {
      tools: {
        schemas() {
          return [{ name: 'mcp__github__search' }, { name: 'mcp__slack__post' }]
        },
        restrict(filter) {
          denied.push(filter)
          return () => { lifted.push(filter) }
        },
      },
    },
  }
  const tight = normalizePolicy({ preset: 'developer', mcp: 'none' })
  const loose = normalizePolicy({
    preset: 'developer',
    mcp: 'explicit',
    servers: { allow: ['github'], deny: [] },
  })
  const state = emptyMcpState()
  assert.deepEqual(hideDeniedMcp(agent, tight, state).slice().sort(), ['mcp__github__search', 'mcp__slack__post'])
  assert.deepEqual(hideDeniedMcp(agent, loose, state), ['mcp__slack__post'])
  assert.equal(lifted.length, 1)
  assert.deepEqual(denied[1], { deny: ['mcp__slack__post'] })
  assert.deepEqual(hideDeniedMcp(agent, normalizePolicy({ preset: 'developer', mcp: 'init-defaults' }), state), [])
  assert.equal(lifted.length, 2)
})
