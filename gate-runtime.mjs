import { COPY, interpolate, NS, tWith } from './gate-i18n.mjs'
import { ATTR, CSS } from './gate-styles.mjs'
import { createAuditPage, registerSettings } from './gate-page.mjs'

export function applyClient(ctx) {
  const React = require('react')
  const slots = ctx.get('slots')
  if (slots == null || React == null) return

  const doc = typeof document === 'undefined' ? null : document
  let styleTag = null
  if (doc && doc.head) {
    styleTag = doc.createElement('style')
    styleTag.setAttribute(ATTR, '')
    styleTag.textContent = CSS
    doc.head.appendChild(styleTag)
    doc.body.setAttribute(ATTR, '')
  }

  let localeDispose = function () {}
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      localeDispose = ctx.locale.register(NS, COPY) || function () {}
    }
  } catch { /* remount */ }

  function t(key, params) {
    return interpolate(tWith(ctx, key, params), params)
  }

  function subscribeLocale(fn) {
    if (ctx.locale && typeof ctx.locale.subscribe === 'function') {
      return ctx.locale.subscribe(fn) || function () {}
    }
    return function () {}
  }

  function post(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }).then((res) => res.json().then((data) => {
      if (!res.ok && (!data || data.ok !== true)) throw new Error((data && data.error) || ('http ' + res.status))
      return data
    }))
  }

  function toast(message) {
    if (!doc) return
    const existing = doc.querySelector('.dag-toast')
    if (existing) existing.remove()
    const el = document.createElement('div')
    el.className = 'dag-toast'
    el.textContent = message
    doc.body.appendChild(el)
    setTimeout(() => { if (el.parentNode) el.remove() }, 1800)
  }

  let ReactDOM = null
  try { ReactDOM = require('react-dom') } catch { /* optional */ }
  const Page = createAuditPage(React, t, post, toast, subscribeLocale, ReactDOM)
  const stopSettings = registerSettings(ctx, React, t, Page)

  ctx.effect(() => {
    return function () {
      localeDispose()
      if (typeof stopSettings === 'function') stopSettings()
      if (styleTag != null) styleTag.remove()
      if (doc) doc.body.removeAttribute(ATTR)
    }
  })
}
