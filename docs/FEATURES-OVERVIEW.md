# DSH Desktop 开发功能与插件总览

> 这份文档是旧开发仓库（`D:\Deepseek-Harness`）**全部自研功能与插件的唯一索引**。
>
> 用途三件事：
> 1. **让新会话快速知道"曾经做过什么"** —— 不用读 4.9 万行代码就能建立全局认识；
> 2. **需要重建任何一项时，这里有规格、依赖与判定**；
> 3. **避免重蹈 0.1.x 时代的坑** —— 第 6 节是从 295 条变更记录里提炼的踩坑清单。
>
> 生成时间：2026-09-30 ｜ 对应仓库 HEAD：`820b962` ｜ 代码规模：163 个代码文件 / 49,446 行

---

## 0. 怎么用这份文档

| 你想做的事 | 看哪一节 |
|---|---|
| 知道总共做过哪些插件、各自干什么 | §2 插件总表 |
| 判断某个能力还要不要重建 | §2 的「迁移判定」列 + §3 |
| 配模型 / 想知道那 18 个 provider 是干嘛的 | §4 |
| 想再给壳打补丁 | §5（**先看结论：新版不需要这些补丁**） |
| 要改某个行为、怕踩重复的坑 | §6 踩坑清单 |
| 真的要重建一个插件 | §8 操作指引 |

**一句话背景**：这些插件是为 **DSH Desktop v2.0.2 + 内核 0.1.x** 写的。官方版 **v2.0.17 + 内核 0.2.0-rc.2** 已经内置了其中相当一部分能力（§3），并且**移除了若干 0.1.x 的包**（这正是 2 个插件「加载即失败」的原因）。

---

## 1. 项目形态

| 项 | 值 |
|---|---|
| 桌面壳 | DSH Desktop v2.0.2（Electron，Cordis Host 形态，无独立内核子进程） |
| 内核 | `@deepseek-ai/dsh` 0.1.x |
| 壳源码 | `vendor\deepseek-harness-desktop\dsh-plugin-desktop`（**独立 git 仓库**） |
| 活动 profile | `~/.dsh/profiles/desktop` |
| 插件接入方式 | profile 的 `cordis.patch.yml` 里用 `- insert:` 列表逐条挂载；包本体以 **junction（目录符号链接）** 指向本仓库的 `plugins\` |
| 壳补丁 | `scripts\apply-*.mjs` 共 **32 个**，其中 `apply-shell-0.1.7-gaps.mjs` 是 9 处壳适配的入口 |
| 变更记录 | `CHANGELOG.md` 295 节 |
| 产出登记 | `outputs\INDEX.md` + `outputs\` 下 200+ 份报告 |

**⚠️ 关键机制（看懂这个才看得懂后面）**：插件不是"安装"进 profile 的，而是**外链**。profile 的 `package.json` 里 `dependencies` 是空的 `{}`，插件能被加载**唯一靠磁盘上那个 junction**。所以移动/删除本仓库会直接导致插件失效。

---

## 2. 自研插件总表（44 个）

字段说明：
- **类型**：`host` = 只跑在宿主侧；`client` = 带前端面（自注册进 `window.__ModuleLoader__`，坏了整页废）
- **行数**：该插件自身代码行数（不含依赖）
- **判定**：`keep` 官方无等价物、值得保留 ｜ `partial` 官方部分覆盖 ｜ `builtin` 官方已内置 ｜ `dep` 纯依赖 ｜ `rework` 必须改代码才能加载

### 判定 `keep` —— 官方无等价物 · 值得保留（17 个）

| 插件 | 类型 | 行数 | 解决什么问题 | 依赖的宿主服务 | 依据 / 风险 |
|---|---|---:|---|---|---|
| `dsh-code-security-guard` | host | 221 | 扫描 write_file/edit 写入内容里的危险代码模式（eval / os.system / pickle.load / verify=False 等），只写 JSONL 审计并在下一步注入安全提醒，不拦截写入。 | `timer logger` | 官方零命中；扫描写入内容的危险代码模式；风险：低 |
| `dsh-crashpad-hygiene` | host | 447 | 定时把 Crashpad 目录里堆积的 .dmp 崩溃转储清理进回收站（带完整审计），防止崩溃转储占满磁盘。 | `timer webServer logger` | 官方零命中；崩溃转储清理防占满磁盘；风险：低 |
| `dsh-diagram-renderer` | client | 1052 | 提供 render_diagram 工具，在会话流里渲染可交互的 SVG 图表卡片（toolview 渲染器：复制/下载/缩放/平移/分步播放），并附带 diagram 技能。 | `tools webServer slots conversationEvents` | 官方全 289 包与所有 md/js 中 mermaid 零命中 —— 图表渲染无官方等价，必须迁；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-health-dashboard` | host | 109 | 注册 /health/dashboard 端点，聚合磁盘剩余空间与各监控插件（command-guard / code-security-guard / tool-audit / temp-tracker / session-hygiene）的 JSONL 统计，纯只读 best-effort。 | `timer logger` | 官方零命中（桌面壳只有 desktop-diagnostics）；聚合并监控类插件的 JSONL；风险：低 |
| `dsh-host-services` | host | 597 | 提供 ctx.hostServices 单一事实来源：本地 HTTP API 路由样板（trusted / readBody / registerLocalApi / json）+ 配置读写工具（resolveConfig / readJson / writeJson），并聚合 /health 端点。 | `webServer hostServices logger` | 自研基础设施（ctx.hostServices）—— 其他插件的公共依赖，必须最先迁；风险：低 |
| `dsh-hy3-gateway` | host | 128 | DSH 启动时以 detached 子进程拉起本地 hy3（腾讯混元 CloudBase 免费通道）OpenAI 兼容网关，带心跳文件与退出清理钩子防孤儿进程。 | `(none — 直接 spawn 子进程 + process exit 钩子)` | 官方零命中；hy3 免费通道需要它才有；风险：低 |
| `dsh-instance-janitor` | host | 520 | 后台周期性清道夫：按"归属→孤儿→旧代"判据清理旧代 crashpad 僵尸与旧代 hy3 网关进程，其余旧进程只告警不动手。 | `timer logger` | 官方零命中；与 crashpad-hygiene / hy3-gateway 退出钩子职责重叠，可合并考察；风险：低 |
| `dsh-memory-guard` | host | 562 | 周期性检测进程内存/提交内存（commit）风暴（如 YOLO 训练的 dataloader 集群）并按阈值回收，防止内存耗尽导致应用崩溃或系统蓝屏。 | `timer hostServices logger` | 官方零命中；内存/commit 风暴回收，与训练类工作负载强相关；风险：低 |
| `dsh-model-inspection-guard` | host | 206 | 在 agent/request 处把超阈值的大上下文请求从配置的 provider（如 ModelScope）改道一次并重试该步，避免上游 400 data_inspection_failed 让整轮硬失败。 | `tools` | 上游 data_inspection_failed 改道重试，官方无等价；风险：低 |
| `dsh-model-provider-failover` | host | 457 | 观察 agent/request-error 把稳定失败的 provider（429/5xx/计费类）放进冷却集，随后把 agent/request 路由到已配置的备用 provider，且不抢占内核 dsh-llm-retry 的重试权。 | `tools` | provider 失败冷却+改道，官方只有 dsh-llm-retry（同 provider 重试）；风险：低 |
| `dsh-model-tier-router` | host | 477 | 同源双模型自动分级路由：按当前任务复杂度在 agent/request 瀑布处，把请求切到同 provider 下配置的 high 或 low 模型（简单任务省钱、复杂任务保质量）。 | `tools` | 同源双模型复杂度分级路由，官方无等价；风险：低 |
| `dsh-project-brief` | host | 57 | 提供工具为任意工作区生成/动态更新跨 agent 平台的项目说明文件（默认 AGENTS.md），让 Claude/Codex/Cursor/DSH 接手时快速理解项目。 | `tools` | 官方零命中；新版只有 dsh-agent-instructions 负责"读取" AGENTS.md，没有"生成/更新项目简报"的工具；风险：低 |
| `dsh-prompt-enhance` | host | 108 | 一键把用户输入改写为更精确的提示词（WorkBuddy #1 方案）。 | `tools` | 官方零命中；一键改写提示词；风险：低 |
| `dsh-self-maintenance` | host | 390 | 每小时一轮自检（磁盘剩余 / 会话体积 / Web GUI 连通 / renderer 空闲 CPU / 上游雷达），健康时静默、异常才通知，只观测绝不删文件。 | `timer logger` | 官方零命中；每小时自检，只观测不删；风险：低 |
| `dsh-session-hygiene` | host | 686 | 监控会话文件体积并通过 /session-hygiene/report 报告（advisory only，绝不修改会话文件；archivePlan 恒为 dry-run）。 | `timer webServer logger` | 官方零命中（无 hygiene/会话清理）；插件本身只读上报，风险低；风险：低 |
| `dsh-task-scheduler` | host | 162 | 跨对话协作调度：并发操作互斥锁 + 优先级避让 + 变更时间线，防多个对话同时改同一项目互相覆盖或改到一半。 | `timer webServer logger` | 多对话协作互斥锁，官方零命中；本项目工作流强依赖；风险：低 |
| `dsh-vision-rotator` | host | 391 | 健康探测所有备用视觉提供商；当 modlens_read_image 因配额耗尽/限速/超时/5xx 失败时，自动把 openai 槽切到下一个健康的备用提供商（gemini-api 独立槽不受影响）。 | `webServer logger` | 官方无视觉提供商轮换；仅次于 modlens 存在时才有效；风险：低 |


