# DSH v2.0.16 迁移全面方案

> 日期：2026-09-30 ｜ 前置：`outputs/2026-09-30-report-dsh-2-0-16-migration-record/`（升级与隔离记录）
> 原则：**一项一项来，不一次性全迁**；每批都有独立验证与回滚；先证据后动手。
> 本方案取代迁移记录 §10.4 里"抄回 bundle 与调参"的笼统说法 —— 逐项复核后发现其中**至少两条已无必要、一条会直接报错**。

---

## 0. 结论摘要

**44 个插件的处置分布**（逐项判定，见 `migration-matrix.json`）：

| 判定 | 数量 | 含义 |
|---|---|---|
| `builtin` | 4 | 官方已内置等价能力 → **不迁**，改为打开官方能力 |
| `partial` | 19 | 与官方部分重叠 → **先实测对比**，能靠官方就不迁 |
| `keep` | 17 | 官方零命中 → **必须迁移** |
| `dep` | 2 | 依赖 modlens（外部插件）→ modlens 到位后才谈 |
| `rework` | 2 | 引用已删除的包 → **必须改造才能迁** |

**15 个配置调优条目的处置**（详见 §6）：**2 条已无必要**、**3 条需改造**、**6 条可直接沿用**、**2 条依赖实测验网**、**2 条需先开官方能力**。

### 最反直觉的四条（都有源码级证据，且推翻了我此前的判断）

1. **`session-projection-cache` 的调优已无必要。** 新版把它改成 `layout: per-record` —— 每会话一个文档（`session_projcache/sessions/<id>.json`），写路径从"整文件序列化重写"变成"替换该会话的记录"，且加了三个必写点。旧痛点（单一大文件每 ~8.5s 全文重写钉住单核）在结构上已消失。默认值也变成 `writeEveryEvents: 200 / writeIntervalMs: 5000`。→ **不迁**。
2. **`dsh-web` 若配 `bing` 会直接报错。** 本安装里 web 搜索/抓取各只有一个 provider（`deepseek-official` / `http`），配置未注册的 id 会抛 `WEB_PROVIDER_CONFIGURED_MISSING` —— **不是回退到默认，是直接失败**。想继续用 Bing，只能靠你自己的 `dsh-web-search-bing` / `dsh-web-fetch-local` 注册同名 provider。
3. **`session-title-llm` 的 64 token 问题只修了一半。** 新版对 DeepSeek 原生路由**已修**（`purpose === "session-title"` 时强制 `reasoning: "off"`，源码 `dsh-llm-deepseek/lib/index.js:1694`），但 **pi-ai 适配器里 `purpose` 零命中** —— 不做按用途关闭思考。而你的 18 个 provider **全部是 pi-ai**（`openai-completions`）→ **大 `maxOutputTokens` 仍需保留**。
4. **`compaction-basic` 的旧配置位置已失效。** 新版在 web-app 层把宿主面的 `compaction-basic` 置 `disabled: true`，真正的实例移到了 **preset 面**（`dsh-web-app/presets/cordis.patch.yml` 的 `compaction` group）。写回旧位置等于没写。

### 一条好消息

**18 个 provider / 75 个模型的 compat 键全部合法，可原样平移、零改动。** 实测：18 个 provider 只用 `supportsDeveloperRole` 一个 compat 键，而它在新内核 `COMPLETIONS_COMPAT_GATE` 里是 `offer`（合法）；没有任何 provider 用到被 `withhold` 的键。

---

## 1. 调查基础（可复核）

