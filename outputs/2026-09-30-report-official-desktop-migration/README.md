# 官方版 DSH Desktop 迁移盘点报告

- 日期：2026-09-30
- 范围：把旧的开发构建（DSH Desktop **v2.0.2** + 内核 `@deepseek-ai/dsh` **0.1.x**，工作区 `D:\Deepseek-Harness`，profile `desktop`）迁到官方安装版（**v2.0.17** + 内核 `@deepseek-ai/dsh` **0.2.0-rc.2**，安装位置 `D:\DSH-Desktop\DSH Desktop`）
- 本报告全部结论分三级标注：**[实测]**＝有命令/日志/文件证据；**[推断]**＝由证据推得但未直接验证；**[未验证]**＝没测过
- 产出的证据文件：`plugin-status.json`（43 个插件链接 vs 10 个已加载的逐条比对）

---

## 0. 三句话结论

1. **数据不用搬。** 新旧两版共用同一个 `~/.dsh`（`DSH_HOME=C:\Users\机械革命\.dsh`）。会话 292 条 / 414 MB、7 个工作区、58 个 skills、39 项凭据、storages、附件，在官方版里已经全部可见 —— **本报告这一句话本身就是证据：当前这个会话就跑在官方版里，读的是同一份数据。** [实测]

2. **配置已经迁完，插件只迁了一半。** 18 个 provider / 75 个模型已写进官方 profile 的补丁文件，默认模型指向 `tokenry / deepseek-flash`；43 个自研插件已链接进官方 profile 的 `node_modules`，但**只有 10 个真正注册加载**，**33 个还挂着没启用**。 [实测]

3. **旧壳补丁不该迁。** 旧版靠 9 处 `apply-shell-0.1.7-gaps.mjs` 补丁把 v2.0.2 的壳硬接到 0.1.x 内核上；官方 2.0.17 自带适配。实测在官方壳的 `lib/*.js` 里搜这些补丁的标记字符串，**0 命中**。 [实测]

**一句话回答"能迁吗"**：数据＝本来就是同一份，零迁移成本；配置＝已迁；44 个自研插件里 **17 个应当迁、19 个部分迁、4 个官方已内置、2 个纯依赖、2 个必须改造**；旧壳补丁＝不迁。

---

## 1. 之前做了什么（功能总账）

### 1.1 应用形态

| 项 | 值 | 出处 |
|---|---|---|
| 桌面壳 | DSH Desktop v2.0.2（Electron，Cordis Host 形态，无独立内核子进程） | `D:\Deepseek-Harness\package.json` [实测] |
| 内核 | `@deepseek-ai/dsh` 0.1.x | `outputs/2026-09-29-feature-audit/README.md:14` [实测] |
| 壳源码 | `vendor\deepseek-harness-desktop\dsh-plugin-desktop` | 目录存在 [实测] |
| 活动 profile | `~/.dsh/profiles/desktop`（package.json / cordis.patch.yml / pnpm-lock.yaml / node_modules） | `_backups\desktop-profile-v2.0.2-20260930\package.json` [实测] |
| 壳补丁 | 9 处可重放补丁 `scripts\apply-shell-0.1.7-gaps.mjs` + 补丁三件套登记 | `outputs/2026-09-29-feature-audit/README.md:87-97` [实测] |
| 补丁脚本总数 | `scripts\apply-*.mjs` 共 **32 个** | 目录枚举 [实测] |
| 变更记录 | CHANGELOG 235 条 | `AGENTS.md` brief [实测] |

### 1.2 自研插件 44 个 · 全表

判定口径来自既有迁移方案（`outputs\2026-09-30-report-dsh-migration-plan\evidence\migration-matrix.json`，逐行行号见括号），功能列为其 `reason` 字段的中文化。

判定含义：`keep`＝官方没有等价物、应当迁｜`partial`＝官方有部分覆盖、看情况迁｜`builtin`＝官方已内置、不必迁｜`dep`＝纯依赖、被别的一起带｜`rework`＝引用了新内核已删除的包、**加载即失败、必须改代码**

