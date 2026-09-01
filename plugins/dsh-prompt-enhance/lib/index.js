/**
 * @dsh-external/dsh-prompt-enhance
 *
 * Prompt enhance (WorkBuddy #1 / 方案书 v3).
 * Registers `prompt_enhance` as an agent-callable tool — the agent auto-decides
 * when a user request is vague / underspecified / needs a precise restatement
 * and calls this tool to rewrite it into a better prompt.
 *
 * DeepSeek API key read from ~/.dsh/.credentials.yaml.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = '@dsh-external/dsh-prompt-enhance'
export const inject = ['tools']

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

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'prompt_enhance',
    description: '把含糊/缺约束的提示词改写为更精确、更详细、结构清晰的版本（调用 DeepSeek）。当用户请求含糊不清、缺少关键约束、需要把模糊需求重述为可执行任务、或要委派子代理/拆解复杂任务时调用；请求已清晰时不要调用。',
    parameters: {
      text: { type: 'string', description: '要增强的原始提示词/用户请求文本' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args) {
      const text = String(args?.text || '').trim()
      if (!text) return '错误：请提供要增强的文本'
      if (text.length > 10000) return '错误：文本过长（最多10000字符）'
      const apiKey = readApiKey()
      if (!apiKey) return '错误：未找到 DEEPSEEK_API_KEY（~/.dsh/.credentials.yaml）'
      try {
        return await enhanceText(text, apiKey)
      } catch (e) {
        safeLog(`enhance failed: ${String(e)}`)
        return `错误：增强失败：${String(e?.message || e)}`
      }
    },
  })), 'dsh-prompt-enhance: prompt_enhance tool')

  safeLog('active: prompt_enhance tool registered')
  return () => {
    try { safeLog('disposed') } catch { /* ignore */ }
  }
}
