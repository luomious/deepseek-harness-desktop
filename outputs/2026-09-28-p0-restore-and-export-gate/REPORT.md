# P0 环境恢复 + profile 导出门禁（长效机制一件）

> 日期：2026-09-28 ｜ 会话：goal-round 1 ｜ 全程可回滚，未重启应用
> 关联：`outputs/2026-09-27-master-plan-upgrade-and-learning/PLAN.md`（U 轨）、`outputs/2026-09-27-u6-0-settings-migration/DECISION.md`

## 一、本轮做了什么（3 件）

### 1. 救回 API 模型配置（`~/.dsh/settings.yaml`）

| 项 | 值 |
|---|---|
| 恢复前 | **394 B**，3 个 section，1 provider（tokenry）/ 1 模型 |
| 恢复后 | **14,203 B**，8 个 section，**18 provider / 75 模型** |
| 来源 | `~/.dsh/settings.yaml.imported`（SHA-256 `F6325FFD2DD8BCAB…`，13,850 B） |
| 手法 | 以 `.imported` 为基，**插入** `tokenry` provider（保留今天新增的 `TOKENRY_API_KEY` 可用），`agent-default-model` 维持 `tokenry/deepseek-flash`（= 恢复前可用态）；LF、无 BOM；同目录 tmp → rename 原子替换 |

**备份（三处，均实测哈希一致）**
- `_backups/p0-settings-restore-20260928-231854/settings.yaml.imported`
- `_backups/settings-imported-second-copy/settings-imported-20260928-231854.yaml`
- 原地 `~/.dsh/settings.yaml.bak-p0restore-20260928-231945`（394 B 降级态）

**校验（`_tmp/validate-restored-settings.mjs`，PASS）**：8/8 section 无丢失；provider 18 / 模型 75；18/18 `apiKeyEnv` 在 `.credentials.yaml` 可解析（24 refs）；无 BOM、无 CRLF。

### 2. 新增 `scripts/verify-profile-exports.mjs`（长效机制 · 第 1/3 件）

**为什么**：2026-09-28 升级失败的根因类别是「**具名导出被删**」，而现有四道门都看不见它——
`verify-dist-exports.mjs`（B3）只覆盖 **dist 自身**；`verify-plugin-imports.mjs` 只管**说明符纪律**并把 `@deepseek-ai/*` 当宿主提供而不查导出名；`check-dist-integrity.mjs` 只查 lib/main.js 的**相对**导入；`verify-runtime-closure.mjs` 只查依赖图闭合。
⇒ **profile 的 59 个插件包（43 个 `@dsh-external` + 16 个第三方）从未被任何导出门禁覆盖**。

**做什么**：扫 profile 声明的每个包的 `lib/**/*.js`，抽取所有指向 `@deepseek-ai/*` 的**具名 import / 具名 re-export**，逐个对照**目标内核**该包的导出面（跟随 `export * from` 递归）。缺失 → `MISSING_EXPORT` + `文件:行号`。

用法：
```
node scripts/verify-profile-exports.mjs                        # 目标=最新 build，profile=desktop
node scripts/verify-profile-exports.mjs --target <unpackedDir> # 指定内核树
node scripts/verify-profile-exports.mjs --profile web --json
```
退出码：0=无缺失，1=有 `MISSING_EXPORT`，2=找不到内核树。

**证伪测试（双内核对照，本轮实测）**

| 目标内核 | 结果 | 说明 |
|---|---|---|
| `win-unpacked-build202609272329`（**0.1.7-rc.2**） | **FAIL — 5 个包** | 见下表 |
| `win-unpacked`（**0.1.1-rc.2**，当前运行内核） | **PASS — 0 个** | 对照组：证明它不是在"一律报红" |

**对 0.1.7 报出的 5 项，与今日崩溃日志逐条交叉核对**

| # | 包 | 缺失导出 | 今日日志命中 | 判定 |
|---|---|---|---|---|
| 1 | `dsh-context` | `dsh-settings :: settingsNamespace` | **62 次** | 真实崩溃（已知） |
| 2 | `dsh-better-sidebar` | `dsh-settings :: settingsNamespace` | **64 次** | 真实崩溃（已知） |
| 3 | `dsh-tool-search` | `dsh-llm :: CallId` | **32 次** | 真实崩溃（已知） |
| 4 | `dsh-bash-terminal` | `dsh-settings :: settingsNamespace` | **42 次** | **真实崩溃（本轮新发现——人工看日志时漏掉）** |
| 5 | `dsh-safe-delete` | `dsh-settings :: installSettingsSection` / `settingsNamespace` | **0 次** | **潜在雷**：不在 `dsh.profile.bundles`、无 `dsh.bundle.patch` ⇒ 当前未被加载，一旦装配即崩 |

