import { loadAgentHintSync } from '../dsh-session-permissions/perm-layers.mjs'

export function lookupOf(options) {
  const value = options && typeof options === 'object' ? options : {}
  const cwd = typeof value.cwd === 'string' && value.cwd
    ? value.cwd
    : (value.scope && value.scope.session && value.scope.session.header && value.scope.session.header.cwd) || ''
  const preset = value.scope && value.scope.session && value.scope.session.header
    ? value.scope.session.header.agentPreset
    : undefined
  return { cwd, preset }
}

export function deniedSkillNames(home, options) {
  const agent = loadAgentHintSync(home, lookupOf(options))
  const deny = agent && agent.policy && agent.policy.skills && agent.policy.skills.deny
  return Array.isArray(deny) ? deny.filter((name) => typeof name === 'string' && name) : []
}

export function filterSkillRows(rows, denied) {
  const list = Array.isArray(rows) ? rows : []
  if (!denied || denied.length === 0) return list.slice()
  const blocked = new Set(denied)
  return list.filter((row) => row && !blocked.has(row.name))
}

export function filterSnapshot(snapshot, denied) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : { skills: [], complete: true }
  return {
    ...value,
    skills: filterSkillRows(value.skills, denied),
  }
}
