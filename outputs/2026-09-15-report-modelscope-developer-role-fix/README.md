# ModelScope 流式 400 `developer is not one of [...]` — 根因、修复与结构性防护

- 日期: 2026-09-15
- 类型: report
- 主题: modelscope-developer-role-fix
- 状态: **现行**（配置级修复已**热重载生效并实测通过**；结构性防护插件已装配，**待重启**）

## 概述

用户报告调用 ModelScope 报错：

```
400: {"code":"invalid_parameter_error",
      "message":"developer is not one of ['system', 'assistant', 'user', 'tool', 'function']",
      "param":null,"type":"invalid_request_error"}
```

**结论**：不是 ModelScope 的配置问题，也不是网络问题 —— 是 DSH 把**系统提示词当作 `role:"developer"` 发出**，
而 ModelScope 的流式端点只接受 `system/assistant/user/tool/function`。
根因是「pi-ai 对**未登记端点**默认 `supportsDeveloperRole=true`」+「`dsh-force-reasoning-effort`
注入 `reasoning=true`」+「该模型在 `settings.yaml` 里漏配 `compat.supportsDeveloperRole:false`」三者相乘。

修复分两层：**配置级**（补齐漏配 + 把另外两个同类隐患提供商归一化到路由级）+ **结构性**
（新增插件 `dsh-developer-role-guard`，让"以后新增提供商/模型"不再依赖人工记性）。

## 一、症状与复现（决定性的一步：非流式测不出来）

| 请求形态 | ModelScope 行为 |
|---|---|
| **流式**（DSH 恒用） | `400 {"code":"invalid_parameter_error","message":"developer is not one of [...]"}` |
| 非流式 | `200` + `"choices":null`（**静默空响应**，看不出是角色问题） |

⇒ 首轮我用非流式复现，拿到 200 假绿；改用 `stream:true` 后**逐字复现**了用户那条 400。
**这条经验适用于以后所有同类排查：DSH 恒流式，验证必须带 `stream:true`。**

## 二、根因链（全部带 `路径:行号`）

1. **决策点**：`@earendil-works/pi-ai/dist/api/openai-completions.js:787`
   ```js
   const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
   const role = useDeveloperRole ? "developer" : "system";
   ```
2. **compat 从哪来**：同文件 `:1194` `getCompat()` = `model.compat.X ?? detected.X`；
   未配置时落到 `detectCompat()`（`:1148`）的规则：
   `supportsDeveloperRole = isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter)`
   —— **`api-inference.modelscope.cn` 不在任何已知厂商列表 ⇒ 默认 `true`**。
3. **reasoning 从哪来**：`dsh-llm-pi-ai/lib/index.js:537` `resolveModelReasoning()` 对未声明
   `reasoningEfforts` 的模型返回 `reasoning:false`；但 `plugins/dsh-force-reasoning-effort/lib/index.js:177`
   在运行时把这类模型**注入** `model.reasoning = true`（`:148-155` 的 `isKnownNonReasoning` 以
   「cost 全零」判定为"未知"而非"已知不支持"，故不跳过）。
4. **配置缺口**：`~/.dsh/settings.yaml` 的 `modelscope` 提供商中，3 个模型只有 2 个写了
   `compat.supportsDeveloperRole:false`；实际在用的 `deepseek-ai/DeepSeek-V4.1-Flash` 漏了
   （model-tier-router 日志：该模型 09-15 09:24 被调用，用户 09:28 粘贴报错）。
5. **为什么"配置里有默认值"这条退路不存在**：`dsh-llm-pi-ai/lib/index.js:963`
   `const Config = z.object({ providers: z.dict(profile).default({}) })` —— **没有全局 compat 默认**，
   只能逐路由写。事故当天 16 个提供商里 15 个都手工写过那一行，漏掉的那一个就是全部成因。

链路归属（排查中的排除项）：`modlens` 的包装适配器是**纯透传**
（`@liustack/modlens/dsh/index.js:680` `ctx.llm.stream({ ...options, provider: upstream })`），
不构造消息体，**不是根因**；`hy3-gateway` 是混元通道，与本问题无关。