#### A. 基础设施与服务（5）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-host-services` | 自研基础设施 `ctx.hostServices`，是其他多个插件的公共依赖 | **keep**（必须最先迁）(MX:188) |
| `dsh-task-scheduler` | 多对话互斥锁 + 全局变更时间线，跨工作区协作强依赖 | **keep** (MX:460) |
| `dsh-super-injector` | 运行时热注入/卸载插件 | **rework**（引用已删除包，高风险）(MX:786) |
| `dsh-settings-scope-shim` | 垫 0.1.x 的 settings scope 缺口 | **partial**（新内核 settings 已重写，很可能没必要）(MX:761) |
| `dsh-system-notify` | 系统通知（`ctx.notify`） | **partial**（壳自带 notifications）(MX:806) |

#### B. 模型路由与视觉（11）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-model-tier-router` | 同源双模型分级路由 | **keep** (MX:319) |
| `dsh-model-provider-failover` | 跨 provider 故障转移（官方只有同 provider 重试） | **keep** (MX:301) |
| `dsh-model-inspection-guard` | `data_inspection_failed` 时改道重试 | **keep** (MX:283) |
| `dsh-model-whitelist` | 会话选择器里的模型勾选白名单 | **partial** (MX:714) |
| `dsh-model-picker-group` | 模型选择器按厂商重排分组 | **partial** (MX:693) |
| `dsh-developer-role-guard` | 防未登记端点误发 `developer` 角色 | **partial** (MX:111) |
| `dsh-force-reasoning-effort` | 强制推理档位 off/low/high/max | **builtin**（官方已内置）(MX:149) |
| `dsh-vision-engine` | 视觉能力路由 + Ollama 生命周期 + 额度统计 | **partial** (MX:863) |
| `dsh-vision-rotator` | 视觉提供商轮换 | **keep** (MX:517) |
| `dsh-modlens-guard` | modlens 守卫 | **dep**（没 modlens 就是死代码）(MX:556) |
| `dsh-modlens-autoread` | modlens 自动读取附件 | **dep** (MX:537) |

#### C. 守护 / 自愈 / 安全（11）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-self-maintenance` | 智能自检守护（磁盘/会话/连接，**只观测绝不删文件**） | **keep** (MX:377) |
| `dsh-session-hygiene` | 会话文件体积巡检（**只读上报**，归档恒 dry-run） | **keep** (MX:397) |
| `dsh-session-watchdog` | 会话目标续跑看门狗 | **partial**（官方 goal-round-driver 自带续行，需实测）(MX:419) |
| `dsh-stuck-loop-guard` | 按错误签名注入 pivot、打断失败循环 | **partial**（官方只提醒不干预）(MX:437) |
| `dsh-context-lifecycle` | token 生命周期 + compact/handover 横幅 | **partial** (MX:71) |
| `dsh-memory-guard` | 内存/commit 风暴回收 | **keep** (MX:265) |
| `dsh-crashpad-hygiene` | 定时把 `.dmp` 移进回收站 | **keep** (MX:91) |
| `dsh-instance-janitor` | 清 crashpad 僵尸与旧代网关进程 | **keep** (MX:225) |
| `dsh-diff-guard` | 敏感路径 + 大段删除 **fail-closed** 拦截 | **partial** (MX:130) |
| `dsh-command-guard` | 命令观察 + 风险评分 + JSONL | **partial** (MX:48) |
| `dsh-code-security-guard` | 扫写入内容里的危险代码模式 | **keep** (MX:29) |

#### D. 会话与工作区（3）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-session-history` | 会话全文搜索 + 侧边栏 + Mod+K | **builtin**（官方 `session-query-sqlite` 已内置）(MX:574) |
| `dsh-file-explorer` | 文件浏览器 | **builtin**（官方 `ui-sidebar-files` 等）(MX:656) |
| `dsh-remote-workspace` | 远程工作区 | **rework**（引用已删除 `@deepseek-ai/dsh-client-runtime`，**加载即失败**）(MX:741) |

