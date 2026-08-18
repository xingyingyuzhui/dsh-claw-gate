import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { apply, inject, name, MCP_REFRESH_MS } from '../host.js'

test('session-start hides MCP and does not pin sandbox', () => {
  const appended = []
  const session = {
    id: 'session-gate',
    header: { cwd: '/Users/qin/.dsh/DSclaw/test1', agentPreset: 'standard' },
    events: [],
    append(type, data) { appended.push({ type, data }) },
  }
  const events = {}
  apply({
    tools: { guard() { return () => {} } },
    webServer: { register() { return () => {} } },
    skills: { async snapshot() { return { skills: [], complete: true } } },
    on(name, fn) { events[name] = fn; return () => {} },
    effect() {},
  })
  events['agent/session-start']({ agent: { session, tools: { list() { return [] } } } })
  assert.equal(appended.length, 0)
})

test('gate named exports and hooks', () => {
  assert.equal(name, 'dsh-agent-gate')
  assert.deepEqual(inject, ['tools', 'webServer', 'skills', 'agents'])
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
  assert.deepEqual(events, ['agent/session-start', 'tools/change', 'tools/pre-execute'])
  assert.deepEqual(routes, ['/dsh-agent-gate/audit', '/dsh-agent-gate/audit-export'])
})

test('tools/change walks injected agents and does not throw without them', () => {
  const events = {}
  const seen = []
  apply({
    tools: { guard() { return () => {} } },
    webServer: { register() { return () => {} } },
    skills: { async snapshot() { return { skills: [], complete: true } } },
    agents: {
      values() { return [{ id: 'agent-1', session: { id: 's1', header: {}, events: [] } }] },
    },
    on(event, fn) { events[event] = fn; return () => {} },
    effect() {},
  })
  assert.equal(typeof events['tools/change'], 'function')
  events['tools/change']()
  seen.push('with-agents')
  const missing = {}
  apply({
    tools: { guard() { return () => {} } },
    webServer: { register() { return () => {} } },
    skills: { async snapshot() { return { skills: [], complete: true } } },
    get(key) {
      if (key === 'agents') throw new Error('cannot get property "agents" without inject')
      return undefined
    },
    on(event, fn) { missing[event] = fn; return () => {} },
    effect() {},
  })
  assert.doesNotThrow(() => missing['tools/change']())
  assert.deepEqual(seen, ['with-agents'])
})

test('tools/change coalesces bursts and never throws out of the listener', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const events = {}
    let scans = 0
    let stop
    apply({
      tools: { guard() { return () => {} } },
      webServer: { register() { return () => {} } },
      skills: { async snapshot() { return { skills: [], complete: true } } },
      agents: {
        values() {
          scans += 1
          throw new Error('scan exploded')
        },
      },
      on(event, fn) { events[event] = fn; return () => {} },
      effect(fn) { stop = fn() },
    })
    for (let i = 0; i < 20; i++) events['tools/change']()
    assert.equal(scans, 0)
    assert.doesNotThrow(() => mock.timers.tick(MCP_REFRESH_MS))
    assert.equal(scans, 1)
    if (typeof stop === 'function') stop()
  } finally {
    mock.timers.reset()
  }
})
