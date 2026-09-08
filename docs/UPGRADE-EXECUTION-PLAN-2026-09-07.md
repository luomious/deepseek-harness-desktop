# DSH Desktop 升级执行计划（分阶段 · 统一实施清单）

- 版本：v1.0 · 日期：2026-09-07 · 定位：**离线单机长期使用，仅升级日访问上游**
- 上游基线：`@deepseek-ai/dsh@0.1.1-rc.2`（冻结，上游已至 v0.1.2-rc.1 含破坏性变更）
- 使用方式：本计划是**唯一执行依据**。每项有 ID / 证据 / 动作 / 验证 / 风险 / 依赖 / 状态，
  按阶段顺序执行；每完成一项在状态列标记并记录日期。

---

## 使用说明（先读）

1. **执行顺序**：严格按阶段 1→2→3→4→5→6 执行，不可跳阶段（止血必须在重构前）。
2. **每项纪律**：改共享文件/补丁前先 `node scripts/task-scheduler.mjs status`；关键操作 acquire，改完 release --summary。
3. **改动流程**：read → plan → 备份 → 原子写 → `node --check` → `startup-verify.mjs` → 记录。
4. **不自动重启**：任何改动完成后等用户明确指示才重启。
5. **回滚**：每项有回滚方式；高风险项先备份再改。
6. **状态标记**：`[ ]` 待做 · `[~]` 进行中 · `[x]` 已完成 · `[?]` 待用户决策 · `[!]` 已放弃（记录原因）。

---

## 阶段总览

| 阶段 | 名称 | 周期 | 目标 | 门禁 |
|---|---|---|---|---|
| **0** | 已实施基线 | （已完成） | 止血起点 | startup-verify 全绿 |
| **1** | 止血保开 | 1 周 | 保证能正常打开、不再崩溃 | kill 主进程 5 分钟自恢复 |
| **2** | 能力激活 | 1-2 周 | 启用已有能力（72 skill / 画图） | 关键能力可被 skill_search 发现 |
| **3** | 自愈闭环 | 2-3 周 | 90 天无人干预 | /health 全绿 + 故障注入全过 |
| **4** | 债务清偿 | 1-2 月 | 补丁最小化 + 重复收敛 | 破坏补丁必须 FAIL |
| **5** | 规范化流水线 | 1-2 月 | 官方标准 + 全层门禁 | lint 全绿 + CI 含启动冒烟 |
| **6** | 升级日机制 | 持续 | 受控升级 | 完整演练 1 次成功 |

---

## 阶段 0 · 已实施基线（2026-09-07 完成）

| ID | 项 | 状态 | 证据/备份 |
|---|---|---|---|
| F1 | 修 `dsh-instance-janitor` crashpad 死代码（查询集+`Name='crashpad_handler.exe'`，判断+进程名双保险） | [x] | `node --check` PASS；startup-verify V4-V10 全 PASS；备份 `_backups/fix-20260907-095241/` |
| F2 | 清理 2 个孤儿 crashpad（15960/19892） | [x] | taskkill 实测 |
| F3 | 隔离 127MB installer.exe → `_quarantine_20260907/`（可逆） | [x] | 原路径不存在 |
| F4 | 新建 6 个方法论 skill（`~/.dsh/skills/`） | [x] | frontmatter 校验 6/6 PASS |
| F5 | `~/.dsh/AGENTS.md` +26 行认知纪律 | [x] | 备份 `AGENTS.md.bak-20260907-005225` |
| F6 | 已实施方法论 skill + AGENTS.md 需重启生效 | [?] | **等用户重启** |

> 遗留：3 个 Services 会话 crashpad（8128/19548/28000）需管理员权限清理 → 转阶段 1 PROC-1。

---

## 阶段 1 · 止血保开（1 周）

> **目标：保证每次都能正常打开，不再出现"打不开/打开旧实例/更新后失败"。**

### 1.1 进程与实例（解决"打开旧实例"）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| PROC-1 | 3 个 Services 会话 crashpad 未清 | tasklist 实测 8128/19548/28000 | 管理员运行 `scripts/close-stale-dsh.ps1` 或 taskkill | tasklist 无残留 | 低；无主进程关联 | [ ] |
| PROC-2 | janitor 只在应用运行期工作（死锁） | `instance-janitor/lib/index.js:239-240` | 纳入外部看门狗（WDOG-1）一并解决 | — | — | [ ] |
| PROC-3 | `second-instance` 只 show 不杀旧实例 | `main.ts:498-501` | 加"重启为新实例"选项（需重启验证） | 启动旧实例后再点启动 → 出现重启选项 | 中；改启动链路；备份 | [ ] |
| PROC-4 | 陈旧 lock 2 分钟阈值 | `main.ts:294` | 阈值缩短到 60s（补丁脚本 `apply-stale-lock-patch.mjs`，幂等标记） | 1 分钟内快速重启可成功 | 低 | [x] |
| PROC-5 | 非 DSH 进程占 43120 → 启动直接失败 | `webserver.ts:56-59` 重试耗尽 throw | 端口预检补丁（`apply-startup-resilience-patches.mjs`）：启动早期 probe-bind，被占 → 友好弹窗+干净退出 | 人为占端口 → 弹窗提示而非卡死 | 低；幂等标记 | [x] |