### 判定 `partial` —— 官方部分覆盖 · 看情况（19 个）

| 插件 | 类型 | 行数 | 解决什么问题 | 依赖的宿主服务 | 依据 / 风险 |
|---|---|---:|---|---|---|
| `dsh-command-guard` | host | 283 | 对 shell/exec 类工具调用做命令风险评分，高风险命令写 JSONL 告警并做状态路由；声明的 approval 服务为后续拦截预留（当前只读检测）。 | `timer approval` | 官方 permission-presets + sandbox-policy + auto-review 覆盖一部分命令审批；但本插件的风险评分与 JSONL 告警是独有；风险：低 |
| `dsh-context-lifecycle` | client | 456 | 跟踪每个 live agent 的请求压力，在对话变贵时通过编辑器上方横幅让用户确认两种恢复动作之一：压缩上下文（compact）或开新会话并交接（handover）。 | `agents webServer tokenMeter hostServices slots compaction` | 官方有 dsh-compaction* + dsh-token-meter（压缩与计量）；但"横幅让用户选 compact/handover"的交互是本插件独有；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-developer-role-guard` | host | 447 | 强制非真 OpenAI 上游的请求使用 role:"system"，避免第三方 OpenAI 兼容网关（ModelScope 等）因 pi-ai 默认发 role:"developer" 而在流式模式被拒。 | `llm hostServices logger` | 新版 dsh-llm-pi-ai 有逐路由 compat（supportsDeveloperRole），若该开关已生效则本插件无必要 —— 必须先实测；风险：低 |
| `dsh-diff-guard` | host | 335 | 在 tools/pre-execute 对高危 edit/write diff（敏感路径、超过 400 字的大段删除）走 approval 审批，fail-closed——拿不到 approval 服务就拒绝，与 command-guard 的命令拦截互补。 | `timer approval` | 官方 permission-presets 有审批策略；但"敏感路径 + 大段删除 fail-closed"是独有判据；风险：低 |
| `dsh-frontend-reload` | client | 5 | 在页面内加刷新按钮和 Ctrl+R 快捷键（桌面壳 Windows 无应用菜单/reload 角色，做页面内兜底）。 | `slots` | 新版壳的 compatibility-chrome 自带 reload 命令；且新增 dsh-client-hmr —— 需实测是否已覆盖"页面内刷新按钮"；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-memory-files` | host | 240 | 会话构建系统提示词时，把磁盘上的长期记忆文件作为只读上下文注入（有字符预算、缺文件即跳过），实现 G1 文件型长期记忆。 | `systemPrompt hostServices logger` | 官方 dsh-agent-instructions 只加载 AGENTS.md/CLAUDE.md；长期记忆文件的预算化注入是本插件独有；风险：低 |
| `dsh-model-picker-group` | client | 14 | 重排会话模型选择器的分组，把每个厂商的 "(modlens vision)" 模型组挪到该厂商普通模型组正下方，让同厂商模型相邻显示。 | `connection locale` | 官方 dsh-client-ui-model-selection 管模型选择，但"按厂商重排分组"无官方等价；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-model-whitelist` | client | 152 | 设置页"模型管理"面板：勾选哪些 provider 的模型出现在会话模型选择器里，并可对指定 provider/model 发一次最小 chat 请求测试连通性与延迟。 | `locale remote webServer hostServices` | 官方 settingd-subagent 有"子代理可选模型白名单"；但"会话选择器里勾选展示哪些模型"是本插件独有；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-session-watchdog` | host | 160 | 定时扫描所有 live agent 的当前目标，把"active 但 disarmed"的目标自动 resume()，让 goal-round-driver 恢复自动续跑。 | `timer logger` | 新版 dsh-goal-round-driver 自带"竞态护栏续行驱动"；但本插件针对 active-but-disarmed 目标的 resume，是否仍需要必须实测；风险：低 |
| `dsh-settings-scope-shim` | client | 7 | 纯前端垫片：修正设置面板的作用域（scope）问题；宿主半刻意留空，整包只为承载 client 面而存在。 | `(client-only; host inject=[])` | 它当年是垫 0.1.x 的 settings 作用域缺口；新内核 settings 已重写（STATE_VERSION 2、profile patch 层），很可能已无必要 —— 必须实测；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-skills-manager` | client | 305 | 设置页 Skills 管理器：系统/用户技能分类展示，用户技能支持开关、编辑、删除、新建，并集成在线技能市场（目录源浏览/搜索/校验安装/更新/卸载）。 | `skills fs shell sandboxPolicy webServer hostServices` | 官方 dsh-skill* 全家 + ui-skill + 内置 dshmarket 1.66.5 + community-market；但"用户技能开关/编辑/删除/新建"的具体交互需实测对比；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-stuck-loop-guard` | host | 317 | 按归一化错误签名跟踪"同一工具连续失败"的链条，注入逐步升级的换路子（pivot）指令，让卡住的会话少烧 token、更快恢复。 | `(none — 直接挂 tools post-execute / agent pre-step 事件，仅用 ctx.logger)` | 官方 dsh-repeat-tool-reminder 会提醒重复工具调用；但本插件是"按错误签名注入逐步升级的 pivot 指令"，语义更强 —— 需对比；风险：低 |
| `dsh-system-notify` | client | 11 | 任务/会话完成时在电脑右上角弹 Windows toast；客户端向其他插件提供 ctx.notify 服务复用。 | `notify` | 桌面壳自带 notifications 插件（cordis.patch.yml 插入）；但 ctx.notify 服务是给其他插件复用的接口，是否有官方等价需实测；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-temp-tracker` | host | 180 | 监听工具写入路径，把匹配 test/temp 模式（test_/tmp_ 前缀、.test.* 后缀、cache 目录）的文件记入 JSONL（1MB 轮转），只追踪不清理。 | `timer logger` | 官方 dsh-spill 管超大输出落盘；但"按 test/temp 模式记账"是本插件独有；风险：低 |
| `dsh-tool-audit` | host | 182 | 配对 tool/call 与 tool/result，把每次工具调用的工具名、参数摘要、耗时、成败、结果大小记入 JSONL 审计（1MB 轮转），纯观察者失败静默。 | `timer logger` | 官方有 dsh-client-ui-trajectory（轨迹账本）与 session-log-export；但本插件写 JSONL 审计是它独有；风险：低 |
| `dsh-ui-performance` | client | 5 | 注入前端 CSS：禁用设置面板的全视口 backdrop-filter 毛玻璃，并对面板做视口自适应放大与内容适配，缓解设置页渲染卡顿。 | `(client-only; host inject=[])` | 官方无专用 UI 性能包；但新版壳已重写设置面板与主题，毛玻璃卡顿可能已修 —— 需实测后再决定；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-vision-engine` | client | 979 | 图片识别模型配置中心：多配置（本地 Ollama / API 预设）管理与"设为当前"、测试识别、渠道额度监控与用量统计，并托管 Ollama 的启动/停止生命周期。 | `webServer hostServices locale slots` | 官方已内置视觉输入（dsh-llm-deepseek inputModalities + imagePixelBudget + settings-models 文本/图片勾选）；但多配置管理 / Ollama 生命周期 / 额度统计是本插件独有；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-web-fetch-local` | host | 193 | 给 DSH 的 web_fetch 提供一个本地原生 HTTP(S) 抓取 provider，带 SSRF 防护与响应体积上限。 | `web` | 官方新增 dsh-web-fetch-http；本插件带 SSRF 防护与体积上限，是否有必要取决于官方实现；风险：低 |
| `dsh-web-search-bing` | host | 297 | 给 DSH 提供一个免 API Key 的 Bing 网页搜索 provider。 | `web` | 官方新增 dsh-web-search-deepseek + dsh-tool-web（默认关闭）；本插件的存在理由是"官方 firecrawl 在其网络被 IP 封"—— 若 deepseek 搜索可用则不必迁；风险：低 |


### 判定 `builtin` —— 官方已内置 · 不必重做（4 个）

| 插件 | 类型 | 行数 | 解决什么问题 | 依赖的宿主服务 | 依据 / 风险 |
|---|---|---:|---|---|---|
| `dsh-file-explorer` | client | 332 | 右侧 details 面板的文件浏览器：文件树 + 代码高亮 + docx/xlsx/pptx/pdf/图片提取预览 + 大文本分段预览，另有"详情"tab。 | `slots webServer tools hostServices` | 官方已内置 ui-sidebar-files（懒加载文件树）+ ui-sidebar-documentpreview（Office/表格/MD/代码/图片/PDF）+ ui-sidebar-browser；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-force-reasoning-effort` | host | 335 | 给缺少 reasoning 元数据的模型补上 off/low/medium/high 思考强度档位，让所有模型都能在模型选择器里调节推理强度。 | `llm logger` | dsh-llm-deepseek 已内置 off/low/high/max 推理强度，dsh-agent-loop 有 agents[].reasoningEffort，dsh-agent-default-model 存选择；风险：低 |
| `dsh-session-history` | client | 14 | 在对话区发送栏加历史按钮，弹出过往会话列表并可一键跳转；另提供消息迷你地图竖条导航（每条用户消息一根横线）。 | `locale` | 官方 dsh-session-query-sqlite 提供跨会话/会话内全文搜索（默认 openAt: never，需改 first-search 打开）+ sidebar 搜索 + workspace Mod+K；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |
| `dsh-tool-renderers` | client | 14 | 为 DSH 特有工具（goal / jobs / subagent）注册 keyed toolview 渲染器，让它们的会话行显示紧凑摘要卡而不是通用兜底渲染。 | `(client-only; host inject=[])` | 官方已内置 dsh-client-ui-goal / -jobs / -subagent 原生渲染这三类工具；风险：中（client 半依赖 __ModuleLoader__ 与 slot API，格式可能已变） |


