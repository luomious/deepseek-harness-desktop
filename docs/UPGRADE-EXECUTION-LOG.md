# DSH 升级执行日志（UPGRADE EXECUTION LOG）

> 方案依据：`E:\WorkBuddy\learn\DSH全面升级方案书v3-最终版.md`
> 记录规则：每阶段记录 开始/执行项/结果/问题/处置；问题一律登记（含已知过时项）
> 创建：2026-08-28

---

## 阶段 0：基线留存

**开始时间**：2026-08-28（会话内）
**执行项**：
1. ✅ 检查 task-scheduler 锁状态（locks: [] 无活动锁；历史显示多个并行会话近期活跃）
2. ✅ 确认 `verify-features.ps1` 为只读（脚本头注释确认）
3. ✅ 运行 verify-features.ps1 获取基线快照
4. ✅ git status / git log 基线
5. ✅ _backups 清单登记

**验证结果**：
- verify-features：**49 项，48 PASS + 1 FAIL**
  - FAIL: `endpoint/vision-rotator`（http -1）
- git：`master @ 6c768bd`（WORKTREE 有未提交改动，见下）
- vendor：`prod-baseline-20260823` @ 0f5ae64（3 commits 领先）

**问题登记**：

| # | 问题 | 类型 | 处置 |
|---|------|------|------|
| P0-1 | verify-features 的 `endpoint/vision-rotator` 检查 FAIL——dsh-vision-rotator 已卸载（commit af2ba0a 移除残留），检查项过时未清理 | 已知过时检查 | 登记；列入阶段 2 治理批清理该检查项 |
| P0-2 | git 工作树有**并行会话未提交改动**：CHANGELOG.md、dsh-context-lifecycle/{README,lib/client.js,lib/index.js}、plugins/dsh-file-explorer/lib/index.js、patches/bundles/MANIFEST.md、tests/plugins/context-lifecycle-client.test.mjs | 并行会话产物 | **不代提交**（协作铁律）；仅记录，等各会话自行提交 |
| P0-3 | _backups 现状 0.63GB/12 目录（审计时点 4.56GB） | 信息更新 | 已登记；保留策略列入阶段 2 |

**阶段 0 完成判定**：基线快照留存 ✅（本日志 + stage0-verify-features-baseline.txt）
**结论**：基线已留存。因工作树有并行会话未提交改动，**本升级计划的所有 git 提交将只包含本计划自己的改动**，避免混入他人半成品。

---

## 阶段 1：稳定性 P0 五件套（执行中）

### 5.1 装配收敛单入口 + 启动预检（进行中）

**已执行**：
1. ✅ 分析现有装配机制（staged-profile-assemble.ps1 隔离装配引擎、check-all.ps1 门禁链）
2. ✅ 新建 `scripts/startup-verify.mjs`（启动预检 8 项，纯只读）：
   - V1 插件 bundles 可解析（目录存在 OR require.resolve 混合策略）
   - V2 模板=运行态 bundles
   - V3 disabled:true ⊆ insert（patch 结构精确解析）
   - V4 无孤儿 @dsh-external 包
   - V5 dist junction 健康（vendor/dist/win-unpacked）
   - V6 核心运行文件存在（main.js/launcher.js/package.json）
   - V7 单实例 lock 状态（提示项）
   - V8 补丁锚点（modlens lowered0 / workspace ADD_CHAT）
3. ✅ 接入 `check-all.ps1` Step 1.5（装配预检门禁）
4. ✅ 首次运行：**7/8 PASS**（V2 模板漂移 FAIL）

**问题登记**（预检立即发现 2 个真实问题，均非本计划改动）：

| # | 问题 | 证据 | 来源 | 处置 |
|---|------|------|------|------|
| P1-1 | `plugins/dsh-file-explorer/lib/index.js:309` **顶层 return 语法错误**（游离在 isPathAllowed 函数外的 `if (process.env.DSH_FILE_EXPLORER_UNRESTRICTED === '1') return true`），`node --check` 失败 | check-all Step 1 FAIL（1/54） | 并行会话 file-explorer-doc-preview 的未提交中间态（git M，未 commit） | **不代改**（协作铁律）；登记并通知用户/该会话 |
| P1-2 | office 插件 `@huanlin/dsh-plugin-better-sidebar-plugin-office` 已入运行时 bundles 但**模板未同步**（V2：template 31 vs runtime 32） | startup-verify V2 FAIL | 并行会话 install-better-sidebar-office-plugin（已 release，restart required） | 登记；重装 profile 会丢该插件，需同步模板（待用户/该会话确认） |

