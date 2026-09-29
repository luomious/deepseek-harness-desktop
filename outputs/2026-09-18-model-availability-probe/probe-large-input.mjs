#!/usr/bin/env node
// 测 modelscope 内容审核是否与「输入长度」相关：发一段完全无害但很长的填充文本。
// 用法: node probe-large-input.mjs <repeatCount>
import { readFileSync, existsSync } from 'node:fs'
import { parseSettings, parseCreds, PATHS } from './probe-models.mjs'

const n = Number(process.argv[2] || 400)
const provs = parseSettings(readFileSync(PATHS.SETTINGS, 'utf8'))
const creds = existsSync(PATHS.CREDS) ? parseCreds(readFileSync(PATHS.CREDS, 'utf8')) : {}
const p = provs.modelscope
const key = creds[p.apiKeyEnv]

// 完全无害的中性填充（技术手册体）
const unit = 'This section describes the calibration procedure for the optical inspection station. The operator shall verify the lens focus, confirm the lighting intensity, and record the measured values in the maintenance log before production begins. '
const filler = unit.repeat(n)
const payload = {
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  messages: [{ role: 'user', content: filler + '\n\nReply with the single word: OK' }],
  max_tokens: 16,
  stream: false,
}
const approxTokens = Math.round(payload.messages[0].content.length / 4)
console.log(`repeat=${n} chars=${payload.messages[0].content.length} approxTokens~${approxTokens}`)

const t0 = Date.now()
const res = await fetch('https://api-inference.modelscope.cn/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(payload),
})
const text = await res.text()
console.log(`HTTP ${res.status}  ${Date.now() - t0}ms`)
console.log(text.slice(0, 600))