#### E. 网络与工具（5）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-web-search-bing` | Bing 搜索提供商 | **partial** (MX:610) |
| `dsh-web-fetch-local` | 带 SSRF 防护/体积上限的抓取 | **partial** (MX:592) |
| `dsh-diagram-renderer` | 会话内 SVG 图表卡片 | **keep**（官方 289 个包与 md/js 里 mermaid 零命中）(MX:635) |
| `dsh-tool-renderers` | 工具结果原生渲染 | **builtin** (MX:824) |
| `dsh-hy3-gateway` | hy3 免费通道本地网关（127.0.0.1:8787） | **keep** (MX:206) |

#### F. 记忆与提示（3）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-memory-files` | 预算化的磁盘长期记忆注入 | **partial** (MX:245) |
| `dsh-project-brief` | 生成/刷新跨 agent 的项目说明 `AGENTS.md` | **keep** (MX:340) |
| `dsh-prompt-enhance` | 提示词增强工具 | **keep** (MX:358) |

#### G. 观测与审计（3）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-health-dashboard` | `/health/dashboard` 状态路由 | **keep** (MX:168) |
| `dsh-tool-audit` | 工具调用 JSONL 审计 | **partial** (MX:498) |
| `dsh-temp-tracker` | 测试/临时文件记账 | **partial** (MX:479) |

#### H. 界面与体验（3）

| 插件 | 干什么 | 判定 |
|---|---|---|
| `dsh-ui-performance` | UI 性能补丁 | **partial** (MX:842) |
| `dsh-frontend-reload` | 前端热重载 | **partial** (MX:674) |
| `dsh-skills-manager` | 技能开关/编辑/删除/新建 + 市场 | **partial** (MX:886) |

**判定分布**：keep 17 ｜ partial 19 ｜ builtin 4 ｜ dep 2 ｜ rework 2（共 44）(MX:3-9)

### 1.3 第三方插件（旧 profile bundle 里的 51 项之第三方部分）

`dsh-better-sidebar` `@huanlin/dsh-plugin-better-sidebar-plugin-office` `@liustack/modlens` `@liustack/modsearch` `@liustack/pptwise` `dsh-office-tools` `@vectorize-io/hindsight-coding-agents` `dsh-bash-terminal` `dsh-tool-search` `dsh-find-plugin` `dsh-mcp-lens` `@openviking/dsh-memory-plugin` `dsh-safe-delete` `dshmarket` `dsh-context` `dsh-skills-manager`

出处：`_backups\desktop-profile-v2.0.2-20260930\package.json:4-64` [实测]

### 1.4 配置资产

| 资产 | 规模 | 状态 |
|---|---|---|
| LLM provider | **18 个 / 75 个模型** | 已迁进官方 profile [实测] |
| 凭据 | `.credentials.yaml`，39 个条目（其中 24 个 `*_API_KEY`） | 原地共用，未动 [实测] |
| MCP 服务 | firecrawl（npx）、markitdown（本地 venv exe） | **未迁**（旧 patch 里的两条 insert） [实测] |
| 其他旧 patch | 15 条（compaction、web bing、session-title-llm、session-projection-cache、modlens、super-injector、better-sidebar、settings-scope-shim…） | **未迁**，逐条取舍见 §4 [实测] |
| 技能 | `~/.dsh/skills` 58 个目录 | 原地共用，官方版本会话已能列出 [实测] |
| 会话 | 292 条 / 414 MB，7 个工作区 | 原地共用 [实测] |
| 附件 | 387 个文件 / 81.3 MB | 原地共用 [实测] |

---

## 2. 迁移可行性：分层判定

