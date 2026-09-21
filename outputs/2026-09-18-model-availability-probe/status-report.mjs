#!/usr/bin/env node
// 从 r2/probe-results.json 生成逐模型状态清单（MODEL-STATUS.md + model-status.csv）。
// 用法: node status-report.mjs <probe-results.json> <outDir>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [src, outDir] = process.argv.slice(2)
const data = JSON.parse(readFileSync(src, 'utf8'))

// 归因：把「探测失败」翻译成「谁该动」
function attribute(r) {
  const kind = (r.retry && !r.retry.ok ? r.retry.kind : r.kind) || 'unknown'
  const err = String((r.retry && !r.retry.ok ? r.retry.error : r.error) || '')
  const low = err.toLowerCase()
  const p = r.provider
  if (kind === 'AUTH_401' && /insufficient balance|creditserror/.test(low)) return ['需要你操作', '账户余额不足（opencode-go CreditsError）']
  if (kind === 'AUTH_401') return ['需要你操作', '未授权 401']
  if (kind === 'FORBIDDEN_403' && /美元预算/.test(err)) return ['需要你操作', '该分组未配置可用的 Codex 美元预算']
  if (kind === 'FORBIDDEN_403' && /credit limit/.test(low)) return ['需要你操作', '账户余额 $0（403 credit limit）']
  if (kind === 'FORBIDDEN_403' && /gift balance/.test(low)) return ['需要你操作', '赠送余额不可用于该模型（剩余可用额度 $0，需充值）']
  if (kind === 'FORBIDDEN_403' && /<!doctype html/i.test(err)) return ['需要你操作', '站点被 Cloudflare 403 拦截（服务端）']
  if (kind === 'FORBIDDEN_403' && /"Forbidden"|^Forbidden$/i.test(err)) return ['需要你操作', '上游 403 Forbidden（Key/组织受限或区域封锁，本轮新出现）']
  if (kind === 'QUOTA_402' && /check-in/.test(low)) return ['需要你操作', '免费模型需每日签到']
  if (kind === 'QUOTA_402' && /subscription/.test(low)) return ['需要你操作', '该模型仅限订阅用户']
  if (kind === 'QUOTA_402') return ['需要你操作', '额度/订阅限制']
  if (/insufficient balance/.test(low)) return ['需要你操作', '账户额度不足（账号级，所有模型同错）']
  if (kind === 'NOTFOUND_404') return ['配置可修', '模型 slug 已下线 → 可换可用模型']
  if (kind === 'BADMODEL_400') return ['配置可修', '上游已下线该模型（400 Unsupported model）→ 删掉或换可用模型']
  if (kind === 'SERVER_5XX' && /model_not_found|no available channel/.test(low)) return ['需要你操作', 'slug 下线且账户余额 $0']
  if (kind === 'SERVER_5XX' && /no_avai|service unavailable/i.test(err)) return ['上游临时', '上游无可用通道（503）']
  if (kind === 'SERVER_5XX' && /<!doctype html/i.test(err)) return ['上游临时', '首轮被 CF 拦，串行复测可恢复']
  if (kind === 'SERVER_5XX') return ['上游临时', '上游 5xx']
  if (kind === 'RATE_429') return ['上游临时', '上游限流/繁忙（会自行恢复）']
  if (kind === 'TIMEOUT') return ['上游临时', '超时']
  if (kind === 'NETWORK') return ['上游临时', '网络瞬时失败']
  if (kind === 'BADBODY_200') return ['上游临时', '返回 200 但 body 是错误体（假阳性，已按失败计）']
  if (kind === 'nokey') return ['需要你操作', '缺 API Key']
  return ['未分类', kind]
}