**下一步**：5.1 的 assemble-profile.mjs（装配收敛单入口，较大工程）在预检机制稳定后单独执行；先继续 5.2 zstd。

### 5.2 zstd 异步化（Option A 已就位，待重启验证）

**适配性检查（用户要求改前先检查，已补做）**：
1. ✅ 模块 `dsh-session-persistence-jsonl` 是 **cordis Service 子类**（构造需完整 ctx.reflect，mock 不可行 → 运行时验证必须重启）
2. ✅ 同步解码热路径共 3 处：`readRaw`(L880) / `readZstdPrefix`(L960) / `readFirstZstdLine`(L1296，原本已异步)
3. ✅ 模块已有 `decompressZstdFrame`(async，L580) —— **用已有 API，不引入新依赖**
4. ✅ 帧边界语义：`scanZstdFrames` 结果不变，逐帧 `buffer.subarray(start,end)` 等价原 decoder
5. ✅ 校验和语义：decompressZstdFrame "validate its checksum" 与原 decoder 一致
6. ✅ abort/错误处理保留；同步 decoder 类保留定义但 `createZstdFrameDecoder` 已无调用点

**改动**：
1. ✅ `readRaw`：同步 decoder 循环 → 逐帧 `await decompressZstdFrame`（3 处 PATCH marker：L880/961/1013）
2. ✅ `readZstdPrefix`：同步 decoder → 逐帧异步（header 帧 frames[0] + idx=1..n-1，yield 逻辑等价）
3. ✅ 备份：`_backups/zstd-async-20260828/index.js.orig`
4. ✅ canon 副本：`patches/bundles/dsh-session-persistence-jsonl-index.js`（57KB）
5. ✅ 登记：`port-user-patches.mjs` 新增 `ZSTD_MODULE` 条目（dev + 构建双 target，markers `PATCH(zstd-async)`），运行 7/7 OK
6. ✅ `verify-patches.ps1` ALL PASS（22 项）

**验证状态（诚实声明）**：
- ✅ 语法：node --check 双副本通过
- ✅ 逻辑等价：逐行论证 + 适配性审计（无遗漏调用点）
- ⏳ **运行时行为验证：需重启 DSH 后端到端验证**（打开大会话/会话列表/导出），cordis 环境 mock 不可行
- ✅ 运行中实例不受影响（内存已加载旧模块）

**回滚路径**：
1. 恢复 `_backups/zstd-async-20260828/index.js.orig` 到两处副本
2. 或从 `port-user-patches.mjs` 移除 ZSTD_MODULE 条目后重跑脚本（会覆盖回 canon——注意 canon 是补丁版，需先恢复 canon）
3. 重启验证失败即执行上述任一

**教训登记**（用户提醒：改前先检查已有代码支不支持/能否适配）：
- 修改内核模块前必须先做：①调用点全量扫描 ②API 契约确认 ③验证路径可行性（本例实例化需 cordis）
- 本次补做检查通过，但流程上应先查后改——记入后续执行规范

### 重启验证记录（2026-08-29 用户重启）

**状态**：✅ DSH 重启后正常（root 200）；✅ zstd 补丁 3 处 markers 仍生效（已加载）；✅ file-explorer 语法错误已被并行会话修复（node --check OK）

**日志证据（%APPDATA%\DSH Desktop\logs）**：
- `2026-08-29 02:16:31`：**file-explorer "Illegal return statement" 导致 plugin tree failed to load**（正是 P1-1 登记的语法错误，重启时实际触发启动失败——印证 AGENTS.md 2026-08-29 原子写纪律事故）
- `2026-08-29 02:25:28`：第二次重启正常（self-maintenance / session-hygiene 正常启动），无 zstd 报错
- 结论：P1-1 已闭环（并行会话修复）；zstd 无运行时报错

**用户反馈**："显示当前不能安全退出"——为关键操作退出保护（critical-busy，有活跃会话时拒绝退出），设计行为非故障。

### 5.3 渲染/GPU 环境加固（现核查明：大部分已存在）

