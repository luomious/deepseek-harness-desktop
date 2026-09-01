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

---

## 阶段 3a 收尾修正：A2 回归 + 装配机制真相确认（2026-08-31 晚，重启验证后）

**现象**：用户重启后验证——`dev_plugin_status` loader entries **无 dsh-tool-visibility fiber**、`/tool-visibility/status` 404。A1+A2 前（08-31 早）tool-visibility 一直 active 且路由工作。

**取证（决定性）**：扫描全部 21 个插件 `cordis.patch.yml`——**19 个工作插件全部带 `- insert:` 块；仅 command-guard 与 tool-visibility（A2 改后）为纯注释，且恰好都不工作**。

**真相确认（修正 3a 结论）**：
1. **`- insert:` 块是 cordis include loader 创建 fiber 的装配入口**；`desktopPlugins` bundles 清单只是清单层（"active" 状态来自清单，不代表 loader 已装配）。
2. 3a 排查中「tool-visibility patch 乱码吞掉 insert → 碰巧只走 bundles 装配工作正常」**系 PowerShell 5.1 编码显示误读（UTF-8 文件被按 ANSI 读成乱码）**——原文件实际一直是干净 UTF-8 + insert，tool-visibility 一直靠 insert 装配。
3. 3a「bundles + patch insert 双装配冲突」与「机制层限制」结论**不成立或非主因**；command-guard 第一版（带 insert）失败更可能是**相对导入（lib 引用）+ inject=[]** 所致（与 tool-visibility 的「单文件 + inject timer + insert」完整形态对比可知），后续改纯注释后失败是必然（无 insert = 无装配入口）。

**修复（A2 修正）**：
- ✅ `plugins/dsh-tool-visibility/cordis.patch.yml`：**恢复 insert 块**（干净 UTF-8 + insert + 装配说明注释），与 19 个工作插件形态一致。

**修正后的插件装配形态（写死为唯一可靠组合）**：
```
cordis.patch.yml 必须含 - insert:（id/name/config enabled）  ← 装配入口
单文件（无相对导入）                                       ← 避免 loader 解析问题
inject: ['timer']（用 ctx.setTimeout 前）                 ← 惰性依赖先注入
bundles 清单 + dependencies + junction + 模板同步           ← 清单层，必须一致
```

**待验证**：重启后 tool-visibility fiber active + 路由 200（用户执行重启）。

**知识沉淀更新**：本段修正覆盖阶段 3a 终验「机制层限制」结论；HANDOVER §2 教训 1 同步修订。

**问题登记**：无新增（本次为自身回归，已闭环）。

---

## A 组收尾：验证清理 / 契约文档 / SLO 定时巡检（✅ 2026-08-31 晚）

**背景**：阶段 3a 收尾（A1/A2 + 回归修正）后，用户重启验证 tool-visibility 恢复；随后执行 A 组三项低风险收尾（用户批准 A 方案）。

**重启验证（tool-visibility 回归闭环）**：
- ✅ dev_plugin_status：`dsh-tool-visibility` **[active]**（fiber 恢复）
- ✅ `/tool-visibility/status` 200（ok:true、bufferSize、logPath 正常）
- ✅ startup-verify 10/10
- 结论：**insert 是装配入口的认知完整实证**，3a 修正闭环。

**A1：verify-features 过时项清理（P0-1 闭环）**
- 移除 `scripts/verify-features.ps1` endpoint 检查中的 `/vision-rotator`（dsh-vision-rotator 已卸载，该项必 FAIL；stale 清单保留，仍防 registry 残留）
- 验证：**TOTAL 50, FAIL 0 全绿**（此前 49 项 1 FAIL）

**A2：契约文档初版**
- 新建 `docs/plugin-contracts.md`：四类契约 v1——工具调用事件（✅ 已生效：字段/路由/可靠性）、连接器 manifest（📝 草案：等官方升级、不重复造轮子）、技能 frontmatter（📝 部分）、插件服务契约（✅ 已生效：insert 装配入口 + 单文件 + inject timer + 清单层 + dev_plugin_status 验证）

**A3：SLO 定时巡检（脚本就位，注册可选）**
- 新建 `scripts/health-task-run.ps1`：每日 runner（health-check 追加 SLO + check-update-compat 更新提醒，日志 `~/.dsh/.health/task-*.log`）
- 新建 `scripts/install-health-task.ps1`：一键注册计划任务「DSH Health Check」每日 09:05（需管理员权限）
- 实测：runner 手动跑通——SLO 历史 2→3 条 100% PASS；update-compat 结论输出正常
- 说明：注册为可选；不注册时 check-all 已自动积累 SLO

