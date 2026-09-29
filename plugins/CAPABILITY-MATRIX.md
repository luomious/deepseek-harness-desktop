# 插件能力矩阵 · 上游原生对照与保留/合并/退役决定

> 评估日期：2026-09-28 ｜ 对照内核：**0.1.7-rc.2**（候选 build `win-unpacked-build202609272329`）｜基准内核：0.1.1-rc.2
> 来源：6 批并行深读（逐文件核实、`路径:行号`）+ `kernel-surface` 快照 + 直接 grep 两版内核
> 机器可校验：`node scripts/verify-inventory.mjs`（本文件的表格即数据源）

## 列定义

| 列 | 含义 |
|---|---|
| **上游原生** | `full` = 上游已提供等价能力，本插件可退役；`partial` = 上游有部分/相邻能力，本插件仍有增量；`none` = 上游无同类，**内核缺它没人做** |
| **决定** | `保留` / `收敛`（保留但砍职责）/ `合并`（并入他处）/ `退役`（下线归档）/ `重写`（能力要但要重做实现） |
| **前置** | 执行该决定前必须先做的事（空 = 可直接做） |

> 判定纪律：`none` 必须有**反证**（grep 两版内核 0 命中或逐条核过）；查不实的一律标 **`none`(未验证)**，不算作已证。

## 一、plugins/ 自研插件（40 个）

