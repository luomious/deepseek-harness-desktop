# plugins/ 插件登记表

> 单一事实源：每个插件的状态、热重载安全性、用途。
> 与 AGENTS.md structure 区互补（那里只列名字）。

## 装配方式（重要 · 判读依据）

DSH 本地插件有**两条互相独立的装配路径**（实测确认，二者都正常 active）：

- **`bundle`**：插件 package.json 声明 `dsh.bundle.patch`，且包名加入 profile `dsh.profile.bundles` 数组。重启后 loader 读**插件目录下**自带的 `cordis.patch.yml` 装配。
- **`patch-insert`**：插件**不**在 `dsh.profile.bundles` 数组里，而是直接在主 profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `- insert: {id, name}` 装配。**此类插件自带 cordis.patch.yml 在桌面装配时未被读取**（冗余），但它供 **web profile 装配流**（`dsh plugin add` / `dev_install_package`）使用，**不可删**。

> 判断插件走哪条：查 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 是否含该包名。下表「装配」列即据此标注。

## 状态说明

- **core**：生产必需，缺了会影响核心功能
- **experimental**：实验性，可安全卸载
- **deprecated**：已完成使命，待清理

## 热重载说明

- ✅ 可热重载：`dev_reload_package` 安全
- ❌ 必须重启：modlens 类（adapter 注册只在启动时发生，热重载会丢失）
- ⚠️ 建议重启：bundle 插件（热重载可能丢状态）

## 插件清单

### plugins/ 目录（38 个）

> **计数纪律（2026-09-13 复核）**：本标题数字必须与实测一致 —— 复算：
> `(Get-ChildItem plugins -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }).Count`
> 或看运行态 `GET http://127.0.0.1:43120/health` 的 `plugins` 探测（2026-09-13 实测 **36**，且 36/36 都含 `lib/index.js`）。另 `dsh-routing-suite` 无顶层 package.json（子仓容器），**不计入该数**但列于下表。
> 历史：本标题曾长期写「**31 个**」，2026-09-12 按实测改为 35（台账标题滞后于台账内容，O9 同族）。
> ✅ **2026-09-15 新增** `dsh-memory-guard`（事故防护常驻化）⇒ 标题 **38** = 37（含 `package.json` 的目录）+ `dsh-routing-suite`；`experimental` 3→4、`bundle` 30→31。
> ✅ **2026-09-15 新增（同日第二件）** `dsh-developer-role-guard`（非 OpenAI 上游 developer 角色护栏）⇒ 标题 **39** = 38（含 `package.json` 的目录）+ `dsh-routing-suite`；`experimental` 4→5、`bundle` 31→32。事故复盘 `outputs/2026-09-15-report-modelscope-developer-role-fix/`。
> ✅ **补登完成（2026-09-13）**：此前缺 5 行 —— `dsh-code-security-guard`、`dsh-tool-audit`、`dsh-temp-tracker`、`dsh-health-dashboard`、`dsh-crashpad-hygiene`（**均已装配且有 `lib/index.js`，却无台账行**），本次按实测补入下表 ⇒ 表格行数（**37** = 36 + `dsh-routing-suite`）与标题计数口径一致。
> ✅ **2026-09-16 移除** `dsh-orchestrator`（用户决定退役，档案 `_backups/removed-2026-09-16-dsh-orchestrator/`）⇒ 标题 **39→38** = 37（含 `package.json` 的目录）+ `dsh-routing-suite`；表格行 **40→39**；`core` 38→37、`bundle` 32→31；`必须重启` 不变（该插件为 ⚠️ 建议重启）。