**问题登记**：无新增。

---

## B 专项第一阶段：Client 装配路径只读逆向（✅ 2026-08-31 晚）

**产出**：`docs/CLIENT-ASSEMBLY-FEASIBILITY.md`（可行性报告）。

**核心结论（推翻旧认知）**：
1. **client 装配路径已打通**——内核标准机制：插件 `package.json` 的 `dsh.client` 声明 + `exports["./client"]`；host 侧 `dsh-client-modules` 增量扫描 loader entries → 组合 `window.__DSH_BOOT__` wire → 浏览器 `__ModuleLoader__.load({id, factory})` lazy CJS 物化。**本地已有 10 个插件在用**（file-explorer、skills-manager、ui-performance 等）+ 第三方 dsh-community-market/dshmarket。
2. **「client 装配路径未打通」系旧认知，已过时**——阶段 4/5 的阻塞判断不成立。
3. **`tool.call.toolview` 插槽存在**（dsh-client-ui-tool）：工具专用渲染卡的官方注入点 → 方案书 P3「渲染器 ×20」**无需改 apps/web shell**，走 client 插件 + slot 即可。
4. 方案书剩余展示层功能可行性全面翻新：工具流式展示 ✅、技能状态卡/导入文件夹 ✅、集成面板 ✅、渲染器 ✅（chain 条件注册）、Mention ❓（待验证输入框 slot）。

**门槛**：client bundle 需 tsdown 构建（缺失 → MissingClientBundleError 启动报错）；新增 client 插件仍须重启 + dev_plugin_status 验证；装配纪律（insert + bundles + 模板同步）不变。

**建议落地顺序**：① 工具流式 client 卡片（数据层已就绪）→ ② 3b 技能状态卡/导入文件夹 → ③ 集成面板 → ④ 渲染器按需注册。

**问题登记**：无新增（纯只读，零风险）。

---

## B 专项第二阶段第一版：tool-visibility client 展示层（✅ 代码就位，待重启生效）

**目标**：P2-A-0 展示层第一版——设置页「工具调用可见性」实时面板（最近工具调用：name/status/耗时/参数摘要，2s 轮询 `/tool-visibility/recent`）。

**实现（低风险设计）**：
1. 新建 `plugins/dsh-tool-visibility/lib/client.js`：`__ModuleLoader__.load` + `require("react")` + `slots.inject("settings.section")` 注册面板（模式复制 dsh-skills-manager，已验证）；CSS 用 --dsw-alias-* 变量；轮询失败静默降级（面板内显示错误，不影响会话区）
2. `package.json`：v0.1.0→0.1.1；加 `exports["./client"]` + `dsh.client: { platform: "web", inject: [client-runtime, client-ui-settings] }`
3. **profile/bundles/junction 零改动**——tool-visibility 已在 loader 链路，client 部分重启后由 dsh-client-modules 自动扫描组合
4. 备份：`_backups/tool-visibility-package.json.bak-20260831`

**验证（文件级）**：client.js `node --check` OK；package.json JSON 合法；startup-verify **10/10**。

**待重启验证**：① dev_plugin_status 正常（host fiber 仍在 + client 装配无报错）；② 设置页出现「工具调用可见性」面板；③ 面板显示 recent 数据（status/durationMs/argsSummary）。

**回滚**：删 lib/client.js + 还原 package.json（备份在 _backups）或 git revert → 重启即回滚。

**风险收益**：低风险——host 逻辑零改动、不碰运行链路、不碰会话区渲染；最坏 = 设置页少一节，不影响任何功能。收益 = P2-A-0 展示层第一版落地。

---

## 阶段 3b（第一版）：skills-manager 导入文件夹 + 技能状态卡增强（✅ 代码就位，待重启生效）

**背景**：方案书 v3 P2-A-1。skills-manager 为并行会话维护插件（v0.2.0 市场功能），按协作铁律加锁（task-scheduler `tk-mth6q2im`，resources=plugins/dsh-skills-manager）。

