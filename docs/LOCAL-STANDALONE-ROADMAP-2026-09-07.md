# DSH Desktop 单机本地化 · 修复与优化提升方案书

- 版本：v1.0
- 日期：2026-09-07
- 定位声明：**长期离线单机运行，仅在"升级日"主动访问上游**
- 上游基线：`@deepseek-ai/dsh@0.1.1-rc.2`（pin `b150a551`），壳 v2.0.2（分支 `prod-baseline-20260823` @ `0f5ae64`）
- 输入依据：`docs/AUDIT-2026-09-07-COMPREHENSIVE.md`（十维度审计，综合 6.4/10）

---

## 〇、方案定位：为什么单机化要换一套打法

审计时的评分是按"可持续演进的工程"打的分。一旦定位为**单机自用**，评分权重必须重排：

| 维度 | 团队/产品化项目的权重 | **单机自用项目的权重** | 结论 |
|---|---|---|---|
| 上游跟随能力 | 高 | **低**（一年 2-4 次） | 从"持续集成"降级为"周期事件" |
| 补丁可维护性 | 高 | **中**（升级日集中处理） | 可接受"升级日重打"，但必须**可感知失效** |
| 长期运行稳定性 | 高 | **最高** | 无人值守是核心诉求，优先级提到第一 |
| 数据不丢失 | 中 | **最高** | 单机无冗余，损坏=永久丢失 |
| 代码规范/lint | 高 | **低** | 单人维护，可读性 > 工具强制，可裁剪 |
| 团队协作流程 | 高 | **无** | 砍掉 commitlint/husky 等 |
| 离线自持 | 无 | **新增，高** | 断网时必须仍可用 |
| 回滚能力 | 中 | **最高** | 单机没有"别人帮你修"，回滚是唯一保险 |

**一句话**：把资源从"让人好协作"转移到"让机器别坏、坏了能自己好、好不了能退回去"。

---

## 一、五条设计原则

1. **离线优先（Offline-First）**：默认断开一切非必要外联；网络只在升级日开窗，用完即关。
2. **可逆优先（Reversible-First）**：任何改动必须有已验证的回滚路径，否则不做。单机没有第二次机会。
3. **自愈要动作不要通知（Act, Don't Just Notify）**：现有守护 90% 只弹提示。能自动处理的必须自动处理，只在需要人决策时才通知。
4. **失效必须响（Fail Loud）**：补丁失效、自愈失效、磁盘满——静默是单机最危险的失败模式。
5. **补丁最小化（Minimal Patch）**：整文件替换 → 最小 diff / 运行时 hook，把升级冲击面从 100% 降到 5%。

---

## 二、现状 → 目标态对照

| 维度 | 现状（实测） | 目标态 |
|---|---|---|
| 网络依赖 | update-watch / market / hy3 等多处可外联 | 默认全关，仅升级日开 `update-watch` |
| 上游版本 | `0.1.1-rc.2` 锁版，上游已到 `0.1.2-rc.1` | **主动冻结**，升级日才动 |
| 补丁 | 18 处（8 整文件替换 + 10 脚本注入） | ≤8 处，全部最小 diff + 强校验 |
| 主进程守护 | 无（唯一 SPOF） | 外部看门狗，崩溃自拉起 |
| 自愈类型 | 90% 通知型 | 70% 动作型 |
| 运行时数据 | `~/.dsh` 1.3GB，无回收 | 配额 2GB + 自动归档 + TTL |
| 日志 | super-injector 目录无轮转 | 统一轮转（50MB / 14 天） |
| 写安全 | 2 处高危非原子写 | 0 处 |
| 回滚 | dist 层 junction 有；数据层无 | 三层全有（dist / 配置 / 数据） |
| 测试 | 9 单测 / 30 插件 | 关键路径 20 单测 + 1 套启动冒烟 |

---

## 三、阶段总览

| 阶段 | 名称 | 周期 | 核心产出 | 门禁（DoD） |
|---|---|---|---|---|
| **0** | 单机化基线 | 1-2 天 | 外联封禁 + 版本冻结 + 离线快照 | 断网 30 分钟全功能可用 |
| **1** | 止血 | 1 周 | 消除不可逆损坏风险 | 0 高危非原子写；日志全轮转 |
| **2** | 自愈闭环 | 2-3 周 | 看门狗 + 动作型自愈 + 配额治理 | 90 天无人干预演练通过 |
| **3** | 债务清偿 | 1-2 月 | 补丁最小化 + 重复收敛 + 拆分巨型文件 | 补丁 ≤8 处，全部强校验 |
| **4** | 升级日机制 | 持续 | 雷达 + 沙箱预演 + rebase SOP + 回滚 | 完整演练 1 次成功 |
| **5** | 可选增强 | 按需 | 安全加固 / 体验优化 | — |

