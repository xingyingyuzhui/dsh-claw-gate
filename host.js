import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDshHome } from '../dsh-session-permissions/perm-store.mjs'
import { resolveLayersSync } from '../dsh-session-permissions/perm-layers.mjs'
import { denyReason } from '../dsh-session-permissions/perm-layers.mjs'
import { applyOfficialPin, askReason } from '../dsh-session-permissions/perm-official.mjs'
import { exportAudit, exportFilename, readAudit } from './gate-audit.mjs'
import { deniedSkillNames, filterSnapshot } from './gate-skills.mjs'
import { eachLiveAgent, emptyMcpState, hideDeniedMcp } from './gate-mcp.mjs'
import { CODES, operation, policyHash, setObserveHome } from '../dsh-observability/observe.mjs'

export const name = 'dsh-agent-gate'
export const inject = ['tools', 'webServer', 'skills', 'agents']
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

const BODY_CAP = 65536
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

const writeJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readJsonBody = (req, cap = BODY_CAP) => new Promise((resolveBody, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > cap) {
      reject(new Error('body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try {
      resolveBody(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {
      reject(new Error('invalid json body'))
    }
  })
  req.on('error', reject)
})

const guard = (req, res) => {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return false
  }
  const headers = req.headers || {}
  if (headers['x-dsh-agent-gate'] !== '1') {
    writeJson(res, 403, { ok: false, error: 'missing csrf header' })
    return false
  }
  const origin = headers.origin
  if (origin !== undefined && origin !== null && !LOOPBACK_ORIGIN.test(origin)) {
    writeJson(res, 403, { ok: false, error: 'origin not allowed' })
    return false
  }
  return true
}

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

function pinSession(session) {
  const layers = layersOfSession(session)
  if (!layers) return null
  applyOfficialPin(session, layers)
  return layers
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
    const op = operation({ plugin: 'dsh-agent-gate', feature: 'audit', operation: 'write_audit' })
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
    plugin: 'dsh-agent-gate',
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
    if (!layers || !layers.effective) return
    let state = hiddenMcp.get(agent)
    if (!state) {
      state = emptyMcpState()
      hiddenMcp.set(agent, state)
    }
    hideDeniedMcp(agent, layers.effective, state)
  }

  const stopGuard = ctx.tools && typeof ctx.tools.guard === 'function'
    ? ctx.tools.guard((exec) => {
      const reason = denyReason(dshHome, exec)
      if (reason) {
        const session = exec && exec.agent && exec.agent.session
        const layers = layersOfSession(session)
        logAuthorize(exec, 'deny', CODES.GATE_POLICY_DENIED, reason, layers)
        auditOnce({ kind: 'deny', tool: exec && exec.name, reason, ...auditContext(session, layers) })
      }
      return reason
    })
    : function () {}

  const stopStart = typeof ctx.on === 'function'
    ? ctx.on('agent/session-start', (payload) => {
      const session = payload && payload.agent && payload.agent.session
      const plan = pinSession(session)
      if (plan && plan.claw) {
        audit({ kind: 'pin', ...auditContext(session, plan) })
      }
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
          const op = operation({ plugin: 'dsh-agent-gate', feature: 'mcp', operation: 'refresh_mcp' })
          op.start()
          op.fail(CODES.GATE_TOOLS_CHANGE_FAILED, error, { state: 'clean' })
        }
      })
    } catch (error) {
      const op = operation({ plugin: 'dsh-agent-gate', feature: 'mcp', operation: 'refresh_mcp' })
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
    ? ctx.on('tools/pre-execute', (exec, next) => {
      const session = exec && exec.agent && exec.agent.session
      const layers = pinSession(session) || (session ? layersOfSession(session) : null)
      const reason = denyReason(dshHome, exec)
      if (reason) {
        logAuthorize(exec, 'deny', CODES.GATE_POLICY_DENIED, reason, layers)
        auditOnce({ kind: 'deny', tool: exec && exec.name, reason, ...auditContext(session, layers) })
        return { kind: 'deny', reason }
      }
      const policy = layers && layers.effective
      const header = session && session.header
      const ask = askReason(policy, exec && exec.name, exec && exec.arguments, header && header.cwd)
      if (ask) {
        logAuthorize(exec, 'ask', CODES.GATE_POLICY_ASK, ask, layers)
        audit({ kind: 'ask', tool: exec && exec.name, reason: ask, ...auditContext(session, layers) })
        return { kind: 'ask', reason: ask }
      }
      return next()
    })
    : function () {}

  const handle = (fn) => async (req, res) => {
    if (!guard(req, res)) return
    try {
      const body = await readJsonBody(req)
      await fn(req, res, body)
    } catch (err) {
      writeJson(res, 400, { ok: false, error: String(err.message || err) })
    }
  }

  const stopAudit = ctx.webServer && typeof ctx.webServer.register === 'function'
    ? ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-gate/audit',
      handler: handle(async (_req, res, body) => {
        writeJson(res, 200, { ok: true, items: readAudit(dshHome, body && body.limit) })
      }),
    })
    : function () {}

  const stopExport = ctx.webServer && typeof ctx.webServer.register === 'function'
    ? ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-agent-gate/audit-export',
      handler: handle(async (_req, res, body) => {
        const format = body && (body.format === 'md' || body.format === 'markdown') ? 'md' : 'jsonl'
        const text = exportAudit(dshHome, format, body && body.query)
        writeJson(res, 200, {
          ok: true,
          format,
          filename: exportFilename(format),
          type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/jsonl;charset=utf-8',
          text,
        })
      }),
    })
    : function () {}

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
    if (typeof stopAudit === 'function') stopAudit()
    if (typeof stopExport === 'function') stopExport()
  })
}
