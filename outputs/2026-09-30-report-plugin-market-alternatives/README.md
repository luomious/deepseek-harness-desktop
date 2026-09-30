# 插件市场替代品分析（自研 44 个 + 已装 16 个第三方 vs 4392 个社区插件）

- 日期：2026-09-30
- 数据源：`https://awesome-dsh-plugin.com/plugins.json`（**4392 个插件**，CI 每日刷新，`updated: 2026-09-29`）
- 对比基准：本仓库 44 个自研插件 + 新 profile 里已装的 16 个第三方包
- 证据分级：**[实测]** 有数据/命令证据｜**[注册表]** 来自上述注册表描述字段｜**[未验证]** 没测过

> ⚠️ **重要前提**：注册表里的描述与星数都是**第三方数据**。星数是 GitHub 仓库的 star，**不代表质量、不代表能跑在你的内核上**。所有这些插件的 `@deepseek-ai/dsh` peer 兼容性**全部未验证**（本机内核 `0.2.0-rc.2`，而注册表里大量插件是 0.1.x 时代写的）。

---

## 0. 结论速览

| 判定 | 数量 | 含义 |
|---|---:|---|
| **市场有更好替代** | 18 | 社区版功能更全更成熟，建议改用 |
| **市场有相近替代** | 6 | 功能重叠但各有侧重 |
| **市场无替代，建议保留** | 5 | 自研独有 |
| **官方已内置** | 4 | 不必自研也不必装 |
| **建议直接弃用** | 2 | 无消费者、无替代、无价值 |
| **已装第三方可升级** | 6 | 市场上有更强的同类 |

**一句话**：你自研的 44 个插件里，**真正"市场买不到"的只剩 5 个**；另有 18 个在社区里已有更成熟的实现，2 个建议直接弃用。

---

## 1. 方法

```
1. 下载实时注册表（4392 条，含 name/category/描述/star/downloads/capabilities/capabilityRedLines）
2. 为每个自研插件定义「它解决的问题」的关键词集（中英双语）
3. 在 name + 中文描述 + 英文描述 + category 上匹配，按 star×3 + log10(downloads)×10 排序
4. 人工复核 top 5，剔除关键词误命中
```

**注册表自带的两个字段特别有用**：

| 字段 | 用途 |
|---|---|
| `capabilities` | 插件声明需要的能力（`shell` / `fs-write` / `fs-read` / `network` / `credentials` / `env` / `llm` / `dynamic-code` / `host-runtime`） |
| `capabilityRedLines` | **红线告警**，如 `reads credentials/secrets AND has network access`（既读凭据又能联网）—— 全表 **466 个**插件带红线 |

**本机现状** `[实测]`：本地那个 176 条的注册表快照（`dsh-find-plugin/data/registry-snapshot.json`）是 **2026-08-22** 的，过期 6 周；实时源是 **4392 条** —— 差 **25 倍**。

---

## 2. 自研插件逐个对比

### 2.1 市场有**更好**替代（18 个）

