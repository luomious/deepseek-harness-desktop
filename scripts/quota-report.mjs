#!/usr/bin/env node
// scripts/quota-report.mjs — 按 provider/模型 统计「加权 token」用量与剩余额度（零依赖、只读、按需运行）
//
// 为什么存在：apinex 这类网关的免费额度**没有公开 API**（只有登录页显示 used/limit），
// 而 402 `billing_error` 会在跑到一半时突然掐断整轮（2026-09-15 事故）。本脚本把
// 「今天还能跑多少」变成一条命令，不新增任何常驻进程/插件（用户的锚点：不给项目增加繁重占用）。
//
// 计量规则（apinex 实测，2026-09-15）：
//   计费 = ceil((input + output) × weight)；放行判断用最坏情况 weight × (输入 + max_tokens)。
//   实测权重：free/gpt-5.6-luna、free/glm-5.3-flash、free/gemini-3.8-flash = 3.24；
//   free/deepseek-v4.1-flash、free/qwen-3.8-max、free/deepseek-v4-* = 2.16；
//   free/mimo-v2.5、free/muse-spark-1.3 **不计入额度**。
//
// 数据来源：~/.dsh/sessions/**/session.jsonl.zstd（**多帧 zstd**：整文件单次解压只得首帧，
// 必须按魔数 0x28B52FFD 分帧解压——这是 2026-09-15 踩过的坑）。
//
// 用法：
//   node scripts/quota-report.mjs                 # 今天（UTC）
//   node scripts/quota-report.mjs --days 3        # 最近 3 天
//   node scripts/quota-report.mjs --provider apinex --json
// 配置（可选，首次运行会提示默认值）：~/.dsh/quota-limits.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSION_ROOT = path.join(DSH_HOME, 'sessions')
const CONFIG_PATH = path.join(DSH_HOME, 'quota-limits.json')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 内置默认（可用 ~/.dsh/quota-limits.json 覆盖/扩展）。 */
export const DEFAULT_LIMITS = {
  providers: {
    apinex: {
      dailyWeighted: 1_000_000,
      resetUtcHour: 0,
      defaultWeight: 0, // 未列出的模型按 0 计（apinex 的 mimo/muse 实测不计额度）
      weights: {
        'free/gpt-5.6-luna': 3.24,
        'free/glm-5.3-flash': 3.24,
        'free/gemini-3.8-flash': 3.24,
        'free/deepseek-v4.1-flash': 2.16,
        'free/qwen-3.8-max': 2.16,
        'free/deepseek-v4-flash-0731': 2.16,
        'free/deepseek-v4-pro-0813': 2.16,
        'free/gemini-3.1-pro': 2.16,
        'free/mimo-v2.5': 0,
        'free/muse-spark-1.3': 0,
      },
      note: 'apinex 免费模型日额度（登录页 used/limit 实测 1M/天，00:00 UTC 重置）',
    },
  },
}

/** 多帧 zstd 解压（整文件单次解压只得首帧；见文件头说明）。 */
export function readSessionText(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { offsets.push(i); i += 4 }
  const chunks = []
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end))) } catch { /* 跳过坏帧 */ }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function walkSessions(dir, out = [], sinceMs = 0) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walkSessions(p, out, sinceMs); continue }
    if (!e.name.endsWith('.zstd')) continue
    // 性能：多帧 zstd 解压成本高，按 mtime 跳过与统计窗口无关的历史文件
    if (sinceMs > 0) { try { if (fs.statSync(p).mtimeMs < sinceMs) continue } catch { continue } }
    out.push(p)
  }
  return out
}

/** provider 归一化：`modlens-apinex` → `apinex`（modlens 包装层前缀）。 */
export function normalizeProvider(provider) {
  const raw = String(provider || '')
  return raw.startsWith('modlens-') ? raw.slice('modlens-'.length) : raw
}

/** 权重查表：先精确匹配 model，再匹配 provider 级默认。 */
export function weightFor(limits, provider, model) {
  const p = limits.providers?.[normalizeProvider(provider)]
  if (!p) return 0
  if (p.weights && Object.prototype.hasOwnProperty.call(p.weights, model)) return Number(p.weights[model]) || 0
  return Number(p.defaultWeight) || 0
}

/** UTC 日键。 */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 纯函数：把会话事件折叠成「按 provider/模型/UTC 天」的加权用量。
 * @param entries 形如 {time, provider, model, inputTokens, outputTokens, billingError} 的扁平记录
 */
export function foldUsage(entries, limits) {
  const byDay = new Map()
  for (const e of entries) {
    if (!e || !e.provider) continue
    const day = utcDay(e.time)
    if (!byDay.has(day)) byDay.set(day, { day, providers: new Map(), billingErrors: 0 })
    const bucket = byDay.get(day)
    const prov = normalizeProvider(e.provider)
    if (!bucket.providers.has(prov)) bucket.providers.set(prov, { provider: prov, weighted: 0, tokens: 0, calls: 0, models: new Map() })
    const slot = bucket.providers.get(prov)
    const inTok = Number(e.inputTokens) || 0
    const outTok = Number(e.outputTokens) || 0
    const w = weightFor(limits, e.provider, e.model)
    const weighted = Math.ceil((inTok + outTok) * w)
    slot.weighted += weighted
    slot.tokens += inTok + outTok
    slot.calls += 1
    const m = slot.models.get(e.model) || { model: e.model, weighted: 0, tokens: 0, calls: 0, weight: w }
    m.weighted += weighted; m.tokens += inTok + outTok; m.calls += 1
    slot.models.set(e.model, m)
    if (e.billingError) bucket.billingErrors += 1
  }
  return byDay
}

