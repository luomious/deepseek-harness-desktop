# 规范化与流水线化管理 · 差距分析报告

> ⚠️ **计数口径已过时（2026-09-12 实测修正）**：本文的 skill / 插件**计数**是写作当日（2026-09-07）的快照。
> 当前实测 = **插件 35 个**（35/35 含 `lib/index.js`）+ 根级 3 个；**skill 顶层 61 个**（hub 源码 94；12 个有 hub manifest 登记）。
> 复算：`GET http://127.0.0.1:43120/health` · `node scripts/skill-inventory.mjs`。**分析与结论保留不动**（它是「分析稿，未做任何修改」），仅计数勿直接引用。

- 版本：v1.0（**分析稿，未做任何修改**）
- 日期：2026-09-07
- 范围：系统内**功能**（tools / commands / UI 面板）、**插件**（30 个本地插件）、**Skill**（6 个方法论 skill + 13 个官方样例）
- 标准来源：`@deepseek-ai/dsh-skill-filesystem` / `dsh-skill` / `dsh-tool-skill` / `dsh-host-plugin-inventory` README（**本地已安装官方包的权威文档**，非二手教程）
- 说明：用户要求"先分析，不要修复"。本报告只做差距识别与方案设计，**未改动任何文件**。

> 术语：下文"流水线化"= Pipeline 化，指建立 **开发 → 校验 → 装配 → 发布 → 运维 → 退役** 的标准化通道与门禁。

---

## 〇、一句话结论

**插件装配层门禁较完善（且当前无双装配冲突），但 Skill 层（C/D）与仓库治理层（E）完全无门禁**——
而 6 个方法论 skill 位于**仓库之外**（`~/.dsh/skills`，rank 400），既不进 git、也无 CI、无脚本校验，
是这个系统目前**唯一一类"改坏了不会有人知道"的资产**。

---

## 一、官方标准基线（权威提取）

### 1.1 Skill 官方规范（`@deepseek-ai/dsh-skill-filesystem`）

| 项 | 官方要求 |
|---|---|
| **形态** | 单层目录 bundle `<name>/SKILL.md`，或扁平 `<name>.md` |
| **发现深度** | **只扫一层**；嵌套 `**/SKILL.md` **故意不发现** |
| **frontmatter** | open YAML。**required：`name` + `description`**；optional：`whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable` |
| **命名** | `name` **必须 kebab-case** |
| **fail-closed** | invocation 字段若 camelCase 拼写或值非布尔 → **整个 skill 被丢弃**（不是只丢该字段） |
| **catalog 内容** | 只发布 `name` + `description`；**`whenToUse` 不在 catalog 内** |
| **description 上限** | `catalogDescriptionMaxLength` 默认 **500**，必须 ≥3 整数 |
| **热更新** | body 每次加载重读重解析（**改 body 无需重启**）；frontmatter 改名会 reject stale name 并 invalidate |
| **watcher** | 观察 `SKILL.md` 的 add/remove/change；`references`/`scripts`/`assets` 子目录变化**不触发** catalog 失效 |

### 1.2 Skill 发现根优先级（rank，数字小者优先）

| Rank | Source | 路径 | 说明 |
|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | 项目级，最高 |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | 跨 agent 共享约定 |
| 300 | `custom` | `Config.customSkillDirs` | 可配置 |
| **400** | **`user-dsh`** | **`~/.dsh/skills`** | **本项目 6 个 skill 在此** |
| 500 | `user-agents` | `~/.agents/skills` | 共享 agent 根 |

### 1.3 插件官方/通行规范

| 型 | 要求 |
|---|---|
| **bundle** | `package.json`（`type:module`、`main: ./lib/index.js`、`exports` 含 `.`/`./client`/`./package.json`、`dsh.bundle.patch` → `./cordis.patch.yml`、`dsh.client.platform/inject`）+ `cordis.patch.yml`（`- insert: {id, name}`）+ `lib/index.js`（export `name`/`inject`/`apply`）+ 可选 `lib/client.js` |
| **patch-insert** | **不得**带 `dsh.bundle`（否则触发双装配冲突） |

---

## 二、差距分析

### 2.1 Skill 层