| 自研插件 | 建议替代 | 星数 | 为什么更好 |
|---|---|---:|---|
| `dsh-prompt-enhance` | **`dsh-prompt-enhancer`** | 77 | 5 模式 + 记忆链 + 模型链 + 语音识别（Qwen3-ASR/SenseVoice），带服务异常一键重启 |
| 〃 | `dsh-better-input` | 29 | 输入框内 AI 润色，**带差异预览**与反覆盖保护，跟随界面语言 |
| 〃 | `oss-prompt-optimizer` | 21 | 三种输出形态 + 情境感知画像 + **自迭代学习** + `/template` 命令 |
| `dsh-model-provider-failover` | **`dsh-model-channel-manager`** | 新 | 多供应商共享**一条虚拟路由**（roundrobin/组），失败转移 + 重试 + 超时 + 冷却；设置页可编辑轮询组、跑测速与真实请求测试；**健康面板聚合七天延迟/失败/上游** |
| `dsh-model-tier-router` | **`dsh-auxiliary`** | 12 | 为**视觉/上下文压缩/审批审查/子代理/会话标题/图片生成**分别提供独立模型路由与系统提示 —— 比"高低两档"更系统 |
| 〃 | `dsh-polyglot` | — | 模型切换器，内置免费/低价预设，**免费额度限流时自动回退** |
| `dsh-session-history` | **`dsh-codex-ui`** | 103 | Codex 风格侧栏 + 工作区会话树 + 全局搜索 + 轮次导航（下载量 168,527） |
| 〃 | `dsh-session-workbench` | 51 | 全文搜索 + **一键 @引用召回最多 3 个** + 视图标签栏拖拽排序 |
| `dsh-file-explorer` | **`DSH-better-sidebar`**（**已装**） | 3868 | 侧边栏完整工作台：文件渲染编辑 + 终端 + Git + 子代理，支持三方注册 Tab（下载量 245,487） |
| 〃 | `dsh-popout-sidebar` | 209 | 产物与文件树 + 多预览 + **可弹出为独立窗口拖到另一显示器** |
| `dsh-remote-workspace` | **`dsh-remote`** | 101 | 多机 SSH 远程工作区，在**原生「添加工作区」流程**里选远程目录，镜像成真实本地文件夹 + `rw_*` 工具 |
| 〃 | `dsh-wsl-workspace` | 53 | 从 Web GUI 添加 WSL 工作区，**无需在 WSL 里再装 dsh** |
| `dsh-super-injector` | **`dsh-routing-suite`** | **7003** | **这就是它的上游**！同一仓库三件套（运行时注入器 + 热重载 + 卸载 + 设置页插件管理） |
| `dsh-system-notify` | **`dsh-im`** | 1525 | 9 种 IM 渠道（飞书/微信/钉钉/企微/QQ/Slack/Telegram/Discord/WhatsApp），下载量 48,445 |
| `dsh-session-hygiene` | **`dsh-session-manager`** | 69 | 删除（回收站可恢复/彻底清除）+ 归档恢复 + **活动统计** + 打开日志目录 + 未读标记 + 工作区分组排序 + **上下文压缩阈值设置** |
| `dsh-code-security-guard` | **`dsh-secure-audit`** | 85 | 只读安全合规：**提示注入检测 + 中文 PII 脱敏 + 本机配置安全审计**，输出脱敏可复现报告 |
| 〃 | `sofagent#cordis-plugin-sofagent-audit` | 49 | 24 条 git diff 规则（密钥泄漏/越界改动/提示注入）+ **HMAC 签名审计链** + 快照回滚 |
| `dsh-command-guard` + `dsh-diff-guard` | **`dsh-permission-rules`** | 115 | Claude Code 风格**声明式 YAML 权限规则**（按序 allow/deny/ask），在 `tools/pre-execute` 瀑布上匹配工具名/参数/工作区路径/agent 身份 |
| 〃 | `dsh-approval-gate` | 80 | Flash 预判写入/命令是否可回补，安全自动批准、危险转人工（**fail-safe**）+ diff 对比与一键撤销 |
| 〃 | `dsh-auto-mode` | 164 | 在 workspace-write 与 full-access 之间加 **Auto 权限档**，会话模型复核升权 |
| `dsh-memory-files` | **`dsh-mnemon`** | 420 | 跨 Agent、本地优先持久记忆，可检索项目档案（下载量 34,840） |
| 〃 | `engramory#plugin` | 191 | 纯 markdown，**一条事实一个文件**，索引 `MEMORY.md` 有 200 行/25KB 硬上限 |
| 〃 | `dsh-auto-memory` | 28 | Claude Code 式类型化记忆，**无记忆时零提示词占用** |
| `dsh-vision-engine` + `dsh-vision-rotator` | **`modlens`**（**已装**） | 4063 | 视觉桥：粘贴图片输出结构化 JSON 证据（OCR/版面/语义） |
| 〃 | `dsh-vision-router` | 1125 | 免 Key 视觉链 + 像素级工具（定位/裁剪/像素对比/取色/OCR/矢量化/抠图） |
| `dsh-web-search-bing` + `dsh-web-fetch-local` | **`dsh-free-search`** | 272 | 7 引擎（DuckDuckGo/Bing/SearXNG 免费 + Exa/Perplexity/DeepSeek 付费）+ **自动回退** + 设置页 |
| 〃 | `dsh-web-tools` | 31 | 多供应商搜索与抓取统一入口 + 多 Key 轮询容灾 + 用量与健康监控 |
| `dsh-context-lifecycle` | **`dsh-context`** | 1556 | Context 仪表盘 + `/context` 命令 + Context 浏览器（分类组成/内容详情/演进趋势/压缩注入事件），下载量 106,379 |
| 〃 | `billion-context` | 361 | 上下文压缩，**下载量 275,398** |
| `dsh-session-watchdog` | **`dsh-auto-continue`** | 120 | 请求中断自动续跑（网络/超时/宿主崩溃），错误分类 + 自适应退避 + 浏览器通知 |
| `dsh-diagram-renderer` | **`dsh-genui`** | 486 | 回复内渲染交互式 UI：布局/图表/表单/测验/**mermaid**/3D 场景 + 回传事件循环 |
| 〃 | `dsh-raw-html` | 76 | 把 agent 输出的 HTML 渲染成真实界面，支持 KaTeX 与 **Mermaid** |
| `dsh-skills-manager` | `dsh-echocat-skill-panel` | 196 | 每轮报告调用了哪些 skill + **粘贴仓库/文件夹/SKILL.md/zip 地址即可安装** |
| `dsh-tool-audit` | `dsh-suite#plugin-session-export` | 57 | 把 append-only 会话日志导出为按轨迹来源分组的可读 Markdown/HTML |
| `dsh-self-maintenance` + `dsh-health-dashboard` | `dsh-env-inspector` | 13 | 环境自检与端口大屏：系统架构 + 12 款 CLI 工具链 + **活跃监听端口与悬浮释放** + **模型凭据就绪状态**，零外联零明文 |

