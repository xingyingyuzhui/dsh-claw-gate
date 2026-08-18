import { allowTool } from '../dsh-session-permissions/perm-schema.mjs'

export function deniedMcpNames(policy, schemas) {
  const list = Array.isArray(schemas) ? schemas : []
  const deny = []
  for (let i = 0; i < list.length; i++) {
    const name = list[i] && list[i].name
    if (!name || !String(name).startsWith('mcp__')) continue
    if (!allowTool(policy, name, {})) deny.push(name)
  }
  return deny
}

export function hideDeniedMcp(agent, policy, seen) {
  const tools = agent && agent.ctx && agent.ctx.tools
  if (!tools || typeof tools.restrict !== 'function') return []
  let schemas = []
  try {
    schemas = typeof tools.schemas === 'function' ? (tools.schemas(agent) || []) : []
  } catch {
    return []
  }
  const prev = seen || new Set()
  const names = deniedMcpNames(policy, schemas).filter((name) => !prev.has(name))
  if (names.length === 0) return []
  try {
    tools.restrict({ deny: names })
    for (let i = 0; i < names.length; i++) prev.add(names[i])
    return names
  } catch {
    return []
  }
}

export function eachLiveAgent(agents, fn) {
  if (!agents) return
  if (typeof agents.values === 'function') {
    for (const agent of agents.values()) fn(agent)
    return
  }
  if (typeof agents.list === 'function') {
    const list = agents.list()
    if (Array.isArray(list)) list.forEach(fn)
  }
}