| 插件 | 装配 | 状态 | 热重载 | 用途 |
|------|------|------|--------|------|
| `dsh-file-explorer` | patch-insert | core | ⚠️ | 右侧文件浏览器（details 面板）：文件树 + 代码高亮 + 文档预览（docx/xlsx/pptx/pdf 零依赖文本提取、图片预览、大文本分段预览（UTF-8 边界窗口翻页）、旧版二进制「用系统程序打开」兜底；2026-08-28 增强） |
| `dsh-diagram-renderer` | bundle | core | ⚠️ | 交互式 SVG 图表卡片：`render_diagram` 工具（host）+ **v5 自适应免缩放交互卡**（fit-width 高度随图、严格信封防幻影、WorkBuddy 纸面风、mermaid 本地引擎）+ diagram 技能；回归测试 tests/（2026-09-04 补登；v4/v5 2026-09-05，模板已同步） |
| `dsh-force-reasoning-effort` | patch-insert | experimental | ✅ | 强制 reasoning-effort 能力（无 reasoning 元数据的模型也显示思考强度控件） |
| `dsh-frontend-reload` | patch-insert | core | ✅ | 前端刷新按钮 + Ctrl+R（桌面壳 Windows 无应用菜单时的兜底） |
| `dsh-command-guard` | bundle | core | ✅ | 命令风险检测：监听 tool/call 的 shell/exec 类命令做风险评分（共享 risk-rules 模块），高风险命令告警 JSONL + 状态路由 |
| `dsh-diff-guard` | bundle | core | ⚠️ | edit/write **文件改动**风险门禁（补 command-guard 只拦命令、不拦文件改动的缺口）：`tools/pre-execute` 拦 edit/write → `scorePath`/`scoreMutation` 评分（high=系统目录/盘根/凭据与配置；medium=node_modules/.dsh/大段删除）→ 高危走 `ctx.get('approval').request()` 审批，**无 approval 服务 fail-closed deny**；阶段 2 可选 LLM 语义评审（**默认关**，仅 `DENY` 自动拒、`ALLOW`/超时/异常一律降级人工，凭据读 `~/.dsh/.credentials.yaml`）（2026-09-13：阶段 1 已重启验证生效；阶段 2 代码+测试+config 已落地，**待重启**） |
| `dsh-code-security-guard` | bundle | core | ✅ | 代码安全模式警告：监听 `tools/post-execute` 检测 write/edit 写入内容中的危险代码模式（os.system/eval/pickle.loads/verify=False/XSS 等 12 条），**非阻塞**（不阻止写入）——工具结果追加 ⚠️ 警告供模型自修正 + JSONL 审计 `~/.dsh/code-security-guard/alerts.jsonl`（参考 Hermes security-guidance；**DSH 零风险改进 #1**，见 docs/ZERO-RISK-IMPROVEMENTS-PLAN.md） |
| `dsh-tool-audit` | bundle | core | ✅ | 工具调用审计：`tools/pre-execute` + `tools/post-execute` 配对，记录每次调用的元数据（工具名/参数摘要/耗时/成功失败/结果大小）到 `~/.dsh/tool-audit/audit.jsonl`（1MB 轮转）。纯观察者——不修改任何工具行为、失败静默（**DSH 零风险改进 #2**） |
| `dsh-temp-tracker` | bundle | core | ✅ | 临时文件追踪：监听 `tools/post-execute` 检查 write/edit/patch 写入的文件路径，匹配 test/temp 模式（`test_`/`tmp_` 前缀、`.test.*` 后缀、cache 目录）→ `~/.dsh/temp-tracker/tracked.jsonl`（1MB 轮转）。**只追踪不清理**、零删除风险（**DSH 零风险改进 #3**） |
| `dsh-health-dashboard` | bundle | core | ⚠️ | 系统健康仪表盘端点：注册 `/health/dashboard` 聚合磁盘剩余 + 各监控插件 JSONL 统计（command-guard / code-security-guard / tool-audit / temp-tracker / session-hygiene）。纯只读聚合、全部 best-effort（**DSH 零风险改进 #4**；HTTP 实测返回磁盘 30.2GB + 4 插件统计） |
| `dsh-crashpad-hygiene` | bundle | core | ⚠️ | Crashpad 崩溃转储堆积治理：自重调度（6h + 退避）扫描 `.dmp`，配额 maxKeep=2 / 30d 超龄 / 300MB，**回收站删除 + `data/events.jsonl` 全审计**，loopback 端点 `/crashpad-hygiene/report`+`/status`（2026-09-08 上线、首次清理 33.4MB；见 docs/UPGRADE-HANDOVER-20260831.md；其「PS 内 try/catch + Write-Output」是回收站删除正确范式，AGENTS.md F13） |
| `dsh-prompt-enhance` | bundle | core | ✅ | 提示词增强：一键将用户输入改写为更精确的提示词 |
| `dsh-tool-renderers` | bundle | core | ✅ | Tool renderer keyed cards：为 DSH 专属工具（goal/jobs/subagent）注册 tool.call.toolview keyed 渲染器（null-safe 摘要） |
| `dsh-hy3-gateway` | bundle | experimental | ✅ | HY3 OpenAI 兼容网关自动启动（CloudBase 免费混元）；2026-09-03 新增「代际接管」：EADDRINUSE 时向旧实例发 `/__hy3/takeover-shutdown`（token 校验）→ 优雅退出 → 700ms 重试绑定（≤5 次），新实例永远接管旧实例自动退场 |
| `dsh-instance-janitor` | bundle | core | ⚠️ | 后台旧实例清道夫：启动即扫 + 每小时，白名单清理旧代 crashpad-handler / 旧代 hy3 网关（杀后自动补拉新网关），其余旧进程仅记录+通知（24h 去重）；护栏：绝不碰当前进程树/本进程/系统进程；`/instance-janitor/status` 可观测（GET 查看 / POST 手动触发）；动作日志 `~/.dsh/instance-janitor.log`（2026-09-03 上线） |
| `dsh-host-services` | bundle | core | ⚠️ | 本地 HTTP API 样板收敛（trusted/readBody/registerLocalApi 单一事实源）+ **O6 统一 `/health` 聚合端点**（7 项内建只读探测，全绿 200 / 有红 503；`registerHealthProbe(id,fn)` 可被其它插件扩展） |
| `dsh-memory-files` | bundle | core | ⚠️ | **G1 文件型长期记忆**：会话构建系统提示词时只读注入 `MEMORY.md`（`<DSH_HOME>/memory/` + `<cwd>/.dsh/memory/` + `<cwd>/.workbuddy/memory/`，默认预算 2000 字符、超预算截断、缺文件静默跳过、零依赖、只读不写）；经 host-services 注册 `/health` 探测项 `memory.files` 自证（2026-09-11 上线，需重启生效） |
| `dsh-memory-guard` | bundle | experimental | ⚠️ | **进程内存哨兵**（2026-09-14/15 事故防护常驻化）：自适应轮询（活跃 15s / 连续 4 轮平静后 60s）查目标镜像名进程（默认 `python.exe`）的**提交内存(commit)** + 系统水位，命中即回收 —— 规则表「扇出 count>8 且合计提交>4000MB ／ 单体提交>6000MB ／ 系统 commit/limit>0.90 ／ 可用<700MB」；护栏＝`~/.dsh/memory-guard/paused` 放行闸门（合法训练放行，跨重启有效）+ **DSH 直属子进程豁免**（MCP python 不被误杀）+ 路径排除 + 小进程不杀 + dryRun 观察模式 + 杀不掉者按「路径+启动时间」抑制 10min；端点 `GET/POST /memory-guard/status`（含 `?paused=1\|0`）+ `/health` 探测项 `memory.guard`；日志 `~/.dsh/memory-guard/guard.log`。事故：另一 DSH 会话的 YOLO 训练 25 worker 把 16GB 机器推到 50.6GB 提交上限 → DSH 崩溃×2 + `0x50` 蓝屏（复盘 `outputs/2026-09-15-report-yolo-training-incident/`）。验证：单测 **17/17**（v0.2 双向回归） + 导入门禁 0 违规 + **双向真实进程验证 PASS**（A 合法 workers=4 必须不杀：5/5 存活；B 10×450MB 提交扇出必须杀：10/10 全灭残留 0；关键对照 B 的 maxCommit=5422MB 而 maxWS=41MB ⇒ WS 口径会漏判）。**v0.2 判据层需重启桌面应用生效**（`dev_reload_package` 报 `loader.internal 不可用`）。**标注 experimental 的原因**：阈值对「合法大内存 python 任务」的误伤边界尚未经真实使用观察，可安全卸载（`dev_uninject_plugin`），观察期建议先 `dryRun` |
| `dsh-developer-role-guard` | bundle | experimental | ⚠️ | **非 OpenAI 上游的 `developer` 角色护栏**（2026-09-15 事故防护常驻化）：pi-ai 对**未登记端点**默认 `supportsDeveloperRole=true`（`openai-completions.js:1148` 探测规则「不在已知非标准厂商列表且非 OpenRouter ⇒ true」）⇒ 系统提示词发 `role:"developer"`；ModelScope 流式**直接 400**（`developer is not one of [...]`），非流式只回 200 + `"choices":null` **静默失败**，而 DSH 恒为流式 ⇒ 表现为该提供商整条不可用。放大器：`dsh-force-reasoning-effort` 注入 `reasoning=true` 使该判定成立。本插件包装 pi-ai 适配器（同 force-reasoning-effort 模式），对**非白名单**路由强制 `compat.supportsDeveloperRole=false` ⇒ 系统提示词走通用的 `system`；白名单＝真 OpenAI 系（provider + host 双判据、含子域、`api.openai.com.evil.tld` 不误放行），保住 o 系列对 developer 的依赖。护栏：全程 **fail-open**（异常退回未打补丁快照、绝不抛错/阻断请求）+ 只改一个字段且复制而非原地改 + 幂等 + `ctx.effect` 卸载还原（原本无 compat 者删键）+ `dryRun` 试运行 + 可选 `/health` 探测 `developerRole.guard`。验证：单测 **11/11**（含故障注入：`getModels()` 抛错／`Object.freeze` 描述符／compat 只读／畸形 snapshot 全部 fail-open，且单模型失败不拖累同批）+ fake-ctx 接线（apply→wrap→dispose 后两条路由键全消失＝完全还原，`failed=0`）+ **真 pi-ai × 真 ModelScope 对照**（漂移态 `developer`→400 逐字复现；经守卫 `system`→`done`）。装配 4/4 + `startup-verify` 10/10。事故复盘 `outputs/2026-09-15-report-modelscope-developer-role-fix/`。**需重启生效** |
| `dsh-model-picker-group` | bundle | core | ⚠️ | 模型选择器分组（供应商模型 + modlens 双胞胎排序） |
| `dsh-model-provider-failover` | bundle | core | ⚠️ | **Provider 级请求故障转移（2026-09-15 配额感知升级 + 装配到位）**：可用性类失败（SERVER/TRANSPORT/RATE_LIMIT/QUOTA/408/STREAM_CLOSED/MALFORMED）按阈值冷却；**计费/配额类失败（`402`/`billing_error`/`allowance is too low`/`insufficient balance`/中文"额度不足"等，code 或 message 双判）一次即冷却并接管一次恢复**（返回 `{kind:'retry'}` 且不调 next），**只对内核重试码表之外的码接管**（`KERNEL_RETRYABLE_CODES` 不相交不变量 ⇒ 不抢 `dsh-llm-retry` 恢复权）；新增 `fallbackModel` 映射（跨 provider 必须换 model id，否则切换后必二次失败）、`maxRecoveriesPerKey`/`maxFailoversPerTurn` 预算防抖、取消优先、全链路 fail-open；`dev_provider_failover_status` / `dev_provider_failover_configure` 两个工具（可观测 + 运行时配置，免重启）。**装配 4/4**（`register-plugin --yes`，`startup-verify` 10/10，bundles 47→48）。验证：单测 + 集成测试，**含 9 个故障注入场景**（回放 2026-09-15 线上真实 402 报文、内核码表码不被抢、预算/取消/无 fallback 均正确放行）。事故与设计证据：`outputs/2026-09-15-doc-dsh-next-steps/`、`_backups/failover-quota-20260915-211732/` |
| `dsh-model-tier-router` | bundle | core | ⚠️ | 同源模型自动分级路由（简单任务走 low，复杂走 high） |
| `dsh-model-whitelist` | bundle | core | ⚠️ | 模型白名单（并入 Settings → 模型 单页下段：白名单控制可见模型 + 测试连接；2026-09-02 与「模型」页整合，详见 docs/MODEL-WHITELIST-MERGE-2026-09-02.md） |
| `dsh-modlens-autoread` | bundle | core | ❌ | 纯文本模型图片自动识别（粘贴/发照片时自动调 modlens 读图） |
| `dsh-modlens-guard` | bundle | core | ❌ | ModLens 配置守卫（防 visionProvider 被关、60s 巡查） |
| `dsh-project-brief` | patch-insert | core | ⚠️ | AGENTS.md 自动生成（跨 agent 平台的项目说明） |
| `dsh-remote-workspace` | patch-insert | core | ⚠️ | SSH/WSL/Docker 远程工作区连接 |
| `dsh-routing-suite` | bundle | core | ✅ | 路由套件（含 super-injector，file: tgz 装配，在 bundles 数组） |
| `dsh-self-maintenance` | bundle | core | ⚠️ | 应用内智能自检守护（取代计划任务）：每小时磁盘剩余（<5GB warn / <2GB error）+ 会话体积聚合判断，健康静默、异常 24h 去重通知，`/self-maintenance/status` 心跳；只观测绝不删文件；零依赖、`inject:['timer']` 惰性解析（2026-08-26 上线） |
| `dsh-session-history` | bundle | core | ⚠️ | Web-chat 风格会话历史弹窗 |
| `dsh-session-hygiene` | bundle | core | ⚠️ | 会话文件大小卫生监控：每小时 stat 扫描 `~/.dsh/sessions/`，>4MB 提醒 / >8MB 强烈告警（Electron 通知 + 对话注入），`/session-hygiene/report` 报表（148 会话 38ms），闲置 24h 超阈值标建议归档（不自动归档，内核无归档 API）；零依赖、自调度退避、bundle 装配（2026-08-25 上线；`dev_inject_plugin` 运行时注入在当前 DSH 构建不可用，见 CHANGELOG） |
| `dsh-session-watchdog` | patch-insert | core | ✅ | 会话续跑看门狗（定时检测中断/停滞的会话与目标，自动恢复续跑） |
| `dsh-skills-manager` | bundle | core | ⚠️ | Skills 管理器（设置页，系统/用户技能分类展示、编辑、新建） |
| `dsh-system-notify` | patch-insert | core | ⚠️ | 系统通知（任务/会话完成时弹 Windows toast） |
| `dsh-task-scheduler` | patch-insert | core | ✅ | 跨对话任务调度：并发操作互斥锁（文件级 `~/.dsh/.task-scheduler`）+ 优先级抢占通知 + 变更时间线 + stale 基线防覆盖 + 无锁修改检测；CLI（`scripts/task-scheduler.mjs`）+ HTTP（`/task-scheduler/*`）双通道；规则在全局 `~/.dsh/AGENTS.md` 覆盖所有工作区（2026-08-27 上线） |
| `dsh-ui-performance` | bundle | core | ✅ | 设置面板渲染优化：禁用 backdrop-filter 毛玻璃（遮罩 blur(2px)；规则二保留为 no-op，原针对已删除的 maid-atelier 皮肤面板 blur(6px)）+ 面板视口自适应放大（clamp 80vw/82vh，封顶 1240×920，双 max 守卫）+ 各分区宽度上限适配（plugins/desktop/models/agent-presets）+ 插件清单栅格自适应与 content-visibility 渲染节流；纯 CSS 注入、无状态、幂等 |
| `dsh-vision-engine` | bundle | core | ✅ | 视觉引擎（modlens 服务间桥接）：多配置管理 + 测试/额度/用量 + 通道健康卡（代理/Ollama/CLI）+ 单写者 provider pin + autoFailover 开关（2026-08-28 增强） |
| `dsh-web-fetch-local` | bundle | core | ✅ | 本地 HTTP(S) 抓取（SSRF 防护 + 大小限制） |
| `dsh-web-search-bing` | bundle | core | ✅ | 免 key 必应搜索 |