### 2.2 市场有**相近**替代（6 个）

| 自研插件 | 相近替代 | 星数 | 差异 |
|---|---|---:|---|
| `dsh-task-scheduler` | `task-passport` | 11 | 用**机器可读检查点 + 乐观锁**在 DSH/WorkBuddy/Claude Code/Codex 之间交接状态 —— 跨工具，不是跨会话锁 |
| 〃 | `dsh-retrace` | 4 | 撤回/重做/版本化 + **实时看门狗（并发写入第一时间快照日志）** —— 能**检测**并发写，但不做互斥 |
| `dsh-stuck-loop-guard` | `dsh-task-control` | 3 | 卡死的工具调用一键急停 + 卡死识别 + 追加条件/暂停/恢复 |
| 〃 | `dsh-messages-sanitizer` | 3 | 工具调度崩溃后自动修复 messages 数组（孤儿 tool_calls），防 400 死锁 |
| `dsh-frontend-reload` | （官方 `dsh-client-hmr`） | — | 官方已内置客户端 HMR |
| `dsh-ui-performance` | `dsh-web-network-optimizer` | 5 | 缓存+压缩降低传输提升加载速度 + 断网自动重连 |
| `dsh-vision-rotator` | `dsh-vision-recognizer` | 2 | 把图片经可配置模型（15+ 供应商）转文字 |

### 2.3 市场**无替代**，建议保留（5 个）

| 自研插件 | 说明 |
|---|---|
| **`dsh-task-scheduler`** | 唯一没有等价的：**多对话之间的文件级互斥锁 + 全局变更时间线**。你的全局 `AGENTS.md`「多对话协作铁律」直接依赖它，`.task-scheduler/changes.jsonl` 已 888 KB |
| **`dsh-project-brief`** | 生成/刷新 `AGENTS.md`。市场里只有 `dsh-purge`（★2564，管理 AGENTS.md **规则集**）和一堆"读取"AGENTS.md 的，**没有"生成/更新"的** |
| **`dsh-host-services`** | `ctx.hostServices` 基础设施 + `/health` 聚合。市场**零命中**同类基础设施插件 |
| **`dsh-model-inspection-guard`** | `data_inspection_failed` 改道重试。市场无直接等价（只有通用 failover） |
| **`dsh-code-security-guard`** | 扫**写入内容**里的危险代码模式 —— 与 `dsh-secure-audit` 的"本机暴露面审计"是不同维度 |

