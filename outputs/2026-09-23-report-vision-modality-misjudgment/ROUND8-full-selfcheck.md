# ROUND8 · DSH 全面自检（内置验证器 + 三切面并行审计 + 配置/仓库切面）与修复

> 2026-09-23 深夜 · 承接 ROUND7。用户要求「对 DSH 继续全面自检，看看有没有其他问题」。
> 方法：先跑全部内置验证器，再按**正交切面**派 3 个子代理并行深审（日志错误 / 运行态与存储卫生 / 插件与机制），
> 我自己补做**未被分配**的切面（配置健全性、陈旧双胞胎、仓库版本控制状态、健康探针语义）。
> 每条结论标注「实测 / 推断 / 未验证」；子代理结论一律复核后才采信（本轮**修正了 3 条**）。

## 1. 内置验证器（全绿，实测）

| 验证器 | 结果 |
|---|---|
| `check-all.ps1` | **ALL PASS**（含 Step 1–4：语法 / 健康 / 悬空 / 技能 / 补丁锚点 / 单元测试 298 / 冒烟 24 项） |
| `verify-patches.ps1` | **ALL PASS (78 checks)**（本轮新增 2 条） |
| `startup-verify.mjs` | **10/10 PASS**（V1 bundles=50 可解析、V2 相等、V3 insert=10 disabled=0、V4 无孤儿、V5 dist junction 正确、V7 无锁文件、V9 link 插件 41/97 文件全 ok、V10 bundles 全声明且 patch 在位） |
| `scan-dangling.mjs --strict` | `DANGLING=0 STALE-DECL=0 ORPHAN=0 NOT_INSTALLED=0 INFO=0` |
| `audit-plugin-inventory.mjs` | `PASS=11 WARN=0` |
| `GET /health` | **9 绿 1 红**；唯一红 `preflight` = 历史窗口型（见 §5.3），**约 09-24 15:09 自动转绿** |

## 2. 本轮执行的四项修复（都有证据 + 回滚路径）

### 2.1 补齐 10 个模型的 `contextWindow`（配置侧，已写入并持久化）
- **问题（实测，运行态）**：`modelscope/deepseek-ai/DeepSeek-V4.1-Flash` 的会话投影显示 `contextWindow = 262144` —— 即内核兜底默认（`dsh-llm-pi-ai/lib/index.js:639` 链 `entry.contextWindow ?? base?.contextWindow ?? defaultContextWindow(262144)`）。该模型真实窗口是 1M ⇒ 用它会**提前压缩**。
- **范围**：12 个模型缺该字段；其中 10 个有**权威依据**（本机同模型兄弟声明或 models.dev），2 个（justdowork）整站被 WAF 拦、无使用价值 ⇒ 不动。
- **依据**：modelscope V4-Flash-0731 / V4-Pro-0813 → 1000000（`qiniu` 同模型）；modelscope V4.1-Flash → 1048576（`amd` 同 id）；tokenrouter `z-ai/glm-5.3` → 1000000（`qiniu` 同模型）；yidong `DeepSeek-V4-Flash` → 1000000（本机 deepseek-v4-flash 家族）；duoyuanx 5 个 gpt-5.x → 1050000（`codecraft/gpt-5.6-sol` 同 id + models.dev crossmodel 一致）。
- **执行**：`_tmp/patch-settings-contextwindow-20260923.mjs`（锚点唯一性断言 + 原子替换 + 回读校验，**+10 条**）。备份 `_backups/settings-contextwindow-20260923-231101/settings.yaml.bak`。
- **复核**：写入后 `contextWindow` 计数 62 → **72**，文件未被第二写入者回写覆盖；配置审计「缺 contextWindow」12 → 2。
- **未验证**：运行态解析值（RPC 不暴露该字段）；配置热加载机制此前实测有效（首轮 18 个模型声明免重启生效）。

### 2.2 下调投影缓存上界（env 逃生门，重启后生效）
- **问题（实测）**：`session_projcache.json` **61.0 MB / 453 条**，`softCap=400 / hardCap=500` ⇒ **淘汰尚未触发**（453 介于两者之间），仍在上行。
- **修正子代理口径**：缓存**并非无界** —— `hardCap=500` 是硬上界（约 70MB）；问题是该上界对本机 16GB 偏高。且 **196 条孤儿记录**（会话已删除/移走、缓存行从不淘汰）的 `createdAt` 最旧 ⇒ **淘汰会优先清掉它们**。
- **执行**：`setx DSH_PROJCACHE_SOFT_CAP 250` + `DSH_PROJCACHE_HARD_CAP 300`（HKCU\Environment 已确认）。重启后首次 flush 将淘汰约 204 条最旧记录 ⇒ 缓存降到约 250 条 / ~35MB，且优先清孤儿。
- **可逆**：删掉这两个用户环境变量即可回到默认。