**实现（低风险新增，不动现有 API/面板逻辑）**：
1. **host**：`lib/index.js` 新增 `importFolder` API——`find -maxdepth 2 -name SKILL.md` 扫描文件夹（含一层子目录）→ `cat` 原样读取（**不重写 frontmatter，保留 triggers 等字段**）→ frontmatter name 解析（回退目录名，kebab-case 校验）→ 复制到 `~/.dsh/skills/<name>/SKILL.md`；跳过已存在同名；返回 `{imported, skipped, errors}`；沿用现有 shell+fullPolicy+settle 模式
2. **client**：`lib/client.js` 用户 tab 新增「导入文件夹」输入框 + 按钮 + 结果提示（新增/跳过/失败明细）；技能状态卡原有 name/source/provider/启用/禁用/模型可调用徽章保持，作为状态卡基础
3. **无删除/无重写操作**，导入只写用户 skills 根目录内（越界天然受限）

**验证（文件级）**：index.js + client.js `node --check` OK；startup-verify **10/10**；v0.2.0 市场测试未触碰（tests/ 未改）。

**待重启验证**：设置页 Skills 管理器 → 用户 tab → 输入含 SKILL.md 的文件夹路径 → 导入后列表出现新 skill（可启用/编辑/删除）。

**回滚**：`git revert` 本 commit → 重启即回滚（host+client 双回滚）。

**风险收益**：低风险——新增 API 与新增 UI 区块，不触碰现有 method 与面板逻辑；原样复制技能文件（不重写、不删除）；最坏 = 导入失败返回错误提示。收益 = 批量安装技能（方案书「一键安装 ≤3 步」目标的本地化第一步）。

### 3b 修复记录：importFolder 跨平台化（2026-08-31 晚，commit a68072c）

**现象**：首版 importFolder 实测报「无法读取文件夹（exit 1）」。

**根因**：`ctx.shell` 在 Windows 为 **pwsh 后端（dsh-pwsh-local，`pwsh -Command` 直通，无 POSIX 翻译层）**——`find`/`cat` 不存在；而既有代码（create/delete 的 mkdir -p / rm -rf）恰好被 pwsh 的别名层容忍（mkdir→New-Item 忽略 -p/--；rm→Remove-Item 接受 -r -f），**printf（detectUserRoot 回退路径）与 find 不可用**。

**修复**：importFolder 遍历/读取/建目录改用 **node:fs**（statSync/readdirSync/readFileSync/mkdirSync）——跨平台且不依赖 shell 后端；写入仍走 `ctx.fs.writeText(…fullPolicy)`。顶部新增 `import fs/path from "node:*"`。

**验证**：`node --check` OK + 逻辑等价测试（扫描 E:/WorkBuddy/_skill-import-test → 发现 echo-greet/SKILL.md、name 解析正确）。

**附注（疑似问题登记，未擅自修）**：
1. `detectUserRoot` 的 printf 回退在 Windows 不可用——但主路径（resourcePath 推断）当前工作，仅在无 user-dsh skill 时触发；如遇「无法定位用户 skills 根目录」再修。
2. `delete` 的 `rm -rf --` 在 pwsh 下 `--` 可能被当作路径参数——有越界防护兜底，暂未验证；后续可复核。
3. 平台经验沉淀：**DSH 插件在 Windows 的 shell 命令必须用 PowerShell 语法或 node:fs，POSIX 命令（find/printf/cat）不可用**——写入 HANDOVER 教训。

---

## 阶段 3a 翻案：command-guard 重试装配（✅ 终验通过，2026-08-31 晚）

**背景**：3a 曾判定「机制层限制」搁置；「阶段 3a 收尾修正」段已推翻该结论（insert 是装配入口）。本次按新认知重试——**三处关键修正 vs 3a 失败版**：
1. `cordis.patch.yml`：纯注释 → **含 `- insert:` 块**（id/name/config enabled）——装配入口
2. 模块形态：单文件 `lib/index.js`（无相对导入，评分逻辑内嵌）+ `inject: ['timer']`（108 行）——与 tool-visibility 完全一致
3. 装配：A1 清理的条目全部加回——运行时+模板 dependencies/bundles（32→33）+ junction 重建（fs.symlinkSync junction）

**执行（加锁 tk-mthfw5ur，备份 _backups/command-guard-patch.yml.bak-20260831 等 3 份）**：
- ✅ patch 重写为 insert 形态（干净 UTF-8）
- ✅ 运行时+模板 package.json：dep+bundle 加回（原子写，33 项）
- ✅ junction 重建（LinkType=Junction → plugins/dsh-command-guard）

