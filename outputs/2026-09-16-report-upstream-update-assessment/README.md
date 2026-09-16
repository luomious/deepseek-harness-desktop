# 上游更新评估 + 补丁体系加固（2026-09-16）

- 日期: 2026-09-16
- 类型: report
- 主题: upstream-update-assessment
- 状态: 已完成（评估已定案；加固已落地并验证；升级未执行，等用户拍板）
- 本机基线: `@deepseek-ai/dsh@0.1.1-rc.2` + `dsh-plugin-desktop 2.0.2`（vendor HEAD `0f5ae64`）
- 触发: 用户要求「看官方 dsh / dsh-desktop 有没有更新 + 全面分析我的 dsh 可更新什么 + 是否有必要」

> 本报告是本次全面分析的归档。所有数字都来自本机实测或上游官方接口，**区分「实测 / 推断 / 未验证」**；
> 未执行任何升级动作（涉及 install/build/promote/重启的步骤一律留给用户）。

---

## 1. 结论速览

| # | 结论 | 依据强度 |
|---|---|---|
| 1 | **先纠正前提**：只有**内核** `@deepseek-ai/dsh` 是 DeepSeek 官方；桌面壳 `anywhere-labs/dsh-desktop` 是**社区项目**（官方 release notes 原文：「并非 DeepSeek 官方产品」） | 实测（GitHub API + release body） |
| 2 | 官方内核已走远：本机 **0.1.1-rc.2**（08-21）→ 官方 `latest=0.1.5-rc.1` / `next=0.1.5-rc.2` / `alpha=0.1.6-alpha.1` | 实测（npm dist-tags + GitHub releases + 本仓雷达） |
| 3 | 社区桌面壳最新正式 **v2.0.10**（09-13，内核 0.1.5-rc.2），本机 **2.0.2**；master 上 2.0.11 在飞（beta 切 0.1.6-alpha.1 + 专属 `~/.dsh-beta`） | 实测（GitHub tags/releases/commits） |
| 4 | **升级不是「点一下」**：内核随壳打包（profile 无内核副本，实测 `@deepseek-ai/` 下只有 cosmokit/schemastery）⇒ 升内核 = 重建壳 | 实测 |
| 5 | **当前不建议立即升级**：仓库自定的 5 条触发条件只满足 1 条（脱 alpha），其余 3 条待做、1 条（观察期 ≥7 天）未到 | 实测（脚本 + 文档 + 日期计算） |
| 6 | **但有一条与升不升级无关的必修项已落地**：整文件补丁「静默覆盖」假绿（详见 §6） | 实测 + 故障注入 |
| 7 | 明确**不建议**跳 0.1.6-alpha.1：alpha + PTC/workflow 改名 + Team 模式改 `spawn_teammate` 直接命中本仓 `agent.cordis.yml:205-217,241,246` | 实测（grep 定位） |

---

## 2. 官方更新现状（2026-09-16 实测）

### 2.1 内核（DeepSeek 官方）

| 通道 | 版本 | 时间 |
|---|---|---|
| 本机 | **0.1.1-rc.2** | 2026-08-21 |
| npm `latest` | 0.1.5-rc.1 | 2026-09-10 |
| npm `next` | 0.1.5-rc.2 | 2026-09-10 |
| npm `alpha` / GitHub 最新 release | 0.1.6-alpha.1 | 2026-09-15 |
| 中间版本 | 0.1.2-alpha.1 | 2026-08-27 |

本仓雷达实跑结果（`node scripts/update-watch.mjs`）：`kernel dist-tags: latest=0.1.5-rc.1 next=0.1.5-rc.2 alpha=0.1.6-alpha.1`、`release.desktop: v2.0.10`。
`node scripts/check-update-compat.mjs`：`UPDATE-AVAILABLE 2.0.10 vs 本地 2.0.2`、6 项本地补丁锚点「全部在位」。

### 2.2 桌面壳（社区）

| 版本 | 时间 | 内核 | 关键内容（官方 notes 摘要） |
|---|---|---|---|
| 本机 **2.0.2** | 08-27 | 0.1.1-rc.2 | — |
| v2.0.7 | 09-10 | 0.1.5-rc.1 | 手机连接、数据目录管理、窗口遮挡修复 |
| v2.0.9 | 09-10 | — | **Windows 子进程 runner 改 Node 模式**、远程控制入口 |
| **v2.0.10（最新正式）** | 09-13 | **0.1.5-rc.2** | **全平台取消 ASAR**（产物改 `resources/app/`）、portable 校验 |
| master 2.0.11（未发） | 09-16 | beta 切 0.1.6-alpha.1 | beta 专用 `~/.dsh-beta`、stable 留在 0.1.5-rc.2 |

