import { forEachLiveAgent } from 'dsh-claw-core/live-agents'
import { allowTool } from 'dsh-claw-permissions/schema'

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

function sameNames(left, right) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export function emptyMcpState() {
  return { names: [], dispose: null, busy: false }
}

export function hideDeniedMcp(agent, policy, state) {
  const tools = agent && agent.ctx && agent.ctx.tools
  if (!tools || typeof tools.restrict !== 'function') return []
  const bag = state && typeof state === 'object' && !Array.isArray(state) && !(state instanceof Set)
    ? state
    : emptyMcpState()
  if (bag.busy) return []
  let schemas = []
  try {
    schemas = typeof tools.schemas === 'function' ? (tools.schemas(agent) || []) : []
  } catch {
    return []
  }
  const names = deniedMcpNames(policy, schemas).slice().sort()
  if (sameNames(bag.names || [], names)) return []
  bag.busy = true
  try {
    if (typeof bag.dispose === 'function') {
      try { bag.dispose() } catch { /* already lifted */ }
      bag.dispose = null
    }
    bag.names = names
    if (names.length === 0) return []
    bag.dispose = tools.restrict({ deny: names }) || null
    return names
  } catch {
    bag.names = []
    bag.dispose = null
    return []
  } finally {
    bag.busy = false
  }
}

export function eachLiveAgent(agents, fn) {
  forEachLiveAgent(agents, fn)
}
