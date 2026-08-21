#!/usr/bin/env node
/**
 * stuck-loop-guard evaluation reporter.
 *
 * Reads the guard's audit JSONL and produces a monitoring report:
 * fire volume, tier split, chain-settle depth, recurring problem clusters,
 * daily trend, and concrete tuning recommendations.
 *
 * Usage:
 *   node scripts/evaluate.mjs                 # stdout, last 7 days, default file
 *   node scripts/evaluate.mjs --days 3 --write [out.md]
 *   node scripts/evaluate.mjs --file <events.jsonl> --json
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const file = flag('--file') ?? join(PKG_ROOT, 'data', 'events.jsonl')
const days = Number(flag('--days') ?? '7')
const json = args.includes('--json')
const writeIdx = args.indexOf('--write')
const outFile = writeIdx >= 0 ? (args[writeIdx + 1] && !args[writeIdx + 1].startsWith('--') ? args[writeIdx + 1] : join(PKG_ROOT, 'REPORT.md')) : undefined

if (!existsSync(file)) {
  console.log(`No audit data yet (${file}). The guard records events only when failure loops occur — an empty file means no stuck loops were detected.`)
  process.exit(0)
}

const cutoff = Date.now() - days * 86400_000
const records = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const rec = JSON.parse(line)
    if (Date.parse(rec.ts) >= cutoff) records.push(rec)
  } catch { /* skip corrupt lines */ }
}

const fires = records.filter((r) => r.type === 'fire')
const settles = records.filter((r) => r.type === 'settle')

const groupBy = (list, key) => {
  const map = new Map()
  for (const item of list) {
    const k = key(item)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

const firesByTool = groupBy(fires, (r) => r.tool)
const tierCounts = groupBy(fires, (r) => r.tier)
const settleByReason = groupBy(settles, (r) => r.reason)
const settleDepth = groupBy(settles, (r) => (r.count >= 5 ? '5+' : String(r.count)))
const firesByDay = groupBy(fires, (r) => r.ts.slice(0, 10))

// Problem clusters: same tool + code + signature firing repeatedly.
const clusterMap = new Map()
for (const f of fires) {
  const key = `${f.tool} | ${f.code || 'NO_CODE'} | ${f.sig}`
  const entry = clusterMap.get(key) ?? { count: 0, days: new Set(), first: f.ts, last: f.ts, tool: f.tool, code: f.code, sig: f.sig, maxCount: 0 }
  entry.count += 1
  entry.days.add(f.ts.slice(0, 10))
  entry.maxCount = Math.max(entry.maxCount, f.count)
  entry.last = f.ts
  clusterMap.set(key, entry)
}
const clusters = [...clusterMap.values()].sort((a, b) => b.count - a.count)

const escalateFires = fires.filter((f) => f.tier === 'escalate').length
const escalateRatio = fires.length ? escalateFires / fires.length : 0
const deepSettles = settles.filter((s) => s.count >= 5).length
const deepSettleRatio = settles.length ? deepSettles / settles.length : 0
const chronic = clusters.filter((c) => c.days.size >= 3)

// ── Verdict heuristics ──────────────────────────────────────────────────
const notes = []
if (fires.length === 0) {
  notes.push(`Window had zero stuck loops. Either work was smooth or the guard's include/exclude needs reviewing — nothing to tune from data alone.`)
} else {
  if (escalateRatio < 0.2) notes.push(`Escalation ratio ${(escalateRatio * 100).toFixed(0)}% (<20%): tier-1 diagnose reminders resolve most loops before they deepen — thresholds are effective.`)
  else if (escalateRatio > 0.5) notes.push(`Escalation ratio ${(escalateRatio * 100).toFixed(0)}% (>50%): tier-1 reminders are often ignored. Consider thresholds [2,4] so intervention comes earlier.`)
  else notes.push(`Escalation ratio ${(escalateRatio * 100).toFixed(0)}%: mixed effectiveness; review top clusters below for repeat offenders.`)
  if (settles.length && deepSettleRatio > 0.3) notes.push(`${(deepSettleRatio * 100).toFixed(0)}% of loops ran 5+ failures before settling — consider earlier thresholds or adding tool-specific timeouts.`)
  for (const c of chronic) notes.push(`Chronic cluster (${c.days.size} days): ${c.tool} / ${c.code || 'NO_CODE'} — recurring project problem, or legitimate repeated failure that belongs in the guard's \`exclude\` list.`)
}

// ── Rendering ───────────────────────────────────────────────────────────
const table = (rows) => rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')
const report = `# stuck-loop-guard 监测报告

- 窗口: 最近 ${days} 天（截至 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC）
- 数据源: \`${file}\`
- 提醒触发: **${fires.length}** 次（diagnose ${tierCounts.find(([k]) => k === 'diagnose')?.[1] ?? 0} / escalate ${escalateFires}）
- 失败链终结: **${settles.length}** 条

## 按工具的触发
| 工具 | 触发次数 |
|---|---|
${firesByTool.length ? table(firesByTool) : '| （无） | 0 |'}

## 按天分布
| 日期 | 触发次数 |
|---|---|
${firesByDay.sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `| ${k} | ${v} |`).join('\n') || '| （无） | 0 |'}

## 失败链终结深度（循环在多深时被打破）
| 深度 | 条数 |
|---|---|
${settleDepth.map(([k, v]) => `| ${k} | ${v} |`).join('\n') || '| （无） | 0 |'}

终结原因: ${settleByReason.map(([k, v]) => `${k}×${v}`).join('，') || '（无）'}

## 高频问题簇（同工具+同错误签名）
| 工具 | 错误码 | 触发 | 天数 | 最深 | 签名摘要 |
|---|---|---|---|---|---|
${clusters.slice(0, 8).map((c) => `| ${c.tool} | ${c.code || 'NO_CODE'} | ${c.count} | ${c.days.size} | ${c.maxCount} | ${c.sig.slice(0, 70)} |`).join('\n') || '| （无） | | | | | |'}

## 评估结论
${notes.map((n) => `- ${n}`).join('\n')}

## 调参建议
- 误报（合法轮询被提醒）：把该工具加进 \`exclude\`（cordis.patch.yml 的 config）。
- 提醒被忽视（escalate 占比高）：thresholds 收紧为 \`[2, 4]\`。
- 干预太频繁（diagnose 大量且循环本就短）：放宽为 \`[4, 7]\`。
-  chronic 簇若对应真实项目问题：优先修根因，而不是调守卫。
`

if (json) {
  console.log(JSON.stringify({ windowDays: days, fires: fires.length, escalateRatio, deepSettleRatio, firesByTool, firesByDay, clusters: clusters.slice(0, 10), notes }, null, 2))
} else {
  console.log(report)
}
if (outFile) {
  writeFileSync(outFile, report, 'utf8')
  console.log(`\n[written] ${outFile}`)
}