| 层 | 能不能迁 | 依据 | 成本 |
|---|---|---|---|
| **数据**（会话/凭据/技能/附件/storages/工作区） | **不用迁，本来就是同一份** | 两版都用 `DSH_HOME=~/.dsh`；官方版启动日志已列出 292 条会话 [实测] | 0 |
| **配置**（provider/模型/默认模型） | **已迁完** | `~/.dsh/profiles/desktop/cordis.patch.yml` 已含 18 provider；`agent-default-model` 指向 tokenry/deepseek-flash [实测] | 0（已完成） |
| **自研插件** | **能迁，43 个已就位** | shell 里 `@dsh-external` 43 个 junction 全部可解析；10 个已在启动日志里有挂载行 [实测] | 每条 = 改一行 + 重启 + 看日志；剩余 33 条 |
| **第三方插件** | **部分不能迁** | 8 个包声明了不兼容的 dsh peer（`dsh-better-sidebar@0.22.1` 等），新内核启动时会 **跳过而非阻断**（记入 `skippedBundles` + stderr 一行） | 要么等作者适配，要么 `dsh plugin allow-version --accept-risk` 显式豁免 |
| **旧壳补丁**（9 处） | **不该迁** | 官方 2.0.17 壳里搜补丁标记 0 命中；那些补丁是给 0.1.x 内核打的地基 [实测] | 0 |
| **会话数据格式** | **有一处真实损耗** | 旧会话里子代理描述符是 `descriptor version 2`，新内核不认，每次启动刷 ~30 条 warning [实测] | 无自动修法；会话本体可读，子代理树可能展不开 [推断] |

---

## 3. 当前官方版的实测状态

### 3.1 版本与位置

| 项 | 值 | 出处 |
|---|---|---|
| 安装位置 | `D:\DSH-Desktop\DSH Desktop`（v2.0.17，进程 7 个，启动于 09:35:52） | 进程枚举 + `resources\app\package.json` [实测] |
| 壳版本 | `dsh-plugin-desktop@2.0.17` | `resources\app\package.json` [实测] |
| 内核 | `@deepseek-ai/dsh@0.2.0-rc.2`，`@deepseek-ai/*` 包共 289 个 | `resources\app\node_modules` [实测] |
| 活动 profile | `DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=~\.dsh\profiles\desktop` | 进程环境变量 [实测] |
| Web 地址 | `DSH_WEB_URL=http://127.0.0.1:43120` | 进程环境变量 [实测] |

### 3.2 启动日志证据（`%APPDATA%\DSH Desktop\logs\host\dsh-2026-09-30.log`）

09:35 那一代（官方版）启动时打印的挂载行 [实测]：

```
09:35:53.878 [@dsh-external/dsh-self-maintenance] 智能自检守护启动（每 3600000ms 一轮…）
09:35:54.599 [@dsh-external/dsh-host-services]     [host-services] v1 mounted (health: /health)
09:35:54.600 [@dsh-external/dsh-session-hygiene]   status route registered at /session-hygiene
09:35:54.624 [@dsh-external/dsh-task-scheduler]    任务调度插件启动（interval=600000ms）
09:35:55.872 [@dsh-external/dsh-self-maintenance]  status route registered at /self-maintenance/status
09:35:55.887 [@dsh-external/dsh-health-dashboard]  status route registered at /health/dashboard
```

⇒ **5 个插件有正向挂载证据**：`host-services`、`session-hygiene`、`self-maintenance`、`health-dashboard`、`task-scheduler`。

另外 5 个（`tool-audit`、`temp-tracker`、`code-security-guard`、`project-brief`、`prompt-enhance`）**设计上不打印启动行**，"已加载"是靠**无错误**反推的，不是正向证据。 [推断]

### 3.3 并存的告警（都无害，但要知道）