**验证（文件级）**：JSON 解析 + 回读 OK；junction 在位；index.js `node --check` OK；startup-verify **10/10**（V2 33=33、V4 无孤儿、V10 patch 声明在位）。

**待重启终验（三信号，同 tool-visibility 标准）**：① dev_plugin_status loader entries 有 command-guard fiber；② `/command-guard/status` 200；③ 触发含危险字符串命令 → `/command-guard/alerts` 出现 + JSONL 落盘 `~/.dsh/command-guard/alerts.jsonl`。

**回滚**：git revert 本 commit + 删 junction + 还原 package.json（备份在 _backups）→ 重启即回滚。

**风险收益**：中低风险——改动面 = patch + 装配清单 + junction（全可逆）；v1 只读观察者不拦截不干预；最坏 = 无 fiber（再清理）。收益 = 若终验通过，P2-A-5 命令风险可见性转正，3a 遗憾闭环。

**终验通过（2026-08-31 晚，用户重启后）**：
- ✅ `dev_plugin_status`：`dsh-command-guard` **[active]**（fiber 存在）
- ✅ `/command-guard/status`：HTTP 200，`{"ok":true,"alertCount":0,"lastAlertAt":null}`
- ✅ `/command-guard/alerts`：HTTP 200，`{"alerts":[]}`
- 结论：**3a 遗憾闭环，P2-A-5 命令风险可见性正式转正**。insert + 单文件 + inject timer 形态第三次实证可靠。

**问题登记**：无新增。

---

## command-guard v2：approval 拦截（✅ 代码就位，待重启生效，2026-08-31 晚）

**目标**：高危 shell 命令执行前弹确认（approve/reject），安全防线闭合（方案书 P2-A-5 完整交付）。

**实现**：
- 注册 `tools/pre-execute` waterfall handler（内核标准机制，`dsh-sandbox`/`dsh-tool-bash` 已用此模式）
- 流程：shell 工具执行前 → `extractCommand(exec.arguments)` → `scoreCommand` → high/medium → `ctx.approval.request({agent, toolName, callId, reason})` → approval 弹窗
- fail-closed：无 approval 服务 = 拒绝；approval policy "never" = 拒绝；approval 异常 = 拒绝
- inject 加 `'approval'`（`ctx.get('approval')` 拿 ApprovalService）
- v1 审计监听器保留（session/event 记录高危命令到 alerts/JSONL，无论 approval 结果）

**验证（文件级）**：index.js `node --check` OK；startup-verify **10/10**

**待重启验证**：重启后触发一条高危命令（如 `rm -rf /tmp/test-dummy`）→ 应弹 approval 确认框 → 拒绝后命令不执行、alerts 有记录

**回滚**：git revert → 重启即回滚（v1 审计保留，只移除 waterfall handler）

**风险收益**：中风险——在工具执行路径加拦截（`tools/pre-execute` waterfall），但这是内核标准机制；fail-closed 保障。收益 = 安全防线闭合，方案书 P2-A-5 完整交付。

---

## 上下文用量提示（WorkBuddy #6 / 方案书 v3）（✅ 代码就位，待重启生效，2026-09-01）

**目标**：设置页「上下文用量」实时面板——显示当前模型、上下文窗口、表面 token 用量百分比（2s 轮询），防止对话突然截断。

**实现**：
1. **新建 `plugins/dsh-context-usage/`**：独立插件（host + client 双面）
   - **host**（`lib/index.js`）：注册 `/context-usage/status` 路由——读模型配置（`~/.dsh/config/desktop.json`）获取 contextWindow + 调用 `tokenMeter.measure(session)` 获取 surfaceTokens → 返回 `{modelName, contextWindow, surfaceTokens, pressureTokens, percentage}`
   - **client**（`lib/client.js`）：设置页 `settings.section` 面板——进度条（绿<60% / 黄<85% / 红≥85%）+ 模型名 + surface/window 数值；2s 轮询 host 路由
2. **装配**：profile dependencies + bundles（32→33）+ junction + cordis.patch.yml insert
3. **已知限制**：`tokenMeter.measure(session)` 需要 session 对象，host 路由里 `ctx.get("session")` 可能返回 undefined（无活跃会话时 surfaceTokens=0）；后续可接入 `sessionProjections` 的 `contextPressure` 投影获取更精确数据

