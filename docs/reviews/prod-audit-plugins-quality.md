# 插件生态工程质量审计报告（投产前）

> 审计对象：`plugins/` 下 14 个插件（安全敏感插件另有专人审查，本文不覆盖）。
> 审计方式：只读静态分析（源码阅读 + `node --check` 语法校验），不运行插件入口。
> 严重级定义：**P0**=阻塞投产；**P1**=投产前必修；**P2**=优化建议。
> 状态：✅ 已完成（14/14 插件，增量更新 6 轮，全程只读分析）。

## 0. 审计范围与文件清单（已勘察）

| 插件 | 顶层 package.json | src/ | lib/ 入口 | client UI | 备注 |
|---|---|---|---|---|---|
| dsh-bandof-diag | ✅ | ❌ | lib/index.js | 无 | 只有产物无源码 |
| dsh-deep-whale-main | ❌（顶层无） | ✅（maid-atelier/src） | maid-atelier/lib/index.js | maid-atelier/lib/client.js | 插件实体在子目录 maid-atelier/ |
| dsh-force-reasoning-effort | ✅ | ❌ | lib/index.js | 无 | 只有产物无源码 |
| dsh-frontend-reload | ✅ | ❌ | lib/index.js | lib/client.js | 只有产物无源码 |
| dsh-model-picker-group | ✅ | ❌ | lib/index.js | lib/client.js | 只有产物无源码 |
| dsh-model-tier-router | ✅ | ❌ | lib/index.js | 无 | 只有产物无源码 |
| dsh-model-whitelist | ✅ | ❌ | lib/index.js | lib/client.js | 只有产物无源码 |
| dsh-modlens-autoread | ✅ | ❌ | lib/index.js | 无 | 只有产物无源码 |
| dsh-modlens-guard | ✅ | ❌ | lib/index.js | 无 | 只有产物无源码；60s 巡查 daemon |
| dsh-project-brief | ✅ | ✅ | lib/index.js(+map+d.ts) | 无 | TS 构建链完整 |
| dsh-routing-suite | ❌（顶层无） | ✅（injector/src） | injector/lib/index.js | injector/lib/client.js | 聚合包：vendored injector + preset + install.ps1 |
| dsh-session-watchdog | ✅ | ✅ | lib/index.js(+map+d.ts) | 无 | TS 构建链完整 |
| dsh-system-notify | ✅ | ❌ | lib/index.js | lib/client.js | 只有产物无源码 |
| dsh-vision-engine | ✅ | ❌ | lib/index.js | lib/client.js | 只有产物无源码 |

## 1. 分插件审计发现

（以下各节随审计进度填充）

### 1.1 dsh-bandof-diag

**定位**：14 行诊断 shim（`lib/index.js`），无 src（本体就是手写产物，可接受）。作用：若 `globalThis.bandOf` 未定义则安装一个 no-op 打点（返回首参），用于定位 router-bootstrap 缺导入问题。

发现：
- **P2 | dsh-bandof-diag | lib/index.js:1-14**：注释自述"已修复，待下次重启后可卸载"——临时诊断插件残留在投产清单里。globalThis 打点桩会永久掩盖未来任何 `bandOf` 缺导入的回归（静默返回 args[0] 而不报错）。**建议：投产前卸载本插件**；若保留，至少把 no-op 改为打一次警告日志。
- 无 apply 异常路径、无异步、无定时器——健壮性本身无问题。


### 1.2 dsh-deep-whale-main

**定位**：第三方皮肤仓库 `Small-tailqwq/dsh-deep-whale` 的 vendored 快照（无 .git），插件实体在子目录 `maid-atelier/`（包名 `@dsh-external/dsh-client-ui-skin-maid-atelier`）。host 侧 `lib/index.js` 是空 `apply(){}`；全部逻辑在浏览器端 `src/client/index.ts`（607 行，构建产物 2.6MB）。

亮点（本批最佳）：客户端所有 MutationObserver / ResizeObserver / setTimeout / rAF / window 监听 / CSSOM 写入 / document.title / theme-color meta 都在 `ctx.effect` disposer 里逐项还原（index.ts:257-294），卸载零残留；幂等挂载；有 1298 行 vitest 测试。src/lib 同步（有源码有产物）。

发现：
- **P1 | dsh-deep-whale-main | maid-atelier/package.json:27**：许可证 **CC-BY-NC-SA-4.0（非商业使用）**。若本产品有任何商业分发/内嵌场景，投产即构成许可冲突。需产品/法务确认分发性质；不能确认则投产包剔除该皮肤或取得授权。另注意皮肤资源为第三方角色形象二创，版权链条见 README。
- **P2 | dsh-deep-whale-main（顶层）**：vendored 快照无版本钉扎（无 .git、无 commit 记录、顶层无 package.json），上游更新无法追溯/对比。建议在顶层放 README 或 manifest 记录 upstream commit。
- **P2 | maid-atelier/package.json:28-30**：peerDependency 写 `@deepseek-ai/cordis@^4.0.1`，与仓内其它插件的 `cordis@>=4.0.0-rc <5` 包名/范围不一致（上游官方包名差异）；link 加载下不致命，但口径应统一。
- **P2 | lib/client.js（2.6MB）**：webp 美术资源全部 base64 内联，单文件巨大，首屏解析成本可观；建议资源改外部文件按需加载（优化项，不阻塞）。