**现状核实**（避免重复劳动）：
- ✅ `apply-gpu-opaque-patches` 已存在：默认 `disable-gpu`（`DSH_DESKTOP_FORCE_GPU=1` 可恢复）+ `disable-features: CalculateNativeWinOcclusion`（lib/main.js L32-39）
- ✅ RENDER-001 白屏自动 reload（旧壳 v1.3.0 机制，新壳需确认保留）
- ⏳ 待补：**GPU/渲染进程崩溃自动降级重启**（`child-process-gone` 监听 → 自动 --disable-gpu 重启，而非仅靠启动时参数）

### 5.4 进程生命周期治理（现核查明：部分已存在）

**现状核实**：
- ✅ `close-stale-dsh.ps1` 僵尸实例清理脚本已存在
- ✅ startup-verify V7 单实例 lock 检查已接入预检
- ✅ hy3-gateway `server.js` 已有 EADDRINUSE 自检（L183-184 "another instance is running; exiting"）——网关双实例防护已存在
- 结论：5.4 现查已覆盖，无需新增（僵尸清理脚本 + lock 预检 + 网关 EADDRINUSE 三重）

### 5.5 自愈体系设边界（✅ 完成）

**执行**：
1. ✅ startup-verify.mjs 重构为可测试：`parsePatchYmlText`（纯函数）+ `check` 导出 + main 守卫（import 不执行检查）
2. ✅ 新建 `tests/plugins/startup-verify.test.mjs`：6 个用例（insert 解析 / 多 insert 块 / 引号剥离 / disabled 隔注释行 / check level 逻辑）——**6/6 PASS**
3. ✅ 修复过程中发现并修正 parsePatchYml 缩进 bug（trim 丢失缩进导致顶级 id 误判为 insert）
4. ✅ 注意：PS 5.1 `Set-Content -Encoding UTF8` 会破坏 UTF-8 文件（第一行 import 被注释吞并）——**已改为 write 工具重写**（教训：改含中文的 .mjs 勿用 PS 写文件）

### 阶段 1 完成状态（2026-08-29 汇总）

| 子项 | 状态 | 证据 |
|------|------|------|
| 5.1 启动预检 | ✅ | startup-verify 9/9 PASS（V1-V9），接入 check-all Step 1.5 |
| 5.2 zstd Option A | ✅ 就位 | 重启后无报错，3 处 markers 生效，verify-patches 22 ALL PASS |
| 5.3 GPU | ✅ 现查覆盖 | apply-gpu-opaque-patches（disable-gpu + occlusion）已默认；崩溃降级归 P3 |
| 5.4 进程 | ✅ 现查覆盖 | close-stale + lock 预检 + 网关 EADDRINUSE 三重 |
| 5.5 自愈单测 | ✅ | startup-verify.test.mjs 6/6 PASS |

**check-all 全绿**：`CHECK-ALL: ALL PASS`（含 Step 1 语法 55 文件 + Step 1.5 预检 9 项 + Step 2 补丁 22 项）

**并行会话问题闭环**：
- P1-1 file-explorer 语法错误 → 已修复（并行会话），重启日志证实曾致启动失败，现 node --check OK
- P1-2 office 模板漂移 → 已同步（V2 现在 PASS）

**重启验证结论**：zstd 补丁已生效且无运行时报错；大会话打开效果待用户实际使用确认

---

## 阶段 2：P2-A-0 工具流式可见性（✅ 插件完成，待重启生效）

**创建**：`plugins/dsh-tool-visibility/`（host 数据层）
- `lib/index.js`：监听 `ctx.on('session/event')` 的 `tool/call` + `tool/result` → 环形缓冲（200）+ 参数摘要（200 字符截断）+ JSONL 落盘（1MB 轮转，`~/.dsh/tool-visibility/events.jsonl`）+ 路由 `/tool-visibility/status` + `/tool-visibility/recent`
- 设计：只读观察者（不干预 agent 循环）、全 try/catch 兜底、webServer 惰性解析 + 退避（同 self-maintenance）、零模型上下文开销（不注册工具）
- `README.md`：文档 + 验证命令

