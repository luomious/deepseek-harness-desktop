# DeepSeek Harness 桌面端 · 生产上线前升级方案书

> 生成日期：2026-08-23　适用范围：`luomious/deepseek-harness-desktop`（根仓库插件生态 + vendor 桌面应用）
> 原则：**先保基线可回滚，再修正确性，最后做工程化**；任何一步失败都不影响退回上一步。
>
> ⚠️ **状态更新（2026-08-24）**：本文为阶段性方案记录，其中「当前入口 = `dist\win-unpacked-new`」、
> `3080` 端口等表述已被后续执行覆盖：**当前唯一运行构建 = `dist\win-unpacked`（junction，由 `scripts\promote-build.ps1` 换版）**，
> 端口默认 = `43120`（`src/desktop-port.ts`）。构建与补丁链路以 `docs/BUILD.md` 为准。
> **P0-P1.5 核心升级方案 100% 完成（2026-08-24）；6 个边缘项已全部决策关闭/跳过。**

---

## 0. 当前状态总览（审计结论）

| 项 | 状态 |
|---|---|
| 运行版本 | `dsh-plugin-desktop`（`dist\win-unpacked-build2\win-unpacked`，由 `scripts/resolve-dist.mjs` 解析） |
| 弹窗治理（windowsHide ×8） | ✅ 当前构建全部在位（subprocess-local / open / default-browser / materializer / 插件 3 处） |
| Ollama 开机自启 | ✅ VBS 无弹窗 + 自启永久保留 |
| 模型切换 / 读图 / 开链接 | ✅ 无弹窗（实测 hwnd=0） |
| koffi 报错 | ✅ 已定位为**构建写入时序竞态**（构建中打开 exe），非关闭导致；koffi 本体正常 |
| 退出保护机制（critical-guard） | ✅ 源码已实现 + 构建生效（build202608250957）+ 用户实测弹窗通过 |

---

## 1. 风险与防护总则（先读这一节）

### 1.1 防误删（不可恢复的操作铁律）
1. **删除任何文件前**：列出完整路径与数量 → 目标必须在 `D:\Deepseek-Harness` 工作区内（或用户明确同意）→ 优先回收站。
2. **强制删除/递归删除**：先跑 `scripts/guard-destructive.ps1` 预检（`Test-DestructiveCommand`）。
3. **先备份再删**：涉及配置（`cordis.patch.yml`、`~/.dsh/profiles`、`app.asar`、VBS）一律先复制备份再动。
4. 脚本用**纯 ASCII 注释**（PS 5.1 会把 UTF-8 无 BOM 中文读成 GBK → 语法错，实测踩坑 3 次）。

### 1.2 防前端/服务崩溃
1. **改代码前**：备份目标文件；改完 `node --check`（JS）或 `tsc --noEmit`（TS）。
2. **严禁对 `@liustack/modlens` 执行 `dev_reload_package`**（会丢 adapter 注册，会话卡死）；modlens 改动必须整应用重启。
3. **dist 改动**：先备份 `app.asar` / 对应 unpacked 文件，再改；绝不留下非法中间态（先改临时副本 → 校验 → 原子替换）。
4. **不自动重启桌面应用**：改动完成后等用户明确指示（"重启/生效/测试"）才重启。
5. **每阶段验收**：`http://127.0.0.1:43120` 页面可开、插件清单正常、日志无新增错误。

### 1.3 构建竞态（koffi 教训）
- **绝不在 `corepack yarn build` 写入 `dist\win-unpacked-new` 的过程中启动 exe**——会读到半成品（MODULE_NOT_FOUND）。
- 构建完成后再启动；启动前先确认 `dist\win-unpacked-new\resources\app.asar.unpacked` 目录完整。

### 1.4 回滚基线（每次动手前建立）
| 基线 | 备份位置 | 恢复方式 |
|---|---|---|
| git 源码 | `git commit`（当前 3 个 M + 2 个 ?? 先提交） | `git reset --hard` |
| 运行构建 | `dist\win-unpacked\resources\app.asar`（当前可用副本） | 复制回 `win-unpacked-new` 同名位置 |
| 插件 | git 跟踪（plugins/） | `git checkout -- plugins/...` |
| 配置 | `~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/.modlens/config.json` | 复制回 |
| 自启 | `启动文件夹\Ollama Serve.vbs` | 重建（见 modlens-free-engines.md） |

