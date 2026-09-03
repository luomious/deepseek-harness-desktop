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

### plugins/ 目录（27 个）

| 插件 | 装配 | 状态 | 热重载 | 用途 |
|------|------|------|--------|------|
| `dsh-file-explorer` | patch-insert | core | ⚠️ | 右侧文件浏览器（details 面板）：文件树 + 代码高亮 + 文档预览（docx/xlsx/pptx/pdf 零依赖文本提取、图片预览、大文本分段预览（UTF-8 边界窗口翻页）、旧版二进制「用系统程序打开」兜底；2026-08-28 增强） |
| `dsh-force-reasoning-effort` | patch-insert | experimental | ✅ | 强制 reasoning-effort 能力（无 reasoning 元数据的模型也显示思考强度控件） |
| `dsh-frontend-reload` | patch-insert | core | ✅ | 前端刷新按钮 + Ctrl+R（桌面壳 Windows 无应用菜单时的兜底） |
| `dsh-command-guard` | bundle | core | ✅ | 命令风险检测：监听 tool/call 的 shell/exec 类命令做风险评分（共享 risk-rules 模块），高风险命令告警 JSONL + 状态路由 |
| `dsh-prompt-enhance` | bundle | core | ✅ | 提示词增强：一键将用户输入改写为更精确的提示词 |
| `dsh-tool-renderers` | bundle | core | ✅ | Tool renderer keyed cards：为 DSH 专属工具（goal/jobs/subagent）注册 tool.call.toolview keyed 渲染器（null-safe 摘要） |
| `dsh-hy3-gateway` | bundle | experimental | ✅ | HY3 OpenAI 兼容网关自动启动（CloudBase 免费混元） |
| `dsh-host-services` | bundle | core | ⚠️ | 本地 HTTP API 样板收敛（trusted/readBody/registerLocalApi 单一事实源） |
| `dsh-model-picker-group` | bundle | core | ⚠️ | 模型选择器分组（供应商模型 + modlens 双胞胎排序） |
| `dsh-model-provider-failover` | bundle | experimental | ✅ | Provider 级请求故障转移（只读观测 `agent/request-error` 冷却失败 provider，`agent/request` 决策路由到备用；默认 no-op，未持久化装配——见 docs/ROUTING-GATEWAY-PROPOSAL.md P1-1；2026-09-04 入库，含单测+fake-ctx 集成测试） |
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
| `@openviking/dsh-memory-plugin` | external | ⚠️ 建议重启（bundle 类） | 记忆中台插件（openviking 记忆持久化/检索，dsh 会话绑定）。v0.3.0，2026-09-02 装配登记进运行态 + 模板（deps + bundles 均已同步）；用途与读写路径待用户按需启用验证。（2026-09-04 对账补登） |

## 统计

- 总计: 31（plugins/ 28 + 根级 3）| core: 27 | experimental: 3 | deprecated: 1（dsh-vision-rotator）｜ profile 市场安装: 3（dsh-context + dsh-better-sidebar-plugin-office + dsh-memory-plugin）
- 装配方式（plugins/）：bundle 20 | patch-insert 8（根级守护另列）①
- 必须重启: 2 (modlens 类：dsh-modlens-autoread / dsh-modlens-guard)。其余热重载/建议重启以右侧表格逐行标注为准，不在此汇总（避免与表格口径打架）。
- 未持久化装配（仓库内默认 no-op，可随时重新注入）：dsh-model-provider-failover（P1-1）

> ① 根级守护插件（dsh-context-lifecycle / dsh-stuck-loop-guard）经 bundle 数组装配；vision-rotator deprecated，不在运行态。