> **执行顺序不可颠倒**：阶段 1 的止血必须在阶段 3 的重构之前——在还有"写坏即损坏"风险时做重构，等于在雷区跑步。
>
> **横切能力**：§十「Agent 认知与执行优化」不属于任何单一阶段，是提升所有阶段执行质量的方法论层，
> 已于 2026-09-07 先行落地（6 个 skill + AGENTS.md 26 行增量），**需重启后生效**。
>
> **能力层增补**：见 `docs/CAPABILITY-OPTIMIZATION-2026-09-07.md`
> （安全 / 功能 / 工具调用 / 画图 / 生成 五维）。其中「画图稳健化」与「启用本地 hub 中的 72 个 skill」
> 属于**高收益低风险**，建议并入阶段 0-1 一并执行。

---

## 四、阶段 0：单机化基线（1-2 天）

### 4.1 外联点盘点与处置

| # | 外联点 | 位置 | 处置 | 理由 |
|---|---|---|---|---|
| 0-1 | 上游版本雷达 | `scripts/update-watch.mjs`（npm dist-tags + GitHub releases） | **保留但改为手动**，仅升级日运行 | 唯一的合法外联 |
| 0-2 | 社区市场 | `~/.dsh/settings.yaml:338` `dsh-community-market` + `dshmarket` 包 | **默认禁用**，需要装插件时临时开 | 市场会拉取远程插件包 |
| 0-3 | HY3 网关 | `hy3-gateway/server.js:229`（绑 127.0.0.1:8787，外联 CloudBase） | **按需启停**，不用即关 | 唯一真实业务外联，且消耗云端额度 |
| 0-4 | 内核匿名 ID | `@deepseek-ai/dsh-anonymous-user-id` | 评估后若无收益则在 patch 层禁用 | 减少不必要外发 |
| 0-5 | 自动更新检查 | 壳 `lib/updates.js` | **关闭自动检查**，改为升级日手动 | 避免后台静默下载 |
| 0-6 | Web 搜索/抓取插件 | `dsh-web-search-bing` / `dsh-web-fetch-local` | 保留（用户主动触发才外联） | 功能需要 |

**操作**：
```powershell
# 0-2 禁用市场（先备份）
Copy-Item ~/.dsh/settings.yaml ~/.dsh/settings.yaml.bak-$(Get-Date -f yyyyMMdd-HHmm)
# 编辑 settings.yaml：dsh-community-market.enabled: false

# 0-5 关闭自动更新：在 shell 设置中关闭 update autoCheck
```

### 4.2 版本冻结（Version Pinning）

**动作**：把"当前可运行组合"固化为一份可验证的清单文件 `docs/VERSION-BASELINE.md`：

| 项 | 值 | 校验方式 |
|---|---|---|
| 内核包版本 | `@deepseek-ai/dsh@0.1.1-rc.2` × 100+ | `yarn.lock` / `package.json` |
| upstream commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `vendor/.../upstream.json` |
| 壳分支/HEAD | `prod-baseline-20260823` / `0f5ae64` | `git rev-parse HEAD` |
| Electron | 43.4.0 | `package.json` |
| Node 运行时 | 22.19+ / 24+ | `engines` |
| profile 装配 | desktop 44 deps / 37 bundles | `~/.dsh/profiles/desktop/package.json` |
| 补丁集合 | `patches/bundles/MANIFEST.md` 8 项 SHA-256 | `verify-patches.ps1` |

**交付**：`scripts/freeze-baseline.mjs`（新增）——一键生成上述清单 + 所有 bundle 补丁的 SHA-256 + profile 快照，输出到 `_backups/baseline-<date>.json`。**升级日的回滚锚点就是它。**

### 4.3 离线应急快照

单机最大的恐惧是"坏了修不好"。建立一个**可离线恢复的最小恢复集**：

```
_backups/recovery-kit/
  ├── baseline-2026-09-07.json      # 4.2 的版本清单
  ├── profile-desktop-package.json  # profile 装配快照
  ├── patches/bundles/*             # 8 个补丁 canon 副本
  ├── settings.yaml                 # 配置快照
  └── RESTORE.md                    # 人工恢复步骤（不依赖任何脚本）
```

**关键**：`RESTORE.md` 必须是**纯人工可执行的文字步骤**（复制哪个文件到哪），不能依赖脚本——脚本本身可能就是坏的。

### 4.4 阶段 0 门禁