---

## 3. 「我的 dsh 有哪些可更新」——三类，性质不同

### A. 内核 + 壳（绑死，无法只升一个）
实测：`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/` 下只有 `cosmokit`、`schemastery`，**没有内核**；内核在 `app.asar.unpacked/node_modules/@deepseek-ai/*`。⇒ 升内核必须重建壳（与上游发布 2.0.10 的做法一致：bump `@deepseek-ai/*` 依赖 → install → build → 重打补丁）。

### B. 第三方插件（先验 peer，再决定）

| 包 | 本机 | 最新 | peer 约束实测 | 结论 |
|---|---|---|---|---|
| `@liustack/modlens` | 3.23.1 | **3.26.1** | **无 peerDependencies**（仅 undici/commander） | 技术上可行；但会覆盖本地「无缝接管」canon，**必须重做补丁 + 全量重启**（仓规：modlens 禁热重载）⇒ 建议与内核升级一并做 |
| `dsh-tool-search` | ^0.1.3 | 0.1.4 | **要求 `@deepseek-ai/dsh-*: ^0.1.2-rc.1`** | ❌ **与本机 0.1.1-rc.2 不兼容**，现在升级会破 peer 契约 ⇒ 只能等内核升级 |
| `dsh-context` | 0.33.1 | 0.53.0 | 未验证 | 跨度大，推测要新内核（未验证） |
| `dshmarket` | 1.40.0 | 1.47.0 | 未验证 | 同上 |
| `dsh-better-sidebar` | 0.15.2 | 0.19.1 | 未验证 | 同上 |
| `dsh-mcp-lens` | 0.1.0-rc.9 | 0.1.0-rc.9 | — | ✅ 已最新 |

> **这行数据本身就是「生态在倒逼内核升级」的硬证据**：连工具瘦身插件的 patch 版都已要求 0.1.2+。

### C. 本地资产卫生（与升级无关，但决定升级安不安全）
- ✅ **skill catalog 健康**：33 个 modelInvocable / **6,410 字符**（<9KB 红线）⇒ 无需瘦身。
- ⚠️ 6 个整文件补丁 bundle 原本是「静默覆盖」（§6，已修）。
- ⚠️ `plugins/dsh-project-brief/node_modules/@deepseek-ai/dsh-tools` 是指向**全局 npm 旧内核**的绝对路径 junction（升级时的 A 级隐患，未处理）。

---

## 4. 升级成本（全部实测，不是估算）

| 层 | 待处理量 |
|---|---|
| 内核产物 | 内核侧 11 单元：**必重写 5**（5 个 client/host bundle）+ 可能失效 5 + 可退役 1（`dsh-subprocess-local` windowsHide，上游 0.1.3 起自带） |
| 桌面壳 | 壳侧 11 组：**必重写 4 组**（`profile-*`、`log-files-*`、`electron-runtime-*`×2 均为**内容哈希命名**，重建即换名换内容） |
| 脚本层 | **16 处 no-ASAR 硬点**（`resolve-dist.mjs:52,57` 是总根；`check-dist-integrity` / `verify-patches.ps1:32,96` / `smoke-test.ps1` / `startup-verify.mjs:180-188(V6 硬红)` / `scan-dangling.mjs:99,107` / `apply-safe-delete-shim.mjs:80-168` asar 重打包段…） |
| 壳源码 | 本地壳定制 = **11 个 commit / 20 文件**（4 个新增 src + 一堆「改上游文件」型）；`verify-packaged-runtime.ts` 的 `verifyUnpackedContract` 在 no-ASAR 下**必然 afterPack 硬失败**，必须删 |
| 插件层 | 39 插件：A 级（apiproxy 补丁链、~100 个精确钉死 0.1.1-rc.2 的依赖、project-brief junction）；B 级**静默失效** 13 处（`dsh-context-lifecycle:162-211` 裸读 `session.events`、`details` 等硬编码槽位…） |
| 环境前置 | 子模块 `deepseek-harness` **实测是空目录（仅 gitlink）**；yarn 缓存只含 0.1.1-rc.2 一族；`.yarn-cache/.yarn-global` 目录不存在（脚本安装=强制联网）；**代理 127.0.0.1:7897 实测未监听** ⇒ 今天无法 install/build |
| 数据 | Session 磁盘格式 **v0→v1→v2 链式迁移**（首次打开旧会话会重写）⇒ 必须全量备份 |

---

## 5. 「有没有必要」——用仓库自定的 5 条触发条件判（`docs/UPDATE-ASSESSMENT.md:57-63`）