### 1.2 更新机制（解决"更新后重启失败"）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| UPD-1 | **仅 1 个 build 无回滚目标** | dist 仅 `win-unpacked-build202608272104` | **升级前必保留 ≥2 个历史 build**；`promote-build.ps1` 归档段加 ≥2 兜底门禁 | dist 下有 ≥2 个 build | 低；流程改动 | [x] |
| UPD-2 | 自动更新每 6h 检查 | `src/updates.ts:30-34` `enabled:true` | 关闭自动检查（补丁脚本 `apply-disable-auto-update.mjs`，幂等标记）→ 升级走本地构建 | 重启后无后台检查 | 低 | [x] |
| UPD-3 | 更新包只验 PE 魔数 | `update-download.ts:421-454` | **单机决策确认：走本地构建，不用在线 installer**（不加 SHA-256） | — | 决策项 | [x] |
| UPD-4 | 孤儿 installer 长期累积 | 清理只认 `updates/pending-installer.json` 路径 | 隔离已做（F3）；后续定期检查该目录 | 目录无残留 | 低 | [~] |

> UPD-1 证据（2026-09-07）：`promote-build.ps1` 在 keep 集合后新增门禁——`$availBuilds` 全部
> build 目录，keep 先过滤再补足到 ≥2（按名字最旧优先），保证归档步骤永不把 dist 减到 <2 个 build。
> PowerShell Parser 校验 PARSE OK。备份 `_backups/fix-20260907-phase1b-20260907-110726/`。

### 1.3 打开卡顿（缓解，根因优化在阶段 4）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| PERF-1 | 会话 250M 项目目录永不告警 | session-hygiene 只按单文件>4MB 判定 | 改为**按目录聚合**告警（warn 150MB/error 250MB） | 造 200M 目录 → 触发 | 低；只改阈值逻辑 | [x] |
| PERF-2 | 250M 大会话未归档 | `--D-Deepseek-Harness--` 250M | `scripts/archive-big-sessions.ps1`（dry-run 先看清单，确认后移） | 归档后启动变快 | 低；只移动可回 | [x] |
| PERF-3 | vision-engine 3s 全量重渲染 | `vision-engine/client.js:895` | 加可见性门控（document.hidden + 无 textarea 时跳过 timer） | 前端 CPU 占用下降 | 低 | [x] |
| PERF-4 | 插件串行枚举无耗时日志 | `desktop-plugins.ts:403-414` | 加耗时日志（只读观测，不改行为） | 能定位最慢的 bundle | 低 | [ ] |
| PERF-5 | **打开对话载入历史极慢（秒级冻结）** | 实测 12MB/39666 帧会话：readRaw 逐帧 `zstdDecompressAsync` = **2976ms**（每帧一次线程池往返）；JSON.parse 仅 118ms；实机 renderer 峰值 100% 单核 + 窗口"未响应" | `dsh-patch: zstd-stream-readraw v1`（改 `patches/bundles/dsh-session-persistence-jsonl-index.js` readRaw）：单一流式解码器逐帧 write，**2976ms→876ms（3.4x），输出逐字节一致**；任何流式错误自动回退原逐帧路径 | 补丁内新旧路径对比验证 PASS；apply 脚本 `scripts/apply-session-decode-streaming.mjs`（幂等+自动备份）；**已部署 2026-09-07 18:37（DSH 关闭态）**：备份 `_backups/perf5-session-decode-2026-09-07T10-37-48/`；部署后独立核验 = 新 marker `zstd-stream-readraw` 2 处 + 旧 marker `PATCH(zstd-async)` 2 处 + `node --check` OK + `check-dist-integrity.mjs` EXIT 0（verify-patches 在本 agent PowerShell 宿主有 PATCH-5 已知捕获假象，已用独立核验绕过；用户真机 PowerShell 跑即 PASS） | 低；回退路径兜底；备份自动创建 | [x] |

> PERF-1 证据（2026-09-07）：`DEFAULT_CONFIG` 增 `warnDirBytes:150MB/errorDirBytes:250MB`；
> `classifySession` 支持阈值覆盖；新增 `aggregateDirs`/`deriveDirTitle`/`decodeWorkspaceName`；
> `buildReport` 输出新增 `directories[]` 与 summary 工作区计数；通知/告警/去重键区分 dir/file 命名空间。
> 功能验证：269×0.87MB 模拟工作区 223MB → 目录 `warn`（单文件仍 `ok`）；150MB 以下不误报。
> 备份 `_backups/fix-20260907-phase1b-20260907-110726/`。需重启 dsh 生效。