### 1.3 dsh-force-reasoning-effort

**定位**：host-only（277 行，手写产物即源码，注释极详尽）。包装 pi-ai 适配器的 `current()`/`resolveModel()`，给缺推理元数据的模型注入思考强度档位。有 test-plugin.mjs / probe-live.mjs 开发脚本。

亮点：卸载还原完整（ctx.effect 恢复原方法 + 还原已打补丁描述符，:273-283）；包装有幂等标记防重复；`llm/adapters-updated` 后重新扫描；配置校验严格（非法档位直接抛清晰错误）；处处防御性 try。

发现：
- **P2 | lib/index.js:240-249**：包装后的 `adapter.current()` 是热路径（每次取模型快照都走），内部 `patchSnapshot` 每次全量遍历模型表。幂等标记使重复调用近乎空转，但遍历本身仍在；大模型表时有轻微开销。可接受，记录在案。
- **P2 | lib/index.js:122-128**：同步 `mkdirSync`+`appendFileSync` 写 `~/.dsh/super-injector/*.log`，无轮转，长期运行无限增长（多个插件同款问题，见 2.4）。
- **P2 | lib/index.js:297-320**：深度耦合内核私有结构（`llm.adapters` Map、`snapshot.models.getModels()`、`thinkingLevelMap`、`llm/adapters-updated` 事件名）。内核升级若改动这些形状，插件会静默退化为 no-op（fail-open，不致命但功能失效无告警）。建议 wrapAll 里对"找到 0 个适配器"记 WARN。
- **P2 | 包卫生**：无 src/（可接受，代码即文档）、无 peerDependencies、无 `files` 字段（npm pack 会把 probe/test 脚本也打进包）。


### 1.4 dsh-frontend-reload

**定位**：host 空壳 + 客户端 56 行：右下角刷新按钮 + window keydown 拦截 Ctrl(+Shift)+R 强制 `location.reload()`（补 Windows 桌面壳无应用菜单的缺口）。

发现：
- **P2 | lib/client.js:48-57**：`mountKeyHandler` 无幂等守卫也无卸载路径：每次 `apply()` 都追加一个永不移除的 window keydown 监听（按钮/样式有 id 去重，监听器没有）；热重载多次应用后同键多监听叠加。建议用 ctx.effect 注册并在 disposer 里 removeEventListener，或加模块级标记防重入。
- **P2 | lib/client.js:50-56**：无条件 `ev.preventDefault()` + reload，与注释声称的"仅当没有更早处理器时接管"不符（代码并未检查）；生成进行中 Ctrl+R 会直接触发刷新（有 maid-atelier 皮肤时 beforeunload 会弹确认，无皮肤时无任何防护）。低风险，但注释与实现不一致应修正。
- **P2 | package.json:13-19 + cordis.patch.yml**：`files: ["lib"]` 不含 `cordis.patch.yml`，且 package.json 只声明了 `dsh.client` 而未声明 `dsh.bundle.patch`（对比 model-picker-group 等都有声明）——目录里的 cordis.patch.yml 可能从不生效/不被打包，属死配置或漏配置；需对照内核加载逻辑确认后二选一修正。
- host 侧无逻辑，无异步/定时器问题。


### 1.5 dsh-model-picker-group

**定位**：host 空壳 + 客户端 258 行。合并模型选择器里 `（modlens vision）` 双胞胎组到上游厂商组，并**静默接管**：选中普通模型时自动改走其 modlens 包装渠道（`api.sessions.models` / `api.sessions.selectModel` 双包装）。与 modlens-autoread 通过按钮 aria-label 上的 `（modlens vision）` 标记联动。有单测脚本。

发现：
- **P1 | lib/client.js:158-222（设计问题）**：接管"永远生效、无开关"（注释："设置入口已移除…如确需关闭…改回调用条件"）。静默把用户选择的模型换成另一条计费/能力语义不同的渠道，运维无任何配置面可关闭。投产前至少提供一个 config/localStorage 级别的 kill-switch，并在文档明示默认接管行为。
- **P1 | lib/client.js:178-222（卸载不还原）**：对共享 `api.sessions.models/selectModel` 的包装没有 ctx.effect disposer 还原（只防重复包装，不卸载）。插件移除/热重载后改写逻辑永久残留于页面会话；与 modlens-autoread 等联动插件的组合行为将不可预测。建议记录原函数并在 effect disposer 中恢复（判断仍被自己持有再还原）。
- **P2 | lib/client.js:249-251**：`window.setInterval(patchModelAriaLabel, 800)` 模块加载即启动、永不清除（window 全局防重复但无卸载路径），每 800ms 一次全 DOM 查询，插件卸载后依旧运行。建议迁入 apply() 的 ctx.effect 生命周期。
- **P2 | lib/client.js:64-78**：`diag()` 在每次 models()/selectModel 时 POST `/vision-engine/diag`，形成对 vision-engine 路由的硬依赖（未加载时静默 404，可接受）；诊断日志落盘 `~/.modlens/picker-diag.log` 无轮转（见 2.4）。
- 异步处理得当：`origModels().then()` 内 try/catch 完备，无吞掉的 rejection（错误仍返回原 res）。


### 1.6 dsh-model-tier-router

**定位**：host-only 335 行。监听 `agent/request` 瀑布，按关键词/长度启发式分类任务复杂度，在同 provider 高/低模型间切换（子 agent 默认才生效）。注册 3 个 `dev_model_route_*` 工具。有单测（`test/classify.test.mjs`）。

