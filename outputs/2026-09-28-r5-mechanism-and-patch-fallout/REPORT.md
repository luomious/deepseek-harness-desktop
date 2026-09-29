# 长效机制收口 + 依赖升版的补丁连带影响（第 5 轮）

> 日期：2026-09-28 ｜ goal round 5 ｜ 免重启 ｜ 未 promote、未改 junction、未重启
> 关联：`docs/UPSTREAM-SYNC-RUNBOOK.md`、`outputs/2026-09-28-p1-dep-bump/REPORT.md`

## 一、新增门禁 `scripts/verify-client-services.mjs`（长效机制第 3 类形状漂移）

**补的缺口**：既有门禁全看不见「服务没人提供」这一类 —— 它不是导出、不是文件，只表现为 **fiber 永不激活**。
0.1.7 启动时「17 客户端条目 pending」的真因正是它：`dsh-client-ui-settings` 不再 provide `settingsScope`，而消费者仍在 inject。

**做法**：对每个内核树扫 `@deepseek-ai/*` + `@dsh-external/*` 的 `lib/client.js`，收集
`super(ctx,"x")` / `reflect.provide("x"` / `.provide("x"`（提供方）与 `inject:[...]` / `ctx.inject([...])`（消费方），
**并把当前 profile 自己的提供方也算进来**（垫片就是要补上游的洞），然后与 baseline 内核比对，只报**目标新增**的缺口。

**实测（0.1.1 baseline → 0.1.7 target）**：
```
baseline: 57 client bundles, 24 services provided   orphans=0
target  : 84 client bundles, 36 services provided   orphans=0   NEW=0        => PASS
[COVERED] 上游缺、由我们 profile 补上的 3 项：
  + notify          <- @dsh-external/dsh-system-notify/lib/client.js
  + settingsScope   <- @dsh-external/dsh-settings-scope-shim/lib/client.js
  + uiConversation  <- @dsh-external/dsh-settings-scope-shim/lib/client.js
```
**它修正了我上一轮的一个错判**：`uiConversation` 我此前粗测「0 个消费者」，门禁实测 **7 个内核客户端包**消费它
（`ui-chat` / `ui-deliverables` / `ui-goal` / `ui-plan` / `ui-schedule` / `ui-trajectory` / `ui-workflow-run`）
⇒ 上一轮把垫片收敛为「只留 settingsScope + uiConversation」**恰好正确**。
另：桌面壳自身 `client.js` 的 inject 列表也含 `settingsScope` ⇒ 垫片实际有 **3 个消费方**（conversation / settings-models / **桌面壳**）。

## 二、我制造的重复，以及修正

**问题**：我新写的 `verify-inventory.mjs` 与**已存在的** `scripts/audit-plugin-inventory.mjs`（check-all **Step 1.14**）在「台账 ≡ 磁盘」上重叠 —— 违反项目「新功能先问有没有现成机制」。

