#!/usr/bin/env node
// 把 README 的数字收口到 r5 实测（小锚点替换，写入前锚点必须唯一）。
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
const F = 'D:\\Deepseek-Harness\\outputs\\2026-09-18-model-availability-probe\\README.md'
const raw = readFileSync(F, 'utf8')
const EOL = raw.includes('\r\n') ? '\r\n' : '\n'
const L = (...x) => x.join(EOL)

const EDITS = [
  {
    name: 'headline 结果行 -> r5 实测',
    from: '- 结果: **可用 44 / 74** → **已修复并复测：46 / 75**；其中 24 个是账户/额度问题（改配置救不了）、5 个上游临时、3 个已下线/misconfig slug 已改好',
    to: '- 结果: 修复前 **44 / 74** → 修复后**全量实测（r5）47 / 75**；28 个失败 = **24 需要你操作 + 4 上游临时**（数字会随上游滑动，见下方「局限」）',
  },
  {
    name: '分类总览表 -> r5',
    from: L('| ✅ 可用 | 44 | 实测 200 且带 `choices` |',
      '| ≡ 需要你操作 | 24 | 账户/额度/站点问题 —— **改配置救不了** |',
      '| ⏳ 上游临时 | 5 | 限流/繁忙/上游无通道 —— 不用动 |',
      '| 🔧 配置可修 | 1 | 模型 ID 已下线 —— 换 ID 即可 |'),
    to: L('| ✅ 可用 | **47** | 实测 200 且带 `choices` |',
      '| ≡ 需要你操作 | **24** | 账户/额度/站点问题 —— **改配置救不了** |',
      '| ⏳ 上游临时 | **4** | 限流/繁忙/上游无通道 —— 不用动 |'),
  },
  {
    name: '按厂商表加 r2 基线标注',
    from: '## 按厂商（实测）',
    to: L('## 按厂商（**修复前基线 r2 · 74 模型**）',
      '',
      '> ⚠️ 本节是**修复前**的基线快照。**修复后的权威逐厂商/逐模型表见 [`MODEL-STATUS.md`](./MODEL-STATUS.md)**（r5 · 75 模型，含分类与延迟）。'),
  },
]

let ok = true
for (const e of EDITS) {
  const n = raw.split(e.from).length - 1
  console.log(`${n === 1 ? 'OK  ' : 'FAIL'} x${n}  ${e.name}`)
  if (n !== 1) ok = false
}
if (!ok) { console.error('预检失败，拒写'); process.exit(1) }
let out = raw
for (const e of EDITS) out = out.replace(e.from, e.to)
const tmp = `${F}.tmp-${process.pid}`
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, F)
console.log(`WROTE ${Buffer.byteLength(raw)}B -> ${Buffer.byteLength(out)}B`)