## 三、修复

### 3.1 配置级（已生效，热重载）

文件：`C:\Users\机械革命\.dsh\settings.yaml`（**工作区之外**，沙箱拒绝写入 ⇒ 用一次性提权命令完成，
含时间戳备份 + 临时文件 `rename` 原子替换 + 回读校验）

| 提供商 | 改动 | 理由 |
|---|---|---|
| `modelscope` | 加**路由级** `compat.supportsDeveloperRole:false` | 补上漏配的 `V4.1-Flash`，并让**以后新增的模型自动继承** |
| `sennsenova` | 同上（原本只有 3 个模型级） | 同类隐患：**加第 4 个模型就会重现本 bug** |
| `tokenrouter` | 同上（原本只有 1 个模型级） | 同上 |
| `openrouter` | 同上（原本**完全没有** compat） | **复核阶段补获**：其 `openai/gpt-oss-20b:free` 命中 pi-ai 的 `isOpenRouterDeveloperRoleModel` 分支（id 以 `openai/` 开头）⇒ 在配置层仍会发 `developer`。关闭后配置层归零 |

- 备份：`~/.dsh/_backups/settings.yaml.bak-2026-09-15T02-42-37-534Z`（modelscope 修复前）、
  `…bak-2026-09-15T03-06-14-349Z`（归一化前）
- sha256：`420da1cd…` → `d8aed68e…` → `252f95d0…`（两次改动各自可回滚）
- 保留原有模型级条目（与路由级同值，冗余但零风险；未做顺手删除，避免动到"正在工作"的配置）
- **未改任何工作区文件**（本次配置改动全部在 `~/.dsh` 下）

### 3.2 结构性防护（已装配，待重启生效）

**新插件 `plugins/dsh-developer-role-guard/`**（bundle · experimental）：包装 pi-ai 适配器
（与 `dsh-force-reasoning-effort` 同款、本机已验证的模式），对**非白名单**路由强制
`model.compat.supportsDeveloperRole = false` ⇒ 系统提示词走通用的 `system`。
白名单＝真 OpenAI 系（provider + host 双判据，含子域），保住 o 系列对 `developer` 的依赖。

装配 4 处全部完成，且：
```
[断言] runtime dep / runtime bundle / template dep / template bundle / junction：PASS
[断言] template==runtime bundles: PASS（47/47）
[验证] startup-verify 10/10 PASS（含 V9 插件语法预检 40 插件/100 文件、V10 bundle patch 声明）
```

## 四、验证证据（分级，不混用）

### ✅ 实测（可复现）

