#!/usr/bin/env node
// 巡检：找出「当前模型停在已消失的 modlens 双胞胎上」的会话。
//
// 背景（2026-09-23 事故，详见 outputs/2026-09-23-report-vision-modality-misjudgment/ROUND3-stale-twin-rootcause.md）：
// 某个上游模型一旦在 ~/.dsh/settings.yaml 里自行声明 image（`input: [text, image]`），
// modlens 的 shouldWrap 就不再包装它，目录里 modlens-<up> 组的该条目随之消失
// （@liustack/modlens/dsh/index.js:585）。此时**已存在的会话**若仍把「当前模型」
// 记在那个已消失的 modlens 渠道上，modlens 会在 resolveModel 阶段直接拒绝，前端报：
//   model "<m>" declares native image input, so its "(modlens vision)" entry no longer applies.
//
// 自动自愈在客户端插件 dsh-model-picker-group（healStaleTwin，2026-09-23 加）里：
// 每次会话目录刷新都会把这类会话切回上游渠道。本脚本是**离线巡检/兜底**，
// 用于：① 换机器/换 profile 后批量核查；② GUI 未打开时（看门狗续跑的目标会话）
// 人工排障；③ 声明新模型前后做回归。
//
// 用法：
//   node scripts/check-stale-modlens-twins.mjs            # 只读巡检（默认）
//   node scripts/check-stale-modlens-twins.mjs --fix      # 顺手切回上游（运行时生效，重启后由客户端自愈接管）
//   node scripts/check-stale-modlens-twins.mjs --json     # 机器可读输出
//
// 退出码：0 = 无问题；1 = 发现问题（--fix 后仍为 0/1 反映剩余量）；2 = 无法连到宿主。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HOST = process.env.DSH_HOST || 'http://127.0.0.1:43120'
const args = new Set(process.argv.slice(2))
const FIX = args.has('--fix')
const JSONOUT = args.has('--json')

let yaml
for (const c of [
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml'),
  join(process.cwd(), 'node_modules', 'js-yaml'),
]) {
  try { yaml = require(join(c, 'index.js')); break } catch { /* 继续找 */ }
}
if (!yaml) {
  console.error('找不到 js-yaml（试过 profile 与工作区 node_modules）')
  process.exit(2)
}

// 读 settings.yaml：判定「上游是否已声明 image」——这是双胞胎是否还存在的地面事实
function readImageDeclarations() {
  const doc = yaml.load(readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8'))
  const providers = doc?.['llm-pi-ai']?.providers ?? {}
  return function declaresImage(providerId, model) {
    const p = providers[providerId]
    if (!p) return false
    const m = (p.models ?? []).find((x) => x.id === model)
    return Boolean(m && Array.isArray(m.input) && m.input.includes('image'))
  }
}

let rpcSeq = 0
async function rpc(method, payload) {
  const res = await fetch(`${HOST}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOST },
    body: JSON.stringify({ type: 'client-request', rpcId: `rpc-stale-${++rpcSeq}`, method, payload }),
    signal: AbortSignal.timeout(30000),
  })
  return (await res.json()).result
}

function toUpstream(providerId) {
  if (providerId === 'deepseek-modlens') return 'deepseek-official'
  if (typeof providerId === 'string' && providerId.startsWith('modlens-')) return providerId.slice('modlens-'.length)
  return null
}

const declaresImage = readImageDeclarations()

let list
try {
  list = await rpc('session.list', {})
} catch (e) {
  console.error(`无法连到宿主 ${HOST}：${e.message}`)
  process.exit(2)
}
if (!list?.ok) {
  console.error('session.list 失败：' + JSON.stringify(list?.error ?? list))
  process.exit(2)
}

const items = list.value?.items ?? []
const stale = []
let checked = 0
let skipped = 0
const CONC = 8

for (let i = 0; i < items.length; i += CONC) {
  await Promise.all(items.slice(i, i + CONC).map(async (s) => {
    if (s.blank) { skipped++; return }
    const r = await rpc('session.models', { sessionId: s.sessionId }).catch(() => null)
    checked++
    const cur = r?.ok ? r.value?.current : null
    if (!cur?.provider || !cur?.model) return
    const up = toUpstream(cur.provider)
    if (!up) return
    if (!declaresImage(up, cur.model)) return // 双胞胎仍应存在 → 正常
    stale.push({ sessionId: s.sessionId, provider: cur.provider, model: cur.model, upstream: up, running: Boolean(s.running), updatedAt: s.updatedAt })
  }))
}

if (JSONOUT) {
  console.log(JSON.stringify({ host: HOST, total: items.length, checked, skippedBlank: skipped, stale }, null, 2))
} else {
  console.log(`宿主 ${HOST}`)
  console.log(`会话总数 ${items.length}｜已查 ${checked}｜跳过 blank ${skipped}`)
  console.log(`停在「已消失 modlens 双胞胎」上的会话 = ${stale.length}`)
  for (const s of stale) {
    console.log(`  ${s.sessionId}  ${s.provider}/${s.model}  -> 应切到 ${s.upstream}/${s.model}` +
      `  running=${s.running}  updated=${s.updatedAt ? new Date(s.updatedAt).toISOString() : '?'}`)
  }
  if (stale.length) {
    console.log('\n提示：客户端插件 dsh-model-picker-group 的 healStaleTwin 会在会话目录刷新时自动切回上游；')
    console.log('      若需立刻生效（GUI 未打开 / 想在刷新前就用），加 --fix。')
  }
}

if (FIX && stale.length) {
  console.log('\n=== 执行切换（运行时生效；重启后由客户端自愈接管）===')
  let ok = 0
  for (const s of stale) {
    const r = await rpc('session.selectModel', { sessionId: s.sessionId, provider: s.upstream, model: s.model, reasoningEffort: 'high' })
    const back = await rpc('session.models', { sessionId: s.sessionId })
    const now = back?.value?.current
    const good = Boolean(r?.ok && now?.provider === s.upstream && now?.model === s.model)
    if (good) ok++
    console.log(`  ${s.sessionId}  selectModel.ok=${r?.ok}  回读=${now?.provider}/${now?.model}  ${good ? 'OK' : '未生效'}`)
  }
  console.log(`\n切换成功 ${ok}/${stale.length}`)
}

process.exit(stale.length ? 1 : 0)