import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { classifySession } from 'dsh-claw-core/session-classifier'
import { registerJsonRoute } from 'dsh-claw-core/http'
import { defaultDshHome } from 'dsh-claw-permissions/store'
import { resolveLayersSync } from 'dsh-claw-permissions/layers'
import { denyReason } from 'dsh-claw-permissions/layers'
import { askReason } from 'dsh-claw-permissions/official'
import { exportAudit, exportFilename, readAudit } from './gate-audit.mjs'
import { deniedSkillNames, filterSnapshot } from './gate-skills.mjs'
import { eachLiveAgent, emptyMcpState, hideDeniedMcp } from './gate-mcp.mjs'
import { CODES, operation, policyHash, runWithTrace, setObserveHome } from 'dsh-claw-observability/observe'

export const CLAW_PERMISSIONS_UNAVAILABLE = 'Denied: claw permissions unavailable.'

export const name = 'dsh-claw-gate'
export const inject = ['tools', 'connection', 'skills', 'agents']
export const MCP_REFRESH_MS = 50

let dshHome = defaultDshHome()

const _internal = {
  setDshHome(dir) {
    dshHome = dir
    setObserveHome(dir)
  },
  getDshHome() { return dshHome },
}
export { _internal }

function layersOfSession(session) {
  if (!session || !session.id) return null
  const header = session.header || {}
  return resolveLayersSync(dshHome, {
    sessionId: session.id,
    cwd: header.cwd,
    preset: header.agentPreset,
    events: session.events,
  })
}

function sessionKind(session) {
  const header = (session && session.header) || {}
  return classifySession({
    dshHome,
    cwd: header.cwd,
    agentPreset: header.agentPreset,
  })
}

/**
 * For claw / claw-uncertain sessions, permissions layers must be available.
 * Returns a stable deny reason when layers are missing or resolve throws.
 * Ordinary sessions skip this fail-closed path.
 */
function clawPermissionsDeny(session) {
  const kind = sessionKind(session)
  if (kind !== 'claw' && kind !== 'claw-uncertain') return null
  let layers
  try {
    layers = layersOfSession(session)
  } catch {
    return { reason: CLAW_PERMISSIONS_UNAVAILABLE, layers: null }
  }
  if (!layers || !layers.effective) {
    return { reason: CLAW_PERMISSIONS_UNAVAILABLE, layers: layers || null }
  }
  return { reason: null, layers }
}

function auditContext(session, layers) {
  const header = (session && session.header) || {}
  const agent = layers && layers.agent
  return {
    sessionId: session && session.id ? session.id : '',
    cwd: header.cwd ? String(header.cwd) : '',
    claw: !!(layers && layers.claw),
    agentId: agent && agent.agentId ? String(agent.agentId) : '',
    agentTitle: agent && agent.title ? String(agent.title) : '',
  }
}

function audit(row) {
  try {
    const file = join(dshHome, 'agent-gate', 'audit.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n')
    return true
  } catch (error) {
    const op = operation({ plugin: 'dsh-claw-gate', feature: 'audit', operation: 'write_audit' })
    op.start()
    op.fail(CODES.GATE_AUDIT_WRITE_FAILED, error, { state: 'clean' })
    return false
  }
}

const recentAudit = new Map()

export function auditKey(row) {
  const value = row || {}
  return [value.kind || '', value.sessionId || '', value.tool || '', value.reason || ''].join('\0')
}

function matchedLayerOf(layers) {
  if (!layers) return 'unknown'
  if (layers.session && layers.record && layers.record.source === 'session') return 'session'
  if (layers.agent) return 'agent'
  if (layers.claw) return 'workspace'
  return 'official'
}

