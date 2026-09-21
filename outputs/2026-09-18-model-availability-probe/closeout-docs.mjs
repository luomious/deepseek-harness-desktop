#!/usr/bin/env node
// 收口：CHANGELOG 顶部加「一键测试全部」章节 + 当日 memory 追加。
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const CHANGELOG = 'D:\\Deepseek-Harness\\CHANGELOG.md'
const MEM = 'D:\\Deepseek-Harness\\.workbuddy\\memory\\2026-09-18.md'

// ── CHANGELOG ──
const cr = readFileSync(CHANGELOG, 'utf8')
const C_EOL = cr.includes('\r\n') ? '\r\n' : '\n'
const CL = (...x) => x.join(C_EOL)
const cSection = CL(
'---',
'',
'## 2026-09-18 · 模型管理面板新增「一键测试全部」按钮',
'',
'**目标**：在「模型管理」设置面板一键测完**所有厂商×模型**，实时进度 + 逐模型结果。',
'',
'**改动（纯前端，`plugins/dsh-model-whitelist/lib/client.js`，+57 行）**：',
'- 新增 `runAllTests()`：遍历 `displayGroups` 全部 entries，逐个打既有单模型端点 `/model-whitelist/test`，**低并发 3**（避免把 apinex 的 5 次/分、sennsenhaus 的 tpm/rpm 打成假失败）；实时回填 `bulk` state（running/done + 逐模型 {ok, latencyMs, error}）。',
'- 工具栏新增「测试全部」按钮（批量运行时显示 `测试全部 N/M…` 并禁用）；完成后显示 `测试全部：K/M 可用`。',
'- 完成时在列表下方渲染**可滚动结果面板**：每行 `✓/✗ provider/model · 延迟/错误`。',
'- 复用既有单模型端点（不改 host），**刷新页面即生效**（服务端按请求读盘，实测已能取到含 `runAllTests` 的新 bundle，`status 200 / 30628B`）。',
'**验证**：`node --check` OK；`git diff` 仅此文件 +57；门禁 `check-all.ps1` **ALL PASS**（`REGISTERED=27 DRIFTED=0`）；`SMOKE TEST: ALL PASS`。',
'**回滚**：`git checkout -- plugins/dsh-model-whitelist/lib/client.js`（git HEAD = 打补丁前的原始版）。',
'**注意（沿用已知偏差）**：面板用的仍是「测试连接」的判据（HTTP 200 即算可用；单模型端点硬编码 15s 超时会把慢但可用的模型判失败）——「测试全部」一键完整体检请用报告里的 `probe-models.mjs`（更严：200 且 body 含 choices + 串行复测）。',
'',
)

const cAnchor = '## 2026-09-18 · 已配置 API 模型全量可用性测试（17 厂商 / 74→75 模型）+ 配置修复'
if (cr.indexOf(cAnchor) === -1) { console.error('CHANGELOG 锚点未找到'); process.exit(1) }
let cNew = cr.replace(cAnchor, cSection + cAnchor)
writeFileSync(CHANGELOG + '.tmp-' + process.pid, cNew, 'utf8'); renameSync(CHANGELOG + '.tmp-' + process.pid, CHANGELOG)

// ── memory 追加 ──
const mr = readFileSync(MEM, 'utf8')
const M_EOL = mr.includes('\r\n') ? '\r\n' : '\n'
const mAppend = M_EOL + M_EOL + CL(
'## 七、模型管理「一键测试全部」（新增功能）',
'',
'- `plugins/dsh-model-whitelist/lib/client.js` +57 行：`runAllTests()` 遍历全部厂商×模型打单模型端点（并发 3，避免 apinex/sennsenhaus 假限流），工具栏「测试全部」按钮 + 可滚动逐模型结果面板。',
'- **纯前端、改完刷新即生效**（实测服务端已返回含 `runAllTests` 的新 bundle 30628B）。门禁 ALL PASS。',
'- **一次自我纠错**：补丁脚本第一次跑时 `node --check` 因临时文件无 `.js` 后缀失败，且 ESM 里 `require` 未定义 → 临时检查文件 `client.js.checktmp-50696` 留在插件目录、触发门禁红；已回收站删除 + 脚本改用 import 的解构名。⇒ 教训：**清理临时文件的逻辑要在 ESM 里用 import 解构名（不能用 require），且 `node --check` 的临时文件必须带 `.js` 后缀**。',
'',
)
writeFileSync(MEM + '.tmp-' + process.pid, mr + mAppend, 'utf8'); renameSync(MEM + '.tmp-' + process.pid, MEM)

console.log('CHANGELOG + memory updated')