亮点：fail-open（自身异常一律放行原模型，:267-270）；per-turn 分类缓存限 800 条；决策环形缓冲限 50；切换时丢弃 reasoningEffort 避免 UNSUPPORTED；主对话模型绝不改写；统计落盘跨重启保留。

发现：
- **P2 | cordis.patch.yml:21-30 + lib/index.js:62-68**：同一 provider `modlens-tokenrhythm01` 配了两条路由（high=v4-pro 与 high=qwen3.8-max，low 同为 flash）。`findRoute` 首命中优先：从 low 升级永远去 v4-pro，qwen3.8-max→low 可回但 low→不会回 qwen。语义模糊且依赖数组顺序，建议文档化或改用显式 (provider,high,low) 唯一匹配校验（发现重复 low 时告警）。
- **P2 | lib/index.js:62-68 / cordis.patch.yml:21-30**：路由表硬编码具体模型 id，且代码与 yml 两份手工同步（注释：2026-08-23 曾因模型 id 变更导致切换从未触发）。模型 id 再次变化时插件会静默不路由（fail-open）。建议 apply 时对照当前模型目录校验路由存在性，不存在则 logger.warn。
- **P2 | lib/index.js:110-121**：`latestUserText` 对 session.events 无上限倒扫；通常第一条用户消息在尾部附近很快命中，但极端会话（大量非 user/message 事件）单次可达数万次迭代；有 per-turn 缓存兼顾。可接受，若后续出现卡顿可加扫描上限 + 降级策略。
- **P2 | 与其它插件交互**：路由目标模型不受 dsh-model-whitelist 约束（白名单是 picker 层 UI 过滤），理论上可切到被白名单隐藏的模型；两者同开时应在文档中声明行为。与 routing-suite 的 preset router 职责重叠，见 2.3。
- 无定时器/无重试循环/无子进程，无 daemon 失控面；工具参数符合"可选项不写 required"约定。


### 1.7 dsh-model-whitelist

**定位**："模型管理"设置面板 + 选择器白名单过滤（客户端 451 行），host 侧额外提供 `/model-whitelist/test` 连通性测试端点（189 行：读 `~/.dsh/settings.yaml` + `.credentials.yaml`，向厂商发最小 chat 请求）。持久化用 localStorage（`dsh.model-whitelist.v1`），主开关默认关闭。

亮点：host 路由 `trusted()` 校验完整（loopback + Host/Origin 同源 + Sec-Fetch-Site + 端口一致）；请求体 64KB 上限；15s AbortController 超时且 finally 清理；客户端 React 错误边界（guarded + surfaceError）；面板取全量目录走 `api.llm.models` 不受过滤影响。

发现：
- **P1 | lib/client.js:453-466（卸载不还原）**：`api.sessions.models` 被永久包装（模块级 `origModels` 捕获后无 ctx.effect disposer 恢复），与 model-picker-group 同款问题。两个插件叠加包装同一 API，包装顺序决定过滤/合并语义（两者都防御性编写，当前顺序无关紧要，但属脆弱组合）。建议卸载时恢复原函数，并在文档固化两插件的加载顺序约定。
- **P2 | lib/index.js:47-96**：手写缩进式 YAML 解析（逐行正则，假设 2/4/6 空格缩进），上游 settings.yaml 排版变化即静默解析为空→"未配置"误报。建议换正规 YAML 解析或复用内核读取逻辑。
- **P2 | lib/client.js:83-92**：`surfaceError` 往 body 追加固定定位错误条且永不移除，重复出错会叠多条；建议去重/自动消失。
- **P2 | lib/client.js:311-325**：测试连接 fetch 无取消机制，面板卸载后仍会 setState（无害但不干净）。
- **P2 | 安全移交**：host 端点读取 `.credentials.yaml` 的 API Key 并代理请求至配置文件指定 URL——loopback 校验已做，但凭据处理细节请安全审查人复核（本审计只确认了访问控制面）。


### 1.8 dsh-modlens-autoread

**定位**：host-only 354 行。`agent/pre-step` 钩子：纯文本模型收到图片块/粘贴路径时自动调 modlens CLI 转写为证据文本。与 picker-group（aria-label 标记）、vision-engine（用量上报，动态 import 可选依赖）联动。

亮点：promise 级缓存合并并发读（LRU 64、失败不缓存）；临时目录 finally 清理；所有路径绝不抛错（降级原 decision）；spawn 带 `windowsHide:true` + `ELECTRON_RUN_AS_NODE`；ctx.effect 正确 off() 卸载监听；文件写入 0600。

