import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultDshHome } from '../dsh-session-permissions/perm-store.mjs'
import { resolveLayersSync } from '../dsh-session-permissions/perm-layers.mjs'
import { denyReason } from '../dsh-session-permissions/perm-layers.mjs'
import { applyOfficialPin, askReason } from '../dsh-session-permissions/perm-official.mjs'
import { exportAudit, exportFilename, readAudit } from './gate-audit.mjs'
import { deniedSkillNames, filterSnapshot } from './gate-skills.mjs'

export const name = 'dsh-agent-gate'
export const inject = ['tools', 'webServer', 'skills']

let dshHome = defaultDshHome()

const _internal = {
  setDshHome(dir) { dshHome = dir },
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
  } catch { /* best-effort */ }
}

export function wrapSkills(skills, home) {
  if (skills == null || typeof skills.snapshot !== 'function') return function () {}
  const origSnapshot = skills.snapshot.bind(skills)
  const origGet = typeof skills.get === 'function' ? skills.get.bind(skills) : null
  skills.snapshot = async function (options) {
    const snap = await origSnapshot(options)
    return filterSnapshot(snap, deniedSkillNames(home, options))
  }
  if (origGet) {
    skills.get = async function (name, options) {
      if (deniedSkillNames(home, options).indexOf(name) >= 0) return undefined
      return origGet(name, options)
    }
  }
  return function () {
    skills.snapshot = origSnapshot
    if (origGet) skills.get = origGet
  }
}

export function apply(ctx) {
  const stopSkills = wrapSkills(ctx.skills, dshHome)

  const stopGuard = ctx.tools && typeof ctx.tools.guard === 'function'
    ? ctx.tools.guard((exec) => {
      const reason = denyReason(dshHome, exec)
      if (reason) {
        const session = exec && exec.agent && exec.agent.session
        audit({ kind: 'deny', tool: exec && exec.name, reason, ...auditContext(session, layersOfSession(session)) })
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
    })
    : function () {}

  const stopPre = typeof ctx.on === 'function'
    ? ctx.on('tools/pre-execute', (exec, next) => {
      const session = exec && exec.agent && exec.agent.session
      const layers = pinSession(session) || (session ? layersOfSession(session) : null)
      const reason = denyReason(dshHome, exec)
      if (reason) {
        audit({ kind: 'deny', tool: exec && exec.name, reason, ...auditContext(session, layers) })
        return { kind: 'deny', reason }
      }
      const policy = layers && layers.effective
      const header = session && session.header
      const ask = askReason(policy, exec && exec.name, exec && exec.arguments, header && header.cwd)
      if (ask) {
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
    if (typeof stopSkills === 'function') stopSkills()
    if (typeof stopGuard === 'function') stopGuard()
    if (typeof stopStart === 'function') stopStart()
    if (typeof stopPre === 'function') stopPre()
    if (typeof stopAudit === 'function') stopAudit()
    if (typeof stopExport === 'function') stopExport()
  })
}