### 2.3 `/health` 第 6 项 `logs` 探针指向真实运行日志目录（repo 插件，重启后生效）
- **问题（实测）**：`plugins/dsh-host-services/lib/index.js:146-157` 只扫 `DSH_HOME` 顶层 `*.log`（那里只有 `dsh-manual.log` / `instance-janitor.log`）⇒ detail 显示 `newest 13000m old` 这种误导值；而真实运行日志在 `%APPDATA%\DSH Desktop\logs`（今日 196KB、持续写入）。**等于该项没有在监控真正的日志**，而「日志写不进去」正是 2026-09-15 fail-loud 自杀事故的根因。
- **修复**（marker `dsh patch health-logs-runtime-dir v1`）：同时扫运行日志目录，新增 `runtimeLogDir` / `runtimeLogFiles` / `runtimeLogNewestAgeMin` / `runtimeLogsStale`（>6h 无写入）字段；**`ok` 语义保持不变**（仍只判 DSH_HOME 可写）⇒ 不引入新的假红。
- 验证：`node --check` 通过；门禁新增 1 条。

### 2.4 `@deepseek-ai/cordis` fiber runner 的 `.catch` 链 TypeError（dist 补丁，重启后生效）
- **问题（实测）**：7 天日志里 `TypeError: Cannot read properties of undefined (reading 'catch')` **114 次，全部且仅出现在** `[agent-registry] agent "…": agent/disposed listener threw:` 这一个场景。
- **根因（代码级）**：`cordis/lib/index.js:1265-1268`
  `task?.catch(() => { … }).catch((error) => …)` —— 可选链**只护了第一段**；`task` 缺失时 `task?.catch(...)` 求值为 `undefined`，尾随 `.catch(...)` 直接抛 TypeError，**且其后的 `finalizeDisposal(dispose)` 清理链被跳过**（对应子代理「疑资源泄漏」的推断）。
- **唯一性证据**：全树（app.asar.unpacked/node_modules 下所有 `*.js`）扫描 `?.catch(` 模式**仅命中 1 处**（就是这一行）；内核里 4 个 `agent/disposed` 监听（agent-loop / file-reference-local / goal-round-driver / subagent）经逐个核对**均无此写法**（`?.dispose()`、`delete` 等）。
- **修复**：`scripts/apply-cordis-task-catch-fix.mjs` —— `task?.catch(` → `Promise.resolve(task).catch(`（与相邻行 `Promise.resolve(task).then(...)` 同款写法；有 promise 时语义完全一致，缺失时变为 no-op）。补丁器含**反向门**（替换后文件里不得再有 `?.catch(` 字面量）——该门当场抓到我自己把该字面量写进了注释，已改写注释措辞后重跑通过。
- 验证：`node --check` 通过、marker=1、危险模式=0；备份 `_backups/dist-cordis-task-catch-2026-09-23T15-31-30-810Z/`。**重启后核对：新日志窗口内不应再出现 `reading 'catch'`。**

## 3. 子代理三切面审计的要点（含我复核后的修正）

### 3.1 日志错误普查（近 7 天）
- **`[E]` 级 32 行，全部出自 `mcp-client` 一个模块**（openviking 24 / markitdown 6 / firecrawl 2），无内核级、插件加载级、文件系统级错误。
- 关键词实测：`unhandledRejection` / `uncaughtException` / `fatal` / `heap out of memory` / `ENOSPC` / `EACCES` **全 0** ⇒ **2026-09-15 的 fail-loud 自杀事故未复发**。
- **`session-projection-cache` 2098 次（W1/W2/W8）—— 我复核后判定「已修」**：最后一次出现在 **20:09:58**，而 P1 补丁在 20:52 重启后才生效；当前这轮 `cache stays stale` **= 0 行**。子代理的 7 天窗口无法区分补丁前后。
- **`EPERM` 3 次**（均 rename `session_projcache.json`）—— 与 ROUND6 的 `json-storage-retry` 补丁对应，已修。
- **新发现并已修**：`agent-registry` TypeError（见 §2.4）。