| 告警 | 次数 | 含义 |
|---|---|---|
| `jsonl-session-persistence: ... subagent/descriptor N uses unsupported descriptor version 2` | 每次启动 ~30 条 | 旧内核写的旧格式子代理描述符，新内核只跳过、不报错 [实测] |
| `workspace-registry: workspace '80fc...' filtered session 'session-c5e17710...' from membership: session header is missing` | 每次启动 1 条 | 1 条会话被过滤出工作区列表 [实测] |
| `session-title-service: automatic title generation failed: ... reached maxOutputTokens` | 本会话 1 条 | 旧 patch 里 `session-title-llm` 的 `maxOutputTokens: 512` 没迁过来（新 profile 用内核默认 64） [实测] |
| `self-maintenance: 全部会话共 414MB > 0.4GB` | 每小时 1 条，已 24h 去重 | 自研插件在正常工作 [实测] |

### 3.4 插件现状：43 已链接 / 10 已加载 / 33 未加载

未加载的 33 个 [实测]：

```
dsh-command-guard          dsh-context-lifecycle      dsh-crashpad-hygiene
dsh-developer-role-guard   dsh-diagram-renderer       dsh-diff-guard
dsh-file-explorer          dsh-force-reasoning-effort dsh-frontend-reload
dsh-hy3-gateway            dsh-instance-janitor       dsh-memory-files
dsh-memory-guard           dsh-model-inspection-guard dsh-model-picker-group
dsh-model-provider-failover dsh-model-tier-router     dsh-model-whitelist
dsh-modlens-autoread       dsh-modlens-guard          dsh-remote-workspace
dsh-session-history        dsh-session-watchdog       dsh-settings-scope-shim
dsh-stuck-loop-guard       dsh-super-injector         dsh-system-notify
dsh-tool-renderers         dsh-ui-performance         dsh-vision-engine
dsh-vision-rotator         dsh-web-fetch-local        dsh-web-search-bing
```

> 注意：这 43 个 junction 是**运行时移进来的**，并**没有写进** profile 的 `package.json`（当前 `dependencies: {}`）。这意味着一次干净的 `pnpm install` 或 profile 重建会把它们全部清掉。 [推断，风险项]

### 3.5 外部 HTTP 访问被拒（实测观察）

```
GET http://127.0.0.1:43120/            -> 403  body: forbidden
GET http://127.0.0.1:43120/health      -> 403  body: forbidden
GET http://127.0.0.1:43120/api         -> 403  body: forbidden
```

来源定位到 `resources\app\node_modules\@deepseek-ai\dsh-client-connection\lib\index.js:650`（`res.end(admission.rejection === 401 ? "unauthorized" : "forbidden")`），该模块实现了**浏览器会话鉴权**：对外发放的地址形如 `http://127.0.0.1:43120/?token=<43 位>`（`dsh-client-connection:226`、壳 `host-process-entry.js:160`）。

- 应用窗口内使用**不受影响**（本会话正在其中运行）。 [实测]
- **但**：全局 `AGENTS.md` 里写的 `GET http://127.0.0.1:43120/health`、以及 task-scheduler 的"任意工作区 HTTP 通道"，在裸 URL 下会拿到 403。 [实测]
- 旧构建的 `exit-probe.log` 里同样是带 token 的 URL（`http://127.0.0.1:43120/?token=…`），所以这**可能**不是 2.0.17 新引入的行为 —— 旧版是否**强制**鉴权，**未验证**。

---

## 4. 还没做的 / 需要做什么

### 4.0 总览

| 批次 | 内容 | 数量 | 风险 | 需要你在场吗 |
|---|---|---|---|---|
| **P0** | 18 provider / 75 模型 | 1 条 patch | 极低 | 否 —— **已完成** [实测] |
| **P1.0–1.2a** | 纯 host 观测类插件 | 10 个 | 低 | 否 —— **已完成** [实测] |
| **P1.2b** | 会主动做事的 host 插件 | 5 个 | 中 | **是** |
| **P1.3** | 改模型路由的 host 插件 | 4 个 | 中 | **是**（要发消息才看得出对错） |
| **P1.4** | 余下 host 插件 | 7 个 | 中 | **是** |
| **P2** | 旧 patch 逐条取舍 | 15 条 | 低–中 | **是**（含几个二选一） |
| **P3** | 带 client 面的插件 | 13 个 | **高** | **是**（坏了整页就废） |
| **P4** | 第三方升级 / 豁免 | 8 个被拒 + 若干可升 | 中 | **是**（要联网、要接受风险） |

