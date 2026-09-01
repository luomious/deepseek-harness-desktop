/**
 * @dsh-external/dsh-prompt-enhance
 *
 * Prompt enhance (WorkBuddy #1 / 方案书 v3).
 * Host-side: POST /prompt-enhance/run → DeepSeek API → enhanced text.
 * Uses host-services registerLocalApi (default POST + JSON body + Origin validation).
 * Reads API key from ~/.dsh/.credentials.yaml.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'

export const name = '@dsh-external/dsh-prompt-enhance'
export const inject = ['hostServices']

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

  const hs = ctx.hostServices
  if (!hs || typeof hs.registerLocalApi !== 'function') {
    try { ctx.logger?.warn?.('[prompt-enhance] host-services 未加载，跳过 API 注册') } catch { /* ignore */ }
    return
  }

  hs.registerLocalApi(ctx, {
    path: '/prompt-enhance/run',
    handler: async (_req, _res, body) => {
      const text = String(body?.text || '').trim()
      if (!text) return { ok: false, error: '请提供要增强的文本' }
      if (text.length > 10000) return { ok: false, error: '文本过长（最多10000字符）' }
      const apiKey = readApiKey()
      if (!apiKey) return { ok: false, error: '未找到 DEEPSEEK_API_KEY（~/.dsh/.credentials.yaml）' }
      const enhanced = await enhanceText(text, apiKey)
      return { ok: true, enhanced, original: text }
    },
  })

  safeLog('active: /prompt-enhance/run registered via host-services')
  return () => {
    try { safeLog('disposed') } catch { /* ignore */ }
  }
}