**处置**（不删已有门禁、不重复）：
1. 两个门禁**分工写清**（写在 `verify-inventory.mjs` 头部）：Step 1.14 管 `INVENTORY.md` 自洽；本脚本管**第二份台账** `CAPABILITY-MATRIX.md` vs 磁盘 **vs 运行态** + 退役队列。
2. 新增 **[E] 两份台账必须列同一批 plugins/**，防止两个登记处各说各话。
3. **[E] 首跑即抓出口径不一致**（我的矩阵也收了第三方、台账市场表只收 3 个）⇒ 把 [E] 收敛到**双方都应覆盖的 plugins/ 范围**。

**并且现有门禁立刻指出了我改台账时引入的 3 个错误**（它比我准）：
`dsh-settings-scope-shim` 缺行 / 统计行被 `**` 破坏解析 / 统计 bundle 计数滞后。
按它的裁决修完：**`audit-plugin-inventory.mjs --strict` = 11/11 PASS，0 WARN**（此前 2 PASS / 4 WARN）。

## 三、三个新门禁接入 `check-all.ps1`（Step 1.19 / 1.20 / 1.21）

| Step | 脚本 | 断什么 |
|---|---|---|
| 1.19 | `verify-profile-exports.mjs` | profile 加载中包不得缺具名导出（Step 1.18 只管 dist 自身） |
| 1.20 | `verify-client-services.mjs` | 不得有「被消费但无人提供」的客户端服务 |
| 1.21 | `verify-inventory.mjs` | 第二份台账 ≡ 磁盘 ≡ 运行态 + 退役队列 |

## 四、依赖升版的连带影响：3 个第三方补丁被打掉（**本轮最重要的发现**）

升版 `dsh-context` / `dsh-tool-search` / `dsh-better-sidebar` 后，安装覆盖了被补丁改过的文件
⇒ `verify-patches` 立刻报 3 个 FAIL。这些补丁的注释本身就预警过「**插件重装/升级会静默丢失**」，并给了补救命令。

**补救路径实测（fail-closed、报错精确、但有一个留下中间态）**：

| 脚本 | 结果 |
|---|---|
| `apply-context-undefined-tool-fix.mjs` | `ERR anchor occurs 0 times (expected 1) - upstream plugin changed, re-read it before patching` |
| `apply-tool-search-image-passthrough.mjs` | `ERR anchor "dsh-llm import" occurs 0 times: "import { CallId } from '@deepseek-ai/dsh-llm';"`（锚点是旧 `CallId`） |
| `apply-ui-perf-patches.mjs` | **先写了 3 处**，再在 `[measureCenter, state?.bottomOpen]);` 锚点失败 ⇒ **留下 partial write 中间态** |

**处置**：三个文件已从备份**逐字节还原**（hash 校验一致），回到 npm 原版，消除中间态。备份
`_backups/p1-patch-reapply-<ts>/`。

**逐个判定「上游是否已原生修好」**：

| 补丁 | 判定 | 依据 |
|---|---|---|
| `context-undefined-tool (dsh-context)` | ✅ **原生已修 ⇒ 退役** | `dsh-context/lib/index.js:959-972`：`srcEntry ?? blockEntry` 且 `node.tool = toolEntry.name` 只在 `toolEntry !== void 0` 时执行（还多了 `blockId` 兜底）⇒ `node.tool = undefined` 不可能再发生。已在 `verify-patches.ps1` 的 `$retired` 登记（含 ASCII 注释说明来源是**插件升版**而非内核升级） |
| `tool-search image passthrough` | ❌ **需重做** | 新版 `bridge.js` grep `deferContext`/`blocks` **0 命中** ⇒ 图片块仍然会被丢；但锚点 `import { CallId }` 已被 0.1.5 换成 `ToolCallId` |
| `ui-perf: better-sidebar collapse gate` | ❌ **需重做** | 上游重构了该处（锚点 `[measureCenter, state?.bottomOpen]);` 消失） |

**门禁终态**：`verify-patches` **3 FAIL → 2 FAIL**（+1 条正确的 `INFO RETIRED`）。剩下 2 条是**真实的待重做项**，红灯是诚实的，不做假绿。

## 五、本轮门禁全景

| 门禁 | 结果 |
|---|---|
| `audit-plugin-inventory.mjs --strict` | **11/11 PASS，0 WARN**（修台账后） |
| `verify-inventory.mjs` | **PASS**（A/B/E 通过；退役队列 = `dsh-file-explorer` / `dsh-web-fetch-local` / `dsh-vision-rotator`） |
| `verify-profile-exports.mjs` | **PASS**（对 0.1.7；1 个 LATENT = `dsh-safe-delete`，不加载） |
| `verify-client-services.mjs` | **PASS**（NEW gaps = 0；3 项由 profile 覆盖） |
| `startup-verify.mjs` | **10/10 PASS** |
| `verify-patches.ps1` | **2 FAIL**（真实待重做：tool-search / better-sidebar）+ 1 INFO RETIRED |

## 六、下一步（按依赖）

1. **重做 2 个第三方补丁**（tool-search 图片透传 / better-sidebar collapse gate）—— 需读新版代码找等价锚点。
2. 长效机制剩余：把「Config schema 形状」与「钩子 payload/decision 形状」两类漂移也做成快照 diff（见 runbook §6）。上游更版时靠 `upstream-sync` 一条命令收口。
3. **你关应用 → 运行 `outputs/2026-09-28-promote-handoff/promote-to-0.1.7.cmd` → 启动**（前置全绿、冒烟已预跑 PASS）。
4. 重启验收后：按 `CAPABILITY-MATRIX.md` 执行退役/合并/重写批次。