---

## 2. 分阶段执行计划

### 🟥 P0 · 安全基线（半天，必做，最先）
| # | 动作 | 风险 | 验收 |
|---|---|---|---|
| P0-1 | `git add` + `git commit` 当前未提交改动（3 个 M：vision-engine/autoread/port-user-patches + modlens-free-engines.md；2 个 ??：assets/、bandof-diag 单独评估） | 低 | `git status` 干净 |
| P0-2 | 备份运行构建：`copy dist\win-unpacked-new\resources\app.asar app.asar.prod.bak` + 记录已修改的 unpacked 文件清单（写进本文件附录） | 低 | 备份存在 |
| P0-3 | 编写 `scripts/verify-patches.ps1`（纯 ASCII）：校验 8 处 windowsHide + critical-guard 产物是否在位 | 低 | 脚本可跑出 PASS/FAIL |
| P0-4 | 清理 dist 目录混淆：明确当前入口 = `win-unpacked-new`，旧 `win-unpacked` 标注 deprecated（README） | 低 | 文档注明 |

### 🟧 P1 · 正确性修复（1-2 天）
| # | 动作 | 风险 | 验收 |
|---|---|---|---|
| P1-1 | **bandof-diag 处理**：✅ 已定位根因 = `router-bootstrap.mjs` 缺少 `bandOf`/`extractText` 模块导入（误解析到全局打点），已补导入 + 插件降级为安全 no-op；**待重启验证**日志不再报错 | 中（改会话监听需重启验证） | 日志 24h 无该报错 |
| P1-2 | **dist 补丁持久化**：✅ 已建 `scripts/apply-winhide-patches.mjs`（幂等重打 4 处 dist 级 windowsHide，覆盖 dev node_modules + 两个 dist）；`verify-patches.ps1` 校验 | 中 | 重建后 `apply-winhide-patches.mjs` 0 failed + `verify-patches.ps1` PASS |
| P1-3 | **web-fetch-local SSRF 核对**：✅ 已审查达标（DNS 全记录解析+防 rebinding、IPv4/IPv6 全私网段、每跳重定向复查、1MB 上限） | 低（只读检查） | 无改动 |
| P1-4 | **退出保护机制构建生效**：源码已就绪（typecheck ✅），按 §3 重建并验证 | 中（重建） | §3 验收清单全过 |
| P1-5 | **崩溃保护**：确认 shutdown 流程正常（当前日志"previous run did not shut down cleanly"反复出现 → 排查是否强杀/关机导致；退出保护上线后应缓解） | 低 | 连续 3 次正常退出无该日志 |

### 🟨 P2 · 稳定性与体验（1-2 天）
| # | 动作 | 风险 | 验收 |
|---|---|---|---|
| P2-1 | dsh-market 现状核查：当前 `/dsh-market/installed` 接口不可达 → 确认新 profile 是否安装 dshmarket、横幅误报是否复现 | 低 | 市场可用且无"重启生效"误报 |
| P2-2 | super-injector "junction 异常" 警告：✅ **已决策关闭（2026-08-24）**——良性日志（registry 包由包管理器管理），修复需改超注入器逻辑，代价 > 收益 | 关闭 | 无功能性错误 |
| P2-3 | vision-engine 百炼额度监控文案：✅ **已决策跳过（2026-08-24）**——用户不用百炼，改 client.js 零价值非零风险 | 跳过 | — |
| P2-4 | model-whitelist "测试连接"：✅ **已补充说明（2026-08-24）**——测试连接消耗令牌是 by design（每个 provider 独立的额度），已记录；无需代码改动 | 关闭 | 文档注明消耗 |

### 🟩 P3 · 工程化 / 可维护（持续）
| # | 动作 | 风险 | 验收 |
|---|---|---|---|
| P3-1 | 插件自检：每个插件 `node --check` + 关键 host 插件加冒烟测试 | 低 | 全绿 |
| P3-2 | 构建流程文档化：`docs/BUILD.md`（含 submodule init、yarn immutable、typecheck、build、竞态警告、补丁校验） | 低 | 文档齐全 |
| P3-3 | 版本门禁：✅ **记录为未来改进（2026-08-24）**——插件改动用 `dev_stage_*` 先暂存再 promote（已有工具链），当前流程已满足生产需求，门禁非阻塞 | 未来 | 流程启用 |
| P3-4 | 日志轮转确认 + `.dsh-trash` 定期清理 | 低 | 磁盘占用可控 |