- [ ] 断网 30 分钟：启动应用、开会话、用文件浏览器、跑本地搜索 —— 全部正常
- [ ] `_backups/recovery-kit/` 存在且 `RESTORE.md` 可按文字恢复
- [ ] `baseline-<date>.json` 生成成功，8 个补丁 SHA-256 与 MANIFEST 一致

---

## 五、阶段 1：止血（1 周）

> **目标：消除所有"一次意外 = 永久损坏"的路径。**

### 5.1 任务清单

| # | 任务 | 涉及文件 | 要点 | 风险 |
|---|---|---|---|---|
| 1-1 | 非原子写清零 | `dsh-host-services/lib/index.js:205`、`dsh-modlens-guard/lib/index.js:152,173` | 改 `tmp + rename`，复用 `dsh-atomic-write` | 低 |
| 1-2 | 日志全局轮转 | `~/.dsh/super-injector/*.log` 等 5 处 | 统一 50MB / 14 天双阈值 | 低 |
| 1-3 | `~/.dsh` 配额与自动归档 | `dsh-self-maintenance`、`dsh-session-hygiene`、`scripts/archive-big-sessions.ps1` | 见 5.2 | 中 |
| 1-4 | 主进程看门狗 | 新增 `scripts/install-watchdog.ps1` | 见 5.3 | 中 |
| 1-5 | 前端 fetch 统一超时 | 5 个 client.js（file-explorer / model-picker-group / skills-manager / vision-engine / model-whitelist） | 抽 `clientFetch()` 带 AbortController | 低 |
| 1-6 | stream error 兜底 | 已修（P1-5），补回归测试 | — | 低 |
| 1-7 | 写锁强制化 | `scripts/deregister-plugin.mjs`、`startup-verify.mjs` | 写入前强制 acquire | 低 |

### 5.2 任务 1-3 详解：`~/.dsh` 配额治理

**现状痛点**（实测）：
- `~/.dsh` = 1.3GB（profiles 783M / sessions 372M / attachments 50M / storages 40M）
- 单项目会话 `--D-Deepseek-Harness--` = **249M**
- `session-hygiene` 只按**单文件** >4MB 判定 → 249M 会话永不告警

**改造方案**：

| 层 | 改动 | 位置 |
|---|---|---|
| 检测 | 卫生监控增加**目录聚合**：单会话目录 >150MB 即告警（当前只看单文件） | `dsh-session-hygiene/lib/index.js:13-19` |
| 动作 | 从"只通知"升级为"**自动归档**"：闲置 >7 天 且 >150MB 的会话自动移入 `_backups/archived-sessions-<ts>/` | 复用 `scripts/archive-big-sessions.ps1` 逻辑 |
| 配额 | `self-maintenance` 增加**本机数据配额**检查（非磁盘剩余）：`~/.dsh` > 2GB warn / > 3GB 强告警并自动清理 attachments（TTL 90 天） | `dsh-self-maintenance/lib/index.js:274-278` |
| 安全网 | 归档只**移动**不删除，且在 `_backups/` 内可移回 | 已有机制 |

**关键约束**：自愈动作必须满足"**只移动、不删除、可回退、留日志**"四条，否则不许自动化。

### 5.3 任务 1-4 详解：主进程看门狗

当前唯一 SPOF。方案（二选一，推荐 A）：

**A. Windows 任务计划（推荐，零侵入）**
```powershell
# scripts/install-watchdog.ps1
# 每 5 分钟检查：43120 端口无响应且无 DSH 进程 → 拉起 dist\win-unpacked\DSH Desktop.exe
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -File D:\Deepseek-Harness\scripts\ensure-dsh-running.ps1"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "DSH-Watchdog" -Action $action -Trigger $trigger -RunLevel Limited
```
护栏（必须）：
- 检测"应用是否正在启动中"（进程存在但端口未起）→ 不重复拉起
- 连续 3 次拉起失败 → 停止并弹通知（避免启动死循环）
- 所有动作写 `~/.dsh/watchdog.log`（带轮转）

**B. 应用内守护（侵入式，不推荐）**：需改壳代码，重建即丢，与"补丁最小化"原则冲突。

### 5.4 阶段 1 门禁

- [ ] `grep -rn "writeFileSync" plugins/*/lib/*.js` 高危项归零（配置/补丁类文件）
- [ ] 连续运行 7 天，所有日志体积不再单调增长（有轮转）
- [ ] `~/.dsh` 体积周增长 <100MB 或触发自动归档
- [ ] 手动 kill 主进程 → 5 分钟内自动恢复
- [ ] `verify-patches.ps1` 仍 ALL PASS

---

## 六、阶段 2：自愈闭环（2-3 周）