### 根级守护插件（3 个）

| 插件 | 状态 | 热重载 | 用途 |
|------|------|--------|------|
| `dsh-context-lifecycle` | core | ✅ | token 生命周期管理（零依赖 host 模式） |
| `dsh-stuck-loop-guard` | core | ✅ | 失败循环守卫（零依赖 host 模式） |
| `dsh-vision-rotator` | deprecated | ✅ | 视觉引擎轮转 —— 已停用（2026-08-28，双写 config.json + 探活路径与读图路径不一致（代理）导致"假健康"；轮换职责由 modlens 3.23 内置 failover 链承接；源码保留 `dsh-vision-rotator/` 可回滚） |

### profile 市场安装（community-market / npm 管理，非 plugins/ 目录）

| 插件 | 状态 | 热重载 | 用途 |
|------|------|--------|------|
| `dsh-context` | external | ⚠️ 建议重启（market receipt 激活） | 上下文可视化：Context 页签 + /context 命令 + 上下文组成/演进/压缩/剪枝与 token 统计（v0.33.1，2026-08-26 经 community-market 安装，npm `dsh-context`，receipt `0cf24e00-e7aa-4d9b-a23d-b5bfe0370fee`；模板已同步 `profile/desktop/package.json`） |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | external | ⚠️ 建议重启（bundle 类） | better-sidebar 的 Office 预览插件：.docx/.xlsx/.pptx 真实渲染（docx-preview / Univer / xlsx / pptx-renderer）。better-sidebar v0.15.2 起 Office 预览移出主包，须装此插件（v0.1.2，2026-08-28 经 `dsh plugin --profile desktop add` 安装；官方推荐，GitHub `HuanLinOTO/dsh-plugin-better-sidebar-plugin-office`；模板已同步 `profile/desktop/package.json`） |
| `@openviking/dsh-memory-plugin` | external | ⚠️ 建议重启（bundle 类） | 记忆中台插件（openviking 记忆持久化/检索，dsh 会话绑定）。v0.3.0，2026-09-02 装配登记进运行态 + 模板（deps + bundles 均已同步）；（2026-09-09 实测）运行态 active，但检索 MCP 工具未暴露（mcp_search 无匹配、95 工具注册表无 openviking、无 <openviking-context> 注入）→ 记忆读写未接通；要用需先接 openviking MCP 工具面。 |

## 统计

- 总计: 42（plugins/ 39 + 根级 3）| core: 37 | experimental: 4 | deprecated: 1（dsh-vision-rotator）｜ profile 市场安装: 3（dsh-context + dsh-better-sidebar-plugin-office + dsh-memory-plugin）
- 装配方式（plugins/）：bundle 31 | patch-insert 8（根级守护另列）①（2026-09-15 脚本重算口径 `rows=39, byAsm={"patch-insert":8,"bundle":31}`；2026-09-16 移除 `dsh-model-manager` 后 bundle 33→32；2026-09-16 移除 `dsh-orchestrator` 后 bundle 32→31、行 40→39）
- 必须重启: 2 (modlens 类：dsh-modlens-autoread / dsh-modlens-guard)。其余热重载/建议重启以右侧表格逐行标注为准，不在此汇总（避免与表格口径打架）。
- 未持久化装配（仓库内默认 no-op，可随时重新注入）：dsh-model-provider-failover（P1-1）

> ① 根级守护插件（dsh-context-lifecycle / dsh-stuck-loop-guard）经 bundle 数组装配；vision-rotator deprecated，不在运行态。