function logAuthorize(exec, decision, code, reason, layers) {
  const session = exec && exec.agent && exec.agent.session
  const op = operation({
    plugin: 'dsh-claw-gate',
    feature: 'authorize',
    operation: 'authorize_tool',
    sessionId: session && session.id,
    agentId: layers && layers.agent && layers.agent.agentId,
  })
  op.start()
  op.reject(code, {
    tool: exec && exec.name,
    decision,
    matchedLayer: matchedLayerOf(layers),
    reason,
    policyHash: policyHash(layers && layers.effective),
  })
}

export function auditOnce(row) {
  const key = auditKey(row)
  const now = Date.now()
  const prev = recentAudit.get(key)
  if (prev && now - prev < 1500) return false
  recentAudit.set(key, now)
  if (recentAudit.size > 64) {
    const first = recentAudit.keys().next().value
    recentAudit.delete(first)
  }
  audit({ ...row, id: key })
  return true
}

export function wrapSkills(skills, home) {
  if (skills == null || typeof skills.snapshot !== 'function') return function () {}
  const origSnapshot = skills.snapshot.bind(skills)
  const origGet = typeof skills.get === 'function' ? skills.get.bind(skills) : null
  let live = true
  async function snapshot(options) {
    if (!live) return origSnapshot(options)
    const snap = await origSnapshot(options)
    return filterSnapshot(snap, deniedSkillNames(home, options))
  }
  let getWrapped = null
  skills.snapshot = snapshot
  if (origGet) {
    getWrapped = async function get(name, options) {
      if (!live) return origGet(name, options)
      if (deniedSkillNames(home, options).indexOf(name) >= 0) return undefined
      return origGet(name, options)
    }
    skills.get = getWrapped
  }
  return function () {
    live = false
    if (skills.snapshot === snapshot) skills.snapshot = origSnapshot
    if (origGet && skills.get === getWrapped) skills.get = origGet
  }
}