| # | 项 | 官方要求 | 现状 | 严重度 |
|---|---|---|---|---|
| S1 | **无任何 skill 格式校验** | frontmatter / kebab / 长度 / fail-closed | 全仓 grep 无校验逻辑（`scripts/` 仅 `apply-settings-resilience.mjs` 误命中） | **高** |
| S2 | **skill 位于仓库外** | 应可审计、可回滚 | `~/.dsh/skills/` 不进 git、无 CI、无脚本覆盖 | **高** |
| S3 | `metadata` 缺失 | 官方支持（承载 version/owner/tags/生命周期） | 6 个 skill 均只有 `name`/`description`/`whenToUse` | 中 |
| S4 | 跨根管理受限 | 统一管理 | `dsh-skills-manager` 读写**仅限 rank400**（`lib/index.js:54,170,187,198`），project(100)/agents(200)/custom(300) **只读** | 中 |
| S5 | 无脚手架 | 规范化新增 | 无 skill skeleton 脚本；skills-manager 建 skill 时**只校验 kebab 正则 + description 非空**，不校验 ≤500、不校验 metadata、不 fail-closed | 中 |

**已合规的部分（实测确认 ✅）**：

| 检查 | 结果 |
|---|---|
| `name` kebab-case 且与目录名一致 | 6/6 通过 |
| `description` 长度 | 80–99 字符，全部 < 500 |
| 无 camelCase / 非法 invocation 值 | 6/6 通过（不会触发 fail-closed） |
| 形态与官方样例一致性 | 与 `paper-writer/skills/thesis-*`（13 个）同为单层 `SKILL.md` + `whenToUse`，**格式一致** |
| description 可判定性 | 每条均含"适用于…"场景句，弥补了 `whenToUse` 不在 catalog 的缺陷 |

> **一个需要注意的设计点**：官方 catalog **只发 `name` + `description`，`whenToUse` 不进 catalog**。
> 这意味着模型决定是否加载某个 skill 的**唯一依据就是 description**。
> 因此 `description` 的质量权重远高于 `whenToUse`——后续所有 skill 的 description 都应像现在这样自带场景描述。

### 2.2 插件层

| # | 项 | 现状 | 严重度 |
|---|---|---|---|
| P1 | **版本号碎片化** | 0.0.1×3 / 0.1.0×22 / 0.2.0×1 / 0.2.1×1 / **1.0.0×1**（`dsh-session-hygiene`） | 中 |
| P2 | **提交 `node_modules/`** | `dsh-project-brief`、`dsh-remote-workspace` | 中 |
| P3 | **`src/` 与 `lib/` 并存** | `dsh-project-brief`、`dsh-remote-workspace`、`dsh-session-watchdog`（源/产物混淆） | 中 |
| P4 | **`dsh-routing-suite` 无 package.json** | 仅含 `.tgz`/`injector`/`install.ps1`/`preset`，非标准插件形态 | 中 |
| P5 | **命名前缀不统一** | 仅 `dsh-skills-manager` 缺 `@dsh-external/` 前缀 | 低 |
| P6 | **15/30 插件无 README** | command-guard、frontend-reload、host-services、hy3-gateway、instance-janitor、model-provider-failover、model-whitelist、prompt-enhance、self-maintenance、session-hygiene、system-notify、ui-performance、vision-engine、web-fetch-local、web-search-bing | 低 |

**已合规的部分（实测确认 ✅，值得肯定）**：

| 检查 | 结果 |
|---|---|
| 必备字段（type / main 带 `./` / exports 含 `.` 与 `./package.json`） | 29 个真插件**全部**通过 |
| **双装配冲突** | 21 个 bundle 型**全部**带 `cordis.patch.yml`；8 个 patch-insert 型**无一误带** `dsh.bundle` → **当前无冲突**（历史 3 次事故形态已消除） |
| 目录名与包名一致性 | 除 skills-manager 外均一致 |

### 2.3 功能层（tools / commands / UI）

功能由插件提供，因此功能规范化 = 插件规范化的一部分。但有两项**跨插件的功能治理**缺口：

| # | 项 | 现状 | 严重度 |
|---|---|---|---|
| F1 | **隐式契约链无文档** | modlens 视觉四件套（guard→picker-group→autoread→vision-engine）靠 aria-label 字符串、路由名、动态 import 联动，无版本化契约 | 中 |
| F2 | **路由三件套组合语义未定义** | tier-router（换模型）/ router-standard（换思维模式）/ force-reasoning-effort（补思考强度）各做一套启发式分类，组合行为未文档化 | 中 |
| F3 | **客户端永久包装无卸载还原** | picker-group 与 model-whitelist 永久包装 `api.sessions.models/selectModel`，无 disposer 恢复 | 中 |

---

## 三、流水线现状：门禁覆盖图