> **目标：从"通知型"转向"动作型"，达成 90 天无人干预。**

### 6.1 自愈动作化改造表

| 守护 | 现状 | 改造后动作 | 需人工决策的才通知 |
|---|---|---|---|
| `dsh-session-hygiene` | >4MB 提醒 / >8MB 告警 | **自动归档**闲置 >7天 且 >150MB | 无 |
| `dsh-self-maintenance` | 磁盘 <5GB warn | 磁盘 <3GB 时**自动清理** attachments(TTL 90d) + 30 天前日志 | <2GB 才通知 |
| `dsh-instance-janitor` | 白名单杀 crashpad/旧网关 | 扩充白名单：无窗口 DSH 子进程闲置 >2h 一并清理 | 无 |
| `dsh-self-maintenance` | GUI 卡顿仅提示重启 | **连续 3 次探测失败 → 自动重启主进程**（经看门狗通道） | 连续失败才通知 |
| `dsh-model-provider-failover` | 默认 no-op | **配置默认 fallback**（用户确认后启用） | 配置需人工 |
| `dsh-modlens-guard` | 守错 profile（web，非活跃 desktop） | **改守 desktop profile** | — |

### 6.2 健康检查统一端点

现状已有 `/self-maintenance/status`、`/instance-janitor/status`、`/session-hygiene/report`、`/task-scheduler/*`、`/command-guard/*`，但**分散、无统一入口、无聚合健康分**。

**改造**：新增 `dsh-host-services` 提供 `/health` 聚合端点：

```json
{
  "ok": true,
  "ts": "2026-09-07T00:45:00+08:00",
  "checks": {
    "webserver":   { "ok": true },
    "sessions":    { "ok": true,  "bytes": 372000000, "quota": 2147483648 },
    "disk":        { "ok": true,  "freeGB": 120 },
    "patches":     { "ok": true,  "verified": 8, "total": 8 },
    "plugins":     { "ok": false, "failed": ["dsh-x"] },
    "logs":        { "ok": true,  "totalMB": 12 }
  }
}
```
用途：① 看门狗探测依据（比"端口通"更准）② 升级日验收 ③ 日常一眼看健康。

### 6.3 启动自愈钩子

启动时自动执行（顺序固定）：
1. `verify-patches.ps1` → 缺失补丁**自动重打**（不再依赖人记得）
2. `scan-dangling.mjs` → 悬空依赖自动报告（不自动删）
3. `/health` 自检 → 异常写入启动日志

### 6.4 阶段 2 门禁

- [ ] `/health` 端点返回全绿，覆盖 6 项检查
- [ ] 模拟"会话膨胀到 200MB"→ 24h 内自动归档
- [ ] 模拟"日志写满 60MB"→ 自动轮转
- [ ] **90 天无人干预演练**：连续运行 14 天（压缩验证）+ 配额模型外推通过
- [ ] kill 主进程 / 制造会话膨胀 / 制造磁盘压力 三项故障注入全部自动恢复

---

## 七、阶段 3：债务清偿（1-2 月）

> **目标：把"升级税"从 100% 降到 5%。这是单机模式下最重要的长期投资。**

### 7.1 补丁最小化（最高优先级）

**现状致命点**：`patches/bundles/dsh-session-persistence-jsonl-index.js` 是 **57KB 整文件替换**。上游 0.1.2 会话格式升级到 v2 后，这个文件 100% 作废，且**无法 rebase**（只能重写）。

**改造优先级**（按"上游改动概率 × 替换体积"排序）：

| 补丁 | 体积 | 改造方案 | 优先级 |
|---|---|---|---|
| `dsh-session-persistence-jsonl-index.js` | 57KB | **最高危**。尽量改为运行时 hook（在插件层 monkey-patch zstd 解压），不替换文件 | **P0** |
| `dsh-client-ui-conversation-client.js` | 448KB | 定位实际改动点，改为最小 diff | P1 |
| `dsh-client-ui-settings-models-client.js` | 135KB | 同上 | P1 |
| `dsh-client-ui-workspace-client.js` | 116KB | 同上 | P1 |
| `modlens-dsh-index.js` | 87KB | 同上 | P1 |
| `dsh-client-ui-directory-picker-browse-client.js` | 55KB | 同上 | P2 |
| `dsh-host-frontend-static-index.js` | 4KB | 已是小文件，保持 | P3 |
| `safe-delete-shim.cjs` | 5KB | 独立 shim，保持 | P3 |

**同时**：把 `scripts/apply-*.mjs` 的 ~10 个脚本补丁**登记进 `MANIFEST.md`**（当前只有 8 个 bundle 有 SHA-256，脚本补丁无登记 → 升级后无法校验是否存活）。