| # | 条件 | 现状 |
|---|---|---|
| 1 | 官方上游**脱离 alpha** | ✅ **已满足**（0.1.5-rc.1=latest；0.1.5-rc.2=next；社区稳定 2.0.10 即此内核） |
| 2 | 补丁锚点预检通过 | ⚠️ 部分（「在位」只证明**旧基线**完整；对目标版本 5 个 bundle 必然 MISS） |
| 3 | 依赖差异审计 | ❌ 未做（apiproxy 已移除、~100 钉版需重算） |
| 4 | 39 插件兼容清单全绿 | ❌ 未做 |
| 5 | 官方版本稳定观察 ≥7 天 | ❌ **未满足**：2.0.10 发布仅 2.5 天，内核 0.1.5-rc.2 6 天 |

**判定：不必现在升级，但必须现在开始预备。** 理由：① 不升级不损失现有能力（生态调查实测 112/260 同类插件与 0.1.1-rc.2 完全兼容，本机基线绿）；② 升级白拿的能力正好命中既有痛点（官方原生 zstd / 长会话内存与卡顿、断线重连、Windows 子进程治理、目录选择器、模型目录、任意文件上传）并能让 **约 10 项补丁退役**；③ 生态倒逼真实存在（§3.B）。

---

## 6. 本次已执行的零回归加固（H1 + H4）

### 问题（审计实测）
`scripts/port-user-patches.mjs` 把 `patches/bundles/` 的整文件 canon 写进目标前，**只校验 canon 自身**（`ensureMarkers`），从**不校验目标**；写后回读校验查的又是刚被覆盖的文件 ⇒ **必然通过 = 假绿**。上游换版时会把旧内核整份 `client.js` 静默盖到新文件上，报告全绿。

### 改动
| 文件 | 改动 |
|---|---|
| `scripts/patch-shape-gate.mjs`（新增，~230 行） | 登记表（6 个内核包 + modlens）+ 两道门禁：**版本针**（目标包 `package.json` version 必须等于 expectVersion）+ **上游形状锚点**（`canon ∩ 原版` 的公共长行，本机 6 项共 15 条，**全部经双向验证**）；`assertTargetShape()` fail-closed；`--self-check` 只读三方对照（canon / 原版 / 目标） |
| `scripts/port-user-patches.mjs` | 三个写入点全部加 `assertTargetShape`；新增 `--allow-drift`（人工确认迁移的逃生口）与 `--self-check` 转发 |
| `scripts/check-all.ps1` | 新增 **Step 1.16**（阻塞式，纯 ASCII 注释）⇒ 门禁不会腐烂 |

锚点的权威参照 = 全局 npm 安装的 **0.1.1-rc.2 原版包**（实测存在，6 个包齐全）⇒ 锚点不是猜的，是「canon 与原版求交」得到的结构行。

### 验证（四腿）
1. `node --check` 两个脚本 → exit 0；`check-all.ps1` AST 解析 **0 错误**、无 BOM（首 3 字节 `35,32,115`）。
2. `--self-check` → **6 OK + 1 WARN，结论 ALL OK**（exit 0）；每个内核包的锚点在 **canon 与原版双向**均存在，dev + dist 两个目标均 OK。
3. **正常路径零回归**：跑 `port-user-patches.mjs` → 7/7 OK、exit 0，**13 个目标文件哈希前后完全一致（files-changed=0）**。
4. **故障注入**：伪造 `DSH_PKG_ROOT`（6 个包均为 `9.9.9` + 垃圾内容）→ **6 个 worker 全部拒绝写入、exit 1、伪造目标哈希未变（证明 abort 在写盘前）**；再加 `--allow-drift` → 降为 6 条警告、exit 0、确认放行（证明逃生口有效）。

### 回归基线（改动后重测）
`verify-patches.ps1` **ALL PASS (50 checks)** ｜ `startup-verify.mjs` **V1–V10 PASS**（V9 为沙箱 EPERM 环境跳过）｜ `/health` **HTTP 200**。

---

## 7. 未执行项与原因（诚实清单）