### 2.4 官方已内置（4 个）

`dsh-file-explorer`、`dsh-session-history`、`dsh-tool-renderers`、`dsh-force-reasoning-effort` —— 详见 `docs/FEATURES-OVERVIEW.md` §3。

### 2.5 建议直接弃用（2 个）

| 自研插件 | 理由 |
|---|---|
| `dsh-temp-tracker` | 市场**零候选**；运行时数据最后写入停在 9/27，只有 1 个 0.01 MB 文件；设计上**只记账不清理** —— 没有消费者 |
| `dsh-health-dashboard` | 市场有更好的（`dsh-env-inspector` ★13、`dsh-plugin-manager` 的"启动前自检"）；它自己只是聚合本地 JSONL，`/health/dashboard` 又需 token 才能访问 |

---

## 3. 已装第三方插件 vs 市场

| 已装 | 现状 | 市场上有更强的？ |
|---|---|---|
| `dsh-better-sidebar` v0.22.1 | **peer 不兼容**（14 项 `^0.1.7-rc.1`），新内核跳过 | **`DSH-better-sidebar` ★3868**（下载量 245,487）⚠️ 大小写不同，**需确认是否同一个包** |
| `@liustack/modlens` 3.23.1 | 兼容 | `modlens` ★4063 —— **就是它自己**，可从市场更新 |
| `@liustack/modsearch` ^5.4.3 | 兼容 | `modsearch` ★568 —— 也是它自己 |
| `@liustack/pptwise` 0.35.0 | 兼容 | **`dsh-univer-office` ★429**（表格/文档/幻灯片/画布/多维表格一站式，下载量 60,189） |
| `dsh-office-tools` 1.0.3 | **peer 不兼容** | `dsh-office-tools` ★26 在市场里（可升级）；`dsh-univer-office` ★429 更强 |
| `dsh-bash-terminal` 0.3.15 | **peer 不兼容**（11 项） | **`dsh-plugin-kit#tty` ★40**（xterm.js 多标签 + ssh2 原生 SSH）；或直接用已装的 `DSH-better-sidebar` 内置终端 |
| `dsh-tool-search` 0.1.5 | **peer 不兼容** | `dsh-progressive-tools` ★7（缓存稳定的渐进式工具发现，原生工具列表字节稳定） |
| `dsh-mcp-lens` 0.1.0-rc.9 | **peer 不兼容** | `dsh-plugin-kit#mcp` ★40（MCP 配置卡片，stdio/streamable-http 双传输） |
| `dsh-find-plugin` 0.3.7 | **peer 不兼容** | `dsh-plugin-manager` ★8（多源搜索 + 按 profile 安装/移除/更新） |
| `@openviking/dsh-memory-plugin` 0.3.0 | 兼容 | `dsh-mnemon` ★420、`engramory` ★191；OpenViking 自己 ★38914 |
| `@vectorize-io/hindsight-coding-agents` | 兼容 | `hindsight#coding-agents` ★41184 —— 它自己 |
| `@huanlin/...office` 0.1.2 | **peer 不兼容** | 已被 `DSH-better-sidebar` ★3868 覆盖 |
| `dshmarket` 1.40.0 | **peer 不兼容** | **`dsh-market` ★4818**（下载量 **425,158**） |
| `dsh-safe-delete` 0.2.1 | 兼容 | 市场无直接同类（多数是会话回收站） |
| `dsh-context` 0.59.2 | 兼容 | `dsh-context` ★1556 —— 它自己，可更新 |

**注意**：标"peer 不兼容"的 8 个包，新内核的处置是**跳过而非阻断** `[实测：plugin-compat.json]`。它们现在装在 profile 里但**没有被登记加载**，属于"占位不工作"。

---

## 4. 顺带解决了我们踩到的两个问题