### 7.2 校验从"弱"到"强"

`verify-patches.ps1:63-71` 当前用 `Select-String -SimpleMatch`（子串匹配）→ **marker 在但语义损坏仍 PASS**。

**改造**：
1. 保留 marker 检查（快速失败）
2. **增加 SHA-256 校验**（对比 MANIFEST 登记值）
3. **增加行为断言**：至少 2 个补丁加"功能探针"（如 zstd 异步解压：造一个测试文件验证能解）
4. `$ErrorActionPreference` 从 `SilentlyContinue` 改为显式 try/catch（当前会吞掉脚本自身异常）

### 7.3 重复代码收敛（分两批，沿用既有 P2/P3 计划）

| 批次 | 收敛项 | 当前分布 | 目标 | 风险 |
|---|---|---|---|---|
| 第一批 | 退避注册样板、24h 去重通知、loopback 校验 | 5 插件各自重写 | 统一到 `dsh-host-services/lib/shared-utils.js` | 低 |
| 第二批 | log helper、原子写 | 5 插件各自重写 | 统一导出 | 中 |
| 第三批 | SSRF HTTP 客户端（fetch-local 与 bing 逐行复制） | 2 插件 | 共享模块 | **高**（安全敏感，需单独评审） |

> 第三批建议与"升级日"合并执行，不在常规迭代里动。

### 7.4 巨型文件拆分

`plugins/dsh-routing-suite/injector/lib/index.js` **9732 行** —— 全仓最大可维护性风险点。

**策略**：先按职责切 5-8 个模块（**不改行为**），每切一个跑一次 `node --check` + 启动验证。不要重写。

### 7.5 测试补齐（按需，不追求覆盖率）

优先级排序（只补"坏了会静默出错"的）：
1. `dsh-model-tier-router` 分类逻辑（纯函数，好测）
2. `dsh-model-provider-failover` 冷却/路由决策（已有 fake-ctx 基础）
3. `dsh-session-hygiene` 阈值判定（改造成目录聚合后必测）
4. `dsh-task-scheduler` 锁回收（已有，补边界）
5. `dsh-web-fetch-local` SSRF 守卫（安全敏感）

**CI 补强**（单机也要有，因为它是"升级日"的第一道防线）：
```yaml
- node --check (已有)
- tsc --noEmit (新增)
- node --test tests/ (已有)
- 启动冒烟：spawn exe → 等 /health → assert (新增，最关键)
```

### 7.6 阶段 3 门禁

- [ ] 补丁数 ≤8，且**整文件替换类 ≤2 个**
- [ ] 所有补丁有 SHA-256 + 至少 1 个行为断言
- [ ] `verify-patches.ps1` 故意破坏一个补丁 → 必须 FAIL（验证校验有效）
- [ ] shared-utils 复用率 ≥20/30
- [ ] `routing-suite` 单文件 ≤2000 行
- [ ] CI 含启动冒烟，且能捕获"启动即崩"

---

## 八、阶段 4：升级日机制（核心，持续运行）

> **单机模式下，"升级"是一件需要仪式感的事。把它流程化，是防止"升级即崩"的唯一办法。**

### 8.1 升级雷达（平时只读，不动作）

`scripts/update-watch.mjs` 已存在（npm dist-tags + GitHub releases，只读，写 `_backups/update-watch-latest.json`）。

**改造**：增加**破坏性变更预警**——对比当前 baseline 与目标版本，标红以下信号：
- 会话格式版本变化（如 v1 → v2）→ **红色警报**
- persistence API 破坏性变更
- 被补丁覆盖的包版本变化 → 列出受影响的补丁清单

**频率**：每月手动跑 1 次即可，或订阅 GitHub Release 邮件。

### 8.2 升级日 SOP（12 步，不可跳步）