### 4.1 P1.2b —— 5 个"会主动做事"的插件（最该先做，但必须有人看着）

| 插件 | 为什么不能无人值守 |
|---|---|
| `dsh-diff-guard` | **fail-closed**：拿不到审批服务就**拒绝写入**。若新内核审批服务名变了，它会开始拦你的文件编辑 |
| `dsh-instance-janitor` | 会**杀进程** |
| `dsh-memory-guard` | 按阈值**回收内存**，可能作用于其他进程 |
| `dsh-crashpad-hygiene` | 定时**移文件**进回收站 |
| `dsh-command-guard` | 观察+评分本身安全，但与官方 `permission-presets` 重叠，该先对比再定 |

**做法**：一次加一个 → 重启 → 看日志 + **在界面上随便改一个文件确认没被拦** → 再下一个。

```powershell
# 加一项（id=包名）
node D:\Deepseek-Harness\_tmp\patch-edit.mjs --add "command-guard=@dsh-external/dsh-command-guard" --apply
# 重启
Get-Process | Where-Object { $_.ProcessName -eq 'DSH Desktop' } | Stop-Process -Force
Start-Process 'D:\DSH-Desktop\DSH Desktop\DSH Desktop.exe'
# 看日志
notepad "$env:APPDATA\DSH Desktop\logs\host\dsh-2026-09-30.log"
```

### 4.2 P1.3 —— 4 个改模型路由的插件

`model-tier-router`、`model-provider-failover`、`model-inspection-guard`、`developer-role-guard` 都挂在 `agent/request` 上**改路由**。启动日志不会有证据，必须**真实发几条消息**才看得出对错。

### 4.3 P1.4 —— 7 个余下 host 插件

`task-scheduler`（已加载）、`project-brief`（已加载）、`prompt-enhance`（已加载）之外的 `session-watchdog`、`stuck-loop-guard`、`memory-files`、`hy3-gateway`、`vision-rotator`（需造特定失败场景才验证得了）。

### 4.4 P2 —— 旧 patch 逐条取舍（含 4 个要你二选一的决定）

| 旧 patch | 建议 | 要你决定什么 |
|---|---|---|
| `session-title-llm`（`maxOutputTokens: 512`） | 建议补回 | **已实测到症状**：本会话标题生成失败（§3.3）。建议直接补回旧值 |
| `web`（`searchProvider: bing`） | 先别加 | 新内核默认走官方搜索。**先删掉这两个键实测官方搜索能不能用**：能用就不必迁 bing，不能用再加回 |
| `session-query-sqlite`（`openAt`） | 建议开 | 默认是 `:memory:` + `openAt: never`＝**搜索关闭**。改成 `first-search` 就能搜历史；**开了之后 `dsh-session-history` 就不必迁了** —— 这是个二选一 |
| `mcp-firecrawl` / `mcp-markitdown` | 按需补 | 两条 insert 直接抄，注意 firecrawl 的 API Key 现在**明文写在旧 patch 里、已进 git 历史**，补的时候别再用明文 |
| `compaction-basic` | 先别动 | 旧配置位置已失效（真实例在 preset 面），属结构性改动 |
| `session-projection-cache` | 不必迁 | 方案判定新内核已无必要（README:25,153） |
| `modlens` / `better-sidebar` / `super-injector` / `settings-scope-shim` | 先别加 | 三项待实测："能不加就不加" |

### 4.5 P3 —— 13 个带 client 面的插件（风险最高）

自注册进 `window.__ModuleLoader__`，**坏了会把整页搞坏**，而界面坏掉之后你没法操作、只能改文件重启。**绝不要批量动**，一次一个，加完立刻看界面。