| 我们遇到的问题 | 市场里的对应方案 |
|---|---|
| **外部 HTTP 全部 403**（`/health`、`/api`、`/` 都要浏览器会话 token） | **`dsh-full-remote` ★45** —— "转发时改写 Host/Origin，**恢复其他方案必定 403 的 `settings.*` / `credentials.*` / `host.*`**" |
| **`http.proxy = 127.0.0.1:7897` 端口没在监听**，导致 vendor 推送失败 | **`dsh-network-settings` ★107** —— 可视化网络链路（**DNS/TCP/TLS/HTTP 分层探测**），**检测失效的代理配置**，带快照回滚的安全修复 |
| 想知道哪些模型能用、延迟多少 | **`dsh-model-health`** —— 设置页「模型健康」面板，批量测试可用性与延迟 |

---

## 5. 建议的最终形态

**保留自研（4 个）**
```
dsh-task-scheduler          ← 市场无等价，你的铁律依赖它
dsh-project-brief           ← 市场无「生成 AGENTS.md」的
dsh-host-services           ← 市场无同类基础设施（要 /health 就留）
dsh-model-inspection-guard  ← 市场无直接等价
```

**从市场装（各挑一个补齐）**
```
dsh-prompt-enhancer     替代 prompt-enhance（★77）
dsh-secure-audit        替代 code-security-guard（★85）
dsh-env-inspector       替代 self-maintenance + health-dashboard（★13）
dsh-session-manager     替代 session-hygiene（★69）
dsh-auto-continue       替代 session-watchdog（★120）
dsh-mnemon              替代 memory-files（★420）
dsh-permission-rules    替代 command-guard + diff-guard（★115）
```

**直接弃用**
```
dsh-temp-tracker        无消费者、市场零候选
dsh-health-dashboard    已被 dsh-env-inspector 覆盖
```

---

## 6. 风险与未验证（必读）

| # | 风险 | 说明 |
|---|---|---|
| 1 | **兼容性全部未验证** | 注册表不提供 peer 兼容信息。这 4392 个里绝大多数是 0.1.x 时代的，你的内核是 `0.2.0-rc.2`。**装之前必须单个实测** |
| 2 | **安装会触发 pnpm，可能清掉现有插件** | 官方插件管理器装插件时会跑 pnpm，而当前 profile 的 `dependencies` 是空的 `{}` → 未声明的包会被当 extraneous 清掉。**这与阶段 2 要修的隐患是同一个** |
| 3 | **红线告警要逐条看** | 466 个插件带 `capabilityRedLines`。例：`deepseek-harness-zh_pro` ★28 标了"读凭据 + 能联网"；`DSH-Plugins-Marketplace` ★169 标了"明文 http 到 evil.com:3080 / 用字面 IP 1.2.3.4"（很可能是**故意注入的测试样例**，但该字段值得读） |
| 4 | **星数≠质量** | star 是 GitHub 仓库的；`downloads` 是 30 天 npm 下载量，更能反映实际使用 |
| 5 | **本地快照严重过期** | 本机 `registry-snapshot.json` 是 8/22 的（176 条）；实时源 4392 条。**应用内市场面板用哪个源我没验证** |
| 6 | **同名不同包** | `DSH-better-sidebar` ★3868 与你已装的 `dsh-better-sidebar` v0.22.1 **可能是两个不同的包**（大小写/作者不同），换之前必须确认 |

---

## 7. 数据来源与复现

| 项 | 值 |
|---|---|
| 注册表 URL | `https://awesome-dsh-plugin.com/plugins.json` |
| 本地副本 | `_tmp/plugins-live.json`（5,158 KB / 4392 条） |
| 匹配结果 | `_tmp/market-match.txt`（341 行） |
| 匹配脚本 | `_tmp/mm.mjs` |
| 候选排序 | `star×3 + log10(downloads+1)×10` |
| 本地过期快照 | `~/.dsh/profiles/desktop/node_modules/dsh-find-plugin/data/registry-snapshot.json`（176 条 / 2026-08-22） |
| 应用内市场实时源 | `dshmarket/README.zh.md:87` —— 每次打开实时请求 `awesome-dsh-plugin.com/plugins.json` |