import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, name } from '../host.js'

test('gate named exports and hooks', () => {
  assert.equal(name, 'dsh-agent-gate')
  assert.deepEqual(inject, ['tools', 'webServer', 'skills'])
  const guards = []
  const events = []
  const routes = []
  apply({
    tools: { guard(fn) { guards.push(fn); return () => {} } },
    webServer: { register(row) { routes.push(row.path); return () => {} } },
    skills: {
      async snapshot() { return { skills: [], complete: true } },
      async get() { return undefined },
    },
    on(event, fn) { events.push(event); return () => {} },
    effect() {},
  })
  assert.equal(guards.length, 1)
  assert.deepEqual(events, ['agent/session-start', 'tools/pre-execute'])
  assert.deepEqual(routes, ['/dsh-agent-gate/audit', '/dsh-agent-gate/audit-export'])
})
