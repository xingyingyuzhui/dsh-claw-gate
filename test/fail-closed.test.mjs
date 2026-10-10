import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { eachLiveAgent } from '../gate-mcp.mjs'
import { apply, _internal, CLAW_PERMISSIONS_UNAVAILABLE } from '../host.js'

test('eachLiveAgent uses list not values', () => {
  const seen = []
  const agents = {
    list() { return [{ id: 'a' }, { id: 'b' }] },
    values() { throw new Error('agents.values must not be called') },
  }
  eachLiveAgent(agents, (a) => seen.push(a.id))
  assert.deepEqual(seen, ['a', 'b'])
})

test('eachLiveAgent accepts ctx-shaped bag', () => {
  const seen = []
  eachLiveAgent({
    agents: {
      list() { return [{ id: 'c' }] },
      values() { throw new Error('agents.values must not be called') },
    },
  }, (a) => seen.push(a.id))
  assert.deepEqual(seen, ['c'])
})

async function clawFixture() {
  const home = await mkdtemp(join(tmpdir(), 'gate-claw-'))
  const claw = join(home, 'DSclaw', 'bot')
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await mkdir(claw, { recursive: true })
  await writeFile(join(home, 'settings.yaml'), 'permission:\n  defaultPreset: danger-full-access\n')
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    version: 1,
    agents: {
      wa_bot: {
        agentId: 'wa_bot',
        title: 'bot',
        preset: 'developer',
        dshPreset: 'wa-bot',
        canonicalRoot: claw,
        status: 'active',
      },
    },
  }))
  return { home, claw }
}

function installGate(home) {
  _internal.setDshHome(home)
  const guards = []
  const events = {}
  apply({
    tools: { guard(fn) { guards.push(fn); return () => {} } },
    connection: { fetch: { register() { return () => {} } } },
    skills: { async snapshot() { return { skills: [], complete: true } } },
    on(name, fn) { events[name] = fn; return () => {} },
    effect() {},
  })
  return { guard: guards[0], pre: events['tools/pre-execute'] }
}

test('claw session with broken layers → deny (guard + pre-execute aligned)', async () => {
  const { home, claw } = await clawFixture()
  const sessionId = 'session-broken-1111-2222-3333-444444444444'
  await mkdir(join(home, 'session-permissions'), { recursive: true })
  // Invalid JSON forces resolveLayersSync / loadPolicySync to throw
  await writeFile(join(home, 'session-permissions', sessionId + '.json'), '{not-json')
  const { guard, pre } = installGate(home)
  const exec = {
    name: 'read',
    arguments: { path: join(claw, 'a.md') },
    agent: {
      session: {
        id: sessionId,
        header: { cwd: claw, agentPreset: 'wa-bot' },
        events: [],
      },
    },
  }
  const guardReason = guard(exec)
  assert.equal(guardReason, CLAW_PERMISSIONS_UNAVAILABLE)
  const preResult = pre(exec, () => ({ kind: 'allow' }))
  assert.deepEqual(preResult, { kind: 'deny', reason: CLAW_PERMISSIONS_UNAVAILABLE })
})

test('claw session with null layers (no session id) → deny', async () => {
  const { home, claw } = await clawFixture()
  const { guard, pre } = installGate(home)
  const exec = {
    name: 'bash',
    arguments: { command: 'ls' },
    agent: {
      session: {
        header: { cwd: claw, agentPreset: 'wa-bot' },
        events: [],
      },
    },
  }
  assert.equal(guard(exec), CLAW_PERMISSIONS_UNAVAILABLE)
  assert.deepEqual(pre(exec, () => ({ kind: 'allow' })), {
    kind: 'deny',
    reason: CLAW_PERMISSIONS_UNAVAILABLE,
  })
})

test('ordinary session unaffected when layers missing', async () => {
  const { home } = await clawFixture()
  const desktop = join(home, 'Desktop', 'proj')
  await mkdir(desktop, { recursive: true })
  const { guard, pre } = installGate(home)
  const exec = {
    name: 'bash',
    arguments: { command: 'ls' },
    agent: {
      session: {
        // no id → layers null; ordinary path must not fail-closed
        header: { cwd: desktop, agentPreset: 'standard' },
        events: [],
      },
    },
  }
  assert.equal(guard(exec), undefined)
  assert.deepEqual(pre(exec, () => ({ kind: 'allow' })), { kind: 'allow' })
})