### 1.4 数据不丢失（最高优先，单机无冗余）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| DATA-1 | 2 处高危非原子写 | `dsh-host-services/lib/index.js:205`、`dsh-modlens-guard/lib/index.js:152,173` | 改 tmp+rename（host-services 的 writeJson 一处修复惠及全部调用方） | 写中断 → 配置不损坏 | 低 | [x] |
| DATA-2 | 日志无轮转且实时增长 | `super-injector/*.log`（570KB/443KB/189KB 凌晨仍写） | 统一 50MB/14 天双阈值轮转 | 写 60MB → 触发轮转 | 低 | [x] |
| DATA-3 | `~/.dsh` 1.3GB 无回收 | profiles 783M/sessions 372M/attachments 50M | 配额：>2GB warn/>3GB 自动清 attachments(TTL 90d)+30 天前日志 | 配额触发 → 自动清理 | 中；自愈动作需留审计 | [x] |
| DATA-4 | 写锁为 opt-in 未强制 | deregister/startup-verify 未持锁 | 所有 profile/settings 写入经 task-scheduler | 并发写不产生中间态 | 低 | [ ] |

> DATA-1 证据（2026-09-07）：`host-services writeJson` 与 `modlens-guard atomicWriteText`
> 均为"同目录 `.tmp-<pid>-<ts>` + renameSync 覆盖"，失败清 tmp 并上抛。
> 实测：首次写 + 覆盖写 + 读回 + 无 tmp 残留全过；`node --check` 两文件 PASS。
> 备份 `_backups/fix-20260907-phase1b-20260907-110726/`。需重启 dsh 生效。

### 1.5 外部看门狗（消除唯一 SPOF）

| ID | 问题 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|
| WDOG-1 | 主进程崩溃无人拉起（唯一 SPOF） | 新增 `scripts/install-watchdog.ps1`（任务计划每 5 分钟检查；连续 3 次失败即停+通知；动作写日志） | kill 主进程 → 5 分钟内自恢复 | 中；有熔断与日志；注册任务计划可卸载 | [!] 用户决策暂不安装（脚本就绪，随时可装；副作用=主动关 DSH 后 15min 会被拉起） |

> WDOG-1 证据（2026-09-07）：`install-watchdog.ps1` 已创建（PURE ASCII），PS Parser PARSE OK。
> 功能：每 5 分钟检查 DSH Desktop.exe 进程；3 次连续未发现 → 拉起；3 次拉起失败 → 熔断停止；
> 日志 `%USERPROFILE%\.dsh\watchdog.log`；状态 `%USERPROFILE%\.dsh\watchdog-state.json`。
> **等待用户以管理员 PowerShell 运行** `D:\Deepseek-Harness\scripts\install-watchdog.ps1` 完成注册。

### 1.6 自研代码审查修复（SELF，2026-09-07 并入）

> 来源：阶段 1 执行前对自研脚本/插件/机制的一次专项审查。先并入计划按优先级执行，
> 只修"不合理/会咬人"的点，不做无价值重构。SELF-1/2 为 P1，SELF-3 为 P2。