function agentsOf(ctx) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get('agents')
      if (got != null) return got
    } catch { /* not injected */ }
  }
  try {
    return ctx && ctx.agents
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const stopSkills = wrapSkills(ctx.skills, dshHome)
  const hiddenMcp = new WeakMap()

  function hideMcpFor(agent) {
    const session = agent && agent.session
    const layers = session ? layersOfSession(session) : null
    if (!layers || !layers.claw || !layers.effective) return
    let state = hiddenMcp.get(agent)
    if (!state) {
      state = emptyMcpState()
      hiddenMcp.set(agent, state)
    }
    hideDeniedMcp(agent, layers.effective, state)
  }

  const stopGuard = ctx.tools && typeof ctx.tools.guard === 'function'
    ? ctx.tools.guard((exec) => {
      const session = exec && exec.agent && exec.agent.session
      const clawGate = clawPermissionsDeny(session)
      if (clawGate && clawGate.reason) {
        logAuthorize(exec, 'deny', CODES.GATE_PERMISSIONS_UNAVAILABLE, clawGate.reason, clawGate.layers)
        auditOnce({
          kind: 'deny',
          tool: exec && exec.name,
          reason: clawGate.reason,
          code: CODES.GATE_PERMISSIONS_UNAVAILABLE,
          ...auditContext(session, clawGate.layers),
        })
        return clawGate.reason
      }
      const reason = denyReason(dshHome, exec)
      if (reason) {
        const layers = clawGate && clawGate.layers != null ? clawGate.layers : layersOfSession(session)
        logAuthorize(exec, 'deny', CODES.GATE_POLICY_DENIED, reason, layers)
        auditOnce({ kind: 'deny', tool: exec && exec.name, reason, ...auditContext(session, layers) })
      }
      return reason
    })
    : function () {}

  // DSH 0.1.6+: agent/session-start removed; agent/created is serial and awaited
  // before the first model request — hide MCP here so the first turn never sees it.
  const stopStart = typeof ctx.on === 'function'
    ? ctx.on('agent/created', (payload) => {
      hideMcpFor(payload && payload.agent)
    })
    : function () {}

  let mcpRefreshTimer = null
  function refreshHiddenMcp() {
    try {
      eachLiveAgent(agentsOf(ctx), function (agent) {
        try {
          hideMcpFor(agent)
        } catch (error) {
          const op = operation({ plugin: 'dsh-claw-gate', feature: 'mcp', operation: 'refresh_mcp' })
          op.start()
          op.fail(CODES.GATE_TOOLS_CHANGE_FAILED, error, { state: 'clean' })
        }
      })
    } catch (error) {
      const op = operation({ plugin: 'dsh-claw-gate', feature: 'mcp', operation: 'refresh_mcp' })
      op.start()
      op.fail(CODES.GATE_TOOLS_CHANGE_FAILED, error, { state: 'clean' })
    }
  }
  const stopToolsChange = typeof ctx.on === 'function'
    ? ctx.on('tools/change', () => {
      if (mcpRefreshTimer != null) return
      mcpRefreshTimer = setTimeout(() => {
        mcpRefreshTimer = null
        refreshHiddenMcp()
      }, MCP_REFRESH_MS)
      if (mcpRefreshTimer && typeof mcpRefreshTimer.unref === 'function') mcpRefreshTimer.unref()
    })
    : function () {}

  const stopPre = typeof ctx.on === 'function'
    ? ctx.on('tools/pre-execute', (exec, next) => runWithTrace(exec, () => {
      const session = exec && exec.agent && exec.agent.session
      const clawGate = clawPermissionsDeny(session)
      if (clawGate && clawGate.reason) {
        logAuthorize(exec, 'deny', CODES.GATE_PERMISSIONS_UNAVAILABLE, clawGate.reason, clawGate.layers)
        auditOnce({
          kind: 'deny',
          tool: exec && exec.name,
          reason: clawGate.reason,
          code: CODES.GATE_PERMISSIONS_UNAVAILABLE,
          ...auditContext(session, clawGate.layers),
        })
        return { kind: 'deny', reason: clawGate.reason }
      }
      const layers = clawGate && clawGate.layers != null
        ? clawGate.layers
        : (session ? layersOfSession(session) : null)
      const reason = denyReason(dshHome, exec)
      if (reason) {
        logAuthorize(exec, 'deny', CODES.GATE_POLICY_DENIED, reason, layers)
        auditOnce({ kind: 'deny', tool: exec && exec.name, reason, ...auditContext(session, layers) })
        return { kind: 'deny', reason }
      }
      if (!layers || !layers.claw) return next()
      const policy = layers.effective
      const header = session && session.header
      const ask = askReason(policy, exec && exec.name, exec && exec.arguments, header && header.cwd)
      if (ask) {
        logAuthorize(exec, 'ask', CODES.GATE_POLICY_ASK, ask, layers)
        audit({ kind: 'ask', tool: exec && exec.name, reason: ask, ...auditContext(session, layers) })
        return { kind: 'ask', reason: ask }
      }
      return next()
    }))
    : function () {}

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/gate/audit',
    handle: async (body) => ({ items: readAudit(dshHome, body && body.limit) }),
  })

  registerJsonRoute(ctx, {
    path: '/api/dsh-claw/gate/audit-export',
    handle: async (body) => {
      const format = body && (body.format === 'md' || body.format === 'markdown') ? 'md' : 'jsonl'
      const text = exportAudit(dshHome, format, body && body.query)
      return {
        format,
        filename: exportFilename(format),
        type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/jsonl;charset=utf-8',
        text,
      }
    },
  })

  ctx.effect(() => () => {
    if (mcpRefreshTimer != null) {
      clearTimeout(mcpRefreshTimer)
      mcpRefreshTimer = null
    }
    if (typeof stopSkills === 'function') stopSkills()
    if (typeof stopGuard === 'function') stopGuard()
    if (typeof stopStart === 'function') stopStart()
    if (typeof stopToolsChange === 'function') stopToolsChange()
    if (typeof stopPre === 'function') stopPre()
  })
}