| 步 | 动作 | 命令/工具 | 失败处理 |
|---|---|---|---|
| 1 | 触发决策：确有需要（安全修复 / 必需功能）才升级 | 人工 | 跳过本次 |
| 2 | 生成新 baseline 快照 | `node scripts/freeze-baseline.mjs` | 中止 |
| 3 | 全量备份（dist + `~/.dsh` + 仓库工作区） | `scripts/` + robocopy | 中止 |
| 4 | 读上游 release notes，**标记破坏性变更** | 人工 | 有破坏性变更 → 加倍谨慎 |
| 5 | **列出受影响补丁清单**（哪些补丁打在被升级的包上） | 新增 `scripts/patch-impact.mjs` | — |
| 6 | 在**副本环境**预演（复制 `~/.dsh` 到 `~/.dsh-test`，用独立 profile 启动） | 新增 `scripts/upgrade-rehearsal.ps1` | 失败即中止 |
| 7 | 逐个 rebase 受影响补丁 | `scripts/port-user-patches.mjs` | rebase 失败 → 评估放弃该补丁 |
| 8 | 重建 | `scripts/package-vendor.ps1` | — |
| 9 | 补丁校验 | `scripts/verify-patches.ps1`（**必须 ALL PASS**） | 失败即回滚 |
| 10 | 换版 | `scripts/promote-build.ps1`（内置 smoke + 回滚） | 自动回滚 |
| 11 | 启动验收 | `/health` 全绿 + 插件清单完整 + 开一个测试会话 | 失败即回滚到旧 build |
| 12 | 观察 48h 后固化新 baseline | `freeze-baseline.mjs` | — |

### 8.3 补丁 rebase SOP

```
对每个受影响补丁：
  a. 取上游新版本原始文件（.orig-npm 机制已有）
  b. diff 当前补丁 vs 当前原始 → 提取"真实改动集"
  c. 将改动集应用到新版原始文件
  d. 冲突 → 三选一：① 人工合并 ② 改为运行时 hook ③ 放弃该补丁（记录到 KNOWN-GAPS.md）
  e. 更新 MANIFEST.md 的 SHA-256
  f. 跑 verify-patches + 行为断言
```

**关键心态**：**允许放弃补丁**。单机模式下，"少一个优化"远好过"整个应用起不来"。放弃的补丁登记到 `docs/KNOWN-GAPS.md`，等上游自己修。

### 8.4 三层回滚预案

| 层 | 回滚方式 | 耗时 | 覆盖场景 |
|---|---|---|---|
| 应用层 | `promote-build.ps1` 切回上一 build（junction） | <1 分钟 | 新版本起不来 |
| 配置层 | `~/.dsh/settings.yaml.bak-*` + profile 快照 | <5 分钟 | 配置写坏 |
| 数据层 | `_backups/recovery-kit/` + `RESTORE.md` 人工步骤 | <30 分钟 | 最坏情况 |

### 8.5 升级日门禁

- [ ] 备份已验证可恢复（**至少做过一次恢复演练**）
- [ ] 预演环境通过
- [ ] `verify-patches` ALL PASS
- [ ] `/health` 全绿
- [ ] 旧 build 未被删除（保留 ≥2 个历史 build）

---

## 九、阶段 5：可选增强（按需）

| # | 项 | 收益 | 成本 | 建议 |
|---|---|---|---|---|
| 5-1 | `runAsNode` fuse 熔断改造 | 安全 | 高（需重构 sandbox trampoline） | 单机风险有限，**可延后** |
| 5-2 | 凭据 DPAPI 加密 | 安全 | 中 | 若机器共用则做 |
| 5-3 | 插件完整性校验 | 安全 | 中 | 单机且 agent 能写文件时建议做 |
| 5-4 | 双装配通道收敛 | 可维护性 | 高 | 单机收益低，**优先级下调** |
| 5-5 | 15 个插件补 README | 可维护性 | 低 | 建议做（未来自己也会忘） |
| 5-6 | ESLint / Prettier | 规范 | 低 | 单机可选，但 Prettier 格式化值得装 |
| 5-7 | 50 个一次性调试脚本清理 | 整洁 | 低 | 建议做 |

---

## 十、Agent 认知与执行优化（已实施 2026-09-07）

> **背景**：用户要求把"外部 agent 的工作方式优点"（工具调用、思考逻辑、执行纪律）适配进 DSH，
> 让 DSH 自身的思考与执行也获得同样的提升。本节记录设计依据与已落地内容。

### 10.1 关键设计约束：为什么不能塞进 AGENTS.md

`~/.dsh/AGENTS.md` 会被内核**自动加载到所有会话**，膨胀代价极高。`anchored-standard` 的注释里
有一条实测结论（本项目自己的经验）：

> 9KB 的 `<available_skills>` catalog 常驻注入，使模型锚定率从 **81% 跌到 0%**。

因此设计原则：**常驻规则极简，方法论走按需加载**。

| 载体 | 加载方式 | 适合放什么 |
|---|---|---|
| `~/.dsh/AGENTS.md` | **常驻，所有会话** | 极高频、跨任务的纪律条目（每条 1-2 行） |
| `~/.dsh/skills/*.SKILL.md` | **按需**（`skill_search` / `skill_load`） | 完整方法论、判定表、案例（50-80 行） |
| agent preset yml | 常驻但按预设隔离 | 工具编排、bootstrap 策略（改动风险高，本期不动） |