### 3.2 运行态与存储卫生
- 任务调度器 **0 活锁 / 0 死锁**；`changes.jsonl` 轮转**实测有效**（审计期间抓到一次轮转，`old-*` 份数恒为 5）。
- 会话库 **259 个会话 / 365.4MB，0 空目录、0 无事件会话**。
- **2 个 0 字节孤儿 `.tmp`** 判定为 OOM 崩溃残留（三条独立证据：0 字节 + `r+` 独占打开成功 ⇒ 无句柄 + mtime 与两次转储相差 5–6 秒）。**属工作区外用户数据 ⇒ 删除需明确批准，本轮未动。**
- `_backups` **141.2MB**（68% 是本次归档的 96.2MB 会话目录）；Crashpad **2 个转储 ×34MB**（`crashpad-hygiene` 的 `maxKeep=2` 设计值，**不是泄漏**）。
- **`locks/*.stale-*` 111 个 / 19.5 天、无 retention**（对比 `old-*` 有 KEEP_ARCHIVES=5）⇒ 文件数无上界，体积可忽略。
- 磁盘 C: 30.9GB / D: 59.5GB 可用；物理内存可用 **2.67GB（17%）**；memory-guard 今日 12:54–13:00 **五次反复杀 852MB 的 `python.exe`**，守卫自述「元凶在候选之外」⇒ 这是低可用内存的**症状**，清理无法解决。

### 3.3 插件与机制健康
- **41 个 link 插件无一加载失败**；`[no-fiber]` 全部带 `[disabled]`（设计如此）。
- **`dsh-vision-rotator` 双挂载复核成立，匿名 id 现为 `b463b5f1`**（前几次分别观察到 `d5c685ba` / `8806b932` ⇒ **每次 reload 都被重建**，今日 9 次）。双份执行仍被证伪（模块级 `applied` 守卫 + watchdog 4511 次循环零重复时间戳）。
- **`compaction-basic` / `command-compact` 各有两条 `[active]` 条目**（dsh-base 与后续 bundle 各声明一次）。**实测复核**：`dsh-compaction-basic` **没有模块级幂等守卫**，只有「每会话压缩锁」（`lib/index.js:506`）⇒ 双注册**有可能**造成双份执行；今日 compaction 失败日志确有 **6 对（间隔 1–9ms）**。但**替代解释无法排除**（单引擎在 step/turn 两层各上报一次）⇒ 标为**存疑，未闭环**，未改（改 loader 组合风险高于收益）。
- **MCP 三个**：`firecrawl` 连通但**额度 -11（已超支）**；`markitdown` 抖动自愈（趋势改善）；`openviking` 稳态失败（服务端未安装，插件注释自述是「a steady state, not an incident」）。
- `/health` 第 6 项路径问题 → 已在 §2.3 修复。
- **`preflight` 假红根因（实测）**：`~/.dsh/.health/startup-history.jsonl` 只有 19 行、最后写入 **09-17T15:09:38Z**（该文件只在显式跑 health-check 时追加）⇒ 2 条 09-17 的失败样本会一直留在 7 天窗口内，**约 09-24 15:09 滑出后自动转绿**。无需改代码。

## 4. 我补做的切面

### 4.1 配置健全性审计（`_tmp/audit-config-sanity-20260923.mjs`，只读）
- 17 provider / 74 声明模型 / 117 运行态模型。
- **0** 缺失凭据、**0** 重复 model id、**0** 非法 `input` 声明、**0** 空 provider、**0** 死条目（声明了但运行态没有）；默认模型 `tokenrhythm01/deepseek-flash` 有效。
- 唯一问题 = 12 个模型缺 `contextWindow` → 已修 10 个（§2.1）。

### 4.2 陈旧 modlens 双胞胎
- 仍 **23 个**（`modlens-tokenrhythm01/deepseek-flash`，全部非运行中）。**结论不变**：打开会话时由客户端自愈逐个修；`--fix` 对非活跃会话不持久。

### 4.3 仓库版本控制状态
- **30 项未提交变更**：12 修改（`CHANGELOG.md`、`outputs/INDEX.md`、本会话 4 个插件/脚本 + 前序会话的 `dsh-vision-rotator/src/index.ts`、`profile/desktop/package.json`、`scripts/classify-settings-modalities.mjs`）+ 18 未跟踪（本会话新增的 3 个 apply 脚本、2 个测试、2 个巡检脚本、9 个 outputs 报告目录、`_tmp/`）。
- **提交属仓库级动作，需你授权** —— 未执行。建议：把本会话已验证的补丁/测试/脚本入库（`_tmp/` 探针脚本可不入库）。

## 5. 明确不改（附理由）