全部数据与脚本都在 `D:\Deepseek-Harness\_tmp\migration-inventory\`，可重放：

| 证据 | 来源 | 方法 |
|---|---|---|
| 旧 18 provider / 75 模型 | `old-config.json` | 用新版自带 `js-yaml` 解析 `~/.dsh/settings.yaml.imported` |
| 旧 15 条 patch 条目 | `old-config.json` | 解析归档 profile 的 `cordis.patch.yml`（注册 `!!js` 自定义标签） |
| 旧 profile 51 bundle / 59 依赖 | `old-config.json` | 解析归档 `package.json`（43 `link:` + 2 `file:` + 14 registry） |
| 44 个插件功能与依赖 | `old-plugins.json` | 逐插件读 `package.json` / README / 入口源码（子代理完成） |
| 新版 226 个可配置行 | `new-default-capabilities.json` | 解析 `dsh-base` / `dsh-web-app` 等 7 个 bundle 补丁层（183 默认开 / 32 默认关 / 11 条件式） |
| 官方是否已覆盖 | 本文件 §2 | 子代理逐包读 description + README.zh.md（289 个包） |
| 插件引用可用性 | 本文件 §3 | 扫插件源码里 `@deepseek-ai/dsh-*` 引用 vs 新内核 289 个包 |
| 第三方可否升级 | 本文件 §8 | 查 npm registry 最新版的 peer 范围，**用新版自带 semver + `includePrerelease`，并以两条已实测事实做自检** |
| 6 个官方包的 schema | 本文件 §6 | 子代理逐包读源码 Config + 装配补丁层（比包内 JSDoc 更权威） |

**一处方法学说明**：我第一版 registry 检查脚本因 ESM 里误用 `require` 导致 `semver` 为 `null`，于是**把每个包都判成"✅ 全部接受"** —— 这是个假阴性。改为双基线自检（`^0.1.7-rc.2` 必须判 false、`>=0.0.1-rc <2` 必须判 true）后重跑，并顺带发现 node-semver 对 `^0.1.7` 生成的上界是 `<0.2.0-0`，所以 `0.2.0-rc.1` **确实不满足** `^0.1.7-rc.2`。内核先前的判定是对的。

---

## 2. 三层对比结论

### 2.1 官方已覆盖（→ 不迁，改为打开官方能力）

| 你的插件 | 官方等价物 | 依据 |
|---|---|---|
| `dsh-force-reasoning-effort` | `dsh-llm-deepseek` 的 off/low/high/max + `dsh-agent-loop` 的 `agents[].reasoningEffort` + `dsh-agent-default-model` 存选择 | 官方 README |
| `dsh-tool-renderers` | `dsh-client-ui-goal` / `-jobs` / `-subagent` 原生渲染这三类工具 | 官方包清单 |
| `dsh-file-explorer` | `ui-sidebar-files`（懒加载文件树）+ `ui-sidebar-documentpreview`（Office/表格/MD/代码/图片/PDF）+ `ui-sidebar-browser` | 官方 README |
| `dsh-session-history` | `dsh-session-query-sqlite`（FTS5 跨会话+会话内搜索）+ sidebar 搜索 + workspace `Mod+K` | 官方 README；**但桌面默认 `openAt: never` = 搜索关闭**，见 §6.4 |

### 2.2 部分重叠（→ 先实测，能靠官方就不迁）

`dsh-vision-engine`（官方已内置视觉输入，但它的多配置管理/Ollama 生命周期/额度统计是独有）、`dsh-model-whitelist`（官方有子代理模型白名单，但"会话选择器里勾选哪些模型"是独有）、`dsh-model-picker-group`、`dsh-session-watchdog`（新版 `dsh-goal-round-driver` 自带竞态护栏续行）、`dsh-stuck-loop-guard`（官方 `dsh-repeat-tool-reminder` 只提醒，你的是注入 pivot 指令）、`dsh-command-guard` / `dsh-diff-guard`（官方 `permission-presets` + sandbox + auto-review 覆盖一部分审批）、`dsh-context-lifecycle`、`dsh-tool-audit`、`dsh-temp-tracker`、`dsh-memory-files`、`dsh-skills-manager`、`dsh-system-notify`、`dsh-frontend-reload`、`dsh-settings-scope-shim`、`dsh-ui-performance`、`dsh-developer-role-guard`、`dsh-super-injector`（官方新增 `dsh-cordis-host-runner` / `-client-runner` / `dsh-tool-cordis` = 模型自写动态插件）

### 2.3 官方零命中（→ 必须迁移）

`dsh-diagram-renderer`（**全 289 个包与所有 md/js 中 `mermaid` 零命中**）、`dsh-project-brief`、`dsh-session-hygiene`、`dsh-instance-janitor`、`dsh-health-dashboard`、`dsh-crashpad-hygiene`、`dsh-self-maintenance`、`dsh-code-security-guard`、`dsh-host-services`、`dsh-task-scheduler`、`dsh-hy3-gateway`、`dsh-memory-guard`、`dsh-prompt-enhance`、`dsh-model-tier-router`、`dsh-model-provider-failover`、`dsh-model-inspection-guard`、`dsh-vision-rotator`

### 2.4 须改造（→ 必须先改代码）

| 插件 | 阻断原因 |
|---|---|
| `dsh-remote-workspace` | `inject` 与 client `exports` 都引用**已删除**的 `@deepseek-ai/dsh-client-runtime` → 加载即失败 |
| `dsh-super-injector` | 同上（inject + client bundle 外部依赖） |

---

## 3. 独立兼容信号（比 peer 范围更能预测崩溃）

**引用可用性扫描**（44 个插件 × 源码里的 `@deepseek-ai/dsh-*` 引用 vs 新内核 289 个包）：**42 个插件引用的包全部存在**，只有上面 2 个引用了已删除的包。peer 范围通过 ≠ 能跑，这个检查是另一条独立证据。

**peer 门禁实测**（用内核自己的 `evaluatePluginCompatibility`）：51 个 bundle 中 8 个第三方包被拒 —— 但**你自己的 41 个 `@dsh-external/*` 全部通过**（因为写的是宽松范围 `>=0.0.1-rc <2`）。

**关键认知**：内核跳不跳插件，跟 npm semver 无关 —— 你的插件范围本就是开放的，npm 从没拦过。**"新内核不加载旧插件"纯粹是 profile 挂载行为**（旧 profile 被移走 → 新 profile 只挂 base+web-app）。所以迁移风险要按**用到的 API 面**排序（client bundle 格式 / toolview / inject 服务名），不是按 peer 范围。

---

## 4. 分批总览

| 批次 | 内容 | 项数 | 风险 | 前置 | 回滚 |
|---|---|---|---|---|---|
| **P0** | 模型基座（18 provider / 75 模型） | 1 条 patch | **极低**（纯数据、已核 compat 合法） | 无 | 恢复 `cordis.patch.yml` 为 `[]` |
| **P1** | 纯 host 零耦合插件 | 26 | 低-中 | P0（部分插件依赖 provider） | 逐个注释掉该行 |
| **P2** | 配置层调优 + 依赖项 | 5 | 中（3 条要改造） | P0 | 同上 |
| **P3** | 带 client 半的插件 | 13 | **高**（`__ModuleLoader__` 与 slot API 可能已变） | P1 稳定后 | 同上 |
| **P4** | 第三方升级后再迁 | 5 | 中 | P3 完成 | 卸回旧版 |

**纪律**：一批做完、验证通过、记好，再开下一批。**任何一批出问题就停，不要继续往下加**。

---

## 5. P0｜模型基座（最先做，独立无依赖）

**目标**：把应用从"能开不能聊"变成"能聊"，且不改动任何插件。

### 5.1 已生成的产物

`patches/P0-llm-providers.patch.yml` —— 从 `~/.dsh/settings.yaml.imported` **程序化导出**（逐字保留 75 个模型，零手抄风险）。
`patches/P0-llm-providers.manifest.json` —— provider 清单 + 源文件 SHA256。

**不含任何 API Key 值** —— 每个 provider 通过 `apiKeyEnv` 指向 `~/.dsh/.credentials.yaml` 里的键名。

### 5.2 已完成的核验

| 核验项 | 结果 |
|---|---|
| compat 键合法性 | 18 个 provider 只用 `supportsDeveloperRole` → 在新内核 `COMPLETIONS_COMPAT_GATE` 里是 `offer` ✅ |
| 密钥齐备性 | 18 个 provider 引用的 18 个 `*_API_KEY` 键，在 `.credentials.yaml` 里**全部存在** ✅ |
| 结构合法性 | 新内核要求 `providers` 是**字典**（按路由名索引）—— 原文件正是此结构 ✅ |
| 未被引用的多余键 | 6 个（`DEEPSEEK` / `GOOGLE_AI_STUDIO` / `SILICONFLOW` / `VOLCENGINE_ARK` / `BAI` / `SAMBANOVA`）—— 留给视觉类插件用，不影响 |

### 5.3 应用步骤

1. 备份当前 profile：复制 `~/.dsh/profiles/desktop/cordis.patch.yml`（现为 `[]`）到 `_backups/`
2. 把 `P0-llm-providers.patch.yml` 的**数组内容**合并进该文件（它本身就是一个顶层数组，直接作为内容即可）
3. 重启应用（不是热重载 —— 首轮用重启排除 reload 变量）

### 5.4 验证

- 设置 → 模型：应看到 **18 个 provider / 75 个模型**
- 逐个 provider 用它的模型发一条最小请求（至少测 `tokenrhythm01`，因为压缩摘要绑在它上面）
- 若无 key 报错，回查 `.credentials.yaml` 对应键

### 5.5 回滚

把 `~/.dsh/profiles/desktop/cordis.patch.yml` 恢复为 `[]`，重启。**此批不碰任何插件，回滚无残留。**

---

## 6. P2｜配置层（15 条旧 patch 条目逐条判定）

> 先看这张表，再决定动手顺序。**有 2 条明确不用迁、1 条会报错、2 条必须改造。**

| # | 旧条目 | 判定 | 说明 |
|---|---|---|---|
| 13 | `llm-pi-ai` providers | **P0 已含** | 见 §5 |
| 12 | `session-projection-cache` | **❌ 不迁** | 新版改 per-record 布局，旧痛点结构性消失；默认 200/5000 |
| 8 | `web` searchProvider/fetchProvider | **⚠️ 必须改** | 本安装只有 `deepseek-official` / `http`；配 `bing` 会抛 `WEB_PROVIDER_CONFIGURED_MISSING`（直接失败，非回退） |
| 9 | `session-title-llm` | **✅ 仍需（有条件）** | 默认 `maxOutputTokens` 仍是 64；官方 DeepSeek 路由已按 purpose 关思考，但 **pi-ai 路由未修** → 你的 provider 全是 pi-ai，故保留 512。行 id 仍是 `session-title-llm` |
| 5 | `compaction-basic` 固定摘要模型 | **⚠️ 必须改位置** | 宿主面那行已 `disabled: true`，真实例在 **preset 面**（`dsh-web-app/presets/cordis.patch.yml` 的 `compaction` group） |
| 6 | `command-compact` `disabled:false` | **✅ 仍需** | 新版默认 **关**，必须显式打开 |
| 7 | `dsh-context-lifecycle` `disabled:false` | 跟随 P1/P3 | 该插件本体迁移后才有意义 |
| 10 | insert `mcp-firecrawl` | **✅ 可沿用** | 字段未变；`serverName: firecrawl` 符合新约束 `[A-Za-z0-9_-]{1,32}`。**API key 用占位符，不要写进仓库** |
| 11 | insert `mcp-markitdown` | **✅ 可沿用** | 同上；但 `command` 指向的 `D:\Deepseek-Harness\tools\markitdown\.venv\Scripts\markitdown-mcp.exe` **必须存在** |
| 1 | `dsh-super-injector` `profileNodeModules` | **❓ 待实测** | 旧版默认指向 `profiles/web/node_modules`，所以要覆盖成 `desktop`；新版是否仍如此未知 |
| 2 | `modlens` `families` | **⏸ 等 modlens** | modlens 迁移后再照搬 |
| 3 | `better-sidebar` `disabled:false` | **❓ 待实测** | 旧注释说是绕 0.1.1-rc.2 的 loader bug；内核已换，可能不再需要 |
| 0 | insert 7 个插件 | 拆分 | file-explorer ❌不迁 / force-reasoning-effort ❌不迁 / **project-brief → P1** / **session-watchdog → P1** / **task-scheduler → P1** / system-notify → P3 / remote-workspace → P3 且须改造 |
| 4 | insert `frontend-reload` | → P3 | 带 client |
| 14 | insert `settings-scope-shim` | **❓ 很可能不必要** | 它是垫 0.1.x settings 作用域缺口的；新内核 settings 已重写（profile patch 层 + `STATE_VERSION 2`），大概率无事可做 —— 必须实测 |

### 6.1 P2 的推荐顺序

1. **只迁移确定项**：`command-compact`（打开）+ `session-title-llm`（保留 512）+ 两个 MCP 条目
2. 单独验证：重启后 `/compact` 可用、会话标题能生成、两个 MCP server 能连
3. **再单独试 `web`**：先删掉 `searchProvider`/`fetchProvider` 两个键（让内核用默认 `deepseek-official`/`http`），实测官方搜索在你网络上是否可用 —— 若可用，`dsh-web-search-bing`/`dsh-web-fetch-local` 就不必迁；若不可用，再迁这两个插件并配回 `bing`/`bing-fetch`
4. `session-query-sqlite` 单独一轮：把 `openAt` 从 `never` 改成 `first-search`，实测会话全文搜索；**若可用，`dsh-session-history` 就不用迁了**
5. 待实测项（super-injector 覆盖、better-sidebar、settings-scope-shim）放到最后逐个试，能不加就不加

### 6.2 `session-query-sqlite` 的开启方式（原生会话搜索）

桌面默认是 `path: ':memory:'` + `openAt: never`（搜索调用直接以 `SESSION_QUERY_SEARCH_DISABLED` 失败；精确读取仍可用）。
打开全文搜索需要一个 patch 条目把 `openAt` 改为 `first-search`（延迟到首次搜索才 import node:sqlite，保持启动安静）。是否是 `:memory:` 还是落盘索引由你定 —— 落盘才跨重启保留。

---

## 7. P1｜纯 host 插件（26 项，分子批推进）

> 26 项中 **25 项是纯 host**；`dsh-context-lifecycle` 带 client 半，**建议挪到 P3** 一起处理。

### 7.1 子批顺序（按依赖与风险，从小到大）

| 子批 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P1.0** | `dsh-host-services` | 它是自研基础设施（`ctx.hostServices`），**其他插件依赖它**，必须最先 |
| **P1.1** | `dsh-tool-audit`、`dsh-temp-tracker`、`dsh-session-hygiene`、`dsh-self-maintenance`、`dsh-health-dashboard` | 纯只读观测、零副作用 —— 用它们验证"旧 host 插件能否在新内核加载"这条链路 |
| **P1.2** | `dsh-code-security-guard`、`dsh-command-guard`、`dsh-diff-guard`、`dsh-memory-guard`、`dsh-crashpad-hygiene`、`dsh-instance-janitor` | 守护类；`dsh-diff-guard` 是 fail-closed（拿不到 approval 服务就拒绝），要重点看审批服务是否还在 |
| **P1.3** | `dsh-model-tier-router`、`dsh-model-provider-failover`、`dsh-model-inspection-guard`、`dsh-developer-role-guard` | 依赖 P0 的 provider；`developer-role-guard` 要先实测新版 pi-ai 的 `compat.supportsDeveloperRole` 是否已自动生效（若是则不必迁） |
| **P1.4** | `dsh-task-scheduler`、`dsh-project-brief`、`dsh-prompt-enhance`、`dsh-session-watchdog`、`dsh-stuck-loop-guard`、`dsh-memory-files`、`dsh-hy3-gateway`、`dsh-vision-rotator` | 协作/服务类，彼此独立；`hy3-gateway` 需确认是否还用 hy3 免费通道 |

### 7.2 每项的统一验证方式

1. 往 `~/.dsh/profiles/desktop/cordis.patch.yml` 加一条 `- insert: [{ id, name }]`（或对已有行加 config）
2. 重启应用
3. 看 `%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log` 与 `.error.log`：**不应出现该插件的报错行**
4. 看 `~/.dsh/<插件状态目录>/` 是否被创建/更新（证明它真的在跑）—— 这是最直接的"生效证据"
5. 出问题：删掉那一行，重启

### 7.3 可以直接判死的三项

`dsh-force-reasoning-effort`（官方已内置推理强度）、`dsh-tool-renderers`（官方已原生渲染 goal/jobs/subagent）、`dsh-file-explorer`（官方 `ui-sidebar-files` + `ui-sidebar-documentpreview` 已覆盖）—— **不要迁**，改用官方行。

---

## 8. P3｜带 client 半的插件（15 个，风险最高）

**为什么风险最高**：这些插件的 client 半是 `lib/client.js`，靠**自注册进 `window.__ModuleLoader__`** 加载，并使用 `toolview` / `tool.call.toolview` 这类 keyed 渲染器 API 与 slot 注册。内核换了，这套**协议格式可能已变**，而它不像 host 插件那样"加载失败就报一行错" —— 它可能**把整页渲染搞坏**。

### 8.1 处理纪律

- **一次只加一个** client 插件，加完必须实际打开界面确认整页正常
- 先加**最不依赖别人的**：`dsh-ui-performance`（纯 CSS 注入）→ `dsh-system-notify` → `dsh-frontend-reload`
- 再加渲染器类：`dsh-diagram-renderer`（**必须迁**，官方无 mermaid）、`dsh-vision-engine`、`dsh-model-picker-group`、`dsh-model-whitelist`、`dsh-skills-manager`
- **最后处理两个须改造的**：`dsh-remote-workspace`、`dsh-super-injector` —— 它们的 client 半引用已删除的 `@deepseek-ai/dsh-client-runtime`，**必须先改成新内核的对应包**（先确认新内核用什么替代 —— 可能是 `dsh-client-modules` / `dsh-client-ui-slots`）
- **先测后迁的三个**：`dsh-settings-scope-shim`、`dsh-file-explorer`、`dsh-tool-renderers` —— 很可能官方已覆盖，**能不加就不加**

### 8.2 出问题时的止损

client 插件把页面搞坏时，界面上可能已经没法操作 → 只能**改文件 + 重启**：删掉可疑行，或临时把 `cordis.patch.yml` 恢复为 `[]`。
`dsh-plugin-settings-scope-shim` 这类纯前端垫片尤其要小心 —— 它整包只为 client 面存在。

---

## 9. P4｜第三方插件（先升级，再决定迁不迁）

**先升级，很多问题自动消失。** 实测（用内核自带 semver + 双基线自检）：

| 包 | 本地 → 最新 | 升级后能否过门禁 |
|---|---|---|
| `dsh-better-sidebar` | 0.22.1 → **0.24.1** | **✅ 14/14 个 peer 已适配 0.2.x** |
| `dshmarket` | 1.40.0 → **1.66.6** | ✅ 可过（但**新版已内置 `dshmarket@1.66.5`**，其实不必装） |
| `@huanlin/dsh-plugin-better-sidebar-plugin-office` | 0.1.2 → **0.2.0** | ✅ 新版已移除 dsh peer 约束 |
| `dsh-context` | 0.59.2 → 0.60.0 | ✅ 本地版也已通过 |
| `@openviking/dsh-memory-plugin` | 0.3.0 → 0.5.9 | ✅ 本地版也已通过 |
| `dsh-bash-terminal` | 0.3.15（已是最新） | ❌ 11/11 个 peer 仍不接受 |
| `dsh-find-plugin` | 0.3.7 → 0.4.0 | ❌ 仍不接受 |
| `dsh-office-tools` | 1.0.3 → 1.0.4 | ❌ 仍不接受 |
| `dsh-tool-search` | 0.1.5（已是最新） | ❌ 6/6 个 peer 仍不接受 |

**处置建议**：
- `dsh-better-sidebar`：**先升级再迁**，这是唯一"升一下就通"的重点项
- `dshmarket`：**不迁** —— 新版自带，且更新
- 4 个仍被拒的：要么等作者适配，要么用内核的**逐版本豁免**（`dsh plugin allow-version`，需显式接受风险，会写 `compatibility.json` 到 profile）。**建议先不动**，它们不在你的核心链路上
- `@liustack/modlens` / `modsearch` / `pptwise` / `@vectorize-io/hindsight-coding-agents`：**无 dsh peer 约束**，内核不拦，但要实测运行
- `dsh-modlens-guard` / `dsh-modlens-autoread`：**没有 modlens 就是死代码**，modlens 到位后再谈

---

## 10. 纪律（明确不要做的事）

1. **不要一次性全迁** —— 一次一批，验证通过再往下
2. **不要把 `~/.dsh/_backups/desktop-profile-v2.0.2-20260930` 搬回 `profiles/`** —— 那会把 51 个旧 bundle 一次性全部带回，等于放弃我们刚争取到的干净基线。要抄就**逐项抄**
3. **不要把 API Key 写进仓库产出目录** —— 本仓库**已经有一个真实 Firecrawl Key 泄漏在 git 历史里**（`outputs/2026-09-16-doc-model-manager-redesign/cordis.patch.yml.before-uninject:78`，提交 `2baca37`）。MCP 条目里用占位符或从 `.credentials.yaml` 读
4. **不要同时改 profile patch 和加插件** —— 出问题无法定位是哪一处
5. **不要用 PowerShell 的 `Add-Content` / `>>` 写含中文的文件** —— PS 5.1 默认按 ANSI(GBK) 编码，会把中文写坏（本仓库 `CHANGELOG.md` 已有 2,346 处不可逆乱码就是这个原因）。用 Edit/Write 工具或 Node 的 `fs.writeFileSync(p, s, 'utf8')`
6. **不要 `git submodule update`** `plugins/dsh-routing-suite` —— 其 `PROVENANCE.md` 明确警告会把 `injector` 静默降级到不含 H1–H4 安全修复的构建
7. **client 插件不要批量加** —— 一个坏的会连累整页，且坏了之后界面已无法操作，只能改文件重启

---

## 11. 未决项（需要实测，不能靠读源码定）

| 项 | 为什么未决 | 怎么测 |
|---|---|---|
| `compaction-basic` 旧 422 的触发条件 | 新版本所有包里检索 `422` 无压缩相关说明 | 实测：固定摘要模型 vs 让它跟随最新路由，看是否复现 422 |
| `session-projection-cache` 的性能收益 | 结论基于布局/README，**未做压测** | 若你在意，可保留 1000/60000 对比；但结构上旧痛点已消失 |
| `dsh-super-injector` 是否仍需覆盖 `profileNodeModules` | 新版默认值未知 | 加条目后看它是否指向 `profiles/desktop/node_modules` |
| `better-sidebar` 的 `disabled:false` 是否仍需要 | 旧理由针对已换掉的内核 | 不加试一次，看 sidebar 是否正常工作 |
| `dsh-settings-scope-shim` 是否还有事可做 | settings 已重写 | 不加试一次，看设置页是否正常 |
| 官方 `deepseek-official` 搜索在你网络是否可用 | 你当年用 bing 是因为 firecrawl 被 IP 封 | 打开 `dsh-tool-web`（默认关）+ 实测一次搜索 |
| `dsh-developer-role-guard` 是否已多余 | 新版 pi-ai 有逐路由 `compat` | 不装它，用一个 ModelScope 类 provider 实测流式请求是否被拒 |
| `dsh-session-watchdog` 是否已被官方覆盖 | 新版 `dsh-goal-round-driver` 自带续行驱动 | 造一个 active-but-disarmed 目标，看是否自动续跑 |
| modlens / modsearch / pptwise / hindsight 能否在新内核跑 | 无 peer 约束但 API 面未知 | 逐个装 + 实测功能 |

---

## 12. 附：本方案的产物

| 文件 | 内容 |
|---|---|
| `README.md` | 本方案 |
| `patches/P0-llm-providers.patch.yml` | **P0 可直接应用的 18 provider / 75 模型 patch**（程序化导出，无 API Key 值） |
| `patches/P0-llm-providers.manifest.json` | provider 清单 + 源文件 SHA256 |
| `evidence/migration-matrix.json` | 44 个插件的逐项决策矩阵（判定/批次/理由/风险/缺失引用） |
| `evidence/old-plugins.json` | 44 个旧插件盘点（功能/入口/peer/inject/hasClient/行数） |
| `evidence/old-config.json` | 旧 18 provider / 75 模型 + 15 条 patch + 51 bundle / 59 依赖 |
| `evidence/new-default-capabilities.json` | 新版 226 个可配置行（183 默认开 / 32 默认关 / 11 条件式） |

支撑数据已从 `_tmp/` 复制进本目录 —— `_tmp/` 属 gitignore 且会被定期清理，不能作为记录依赖。
原始可重放脚本仍在 `D:\Deepseek-Harness\_tmp\migration-inventory\`（`scan.mjs` / `gen.mjs` / `table.mjs`）。

**下一步**：请确认是否从 P0 开始执行。P0 不需要你配合改文件（纯文件写入），但**改 profile 后需要重启应用**，而按本项目守则我不自动重启 —— 需要你点一下。