发现：
- **P1 | lib/index.js:83**：`appendFileSync('D:/Deepseek-Harness/spawn-trace.log', ...)` —— 调试残留：硬编码绝对路径（写进仓库工作区）、每次子进程都追加、无轮转。投产前必须删除或改到 ~/.dsh 下并降级为可开关诊断。
- **P1 | lib/index.js:207-232（daemon 失控面）**：失败**故意不缓存**（注释"下次重试有机会"），但单次读图超时上限 180s（CLI_TIMEOUT_MS）。一张持续失败的图片（如 CLI 挂起类故障）会在**每个 agent step 的 pre-step 重跑一次**（decision.messages 每步全量转换），无负缓存、无退避、无熔断 → 每步最多 180s 阻塞 + 子进程堆积风险。建议：失败加短 TTL 负缓存或同 key 重试上限（如 3 次后本会话熔断），并为 spawn 加本地看门狗（即使 CLI 不遵守 --timeout 也能 kill）。
- **P2 | lib/index.js:146-181**：readImageBlock 的 `attachments.readImage` 形状假设（`stored.data` / `stored.ref.mediaType`）失败时错误文本已覆盖，但整个链路依赖内核私有 API，升级需回归验证。
- **P2 | lib/index.js:31-38 vs 127-129**：`pastePathPattern()` 每次 findPastePaths 都重建正则（含转义运算），长文本多消息时有开销；可模块级缓存。
- **P2 | inject 声明**：`['agents','llm','attachments']` 中 `agents` 未见直接使用（agent 来自事件 payload），冗余声明若该服务名变更会连累启动；建议核对后精简。


### 1.9 dsh-modlens-guard

**定位**：host-only 205 行 daemon。每 60s 巡查 `~/.dsh/profiles/web/cordis.patch.yml`，移除 modlens 块的 `visionProvider: false` 并强制 families 全量；变更时文件修复 + `entry.update()` 热重建 modlens 条目。支持 `# modlens-guard: off` 哨兵关闭；含 `.simulate-attack` 测试钩子。

亮点（生命周期）：定时器用 `ctx.setInterval` 注册在 ctx.effect 内、disposer 里 `clearInterval`（:202-203）——14 插件中教科书级示范；巡查为纯本地文件操作，无 LLM/token 消耗、无网络重试，单次开销极低；`runOnce` 同步快进快出，异步 `hotReapply` fire-and-forget 带 catch，60s 间隔下无重入堆积。

发现：
- **P1 | lib/index.js:108-122 + 190/197（与 AGENTS.md 禁令冲突）**：`hotReapply` 对 modlens 执行 `entry.update(..., true)` 重建 fiber。AGENTS.md 明令"严禁对 @liustack/modlens 热重载：会丢失 adapter 注册，会话切到 modlens-* 报 no adapter registered 并卡死服务"。本守卫在检测到配置被改时恰会触发热重建——若重建语义与 dev_reload_package 相同，则守卫自己会制造它要防的故障（且触发时会话可能正在用 modlens 渠道）。投产前必须验证 `entry.update` 重建后 adapter 是否完整重注册；不能验证则改为"只修文件 + 提示重启"，把热重建降级为可选。
- **P2 | lib/index.js:25**：PATCH_PATH 硬编码 `profiles/web`；其它 profile 名下守卫完全失效（静默）。建议从 DSH_PROFILE/env 推导，找不到文件时记 WARN。
- **P2 | lib/index.js:180-189**：`writeFileSync` 直接覆写活动配置文件，非原子（写到一半崩溃会损坏 cordis.patch.yml，影响下次启动）。建议写临时文件 + rename。
- **P2 | lib/index.js:23**：`inject = ['timer']` 但代码实际只用 `ctx.setInterval`；若内核无名为 `timer` 的可解析服务，inject 会阻塞启动（AGENTS.md 同款告警）。请确认 `timer` 服务存在，否则从 inject 移除。
- **P2 | lib/index.js:22**：导出 name `'dsh-modlens-guard'` 缺 `@dsh-external/` 前缀，与其余插件不一致（可能影响注入器按名去重/匹配）。
- **P2 | lib/index.js:29,153-166**：`.simulate-attack` 哨兵一旦误留，守卫每 60s 真实写坏再修复生产配置文件并热重建——投产检查单应包含"确认该哨兵文件不存在"。


### 1.10 dsh-project-brief

**定位**：工具包插件（`project_brief_update` 工具）：为工作区生成/增量更新 AGENTS.md。架构最规范的一个：纯逻辑 `core.ts`（零 DSH 依赖、可离线测）+ 薄注册层 `index.ts`；src/lib/d.ts/sourcemap 齐全；构建脚本与 typecheck 齐备；有 smoke 脚本。

亮点：指纹未变不重写（幂等）；AUTO 区标记 + 策展区保留；文件名防路径穿越（拒绝 `..` 与分隔符）；全部事实采集 `safe()` 包裹失败安全；peerDependencies 全用范围（`>=0.0.1-rc <2` / `>=4.0.0-rc <5`），无硬编码内核版本。

发现：
- **P1 | src/core.ts:76-77（lib/core.js 同步存在）**：`execSync('git rev-parse ...')` / `execSync('git log ...')` **均未带 `windowsHide: true`**——直接违反 AGENTS.md"Windows 子进程铁律"（桌面壳无控制台，2026-08-23 刚修过同款 8 处）。该工具被 agent 调用时会闪黑框。修复：加 `windowsHide: true`。
- **P2 | src/core.ts:76-77**：execSync 无 `timeout`——git 挂起（凭据弹窗/网络盘）会无限阻塞工具执行。建议 `timeout: 5000` + windowsHide 一起加。
- **P2 | src/index.ts:35**：`workspacePath` 来自 agent 参数，写文件前仅校验存在性；结合 fileName 校验已足够防越界文件名，但"可被 agent 指向任意目录写 AGENTS.md"属工具本意，安全审查人可再确认。


### 1.11 dsh-routing-suite（含 injector vendored 溯源）