### 10.2 已实施内容

**① 新增 6 个方法论 skill**（`~/.dsh/skills/`，此前该目录为空）

| Skill | 行数 | 解决什么 |
|---|---|---|
| `parallel-execution` | 54 | 并行 vs 串行的判定标准；批量核实模式 |
| `evidence-driven-audit` | 69 | 结论必须带 `路径:行号`；实测/推断/未验证三级置信度 |
| `falsification-check` | 62 | 不轻信子代理与工具；四类断言必复核（含本项目真实翻车案例） |
| `verify-by-fault-injection` | 66 | 「它通过了」≠「它有效」；弱校验识别表 |
| `subagent-orchestration` | 80 | 大仓库按正交切面派代理；主代理只做综合 |
| `multi-step-tracking` | 67 | ≥3 步建清单；按可验证产出拆粒度 |

**② `~/.dsh/AGENTS.md` 最小增量**：101 行 → 127 行（**净增 26 行**），新增「认知与执行纪律」节，
每条 1-2 行 + 指向对应 skill，含 `quick` 预设无 skill 工具时的**直接读文件兜底**说明。

### 10.3 这六条为什么是"外部 agent 的优点"而非重复造轮子

对照全局 AGENTS.md 原有内容，已有的是：五段流程、风险收益评估、相似问题排查、工作区感知、
安全守则、插件删除协议、多对话协作铁律。**缺的是"认知与执行层"的纪律**：

| 新增条目 | 原有规则里缺的部分 |
|---|---|
| 并行优先 | 完全未覆盖（最大的隐性耗时来源） |
| 证据驱动 | 「工作区感知」只要求"先查看"，未要求结论带证据与置信度分级 |
| 证伪义务 | 完全未覆盖（本次审计已实证：子代理报"空壳"实为 316 行完整实现） |
| 故障注入 | 完全未覆盖（"验证"只被要求执行，未被要求证明有效性） |
| 大仓库分工 | 完全未覆盖 |
| 多步追踪 | 完全未覆盖 |

### 10.4 验证证据

- 6 个 SKILL.md 的 YAML frontmatter 全部解析通过，`name` / `description` / `whenToUse` 三字段齐全，
  skill 名与目录名一致（kebab-case）：**6 OK / 0 FAIL**
- `AGENTS.md` 回读确认：新增节结构完整，位于「工作流程铁律」之后、「自动更新授权」之前
- 备份：`~/.dsh/AGENTS.md.bak-20260907-005225`

### 10.5 后续可扩展（未做，风险较高）

| 项 | 内容 | 为什么暂不做 |
|---|---|---|
| Preset 层 | 新建 `audit` 预设：bootstrap 工具给 `grep/glob/read/bash`，按需解锁 web | 改 preset 影响启动链路，需重启验证，与"最小改动"冲突 |
| `instruction-hint.mjs` | 注入更丰富的行为提示 | 注入量增大会扰动轨迹，收益不确定 |
| compaction 调参 | 审计类会话保留更多上下文 | 需实测，贸然改影响所有会话 |
| 更多 skill | 从实际踩坑里持续沉淀 | 建议**按需增量**，不要一次性堆砌 |

> **沉淀机制**：后续每次踩坑/发现新方法论时，新增一个 skill 而不是往 AGENTS.md 加行。
> 保持常驻文件 ≤150 行是硬约束。

### 10.6 回滚

```powershell
Copy-Item ~/.dsh/AGENTS.md.bak-20260907-005225 ~/.dsh/AGENTS.md -Force
Remove-Item ~/.dsh/skills/parallel-execution, ~/.dsh/skills/evidence-driven-audit,
  ~/.dsh/skills/falsification-check, ~/.dsh/skills/verify-by-fault-injection,
  ~/.dsh/skills/subagent-orchestration, ~/.dsh/skills/multi-step-tracking -Recurse
```

---

## 十一、风险登记册

| # | 风险 | 概率 | 影响 | 缓解 | 阶段 |
|---|---|---|---|---|---|
| R1 | 上游 0.1.2 会话格式 v2 与现有 372M 历史会话不兼容 | 高 | 高 | **不升级**；如必须升，先单独备份 sessions 并测试迁移 | 4 |
| R2 | 补丁失效但校验仍 PASS（静默） | 中 | 高 | 阶段 3 强校验改造 | 3 |
| R3 | 自动归档误删未备份数据 | 低 | 极高 | 归档**只移动不删除** + 全部进 `_backups/` | 2 |
| R4 | 看门狗启动死循环（应用启动即崩，反复拉起） | 中 | 中 | 连续 3 次失败即停 + 通知 | 1 |
| R5 | 自愈动作本身有 bug，造成数据移动混乱 | 中 | 高 | 所有自动动作先 dry-run 一周 + 留审计日志 | 2 |
| R6 | 重构 `routing-suite` 引入回归 | 中 | 中 | 只切分不重写，每步验证 | 3 |
| R7 | 断网后某些功能静默降级（如市场/更新） | 中 | 低 | 阶段 0 断网演练覆盖 | 0 |
| R8 | 单机无备份，硬盘故障 = 全损 | 低 | 极高 | 建议**额外做整机/数据异地备份**（本方案之外） | 0 |

