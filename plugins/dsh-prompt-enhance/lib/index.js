/**
 * @dsh-external/dsh-prompt-enhance
 *
 * Prompt enhance (WorkBuddy #1 / 方案书 v3).
 * Host-side: POST /prompt-enhance/run → DeepSeek API → enhanced text.
 * Reads API key from ~/.dsh/.credentials.yaml.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'

export const name = '@dsh-external/dsh-prompt-enhance'
export const inject = ['tokenMeter']

const ENHANCE_SYSTEM = `你是提示词优化助手。把用户的输入改写为更精确、更详细的提示词，保留用户意图。只输出优化后的提示词，不要解释。如果输入已经足够好，可以微调格式和细节，不要改变意图。`

function resolveDshHome() {
  return process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
}

function readApiKey() {
  try {
    const credPath = join(resolveDshHome(), '.credentials.yaml')
    const text = readFileSync(credPath, 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*DEEPSEEK_API_KEY:\s*(.+)\s*$/.exec(line)
      if (m && m[1].trim()) return m[1].trim()
    }
  } catch { /* ignore */ }
  return process.env.DEEPSEEK_API_KEY || null
}

async function enhanceText(text, apiKey) {
  const body = JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: ENHANCE_SYSTEM },
      { role: 'user', content: text }
    ],
    max_tokens: 2048,
    temperature: 0.3
  })

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`
      },
      body,
      signal: ctrl.signal
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new Error(`DeepSeek API ${res.status}: ${err.slice(0, 200)}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('DeepSeek API 返回空内容')
    return content.trim()
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  const safeLog = (msg) => {
    try { console.log(`[prompt-enhance] ${msg}`) } catch { /* ignore */ }
  }
  const safeWarn = (msg) => {
    try { console.warn(`[prompt-enhance] ${msg}`) } catch { /* ignore */ }
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
        path: '/prompt-enhance/run',
        handler: async (req, res) => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const text = String(body?.text || '').trim()
            if (!text) { json(res, 400, { ok: false, error: '请提供要增强的文本' }); return }
            if (text.length > 10000) { json(res, 400, { ok: false, error: '文本过长（最多10000字符）' }); return }

            const apiKey = readApiKey()
            if (!apiKey) { json(res, 500, { ok: false, error: '未找到 DEEPSEEK_API_KEY（~/.dsh/.credentials.yaml）' }); return }

            const enhanced = await enhanceText(text, apiKey)
            json(res, 200, { ok: true, enhanced, original: text })
          } catch (e) {
            safeWarn(`enhance failed: ${String(e)}`)
            json(res, 500, { ok: false, error: String(e?.message || e) })
          }
        },
      })
      routeRegistered = true
      safeLog('route registered: /prompt-enhance/run')
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