**定位**：聚合仓（`github.com/yjh051108/dsh-routing-suite` 的完整 git clone，HEAD `5bc5d56`，2026-08-15），内含两个**独立 clone**（各自有完整 .git 目录，非注册的 gitlink 子模块）：
- `injector/` = `dsh-super-injector`，HEAD `c03de54`（2026-08-24，`v0.3.3-1-gc03de54`，含 H1-H4 安全修复，"生产基线 2026-08-23"）；
- `preset/` = `dsh-router-standard`，HEAD `d4655d5` = v0.1.1 tag（与套件钉扎一致）。
另有未跟踪文件 `dsh-external-dsh-super-injector-0.3.3.tgz`（经解包比对：其 `lib/index.js` 与工作区 injector **逐字节相同**，即安全提交之后重打的包，但文件名/内部 version 仍标 0.3.3）。

**代码质量（抽样）**：注入器本体（src 3137 行）工程化程度高——注册表原子写（tmp+rename）、自愈重试上限 3 次后 `heal-exhausted` 审计、watch 轮询带 `reloading` 重入守卫 + 悬空目录 30s 节流 + 绝不触发自身重载、所有工具/路由注册挂 ctx.effect、DSH_HOME 优先防 homedir 错位。抽查范围内无无限重试/无清理定时器。peerDependencies 用范围声明。脚手架模板（daemon-loop 模板自带 `inject:['timer','llm']`，解释了 modlens-guard 的 timer 服务依赖来源）。