---

## 十二、验收门禁总表

| 阶段 | 门禁项 | 判定 |
|---|---|---|
| 0 | 断网 30 分钟全功能可用 | 手动 |
| 0 | `recovery-kit/RESTORE.md` 可人工执行 | 演练 |
| 0 | 6 个方法论 skill 可被发现（`skill_search` 或直接读文件兜底） | 手动，重启后 |
| 1 | 高危非原子写 = 0 | grep |
| 1 | 日志 7 天不再单调增长 | 观测 |
| 1 | kill 主进程 → 5 分钟自动恢复 | 故障注入 |
| 2 | `/health` 6 项全绿 | 端点 |
| 2 | 会话膨胀 → 24h 自动归档 | 故障注入 |
| 2 | 14 天连续运行 + 90 天外推通过 | 观测 |
| 3 | 故意破坏补丁 → verify 必须 FAIL | 故障注入 |
| 3 | 整文件替换类补丁 ≤2 | 统计 |
| 3 | CI 含启动冒烟 | CI |
| 4 | 升级日完整演练 1 次成功 | 演练 |
| 4 | 回滚演练 1 次成功 | 演练 |

---

## 附录 A：单机化配置清单

```yaml
# ~/.dsh/settings.yaml（建议值）
dsh-community-market:
  enabled: false          # 需要装插件时临时开
updates:
  autoCheck: false        # 仅升级日手动
telemetry:
  enabled: false          # 如存在该开关
```

```powershell
# 需要联网时（升级日）：
# 1. 开市场：临时改 settings.yaml → 装完改回
# 2. 跑雷达：node scripts/update-watch.mjs
# 3. 用完确认无后台外联进程
```

## 附录 B：监控项与阈值

| 项 | warn | 动作阈值 | 自动动作 |
|---|---|---|---|
| `~/.dsh` 总大小 | 2 GB | 3 GB | 清理 attachments(TTL 90d) + 30 天前日志 |
| 单会话目录 | 150 MB | 200 MB + 闲置 7 天 | 自动归档到 `_backups/` |
| 单日志文件 | 50 MB | 50 MB | 轮转 |
| 日志总留存 | 14 天 | 14 天 | 删除最旧 |
| 磁盘剩余（系统） | 5 GB | 3 GB | 自动清理 |
| 主进程心跳 | 2 次失败 | 3 次失败 | 自动重启 |
| 补丁校验 | 任意 FAIL | 任意 FAIL | 启动自愈重打 + 通知 |

## 附录 C：常用命令速查

```powershell
# 健康检查
curl http://127.0.0.1:43120/health

# 补丁校验（重建后必跑）
powershell -ExecutionPolicy Bypass -File scripts\verify-patches.ps1

# 启动预检
node scripts\startup-verify.mjs

# 悬空依赖巡检
node scripts\scan-dangling.mjs --strict

# 版本基线快照（升级日前必跑）
node scripts\freeze-baseline.mjs

# 上游雷达（升级日）
node scripts\update-watch.mjs

# 插件语法校验
node --check plugins\<name>\lib\index.js

# 会话归档（手动）
powershell -File scripts\archive-big-sessions.ps1   # 默认 dry-run
```

---

## 附录 D：本方案明确**不做**的事

为避免资源浪费，以下在单机定位下**主动放弃**：

1. **不做** husky / commitlint / PR 模板 —— 单人无协作收益
2. **不做** 完整单测覆盖率门禁 —— 只补关键路径
3. **不做** 双装配通道彻底收敛 —— 收益 < 风险，维持双通道 + 文档警示
4. **不做** `runAsNode` 熔断改造 —— 成本高，单机威胁模型下收益有限（登记为已知风险）
5. **不做** 跟随上游每个版本 —— 只在有明确收益时升级
6. **不做** 插件签名体系 —— 用目录权限 + 人工审计替代

---

*本方案书为规划文档，未修改任何项目文件。实施时每项改动请遵循既有守则：先 acquire 锁 → 备份 → 原子写 → 验证 → release，且改动后不自动重启，等用户明确指示。*
