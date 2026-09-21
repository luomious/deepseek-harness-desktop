#!/usr/bin/env node
// 逐条验证「候选替换模型」是否真的可用（串行，避免自造限流）。
// 用法: node probe-candidates.mjs [--out <dir>]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probe, parseSettings, parseCreds, PATHS } from './probe-models.mjs'

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const OUT_DIR = arg('out', '.')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// provider / 候选 model / 用途说明
const SPEC = [
  // tokenrouter：配置里的 z-ai/glm-5.3-free 已下线，试替代 slug
  ['tokenrouter', 'z-ai/glm-5.3', '替代 z-ai/glm-5.3-free'],
  ['tokenrouter', 'z-ai/glm-5.3-fast', '替代候选'],
  ['tokenrouter', 'z-ai/glm-5.2', '替代候选'],
  ['tokenrouter', 'deepseek/deepseek-v4-flash', '替代候选'],
  // amd：DeepSeek-V4-Flash 上游 503，试同厂其他模型
  ['amd', 'DeepSeek-V4.1-Flash', '替代 amd/DeepSeek-V4-Flash'],
  ['amd', 'GLM-5.3-Flash', '替代候选'],
  ['amd', 'Qwen3.8-27B', '替代候选'],
  ['amd', 'DeepSeek-V4-Flash-Vision-Exp', '替代候选'],
  // openrouter：stealth/union-alpha 已下线，试其他 free 模型
  ['openrouter', 'qwen/qwen3.8-27b:free', '替代 stealth/union-alpha'],
  ['openrouter', 'deepseek/deepseek-v4-flash-0731:free', '替代候选'],
  ['openrouter', 'z-ai/glm-5.2:free', '替代候选'],
  ['openrouter', 'dots-studio/dots-3-note-preview:free', '替代候选'],
  ['openrouter', 'thinkingmachines/inkling:free', '替代候选'],
  // justdowork：/models 里根本没有配置的 claude-opus-5，试站内真实 slug
  ['justdowork', 'claude-opus-4-8', '站内真实 slug'],
  ['justdowork', 'replay-aigateway/claude-opus-4.8', '站内真实 slug'],
  // zhipu：/models 里的付费模型（看能不能用）
  ['zhipu-ai', 'glm-5.3-flash', '新增候选'],
  ['zhipu-ai', 'glm-4.7', '新增候选'],
  // modelscope：判断是账号级欠费还是单模型问题
  ['modelscope', 'Qwen/Qwen3.8-27B', '判断是否账号级欠费'],
  ['modelscope', 'stepfun-ai/Step-3.7-Flash', '判断是否账号级欠费'],
]

const providers = parseSettings(readFileSync(PATHS.SETTINGS, 'utf8'))
const creds = parseCreds(readFileSync(PATHS.CREDS, 'utf8'))

const results = []
for (const [pid, mid, note] of SPEC) {
  const p = providers[pid]
  if (!p) { console.log(`SKIP  ${pid} (未找到 provider 配置)`); continue }
  const r = await probe(p, { id: mid }, creds[p.apiKeyEnv] || '')
  results.push({ provider: pid, model: mid, note, ...r })
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${pid}/${mid}  ${r.ok ? r.latencyMs + 'ms' : (r.kind || '') + ' ' + String(r.error || '').replace(/\s+/g, ' ').slice(0, 130)}`)
  await sleep(2500)
}

const { writeFileSync } = await import('node:fs')
writeFileSync(join(OUT_DIR, 'candidates.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8')
const ok = results.filter((r) => r.ok)
console.log(`\n=== 候选可用 ${ok.length}/${results.length} ===`)
console.log('可用:', ok.map((r) => r.provider + '/' + r.model).join(', '))
