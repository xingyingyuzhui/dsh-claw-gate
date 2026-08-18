export const NS = 'dsh-agent-gate'

export const COPY = {
  zh: {
    nav: '审计',
    empty: '还没有记录',
    refresh: '刷新',
    exportJson: '导出 JSONL',
    exportMd: '导出 Markdown',
    exported: '已导出',
    fail: '读取失败',
    kindDeny: '拒绝',
    kindAsk: '询问',
    kindPin: '钉沙箱',
    kindAll: '全部结果',
    tool: '工具',
    toolAll: '全部类型',
    session: '会话',
    filterTime: '时间',
    filterKind: '结果',
    filterTool: '类型',
    filterAgent: 'Agent',
    rangeToday: '今天',
    rangeYesterday: '昨天',
    rangeWeek: '近 7 天',
    rangeMonth: '近 30 天',
    rangeAll: '全部时间',
    agentAll: '全部 Agent',
    officialAgent: '官方会话',
    clawAgent: 'Claw',
    emptyFilter: '没有符合筛选的记录',
    count: '{shown} / {total} 条',
  },
  en: {
    nav: 'Audit',
    empty: 'No records yet',
    refresh: 'Refresh',
    exportJson: 'Export JSONL',
    exportMd: 'Export Markdown',
    exported: 'Exported',
    fail: 'Could not read the log',
    kindDeny: 'Deny',
    kindAsk: 'Ask',
    kindPin: 'Pin',
    kindAll: 'All results',
    tool: 'Tool',
    toolAll: 'All types',
    session: 'Session',
    filterTime: 'Time',
    filterKind: 'Result',
    filterTool: 'Type',
    filterAgent: 'Agent',
    rangeToday: 'Today',
    rangeYesterday: 'Yesterday',
    rangeWeek: 'Last 7 days',
    rangeMonth: 'Last 30 days',
    rangeAll: 'All time',
    agentAll: 'All agents',
    officialAgent: 'Official session',
    clawAgent: 'Claw',
    emptyFilter: 'No records match these filters',
    count: '{shown} / {total}',
  },
}

export function interpolate(template, params) {
  if (params == null) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}

export function activeLocaleId(ctx) {
  try {
    const locale = ctx && ctx.locale
    const snap = locale && (locale.getLocale ? locale.getLocale() : locale.getSnapshot && locale.getSnapshot())
    if (snap && typeof snap.active === 'string' && snap.active) return snap.active
  } catch { /* inject miss */ }
  const tag = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'zh'
  return tag
}

export function isZh(ctx) {
  return String(activeLocaleId(ctx)).toLowerCase().indexOf('zh') === 0
}

export function translate(lang, key, params) {
  const table = COPY[lang] || COPY.en
  return interpolate(table[key] ?? COPY.en[key] ?? key, params)
}

export function tWith(ctx, key, params) {
  try {
    const locale = ctx && ctx.locale
    if (locale && typeof locale.bind === 'function') {
      const translated = locale.bind(NS)(key, params)
      if (translated && translated !== key) return interpolate(translated, params)
    }
  } catch { /* fall through */ }
  return translate(isZh(ctx) ? 'zh' : 'en', key, params)
}
