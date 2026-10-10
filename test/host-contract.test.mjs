import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { setObserveHome } from 'dsh-claw-observability/observe'
import { apply, inject, name, MCP_REFRESH_MS } from '../host.js'

setObserveHome(mkdtempSync(join(tmpdir(), 'gate-observe-')))

function fakeConnection() {
  const routes = []
  return {
    routes,
    connection: {
      fetch: {
        register(entry) {
          routes.push(entry)
          return () => {}
        },
      },
    },
  }
}

test('agent/created hides MCP and does not pin sandbox', () => {
  const appended = []
  const session = {
    id: 'session-gate',
    header: { cwd: '/Users/qin/.dsh/DSclaw/test1', agentPreset: 'standard' },
    events: [],
    append(type, data) { appended.push({ type, data }) },
  }
  const events = {}
  const { connection } = fakeConnection()
  apply({
    tools: { guard() { return () => {} } },
    connection,
    skills: { async snapshot() { return { skills: [], complete: true } } },
    on(name, fn) { events[name] = fn; return () => {} },
    effect() {},
  })
  events['agent/created']({ agent: { session, tools: { list() { return [] } } }, source: 'startup' })
  assert.equal(appended.length, 0)
})

test('gate named exports and hooks', () => {
  assert.equal(name, 'dsh-claw-gate')
  assert.deepEqual(inject, ['tools', 'connection', 'skills', 'agents'])
  const guards = []
  const events = []
  const { connection, routes } = fakeConnection()
  apply({
    tools: { guard(fn) { guards.push(fn); return () => {} } },
    connection,
    skills: {
      async snapshot() { return { skills: [], complete: true } },
      async get() { return undefined },
    },
    on(event, fn) { events.push(event); return () => {} },
    effect() {},
  })
  assert.equal(guards.length, 1)
  assert.deepEqual(events, ['agent/created', 'tools/change', 'tools/pre-execute'])
  assert.deepEqual(routes.map((row) => row.path), [
    '/api/dsh-claw/gate/audit',
    '/api/dsh-claw/gate/audit-export',
  ])
  for (const row of routes) {
    assert.deepEqual(row.methods, ['POST'])
    assert.equal(row.requestBody, 'buffered')
    assert.equal(typeof row.fetch, 'function')
  }
})

test('tools/change walks injected agents and does not throw without them', () => {
  const events = {}
  const seen = []
  const { connection } = fakeConnection()
  apply({
    tools: { guard() { return () => {} } },
    connection,
    skills: { async snapshot() { return { skills: [], complete: true } } },
    agents: {
      list() { return [{ id: 'agent-1', session: { id: 's1', header: {}, events: [] } }] },
      values() { throw new Error('agents.values must not be called') },
    },
    on(event, fn) { events[event] = fn; return () => {} },
    effect() {},
  })
  assert.equal(typeof events['tools/change'], 'function')
  events['tools/change']()
  seen.push('with-agents')
  const missing = {}
  const again = fakeConnection()
  apply({
    tools: { guard() { return () => {} } },
    connection: again.connection,
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
    const { connection } = fakeConnection()
    apply({
      tools: { guard() { return () => {} } },
      connection,
      skills: { async snapshot() { return { skills: [], complete: true } } },
      agents: {
        list() {
          scans += 1
          throw new Error('scan exploded')
        },
        values() { throw new Error('agents.values must not be called') },
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

test('audit route answers via Connection Fetch Request/Response', async () => {
  const { connection, routes } = fakeConnection()
  apply({
    tools: { guard() { return () => {} } },
    connection,
    skills: { async snapshot() { return { skills: [], complete: true } } },
    on() { return () => {} },
    effect() {},
  })
  const audit = routes.find((row) => row.path === '/api/dsh-claw/gate/audit')
  assert.ok(audit)
  const res = await audit.fetch(new Request('dsh-app://host/api/dsh-claw/gate/audit', {
    method: 'POST',
    body: JSON.stringify({ limit: 10 }),
  }))
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.items))
})