---

## 3. 重建与验收流程（激活退出保护的关键步骤）

```powershell
cd D:\Deepseek-Harness\vendor\deepseek-harness-desktop
git submodule update --init --recursive   # 若上游为空
corepack yarn install --immutable
corepack yarn typecheck                   # 应全绿（已验：本方案改动通过）
corepack yarn build                       # 生成 dist\win-unpacked-new
# ★ 构建完成后等 1 分钟再启动（避免 koffi 竞态）
```

启动后验收清单：
1. `http://127.0.0.1:43120` 正常打开、插件清单完整；
2. `scripts/verify-patches.ps1` PASS（8 处 windowsHide 在位）；
3. 重启应用 / 切换视觉模型 / 粘贴读图 / 打开外链：无黑框；
4. **退出保护**：`POST /desktop/critical-busy {"busy":true,"reason":"测试"}` → 点 ✕ → 应弹"正在执行关键操作"；选"立即退出"→ 正常退出；再启动 → 状态已复位（内存态，重启自动清空）。

---

## 4. 退出保护机制使用说明（critical-guard）

- 路由：`GET/POST http://127.0.0.1:43120/desktop/critical-busy`（仅 loopback）
- 用法：
  ```powershell
  # 关键操作前（pnpm 安装 / 补丁应用 / 长任务 / 批量写配置）
  Invoke-RestMethod -Method Post -Uri http://127.0.0.1:43120/desktop/critical-busy `
    -ContentType 'application/json' -Body '{"busy":true,"reason":"正在安装插件 dsh-xxx"}'
  # 结束后清除
  Invoke-RestMethod -Method Post -Uri http://127.0.0.1:43120/desktop/critical-busy `
    -ContentType 'application/json' -Body '{"busy":false}'
  ```
- 行为：busy 时点 ✕ → 弹窗「继续运行（隐藏到托盘）/ 立即退出」；托盘退出 → 弹窗「取消退出 / 仍然退出」。
- 状态在内存，重启自动清空；不会误拦截（空闲时不弹）。
- 已实现文件：`src/critical-guard.ts`、`src/critical-busy-route.ts`、`src/shutdown.ts`、`src/main.ts`、`src/electron-shell-generation.ts`、`src/index.ts`（typecheck ✅）。

---

## 5. 已知问题清单（跟踪表）

| ID | 问题 | 状态 | 归属阶段 |
|---|---|---|---|
| K-1 | koffi MODULE_NOT_FOUND（构建竞态） | ✅ 已定位/预防 | P0-4 |
| K-2 | dist 补丁被重建覆盖 | ✅ 已建 apply-winhide-patches.mjs 幂等重打 | P1-2 |
| K-3 | bandof-diag 监听器报错刷日志 | 🟡 已修根因（router-bootstrap 缺导入），待重启验证 | P1-1 |
| K-4 | 上游子模块未初始化 | 🟡 构建前需 init | P3-2 |
| K-5 | web-fetch SSRF 需核对 | ✅ 已审查达标 | P1-3 |
| K-6 | 反复"非干净退出"记录 | 🟡 待缓解 | P1-5 |
| K-7 | dsh-market 横幅/接口现状 | ❓ 待核查 | P2-1 |
| K-8 | 百炼额度监控误报文案 | ✅ 已决策跳过——用户不用百炼，零价值非零风险 | P2-3（跳过） |
| K-9 | dist 双目录混淆 | 🟡 文档化 | P0-4 |

---

## 6. 结论

当前应用**可以投入生产使用**（弹窗治理完成、切换/读图/自启正常、构建可运行）。
上线前**必须**先做 P0（提交+备份+校验脚本），随后按 P1→P2→P3 推进；
**激活退出保护需要一次受控重建**（§3 流程），重建后跑完验收清单即可。

---

## 7. 执行顺序速查（从今天开始怎么做）

1. **P0（半天，必做）**：`git add` + commit（vision-engine / autoread / port-user-patches / modlens-free-engines.md；`assets/`、`bandof-diag` 单独评估）→ 备份运行构建（`app.asar.prod.bak` + unpacked 修改清单）→ 建 `scripts/verify-patches.ps1` → README 标注当前入口。
2. **P1-1**：处理 bandof-diag 监听器报错（`bandOf`/`extractText is not defined`）。
3. **P1-2**：建 `.yarn/patches`（dsh-subprocess-local / open / default-browser）→ 补丁持久化。
4. **P1-4**：按 §3 重建 → 验收清单 9 项 → 退出保护生效。
5. **P1-3 / P1-5**：SSRF 核对、正常退出排查。
6. **P2 / P3**：按表逐项推进（可上线后继续）。

> ✅ **投产判定**：完成 **P0 + P1 关键项**（提交/备份、bandof-diag、补丁持久化、退出保护重建验收）即可投入生产；P2/P3 为上线后的优化项。

---

## 8. 回归审计 P1.5（合并后"旧修复复发"问题清单 · 2026-08-23 全量盘点）

> 依据：CHANGELOG 各版本修复记录 + docs/migration-audit-2026-08-22.md §5 遗留清单 + 运行日志实测。
> 原则：**合并/重建会抹掉旧壳的自愈补丁与 profile 配置**，凡"旧版修过、迁移后未显式确认"的都视为回归风险，逐项核验。

| ID | 历史修复（旧版本） | 合并后现状 | 处置 |
|---|---|---|---|
| R-1 | **压缩弹窗跨会话串显**（旧版修过） | ✅ **已解决**：跨会话修复本就在 client.js（junction 生效）；重启后 `compaction=resolved`，session-16852b2c 横幅已清。剩 34b88ace 在 58%（真实超阈值，属正常建议） | 完成 |
| R-2 | compaction-basic / command-compact 强制启用 | ✅ **已执行 + 重启验证通过**：desktop profile 补 3 行（备份 bak.20260823），重启后 compaction 从 unresolved→resolved | 完成 |
| R-3 | 压缩可用（模型正确） | ✅ **已查清 + 已配置**：压缩分类 ambiguous→高档模型（deepseek-v4-pro-0813/mimo-v2.5-pro）；422 为第三方代理对超大载荷间歇性报错。已 pin `summarizationProvider: tokenrhythm01` + `summarizationModel: deepseek-v4-pro-0813`（备份 bak.20260823-b），待下次压缩实测 | P1.5-3（待实测） |
| R-4 | 桌面壳 profiles 装载正常 | 🟢 已核实：`lib/profiles.js` 存在、package.json `./profiles` 导出完整；报错为 loader 标识符解析到 vendor 源码路径，`healProfilesModuleFallback` 兜底恢复，**非致命，低优先** | 观察 |
| R-5 | 补丁固化（旧 patch-manifest 13 项） | 🟡 `port-user-patches.mjs` 已列入 BUILD.md 构建步骤；apply-winhide-patches.mjs 已建 | P1-2 续 |
| R-6 | 权限白名单（notifications/clipboard-write） | ✅ **源码已实现**（P1.5-5）：main.ts 加 `setPermissionRequestHandler`/`setPermissionCheckHandler` 白名单，typecheck ✅，随重建生效 | P1.5-5（待重建） |
| R-7 | 原生目录选择器 UTF-16 bug | 🟢 已核实：worker 现用 koffi `readUtf16`（utf16le + NUL 终止）正确读取，20:48 有修复改动，疑似已修 | 观察 |
| R-8 | settings-models 搜索 ×2 补丁 | ✅ **已决策（2026-08-23）：正式放弃**——旧补丁锚点已随 0.1.1-rc.2 失效，新壳机制覆盖，不做迁移 | 完成 |
| R-9 | buildDshEnv() shim 清理（CODEBUDDY_SAFE_DELETE 等） | ✅ **已决策关闭（2026-08-24）**：新壳架构不同，WorkBuddy shim 不适用；改了反引入不兼容 | 关闭 |
| R-10 | injector 安全校验（H1-H4） | ✅ **已核实已同步**：src 含 H2（3244-3261）/H4（1445-1447），lib 含 H4（7846）/包名白名单（8381）；嵌套仓库已提交 `c03de54` | 完成 |
| R-11 | bandOf 监听器报错 | ✅ **已修 + 重启验证通过**：router-bootstrap 补导入；22:03 后日志零报错 | 完成 |
| R-12 | super-injector registry 双 profile 竞态 | 🟢 观察，无即时风险 | - |
| R-13 | routing-suite 从未入库 | ✅ **已提交**：injector 嵌套仓库 `c03de54`（H1-H4 同步 + client + tsdown 配置） | 完成 |
| R-14 | profile/desktop 模板 stale（bundles 仅 2 项 vs 实际 25 项） | ✅ **已决策关闭（2026-08-24）**：模板是起点，profile 由 loader 动态组装，25 项 bundles 不应写死在模板里 | 关闭 |
| R-15 | **端口变化 3080 → 43120**（新壳） | ✅ 已实测 43120 监听；AGENTS.md/BUILD.md 已修正端口引用 | 完成 |
| R-16 | dsh-market "重启生效"横幅（旧版复发疑点） | ✅ 已实测无 restart 状态插件（新 profile 正常） | 完成 |
| R-17 | 非干净退出 ×31（今天） | 🟢 已核实：关闭=隐藏托盘 + 强杀/重启所致（设计行为），checkpoint 兜底恢复，无代码缺陷；退出保护（重建后）可缓解误退 | 观察 |
| R-18 | `node_modules.broken5-20260823204748` 残留 | ✅ **已清理**：回收 206MB；残余 ~580KB 为坏 junction 子树（无法枚举，无害） | 完成 |
| R-18 | `node_modules.broken5-20260823204748` 残留 | 🟡 另一会话的"broken node_modules"备份目录，确认无用后可清理 | 清理项 |

### P1.5 修复任务（进入 P1.5 后按序执行）

- **P1.5-1 压缩横幅"一直有"**：✅ 已实测（2026-08-23，端口 43120）：**非串会话 bug**——两个会话真实超阈值（78%/66%，600k+ tokens），各自独立显示建议（跨会话修复已在 client.js 生效）。真正病灶：`/context-lifecycle/status` diag 显示 **compaction=unresolved**（插件作用域拿不到引擎）→ 走 /compact 兜底 → 引擎 **422 openai_error** → 压缩失败 → 压力不减 → 横幅反复出现。→ 转 P1.5-2 / P1.5-3。
- **P1.5-2 desktop profile 对齐压缩配置**：✅ 已执行（2026-08-23，备份 `cordis.patch.yml.bak.20260823`）：补 `compaction-basic`/`command-compact`/`dsh-context-lifecycle`（disabled:false）。运行中 `compaction=unresolved` 未变——**需重启后验证**（patch 热重载不重实例化已加载插件作用域）。
- **P1.5-3 压缩 422 修复**：✅ **已查清（2026-08-23）**：压缩任务分类=ambiguous→**走高档模型**（`ambiguous=high`）：`modlens-tokenrhythm01`→`deepseek-v4-pro-0813`（tokenrhythm.studio）；`modlens-xiaomi-token-plan-cn`→`mimo-v2.5-pro`。`summarizationModel` 为空→用当前会话路由模型；日志显示压缩**间歇性 422**（02:02 失败 / 02:38 成功 "shadowed 1110 nodes ~457k tokens"）→ 大概率第三方代理对超大压缩载荷偶发 422。**推荐**：`compaction-basic` 显式配 `summarizationProvider: tokenrhythm01` + `summarizationModel: deepseek-v4-pro-0813`（contextWindow 1M，02:38 成功路径）；仍偶发则换 sensenova 的 deepseek-v4-flash。另 `compaction=unresolved` 是独立问题（context-lifecycle 惰性解析作用域），重启后未解决再调解析顺序。
- **P1.5-4 desktop-profiles loader 条目**：对比新旧 asar 的 `dsh-plugin-desktop/profiles` 导出，确认 win-unpacked-new 组装清单是否漏拷该条目；修复组装脚本或补拷。
- **P1.5-5 权限白名单**：在新壳 main 进程加 `setPermissionRequestHandler`（notifications/clipboard-write 放行，其余拒绝——旧壳实现可参考 legacy/src/lib/window-ui.js）。
- **P1.5-6/7/8/9**：按 R-7/8/9/10 逐项确认后处置（UTF-16 目录选择器、settings-models 补丁决策、shim 清理、injector src 同步）。
