import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../host.js'
import { officialPin } from '../../dsh-session-permissions/perm-official.mjs'
import { composeLayers } from '../../dsh-session-permissions/perm-layers.mjs'
import { applyPreset, tighterSandbox } from '../../dsh-session-permissions/perm-schema.mjs'

test('unloading the gate restores skills and drops interceptors', async () => {
  const origSnapshot = async () => ({ skills: [{ name: 'cad' }], complete: true })
  const origGet = async (name) => name
  const skills = { snapshot: origSnapshot, get: origGet }
  const guards = []
  const events = {}
  let stop
  apply({
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => { guards.pop() }
      },
    },
    webServer: { register() { return () => {} } },
    skills,
    on(name, fn) {
      events[name] = fn
      return () => { delete events[name] }
    },
    effect(fn) { stop = fn() },
  })
  assert.notEqual(skills.snapshot, origSnapshot)
  assert.equal(guards.length, 1)
  assert.ok(events['tools/pre-execute'])
  stop()
  const snap = await skills.snapshot()
  assert.deepEqual(snap.skills.map((row) => row.name), ['cad'])
  assert.equal(await skills.get('cad'), 'cad')
  assert.equal(guards.length, 0)
  assert.equal(events['tools/pre-execute'], undefined)
  assert.equal(events['agent/session-start'], undefined)
  assert.equal(events['tools/change'], undefined)
})

test('official pin never widens a tighter sandbox after gate is gone', () => {
  assert.equal(tighterSandbox('danger-full-access', 'read-only'), 'read-only')
  assert.equal(tighterSandbox('workspace-write', 'read-only'), 'read-only')
  assert.equal(tighterSandbox('read-only', 'workspace-write'), 'read-only')
  const claw = composeLayers({
    officialName: 'danger-full-access',
    claw: true,
    agent: { agentId: 'wa_1', title: 'test1', preset: 'research', policy: applyPreset('research') },
    sessionRecord: { source: 'inherit', policy: null },
  })
  const afterUnload = officialPin(claw, [
    { type: 'sandbox/mode', data: { mode: 'read-only' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
  ])
  assert.equal(afterUnload.sandbox, null)
})