| 项 | 理由 |
|---|---|
| `_backups` 141MB（含 96.2MB 归档会话） | **工作区外/用户数据**，删除需明确批准；D: 尚余 59.5GB |
| Crashpad 2 个转储（67.6MB） | `crashpad-hygiene` 的 `maxKeep=2` 设计值，非泄漏；删转储不可逆 |
| `locks/*.stale-*` 无 retention | 体积可忽略（131KB）；加 TTL 属插件代码改动，收益低 |
| 2 个孤儿 `.tmp`（0 字节） | 工作区外 ⇒ 删除需明确批准 |
| `openviking` MCP 稳态失败 | 插件作者已把重试预算压到 2 次/约 15s；服务端未装是**事实**不是 bug；卸载会连带移除你 09-02 主动装的记忆功能 |
| `firecrawl` 额度 -11 | 服务侧计费，需充值；连接层健康 |
| vision-rotator 双挂载 | 双份执行已证伪；每轮 reload 重建 ⇒ 清理会被下一次启动还原；改注入器自愈路径风险高 |
| `compaction-basic` 双 `[active]` | **存疑未闭环**（替代解释无法排除）；改 loader 组合风险高 |
| 日志行级交错（129 行/7d 含 2+ 时间戳） | 并发写同一文件的非原子追加；影响审计解析，需改日志 sink，收益中低 |
| memory-guard 反复杀小 python | 低可用内存（17%）的症状，非存储/配置问题 |

## 6. 生效方式与回滚

| 修复 | 生效 | 回滚 |
|---|---|---|
| §2.1 contextWindow | **已生效**（配置文件，热加载机制此前实测有效） | 恢复 `_backups/settings-contextwindow-20260923-231101/settings.yaml.bak` |
| §2.2 缓存上界 | **需重启**（env 读取于进程启动） | 删两个用户环境变量 |
| §2.3 `/health` 探针 | **需重启**（插件代码） | `git checkout plugins/dsh-host-services/lib/index.js` + 删门禁条目 |
| §2.4 cordis 补丁 | **需重启**（ESM 已加载） | 恢复 `_backups/dist-cordis-task-catch-*/cordis-index-*.bak` |

## 7. 重启后核对清单

1. 新日志窗口内 **`reading 'catch'` = 0 行**（§2.4 成功判据）。
2. 日志出现 `session projection cache: evicted N oldest record(s) above the hard cap 300`，且 `session_projcache.json` 降到 **~35MB / ~250 条**（§2.2）。
3. `GET /health` 的 `logs` 项 detail 变为 `…; runtime N log(s) newest Xm`，且 `runtimeLogsStale=false`（§2.3）。
4. `preflight` 约 09-24 15:09 后自动转绿（`/health` 恢复 200）。
5. 使用 modelscope/tokenrouter/yidong/duoyuanx 模型的新会话，其投影 `contextWindow` 应为补入值（§2.1）。

## 8. 重启后实测核对结果（2026-09-23 23:56:59 起，全部达成）

| 核对项 | 实测结果 |
|---|---|
| §2.4 cordis TypeError | ✅ **0 行**（`reading 'catch'`；重启前 7 天 114 次） |
| §2.2 缓存淘汰 | ✅ **已触发**：`23:58:48 [W] session projection cache: evicted 203 oldest record(s) above the hard cap 300 (kept 250)`（同刻另有 3 条并发淘汰行，因多个会话同时 flush，无害）。文件 **61.0MB / 453 条 → 53.1MB / 261 条** |
| §2.3 `/health` logs 探针 | ✅ 新输出：`DSH_HOME writable; home 2 log(s) newest 13055m; runtime 16 log(s) newest 1m`，附 `runtimeLogDir` / `runtimeLogFiles: 16` / `runtimeLogNewestAgeMin: 1` / `runtimeLogsStale: false` |
| 既有修复保持 | ✅ `cache stays stale` **0**、`non-plain-JSON` **0**、`EPERM` **0**；无新 Crashpad 转储（最近仍是 14:45 / 19:22） |
| `preflight` | ⏳ 仍红（预期）—— 2 条 09-17 失败样本仍在 7 天窗口内，**约 09-24 15:09 自动转绿** |
| 日志剩余告警 | 均为已知/预期：super-injector junction 提示、`openviking` 稳态失败（设计如此）、`workspace-registry session header is missing` ×N（归档会话预期副作用） |

**一条方法论教训（记下来避免重犯）**：我第一次核对时把 `evicted` 判为 0 —— 因为核对跑在 **23:57:30**，而淘汰发生在 **23:58:48**（重启后首个 flush 才触发）。**重启后核对必须留出「首次写入发生」的等待窗口**，否则会把「尚未发生」误读为「未生效」。

**缓存目标达成度**：预期 ~35MB / ~250 条，实测 **53.1MB / 261 条** —— 条数吻合（261 ≈ softCap 250 + 重启后新建会话），但**体积高于预期**：剩余 261 条里有若干大会话（平均 208KB/条，高于淘汰前的 138KB/条），说明被淘汰的以「小记录」为主。若要进一步压体积，可再降 `HARD_CAP`（如 200）或按记录体积而非 createdAt 淘汰 —— 本轮未做（避免过度调参）。