const rows = data.results.map((r) => {
  const usable = r.ok || r.retry?.ok
  const phase2 = r.retry ? (r.retry.ok ? '复测可用' : '复测仍失败') : ''
  const kind = (r.retry && !r.retry.ok ? r.retry.kind : r.kind) || ''
  const err = String((r.retry && !r.retry.ok ? r.retry.error : r.error) || '').replace(/\s+/g, ' ').slice(0, 160)
  const [cat, reason] = usable ? ['可用', ''] : attribute(r)
  const lat = r.ok ? r.latencyMs : r.retry?.ok ? r.retry.latencyMs : null
  return { provider: r.provider, model: r.model, usable, phase2, kind, latencyMs: lat, cat, reason, err }
})
rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))

const usable = rows.filter((r) => r.usable)
const byCat = {}
for (const r of rows) byCat[r.cat] = (byCat[r.cat] || 0) + 1

// 每厂统计
const byProv = {}
for (const r of rows) {
  byProv[r.provider] = byProv[r.provider] || { total: 0, ok: 0 }
  byProv[r.provider].total++
  if (r.usable) byProv[r.provider].ok++
}

const stamp = String(data.generatedAt || '').slice(0, 10) || 'unknown'
const md = []
md.push(`# 模型可用状态清单（${stamp} 实测）`)
md.push('')
md.push(`数据来源：\`${src.replace(/\\/g, '/').split('/').slice(-2).join('/')}\`（全量 ${rows.length} 个模型；并发探测 + 失败项串行复测）。`)
md.push('')
md.push('判定口径：**HTTP 200 且 body 是合法 chat.completion（含 choices）**才算可用；200 但 body 是错误体一律算失败。')
md.push('')
md.push(`**合计：可用 ${usable.length} / ${rows.length}**`)
md.push('')
md.push('## 分类统计')
md.push('')
md.push('| 类别 | 数量 | 含义 |')
md.push('|---|---|---|')
const catDesc = {
  '可用': '实测 200 且带 choices',
  '配置可修': '模型 ID 已下线 —— 换一个实测可用的 ID 即可',
  '需要你操作': '账户/额度/站点问题 —— 改配置救不了',
  '上游临时': '上游限流/繁忙/无通道 —— 无需改动，多半会自行恢复',
  '未分类': '待人工看',
}
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} | ${catDesc[k] || ''} |`)
md.push('')
md.push('## 按厂商')
md.push('')
md.push('| 厂商 | 可用/已配置 | 说明 |')
md.push('|---|---|---|')
for (const [p, s] of Object.entries(byProv).sort((a, b) => a[0].localeCompare(b[0]))) {
  const bad = rows.filter((r) => r.provider === p && !r.usable)
  const reasons = [...new Set(bad.map((r) => r.cat + '：' + (r.reason || r.kind)))].join('；')
  md.push(`| ${p} | ${s.ok}/${s.total} | ${reasons || '—'} |`)
}
md.push('')
md.push('## 逐模型明细')
md.push('')
md.push('| 厂商 | 模型 | 状态 | 类别 | 延迟 | 说明 |')
md.push('|---|---|---|---|---|---|')
for (const r of rows) {
  const st = r.usable ? '✅' : '❌'
  const lat = r.latencyMs ? r.latencyMs + 'ms' : '—'
  const note = r.usable ? (r.phase2 || '') : (r.reason || r.kind)
  md.push(`| ${r.provider} | \`${r.model}\` | ${st} | ${r.cat} | ${lat} | ${note} |`)
}
md.push('')
writeFileSync(join(outDir, 'MODEL-STATUS.md'), md.join('\n'), 'utf8')

const csv = ['provider,model,usable,category,latencyMs,kind,note']
for (const r of rows) {
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'
  csv.push([r.provider, r.model, r.usable ? 'YES' : 'NO', r.cat, r.latencyMs || '', r.kind, (r.reason || r.err || '')].map(q).join(','))
}
writeFileSync(join(outDir, 'model-status.csv'), '\uFEFF' + csv.join('\r\n'), 'utf8')

console.log('total=' + rows.length + ' usable=' + usable.length)
console.log('byCat=' + JSON.stringify(byCat))
console.log('wrote MODEL-STATUS.md + model-status.csv ->', outDir)