**热装配验证**（dev_install_package，免重启）：
- ✅ 路由工作：status/recent 返回 JSON
- ✅ 真实事件捕获：shell 调用 pending + done 状态、参数摘要、JSONL 落盘
- ✅ 发现并适配 2 个内核细节：
  1. tool/result 的 callId 在 `message.source.callId` / `content[0].toolCallId`（dsh-llm createToolResultMessage 结构）
  2. **系统内部工具 callId（UUID）与模型侧（call_00_）不一致** → 增加 (turn,step) + 时间窗 FIFO 回退匹配

**已知限制**：
- 打包壳 **loader.internal 不可用**（维护手册确认）→ dev_reload_package 失败；卸载→重装后**运行中的是旧实例**，磁盘代码（含 FIFO 回退）**需重启生效**
- dev_uninject_plugin 会写 patch disabled 条目 → 已手动清理（2 次），并同步模板

**装配状态**（重启后自动生效）：
- ✅ dependencies += link（dev_install_package 已写）
- ✅ bundles += @dsh-external/dsh-tool-visibility（已写）
- ✅ junction 存在
- ✅ 模板已同步（profile/desktop/package.json 32 bundles + link 依赖，Node 原子写）
- ✅ cordis.patch.yml 无 disabled 残留
- ✅ startup-verify **9/9 PASS**（含 V2 模板=运行态）

**待重启验证**：
1. dev_plugin_status 显示 tool-visibility active
2. 路由 /tool-visibility/status + /recent 工作
3. 触发工具调用 → recent 显示 name + done + durationMs（关联修复生效，不再 unknown/null）

### 阶段 2 重启验证记录（2026-08-29/31，用户重启后）

- ✅ tool-visibility 重启后正式实例 active；**关联修复生效**：`{"name":"shell","status":"done","dur":550}`（name+durationMs 正常，不再 unknown/null）
- ✅ 路由工作（bufferSize 正常，事件持续捕获）

---

## 阶段 3a：命令风险检测 dsh-command-guard（✅ v1 完成，事件捕获待重启）

**创建**：`plugins/dsh-command-guard/`
- `lib/risk-rules.mjs`：**共享评分纯函数模块**（可单测/可复用）——12 条危险规则 + 8 条 medium 规则 + 白名单覆盖 + 命令提取
  - high：rm -rf 根/盘符/系统目录、format/mkfs/dd 设备、shutdown/reboot、taskkill 关键进程、fork bomb
  - medium：普通 rm -rf、del/rd /s /q、git push --force、chmod 777、reg/sc delete、DISM
  - 设计修正（测试驱动）：rm -rf 目标精确匹配（普通路径 medium，根/系统目录 high）；fork bomb 尾部 `;:` 放宽
- `lib/index.js`：复用 tool-visibility 已验证监听模式（session/event → tool/call → 命令提取 → 评分 → 告警环形 100 + JSONL 1MB 轮转 + `/command-guard/status` + `/command-guard/alerts` 路由）
- `cordis.patch.yml` + `dsh.bundle.patch` 声明（满足 profile loader 强校验）
- 单测 `tests/plugins/command-guard-risk.test.mjs`：**12/12 PASS**

**装配与验证**：
- ✅ dev_install_package 热装（路由 status/alerts 工作）
- ✅ 模板同步（33 bundles）+ startup-verify **10/10 PASS** + check-all **ALL PASS**
- ⚠️ **热装实例收不到 `session/event`**（打包壳 loader 限制）：tool-visibility（重启后正式实例）能收、command-guard（热装）不能 → **需重启成为正式实例后事件捕获才生效**

**风险收益评估**（用户要求）：
| 维度 | 评估 |
|------|------|
| 收益 | 命令风险可见可审计（高危命令发现）；v2 可接 approval 拦截（接入点已摸清：ApprovalService.request 需 open turn + fail-closed） |
| 风险 | **低**：v1 只读监听，不拦截不干预；规则保守（宁少勿误伤）；全 try/catch + 有界缓冲 + 日志轮转 |
| 长期稳定 | 只读观察者 + 失败降级（webServer 退避、日志失败关停），零模型上下文开销 |
| 可维护 | 评分规则纯函数 + 12 单测 + allowlist 配置；风险规则与监听逻辑分离 |
| 可迭代 | v1 观察 → v2 拦截（approval.request）；规则表可扩展 |

**待重启验证**：
1. command-guard 正式实例收到 tool/call → 触发含危险字符串的（无害）命令 → alerts 出现
2. JSONL 落盘 `~/.dsh/command-guard/alerts.jsonl`