| 插件 | 上游原生 | 决定 | 前置 | 依据（实测） |
|---|---|---|---|---|
| `dsh-file-explorer` | **full** | **退役** | 确认"工作区外路径浏览"是否仍需 | 上游 `ui-sidebar-files`（工作区文件树，Mod+P）+ `ui-sidebar-documentpreview`（**Markdown/代码/图片/PDF/Office/HTML 真渲染**，Word/PPT 本地转 PDF，表格浏览器打开）+ `open-in-app` + `file-upload` 均在 `dsh-web-app/cordis.patch.yml` **默认启用**；且本插件与上游 `ui-conversation` **争同一个 `details` 槽**（旧 `:10249` / 新 `:10248`） |
| `dsh-session-history` | **partial** | **合并** | — | 上游 `session-turn-outline` + `ui-chat` 右侧 turn rail（`ui-chat/lib/client.js:5052-5053,3564`，默认启用）；本插件只剩「用户消息粒度 + 悬停富卡」，且靠 5 个 DOM 属性 + 2 个上游 class 前缀取数 |
| `dsh-web-fetch-local` | **full** | **退役** | 把 `web.fetchProvider` 从 `bing-fetch` 改到 `http` | 上游 `dsh-web-fetch-http` 由 `dsh-base/cordis.patch.yml:482-483` **默认挂载**，含 URL 校验/公开地址解析/连接固定/仅同源重定向/字节字符上限/显式 UA，**并拒绝非公开目标**（= 已内置 SSRF 防护） |
| `dsh-memory-files` | **full** | **合并** | 确认是否必须占 system prompt 区块 | 原生 `dsh-agent-instructions` 在 **0.1.1 与 0.1.7 都由 `dsh-base` 挂载**（旧 `:232` / 新 `:288-291`），候选文件名可配（`agent-instructions/lib/index.js:17,71`），预算 64KB、per-step + digest 去重、触碰感知 —— 机制比本插件更完善 |
| `dsh-vision-rotator` | n/a（已停用） | **退役** | **先解装配**（仍在 `bundles:116`！） | 台账称"不在运行态"是**错的**；职责已由 modlens 3.23 内置 failover + vision-engine `autoFailover` 承接；其 spare-keys 池实测已残废（2026-09-22 记录 4 条通道全废），且整体重写 `providers.openai` 与 vision-engine 单写者双写冲突 |
| `dsh-modlens-guard` | none | **合并/退役** | 改 `PATCH_PATH` 或直接退役 | 它守的是 **web** profile（`lib/index.js:25` 硬编码），对 desktop **完全无效**；desktop 的 modlens 行本就无 `visionProvider: false` |
| `dsh-model-provider-failover` | none | **重写** | 给 error 监听器加 `{prepend:true}` | 失败路径**零生产证据**：日志 37/37 条 `FAILOVER` 的 `session=sess-1`（全是自测载荷）；其 error 监听器**无 `{prepend:true}`**（`lib/index.js:263`），被内核 `dsh-llm-retry` 内层跳过 ⇒「一次即冷却+接管恢复」自 09-15 起从未生效。**且测试在写生产日志** |
| `dsh-model-whitelist` | none | **重写（client 半）** | 包装点改 `session.modelCatalog` | 0.1.7 把选择器数据源从 `sessions.models` 改为 `session.modelCatalog`（`dsh-client-ui-model-selection/client.js:118`），全内核已无客户端调旧 RPC ⇒ 白名单过滤**升级后静默失效且不报错**；host 半（测试连接端点）仍有效 |
| `dsh-model-picker-group` | none | **重写或退役** | 同上层 + modlens 组命名核对 | 同上数据源搬迁 ⇒ 分组重排静默失效；职责与 modlens/vision-engine 有重叠（未验证是否可整体退役） |
| `dsh-session-hygiene` | none | **保留+必修** | 修死代码注入 + `events.jsonl` 加轮转 | 无原生「会话体积/磁盘卫生」；但①`agent/pre-step` 的注入是**死代码**（两版内核 decision 由 fallback 新建，payload 上的 `additionalContexts` 永不进入 decision）②`data/events.jsonl` 实测 3.82 MB **无轮转无上限** |
| `dsh-session-watchdog` | none | **保留待重估** | 用户策略确认 | 能力无替代，但 0.1.7 `dsh-goal-round-driver/README.zh.md:57` 明确「**驱动器绝不会自行复活工作**」⇒ 与本插件存在理由（自动 resume）**设计上对抗**，属策略选择 |
| `dsh-context-lifecycle` | **partial** | **收敛** | 砍掉 compact 分支 | 上游 `dsh-compaction-basic` 的 `auto` 默认 `true`（`lib/index.js:85,827`）+ `ui-conversation` 上下文占用圆环已覆盖大半；只留「新会话建议 + 交接摘要」 |
| `dsh-diff-guard` | **partial** | **保留+收口** | 修 fail-open；凭据改走 `ctx.credentials` | 「高危走 approval」方向正确（上游 `experimental-auto-review` + fs 沙箱审批是同类），但实测**缺陷**：`approval.request` 放在 try 内、异常被 `catch { return next() }` 吞掉 ⇒ **静默放行**，与自称的 fail-closed 不一致；另自读 `.credentials.yaml` 直连 api.deepseek.com（架构越层） |
| `dsh-prompt-enhance` | none | **保留+收口** | 改走 `ctx.get('llm')` | 两版内核 grep `enhance` 零命中；但硬编码 `deepseek-chat`、直连 api.deepseek.com、自读明文凭据 ⇒ 绕过内核 LLM 路由/凭据管理 |
| `dsh-command-guard` | **partial** | **保留** | 删重复规则表 | 上游新增 hooks 体系（`hooks-claude-code` / `hooks-codex`）与 `tools.guard()`，但**命令风险规则表本身无原生同类**；本插件 `index.js:31-33` 显式不 import `risk-rules.mjs`，两表逐条重复 |
| `dsh-health-dashboard` | none | **合并** | 并入 host-services 的探测表 | 内核无 `/health`、无 healthProbe；但本项目已有 `dsh-host-services` 的统一 `/health`（**7 项**探测）⇒ 两套聚合端点、两套口径 |
| `dsh-tool-renderers` | none | **保留** | 复核 key 漂移 | 内核内建 keyed 注册只有 ask_user_question/bash/edit/write/read/grep/glob/todo_write/web_search/web_fetch；goal/jobs/subagent 三个官方包**不注册** `tool.call.toolview`；失效 key 静默回退通用卡，不报错 |
| `dsh-ui-performance` | **partial** | **保留** | 删已失效的规则一/二、补 `blur(40px)` 菜单材质 | ① 规则一/二针对的 `--dsw-mask-blur` 在 0.1.7 已为 `none` ⇒ 退化 no-op；② 规则三~八依赖的 4 组类名 hash **0.1.7 未变**；③ 新风险面：0.1.7 新增 `--dsw-menu-backdrop-filter: blur(40px)` 用于大量菜单 |
| `dsh-frontend-reload` | none(未验证) | **保留** | 升级后实测 Ctrl+R | 新 `dsh-client-shortcuts`/`ui-shortcuts` 内 grep `reload|F5|ctrl+r` **零命中**；且新包自带注释「0.1.7 desktop 仍只发文件路径桥」⇒ 原生 reload 入口未验证 |
| `dsh-memory-guard` | none | **保留** | — | 0.1.7 仅新增 `dsh-win32-process` 的 `TerminateProcess` 原语，**无**"按 commit 压力判据回收第三方进程"的服务；这是唯一挡在蓝屏前的东西 |
| `dsh-self-maintenance` | none | **保留** | renderer 探测与桌面壳解耦（硬编码 `DSH Desktop.exe`） | 磁盘水位/会话体积/GUI 连通/renderer CPU/上游雷达五项巡检在 0.1.7 无对应服务（`dsh-schedule` 是"持久提醒投递回原会话"，语义不同） |
| `dsh-instance-janitor` | none | **保留（过渡）** | 中期推动 hy3-gateway 改走 `ctx.subprocess` | Desktop 生态特有（crashpad_handler / hy3 网关）；0.1.7 `dsh-subprocess-local` 用 Job Object 在宿主退出时终止成员，但 `dsh-hy3-gateway` 用**裸 `spawn(detached)`** 绕开了它 |
| `dsh-task-scheduler` | none | **保留** | — | 跨会话互斥锁 + 优先级抢占 + 变更时间线 + stale 基线在 0.1.7 **无同类**；`dsh-workspace-changes` 只在"发现文件被改"上轻微重叠 |
| `dsh-model-tier-router` | none | **保留** | — | 官方无分级路由；本插件 445 条 `SWITCH` 真实会话记录 = 本批**唯一有强生产实证**的模型路由插件 |
| `dsh-model-inspection-guard` | none | **保留** | — | 官方无审核拒收规避；**09-26 有真实生产救援记录**（`RESCUE-TRIGGERED turn=22 step=7`，排除测试污染）⇒ 本批唯一有生产救援实证的插件 |
| `dsh-developer-role-guard` | none | **保留（须先自证）** | 补日志 + 受控重启验证「已包装」是否恢复 | 接缝在 0.1.7 结构未变（`dsh-llm-pi-ai:1756` `current()` 等均在）；但 09-27 前每次启动都有「已包装」记录，**09-28 起 6 次启动零记录** ⇒ 疑似空转；且它是 ModelScope developer 事故的**放大器**，不能贸然退役 |
| `dsh-force-reasoning-effort` | none(未验证) | **保留（须先自证）** | 同上 | 机制未变（0.1.7 仍按模型 `reasoning` 元数据驱动强度）；同样 09-28 起零「snapshot 补丁」记录 |
| `dsh-modlens-autoread` | none | **保留** | 升级后做"纯文本模型+发图"端到端回归 | 两版内核描述里 vision/ocr 命中均为 0，**官方没有任何识图/OCR/视觉桥包**；本插件强耦合 `agent/pre-step` 的 `decision.messages` 结构 + `attachments.readImage` 形状 |
| `dsh-vision-engine` | none | **保留** | 升级后先跑 `/vision-engine/health` | 视觉链唯一入口；依赖内核只到 `webServer` + 本地 `hostServices`（`settings.section` 槽 0.1.7 仍在） |
| `dsh-web-search-bing` | none | **保留** | — | 官方 `web-search-deepseek` 需账号额度；profile 注释记录 modsearch 的 firecrawl 被本网 IP 封 ⇒ 不可替代。`dsh-web` 的 provider 契约两版**逐字相同** |
| `dsh-hy3-gateway` | none | **保留** | — | 第三方免费网关，零内核 API 依赖（只用 `spawn`/`process`/`globalThis`）⇒ 升级基本不影响 |
| `dsh-diagram-renderer` | none | **保留** | 盯 `webServer.register` 与 session 结构 | 两版内核 grep `mermaid` **均 0 命中**；上游仅有 `ui-deliverables` 的 present 卡与 turnTail，不成替代。自有 9 文件回归测试 + skill |
| `dsh-project-brief` | **partial** | **保留** | — | 原生 `agent-instructions` 只**加载** AGENTS.md，无生成/指纹/分区维护能力 |
| `dsh-skills-manager` | **partial** | **保留** | 复测 `settings.section` 渲染 | 0.1.7 有 `skill`/`skill-filesystem`/`ui-skill`，但 `settings.section` 的注册者实测只有 agent-preset/account/general/models/plugins，**无 Skills 页** |
| `dsh-system-notify` | none | **保留** | 复测 `assistant-step` 选择器 | 0.1.7 客户端 `Notification.*` 零命中；**5 个自研插件消费 `notify`**（memory-guard / instance-janitor / crashpad-hygiene / self-maintenance / session-hygiene）⇒ 不可静默删 |
| `dsh-remote-workspace` | none | **拆半** | **客户端半改接 `ADD_WORKSPACE`**（上游把 `remoteFlow` 槽整体重写） | host 半（SSH/WSL/Docker、`remote_bash`、systemPrompt 注入）无替代；client 半挂在已被上游删除的槽上 ⇒ **远程面板入口会静默消失**（`smoke-test.ps1:44-51` 已记录该重写） |
| `dsh-stuck-loop-guard` | **partial** | **保留** | — | 原生 `repeat-tool-reminder` 只做**精确重复**；本插件按「工具+错误码+归一化签名」的连续失败链 3 次诊断/5 次升级，粒度更细 |
| `dsh-crashpad-hygiene` | none | **保留** | 核对与诊断包 50MB 预算的冲突（现 maxKeep=2≈70MB） | 壳只采集+诊断导出，**无配额回收**（vendor 源码 grep `maxKeep/retention/quota` 清理逻辑 0 命中） |
| `dsh-tool-audit` | **partial** | **保留** | 考虑改由 session 事件派生，取消双写 | 内核无 audit 包，但原生 session 已留痕 `tool/call`+`tool/result` 落 JSONL；耗时/参数摘要仍需插件 |
| `dsh-temp-tracker` | none(未验证) | **保留观察** | 定去留：至今**无消费方** | 只写不删、无端点、无消费方（台账称"为后续清理提供数据基础"，至今无清理方） |
| `dsh-code-security-guard` | none | **保留** | 补规则漂移测试 | 两版内核 grep `dangerouslySetInnerHTML\|pickle.load\|os.system` **0 命中**；但①其 `tests/smoke-rules.test.mjs` 自己重抄了一份规则表 ⇒ 对漂移**零检出能力** ②自身 `package.json` 描述仍写已过时的 `tool/call` |
| `dsh-host-services` | none | **保留（底座不可退役）** | 把 6 处深路径耦合收成正式导出 + 补测试 | 内核无 `trusted/readBody/registerLocalApi/json`；被 **6 个插件**相对深路径 import ⇒ 架构单点，换目录即同时失败 |
| `dsh-routing-suite` | none | **保留（分层治理）** | injector 私有面抽 adapter；**不在升级窗口重建 tgz** | 生态唯一免重启通道（`dev_install_package`/`dev_uninject_plugin` 全依赖它）；但 `injector` 直改 10 类内核内部面、**lib 内联整份内核**（`lib/index.js:30-6809`）⇒ 每次升级必须重建 |
| `@dsh-external/dsh-super-injector` | none | **保留** | — | `dsh-routing-suite` 内的 `file:` tgz 组件（`dsh-external-dsh-super-injector-0.3.3.tgz`），**独立成一条装配名**（bundles 里的名字是它，不是 routing-suite）⇒ 单列登记，避免"运行态有名字、台账无行" |
| `dsh-settings-scope-shim` | n/a（垫片） | **保留（临时）** | 上游恢复 `settingsScope` 提供者后可退役 | 0.1.7 **删除了 `settingsScope` 提供者**（实测 0 个 provider）而消费方仍在（settings-models / conversation）；本垫片是唯一提供者。2026-09-28 已收敛为**只 provide `settingsScope` + `uiConversation`**（原先 10 个会与官方抢注册、`cordis:813` 遇重名抛错 ⇒ 白屏风险） |

