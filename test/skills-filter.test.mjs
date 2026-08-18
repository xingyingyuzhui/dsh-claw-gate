import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { deniedSkillNames, filterSkillRows, filterSnapshot } from '../gate-skills.mjs'
import { wrapSkills } from '../host.js'

test('deniedSkillNames reads the agent deny list by cwd', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dag-sk-'))
  const root = join(home, 'DSclaw', 'test1')
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    version: 1,
    main: { agentId: 'main', createdAt: 't' },
    agents: {
      wa_1: {
        agentId: 'wa_1',
        workspaceId: '1',
        canonicalRoot: root,
        title: 'test1',
        slug: 'test1',
        preset: 'developer',
        dshPreset: 'wa-test1',
        status: 'active',
        policy: { preset: 'developer', skills: { deny: ['bambu-labs', 'cad'] } },
      },
    },
  }))
  assert.deepEqual(deniedSkillNames(home, { cwd: root }), ['bambu-labs', 'cad'])
  assert.deepEqual(deniedSkillNames(home, { cwd: join(home, 'other') }), [])
})

test('filterSnapshot drops denied names', () => {
  const next = filterSnapshot({
    complete: true,
    skills: [{ name: 'keep' }, { name: 'cad' }, { name: 'keep-too' }],
  }, ['cad'])
  assert.deepEqual(next.skills.map((row) => row.name), ['keep', 'keep-too'])
  assert.equal(next.complete, true)
  assert.deepEqual(filterSkillRows([{ name: 'cad' }], ['cad']), [])
})

test('wrapSkills filters snapshot and get, then restores', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dag-wrap-'))
  const root = join(home, 'DSclaw', 'x')
  await mkdir(join(home, 'workspace-agents'), { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(join(home, 'workspace-agents', 'registry.json'), JSON.stringify({
    version: 1,
    main: { agentId: 'main', createdAt: 't' },
    agents: {
      wa_x: {
        agentId: 'wa_x',
        workspaceId: 'x',
        canonicalRoot: root,
        title: 'x',
        slug: 'x',
        preset: 'research',
        dshPreset: 'wa-x',
        status: 'active',
        policy: { preset: 'research', skills: { deny: ['hidden'] } },
      },
    },
  }))
  const skills = {
    async snapshot() {
      return { complete: true, skills: [{ name: 'visible' }, { name: 'hidden' }] }
    },
    async get(name) {
      return { name, content: 'body' }
    },
  }
  const stop = wrapSkills(skills, home)
  const snap = await skills.snapshot({ cwd: root })
  assert.deepEqual(snap.skills.map((row) => row.name), ['visible'])
  assert.equal(await skills.get('hidden', { cwd: root }), undefined)
  assert.equal((await skills.get('visible', { cwd: root })).name, 'visible')
  stop()
  const again = await skills.snapshot({ cwd: root })
  assert.equal(again.skills.length, 2)
})