| 层 | 校验点 | 现有工具 | 状态 |
|---|---|---|---|
| **A** 插件 JS 语法 / 产物 | `node --check` | `syncheck-plugins.mjs`、`startup-verify.mjs` V9、`check.yml`、`smoke-test.ps1` | ✅ 有门禁 |
| **B** 插件装配（bundle / patch / 悬空引用） | 装配一致性 | `startup-verify.mjs` V1–V10、`scan-dangling.mjs`、`verify-patches.ps1` | 🟡 部分（缺 exports 字段、命名前缀、version 校验） |
| **C** Skill 格式 | frontmatter / kebab / 长度 / fail-closed | **无** | ❌ **完全无门禁** |
| **D** Skill 内容质量 | 结构 / 证据 / 可判定性 | **无** | ❌ **完全无门禁** |
| **E** 仓库治理 | node_modules / src∩lib / README / 版本 | **无** | ❌ **完全无门禁** |
| **F** 跨根 skill 管理 | 统一读写 | `dsh-skills-manager` | 🟡 仅可写 rank400，100/200/300 只读 |

**形象化**：现在有一条"插件流水线"（A→B 通，B 有缺口），和一条**根本不存在的"Skill 流水线"**（C→D 断），
以及一块无人看管的"仓库治理区"（E 断）。

---

## 四、规范化方案设计（**未实施，供批准**）

### 4.1 Skill 规范（目标态）

```
~/.dsh/skills/<kebab-name>/SKILL.md
---
name: <kebab-case>            # required，与目录名一致
description: "<≤500 字符，必须自带适用场景>"   # required，模型唯一触发依据
whenToUse: "<可选，人读/辅助>"                # 注意：不在 catalog 内
metadata:                                    # 官方可选，本规范定为**必填**
  version: 1.0.0
  owner: local
  status: active          # draft | review | active | deprecated | archived
  tags: [methodology, audit]
  since: 2026-09-07
  related: [evidence-driven-audit]
---
```

**关键决策**：把官方**可选**的 `metadata` 在**本系统内定为必填**，
用它承载生命周期状态——这是流水线化的最小可行抓手（不需要改任何官方代码）。

### 4.2 生命周期状态机

```
draft ──review──> active ──deprecate──> deprecated ──archive──> archived
  │                  │                       │
  └──────────────────┴───────────────────────┘
                  可回退（保留变更记录）
```

| 状态 | 含义 | catalog 行为 |
|---|---|---|
| `draft` | 草稿，未评审 | 建议 `disable-model-invocation: true`（官方字段，模型不可见） |
| `review` | 待评审 | 同上 |
| `active` | 生效 | 正常暴露 |
| `deprecated` | 不推荐，保留兼容 | 暴露但 description 前缀标注 |
| `archived` | 已归档 | 移出 skills 根，进 `_backups/` |

> `disable-model-invocation` 是**官方已支持的字段**，用它实现草稿态隔离是零成本方案。

### 4.3 插件规范（目标态）

| 项 | 目标 |
|---|---|
| 版本号 | 统一语义化版本，全部对齐；或明确"内部插件统一 0.1.0 + metadata 记录迭代" |
| `node_modules/` | 从版本库移除，加 `.gitignore` |
| `src/` 与 `lib/` | 二选一：**有 src 则 lib 不入库**（构建产物）；无 src 则 lib 即源码 |
| `dsh-routing-suite` | 补 package.json 或明确标注为"非插件·vendored 依赖"并移出 `plugins/` |
| 命名 | 统一 `@dsh-external/<name>` 前缀 |
| README | 补齐或明确"无 README 需登记理由" |

### 4.4 流水线设计（目标态 · 六段）

| 段 | 环节 | 要建的资产 | 门禁 |
|---|---|---|---|
| **1 开发** | 脚手架 | `scripts/new-skill.mjs`、`scripts/new-plugin.mjs`（生成合规骨架 + metadata 模板） | 骨架自带校验 |
| **2 校验** | lint | `scripts/lint-skills.mjs`（frontmatter/kebab/长度/metadata/fail-closed）<br>`scripts/lint-plugins.mjs`（exports/前缀/version/node_modules/src∩lib/README） | **CI 强制** |
| **3 装配** | 装配登记 | 复用 `startup-verify.mjs` + `scan-dangling.mjs` | 保留现有 |
| **4 发布** | 版本/变更 | 变更写入 `CHANGELOG.md`；skill 版本走 `metadata.version` | 人工确认 |
| **5 运维** | 健康 | 接入 `/health`（阶段 2 已规划），新增 `skills` 检查项 | 启动自检 |
| **6 退役** | 归档 | 状态置 `archived` → 移入 `_backups/`，保留回滚 | 留痕 |