## 二、根级守护插件（3 个）

| 插件 | 上游原生 | 决定 | 依据 |
|---|---|---|---|
| `dsh-context-lifecycle` | partial | 收敛 | 见上表同名行 |
| `dsh-stuck-loop-guard` | partial | 保留 | 见上表同名行 |
| `dsh-vision-rotator` | n/a | **退役（须先解装配）** | 见上表同名行 |

## 三、profile 市场 / npm 安装（3 + 16）

| 插件 | 上游原生 | 决定 | 依据 |
|---|---|---|---|
| `dsh-context` | none | 保留（已升版 0.59.2） | 上下文可视化页；第三方生态活跃 |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | **partial** | 评估退役 | 上游已带 **Office/PDF 真渲染**（`ui-sidebar-documentpreview` + `office-to-pdf` + 内置 LibreOffice），Office 预览能力重叠 |
| `@openviking/dsh-memory-plugin` | none | 保留待接通 | 其 MCP 检索工具面未接通（实检索无匹配） |
| `dsh-safe-delete` | none | **退役候选** | ①声明在 deps 但**不在 bundles**、无 `dsh.bundle.patch` ⇒ 从未加载；②其最新版 0.2.1 仍 import 已被 0.1.7 删除的 `installSettingsSection`/`settingsNamespace` ⇒ **无兼容版本**；③回收站能力实由自有补丁 `patches/bundles/safe-delete-shim.cjs` 提供 |
| `dshmarket` / `dsh-find-plugin` | **partial** | 评估退役 | 上游新增 `dsh-plugin-manager` + `dsh-client-ui-plugin-manager` + `dsh-package-manifest` |
| `dsh-bash-terminal` | **partial** | 评估退役 | 与官方 terminal 栈（`ui-sidebar-terminal` + `dsh-terminal`）重叠 |
| `@liustack/modlens` / `modsearch` / `pptwise` / `hindsight` / `dsh-mcp-lens` / `dsh-office-tools` / `dsh-skills-manager`(自研) | none | 保留 | 无 peer 约束或已核；`dsh-office-tools` 与 `dshmarket` 的 peer 在升级后**状态翻转**（已记录） |