| 项 | 为何不做 |
|---|---|
| 内核 0.1.1-rc.2 → 0.1.5-rc.2 | 触发条件 3/4/5 未满足；且代理未开、子模块未初始化、16 处 no-ASAR 硬点未改 ⇒ 今天做只会得到半成品 |
| 桌面壳 2.0.2 → 2.0.10 | 同上；且必须先修 `resolve-dist.mjs`（单点瓶颈） |
| 退役「已被上游吸收」的补丁 | ⚠️ **反直觉但关键**：`dsh-subprocess-local` 的 windowsHide 在**上游 0.1.3+ 已自带**，但本机跑的是 0.1.1-rc.2（**没有**）⇒ 现在退役会**破坏现有功能**。退役必须与升级同批 |
| `dsh-tool-search` 0.1.3 → 0.1.4 | peer 要求 ^0.1.2-rc.1，本机不满足（升级即破契约） |
| modlens 3.23.1 → 3.26.1 | 无 peer 阻碍，但会覆盖本地 canon + 需全量重启 + 收益未证实 ⇒ 等内核决策一并处理 |
| `dsh-context-lifecycle` 的 `session.events` 双兼容层 | 当前内核下**零可观测收益**（纯未来保险），且改运行态插件需重启 ⇒ 归入升级批次 |
| project-brief 绝对路径 junction | 改动会动插件解析路径，需先确认 `dsh-tools` 的真实使用方式 ⇒ 单独小任务 |

---

## 8. 方案（分层，含验证与回滚）

现成资产可直接复用（不必重造）：`docs/UPDATE-ASSESSMENT.md`（触发条件）、`docs/UPSTREAM-UPDATE-PREP.md`（雷达 + Phase 0/1）、`docs/UPGRADE-REHEARSAL-2026-09-08.md` + `_backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md`（**49 项补丁处置表 + 执行手册 + 回滚路线**）、`docs/UPGRADE-EXECUTION-PLAN-2026-09-07.md`（升级日 12 步 SOP）。**目标版本需从 0.1.3-alpha.2 刷新到 0.1.5-rc.2。**

### P0 · 已完成（本次）
✅ 形状门禁落地 + 接入 check-all。

### P1 · 观察期到点后（只读预备，约 1 天）
1. `npm pack @deepseek-ai/dsh@0.1.5-rc.2` 解包到临时目录（**不装不跑**）→ 对内核侧 11 个目标产出**锚点存活矩阵**（5 个 bundle 是否重抓 canon 的唯一判据）。
2. 刷新 `IMPACT-REPORT.md` 到 0.1.5-rc.2（沿用 49 项处置表格式）。
3. 39 插件在**隔离 profile** 里跑兼容冒烟（含 B 级 13 处静默失效的故障注入）。
4. 第三方插件逐个复查 peer 后再小步升。

### P2 · 受控升级（需用户在场；代理必须先开）
5. vendor 合入 `v2.0.10`（**需先 fetch 完整历史**：本地 clone 只有 12 个 commit）+ `submodule update --init`。
6. `yarn install --immutable` → `build` → 产出**新 buildN，不碰 junction**。
7. **先修 no-ASAR 16 处脚本**（`resolve-dist.mjs` 一处改 → 12 个脚本连带复活）→ 删 `verifyUnpackedContract` → 修 `smoke-test`/`promote-build` 断言 → 重放 20 文件定制。
8. 按矩阵重打/退役补丁 + `verify-patches` / `startup-verify` / `check-all` / `smoke-test` / 逐插件启动。
9. sessions 二次备份 → **由用户**执行 `promote-build.ps1` 切 junction → 按 SOP 冒烟（含「开」路径选择器、旧会话 v0→v2 迁移、tier-router 回归、回收站 guard、断线重连）。

### P3 · 升级后整合
落地约 10 项补丁退役、`dsh-context-lifecycle` 兼容层、文档与台账同步。

**回滚（三层均在）**：junction 切回 `build202608272104`／sessions 备份还原／vendor 分支 + 补丁 rollback。
**安全红线**：`rebuild-and-restart.ps1` 的 `:80 Start-Process` **会自动重启应用** ⇒ 该脚本禁用，重启只由用户手动执行。

---

## 9. 重启需求

**本次加固不需要重启**：改动全在构建期脚本（`scripts/*.mjs`、`check-all.ps1`），不在应用运行路径、不在插件运行态、不改任何已打补丁的产物文件（哈希已证）。

---

## 10. 主要证据路径

| 证据 | 位置 |
|---|---|
| 门禁实现 + 登记表 | `scripts/patch-shape-gate.mjs` |
| 写入点改造 | `scripts/port-user-patches.mjs` |
| 例行门禁接入 | `scripts/check-all.ps1` Step 1.16 |
| 雷达快照 | `_backups/update-watch-latest.json` |
| 升级影响报告（49 项处置表） | `_backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md` |
| 触发条件与历史评估 | `docs/UPDATE-ASSESSMENT.md`、`docs/UPSTREAM-UPDATE-PREP.md`、`docs/UPGRADE-REHEARSAL-2026-09-08.md` |
