#!/usr/bin/env node
// 把 CHANGELOG 里「一键测试全部」章节的描述改成就近排版版。
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
const F = 'D:\\Deepseek-Harness\\CHANGELOG.md'
const raw = readFileSync(F, 'utf8')
const EOL = raw.includes('\r\n') ? '\r\n' : '\n'
const L = (...x) => x.join(EOL)

const EDITS = [
  {
    name: '改动描述 → 就近排版',
    from: L("- 工具栏新增「测试全部」按钮（批量运行时显示 `测试全部 N/M…` 并禁用）；完成后显示 `测试全部：K/M 可用`。",
      "- 完成时在列表下方渲染**可滚动结果面板**：每行 `✓/✗ provider/model · 延迟/错误`。"),
    to: L("- 工具栏新增「测试全部」按钮（批量运行时显示 `测试全部 N/M…` 并禁用）；完成后显示 `测试全部：K/M 可用`。",
      "- **结果就近显示（用户反馈后优化）**：厂商行右侧加本组汇总徽标 `✓ K/N`（全绿/有红两色），展开后**每个模型行右侧**直接显示该模型结果 `✓ 1.2s` / `✗ 禁止访问(403)`（过长自动省略，`title` 悬停看全文）；**取消**了原先放在页面最底部的大结果面板（需要滚动才能看到，不方便对照）。"),
  },
  {
    name: '补一行验证（排版版）',
    from: "**验证**：`node --check` OK；`git diff` 仅此文件 +57；门禁 `check-all.ps1` **ALL PASS**（`REGISTERED=27 DRIFTED=0`）；`SMOKE TEST: ALL PASS`。",
    to: "**验证**：`node --check` OK；`git diff` 仅此文件（+81/-1）；门禁 `check-all.ps1` **ALL PASS**（`REGISTERED=27 DRIFTED=0`）；`SMOKE TEST: ALL PASS`；服务端实取新 bundle（`modelResult`/`groupSummary` 均在、底部面板文案已消失）。",
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
writeFileSync(F + '.tmp-' + process.pid, out, 'utf8')
renameSync(F + '.tmp-' + process.pid, F)
console.log('CHANGELOG updated')