| # | 验证 | 结果 |
|---|---|---|
| 1 | 真 pi-ai `stream()` + 真 ModelScope，模型**无 compat**（漂移态） | 上网角色 `"developer"` ⇒ **400 逐字复现** |
| 2 | 同一漂移态 + 本插件 `patchModel` | 上网角色 `"system"` ⇒ **`done` 成功** |
| 3 | 原始 API 对照（脚本直连） | 流式+developer→400；流式+system→200；流式+system+`reasoning_effort`+tools→200 |
| 4 | 配置改动经 **DSH 官方 `Config` schema** 校验 | 接受；三个提供商均 `routeCompat=false & allModelsCovered=true` |
| 5 | 插件单测 `tests/plugins/developer-role-guard.test.mjs` | **11/11 pass** |
| 6 | **故障注入**（防"修一个问题造一个问题"） | `getModels()` 抛错／`Object.freeze` 描述符／`compat` 只读／畸形 snapshot ⇒ **全部 fail-open**，且单模型失败**不拖累同批其它模型** |
| 7 | fake-ctx 接线（apply→wrap→`ctx.effect` 还原） | 第三方路由被置 `false`、真 OpenAI 路由 `undefined` 不动、**dispose 后两条路由键全部消失＝完全还原**、`failed=0` |
| 8 | **活体验证（运行中的内核）** | 强制走 `modelscope/DeepSeek-V4.1-Flash` 的真实调用返回 `PONG`（修复前该路径必 400） |
| 9 | 生效方式 | `settings.yaml` mtime 10:42 晚于应用启动 09:18，调用成功 ⇒ **chokidar 热重载生效，无需重启**（`dsh-settings-file` `watch` 默认 true） |
| 10 | 台账一致性 | `scripts/audit-plugin-inventory.mjs` **11 PASS / 0 WARN**（改前 9 PASS / 2 WARN） |
| 11 | 相似问题扫描（**完整复刻 `detectCompat` 规则**后终态复算） | 16 提供商 / 71 模型：`modelscope`/`sennsenova`/`tokenrouter` 由模型级归一化为路由级、`openrouter` 补齐路由级 ⇒ **配置层 `would send developer = 0`，且无提供商缺路由级 compat**；装载守卫后仍为 0（纵深防御） |
| 12 | **复核（证伪轮）**：独立重验而非复述结论 | 从 profile 目录真实 `import` 插件包成功（`name`/`inject`/`apply` 契约正确，对照：工作区根目录解析失败＝预期）；4 处装配直接读文件复核 PASS（`template==runtime` 47/47、junction realpath 正确）；`startup-verify` 真实 V9 重跑 PASS（40 插件/100 文件） |
| 13 | **重启后装载复验**（用户 14:10 重启） | 插件日志 `已启用` + `已包装 1 个 pi-ai 适配器实例`（bundle 列表装载成功，非热注入）；`/health` 全绿 200、`failed:[]`、`plugins` 探测 39 个；`startup-verify` **10/10**（真实 V9：40 插件/100 文件 all ok）；重启后 modelscope 活体调用返回 `PONG` |
| 14 | **生产故障注入（最强证据）** | 故意抹掉 `modelscope` 路由级 compat ⇒ 真实内核调用**依然成功**（`PONG`），插件日志 `snapshot 处理: patched=1 allowed=0 already=70 failed=0` —— 71 个模型中**恰好那 1 个漏配者**被改回 `false`；随后配置按备份**字节级还原**（`byte-identical: true`，sha256 回 `05ac88d2888cae7f`） |

| 15 | **探测项修复生效复验**（用户 20:35 第二次重启） | `/health` 探测项 9 → **10 项**，`developerRole.guard = {"ok":true,"detail":"adapters=0 patched=15 allowed=0 failed=0"}` ✅；应用进程启动 20:35:39；`startup-verify` **10/10**；插件日志显示上一进程**正常卸载**（`已还原 15 个模型描述符（插件卸载）`）⇒ 卸载还原路径在生产里也被验证到了 |
| 16 | **配置缺口「长回来」的实测 + 两法交叉验证** | 提供商 16 → **18**、模型 71 → **86**；新增 `codecraft`(6) 与 `apinex`(9) **均无路由级 compat** ⇒ 静态分析算出缺口 **15 个**，与守卫实跑 `patched=15` **完全吻合**。守卫的纵深防御在生产中**首次真正被用到**（这 15 个模型当前全靠它） |

### ⚠️ 本轮新发现并已修的缺陷（重启后实测才暴露）

- **文档承诺的 `/health` 探测项 `developerRole.guard` 实际没注册**（9 个探测项里没有它）。
  根因：原实现把 `ctx.hostServices` 与 `ctx.reflect.get('hostServices')` 写在**同一个 try** 里，
  而访问未注入的服务会抛错 ⇒ 反射兜底永远走不到，catch 又是空的 ⇒ **静默缺失**。
- **修法**（本仓惯例）：`inject: ['llm']` → `['llm','hostServices']`（8/8 个使用该服务的插件同此写法）
  + 分段兜底 + **注册失败显式记日志**（不再静默吞掉这类缺陷）。
- **已固化回归**：单测 11 → **15 项**，新增 4 条接线回归（`inject` 必须含 `hostServices`、
  在位时必须注册、**访问抛错时反射兜底仍须可达**〔原缺陷复现〕、完全没有 `hostServices` 时不得抛出）。