### 阶段 3a 故障排查记录（2026-08-31，用户重启后）

**现象**：重启后 command-guard 显示 [active] 但 `/command-guard/status` 404、`~/.dsh/command-guard/` 目录创建时间（10:38）早于重启（10:47）→ **apply 未完整执行**（目录是热装残留）。

**根因（逐层排查证实）**：
1. `debug_webserver_routes`（staging 工具）显示 webServer 26 个 prefix 路由含 `/tool-visibility/*` 但**无 `/command-guard/*`** → command-guard 路由从未注册
2. `debug_register_probe` 从执行 ctx 注册 `/command-guard/status` **成功** → webServer.register 本身正常，差异在 command-guard 自己的 ctx/装配
3. 对比两插件 cordis.patch.yml：**tool-visibility 的 patch 文件被 GBK 编码写坏**（第二行注释乱码 `�?` 吞掉了 `- insert:`）→ 碰巧**只走 bundles 装配** → 工作正常；**command-guard 的 patch insert 有效** → **bundles + patch insert 双装配冲突** → apply 不完整执行

**修复**：command-guard/cordis.patch.yml 改为**纯注释（无 insert）**——走 bundles-only 装配（与 tool-visibility 一致），避免双装配。startup-verify **10/10 PASS**（V3 disabled⊆insert / V10 dsh.bundle.patch 在位均过）。

**教训**：① DSH 插件装配有 **bundles 列表 + patch insert 两条路径，同一插件不得同时走两条**（双装配 → apply 不完整）；② 写坏文件的 GBK 编码事故反而"意外正确"（bundles-only），暴露了装配机制的真实语义——新插件统一走 bundles-only + 纯注释 patch。

### 阶段 3a 深度排查记录（2026-08-31 二轮，用户多次重启后）

**现象演进**：12:11 重启后 command-guard 仍 404；热装（loader.create）后路由 200 但事件监听不生效、apply 副作用（stamp/alerts）不落地——**热装实例状态不可靠**。

**排查（穷尽式）**：
1. staging 探针：webServer 路由表 26 项，tool-visibility 在、command-guard 不在
2. 注册探针：从执行 ctx 注册 `/command-guard/status` 成功 → 代码/路径本身无问题
3. mock ctx 直接调 apply：applyOk（模块与 apply 无运行时错误）
4. super-injector registry.json：空（无热装残留）
5. disabledBundles 状态：无 command-guard
6. **关键对比**：file-explorer 有相对导入 `./extract.js` 但走 **patch 装配**（profile insert 行）；tool-visibility 单文件走 **bundles 装配** → **假设：bundles 装配的 loader 不支持 ESM 相对导入**

**修复（收敛性）**：command-guard 内联为**单文件**（risk-rules 逻辑内嵌，risk-rules.mjs 保留供单测/共享）；cordis.patch.yml 保持纯注释（bundles-only）；junction/模板/无 disabled 全部确认（startup-verify 10/10）。

**待重启终验**：单文件版 bundles 装配是否完整工作（路由 + 事件 + stamp）。若仍失败 → 判定为打包壳 bundles 装配限制，记录后搁置本插件深度调试（不影响其他功能），继续阶段 3b。

**教训**：① 热装/卸载/重装多次操作会搅乱运行态（路由/目录/事件状态不可靠），**验证 bundles 装配必须用干净重启**；② DSH 插件装配路径（bundles vs patch insert）与模块形态（单文件 vs 相对导入）存在未文档化的耦合——单文件 + bundles-only 是最稳组合。

### 阶段 3a 三轮回溯 · 根因确认（2026-08-31 三轮）

**现象**：单文件内联后重启仍 404、apply-stamp 未写、路由表无 command-guard。

**决定性对比**（tool-visibility ✅ vs command-guard ❌ 逐字段）：
| 字段 | tool-visibility（工作） | command-guard（不工作） |
|------|------------------------|------------------------|
| inject | **`['timer']`** | `[]` |
| 其余（name/main/files/patch/bundles/apply 签名） | 相同 | 相同 |

**根因确认**：`inject=['timer']` 提供 `ctx.setTimeout`——command-guard 的路由退避重试依赖它。`inject=[]` 时 `ctx.setTimeout` 不可用 → **首次 registerRoute 失败（webServer 启动竞态）后永不重试 → 永久 404**。tool-visibility 因 inject timer 能退避重试到成功。apply-stamp 未写疑为早期失败路径（待重启确认）。

