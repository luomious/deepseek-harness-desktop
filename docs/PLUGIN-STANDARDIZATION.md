# 本地插件统一规范（Interface Standardization）

> 创建 2026-09-02。目的：把 `D:\Deepseek-Harness\plugins\` 与顶层 `dsh-*` 共 30 个本地插件
> 收敛到一套可读、可维护、可迭代、可扩展的统一接口规范。
> 本文档是只读规划 + 试点记录；任何对装配方式的改动都须分批、备份、重启验证。

---

## 1. 核心发现：两种装配通道（必须先分类，不可一刀切）

`dev_plugin_status` + `profile/cordis.patch.yml` + `profile/package.json#dsh.profile.bundles` 交叉核对：

| 装配方式 | 判定 | 插件数量 | 插件清单 |
|---|---|---|---|
| **patch-insert** | 在 **profile 的 `cordis.patch.yml`** 的 `insert` 列表，**不在** `dsh.profile.bundles` | 8 | file-explorer、force-reasoning-effort、project-brief、session-watchdog、system-notify、remote-workspace、task-scheduler、frontend-reload |
| **bundles-only** | 在 profile `dsh.profile.bundles` 数组，包自带 `dsh.bundle.patch` 声明 | 27（含 npm 插件） | model-picker-group、command-guard、prompt-enhance、tool-renderers、host-services、web-fetch-local、web-search-bing、session-history、session-hygiene、self-maintenance、stuck-loop-guard、context-lifecycle、model-tier-router、model-whitelist、modlens-guard、modlens-autoread、vision-engine、skills-manager、hy3-gateway、ui-performance 等 + npm 插件 |

**结论**：给 patch-insert 插件盲补 `dsh.bundle` 声明 / 新建 `cordis.patch.yml` = 改成双装配，
会触发历史上反复出现的「bundles + patch 双装配冲突」（2026-08-31 tool-visibility、command-guard、
file-explorer 事故均属此类）。**统一规范必须按通道分类对齐。**

---

## 2. 统一规范模板（按通道）

### 2.1 bundles-only 插件（推荐目标态，参考 dsh-model-picker-group）

```
my-plugin/
  package.json
    "type": "module",
    "main": "./lib/index.js",                 # 统一带 ./
    "exports": { ".": "./lib/index.js",
                 "./client": "./lib/client.js",   # 有 client 才加
                 "./package.json": "./package.json" },
    "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
             "client": { "platform": "web", "inject": [...], "immediately": false } }
  cordis.patch.yml      # - insert: [{id, name}]
  lib/index.js          # export name / inject / apply(ctx)
  lib/client.js         # 可选，client 入口
```

### 2.2 patch-insert 插件（8 个，保持精简，勿加 dsh.bundle）

```
my-plugin/
  package.json
    "type": "module",
    "main": "./lib/index.js",
    "exports": { ".": "./lib/index.js", "./package.json": "./package.json" }
    # 不要 dsh.bundle / 不要自带 cordis.patch.yml —— 装配由 profile/cordis.patch.yml 的 insert 行负责
  lib/index.js
```

---

## 3. 阶段 1 试点（2026-09-02，已完成）

| 插件 | 改动 | 风险 | 验证 |
|---|---|---|---|
| dsh-model-picker-group（bundles-only） | `main`：`lib/index.js` → `./lib/index.js` | 低（语义等价） | JSON OK、startup-verify 10/10、scan-dangling 0 |
| dsh-task-scheduler（patch-insert） | 补 `exports`（`.`、`./package.json`） | 低（不影响装配） | JSON OK、保持无 dsh.bundle、装配未变 |

备份：
- `_backups/pkg-task-scheduler.20260902-150328.json`
- `_backups/pkg-model-picker-group.20260902-150328.json`

锁：task-scheduler acquire/release 已登记（summary 含本记录）。

---

## 4. 阶段 2（2026-09-02 已完成，一次性批量）

对 16 个本地插件 `package.json` 做纯元数据规范化（**不碰装配方式、不碰代码**）：

| 改动 | 数量 | 说明 |
|---|---|---|
| `main` 统一加 `./` 前缀 | 12 | `lib/index.js` → `./lib/index.js` |
| 补 `exports`（`.`、`./package.json`） | 5 | command-guard、project-brief、self-maintenance、session-watchdog、session-hygiene |
| 两者都改 | 1 | dsh-session-hygiene |
| 保留 `dsh.bundle` | 13 | bundles-only（本就该有） |
| 保持**无** `dsh.bundle` | 3 | patch-insert：force-reasoning-effort、project-brief、session-watchdog（**禁止**加） |

验证：16/16 `main`/`exports`/编码/装配分类全 OK；`startup-verify 10/10`；`scan-dangling 0`。
备份：`_backups/pkg-<name>.20260902-152234.json`（16 份）。
状态：**已重启验证通过（2026-09-02）**——`dev_plugin_status` 16 个插件全部 active，装配无回归。
结论：阶段 1+2（低风险规范化）**全部收官**。阶段 3/4 为远期高风险项，留待专门迭代。

---

## 5. 阶段 3 / 4 计划（未执行，需分批 + 重启验证）

- **阶段 3（装配收敛，远期可选，高风险）**：
  - 把 8 个 patch-insert 逐步并入 bundles（或反之），消除双通道；每迁移 1 个必须完整重启验证
- **阶段 4（构建统一，远期）**：手写 lib → `src/*.ts` + tsdown（模板见 skill `dsh-bundle-plugin-dev`）

> 每个阶段改动前：acquire 锁 → 备份 → 原子写 → `node --check` + `startup-verify` + `scan-dangling` → release 登记。
> 涉及装配的改动一律由用户重启后验证，不自动重启。