## 四、总结

| 决定 | 数量 | 插件 |
|---|---|---|
| **退役** | 5 | `dsh-file-explorer`、`dsh-web-fetch-local`、`dsh-vision-rotator`、`dsh-safe-delete`（候选）、`dsh-modlens-guard`（候选） |
| **合并** | 3 | `dsh-session-history`、`dsh-memory-files`、`dsh-health-dashboard` |
| **重写** | 3 | `dsh-model-provider-failover`、`dsh-model-whitelist`(client 半)、`dsh-model-picker-group` |
| **收敛/拆半/收口** | 6 | `dsh-context-lifecycle`、`dsh-remote-workspace`(拆半)、`dsh-diff-guard`、`dsh-prompt-enhance`、`dsh-ui-performance`、`dsh-command-guard` |
| **保留** | 其余 | 30 个（含 3 个须先自证：`dsh-developer-role-guard`、`dsh-force-reasoning-effort`、`dsh-session-watchdog`） |

**收益估算**：退役 5 + 合并 3 + 重写 3 ⇒ 维护面从 40 降到约 **33**；其中 3 项（file-explorer / session-history / web-fetch-local）是"上游已接管"，退役后**净减约 2,000 行自研代码**，且不再与上游争槽位。

## 五、本次评估推翻的台账说法（纠错记录）