| ID | 问题（风险） | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| SELF-1 | task-scheduler 并发锁静默吞异常（P1） | `plugins/dsh-task-scheduler/lib/core.js` 28 处空 `catch{}` + 19 处同步 IO | ①逐个 catch 分类：锁关键路径（tryAcquire/release/touch）失败必须经返回值/日志可见，只保留审计/懒回收类的 fail-soft；②`tryAcquire` 的 'wx' EEXIST 竞态从 ERROR 改判 BUSY 重试 | 故障注入（锁目录不可写/并发同资源抢锁）→ CLI/HTTP 返回明确错误而非静默"成功/失败" | 中；核心锁机制，逐个改逐个 `node --check`+并发实测；备份 | [x] |
| SELF-2 | safe-delete-shim 删除无 fallback（P1） | 单一路径尝试，删除失败即无声 | 加 fallback 链：回收站/`_quarantine` 隔离 rename（可逆），失败才报错 | 制造删除失败 → 落入隔离且文件保留可恢复 | 低；机制自身可逆 | [x] |
| SELF-2b | shim 拦截链误伤瞬态锁文件 → 启动失败（SELF-2 实测回归） | 2026-09-07 15:26 起启动必卡 install-recovery：rimraf 自持句柄的 `state.json.lock`，回收站+隔离双失败 → EQ_DELETE → 恢复窗口 ERR_FAILED | ①瞬态旁路：`*.lock`/`*.tmp`/`*.tmp-*` 直走原始删除；②竞态委托：隔离时目标已消失 → 委托原始 fs（ENOENT=stock 语义，rimraf 视为成功） | `tests/plugins/safe-delete-shim.test.mjs` 9/9 PASS；修复后 install-recovery 稳定通过；用户数据保护链不变 | 低；详见 `docs/INCIDENT-20260907-STARTUP-FAILURE.md` | [x] |
| ENV-1 | 启动环境约定：Job 嵌套环境会杀 renderer | 2026-09-07 实测：从 agent/WorkBuddy Job 内启动（无 breakaway 权限）→ Chromium 沙箱 renderer 被 killed → renderer-startup 失败；`--no-sandbox` 或用户双击均正常 | 文档化约定：助手测试启动一律加 `--no-sandbox` 或请用户双击验证；禁止在无 breakaway 的 Job 环境下判断"启动失败" | 单变量实测确认（仅 --no-sandbox → startup.run.completed） | 低；纯约定 | [x] |
| SELF-3 | 7 个 dev 脚本硬编码仓库路径（P2） | `D:/Deepseek-Harness` 写死于 scripts/*.mjs/ps1 | 收敛为共享解析（基于 `$PSScriptRoot`/`import.meta.url` 向上推导或统一 env，不写死盘符） | 仓库换目录后脚本无需改动仍能定位 | 低 | [x] |

> SELF-3 证据（2026-09-07）：grep 实测 11 脚本含硬编码路径，其中 4 个是注释（已用 import.meta.url）、1 个是
> 模式检测字符串（fix-modlens-spawn-trace.mjs 搜索旧模式）、1 个在 `_legacy/`（低价值），
> 真正需要修的 = 4 个脚本（port-user-patches / fix-security / download-electron / patch-host-apiproxy-default-cwd）。
> 修复：每个脚本添加 `import { fileURLToPath } from 'node:url'` + `const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')`，
> 原硬编码路径替换为 `join(REPO_ROOT, ...)` 。`node --check` 4/4 PASS；REPO_ROOT 推导实测 = `D:\Deepseek-Harness`。
> 备份 `_backups/fix-20260907-self3-20260907-114238/`。

> SELF-2 证据（2026-09-07）：审计确认原 shim 在回收站失败时**回落原永久删除**（失败模式=数据丢失，
> 恰与"安全删除"目标相反）。修复 `patches/bundles/safe-delete-shim.cjs`：
> ①新增 `_quarantine` 兜底（`~/.dsh/_quarantine`，同卷 rename 可逆，30 天 TTL 机会性清理）；
> ②回收站失败 → 隔离；隔离也失败 → 抛 `EQ_QUARANTINE/EQ_DELETE`（调用方可见，绝不静默硬删）；
> ③受保护路径保持原硬删（junction heal 依赖）；④`rm force` 缺失目标语义保持不抛；
> ⑤新增测试旋钮 `DSH_SAFE_DELETE_FAIL_RECYCLE=1` 与导出纯函数（isProtected/quarantinePath/…）。
> 验证：强制失败 harness 9/9 PASS（unlinkSync/rmSync/promises.unlink/rm 均落入隔离、受保护路径仍硬删、
> missing+force 不抛）；`node --check` PASS。备份 `_backups/fix-20260907-self2-20260907-112144/`。
> 生效：源码已在 patches/bundles（补丁唯一事实源），下次重建/`apply-safe-delete-shim.mjs` 部署到 dist
> （app 停止窗口执行）；运行中实例仍为旧 shim。

> SELF-1 证据（2026-09-07）：取证实锤——CLI 层 acquire/release 失败**本就 loud**（BUSY→2/STALE→3/ERROR→5），
> 真正的 P1 隐患是审计链与竞态分类。修复 `plugins/dsh-task-scheduler/lib/core.js`（4 处改动）：
> ①新增模块级 `lastAuditError`/`lastReadError`（appendChange/readChanges 失败时记录，成功时清零）；
> ②`appendChange` 从静默 `catch {}` 改为 catch 记录时间戳+错误（保留 fail-soft 语义，审计可见）；
> ③`readChanges` 同上（status 不再在 store 读取失败时返回虚假空列表）；
> ④`status()` 新增 `degraded` 字段（audit/read 任一失败时出现，CLI JSON 自动输出）；
> ⑤`tryAcquire` 的 `wx` EEXIST 竞态从外层 catch（ERROR）改为内层 try/catch，EEXIST→BUSY 路径
> （重新读取 holder 并返回正确 reason=`race-eexist`，覆盖两个进程同时 existsSync=false 然后都 wx 的窗口）。
> 验证：temp store harness 9/9 PASS（基本 acquire/release/并发 BUSY/降级出现/降级恢复/checkUnsupervised）；
> `node --check` PASS。备份 `_backups/fix-20260907-self1-20260907-113510/`。
> 注：CLI 无需改动（JSON 输出自动携带 degraded）；剩余 ~23 个 catch 为 fail-soft 设计（readLock 重命名损坏文件
> /fileHash 返回 null/pruneChanges 非关键维护/pidAlive 返回 EPERM），保持原样合理。

### 阶段 1 门禁

- [ ] 手动 kill 主进程 → 5 分钟内自动恢复（WDOG-1）
- [ ] `~/.dsh` 不再单调增长（DATA-2/3）
- [ ] dist 下 ≥2 个 build（UPD-1）
- [ ] startup-verify + verify-patches 全绿
- [ ] 会话归档后启动体感变快

---

## 阶段 2 · 能力激活（1-2 周）

> **目标：启用已有但未被使用的能力，不新增依赖。**

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| CAP-1 | **72 个 hub skill 未启用** | `tools/dsh-skills-hub/skills/` 本地有源码，`~/.dsh/skills` 仅 6 个 | **本地直装 12 个高频**（选单 `scripts/hub-skills.selection.json`：docx/pptx/xlsx/pdf/diagram-design/security-audit/dep-auditor/zh-docgen/dispatching-parallel-agents/verification-before-completion/systematic-debugging/test-driven-development）via `scripts/install-hub-skills.mjs`（幂等+manifest+可回滚） | lint-skills 18/18 PASS；幂等复跑 SKIP；manifest 12 项；skill_search 发现待重启确认 | 低；纯复制可逐项 `--remove` 回滚 | [x] |
| CAP-2 | 画图依赖宿主内部通道 | diagram-renderer v6.4→v6.5→v8 反复翻修 | **勘察结论（2026-09-07）：双通道已存在**——①SVG 原子落盘 `<cwd>/diagrams/` ②`/diagram-files/` 静态路由 ③结果文本自带 markdown 兜底图行 ④交互卡。剩余仅"降低 React fiber 依赖"重构 → **移入阶段 4 QUAL-7**（它是 3 次翻修根源，不折腾能用的未来再动） | 四层通道代码级确认（index.js:240-285） | — | [~] 重定性 |
| CAP-3 | 无能力注册表 | "我有哪些能力"无单一事实源 | 新建 `docs/CAPABILITY-REGISTRY.md`（顶层地图分层索引：skill 18 项明细/插件分组引 INVENTORY.md/脚本工具箱/宿主能力/明确没有的能力） | 表格覆盖 skill+插件+脚本+宿主 4 层 | 低；纯文档 | [x] |
| CAP-4 | 生成资产散落 | diagrams/ 8 个 SVG 有 4 个同名不同时间戳 | 建 `outputs/` 统一归档 + 命名规范（日期+类型） | 生成物可追溯 | 低 | [ ] |
| CAP-5 | 图像/视频/3D 生成缺口 | 需云端 API | 做成**按需 skill**（用时才联网），不装常驻插件 | 调用时可达 API | 低；破离线需用户接受 | [?] |
| CAP-6 | skill 重叠（我的 vs hub） | dispatching-parallel-agents ≈ subagent-orchestration | 共存观察一周期，按实际加载决定去留（2026-09-07 起观察） | — | 低 | [~] |

### 阶段 2 门禁

- [~] `skill_search` 能发现 ≥10 个新 skill（已装 12 个 + lint 全绿；最终确认待重启）
- [x] 生成一张图同时产出交互卡 + 独立文件（勘察确认已满足：SVG 落盘 + 静态路由 + markdown 兜底行 + 交互卡四层）
- [x] 能力注册表可查到全部能力（docs/CAPABILITY-REGISTRY.md）
- [ ] 断网下 docx/pptx/xlsx 可正常生成（依赖本地 Python 库，待实测）

---

## 阶段 3 · 自愈闭环（2-3 周）

> **目标：守护从"通知型"升级为"动作型"，达成 90 天无人干预。**

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| HEAL-1 | 守护 90% 只通知不动作 | hygiene/self-maintenance/disk 均只提示 | 会话超阈值自动归档；磁盘 <3GB 自动清 attachments+旧日志；GUI 连续失败自动重启 | 故障注入：会话膨胀/磁盘压力/卡顿 → 全部自动恢复 | 中；动作须"只移动+留审计+可回退+有熔断+dry-run 一周" | [ ] |
| HEAL-2 | 无统一健康端点 | 健康检查分散 | `dsh-host-services` 加 `/health` 聚合（webserver/sessions/disk/patches/plugins/logs 6 项） | `curl /health` 返回全绿 JSON | 低 | [ ] |
| HEAL-3 | 启动无自愈钩子 | 补丁缺失靠人记得重打 | 启动自动跑 verify-patches，缺失自动重打；scan-dangling 报告 | 故意删一个补丁 → 启动自动重打 | 中；启动链路 | [ ] |
| HEAL-4 | provider 故障不切换 | failover 默认 no-op `fallback:{}` | 配置默认 fallback（用户确认后启用） | 主 provider 挂 → 自动切备用 | 低 | [?] |
| HEAL-5 | modlens-guard 守错 profile | 硬编码守护 web（非活跃） | 改守 desktop profile | 篡改 desktop 配置 → 守卫触发 | 低 | [ ] |
| HEAL-6 | 主进程双实例/端口接管无兜底 | 仅网关有 EADDRINUSE takeover | 主进程 43120 冲突接管（与 PROC-3/5 协同） | 旧实例存活时新实例可接管 | 中 | [ ] |

### 阶段 3 门禁

- [ ] `/health` 6 项全绿
- [ ] 故障注入 3 项（会话膨胀/日志写满/主进程 kill）全部自动恢复
- [ ] 14 天连续运行 + 90 天外推通过

---

## 阶段 4 · 债务清偿（1-2 月）

> **目标：把"升级税"从 100% 降到 5%。**

### 4.1 补丁最小化（最高优先）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| PATCH-1 | **57KB 整文件替换 session-persistence** | `patches/bundles/dsh-session-persistence-jsonl-index.js` | 尽量改运行时 hook（monkey-patch zstd 解压），不替换文件 | 上游升级该包后补丁仍存活 | 高；安全敏感，需单独评审 | [ ] |
| PATCH-2 | 其余 5 个大补丁整文件替换 | conversation(448KB)/settings-models(135KB)/workspace(116KB)/modlens(87KB)/dir-picker(55KB) | 定位真实改动点，改最小 diff | 同上 | 高 | [ ] |
| PATCH-3 | 10 个 apply-*.mjs 脚本补丁未登记哈希 | 仅 8 个 bundle 在 MANIFEST | 全部登记进 `MANIFEST.md` + SHA-256 | MANIFEST 覆盖全部补丁 | 低 | [ ] |
| PATCH-4 | **verify 用子串匹配（假成功）** | `verify-patches.ps1:63-71` `Select-String -SimpleMatch` | 升级为 SHA-256 + ≥1 个行为断言；`SilentlyContinue` 改显式 try/catch | 故意破坏补丁 → 必须 FAIL | 低；验证有效即可 | [ ] |
| PATCH-5 | verify-patches 组合执行误报 3 FAIL | resolve-dist/check-dist-integrity 单独跑均 PASS，组合执行 `$LASTEXITCODE` 环境问题 | 修 PowerShell 退出码捕获逻辑 | 单独/组合执行结果一致 | 低 | [ ] |

### 4.2 代码质量收敛

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| QUAL-1 | routing-suite **9732 行单文件** | `injector/lib/index.js` | 按职责切 5-8 模块（不改行为） | 每步 `node --check`+启动验证 | 中；只切分不重写 | [ ] |
| QUAL-2 | shared-utils 复用 3/30 | 5 插件各自重写退避/通知 | 收敛到 `dsh-host-services`（分 3 批：退避+通知 → log+原子写 → SSRF client） | 复用率 ≥20/30 | 低/中/高（SSRF 批单独评审） | [ ] |
| QUAL-3 | 前端 fetch 无超时 | 5 个 client.js 裸 fetch | 抽 `clientFetch()` 带 AbortController+重试 | 弱网下 UI 不假死 | 低 | [ ] |
| QUAL-4 | 定时器未清理 | system-notify keepAlive / model-picker 800ms / session-hygiene 自调度链 | 加 disposer/abort | 重注入不泄漏定时器 | 低 | [ ] |
| QUAL-5 | 过度吞异常 | force-reasoning 14 处 / command-guard 12 处 / host-services 6 处 `catch {}` | 关键路径改为记录日志 | 失败可排查 | 低 | [ ] |
| QUAL-6 | 卡顿根因 C1/C2/C5 | 会话同步遍历 + 同步 zstd + 串行枚举 | `readdirSync`→异步；`PublicZstdFrameDecoder` 恢复路径改异步；枚举并行化 | 启动时间下降 | 中；安全敏感补丁，单独评审 | [ ] |
| QUAL-7 | diagram-renderer 交互卡 React fiber 依赖（CAP-2 移入） | v6.4→v6.5→v8 三次翻修均在卡层 | 卡层与数据层解耦（envelope 已四层通道，重构只动 client.js 渲染） | 卡失效时其余三层不受影响 | 中；能动但非必须，排最后 | [ ] |

### 阶段 4 门禁

- [ ] 整文件替换类补丁 ≤2 个
- [ ] 故意破坏任一补丁 → verify 必须 FAIL
- [ ] shared-utils 复用率 ≥20/30
- [ ] routing-suite 单文件 ≤2000 行

---

## 阶段 5 · 规范化与流水线（1-2 月）

> **目标：官方标准落地 + 全层门禁 + 流水线。**

### 5.1 补齐门禁（C/D/E 层）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| LINT-1 | Skill 格式无校验（C 层） | 全仓 grep 无校验逻辑 | ✅ 提前落地 `scripts/lint-skills.mjs`（2026-09-07）：内核同款 `yaml` 包真解析（支持块标量）、官方规范全项（name kebab/dir 一致/desc≤500/fail-closed 布尔/snake_case 陷阱/whenToUse 类型）、根内查重、metadata 约定 WARN | 90 PASS / 0 FAIL（6 自研 + 72 hub + 12 直装副本）；曾实战拦截 metadata 插入坏行（`/n` 字面量） | 低；只读 | [x] |
| LINT-2 | 仓库治理无门禁（E 层） | node_modules/src∩lib/README/版本 | 新建 `scripts/lint-plugins.mjs` | 造违规 → 必须 FAIL | 低；只读 | [ ] |
| LINT-3 | 接入 CI | 现 CI 仅 `node --check`+单测 | CI 加 lint + `tsc --noEmit` + **启动冒烟**（launch→wait→assert） | CI 能捕获"启动即崩" | 低 | [ ] |
| LINT-4 | 无新增脚手架 | 新增 skill/plugin 走样 | `scripts/new-skill.mjs` / `new-plugin.mjs`（合规骨架+metadata 模板） | 生成的骨架自带校验通过 | 低 | [ ] |

### 5.2 Skill 生命周期（官方标准落地）

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| SKILL-1 | metadata 缺失（官方可选） | 6 个 skill 均仅 name/description/whenToUse | ✅ 提前落地（2026-09-07）：6 个自研方法论 skill 补全 metadata（version/owner/status/tags/since）；上游 hub skill 不改源，metadata 由安装 manifest 承载 | lint 无 metadata WARN（自研 6 个）；备份 `_backups/fix-20260907-skillmeta-164904/` | 低；纯 frontmatter | [x] |
| SKILL-2 | skill 在仓库外（不可审计） | `~/.dsh/skills/` 不进 git | **方案 A 镜像同步**：仓库建 `skills/` 为唯一源，`sync-skills.mjs` 单向同步到 `~/.dsh/skills` | 改源 → 同步 → 可审计可回滚 | 低；需防"直改运行时"漂移 | [?] |
| SKILL-3 | 无生命周期状态 | 无 draft/active/deprecated | 用官方 `disable-model-invocation` 实现 draft 隔离 | draft 态模型不可见 | 低 | [ ] |

### 5.3 插件规范对齐

| ID | 问题 | 证据 | 动作 | 验证 | 风险/回滚 | 状态 |
|---|---|---|---|---|---|---|
| PLUG-1 | 版本碎片（0.0.1×3/0.1.0×22/0.2.0/0.2.1/1.0.0） | 实测统计 | 统一 0.1.0 + metadata 记迭代 | 全部对齐 | 低 | [?] |
| PLUG-2 | 提交 node_modules | project-brief / remote-workspace | 移出版本库 + `.gitignore` | git status 无 node_modules | 低 | [ ] |
| PLUG-3 | src∩lib 并存（3 个） | project-brief / remote-workspace / session-watchdog | 有 src 则 lib 不入库（构建产物） | 源/产物职责清晰 | 低 | [?] |
| PLUG-4 | routing-suite 无 package.json | 仅 .tgz/injector/install.ps1 | 标注 vendored 并移出 `plugins/`（或补 package.json 转正） | 形态明确 | 中；涉装配 | [?] |
| PLUG-5 | skills-manager 缺前缀 | 唯一无 `@dsh-external/` | 统一前缀 | 命名一致 | 低 | [ ] |
| PLUG-6 | 15 插件无 README | 清单见标准化分析 | 补齐或登记理由 | 可维护性 | 低 | [ ] |
| PLUG-7 | 根级 3 插件不在 plugins/ | context-lifecycle / stuck-loop-guard / vision-rotator | 移入 `plugins/`（需同步运行态引用） | scan-dangling 0 | 中；涉装配 | [ ] |
| PLUG-8 | self-maintenance 依赖四反斜杠 | 与其余 30 项不一致 | 统一为双反斜杠 | profile 解析一致 | 低 | [ ] |

### 5.4 功能契约（防静默失效）

| ID | 问题 | 动作 | 验证 | 状态 |
|---|---|---|---|---|
| FUNC-1 | 视觉四件套隐式契约（guard→picker→autoread→vision-engine） | 文档化契约（aria-label/路由名/动态 import 联动） | 任一改名 → 有契约可查 | [ ] |
| FUNC-2 | 路由三件套组合语义未定义 | 文档化 tier-router/router-standard/force-reasoning 组合行为 | 组合行为可预期 | [ ] |
| FUNC-3 | 客户端永久包装无卸载还原 | picker-group/model-whitelist 加 disposer | 卸载/热重载后原函数还原 | [ ] |

### 阶段 5 门禁

- [ ] lint-skills / lint-plugins 全绿
- [ ] CI 含 tsc + lint + 启动冒烟
- [ ] 6 个 skill metadata 补全
- [ ] skill 源纳入版本管理（可审计可回滚）

---

## 阶段 6 · 升级日机制（持续运行）

> **目标：受控升级，消除"升级即崩"。**

| ID | 问题 | 动作 | 验证 | 状态 |
|---|---|---|---|---|
| UPGRADE-1 | 无版本基线锚点 | 新建 `scripts/freeze-baseline.mjs`（生成 baseline JSON：包版本/commit/build/profile/补丁 SHA-256） | 一键生成 `_backups/baseline-<date>.json` | [ ] |
| UPGRADE-2 | 无补丁影响分析 | 新建 `scripts/patch-impact.mjs`（列受升级影响的补丁） | 升级前列出受影响补丁清单 | [ ] |
| UPGRADE-3 | 无沙箱预演 | 新建 `scripts/upgrade-rehearsal.ps1`（复制 `~/.dsh`→`~/.dsh-test` 独立 profile 预演） | 预演环境通过才动真环境 | [ ] |
| UPGRADE-4 | 升级雷达无破坏性预警 | `update-watch.mjs` 加会话格式/API 破坏性变更标红 | 检出 v0.1.2 会话格式 v2 → 红色警报 | [ ] |
| UPGRADE-5 | 离线恢复包 | 建 `_backups/recovery-kit/`（baseline + profile + 补丁 canon + settings + **RESTORE.md 人工步骤**） | 按文字步骤可人工恢复 | [ ] |

### 升级日 12 步 SOP（每次升级执行，不可跳步）

1. 触发决策（确有需要才升）
2. `freeze-baseline.mjs` 生成快照
3. 全量备份（dist + `~/.dsh` + 工作区）
4. 读 release notes，标破坏性变更
5. `patch-impact.mjs` 列受影响补丁
6. `upgrade-rehearsal.ps1` 副本预演
7. 逐个 rebase 受影响补丁（允许放弃，登记 `KNOWN-GAPS.md`）
8. `package-vendor.ps1` 重建
9. `verify-patches.ps1` **必须 ALL PASS**
10. `promote-build.ps1` 换版（内置 smoke+回滚）
11. 启动验收：`/health` 全绿 + 插件清单完整 + 测试会话
12. 观察 48h 后固化新 baseline

### 阶段 6 门禁

- [ ] 升级日完整演练 1 次成功
- [ ] 回滚演练 1 次成功（三层回滚均验证）
- [ ] 备份恢复演练 1 次成功

---

## 问题索引（按类别，便于查找）

| 类别 | ID 清单 |
|---|---|
| 已实施 | F1-F6 |
| 进程/实例 | PROC-1 ~ PROC-5 |
| 更新机制 | UPD-1 ~ UPD-4 |
| 卡顿/性能 | PERF-1 ~ PERF-4 |
| 数据安全 | DATA-1 ~ DATA-4 |
| 看门狗 | WDOG-1 |
| 自研代码审查 | SELF-1 ~ SELF-3 |
| 能力/功能 | CAP-1 ~ CAP-6 |
| 自愈 | HEAL-1 ~ HEAL-6 |
| 补丁 | PATCH-1 ~ PATCH-5 |
| 代码质量 | QUAL-1 ~ QUAL-6 |
| 门禁/工程化 | LINT-1 ~ LINT-4 |
| Skill 规范 | SKILL-1 ~ SKILL-3 |
| 插件规范 | PLUG-1 ~ PLUG-8 |
| 功能契约 | FUNC-1 ~ FUNC-3 |
| 升级日 | UPGRADE-1 ~ UPGRADE-5 |

---

## 决策汇总（执行前需拍板）

| # | 问题 | 建议 | 关联 |
|---|---|---|---|
| D3 | 归档 250M 项目会话 | 先 dry-run 看清单 | PERF-2 |
| Q2/Q6 | 关闭自动更新 | 改走本地构建 | UPD-2/3 |
| Q6/Q7 | hub skill 本地直装 10-15 个 | 推荐 | CAP-1 |
| Q8 | 画图双通道（交互卡+独立文件） | 推荐 | CAP-2 |
| Q9 | 图像/视频生成接云端 | 按需 skill | CAP-5 |
| Q10 | 重叠 skill 共存观察 | 推荐 | CAP-6 |
| Q1 | skill 源仓库方案 A 镜像 | 推荐 | SKILL-2 |
| Q3/Q4 | routing-suite 定性 / src-lib 策略 | vendored 移出 / lib 不入库 | PLUG-3/4 |

---

## 执行进度跟踪（每完成一项更新）

| 阶段 | 总项 | 已完成 | 待做 | 待决策 |
|---|---|---|---|---|
| 0 基线 | 6 | 5 | 0 | 1（重启） |
| 1 止血 | 23 | 16 | 7 | 0 |
| 2 能力 | 6 | 2 | 3 | 1（CAP-5） |
| 3 自愈 | 6 | 0 | 5 | 1 |
| 4 债务 | 12 | 0 | 12 | 0 |
| 5 规范 | 17 | 2 | 12 | 3 |
| 6 升级日 | 5 | 0 | 5 | 0 |

---

*本计划整合了全面审计（AUDIT）、运行时诊断（DIAGNOSIS）、能力优化（CAPABILITY）、
标准化分析（STANDARDIZATION）、单机化路线（ROADMAP）、Master Plan 的全部问题与改进项，
统一为一份可分阶段执行的清单。后续每次升级迭代照此执行并更新状态列。*