### 判定 `dep` —— 纯依赖（2 个）

| 插件 | 类型 | 行数 | 解决什么问题 | 依赖的宿主服务 | 依据 / 风险 |
|---|---|---:|---|---|---|
| `dsh-modlens-autoread` | host | 580 | 选普通纯文本模型时直接粘贴/发送图片会自动判定模型模态并调用 modlens 读图，不必手动切到 "(modlens vision)" 双胞胎模型。 | `agents llm attachments` | 同上，依赖 modlens；风险：低 |
| `dsh-modlens-guard` | host | 212 | 自动移除 cordis.patch.yml 里 modlens 的 visionProvider: false 并热重建该条目，每 60s 巡查一次，防止 (modlens vision) 模型再次从选择器里消失。 | `timer loader` | 没有 modlens 就是死代码；modlens 迁移成功后才谈；风险：低 |


### 判定 `rework` —— 必须改代码（2 个）

| 插件 | 类型 | 行数 | 解决什么问题 | 依赖的宿主服务 | 依据 / 风险 |
|---|---|---:|---|---|---|
| `dsh-remote-workspace` | client | 733 | 把 SSH 远程主机 / WSL 子系统 / Docker 容器做成一等公民的独立工作区，提供远程工作区选择与连接配置的 UI 与后端注册。 | `slots workspaces sessions webServer subprocess workspaceRegistry` | 必须改造：inject 与 client exports 都引用已删除的 @deepseek-ai/dsh-client-runtime，加载即失败；风险：高（引用已删除的包，必改造） **缺失依赖：@deepseek-ai/dsh-client-runtime（inject + exports + client 类型导入）** |
| `dsh-super-injector` | client | 10967 | 聚合套件目录：injector（dsh-super-injector 运行时注入器插件，提供 dev_* 工具全套：注入/热重载/卸载/路由自愈/插件管理 UI）＋ preset（dsh-router-standard 思维模式路由 agent 预设，非 cordis 插件）。 | `systemPrompt tools timer llm webServer slots` | 新版内置 dsh-cordis-host-runner / dsh-client-runner / dsh-tool-cordis = 模型自写动态插件的定义/运行/停止；与本插件的 dev_* 工具集部分重叠 —— 需逐功能对比；且它引用了已删除的 dsh-client-runtime；风险：高（引用已删除的包，必改造） **缺失依赖：@deepseek-ai/dsh-client-runtime（inject + client bundle 外部依赖）** |

---

## 3. 官方版已内置、无需重做的能力

| 旧插件 | 官方等价物 |
|---|---|
| `dsh-file-explorer` | `dsh-client-ui-sidebar-files` + `-documentpreview` + `-browser` |
| `dsh-session-history` | `dsh-session-query-sqlite` + 侧边栏搜索 + `Mod+K`（**默认关闭**，需把 `openAt` 改成 `first-search`） |
| `dsh-tool-renderers` | `dsh-client-ui-goal` / `-jobs` / `-subagent` 原生渲染 |
| `dsh-force-reasoning-effort` | `dsh-llm-deepseek` 内置 off/low/high/max + `agents[].reasoningEffort` |
| `dshmarket`（第三方） | 官方内置 1.66.5 + `dsh-community-market` |
| `dsh-web-search-bing` | `dsh-web-search-deepseek` + `dsh-tool-web` |
| `dsh-web-fetch-local` | `dsh-web-fetch-http` |
| `dsh-skills-manager` | `dsh-skill*` + `ui-skill` + 内置市场 |
| `dsh-super-injector` | `dsh-cordis-host-runner` / `dsh-client-runner` / `dsh-tool-cordis`（模型自写动态插件） |

**内核 0.2.0-rc.2 移除的包**（两个插件因此加载即失败）：

- `@deepseek-ai/dsh-client-runtime` —— 被 `dsh-client-modules` / `dsh-client-ui-slots` 取代
- `@deepseek-ai/dsh-settings-file` —— settings 改为存在 profile patch 层

---

## 4. 配置资产：18 个 LLM provider