| # | 台账原文 | 实测事实 |
|---|---|---|
| 1 | `INVENTORY.md:104`「`dsh-model-provider-failover` 未持久化装配」 | **已在 bundles**（`profile/desktop/package.json:115`）⇒ 台账过期 |
| 2 | `INVENTORY.md:89/106`「`dsh-vision-rotator` 已停用 / 不在运行态」 | **仍在 `bundles:116`** + deps:44 + junction 在位，patch 层无 disabled ⇒ 下次 desktop 启动它会 apply() |
| 3 | 台账**无** `dsh-settings-scope-shim` 行 | 它在 deps:63 与 `cordis.patch.yml` insert 里都已装配 ⇒ 已补 |
| 4 | `INVENTORY.md:46` command-guard「共享 risk-rules 模块」 | **反向**：`index.js:31-33` 显式不 import，规则表内联重复 |
| 5 | `INVENTORY.md:61/63`「`agent/request-error` 送不到插件监听器」 | 应降级为「**未 prepend 的内层监听器收不到**；`{prepend:true}` 的外层可收到」——`dsh-model-inspection-guard` 09-26 有真实生产救援为反例 |
| 6 | `INVENTORY.md:51` health-dashboard 聚合含 session-hygiene | `index.js:43` 默认 `sessionHygiene: null`（不计） |
| 7 | `INVENTORY.md:57`「host-services 7 项探测」 | 代码确为 7，但该插件 `README.md` 写 8、工作区 `AGENTS.md` 写 10 ⇒ **三处口径不一致，需统一** |
| 8 | `INVENTORY.md:73` session-hygiene「Electron 通知 **+ 对话注入**」 | 对话注入是**死代码**（两版内核皆然）⇒ 只有通知生效 |
| 9 | `INVENTORY.md:73`「内核无归档 API」 | 不准确：`ctx.workspaceRegistry.archiveSession()` 两版都有（语义是记录归档/门禁，不搬 jsonl 文件） |
| 10 | 标题「plugins/ 目录（38 个）」 | 实测 **40** 个含 `package.json` 的目录 |
| 11 | `INVENTORY.md:11`「patch-insert 类插件自带 `cordis.patch.yml`」 | `dsh-project-brief` 目录内**没有**该文件 |
| 12 | `INVENTORY.md:43` diagram-renderer「v5 自适应」 | 实际 `README.md:5` 已是 **v9 设计系统**，`lib/scene-v2.js` 即 v9 内核 |
| 13 | `INVENTORY.md:53` prompt-enhance「一键将用户输入改写」 | 无 client 半、无按钮，是给 **agent 调用**的工具（`index.js:80`） |
| 14 | `dsh-session-history` 自身 `package.json:12` 描述 | 写成"会话历史弹窗"，实现是**用户消息 mini-map 竖条**（台账描述反而是对的） |

## 六、未验证清单（不算作已证）

- 0.1.7 是否存在"命令/路径风险规则表""代码模式扫描""临时文件追踪"的原生同类（只证了无内置 audit 包、无 `/health`、无 `trusted/readBody/registerLocalApi`）
- `dsh-spill`/`dsh-output-retention` 与 temp-tracker 的语义边界（未逐行读）
- bundle 装配是否**真的**读取插件目录自带 `cordis.patch.yml`（只核了配置内容与 bundles 命中，未读 loader 实现）
- `uiConversation` / `sidebarRightTabs` 在 0.1.7 的消费方（粗测 0，可能因消费写法不同而漏检）
- `dsh-model-whitelist` / `dsh-model-picker-group` 在 0.1.7 GUI 下是否真的失效（需一次受控重启或 GUI 观测）
- 两个适配器包装插件（developer-role-guard / force-reasoning-effort）09-28 零「已包装」记录的确切原因