发现（含已知线索核实，详见第 3 节）：
- **P1 | preset/preset/router-bootstrap.mjs:22-25 vs 107-108（源码与运行时不同步）**：vendored 源码（上游 v0.1.1）**缺少 `bandOf` / `extractText` 导入**却在 :107/:08 使用——正是 dsh-bandof-diag 注释里诊断的那个 bug。修复只落在运行时副本 `~/.dsh/.agent-presets/router-standard/router-bootstrap.mjs`（+1 行导入，已实测确认），**未回流上游/未更新 vendored 源**。删除重装（install.ps1 在目标已存在时跳过，但手工清理后重装）即回归该 bug：weak 模式引导失效 + `session/event` 处理器内 ReferenceError。修复：把 +1 行导入提交回 vendored 副本并推上游打 v0.1.2。
- **P1 | injector 版本漂移**：套件钉扎 `f4ef59f`(v0.3.3)，实际检出 `c03de54`(v0.3.3+安全修复)，且因是独立 clone，`git submodule status` 显示未注册（`-` 前缀）——钉扎形同虚设。任何人执行 `git submodule update --init --recursive` 会把注入器**降级回无安全修复的 v0.3.3** 且不报错。修复：提交套件把钉扎 bump 到 c03de54（或上游打 v0.3.4），并在 README/CHANGELOG 记录"当前生产基线 = c03de54"。
- **P2 | 未跟踪且版本号失真的 tgz**：`dsh-external-dsh-super-injector-0.3.3.tgz` 内容是 v0.3.3+1 的构建却标 0.3.3，若被当作 Release 资产分发会造成供应链歧义。删除或按内容重打版本号。
- **P2 | install.ps1 本地修改未提交**（ASCII 化 + 错误处理加固，方向正确）；上游同步会丢失。建议提交或推上游。
- **P2 | injector/src/index.ts:580,2303**：watch 轮询默认 1500ms 全量指纹注入清单 + registry（纯本地文件读，开销小）；投产配置若不需要"改代码自动热重载"，建议把 intervalMs 调大或关掉 watch（生产环境不需要开发态热重载）。
- **P2 | preset/probe/**：38 个评测脚本 + 结果 JSON 随包携带（含 `creds.mjs` 凭据读取脚本），不参与运行，属仓库赘肉；投产分发可裁剪（安全审查人请一并看 `probe/creds.mjs`）。


### 1.12 dsh-session-watchdog

**定位**：daemon-loop 形态（TS，src/lib/d.ts 齐全，181 行）。每 30s 扫描 live agents 的目标，把 active+disarmed 的目标 `resume()` 重新武装，修复会话恢复后目标不续跑。AGENTS.md 点名的守护插件。

亮点（daemon 失控面全部受控）：intervalMs/cooldownMs 双下限校验（≥ 5s，防抖配置直接抛错）；同一目标 60s 冷却防振荡；**轮次耗尽的目标永不自动恢复**（round-limit 硬墙）；只动 idle agent；paused/blocked 默认不碰；`goals`/`agents` 用 ctx 代理 + `ctx.reflect` 惰性解析（严格遵守 AGENTS.md"永不解析的服务不写 inject"），inject 只留 `timer`；每步 try/catch + `Promise.resolve(...).catch`，无未处理 rejection；空转日志每 20 轮一条防刷屏；无 LLM/token 消耗、无网络、无子进程。`ctx.setInterval` 由 cordis 生命周期托管（与 modlens-guard 的显式 effect+clearInterval 等价）。

发现：
- **P2 | lib/index.js:104-109**：同款无轮转日志（`~/.dsh/super-injector/dsh-session-watchdog.log`，见 2.4）。
- **P2 | src/index.ts:101**：`lastResume` Map 按 goal.id 累积不清理（量极小，长运行数月级别才有意义），可加容量上限。
- 未发现其它问题。本插件可作为其它 daemon 插件的参考实现。


### 1.13 dsh-system-notify

**定位**：host 空壳 + 客户端 120 行。窗口失焦时检测新 assistant 回复 → Web Notification（Windows toast）；并向其它插件暴露 `ctx.notify` service。60s 冷却 + 聚焦不打扰。

亮点：MutationObserver + 30s keepAlive 自愈重附着（注释记录了"观察会话容器会被卸载导致通知永久失效"的踩坑），且两者都在 `ctx.effect` 的 disposer 里断开/清除（:104-107）——客户端插件生命周期的正面样本；权限请求带 catch；所有异步路径有错误处理。

发现：
- **P2 | lib/client.js:99-108**：`ctx.effect` 不可用时（理论上客户端运行时恒有）observer/interval 无清理路径；可忽略，仅备案。
- 无 host 侧逻辑、无定时器残留、无吞掉的 Promise。整体质量良好。


### 1.14 dsh-vision-engine

**定位**：图片识别模型配置中心：多配置管理/切换（写 `~/.modlens/config.json` 槽位）、测试识别（跑 modlens CLI）、额度查询（厂商余额接口，尽力而为）、本机用量统计（导出 `recordUsage` 供 autoread 上报）、粘贴图预览；并**托管本机 Ollama 生命周期**（启动/停止/开机自启）。8 条 `/vision-engine/*` 路由。客户端 824 行设置面板 + 粘贴预览卡片。

亮点：apiKey 只存 host 侧，浏览器只见 `hasKey`/`set` 掩码（且不把回传的 `"set"` 当真实 key 落盘，:664-670）；额度/测试请求全部 host 发起；用量环 5000 封顶；粘贴图预览路由有完整目录穿越防御（:764-801）；客户端预览轮询有幂等清理（`window.__VE_POLLERS__` 先清后挂，:804-822）；所有 fetch 带超时+AbortController。

发现：
- **P1 | lib/index.js:231,482,518**：三处 `appendFileSync('D:/Deepseek-Harness/spawn-trace.log', ...)` 调试残留（与 modlens-autoread 同款，同一调试会话引入）。投产前删除。
- **P1 | lib/index.js:458-562,677-680,841-849（机器级副作用 + 安全移交）**：面板保存配置即可（a）`taskkill /F` 杀本机全部 `ollama.exe`/`llama-server.exe`；（b）写 VBS 进 Windows 启动目录实现开机自启（注释称"用户要求永久保留"）；（c）VBS/回退 spawn 硬编码 `OLLAMA_MODELS=D:\ollama-models`（盘符/路径机器特定）。这些是系统级副作用，应由用户在文档中明确知情；且 `/vision-engine/config`（可写任意 baseUrl+apiKey）、`/vision-engine/refresh`（触发 CLI 执行）、`/vision-engine/test`（`body.path` 接受任意文件路径交给 CLI，:684-692/:311-328）的 `trusted()` 只有 loopback+Host 校验，**无 Origin/Sec-Fetch-Site 检查**（对比 model-whitelist 的同名函数更严格）——跨站 POST 可触达这些端点。请安全审查人重点复核 CSRF 面；工程侧建议把 `trusted()` 升级到 whitelist 版本，并给 `handleTest` 的 path 参数加 PASTE_ROOT 限制。
- **P2 | lib/index.js:85-88,196,675**：`writeJson`/`writeModlensSlot` 非原子写（崩溃可损坏 `~/.modlens/config.json`，影响 modlens 本体）；建议 tmp+rename。
- **P2 | lib/index.js:27-36**：profile 探测顺序 `desktop→web` 与 modlens-guard 硬编码 `web` 不一致（见 2.3）。
- **P2 | lib/client.js:804-822**：900ms 轮询 + 4 个 document/window 监听靠 `window.__VE_POLLERS__` 防累积，但插件卸载后无人清除（同 picker-group 模式）；建议迁入 ctx.effect。
- **P2 | lib/index.js:713-737**：每次"刷新"都会用内置测试图真实调一次视觉模型（计费调用），无频率限制；建议客户端加防抖或服务端加冷却。
- 无定时器/无守护循环，无 daemon 失控面；异步错误全部有降级返回。


## 2. 工程卫生汇总（随审计更新）

### 2.1 package.json 版本与 peerDependencies
| 插件 | name | version | peerDependencies | 备注 |
|---|---|---|---|---|
| bandof-diag | @dsh-external/dsh-bandof-diag | 0.0.1 | 无 | 临时诊断插件，无 peer 合理 |
| deep-whale/maid-atelier | @dsh-external/dsh-client-ui-skin-maid-atelier | 0.0.1 | `@deepseek-ai/cordis ^4.0.1` | 包名/范围与仓内口径不一致；CC-BY-NC-SA |
| force-reasoning-effort | @dsh-external/dsh-force-reasoning-effort | 0.1.0 | 无 | 无 files 字段 |
| frontend-reload | @dsh-external/dsh-frontend-reload | 0.1.0 | 无 | files 排除 cordis.patch.yml |
| model-picker-group | @dsh-external/dsh-model-picker-group | 0.1.0 | 无 | |
| model-tier-router | @dsh-external/dsh-model-tier-router | 0.1.0 | 无 | |
| model-whitelist | @dsh-external/dsh-model-whitelist | 0.1.0 | 无 | |
| modlens-autoread | @dsh-external/dsh-modlens-autoread | 0.1.0 | 无 | |
| modlens-guard | @dsh-external/dsh-modlens-guard | 0.1.0 | 无 | 导出 name 缺前缀 |
| project-brief | @dsh-external/dsh-project-brief | 0.0.1 | dsh-llm/dsh-tools `>=0.0.1-rc <2`、cordis `>=4.0.0-rc <5`、schemastery `^3.18.0` | ✅ 规范范围声明 |
| routing-suite/injector | @dsh-external/dsh-super-injector | 0.3.3（实际内容=0.3.3+安全提交） | dsh-tools/cordis/schemastery 范围 | 版本号失真（见 1.11/3） |
| routing-suite/preset | dsh-router-standard | 0.1.1 | 无（engines node>=22） | |
| session-watchdog | @dsh-external/dsh-session-watchdog | 0.0.1 | 同 project-brief | ✅ 规范范围声明 |
| system-notify | @dsh-external/dsh-system-notify | 0.1.0 | 无 | |
| vision-engine | @dsh-external/dsh-vision-engine | 0.1.0 | 无 | |

**结论：无任何插件硬编码内核版本号**（有 peer 者全部范围声明）。问题集中在：多数插件零依赖声明（仓内约定的零依赖 host 模式，可接受）；皮肤包 peer 包名口径不一；injector 版本号失真。

**src/lib 同步性**：有源码的 4 家（maid-atelier、project-brief、session-watchdog、routing-suite/injector）src/lib 均齐备且对应（brief/watchdog 带 sourcemap+d.ts，injector 有 build 链）；无源码的 10 家中，除 bandof-diag 是 14 行 shim 可接受，其余属"手写产物即源码"，注释质量高但缺构建链，建议投产后逐步把 tier-router/modlens-* 纳入 src+构建。

### 2.2 node --check 结果汇总
| 文件 | 结果 |
|---|---|
**24/24 全部 PASS，无语法错误**。覆盖 14 插件全部 host 入口与 client bundle、preset 的 router-bootstrap/router-core：bandof-diag/index；maid-atelier/index+client；force-reasoning-effort/index；frontend-reload/index+client；picker-group/index+client；tier-router/index；whitelist/index+client；autoread/index；guard/index；brief/index+core；injector/index+client；router-bootstrap.mjs；router-core.mjs；watchdog/index；notify/index+client；vision-engine/index+client。

### 2.3 职责重叠/冲突分析（路由 / 白名单 / 模型选择 / 视觉类）
**"路由"类三件套（不同层，非重复建设，但叠加面广）**：
- `model-tier-router`：host 层换**模型**（高/低价切换，默认仅子 agent）；
- `routing-suite/preset router-standard`：会话层换**思维模式**（persona/工具面，按首条用户消息分类）；
- `force-reasoning-effort`：元数据层补**思考强度**能力。
三者各自实现"读首条用户消息 + 关键词正则分类"启发式（tier-router COMPLEX_RE 与 router-core 高度相似），同一输入被分类两次且标准不同；组合语义（如 tier-router 换模型后 router 按新 modelId 选 persona）未见文档。**不构成冲突，但建议投产文档固化组合语义**。另：tier-router 路由目标不受 whitelist 约束（1.6 已述）。

**模型选择器双层包装链**：`model-whitelist`（过滤）与 `model-picker-group`（合并+静默接管）都包装 `api.sessions.models`，picker-group 另包装 `selectModel`。两层均无卸载还原（各 1 条 P1），叠加顺序未文档化。

**modlens 视觉四件套（产品链路完整，隐式契约多）**：guard（保活双胞胎）→ picker-group（合并+接管，靠 aria-label 字符串标记联动 autoread）→ autoread（自动读图，靠粘贴路径约定 + 动态 import vision-engine 的 recordUsage）→ vision-engine（配置/用量 + `/vision-engine/diag` 接收 picker 诊断）。四插件契约全是字符串/路由级隐式约定，无版本化、无配置面，任一改名即静默失效。建议补"modlens 视觉链契约"文档作为投产交付物。

**profile 假设不一致**：modlens-guard 硬编码 `profiles/web`；vision-engine 探测 `desktop→web`；autoread/vision-engine 的 CLI 定位用 `DSH_PROFILE||web`。桌面壳若实际运行在 desktop profile，guard 静默失效。建议统一 `DSH_PROFILE` 驱动。

### 2.4 日志无轮转（共性问题）

以下追加式日志均无上限/轮转（单条小、增速低，不阻塞投产，建议统一加尺寸上限）：`~/.dsh/super-injector/{dsh-force-reasoning-effort,model-tier-router,modlens-guard,dsh-session-watchdog}.log`、`~/.modlens/picker-diag.log`。**另有违规写入仓库工作区的 `D:/Deepseek-Harness/spawn-trace.log`（autoread:83 + vision-engine:231,482,518，P1 待删）**。

## 3. 已知线索核实：routing-suite\injector 与 dsh-super-injector 的关系
**结论：线索属实，且现状比预期更需处置。**

1. **来源**：`plugins/dsh-routing-suite` 是 `github.com/yjh051108/dsh-routing-suite` 的完整 git clone（HEAD `5bc5d56`，2026-08-15）。`.gitmodules` 声明 `injector → yjh051108/dsh-super-injector`、`preset → yjh051108/dsh-router-standard`。AGENTS.md 所述“插件经 dsh-super-injector 注入/热重载/持久化装配”的宿主机制，**就是这份 vendored 副本**（当前会话的 `dev_inject_plugin`/`dev_reload_package` 等工具全部由它提供）。
2. **当前状态（实测）**：两个“子模块”实为**独立完整 clone**（各带完整 .git 目录；`git submodule status` 显示 `-` 未注册），套件钉扎不被执行：
   - injector 检出 `c03de54`（2026-08-24，`v0.3.3-1-gc03de54`，提交标题：security+client: H1-H4 安全修复同步…生产基线 2026-08-23），比套件钉扎的 `f4ef59f`（=v0.3.3）**多 1 个安全提交**；
   - preset 检出 `d4655d5`（=v0.1.1 tag，与钉扎一致，但其 `router-bootstrap.mjs` 缺导入修复，见 1.11）；
   - 套件工作区脏：`install.ps1` 有未提交本地加固（ASCII 化 + 错误处理），另有未跟踪 `dsh-external-dsh-super-injector-0.3.3.tgz`（解包比对：与工作区 injector 的 lib 逐字节相同 → 是安全提交后重打的包，但文件名/内部 version 仍标 0.3.3）。
3. **更新方式**：全手动（各组件目录内 `git pull`），无自动同步；套件 README 自述“子模块指向各自 main”（跟 main 漂移，而非钉 tag）。
4. **与宿主注入机制的一致性风险**：
   - 注入器是所有其它插件的装配/热重载通道，自身却处于**版本漂移 + 钉扎失效 + 工作区带未提交修改**状态 → 投产基线不可复现；
   - 最危险的误操作：任何人按标准流程跑 `git submodule update --init --recursive`，会把注入器**无声降级回不含 H1-H4 安全修复的 v0.3.3**；
   - 宿主依赖注入器私有行为（registry.json、junction、loader.internal.loadCache），上游继续演进时本地必须人工验证同步。
5. **处置建议（投产前必做）**：① 上游把安全提交打成 v0.3.4 tag，套件钉扎 bump 到该 tag（或改回真正 `submodule init` 流程并同步钉扎）；② 套件根提交 `PROVENANCE.md`：两组件的 upstream/commit/日期 + “生产基线 = injector c03de54”；③ 提交或推送 install.ps1 本地修改；④ 删除/重打版本失真的 tgz；⑤ 运行时 preset 副本的 +1 行导入修复回流 vendored 源与上游（见 1.11）。


## 4. 整体判定
**判定：有条件通过（修复 P1 后可投产）。未发现 P0。**

- **P0：0 条**。全部 24 个入口 `node --check` 通过；无崩溃级缺陷；无致命异步错误吞噬。
- **P1：9 条（投产前必修）**：
  1. autoread:83 + vision-engine:231,482,518 共 4 处 `D:/Deepseek-Harness/spawn-trace.log` 调试残留；
  2. autoread 失败无熔断：坏图每 agent step 重跑最长 180s CLI（1.8）；
  3. project-brief `execSync` 缺 `windowsHide:true`，违反子进程铁律（1.10）；
  4. modlens-guard `entry.update` 热重建 modlens 与 AGENTS.md 禁令冲突，需验证或降级为仅修文件（1.9）；
  5. picker-group 静默改道无开关（1.5）；
  6. picker-group + whitelist 包装共享 API 卸载不还原（1.5/1.7）；
  7. deep-whale 皮肤 CC-BY-NC-SA 许可与分发性质待确认（1.2）；
  8. routing-suite：injector 版本漂移/钉扎失效（误操作可静默丢安全修复）+ vendored router-bootstrap 缺导入、重装即回归（1.11）；
  9. vision-engine 机器级副作用（taskkill/启动目录 VBS）+ 弱 trusted() 无 Origin 检查，移交安全复核（1.14）。
- **P2：40+ 条**（见各节）：集中在无轮转日志、非原子文件写、客户端轮询/监听卸载不彻底、硬编码 profile/模型 id、包卫生（无 files/无 src）。

**亮点（值得投产保留并推广）**：
- `dsh-session-watchdog`：daemon 失控防护的参考实现（双下限校验/冷却/轮次硬墙/惰性服务解析/全链路容错）；
- `dsh-modlens-guard`、`dsh-system-notify`、`maid-atelier` 的 ctx.effect 生命周期纪律（定时器/观察器/监听卸载零残留）；
- `dsh-deep-whale-main/maid-atelier`：全仓最好的客户端资源治理 + 1298 行测试；
- `dsh-super-injector`（vendored）：注册表原子写、自愈重试上限、防自毁守卫等设计成熟；
- `dsh-project-brief`/`dsh-session-watchdog` 的 TS 构建链 + 范围式 peerDeps 是包卫生标杆；
- 14 插件无一硬编码内核版本；tier-router/model-whitelist 的 fail-open 与 loopback 访问控制设计良好。

**投产检查单（除 P1 修复外）**：确认 `modlens-guard/.simulate-attack` 哨兵不存在；卸载或降级 bandof-diag；确认 `~/.dsh/.agent-presets/router-standard` 与 vendored 源一致；生产配置调大/关闭 injector watch 热重载轮询；文档固化“模型选择链/路由三件套/modlens 视觉链”组合语义。

---
*审计完成：14/14 插件；报告增量更新 6 轮；全程只读（仅 `node --check` 与 git/tar 只读命令，未运行任何插件入口）。安全敏感面（凭据端点、vision-engine CSRF、preset/probe/creds.mjs、model-whitelist 凭据代理）已在文中标记移交安全审查人。*