**验证（文件级）**：index.js + client.js `node --check` OK；junction 重建后 startup-verify **10/10**（V2 33=33）

**待重启验证**：设置页出现「上下文用量」面板；进度条显示百分比；发起对话后数值更新

**回滚**：删插件目录 + 还原 package.json + 删 junction → 重启即回滚

**风险收益**：低风险——新插件独立，不碰现有逻辑；最坏 = 设置页少一节。收益 = 每次对话实时看到上下文使用情况，防截断（方案书 #6 达标）。

---

## 上下文用量插件回滚（2026-09-01，用户确认功能已存在）

**原因**：用户重启后发现设置页「上下文用量」面板报错，且 DSH 已有上下文用量功能（轨迹栏旁边已有内置展示）——该插件冗余且报错，用户要求删除清理。

**清理清单（全部已执行）**：
1. ✅ 运行态 `~/.dsh/profiles/desktop/package.json`：移除 `@dsh-external/dsh-context-usage` 的 dependencies + bundles（33→32）
2. ✅ 模板 `profile/desktop/package.json`：同步移除（33→32）
3. ✅ 删除 junction `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-context-usage`
4. ✅ 删除 `plugins/dsh-context-usage/` 整个目录（回收站）

**验证**：startup-verify **10/10**（V2 32=32、V4 无孤儿）

**教训**：开发新插件前应先确认 DSH 内核是否已有等价功能（dev_plugin_status + UI 全景扫描），避免重复造轮子。

---

## 提示词增强（WorkBuddy #1 / 方案书 v3）（✅ 代码就位，待重启生效，2026-09-01）

**目标**：输入框「增强」按钮——一键将用户输入改写为更精确的提示词（DeepSeek API）。

**阶段 A 审计确认**：DSH 内核**无**增强提示词功能（grep ui-input-trigger 无 enhance/boost/rewrite 按钮）——确认不重复造轮子。

**实现**：
1. **新建 `plugins/dsh-prompt-enhance/`**：独立插件（host + client 双面）
   - **host**（`lib/index.js`）：注册 `POST /prompt-enhance/run` 路由——读 `~/.dsh/.credentials.yaml` 获取 `DEEPSEEK_API_KEY` → DeepSeek chat API（deepseek-chat 模型，temperature 0.3）→ 返回增强后文本
   - **client**（`lib/client.js`）：设置页 `settings.section`「提示词增强」面板——textarea 输入 + 增强按钮 + 结果展示 + 复制按钮
   - API key 来源：`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` 行（简单 key-value 解析，无需 YAML 库）
2. **装配**：profile deps+bundles（32→33）+ junction + cordis.patch.yml insert
3. **验证（文件级）**：index.js + client.js `node --check` OK；startup-verify **10/10**

**待重启验证**：设置页出现「提示词增强」面板；输入文本 → 增强 → 结果显示。

**风险收益**：低风险——新插件独立，最坏 = 设置页少一节；host 路由仅读 credentials + 调 DeepSeek API。收益 = 提示词一键优化，开发效率提升。

**回滚**：删插件目录 + 还原 package.json + 删 junction → 重启即回滚。

---

## prompt-enhance 工具化重构（2026-09-01，用户要求"agent 自动判断使用"）

**用户需求**：提示词增强对开发有提升可保留，但**不要放设置面板**，改为 **agent 自动判断何时调用**。

**改动**：
1. `lib/index.js`：改用 `ctx.tools.register(defineTool(...))` 注册 `prompt_enhance` 工具（`inject: ['tools']`）；工具 description 写明判断逻辑（含糊/缺约束/需重述为可执行任务/委派子代理时调用；请求已清晰时不调用）；execute 调 DeepSeek API 返回增强文本
2. **删除** `lib/client.js`（设置面板）
3. `package.json`：移除 `exports["./client"]` + `dsh.client` 声明（防 MissingClientBundleError）
4. 验证：index.js `node --check` OK；startup-verify **10/10**（V1 33 bundles resolvable）

**待重启验证**：dev_plugin_status 显示 prompt-enhance active + agent 工具集中出现 `prompt_enhance`。

**风险收益**：低风险——仅改自身插件（工具注册替代面板），不碰其他；工具注册增加极小模型上下文开销（一个工具 schema）。收益 = 提示词增强从手动按钮升级为 agent 自动判断调用，贴合开发场景。

**回滚**：git revert → 重启即回滚。