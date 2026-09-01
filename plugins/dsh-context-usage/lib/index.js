/**
 * @dsh-external/dsh-context-usage
 *
 * Context usage indicator (WorkBuddy #6 / 方案书 v3).
 * Host-side: reads model config for context window, exposes /context-usage/status.
 * Design rules identical to dsh-tool-visibility / dsh-command-guard.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'

export const name = '@dsh-external/dsh-context-usage'
export const inject = ['tokenMeter']

const CONTEXT_WINDOW_MAP = {
  'deepseek-chat': 65536,
  'deepseek-coder': 32768,
  'deepseek-reasoner': 65536,
  'deepseek-v3': 65536,
  'deepseek-r1': 65536,
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-3.5-sonnet': 200000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,
}

function parseContextWindow(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number' && raw > 0) return raw
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase()
    if (s.endsWith('K')) {
      const n = parseFloat(s.slice(0, -1))
      return isNaN(n) ? null : Math.round(n * 1024)
    }
    if (s.endsWith('M')) {
      const n = parseFloat(s.slice(0, -1))
      return isNaN(n) ? null : Math.round(n * 1024 * 1024)
    }
    const n = parseInt(s, 10)
    return isNaN(n) ? null : n
  }
  return null
}

function readModelConfig() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const cfgPath = join(home, '.dsh', 'config', 'desktop.json')
    const raw = readFileSync(cfgPath, 'utf8')
    const cfg = JSON.parse(raw)
    return { models: cfg.models || [], activeModel: cfg.activeModel || null }
  } catch {
    return { models: [], activeModel: null }
  }
}

export function apply(ctx) {
  const safeLog = (msg) => {
    try { console.log(`[context-usage] ${msg}`) } catch { /* ignore */ }
  }
  const safeWarn = (msg) => {
    try { console.warn(`[context-usage] ${msg}`) } catch { /* ignore */ }
  }

  let routeRegistered = false
  let routeAttempts = 0

  const json = (res, status, payload) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch { /* ignore */ }
  }

  const registerRoute = () => {
    if (routeRegistered) return true
    let webServer = null
    try {
      webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null
    } catch { webServer = null }
    if (!webServer?.register) return false
    try {
      webServer.register({
        kind: 'prefix',
        path: '/context-usage/status',
        handler: (req, res) => {
          try {
            const { models, activeModel } = readModelConfig()
            const modelName = activeModel || models[0]?.name || null
            const model = models.find((m) => m.name === modelName)
            const contextWindow = parseContextWindow(model?.contextWindow)
              || (modelName ? CONTEXT_WINDOW_MAP[modelName] : null)
              || 65536

            let surfaceTokens = 0
            let pressureTokens = 0
            try {
              const meter = ctx.get('tokenMeter')
              if (meter && typeof meter.measure === 'function') {
                const state = ctx.get('session')
                if (state) {
                  const m = meter.measure(state)
                  surfaceTokens = m.surfaceTokens || 0
                  pressureTokens = (m.baseline?.tokens || 0)
                }
              }
            } catch { /* fallback to 0 */ }

            const percentage = contextWindow > 0
              ? Math.min(100, Math.round((surfaceTokens / contextWindow) * 100))
              : 0

            json(res, 200, {
              ok: true,
              modelName: modelName || 'unknown',
              contextWindow,
              surfaceTokens,
              pressureTokens,
              percentage
            })
          } catch (e) {
            json(res, 200, { ok: false, error: String(e) })
          }
        },
      })
      routeRegistered = true
      safeLog(`route registered: /context-usage/status`)
      return true
    } catch (e) {
      safeWarn(`route register failed: ${String(e)}`)
      return false
    }
  }

  if (!registerRoute()) {
    const retry = () => {
      if (routeRegistered) return
      if (registerRoute()) return
      routeAttempts += 1
      if (routeAttempts >= 20) { safeWarn('route unavailable after retries'); return }
      const delay = Math.min(2000 * 2 ** Math.min(routeAttempts, 4), 30000)
      try { ctx.setTimeout(retry, delay) } catch { /* tolerate */ }
    }
    try { ctx.setTimeout(retry, 2000) } catch { /* tolerate */ }
  }

  safeLog('active')
  return () => {
    try { safeLog('disposed') } catch { /* ignore */ }
  }
}