这些 provider 的配置在迁移时已整体搬到官方版（`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `- id: llm-pi-ai` 条目），共 **18 provider / 75 模型**。API Key 不写在配置里，而是通过 `apiKeyEnv` 指向 `~/.dsh/.credentials.yaml`。

| provider | 基址 | 用途定位 |
|---|---|---|
| `tokenry` | `tokenrhythm.studio/v1` | 主力（默认模型 `deepseek-flash` 走这里） |
| `tokenrhythm01` | `tokenrhythm.studio/v1` | 同源第二账号，模型最全（14 个） |
| `opencode-go` | `opencode.ai/zen/go/v1` | 多模型聚合 |
| `sennsenova` | `token.sensenova.cn/v1/` | 国内通道，带 6 次重试策略 |
| `duoyuanx` | `chat.ai666.net/api/codex` | GPT 系列 |
| `codecraft` | `codecraftapi.com/v1` | Claude / GPT / Kimi 聚合 |
| `apinex` | `api.apinex.bond/v1` | 免费模型池（9 个 `free/*`） |
| `qiniu` | `api.qnaigc.com/v1` | 七牛，模型全 |
| `modelscope` | `api-inference.modelscope.cn/v1` | 魔搭免费额度 |
| `openrouter` | `openrouter.ai/api/v1` | 免费模型（6 个 `:free`） |
| `groq` | `api.groq.com/openai/v1/` | 快速推理 |
| `amd` | `developer.amd.com.cn/radeon/api/v1` | AMD 开发者通道 |
| `baidu-qianfan` | `qianfan.baidubce.com/v2` | 文心 ERNIE |
| `zhipu-ai` | `open.bigmodel.cn/api/paas/v4/` | 智谱 GLM |
| `yidong` | `zhenze-huhehaote.cmecloud.cn/v1/` | 移动云 |
| `justdowork` | `api.justwoker.icu/v1/` | Claude Opus 通道 |
| `tokenrouter` | `api.tokenrouter.com/v1` | GLM 中转 |
| `hy3-free` | `http://127.0.0.1:8787/v1` | **本地网关**（混元 hy3 免费通道，由 `dsh-hy3-gateway` 拉起） |

**绝大多数 provider 都带 `compat.supportsDeveloperRole: false`** —— 这是因为第三方 OpenAI 兼容网关大多不接受 `role: "developer"`，会被拒。这是 `dsh-developer-role-guard` 存在的根因（见 §6）。

---

## 5. 壳补丁体系（9 处）

`scripts\apply-shell-0.1.7-gaps.mjs` 里的 9 处补丁，是**为 0.1.x 内核适配 v2.0.2 壳**而打的：

| # | 补丁 | 修的是什么 |
|---|---|---|
| 1 | web-frontend readiness 回退 | 前端就绪信号缺失导致启动卡住 |
| 2 | 启动健康超时关闭 | 健康检查超时把启动判死 |
| 3 | settingsScope 注入 | host 侧 settingsScope 不完整（`bash-terminal` 报 `settingsScope.get is not a function`） |
| 4 | root Include 回退 | 壳不调 `mountRootInclude`，导致 `profile reload requires the root Include entry` |
| 5 | HealthGate.stop 软结束 | 健康门关闭时硬中断 |
| 6 | 插件失败不杀窗 | 单个插件加载失败导致整个窗口退出 |
| 7 | 跳过内测声明弹窗 | 内测提示噪声 |
| 8 | loader.await 10s 竞速 | 激活竞速 3s 误伤 `required plugin did not activate` |
| 9 | EPIPE 类 uncaught 非致命 | 写设置/重载时 `EPIPE: broken pipe` 进 `uncaughtException` → `exit(1)`，表现为「点创建提供商，应用直接没了」 |

> **结论：官方 v2.0.17 壳里这些补丁标记 0 命中** —— 它们是 0.1.x 的地基，不要在官方版上重打。**但第 9 条（EPIPE→exit）值得在新版上复核一次**，因为它对应的是"点了某个按钮应用就消失"，属于高危失败模式。

---

## 6. 踩坑清单

来源：`CHANGELOG.md` 295 节 + `outputs/` 下的事故报告。**下面每一条都是真实踩过的**，重建功能前先读，能省掉大量时间。

### 6.1 必读的高危坑（会造成"应用直接没了"或"数据丢了"）

| 坑 | 现象 | 根因 |
|---|---|---|
| **EPIPE 进 uncaughtException** | 设置 → 模型 → **创建提供商，应用直接退出** | 写设置/profile reload 路径上 `EPIPE: broken pipe` 未被捕获 → `uncaughtException` → `exit(1)`。修法：EPIPE/ECONNRESET 类只记日志、不退出 |
| **`window-all-closed` 无人接管** | 切换模型后静默退出，无异常无转储、退出码 0 | profile 热重载拆掉持有窗口的 `desktop-shell` 行 → `window.destroy()` → Electron 隐式 quit。修法：模块级 `window-all-closed` 守卫 + 15s 无窗口才兜底 relaunch |
| **`app-boot` fail-loud 的 `proc.exit(1)`** | 首启直接退出 | 启动失败即自杀，不给恢复机会 |
| **悬空 junction 导致启动报错** | 重启报 `cannot resolve package "@dsh-external/<name>"` | 删了插件目录但没清理 profile 里的引用（2026-08-31 事故） |
| **投影缓存整文件重写** | 主进程常驻 ~70% 单核；`session_projcache.json` 52 MB 每 8.5 秒整体重序列化 | json storage 后端是**原子整文件替换**；修法是 write-behind 节流（`writeEveryEvents` / `writeIntervalMs`） |
| **原子写中间态被读到** | 桌面启动失败（file-explorer 顶层 `return`） | 并行会话直接截断覆盖运行路径文件；必须 **同目录 tmp + rename** |

### 6.2 模型/网络类

| 坑 | 现象 | 根因 |
|---|---|---|
| **`developer` 角色被拒** | ModelScope 流式返回 400 `developer is not one of [...]` | pi-ai 对未登记端点默认发 `role: "developer"`，而该网关不接受。修法：`compat.supportsDeveloperRole: false`（17 个 provider 都配了） |
| **非流式只回 200 + `choices: null`** | 静默失败，看不出错 | 上游对非流式请求返回空壳 |
| **`data_inspection_failed`** | 整轮对话硬失败 | 上游内容审查，需改道重试（`dsh-model-inspection-guard`） |
| **`finish_reason=max-tokens` 打断标题生成** | 会话标题永远生成不出来 | 内核默认 `maxOutputTokens: 64`，被 thinking 模型一次思考就撑爆。修法：`session-title-llm` 提到 512 |
| **firecrawl IP 被标记** | 搜索不可用 | 网络环境问题，改用 Bing provider |

### 6.3 环境 / 工程类

| 坑 | 说明 |
|---|---|
| **PS 5.1 把无 BOM 的 UTF-8 脚本读成 GBK** | 中文注释导致语法错。**脚本一律纯 ASCII 注释**（这条在本次迁移里又踩了一次） |
| **`spawn/execFile/execSync` 无 `windowsHide:true`** | 无控制台环境下闪黑框 |
| **工具可选参数不能写 `required:false`** | loader 报 `required must be true when present`，省略 required 即可 |
| **插件 `inject` 不要写永不解析的服务** | 用 `ctx.reflect.get(...)` 惰性解析 |
| **回收站删除不看退出码** | 要用文件系统事实核验 |
| **`node_modules/.pnpm` 硬链接删除需 `danger-full-access`** | 沙箱限制 |
| **中文用户名下 Git-Bash 的 ssh 建不了 `~/.ssh`** | 路径编码问题；用 Windows 原生 `C:/Windows/System32/OpenSSH/ssh.exe` |

### 6.4 完整变更时间线（295 节索引）

共 288 节（已过滤编码损坏的旧标题），按时间倒序：

1. 2026-09-29 · 「切换模型」也重启的真实链路：config-editor 的**空重载**预检（比 reconcile 更靠前一层）
2. 2026-09-29 · 创建提供商静默退出的真正死法：window-all-closed 无人接管
3. 2026-09-29 · 真凶：app-boot fail-loud 的 proc.exit(1) · 创建提供商退出最终修复
4. 2026-09-29 · 创建提供商退出根治 · 门禁全绿 ALL PASS
5. 2026-09-29 · EPIPE 非致命 + 功能全面体检清单
6. 2026-09-29 · 跳过「内测声明」弹窗 · 修「点继续就自动退出」
7. 2026-09-29 · 软失败：stop 不 reject + 不因插件失败杀窗 · 修「还是打不开」
8. 2026-09-29 · 固化「壳 ↔ 0.1.7」4 处 dist 运行时补丁 · 可重放 + 门禁守门
9. 2026-09-27（0.1.7 启动报错修复三）· 桌面窗口 URL 接 `connection.authenticatedUrl` · 修 401「dsh web authentication required」· 需重启
10. 2026-09-27（0.1.7 启动报错修复二）· 补 `profileContext` 解 `did not register a window` · 热修 dist + 源码 · 需重启
11. 2026-09-27（0.1.7 启动报错修复）· `dsh-web-app` `dsh.bundle.patch` 数组兼容 · 热修 dist + 源码 + startup-verify V10 · 需重启
12. 2026-09-27（U6-0c 实施）· 设置页回补：私有 API POST + 客户端 scope 改接 · 0.1.7 设置页恢复可编辑 · 免重启（新 build 构建中）
13. 2026-09-27（B3 落地）· 打包态具名导出守卫 `verify-dist-exports.mjs` + 门禁 Step 1.18 · **免重启**
14. 2026-09-27（第七轮·R2 修复）· 注入器 A1（junction 假阳性告警）+ R7（dev_self_test 桌面形同虚设）· 25 PASS / 0 FAIL · **需重启**
15. 2026-09-27（第六轮·R1 修复）· 「幽灵 loader entry」根治（**开了 3 轮的根因**）· 21 PASS / 0 FAIL · **需重启**
16. 2026-09-27（第六轮·A0 验收）· 锁定 9.3×：主进程 69.5% → 7.5% 单核 · R1 根因也定位了
17. 2026-09-27（第六轮·P0-7）· 官方 0.1.7-rc.2 升级影响评估（**只读**）· 三张清单 23 项 · 含一次假阳性自捉
18. 2026-09-27（第六轮）· 卡顿根因定性：`session_projcache.json` 整文件重写风暴 · 已修配置 · **需重启生效**
19. 2026-09-26（第五轮）· 验收 6 步全过（含 T2 故障注入）· P0-6 补丁集身份登记 · `CHECK-ALL: ALL PASS`
20. 2026-09-26（第四轮）· 重启验收发现**我自己修复的严重缺陷**（判据太松 → 22 组假阳性）· 已纠正 · **需第二次重启**
21. 2026-09-26（第三轮）· 注入器 P0 修复（T1/T2/T3）已构建安装 · **需重启** · 含三次自我纠错
22. 2026-09-26（第二轮）· 官方 vs QuWork 全面对撞 + 我方 43 插件/28 补丁/62 技能逐个裁决 + 针对缺点的完整方案
23. 2026-09-26 · 官方桌面版核实 + 官方/QuWork/我们 三方对比 + 分阶段优化方案（含一次自我证伪）
24. 2026-09-24 · 模型可用性全量复测 + 修正 `amd` 配置缺陷 + 审核救援方案重做（**第二次证伪自己**）
25. 2026-09-24 · 新增 `dsh-model-inspection-guard`：从根因止住 ModelScope 审核拒收（并证伪上一轮的兜底方案）
26. 2026-09-24 · dsh-model-provider-failover 新增「上游内容审核拒收」定向兜底（默认关）
27. 2026-09-24 · 第七轮：「图片无法原生识别」真根因结案 —— `tool_call` 桥丢弃图像块
28. 2026-09-24 · 第六轮：崩溃残留清扫（新增 dist 补丁）+ 仓库入库 + `_backups` 保留判定
29. 2026-09-23 · 第五轮：DSH 全面自检（内置验证器 + 三切面并行审计）与四项修复
30. 2026-09-23 · 第四轮：「推荐了但没生效」复查（端到端实测推翻 3 项旧结论）+ 修掉 2 个真缺陷
31. 2026-09-23 · 第三轮收口：重启后核对全部通过 + L3 根因结案（`contextTimeline` 的 `undefined` tool 名）
32. 2026-09-23 · 第二轮收口：投影缓存「有界化 + 单会话可降级 + 写入减半」内核补丁（projcache-guard）
33. 2026-09-23 · 「自动关闭」根因收口：主进程 V8 堆 OOM + modlens 失效双胞胎反向自愈
34. 2026-09-23 · 多模态模型被误判为纯文本：网关能力探测接入 + 18 模型落地 + 「写了但从未生效」普查
35. 2026-09-21 · vision-rotator 掉线找回 + 持久化登记修复 + 轮换链实测
36. 2026-09-20 · 已配置 API 模型全量复测（17 厂商 / 74 模型）+ 2 处配置修复
37. 2026-09-18 · 模型管理面板新增「一键测试全部」按钮
38. 2026-09-18 · 已配置 API 模型全量可用性测试（17 厂商 / 74→75 模型）+ 配置修复
39. 2026-09-17 · session-history：卡片改回 MiMo 左侧 rail 旁浮层（取消对话正中）
40. 2026-09-17 · session-history 卡片硬对齐 MiMo（用户实拍仍不满）
41. 2026-09-17 · session-history：卡片落在可见对话区中部 + 跳转按用户消息居中
42. 2026-09-17 · session-history 卡片二次对齐：贴横条锚定 + 清洗标题/Think 摘要
43. 2026-09-17 · session-history 卡片对齐 MiMo：对话区居中浮层 + 动效 + 摘要/chips
44. 2026-09-17 · dsh-session-history 悬停预览改为 MiMo 式富卡片
45. 2026-09-17 · 渲染卡顿根治：流式行扫光 `left` 动画 → `transform`（合成器）
46. 2026-09-17 · 调度器时间线轮转**根治** + uv 缓存回收（残留收口 · 第四批）
47. 2026-09-17 · 工作区冗余文件整理与清理（回收站可还原 · 约 18.7 MB）
48. 2026-09-17 · 滚动卡顿：三路只读审计 + 官方同源对照 + S1/S2′ 修复（刷新生效）
49. 2026-09-17 · 文档/产出同步入库 + CHANGELOG 重复章节修复 + GPU 补丁脚本原子化
50. 2026-09-17 · AGENTS.md 精简 242→121 行：生成器加列表上限 + 规则条文逐字搬入 docs/
51. 2026-09-17 · 打字卡顿收口：幻影 P0 证伪 + 客户端 bundle 热路径全量扫描 + 轮询缓存化
52. 2026-09-16 · 打字卡顿修复纳入门禁（防插件重装静默丢失）+ 故障注入验证
53. 2026-09-16 · 打字卡顿根治第二步：渲染路径改回硬件加速（窗口保持不透明）
54. 2026-09-16 · 打字卡顿根因定位 + 渲染层修复（软件光栅 × 全量 DOM 扫描）
55. 2026-09-16 · P0 · `dsh-subprocess-local` spill 路径防御加固（修复「清 `%TEMP%` ⇒ 主进程弹窗」崩溃）
56. 2026-09-16 · 补丁门禁语法盲区修复（`log-files` 分块被静默漏检）+ `/health` 容量单位标注
57. 2026-09-16 · 上游更新评估定案 + 补丁体系加固（目标侧形状门禁，修复「静默覆盖假绿」）
58. 2026-09-16 · 补丁写入路径原子化（原子写纪律落地）
59. 2026-09-16 · 移除插件 `dsh-orchestrator`（用户决定：部门式编排功能退役，回到未安装状态）
60. 2026-09-16 · 移除插件 `dsh-model-manager`（用户决定，回到未安装状态）
61. 2026-09-16 · 模型管理界面重构（Clash 风格连接状态面板 `dsh-model-manager`）
62. 2026-09-16 · 全面自检 + 残留任务收尾 + 环境清理（审计清理轮）
63. 2026-09-15 · 验收脚本 `scripts/verify-log-write-guard.ps1`（log-write-guard 事故闭环的一键复验）
64. 2026-09-15 · 运维手册 `docs/OPS-QUOTA-FAILOVER-VISION-2026-09-15.md`（配额 / 故障转移 / 视觉桥）
65. 2026-09-15 · 配额可观测性 `scripts/quota-report.mjs` + `AGENTS.md` T12 勘误修订
66. 2026-09-15 · apinex 免费额度 402 收口：failover「配额感知」升级 + 装配到位 + 视觉桥修复
67. 2026-09-15 · apinex 免费模型 402 `billing_error`：根因定位 + apinex 路由「配额化」配置
68. 2026-09-15 · 编排看板 P1β：默认只显示「本对话」（修「同一工作区的其它主对话全进图」+ 运行串台）
69. 2026-09-16 · 编排器 P1 步 D 根因#4：prompt 传字符串 ⇒ 子代理消息 content 不合规（零输出）
70. 2026-09-16 · 编排器 P1 步 D 根因#3：只读角色 deny 平台 shell ⇒ preset 抛错杀死子代理
71. 2026-09-15 · 编排器 P1 步 D：根因#2 修复（deny 清单用了内核不存在的工具名 bash）
72. 2026-09-15 · 编排器 P1 步 C：根因确认并修复（spawn provider 需要 request.signal）
73. 2026-09-15 · 编排器 P1 步 A：派发失败可诊断化 + 门禁新增 `G9_RUN_INCOMPLETE`（修「跑挂了却 gate=pass」）
74. 2026-09-15 · developer-role 防护加固：补齐两家新供应商 + 只读门禁 Step 1.15 + 账目修正
75. 2026-09-15 · ModelScope 流式 400 修复 + 新增 `dsh-developer-role-guard`（非 OpenAI 上游角色护栏）
76. 2026-09-15 · 日志写入永不致命：根治「DSH 因日志故障自杀退出」的致命链（dist 外科手术补丁）
77. 2026-09-15 · 内存事故防护常驻化：新增 `dsh-memory-guard` 进程内存哨兵
78. 2026-09-14 · 白屏归因 + 两处噪声源治理：janitor 抑制表 + openviking 重连预算
79. 2026-09-14 · 孤儿网关彻底修复：三层兜底 + janitor 判据重构（**宿主插件改动，需重启生效**）
80. 2026-09-14 · dsh-orchestrator P1：编排核心 + orchestrate 工具 + 运行端点（**需重启生效**）
81. 2026-09-14 · dsh-orchestrator P0.2：运行驱动的部门流程图（阶段框 + 驳回回边 + 内嵌卡，**免重启**）
82. 2026-09-14 · dsh-orchestrator P0.1：看板作用域过滤（只显示与你有关的会话，**免重启**）
83. 2026-09-14 · dsh-orchestrator P0：部门流程图板（分层 DAG + 交互 + 铺满主区，**免重启**）
84. 2026-09-14 · dsh-orchestrator 方案转向：部门式编排设计定稿 + 旧工作台 UI 退役（**免重启**）
85. 2026-09-14 · dsh-orchestrator 阶段 1.0·S2：会话元数据接入（实时会话表 + 点行聚焦，**免重启**）
86. 2026-09-14 · dsh-orchestrator 阶段 1.0·S1：状态账本 + 版本化契约（六步原子写 / 降级不重置 / rev CAS）
87. 2026-09-14 · 新增 dsh-orchestrator「编排工作台」阶段 1-A（可点击切换的视图 tab + agent 实时快照）
88. 2026-09-14 · 门禁脚本模块化 + 常驻回归测试（把「假绿加固」钉死）
89. 2026-09-14 · 门禁加固：未登记改动「假绿」修复 + 台账一致性自动核验（Step 1.14）
90. 2026-09-14 · 修复 Mermaid 错误 SVG 泄漏到页面 body
91. 2026-09-13 · dsh-diff-guard 结项：全量门禁自检抓出「目录级登记不覆盖文件级」并修复
92. 2026-09-13 · dsh-diff-guard 阶段 2：LLM 语义评审（默认关，仅 DENY 自动拒）
93. 2026-09-13 · 落地 dsh-diff-guard 插件（guardian 阶段 1：edit/write diff 风险门禁）
94. 2026-09-13 · Codex 动作 0 侦查：diff 内联已对等（证伪 P0）、guardian 接入点确认、版本修正 0.154.0
95. 2026-09-13 · Codex 调研优化 DSH：完整方案落盘 + skill catalog 瘦身（证伪 SL-9 超限）
96. 2026-09-12 T22 · O16 shared-utils 第一批收敛（isLoopback 逐字节等价提取）+ O7 观察期定性
97. 2026-09-12 T21 · 累积工作批量提交 + push 卡点 SSH 修复 + CI 转绿（O20 收尾）
98. 2026-09-12 T20 · O3「先测量」证伪已修 + O13 标注 vendored（零代码改动）
99. 2026-09-12 T19 · W5 结构清理：O19 死文件清除 + O21 插件 README 补齐（零重启、零运行时风险）
100. 2026-09-12 T18 · O5：ollama 模型目录可配置 + 退出钩子回收（**默认行为零变化**）
101. 2026-09-12 T17 · O14 残余盲区关闭（部署门禁能抓到「标记在、文件坏」）+ O15 实态复核
102. 2026-09-12 T16 · O9 收尾：过时计数口径统一（11 份文档 + 台账，纯文档零风险）
103. 2026-09-12 T15 · 文档索引治理（O24）+ 门禁可信度修复（含确定性 A/B 证据）
104. 2026-09-12 O7（第一步）· 归档动作化 dry-run：把「会做什么」算清楚，但**什么都不做**
105. 2026-09-12 T14 · 重启后验收 + 记忆注入窗口治理（含一条自我勘误）
106. 2026-09-12 O11 · 请求超时治理（改 6 个 client bundle + host-services，新增 1 个测试文件）
107. 2026-09-12 O20（第一步）· CI 从「永久红」修正为「可绿且有意义」（改 1 个文件）
108. 2026-09-12 O8g · 门禁覆盖插件内部测试（改动 3 个文件 + 清 1 处残留）
109. 2026-09-11 O8f · 重启后验收：F-LOCK-1 修复确认生效（**零运行时代码改动**）
110. 2026-09-11 T12-续 · 清理执行（仅 A 级）+ 门禁假红修复（**改动 1 个脚本**）
111. 2026-09-11 T12 · 沙箱外通道勘误 + 两处遗留文件清理（**无代码改动**）
112. 2026-09-11 T11 · 文档同步 + 归档索引 + GitHub 文档更新（**无代码改动**）
113. 2026-09-11 T10 · 台账补齐到磁盘真相（批量接管 32 项）+ hub 本地仓库状态校正
114. 2026-09-11 T9 · **v1.7.0 已发布上线（94 项）** + 修 F-LOCK-1（P0）+ 免 git 发布工具化
115. 2026-09-11 T8 · 免 clone 远程导入器（新工具）+ 目录 72 → **94 项**（本地 commit+tag，**待用户 push**）
116. 2026-09-11 T7 · hub 发布包就绪：目录 70 → **72 项**（本地 commit + tag，**待用户 push**）
117. 2026-09-11 T6 · 市场页「治理总览」+ 安装显示正确（**纯客户端 · 刷新即生效、无需重启**）
118. 2026-09-11 O8c · 剩余量补齐：跨会话写锁语义 + 两插件冒烟（**纯测试新增，零运行时改动**）
119. 2026-09-11 T5 · 市场破坏性动作护栏（卸载前整目录备份 + SL-9 本地改造识别）
120. 2026-09-11 T4 · 「未登记改动」升级为 check-all 门禁（运行路径分类 + 存量基线补齐）
121. 2026-09-11 T3 · 市场「接管」本地已存在 skill + 更新前备份 + 未登记改动巡检
122. 2026-09-11 O8（部分）· 关键链路测试：zstd golden + routing-suite 冒烟
123. 2026-09-11 G1 修复 · `inject` 未声明 `hostServices` → /health 探测静默缺失
124. 2026-09-11 T2 · 技能市场修复（安装死路错误 + 源升级 v1.1.0→v1.6.0）
125. 2026-09-11 T1 · 插件装配/注销工具化（`register-plugin.mjs` + `deregister` 补第 4 处）
126. 2026-09-11 G1 · 文件型长期记忆接线（新插件 `dsh-memory-files`）
127. 2026-09-10 O10 · 写锁强制落地（窄切：只锁两条真实写路径，读路径零改动）
128. 2026-09-10 G2 + O6 · `outputs/` 归档约定落地 + 统一 `/health` 聚合端点（7 项）
129. 2026-09-10 F18 · 17 个 probe 脚本修复失效路径；F19 经核实「不改」+ 门禁退出排除态
130. 2026-09-10 F14 · 插件隐性依赖修复 + 新增静态导入解析门禁（Step 1.11）
131. 2026-09-10 ZR-02 修复 · command-guard v1 审计失效（session/event → tools/result 迁移）
132. 2026-09-10 ZR-01 · 零风险改进四件套（代码安全 / 工具审计 / 临时追踪 / 健康仪表盘）
133. 2026-09-10 F17 修复 · check-all 污染 SLO 采样（并纠正方案文档的错误建议）
134. 2026-09-10 SL-9 · Skill catalog 瘦身（D1：低价值 skill 移出模型 catalog，-41.8%）
135. 2026-09-10 F13 修复 · 回收站删除「退出码误判」（跨 3 处生产代码）
136. 2026-09-10 W1 治理止血（skill 治理 / 补丁基线 / 门禁反假成功）
137. 2026-09-10 能力缺口与优化全景方案（方案稿，未执行改动）
138. 2026-09-10 skill 门禁 v2（lint-skills.mjs 升级：质量 + 安全 + 跨根遮蔽）
139. 2026-09-09 设计系统 v9（dsh-diagram-renderer · scene 语义渲染内核，对标 archify）
140. 2026-09-09 设计系统 v8（dsh-diagram-renderer · 与对话内联图同源）
141. 2026-09-09 设计系统 v8.1（消除底部图注 + 阶段说明默认收起）
142. 2026-09-08 修复 dsh-diagram-renderer 插件树加载失败（additionalProperties 缺失）
143. 2026-09-08 进度看板 v7（dsh-diagram-renderer · board 数据驱动 + 动态交互卡）
144. 2026-09-08 日日新 sennsenova kimi-k3 限流治理（聚焦方案，回滚多余改动）
145. 2026-09-07 补丁脚本治理定案（防增量规则 + 重打 HINT + git 三连提交）
146. 2026-09-07 验证层假阳性修复（V9 三态分类 + SLO inconclusive 语义）
147. 2026-09-07 补丁生命周期标准化（登记制 + 统一原子引擎 + 漂移门禁）
148. 2026-09-07 PERF-5 会话解码流式化部署（打开对话载入历史加速）
149. 2026-09-07 阶段 2 启动：CAP-1 hub skill 直装 + CAP-3 能力注册表 + CAP-2 重定性
150. 2026-09-07 启动失败事故闭环（SELF-2b shim 修复 + ENV-1 启动环境约定）
151. 2026-09-07 运行时诊断与保守修复（单机化定位定案 + janitor 死代码修复）
152. 2026-09-07 GPU 子进程崩溃 → 透明窗口 + 启动卡顿（根因修复）
153. 2026-09-07 阶段1 Sprint·第一批（归档目录聚合 + 会话瘦身）
154. 2026-09-06 全面审计与修复（4 批次 + 死锁自动回收，20 文件，4 个 atomic commit）
155. 2026-09-06 dsh-diagram-renderer v6.5：纠正 v6.4 方向——turnTail 恢复为主通道 + 历史信封扫描补挂
156. 2026-09-06 dsh-diagram-renderer v6.4：单通道化——keyed 工具节点完整渲染，历史卡刷新后自动恢复
157. 2026-09-06 dsh-diagram-renderer v6.3：WorkBuddy 式布局（图下说明面板 + 统计卡 + 分步图按显示尺寸作画）
158. 2026-09-06 dsh-diagram-renderer v6.2：审查修复（自动播放永久锁死 / 空格双触发 / 死代码清理）
159. 2026-09-06 dsh-diagram-renderer v6.1：动态效果（阶段过渡 / 播放进度条 / 点脉冲 + 作者侧动效规范）
160. 2026-09-06 dsh-diagram-renderer v6：分步交互图（stages —— 上一步/下一步/播放）
161. 2026-09-06 dsh-diagram-renderer 阶段 4：节点交互 + check-all 纳入回归
162. 2026-09-05 dsh-diagram-renderer v5：自适应免缩放卡（卡片即相框）
163. 2026-09-05 dsh-diagram-renderer v4：幻影空卡 + 小图塌缩根因修复 · WorkBuddy 纸面卡重设计
164. 2026-09-05 dsh-diagram-renderer 渲染管线根因修复（信封 JSON 转义）+ mermaid 引擎本地化
165. 2026-09-04 dsh-diagram-renderer 客户端装配根因修复（inject 协议）+ 消毒器加固
166. 2026-09-04 退出残留 dsh 根治（网关退出回收 + 退出守卫放行）
167. 2026-09-04 dsh-diagram-renderer 双通道渲染补全（对话内嵌图 + ⋮ 菜单交互卡）
168. 2026-09-04 文档对账与清理（INVENTORY 补登 2 插件 + handbook 新增 §19/§20 + 误建目录清理）
169. 2026-09-03 后台旧实例自动清理机制（hy3 网关代际接管 + 实例清道夫插件）
170. 2026-09-03 settings.yaml 反腐化双保险（市场目录缓存不再破坏启动）
171. 2026-09-04 全面审计与规范化整理（收尾）
172. 2026-09-02 设置「模型 + 模型管理」合并为单页
173. 2026-09-02 设置「插件市场」并入「插件」页
174. 2026-09-02 插件市场（community-market）加载慢/图标卡顿修复
175. 2026-09-04 harness 装配修复：Firecrawl MCP + 两技能落地生效
176. 2026-09-03 清理：确认无影响的游离调试日志
177. 2026-09-03 文档对账：插件清单补全 + AGENTS.md 自动区刷新
178. 2026-09-02 审计修正：#16 LaTeX 实为已内置（初版误判），Mermaid 评估暂缓
179. 2026-09-03 收尾清理：临时残留清理 + 未提交成果归档提交
180. 2026-09-03 autoread 读图限流自愈（model 级 429 自动切换）
181. 2026-09-03 免费视觉模型配置修订（图片面板勾选模型甄别 + 失效 id 修正）
182. 2026-09-02 免费视觉模型调研与配置（OpenRouter :free 通道，替代本地 Ollama 提速）
183. 2026-09-02 工具渲染器 keyed 卡·增量扩展（WorkBuddy #11 / 阶段 1 延续）
184. 2026-09-02 工具渲染器 keyed 卡（WorkBuddy #11 / 方案书 v3 阶段 1）
185. 2026-09-02 图片识别端到端验收通过（用户实测确认）
186. 2026-09-02 收尾清理：大会话归档 + 多余文件整理 + 文档更新
187. 2026-09-02 视觉读图引擎切到本地 Ollama（修复 modlens 读图截断/欠费）
188. 2026-09-02 归档交接：Profile 加固 0-4 阶段闭环 + 多余文件清理
189. 2026-09-02 dsh-model-picker-group 默认接管（方案 A）：会话纯文本模型自动改走 modlens 视觉渠道
190. 2026-09-02 Profile 定位调研定案：web 保留 + 巡检工具链加固
191. 2026-09-02 dsh-model-picker-group 接管映射稳定化（修复「当前模型不支持图片」时灵时不灵）
192. 2026-09-02 web profile 残留清理 + scan-dangling 巡检脚本（可复用工具沉淀）
193. 2026-09-02 关闭前「配置自检」补丁 + 插件删除协议固化（防删插件后重启打不开）
194. 2026-09-01 清理已归档 dsh-tool-visibility 的运行时 Profile 残留引用（修复启动解析报错）
195. 2026-09-01 技能市场安装链路修复（PowerShell 兼容性 + fs API 原子落位）
196. 2026-08-31 新增 paper-writer 论文写作预设（研究生论文模式）
197. 2026-08-31 收尾归档：better-sidebar Office 预览落地 + 前序修复核验
198. 2026-08-29 file-explorer 顶层 return 启动失败修复与启动预检加固
199. 2026-08-30 tool-visibility 路由 404 修复（timer 依赖补全 + 回归守卫）
200. 2026-08-30 tool-visibility profile 启动报错修复（bundle 缺 dsh.bundle 声明）
201. 2026-08-28 context-lifecycle 压缩提示条跨会话串显修复（banner sessionId 字段 bug）
202. 2026-08-28 开源技能市场目录源（DSH Skills Index）+ 工作区临时残留清理
203. 2026-08-28 启动报错根治：@dsh-external/dsh-vision-rotator 残留引用清理
204. 2026-08-28 文件浏览器文档预览：docx/xlsx/pptx/pdf 文本提取 + 图片预览 + 系统打开兜底
205. 2026-08-28 视觉引擎修复：通道健康感知 + 单写者收敛 + rotator 停用
206. 2026-08-27 收尾迭代（建议落实）：task-scheduler 跨通道锁一致性修复 + unpacked 健康探针
207. 2026-08-27 收尾：代码质量全检 + 错误日志 + 文档同步 + 清理登记
208. 2026-08-27 跨对话任务调度机制（dsh-task-scheduler）—— 多会话并发冲突防护
209. 2026-08-27 桌面壳鲁棒性修复（launcher / 退出完整性提示 / 工作区检测 / 解包契约护栏）
210. 2026-08-27 safe-delete-shim 启动崩溃根治修复
211. 2026-08-26 维护清扫周报（缓存清理 / 补丁修复 / bundles 收敛 / 插件清理 / 竞态加固）
212. 2026-08-26 插件市场加载失败排障与市场提供方切换（dsh-market → dsh-community-market）
213. 2026-08-26 自研常驻组件代码审查与修复（4 处，与市场切换合并一次重启生效）
214. 2026-08-26 插件市场恢复至设置顶级分区（community-market 客户端补丁 + 流水线登记）
215. 2026-08-26 设置界面卡顿优化（dsh-ui-performance 插件）
216. 2026-08-26 生产收尾（最终收敛：协议统一 + 智能维护内置 + 冗余清理 + 文档定稿）
217. 2026-08-25 插件单元测试 + CI（GitHub Actions）
218. 2026-08-25 execPath 同类问题扫描审计结论（补丁 #15 后续）
219. 2026-08-25 长期稳定性：装配/标题/通道修复（agent 会话）
220. 2026-08-25 长期稳定性：session-hygiene 修复验证通过 + maintenance 误杀修复
221. 2026-08-25 长期稳定性：session-hygiene 修复 + 装配对齐 + 每日巡检安装器
222. 2026-08-25 shell 工具静默假成功定案与修复（补丁 #15）
223. 2026-08-25 插件登记表 + 实验目录清理 + vendor 漂移确认
224. 2026-08-25 Pre-commit hook + AGENTS.md commands 区修正
225. 2026-08-25 dsh-host-services：6 插件本地 API 样板收敛为单一事实来源
226. 2026-08-25 可维护性加固：工作区卫生 + 一键验证 + 脚本索引
227. 2026-08-25 流程机制：五段式工作流铁律写入 AGENTS.md
228. 2026-08-25 「不在项目中工作」修复：会话不再落入当前项目工作区
229. 2026-08-25 启动加固：ZombieCleanup + 定期维护脚本 + 14 项补丁校验全绿
230. 2026-08-25 卡死定案：vision-rotator 同步 curl 探针每 5 分钟阻塞内核主线程（已修复，待重启生效）
231. 2026-08-25 界面变透明 + 未响应 + 打不了字：根因定位与彻底修复（待重启生效）
232. 2026-08-25 同日第二轮：不透明窗口仍「卡住后变透明」——遮挡检测误报（已补丁，待重启生效）
233. 2026-08-25 投产审计修复全量落地 + 运行时验收通过
234. 2026-08-24 工作区目录选择器回归修复：恢复跨盘选择 + 新增「上一级」导航
235. 2026-08-24 视觉引擎配置名乱码根治（复发的 GBK 编码问题）
236. 2026-08-24 生产就绪基线 v1.4.0-production（升级方案 P0-P1.5 全部闭环）
237. 2026-08-24 弹窗根因终结：Ollama 生命周期重写 + 识图引擎切云端（用户决定弃用本地模型）
238. 2026-08-24 构建链路统一：单一事实源 + 旧构建归档（根治"补丁打在旧目录/重启无变化"）
239. 2026-08-23 弹窗治理 + 退出保护机制 + Ollama 自启 + 生产上线方案（详见 docs/PRODUCTION-UPGRADE-PLAN.md）
240. 2026-08-23 安全审计与加固 + 前端刷新/图标修复（详见 docs/migration-audit-2026-08-22.md §8）
241. 2026-08-23 合并迁移后功能修复：远程连接/「不在项目中工作」还原 + 插件兼容适配 + 迁移审计（详见 docs/migration-audit-2026-08-22.md）
242. 2026-08-22 dsh 0.1.1-rc.2 升级后遗症修复：modlens 粘贴路径 + 启动自愈前移 + 核心补丁适配
243. 2026-08-22 更新兼容性机制：更新前评估风险 / 更新后自检 / 一键回滚（v1.4.0 开发中）
244. 2026-08-21 modlens 视觉体系重构：本地引擎 + 自动读图 + 选择器精简（v1.4.0 开发中）
245. 模型管理增强：获取可用模型弹窗搜索（v1.4.0 开发中 · 补丁层）
246. 插件中心（v1.4.0 开发中 · 源码层，未打包）
247. 故障排查记录：dsh 服务反复崩溃 / 界面打不开 / "Failed to load plugins"（2026-08-20）
248. DeepSeek Harness 桌面端 v1.3.0 发布说明
249. 新功能（鲁棒性改造：报错可定位 / 不致命 / 不重复）
250. 测试与实测
251. 错误码速查
252. 故障排查记录
253. 版本号
254. DeepSeek Harness 桌面端 v1.2.3 发布说明
255. 修复内容（src/main.js / src/patch-dsh-native-picker.js）
256. 故障排查记录：重打包后 exe 启动卡死（BOM）
257. 故障排查记录：rc.7 升级后"页面空壳 / 点击无响应"
258. 故障排查记录：modlens 配置卡片在"设置 → 插件"页消失
259. 功能改进（dsh-remote-workspace 插件，改动在 plugins/ 源码）
260. 稳定性验证（v1.2.3）
261. 环境清理（v1.2.3）
262. 已知问题
263. DeepSeek Harness 桌面版 v1.2.2 发布说明
264. 修复内容（src/main.js）
265. 排查记录：「新会话无反应」真正根因
266. 已知设计行为（非 bug）
267. DeepSeek Harness 桌面版 v1.2.1 发布说明
268. 核心修复：端口被僵死进程占用时自愈，不再闪退
269. DeepSeek Harness 桌面版 v1.2.0 发布说明
270. 核心改进：DSH 后端彻底独立于 QClaw
271. 其他检查结论
272. v1.1.9 — 全面代码审计修复：更新流程健壮性与窗口恢复
273. v1.1.8 — 新建工作区路径末尾被截断的根本修复
274. v1.1.7 — dialog null 防御与更新检查健壮性
275. v1.1.6 修复、安全加固与插件管理增强
276. 🐛 严重 Bug 修复
277. ✨ 插件管理增强
278. 🔒 安全加固
279. ✅ 验证
280. 使用
281. v1.1.5 Bug 修复与安全加固
282. 🐛 严重 Bug 修复
283. 🔒 安全加固
284. 🛠️ 健壮性修复
285. ✅ 验证
286. 使用
287. 2026-08-19 插件：modlens 配置守卫 + 模型选择器合并排版
288. 2026-09-06 桌面窗口「打字卡住/未响应」根因修复（dsh-better-sidebar 折叠时空转循环）

---

## 7. 迁移判定速查

| 判定 | 数量 | 含义与处置 |
|---|---:|---|
| `keep` | 17 | 官方无等价物，值得保留 |
| `partial` | 19 | 官方部分覆盖，看情况 |
| `builtin` | 4 | 官方已内置，**不要重做** |
| `dep` | 2 | 纯依赖，跟着别的走 |
| `rework` | 2 | 引用了 0.2.0-rc.2 已移除的包，**必须改代码** |

**按风险分档的建议**（详见 `outputs/2026-09-30-report-plugin-migration-decision/`）：

- **A 组（10 个，无风险直接用）**：`host-services` `task-scheduler` `self-maintenance` `session-hygiene` `health-dashboard` `tool-audit` `code-security-guard` `temp-tracker` `project-brief` `prompt-enhance`
- **B 组（价值高但会主动做事 / 改路由，需逐个实测）**：`command-guard` `model-inspection-guard` `model-provider-failover` `model-tier-router` `memory-guard` `crashpad-hygiene` `instance-janitor` `vision-rotator` `memory-files`
- **C 组（带前端面，坏了整页废）**：其余 11 个
- **D 组（必须重写）**：`remote-workspace` `super-injector`
- **E 组（不必重做）**：§3 那 4 个

---

## 8. 如果要重建某个插件：操作指引

### 8.1 先读源码，不要从零写

源码在 GitHub（`github.com/luomious/deepseek-harness-desktop` 的 `plugins/` 目录）。**先 clone 或直接读远端文件**，绝大多数插件的实现可以直接对照移植。

### 8.2 移植一个 host 侧插件的最小步骤

```powershell
# 1) 取源码
git clone git@github.com:luomious/deepseek-harness-desktop.git D:\dsh-harness-src
# 2) 放到 DSH home 下的本地插件目录
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\local-plugins" | Out-Null
Copy-Item -Recurse D:\dsh-harness-src\plugins\dsh-<name> "$env:USERPROFILE\.dsh\local-plugins\"
# 3) 在 profile 里登记（防 pnpm 清理）
#    编辑 ~/.dsh/profiles/desktop/package.json 的 dependencies：
#    "@dsh-external/dsh-<name>": "link:<绝对路径>"
# 4) 在 profile 的 cordis.patch.yml 里挂载
#    - insert:
#        - id: <name>
#          name: '@dsh-external/dsh-<name>'
# 5) 重启应用，读启动日志确认挂载行 / 无 cannot resolve
```

### 8.3 移植时必须检查的四件事

| 检查项 | 怎么查 | 为什么 |
|---|---|---|
| **是否依赖 0.2.0-rc.2 已移除的包** | 搜 `dsh-client-runtime` / `dsh-settings-file` / `dsh-compaction` | 有就直接失败 |
| **是否用"自身文件位置"推导路径** | 搜 `import.meta.url` / `__dirname` / `WORKSPACE_ROOT` | 换位置就失效。例：`dsh-host-services/lib/index.js:61,512` 用 `PLUGIN_DIR/../..` 推 repoRoot —— **它支持 `health.repoRoot` 显式配置**，移植时务必配上 |
| **是否引用硬编码绝对路径** | 搜 `Deepseek-Harness` / `D:\\` | 例：`dsh-self-maintenance/cordis.patch.yml` 的 `radarStateFile` 指向旧仓库 |
| **宿主服务是否还在** | 看插件的 `inject` 列表 vs 新版内核的服务清单 | 新版移除了 `hmr` / `agentDefaultModel` / `settings`，新增 32 个 |

### 8.4 client 侧插件的额外要求

必须走官方的客户端机制（`slots` / `dsh-client-modules` / `dsh-client-ui-slots`），**不要照抄 0.1.x 的 `__ModuleLoader__` 直注册写法** —— 官方已经重构了客户端服务面。

---

## 附：本文件的来源

| 内容 | 来源 |
|---|---|
| 44 插件判定与用途 | `outputs/2026-09-30-report-dsh-migration-plan/evidence/migration-matrix.json` |
| 插件兼容性 | `outputs/2026-09-30-report-dsh-2-0-16-migration-record/plugin-compat.json` |
| 踩坑清单 | `CHANGELOG.md`（295 节）+ `outputs/` 下事故报告 |
| 18 provider | `outputs/2026-09-30-report-dsh-migration-plan/patches/P0-llm-providers.patch.yml` |
| 9 处壳补丁 | `outputs/2026-09-29-feature-audit/README.md` §补丁总账 |