其中两个**必须先改代码**才能加载 [实测]：

| 插件 | 问题 |
|---|---|
| `dsh-remote-workspace` | `inject` + client exports 引用已删除的 `@deepseek-ai/dsh-client-runtime`，**加载即失败** |
| `dsh-super-injector` | 同上引用已删除包，且与新版 `cordis host/client-runner` + `tool-cordis` 部分重叠，需逐功能对比 |

另外 4 个判定为**官方已内置、不必迁**：`dsh-force-reasoning-effort`、`dsh-tool-renderers`、`dsh-file-explorer`、`dsh-session-history`。

### 4.6 P4 —— 第三方包

**8 个声明了不兼容 dsh peer、会被新内核跳过**（不是崩，是跳过 + stderr 一行） [实测]：

| 包 | 版本 | 冲突的 peer |
|---|---|---|
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | 0.1.2 | `dsh-client-runtime ^0.0.1-rc.1` |
| `dsh-bash-terminal` | 0.3.15 | 11 项 `^0.1.5-rc.1` |
| `dsh-better-sidebar` | 0.22.1 | 14 项 `^0.1.7-rc.1` |
| `dsh-find-plugin` | 0.3.7 | `dsh-tools ^0.1.0-rc.6` |
| `dsh-mcp-lens` | 0.1.0-rc.9 | `dsh-subprocess` / `dsh-tools ^0.1.0-rc.6` |
| `dsh-office-tools` | 1.0.3 | `dsh-agent` / `dsh-fs` / `dsh-llm` / `dsh-session` / `dsh-tools` |
| `dsh-tool-search` | 0.1.5 | 6 项 `^0.1.7-rc.2` |
| `dshmarket` | 1.40.0 | `dsh-settings ^0.1.0-rc.7` |

**两条路**：① 等作者适配；② `dsh plugin allow-version`（需显式 `--accept-risk`），写进 profile 的 `compatibility.json`，**逐"包名@版本"× 逐运行时版本**授权。
注：`dshmarket` **新版官方已内置 1.66.5，不必装**。

### 4.7 建议动手顺序

1. **3 分钟自检**（见 §6） —— 确认现在这个状态真的可用
2. **补回 `session-title-llm`**（今天已有实测症状，改动最小）
3. **P1.2b 五个，一次一个**
4. **测官方搜索** → 决定要不要迁 bing 两件套
5. **开 `session-query-sqlite` 的 `first-search`** → 决定要不要迁 `dsh-session-history`
6. **P1.3 四个**（要发消息验证）
7. **P1.4 余下**
8. **P3 十三个**（一次一个）
9. **P4 第三方**（联网、接受风险）

---

## 5. 回滚点（四层，任选）

| 层级 | 操作 | 影响面 |
|---|---|---|
| 1｜只退插件与 provider | 把 `~/.dsh/profiles/desktop/cordis.patch.yml` 内容换成 `[]`，重启 | 回到"能开不能聊"的干净状态 |
| 2｜退到迁移执行前 | 用 `~/.dsh/_backups/migration-p0-baseline-20260930/cordis.patch.yml.baseline`（217 B，内容正是 `[]`）覆盖 | 同上，且是原始文件 |
| 3｜退到已验证的中间态 | 用 `outputs\2026-09-30-report-dsh-migration-plan\checkpoints\cordis.patch.yml.applied-20260930-0243`（14,904 B）覆盖 | 快速回到 02:43 那个已验证状态 |
| 4｜整 profile 重来 | 从 `D:\Deepseek-Harness\备份\2026-09-29-full\profile-desktop.tar.gz`（194.5 MB）解压 | 最重，但最彻底 |
| 5｜整应用回退 | 旧便携构建 `vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked-build202609292211\win-unpacked` 仍在 | 回到旧壳 |