> 门禁的正确性由两件事共同确立：① 它在 **0.1.1 上全绿**（排除"一律报红"）；② 它报出的 4 项**全部在今日真实崩溃日志里有对应命中**（排除"假阳性"）。
> 另有 `catalogModelInfo`（日志 104 次）**不在**本门禁输出内——它由 **dist 侧的 `dsh-host-apiproxy`** 引用，属于 `verify-dist-exports.mjs` 的职责范围，本门禁**范围判定正确**。

**已知局限（脚本头已写明，不隐藏）**：抽取是词法的（有界正则 + 完整 import 语句）；`export * from` 递归跟随；无法推导导出面的包（CommonJS）报 `SKIP` 并附原因；`SKIP` 与未安装包会在报告里列出，绝不静默当绿。

### 3. 两个此前只是"推断"的结论，本轮拿到硬证据

| 结论 | 硬证据 |
|---|---|
| 当前 GUI 跑的是**极简 `recover-web` profile**（不是 desktop） | `%APPDATA%\DSH Desktop\profile-selection\state.json` = `{"active":"recover-web","lastKnownGood":"recover-web"}` |
| desktop profile 当前有 **2 个真实缺陷** | `node scripts/startup-verify.mjs` = **8/10 PASS，2 FAIL**：<br>🔴 **V3** `disabled:true ids ⊆ insert ids` → 陈旧 disabled：`selftest-r2probe`、`shortcuts`（`shortcuts` 是 **0.1.7 才有的行**，在 0.1.1 上不存在 ⇒ 典型"patch 与内核混版"）<br>🔴 **V8** `patch anchors present` → `modlens=lowered0 workspace=MISSING`（dist 侧一条补丁锚点丢失）<br>✅ V1/V2/V4/V5/V6/V7/V9/V10 全过（bundles 51 全可解析、43 个 link 插件 101 个文件语法全 OK、V10 声明完整） |

## 二、当前状态卡（升级前基线）

| 项 | 状态 |
|---|---|
| 内核 | 0.1.1-rc.2（运行中）／0.1.7-rc.2（build `win-unpacked-build202609272329` 已构建、已 promote 过、未在跑） |
| profile | `recover-web`（44 个客户端入口，**0 个 `@dsh-external`**；`/health`、`/task-scheduler/status`、`/vision-engine/health` 等**全 404**） |
| API 模型 | ✅ 已恢复 18 provider / 75 模型 |
| API Key | ✅ 24 个，未丢（较 9/21 备份仅新增 `TOKENRY_API_KEY`） |
| 插件链接 | ✅ 43/43 junction 可解析 |
| 导出门禁 | ✅ 新增并通过证伪；对 0.1.7 报 **5 个包**（4 真实 + 1 潜在） |
| 启动预检 | 🔴 8/10（V3 混版、V8 锚点丢失） |
| 会话数据 | 286 文件 / 397.4 MB，格式迁移链 v0→v4，**源逐字节不变、无降级支持** |

## 三、下一步（按依赖顺序）

1. **P0.5 回 desktop profile**：`startup-verify` 的两个 FAIL 先修 → 再把 `profile-selection/state.json` 的 `active` 改回 `desktop` → 用户重启验证（`/health` 10 项、43 插件在 loader 内）。
2. **P1 升级前置**（免重启）：4 个真实阻塞包升版（`dsh-context` 0.33.1→0.59.2、`dsh-better-sidebar` 0.15.2→0.22.1、`dsh-bash-terminal` 0.3.14→?、`dsh-tool-search` 0.1.3→0.1.5）+ `dsh-safe-delete` 装配决策 + pwsh `Volatile` 构造修正 + 把本门禁接入 `check-all.ps1`。
3. **长效机制剩余 2 件**：① 内核 API 面快照 + 漂移 diff（`kernel-surface.mjs --snapshot/--diff`）；② `INVENTORY.md` 增 `upstreamNative` 列并由门禁断言"上游已实现却仍在装配 → 报红"（自动退役）。
4. **逐插件取舍表**：6 批深读已全部回收，待汇总为 43 插件逐项 保留/合并/退役 表。

## 四、回滚

| 改动 | 回滚 |
|---|---|
| `~/.dsh/settings.yaml` | 用 `~/.dsh/settings.yaml.bak-p0restore-20260928-231945` 覆盖回原位（394 B 降级态）；`.imported` 两份副本全程未动 |
| 新增 `scripts/verify-profile-exports.mjs` | 纯新增、无调用方，删除即回滚 |
| `_tmp/validate-restored-settings.mjs`、`_tmp/settings-restored.yaml` | 临时文件，可删 |