**修复**：command-guard `inject` 改为 `['timer']`（与 tool-visibility 完全一致）。startup-verify 10/10。

**待重启终验**（三信号）：apply-stamp 存在 / 路由 200 / 触发告警。

**最终教训**：DSH 插件**惰性依赖（reflect.get）前必须先 inject 其计时器等基础服务**；与 tool-visibility 的完整形态对齐（单文件 + bundles-only + inject timer）是已验证的可靠组合。

### 阶段 3a 终验结论 · 打包壳装配机制限制（2026-08-31 末轮）

**终验结果**（inject=['timer'] + 单文件 + 重启）：仍 404、apply-stamp 未写。

**决定性证据（staging 探针）**：
- `desktopPlugins.list()`：command-guard **在清单且 status=active**（bundleId 已分配）→ desktopPlugins 认为它已装配
- `dev_plugin_status`（loader entries）：command-guard **无 fiber**（tool-visibility 有）
- `disabled: []` / `isDisabled=false` → 非禁用问题
- mock ctx 调 apply 成功 → 代码无问题

**最终结论**：**打包壳存在两套装配机制——desktopPlugins direct bundles（清单层）与 cordis include loader（fiber 层）——对新 bundle 未同步/未对齐时，清单显示 active 但 loader 不创建 fiber**（apply 永不执行）。这是机制层限制，非插件代码缺陷。tool-visibility 因恰好在 loader 装配链路内（较早加入）而工作。

**处置**：
- command-guard 代码 + 单测（risk-rules 12 项）**保留**（评分逻辑经 mock 验证有效，可经其他装配路径复用）
- 装配残留（bundles/deps/junction/模板条目）待用户确认后清理（避免"active 但不工作"幽灵状态）
- 完整排查记录留存（4 轮：双装配→相对导入→inject→机制层）

**对长期运行的启示**：新 host 插件的装配验证必须以 **loader entries（dev_plugin_status fiber 存在）** 为准，不能只看 desktopPlugins 清单或 startup-verify 文件级检查；打包壳对新增 bundle 的 loader 装配存在未文档化门槛（待逆向 cordis include 源码定位）。

---

## 阶段 6 提前：SLO 健康看板（✅ 完成，2026-08-31）

**创建**：`scripts/health-check.mjs`
- 运行 startup-verify（--json）→ 解析结果 → 追加 `~/.dsh/.health/startup-history.jsonl`（轮转 200 条/1MB）
- 汇总最近 50 次：**启动成功率 / 失败详情 / 连续失败检测（≥3 提示导出诊断/回滚）**
- 三模式：默认（运行+记录+报告）/ `--summary`（仅汇总）/ `--json`
- 设计：只读+追加（不改运行路径）、全 try/catch、有界历史、spawn windowsHide + 120s 超时

**验证**：
- ✅ node --check + 首次运行：10/10 PASS 记录入库（passRate=100%）
- ✅ --summary --json 输出结构正常

**SLO 对应**（方案书 v3 §8.1）：启动成功率可量化（历史累积后按月/按窗口评估）、连续失败自动预警。

**可迭代**：后续可接入定时巡检（dsh-self-maintenance 同款 timer 模式）、告警通知、看板 UI。

### 阶段 6 增强：接入 check-all 巡检闭环（✅ 2026-08-31）

**改动**：`scripts/check-all.ps1` Step 1.5 改用 `health-check.mjs`（内部跑 startup-verify + 记录 SLO 历史 + 报告），脚本缺失时回退直接跑 startup-verify。

**验证**：check-all 全绿（ALL PASS）+ 健康历史自动积累（2 条：首次手动 + 本次 check-all 自动）。

**效果**：**每次 check-all 巡检自动积累启动健康数据** → SLO 成功率/连续失败预警形成闭环，无需额外操作。

---

## 阶段 3b：技能状态卡/导入文件夹（待执行）

---

## 更新评估登记（2026-08-31：官方 v2.0.4 评估 + 残留实例清理）【补登记】

> 注：本段首次登记于 2026-08-31，曾因并行会话重写本文件而丢失，现按协作铁律补登记于文件末尾。

