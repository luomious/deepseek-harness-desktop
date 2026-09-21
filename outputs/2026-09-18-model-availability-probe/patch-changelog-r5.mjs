#!/usr/bin/env node
// CHANGELOG 数字收口到 r5 实测 + 补「上游滑动 / 一次自我纠错」记录。
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
const F = 'D:\\Deepseek-Harness\\CHANGELOG.md'
const raw = readFileSync(F, 'utf8')
const EOL = raw.includes('\r\n') ? '\r\n' : '\n'
const L = (...x) => x.join(EOL)

const EDITS = [
  {
    name: '结果行 -> r5 实测',
    from: '**结果**：可用 **44/74** → 修复后 **46/75**。',
    to: '**结果**：修复前 **44/74** → 修复后**全量实测 47/75**（r5）。失败 28 个 = 24 需用户操作（账户/额度）+ 4 上游临时。',
  },
  {
    name: '补上游滑动与自我纠错段',
    from: '**运行时健康面**：`GET /health` = **503**',
    to: L('**上游会滑动（单次快照的局限，实测佐证）**：修复后连续跑了 3 轮全量（r3/r4/r5），可用数依次 46→44→**47**，但**成分在变**：`amd/DeepSeek-V4-Flash` 由 503 超时**恢复**（r4 9.6s / r5 16.4s OK）；`groq` 3 个模型在 r2/r3 均 OK，**r4 起全变 403 `Forbidden`**（串行重测 3/3 确认，属本轮之后的上游变化）；`openrouter/poolside`、`zhipu glm-4.7-flash`、`sennsenhaus` 则在失败/成功间摆动。⇒ **数字看趋势、不看单次**。',
      '',
      '**一次自我纠错（如实记录）**：r4 复测 groq 时错用了与 r4 同一个 `--out` 目录，把 75 模型的 `probe-results.json` **覆盖成了 3 行**，且 `MODEL-STATUS.md` 被按 3 行重生（假数据）。发现后**重跑全量（r5）并重生表格**；`status-report.mjs` 同时修掉了写死的数据源标签。⇒ 教训：**带 `--out` 的探针脚本必须把每次运行指向唯一目录**，不能复用。',
      '',
      '**运行时健康面**：`GET /health` = **503**'),
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