/** 从会话日志提取扁平记录（只读；容错解析）。 */
export function collectEntries(sessionRoot = SESSION_ROOT, sinceMs = 0) {
  const entries = []
  const billingPattern = /billing_error|allowance is too low|tokens used|insufficient (?:balance|credit|quota)|额度不足/i
  for (const file of walkSessions(sessionRoot, [], sinceMs)) {
    let text
    try { text = readSessionText(file) } catch { continue }
    let provider = null
    let model = null
    for (const line of text.split('\n')) {
      if (!line || (line.indexOf('request/header') === -1 && line.indexOf('assistant/message') === -1 && line.indexOf('turn/end') === -1)) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      const t = ev.time || 0
      if (ev.type === 'request/header') {
        const cfg = ev.data?.header?.config || {}
        provider = cfg.provider || null
        model = cfg.model || null
        continue
      }
      if (ev.type === 'assistant/message') {
        const src = ev.data?.message?.source || {}
        // 实测（2026-09-15）：用量在 data.usage；message.usage 不存在（写错过一次，靠 dump 真实事件纠正）
        const u = ev.data?.usage ?? ev.data?.message?.usage
        if (u && src.provider) {
          entries.push({
            time: t, provider: src.provider, model: src.model || model || '?',
            inputTokens: (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0),
            outputTokens: Number(u.outputTokens) || 0,
          })
        }
        continue
      }
      if (ev.type === 'turn/end') {
        const msg = String(ev.data?.reason?.error?.message || '')
        if (msg && billingPattern.test(msg)) {
          entries.push({ time: t, provider: provider || '?', model: model || '?', inputTokens: 0, outputTokens: 0, billingError: true })
        }
      }
    }
  }
  return entries
}

function parseArgs(argv) {
  const out = { days: 1, json: false, provider: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--days') out.days = Math.max(1, Number(argv[++i]) || 1)
    else if (a === '--provider') out.provider = argv[++i] || null
    else if (a === '--all') out.days = 3650
  }
  return out
}

function loadLimits() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (raw && typeof raw === 'object' && raw.providers) return { limits: raw, source: CONFIG_PATH }
  } catch { /* 缺文件/坏 JSON → 用内置默认 */ }
  return { limits: DEFAULT_LIMITS, source: '(built-in defaults)' }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { limits, source } = loadLimits()
  // 多扫 1 天以覆盖跨 UTC 日边界的会话文件（mtime 过滤只用于省时间，不影响折窗口）
  const sinceMs = args.days >= 3650 ? 0 : Date.now() - (args.days + 1) * 86_400_000
  const entries = collectEntries(SESSION_ROOT, sinceMs)
  const byDay = foldUsage(entries, limits)
  const days = [...byDay.keys()].sort().reverse().slice(0, args.days)
  const report = { generatedAt: new Date().toISOString(), limitsSource: source, totalRecords: entries.length, days: [] }
  for (const day of days) {
    const b = byDay.get(day)
    const row = { day, billingErrors: b.billingErrors, providers: [] }
    for (const slot of [...b.providers.values()].sort((a, c) => c.weighted - a.weighted)) {
      if (args.provider && !slot.provider.includes(args.provider)) continue
      const limit = limits.providers?.[slot.provider]?.dailyWeighted
      row.providers.push({
        provider: slot.provider,
        weighted: slot.weighted,
        tokens: slot.tokens,
        calls: slot.calls,
        dailyWeighted: limit ?? null,
        remaining: limit ? Math.max(0, limit - slot.weighted) : null,
        percent: limit ? Number(((slot.weighted / limit) * 100).toFixed(1)) : null,
        models: [...slot.models.values()].sort((a, c) => c.weighted - a.weighted),
      })
    }
    report.days.push(row)
  }
  if (args.json) { console.log(JSON.stringify(report, null, 2)); return }
  console.log(`# 加权 token 用量报告  (生成 ${report.generatedAt}; 配置源 ${source}; 记录 ${report.totalRecords} 条)`)
  console.log('# 额度判定按 UTC 日；apinex 的 used/limit 只能登录页查看，这里是**本地估算**（口径=ceil((in+out)×weight)）')
  if (report.days.length === 0) { console.log('(无记录)'); return }
  for (const day of report.days) {
    console.log(`\n== ${day.day} (UTC) ==  计费类失败 ${day.billingErrors} 次`)
    if (day.providers.length === 0) { console.log('  (无匹配 provider)'); continue }
    for (const p of day.providers) {
      const quota = p.dailyWeighted
        ? `额度 ${p.dailyWeighted.toLocaleString('en-US')} / 已用 ${p.weighted.toLocaleString('en-US')} (${p.percent}%) / 剩余 ${p.remaining.toLocaleString('en-US')}`
        : '（未配置日额度，仅供参考）'
      console.log(`  ${p.provider.padEnd(18)} ${quota}   调用 ${p.calls} 次 / 计费 token ${p.tokens.toLocaleString('en-US')}`)
      for (const m of p.models.slice(0, 6)) {
        console.log(`      ${String(m.model).padEnd(30)} ×${m.weight}  加权 ${m.weighted.toLocaleString('en-US')}  调用 ${m.calls} 次`)
      }
      if (p.percent !== null && p.percent >= 80) console.log(`      ⚠ 已用 ${p.percent}%，接近/触及日额度上限`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('quota-report.mjs')) main()