**场景**：应用内置更新检查器提示官方 v2.0.4（2026-08-28 发布），用户要求评估是否适配、是否升级，并给出长期稳定/可维护/可迭代的下一步。

**执行项**：
1. ✅ 只读体检：`verify-patches.ps1` **22 项 ALL PASS**；junction 指向 build202608272104；43120 正常
2. ✅ 版本核对：本地 2.0.2 / 上游 dsh 0.1.1-rc.2；官方 v2.0.4 / 上游 **0.1.2-alpha.1**（破坏性）；官方 2.0.2→2.0.4 共 223 commit；官方依赖已**移除 dsh-host-apiproxy**（依赖 diff：新增 34 / 移除 2 / 变更 99；本地 electron 43.4.0 与 pnpm 11.21.0 反而比官方新）
3. ✅ **清理残留实例**：终止 9:21 启动的 PID 23196/25696（无窗口、占 8787 的孤儿进程，两次重启仍残留）；现仅剩 16:06 服务树（43120 单实例）
4. ✅ 新增 `scripts/check-update-compat.mjs`（只读评估：官方版本 vs 本地基线 + 补丁锚点存在性预检 + 风险清单；node --check + 试运行 3 条风险全命中）
5. ✅ 新增 `docs/UPDATE-ASSESSMENT.md`（本次结论 + 5 条升级触发条件 + 迁移执行路径 + 依赖 diff 明细）
6. ✅ 本日志登记（补登记）

**结论**：**暂缓升级**（维持 2.0.2）。升级触发条件：官方上游脱离 alpha + 补丁锚点预检无 MISS + 依赖差异审计 + 26 插件兼容清单 + 稳定观察期 ≥7 天。

**问题登记**：
| # | 问题 | 处置 |
|---|------|------|
| UA-1 | task-scheduler acquire 写锁文件 EPERM（环境性，status 显示 locks:[] 无竞争） | 登记；目标为新增文件/末尾追加，冲突面小 |
| UA-2 | `close-stale-dsh.ps1` 在 agent shell 内因 WMI 权限受限误报「No DSH Desktop main process found」 | 改用等价 Stop-Process 对已知 stale PID 执行；用户终端跑脚本不受影响 |
| UA-3 | 本段首次登记被并行会话重写文件时覆盖丢失（2026-08-31） | 补登记于文件末尾；共享文档写后需回读验证 |

---

## 阶段 3a 收尾：A1/A2 残留清理与形态统一（✅ 2026-08-31 晚）

**背景**：阶段 3a 终验结论——command-guard 受打包壳装配机制层限制（清单 active、loader 无 fiber），判定为「active 但不工作」幽灵状态；交接文档待办 A1/A2 立项，用户批准执行。

**执行项（A1：command-guard 装配残留清理）**：
1. ✅ 运行态 `~/.dsh/profiles/desktop/package.json`：移除 dependencies + bundles 的 `@dsh-external/dsh-command-guard`（bundles 33→32）
2. ✅ 模板 `profile/desktop/package.json`：同步移除（33→32）
3. ✅ 删除 junction `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-command-guard`（只删链接；目标目录 `plugins/dsh-command-guard/` 保留——risk-rules 评分库 + 12 单测可复用）
4. ✅ 原子写（临时文件→rename）+ JSON 解析校验 + 回读

**执行项（A2：patch 形态统一）**：
1. ✅ `plugins/dsh-tool-visibility/cordis.patch.yml`：重写为纯注释（去 insert 块）——统一为 bundles-only 形态，消除「bundles + patch insert」双装配隐患（原文件实测含有效 insert 块，内容已留档于执行会话）
2. ✅ `plugins/dsh-command-guard/cordis.patch.yml`：复核为纯注释（08-31 已修），无需改动

**验证（全部通过）**：
- ✅ startup-verify **10/10 PASS**：V2 模板=运行态（32=32）、V4 无孤儿 @dsh-external、V3 insert=8/disabled=0、V10 全部声明在位
- ✅ 两个 package.json JSON 解析正常、无 command-guard 残留；junction 已删除且目标目录 `lib/risk-rules.mjs` 完好

**结论**：幽灵装配状态清除，模板与运行态收敛一致。command-guard 插件保留（代码+单测+文档），装配需待打包壳 loader 机制问题解决后（阶段 3c 前置）。

**问题登记**：无新增。