### 4.5 源仓库与同步（解决 S2"仓库外"问题）

**问题**：`~/.dsh/skills/` 在 git 之外，改坏了不可回滚。

**建议方案（三选一，待定）**：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 镜像源 + 同步**（推荐） | 仓库内建 `skills/` 作为**唯一源**，`scripts/sync-skills.mjs` 单向同步到 `~/.dsh/skills` | 可审计可回滚；skill 保持 rank400 全局可用 | 多一步同步，需防"直接改运行时"漂移 |
| **B. 项目级 skill** | 移到 `<projectRoot>/.dsh/skills`（rank 100） | 天然进 git，优先级最高 | 只在 Deepseek-Harness 工作区可见，**失去全局性**（方法论 skill 应跨项目） |
| **C. 符号链接** | `~/.dsh/skills` → 仓库内 `skills/` | 一处维护 | Windows junction + watcher `followSymlinks` 行为需实测 |

> 方法论 skill 的价值在于**跨项目通用**，因此**推荐 A**（保持全局 + 可审计）。

---

## 五、优先级建议（待批准后再实施）

| 优先级 | 项 | 理由 |
|---|---|---|
| **P0** | 建 `scripts/lint-skills.mjs` 并接入 CI | 唯一"改坏无人知"的资产，成本最低（单文件、只读） |
| **P0** | 6 个 skill 补 `metadata`（version/status/tags） | 生命周期流水线的数据基础，纯 frontmatter 增补 |
| **P1** | skill 源纳入版本管理（方案 A 镜像同步） | 消除"仓库外不可回滚" |
| **P1** | 建 `scripts/lint-plugins.mjs`（仓库治理层 E） | node_modules / src∩lib / 版本 / README 全部无门禁 |
| **P1** | 补 `scripts/new-*.mjs` 脚手架 | 从源头防走样 |
| **P2** | 插件版本统一 + `dsh-skills-manager` 前缀补齐 | 一致性 |
| **P2** | `dsh-routing-suite` 定性（补 package.json 或移出 plugins/） | 消除形态歧义 |
| **P2** | 移除提交的 `node_modules/`、明确 src/lib 策略 | 构建确定性 |
| **P3** | 15 个插件补 README | 可维护性 |
| **P3** | F1/F2/F3 三项跨插件契约文档化 | 防静默失效 |

---

## 六、风险与注意事项（实施前必读）

1. **`metadata` 是官方允许但可选的字段** —— 自定义子字段（`status`/`tags`）不会被官方校验拒绝（open YAML object），
   但**不应依赖官方去解释它们**，只作为本系统的约定。需写进规范文档。
2. **`disable-model-invocation` 用在草稿态是安全的**，但要注意：一旦 skill 被该字段排除，模型完全看不到它，
   调试时容易误判为"skill 没生效"。建议在 `metadata.status` 里同步体现。
3. **改动 `~/.dsh/skills` 会触发 watcher 重发现** —— 批量改动 skill 时，frontmatter 的 `name` 变化会 reject stale name，
   可能导致短暂的 catalog 抖动。建议批量操作后重启一次。
4. **不建议把方法论 skill 移到 project 级（rank 100）** —— 会失去跨项目通用性，与方法论定位冲突。
5. **`dsh-skills-manager` 只写 rank400** —— 若采用方案 C（符号链接），需实测 watcher 的 `followSymlinks` 行为。

---

## 七、待确认问题（需用户决策）

| # | 问题 | 选项 |
|---|---|---|
| Q1 | skill 源仓库方案 | A 镜像同步（推荐）/ B 项目级 / C 符号链接 / D 维持现状 |
| Q2 | 插件版本策略 | 统一 0.1.0 / 语义化各自演进 / 统一到某基线 |
| Q3 | `dsh-routing-suite` 定性 | 补 package.json 转正 / 标注 vendored 并移出 plugins/ |
| Q4 | src 与 lib 策略 | lib 不入库（有 src 时）/ 删除 src（lib 即源）/ 维持并存 |
| Q5 | 是否把 lint 接入 CI 强制 | 强制阻断 / 仅警告 |

---

*本报告为分析稿，**未修改任何文件**。所有结论均附官方依据或实测证据。*