- ✅ **探测项已生效**（用户 20:35 重启后）：`/health` 探测项从 9 → **10 项**，
  `developerRole.guard = {"ok":true,"detail":"adapters=0 patched=15 allowed=0 failed=0"}`。
- ⚠️ **同批发现一个观测项账目 bug（轻微，待修，不为此单独重启）**：`detail` 里 `adapters=0`
  与守卫日志 `已包装 1 个 pi-ai 适配器实例` **互相矛盾**。根因：`lib/index.js:377` 的
  `stats.adapters = wrapped` 记的是"**本次新包装数**"，被后续 `llm/adapters-updated` 扫描
  （适配器均已包装 ⇒ `wrapped=0`）覆盖为 0。**仅影响读数语义**，护栏动作不受影响。

### 🔍 未验证 / 明确边界

- **✅ 上游已核实**（2026-09-15 深夜，通道：**Firecrawl MCP**；本机 `web_search`/`curl` 仍被 TLS 阻断）：
  同一根因已是上游公开讨论 —— [deepseek-ai/deepseek-harness **Discussion #551**「llm-pi-ai: expose `supportsDeveloperRole` in `PiAiCompatProfile`」](https://github.com/deepseek-ai/deepseek-harness/discussions/551)
  （2026-08-13 发起，2 条回复）。其结论与本报告一致：`useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`，
  pi-ai 按端点探测默认 `(!isNonStandard && !isOpenRouter)` ⇒ 长得像标准 OpenAI 的端点一律拿到 `true`。
  讨论里的两个 workaround（手工改装好的 `lib/index.js`、`pi2dsh` 注册原生 adapter）**我们都不需要**：
  实测本机内核**原生支持**该字段 —— `.../@deepseek-ai/dsh-llm-pi-ai/lib/index.js`（105,974B, mtime 08-22）
  L886 `supportsDeveloperRole: z.boolean()`（zod schema）+ L367/L390 `supportsDeveloperRole: "offer"`（offered 校验表），
  且 `patches/bundles/*` **无任何补丁涉及该字段** ⇒ 配置级修复是**官方支持路径，重建/升级不丢**，无补丁漂移负担。
- **✅ 交叉验证（两法独立吻合）**：静态覆盖度分析算出的缺口恰为 **15 个**（`codecraft` 6 + `apinex` 9），
  与守卫生产实跑日志 `snapshot 处理: patched=15 allowed=0 already=71 failed=0` **完全一致**。
- **⚠️ 配置层缺口会随新供应商"长回来"（实测）**：本次窗口内提供商 16 → **18**、模型 71 → **86**，
  新增的 `codecraft` 与 `apinex` **都没有路由级 compat** ⇒ 这 15 个模型当前**完全依赖守卫插件兜底**
  （守卫一旦未装载/被卸载即退回 400）。这正是"配置级修复 + 运行时守卫"两层都要有的实证理由，
  也是下面「下一步计划」第 1、2 项的直接依据。
- ~~新插件重启后从 bundle 列表装载的端到端复验~~ → **已完成**（见第 13 项）。
- ~~插件热重载行为未实测~~ → **已实测**：本构建下 `dev_reload_package` 报 `loader.internal 不可用`，
  bundle 插件改动**必须重启**才生效（台账已据此标注）。
- `openrouter` **是否真的会拒绝** `developer` 未实测（本次没对它发过带 developer 的请求）；但已从配置层关闭该分支，不再构成风险面。
- **并发写观察**：复核期间发现 `settings.yaml` 被其他会话/用户改动多次（`agent-default-model` 依次切到
  `modlens-amd` → `modlens-tokenrhythm01/deepseek-flash`，15:41 一次；随后又新增 `codecraft`/`apinex` 两家供应商）。
  我的四条路由级 compat 在这些写入后**全部存活**（说明 GUI/schema 往返不会丢该字段），且我每次写入都
  先重读 + 精确锚点 + 原子替换（未覆盖他人改动）。新默认模型链 `modlens-tokenrhythm01 → tokenrhythm01`
  经查 `routeCompat=false`（14 模型全覆盖），无重现风险。

## 五、风险收益评估（逐步）

| 步骤 | 收益 | 风险 | 等级 | 缓解 |
|---|---|---|---|---|
| 改 `~/.dsh/settings.yaml`（三提供商） | 消除已知 400；归一化后**新增模型自动免疫** | 配置写坏 ⇒ 提供商整体不可用 | **中** | 时间戳备份 + 原子替换 + **DSH 官方 schema 复验** + sha256 前后留痕 |
| 新增运行时守卫插件 | 覆盖**未来所有**新提供商/新模型（唯一能做到的机制） | 触及所有 LLM 调用路径 | **中** | 全程 fail-open + 只改一个布尔字段 + 复制不原地改 + 幂等 + 卸载还原 + `dryRun` + 白名单不误伤真 OpenAI + **故障注入实测** + 可 `dev_uninject_plugin` 秒退 |
| 台账/记录同步 | 可追溯、门禁绿 | 无 | **低** | 脚本带锚点唯一性断言 + 审计复核 |

**为什么不选另外两条路**：
- *只改 vendor（patch `detectCompat` 默认值）*：会影响**真 OpenAI 的 o 系列**（它们需要 `developer`），
  且依赖补丁体系与重建流程，升级即可能漂移 ⇒ 风险高于收益。
- *只做配置级*：治标 —— 新增提供商/模型仍会重现本 bug（`sennsenova`/`tokenrouter` 就是活证据）。

## 六、可维护性 / 可迭代性 / 可扩展性

- **可维护**：单一职责（只碰"角色"这一项）；配置驱动；`README.md` 写清机制、`路径:行号` 证据、
  边界与回滚；README 明说"只解决角色，其它协议差异不在范围内"，不假装万能。
- **可迭代**：`dryRun`（先观测后动手）、`enabled`（静默）、`allowProviders`/`allowHosts`（白名单可增补）、
  日志写 `~/.dsh/super-injector/dsh-developer-role-guard.log`、可选 `/health` 探测项
  `developerRole.guard`（含 patched/allowed/failed 计数）⇒ 长期运行可观测。
- **可扩展**：与 `dsh-force-reasoning-effort` 同构的适配器包装模式已在本机跑通，
  以后要再加"非 OpenAI 上游的协议收敛"（如 `thinkingFormat`、tool-call 细节）可**平行新增同类插件或扩白名单**，
  不需要动内核与 vendor。

## 七、回滚路径

1. 配置级：从 `~/.dsh/_backups/settings.yaml.bak-*` 回滚（两个时间点任选）；
2. 插件级：`dev_uninject_plugin`（立即卸载并还原内存描述符，免重启）或
   `node scripts/deregister-plugin.mjs --plugin dsh-developer-role-guard --yes`（持久化注销）；
3. 只想静默：插件 `config.enabled: false`（或 `dryRun: true` 保留观测）。

## 八、遗留事项

- **待用户指示重启**：新插件由 bundle 列表装载（重启后生效）；按重启守则未自动重启。
- 可选清理：`modelscope`/`sennsenova`/`tokenrouter` 里已被路由级覆盖的模型级 `compat` 条目（冗余无害）。
- 工作区根目录有两个 0 字节杂散文件 `=` 与 `max`（创建于 09-14 23:27/23:28，**非本次会话产生**），
  建议用户确认后清理。
- 若日后仍遇到同类报错：先确认该路由是否漏配 `compat`（守卫应已兜住），
  再看插件日志 `~/.dsh/super-injector/dsh-developer-role-guard.log` 的 `patched/allowed/failed` 计数。

## 产物

| 文件 | 说明 |
|---|---|
| `README.md` | 本文件（根因/修复/验证/风险/回滚/遗留） |
| `../../plugins/dsh-developer-role-guard/README.md` | 插件说明书（机制、配置项、安全护栏、边界、回滚） |
| `../../plugins/dsh-developer-role-guard/lib/index.js` | 守卫实现（纯函数导出 + fail-open 包装） |
| `../../tests/plugins/developer-role-guard.test.mjs` | 单测 **16 项**（含故障注入三条方向性回归 + 4 条接线回归 + 1 条账目回归） |
| `../../scripts/audit-developer-role.mjs` | **新增**：只读门禁（check-all **Step 1.15**，阻塞式），防同类缺口再次长出来 |
| `../../tests/scripts/audit-developer-role.test.mjs` | **新增**：门禁判据常驻回归 9 项（漏报/误报/故障注入三向） |

---

## 六、后续加固（同日第二轮，2026-09-15 深夜执行）

> 触发：重启后实测发现**配置缺口会随新供应商长回来**（16→18 家、71→86 模型，新增 `codecraft`/`apinex`
> 均无路由级 compat ⇒ 15 个模型**完全依赖守卫**；当时 `agent-default-model` 正走 `modlens-apinex`）。
> 结论：仅靠"记得写 compat"不可持续 ⇒ 补配置 + 加门禁。

### 6.1 已执行（免重启，已生效）

| # | 项 | 证据 |
|---|---|---|
| 1 | 为 `codecraft`(6) / `apinex`(9) 补路由级 `compat.supportsDeveloperRole: false` | 锁 + 备份 `settings.yaml.bak-2026-09-15T13-14-12-294Z` + 原子写 + schema 复验；**复算 18 提供商 / 86 模型 `gaps=0`**。**行为不变**（守卫本就在强制 false，配置只是把既有行为写成事实） |
| 2 | 新增只读门禁 `scripts/audit-developer-role.mjs` 并接入 `check-all.ps1` **Step 1.15（阻塞）** | `--self-test` 8/8；真跑 `exit 0`；**故障注入**（副本抹掉 apinex compat）⇒ **`exit 1` 且逐条点名 9 个模型**；逃生口 `DSH_ALLOW_DEVELOPER_ROLE_GAPS=1` ⇒ `exit 0` + 警告；`check-all.ps1` PowerShell 解析 0 错误；常驻回归 **9/9** |
| 3 | 修线上实测的探测项账目 bug（`adapters=0`） | `wrapAll` 由"本次新包装数"改为"**当前受守护数**"；插件单测 15 → **16 项**（新增幂等 + 读数一致性断言） |

### 6.2 门禁设计要点（可维护 / 可迭代 / 可扩展）

- **单一判据来源**：白名单直接复用守卫插件的 `isAllowedUpstream`（不复制第二份规则）；端点探测规则集中在一个函数 + `--self-test` 8 用例作**漂移哨兵** —— 上游若把"未知即不支持"改成默认 `false`，改一处 + 跑自检即可。
- **fail-closed**：读不到/解析不了 `settings.yaml` ⇒ `exit 2`，绝不假装通过；文件不存在（非源码部署/新机器）⇒ `skipped` 视为通过（与 `/health` 探测的 skipped 语义一致，防 F20"狼来了"）。
- **阻塞而非告警**：代价不对称 —— 漏报的后果是"每个请求硬 400"，误报的后果只是"加一行"；配逃生口避免真的卡住别人。
- **可扩展**：新增判据（例如将来 `supportsReasoningEffort` 这类同源兼容位）在同一函数与同一张白名单上追加即可。

### 6.3 本轮遗留

- ⏳ **需重启才激活**：6.1 第 3 项（bundle 插件不可热重载，`dev_reload_package` 报 `loader.internal 不可用`）。**不为此单独重启**。
- ⚠️ **发现但未动**（另一会话的编辑，按"禁止静默顺手改"上报）：`codecraft.baseURL` 引号内**有前导空格**（`" https://codecraftapi.com/v1"`）。
- 可选清理（等你确认）：冗余模型级 `compat` 条目；仓库根目录 0 字节杂散文件 `=`、`max`。