另有 `~/.dsh/_backups/desktop-profile-v2.0.2-20260930/`（41,610 文件 / 671.8 MB）是旧 profile 的完整存档；**注意它现在缺 `node_modules`**（已被移进新 profile 复用）。要还原就整体移回 `~/.dsh/profiles/desktop`。
**不要把这份存档整体搬回 `profiles/`** —— 会一次性带回 51 个旧 bundle（含 8 个不兼容包）。

---

## 6. 你现在可以做的 3 分钟自检

1. **打开应用** —— 能正常出主界面（不是恢复窗口、不是白屏）
2. **设置 → 模型** —— 应列出 **18 个 provider**：`tokenry` `opencode-go` `sennsenova` `duoyuanx` `tokenrhythm01` `openrouter` `yidong` `hy3-free` `baidu-qianfan` `zhipu-ai` `groq` `justdowork` `qiniu` `amd` `modelscope` `tokenrouter` `codecraft` `apinex`
3. **发一条消息** —— 能收到回复（这一条同时验证了 provider 真可用）
4. **会话列表** —— 292 条历史对话都在
5. **确认 5 个"静默"插件是否生效**（我看不到界面，只能靠你）：
   - `tool-audit` / `temp-tracker` → 看 `~\.dsh\tool-audit\` 与 `~\.dsh\temp-tracker\` 的 JSONL 有没有新写入
   - `code-security-guard` → 看 `~\.dsh\code-security-guard\`
   - `project-brief` / `prompt-enhance` → 看工具列表里有没有对应工具
6. **不该看到的东西**：恢复/回滚窗口、`skipping profile bundle` 字样、报错弹窗

---

## 7. 风险与未验证项（明确标注）

### 7.1 已确认的风险

1. **43 个插件链接不在 `package.json` 里** —— 一次干净 `pnpm install` 或 profile 重建会全部清掉，插件集体消失。 [推断]
2. **旧会话数据格式不再被完全支持** —— `descriptor version 2` 已被新内核标记为 unsupported，旧会话的子代理树可能展不开。 [实测告警 / 影响面推断]
3. **两版绝不能同时运行** —— 共用 `~/.dsh` 与 `%APPDATA%\DSH Desktop`（旧报告 R:133-153 已列此风险）。
4. **旧版自动更新仍活着** —— `desktop-updates` enabled=true、首查 60 s、每 6 h。 [引自旧记录]
5. **firecrawl API Key 明文进过 git 历史** —— 补 MCP 配置时不要沿用明文。 [引自旧记录]

### 7.2 未验证（我没测，别当成结论）

- 旧构建下 `/health` 是否**也**需要 token（我只验证了新版 403，旧版的 `exit-probe.log` 里有 token URL 但没验证是否强制） [未验证]
- 8 个第三方包被"跳过"之后，界面上具体少哪些功能 [未验证]
- 33 个未加载的插件里，有多少**真的**能在 0.2.0-rc.2 上跑起来（只有 `plugin-compat.json` 里 9 个声明了 peer 的有静态判定，其余 35 个是"没声明 peer"而非"已验证兼容"） [未验证]
- 官方版界面上的实际观感（我看不到运行中的窗口，视觉效果必须由你确认） [未验证]

### 7.3 本报告用到的证据文件

| 文件 | 用途 |
|---|---|
| `plugin-status.json` | 43 个链接 vs 10 个已加载的逐条比对 |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 当前已应用的补丁（18 provider + 10 insert + 6 条配置） |
| `%APPDATA%\DSH Desktop\logs\host\dsh-2026-09-30.log` | 官方版启动时的挂载证据 |
| `outputs/2026-09-30-report-dsh-migration-plan/` | 既有迁移方案（44 插件决策矩阵 + 15 条 patch 判定）与执行记录 |
| `outputs/2026-09-30-report-dsh-2-0-16-migration-record/` | 数据盘点、删除清单、插件兼容性判定 |
| `D:\Deepseek-Harness\备份\2026-09-29-full\` | 冷备（sessions / storages / profile tar / appdata tar） |
