# DSH 深度优化总计划 v2 · 三轨并行（U 升级主线 / B 地基治理 / A 架构深化）

> 日期：2026-09-27 ｜ 版本：**v2（在 v1 基础上重写）**
> 目标锚点（用户硬约束）：**长期运行不出现问题 · 可维护性 · 可迭代性 · 可扩展性 · 每一步确定有提升**
> v1 备份：`_backups/master-plan-v1-20260927-203505/PLAN-v1.md`（19,806 B，sha256 `99019876…f4ad0d`，与原件逐字节一致）
> 关联材料（全部为既有产出，v2 未新增未验证结论）：
> - `outputs/2026-09-27-upgrade-impact-0.1.7-rc.2/REPORT.md`（P0-7：23 项补丁 A/B/C 清单 + 升级 10 步）
> - `outputs/2026-09-27-upgrade-0.1.7-preflight/REPORT.md`（未决点闭环 / B5 下修 / C10 方案 / loader 1.0.5）
> - `outputs/2026-09-27-upgrade-0.1.7-adaptation/PLAN.md`（G1–G5 适配方案 + 实施结果）
> - `outputs/2026-09-26-threeway-official-quwork-ours/AUDIT-AND-PLAN.md`（十二维度 + T1–T9 + 43 插件/28 补丁/62 技能裁决 + P0–P4 共 30 项）
> - `outputs/2026-09-26-threeway-official-quwork-ours/PLAN.md`（官方 O1–O9 架构决策 + G1–G13 差距 + 阶段 A–F）
> - `outputs/2026-09-24-analysis-quwork-vs-dsh/UPGRADE-PLAN.md`（设计系统 S1–S14 / 思考轨迹链路 / 内核 78 包差距）
> - `outputs/2026-09-27-learn-good-practices/REPORT.md`（官方+QuWork 优点全集 **21 条** A1–A6/B1–B8/C1–C13 + 现状核验）
> - `outputs/2026-09-27-incident-0.1.7-startup-crash/report.md`（**今日事故**：settings 行未迁移 → 启动崩溃）

---

# 第 0 部分 · 一页速览

## 0.1 这份 v2 相对 v1 改了什么（6 项）

| # | v1 的问题（覆盖审计结论） | v2 的处置 |
|---|---|---|
| 1 | **覆盖缺口**：21 条优点（A/B/C 组）只映射了 7 条；13 类缺点只覆盖 T1–T4 | 新增 **第 2 部分覆盖矩阵**，21 优点 + 13 缺点**逐条**落到工作项 |
| 2 | **单轨依赖**：所有收益排在「升级之后」（L 阶段），升级一卡全部停摆 —— **今日事故已证明这个安排脆弱** | 改为**三轨并行**：U（升级主线）/ B（**不依赖内核升级**的地基与治理，多数免重启）/ A（升级后架构深化） |
| 3 | **无阻塞项/依赖章节**：settings 行迁移这类新阻塞只能事后手工追加 | 新增 U6-0 前置项 + 每项标 `依赖` |
| 4 | **无决策点清单**：需拍板项散落 5 处以上 | 新增 **第 7 部分决策点清单**（8 条，含推荐答案） |
| 5 | **证据级别不贯穿**：只有末节 4 条诚实边界 | 全表贯穿【实测】/【推断】/【未验证】标记 + **第 9 部分证据分级说明** |
| 6 | **测试矩阵只服务补丁判定**：T-1..T-12 全对应 A/B/C 补丁，B 轨 30 项无验收项 | 新增 **第 4.3 B 轨验收 + 4.4 故障注入强制要求** |

## 0.2 现状（2026-09-27 23:35 实测）

| 事实 | 值 |
|---|---|
| 运行中应用 | **0.1.1-rc.2**（用户 23:09 重启；junction 事故回滚后未再切） |
| `dist\win-unpacked` junction | → `win-unpacked-build202608272104`（0.1.1，**事故后回滚至今**） |
| 0.1.7 build | **`win-unpacked-build202609272329`（U6-0c）已 promote**（VDE 46/46 + integrity OK + verify 79/79 + SMOKE ALL PASS）；1840/2210 已归档（`_backups/dist-archive/20260927233701/`）；旧 0.1.1 `2104` 保留为回滚 |
| 仓库侧 | U6-0c 代码已完成（contract/controller/写者/main/client-scope/API/tests 7 文件；client/host tsc 0 错；3 spec **42 PASS**）；备份 `_backups/u6-0a-20260927-212313/` |
| 进度 | U0–U5 ✅；B3 ✅；U6-0a ✅；**U6-0c ✅（本轮实施完成，构建中）**；U6-0b 待 0.1.7 运行态；P-遗留（B1/B3 补丁重写、tests 13 处旧 API）待独立批次 |

## 0.3 下一步（三选一，推荐 ①）

> **进度更新（20:50）**：**B3 已提前落地**（`scripts/verify-dist-exports.mjs` + Step 1.18，双构建对照通过）⇒ 原推荐序里的第一步已完成，**下一步 = U6-0 settings 行迁移**。

**进度更新（22:25）：U6-0a 已实施完成**（代码 + 构建 + 打包，新 build `build202609272210` 的**打包态链接期守卫转绿**；2 项补丁 fail-closed 属已知 P-遗留）。⇒ **下一步＝U6-0c 设置页回补**。

**进度更新（23:35）：U6-0c 已实施完成**（7 文件：`desktop-settings-contract` 加 shell/notifications 生效视图；controller `read()` 组装 + bootstrap `readShellView/readNotificationsView`；写者新增 `readDesktopNotificationsSettings`；main 接线；client API `persistShell/persistNotifications` + 严格解析；client scope `unavailableScope→apiSettingsScope`；测试适配 + 新增 5 用例）。**验证**：host/client tsc **0 错**；tests tsc 仅 13 pre-existing；`desktop-settings-api / client-desktop-settings / desktop-shell-settings` 3 spec **42 PASS**；**新 build `win-unpacked-build202609272329`：VDE 46/46 + integrity OK + verify-patches ALL PASS（79）**；**promote SMOKE ALL PASS（junction → 2329，1840/2210 归档）** ⇒ **下一步＝用户重启进入 0.1.7 → 合并验收（T-1..T-13 + U6-0b）**。

① **U6-0c（现推荐，免重启）**：`/api/desktop/settings` 新增 POST（复用 `writeDesktopShellSettings` + `scheduleRestart`）+ 客户端 Shell/Notifications 两节改接 → 重 build → 守卫保持绿。
② **U6-0b**：promote + **用户重启** 后在真实 0.1.7 里跑设置连续性核对（差异表 + 定点补救）。
③ **冒烟 T-1..T-13**（与 ①② 共用同一次重启）。
④ **B 轨**免重启项（B4 / B5 / B19 …）可随时穿插。

## 0.4 阻塞与决策

- **唯一硬阻塞**：U6-0 `settings 行迁移`（不解决则新 build 无法启动）。
- **需用户拍板 8 条** → 见第 7 部分（技能裁剪 / B5 退役 / 签名 / agent-presets 去留 / 插件合并是否执行 / 内核是否继续升 / 更新链路是否重启 / 归档粒度）。

---

# 第 1 部分 · 已完成盘点（逐项有验收证据）

> 这些**不是待办**，是后续工作的安全前提。

| 编号 | 内容 | 验收证据（实测） |
|---|---|---|
| **A0** | `session_projcache.json` 整文件重写风暴（52MB / 8.5s）→ profile 层节流 | 写入 8.5s→60s；主进程 CPU **69.5→7.5 cs/s（9.3×）** |
| **P0-6** | 补丁集身份登记（28 applier + 9 bundle + 3 reference → `patches/MANIFEST.json` + patchDigest） | check-all Step 1.17；故障注入 7 PASS |
| **P0-7** | 升级影响评估（23 项 A/B/C 清单） | 只读交付；6/6 断言复核 |
| **R1** | 幽灵 loader entry（双份巡检）根因 + 修复 + 重启验收 | `dev_dedupe_entries` 0 真重复（4 轮首见）；21 PASS |
| **R7** | `dev_self_test` 桌面形同虚设（0/1）→ 手写 lib 全链路 | 重启后 5/8（注入链路真实执行） |
| **R8** | 热重载平台限制 → SKIP 语义（不误报 FAIL） | 重启后 **8/8**（3 项 [SKIP] 如实标注） |
| **T1–T4** | 注入器四缺陷（重复挂载 / 失败无原因 / selfHeal 语义写反 / stale-tools） | injector 测试 21+35+40 PASS |
| **崩溃诊断基座** | `dsh-crashpad-hygiene`：保留最新 1..10 份 dmp + 容量配额 + 回收站 + 审计 | 存在且工作（67.6MB = 保留策略产物） |
| **L1 / L1b / L1c** | 技能 schema 收敛：`whenToUse` 62/62；扁平 `metadata` 5 键 62/62；嵌套 `invocation` 死配置清理 | YAML 解析 62/62；lint 用户段 **0 FAIL / 1 WARN** |
| **U0–U5** | 升级主线：基线 131 项绿 → 锁+全量备份 → pin 全 0.1.7 线 → install 335 包 + build/package 成功 → G1–G5 适配 → 补丁处置（verify-patches **79 checks ALL PASS**）→ 门禁 expectVersion 0.1.7 | 见 `2026-09-27-upgrade-0.1.7-adaptation/PLAN.md` 与 preflight REPORT |
| **事故回滚** | 2026-09-27 20:09 junction 回滚 + 完整性校验 + 事故报告 | `check-dist-integrity` OK；锁已 release；报告已登记 INDEX |
| **B3（提前落地）** | **打包态具名导出守卫** `scripts/verify-dist-exports.mjs` + `check-all.ps1` Step 1.18 | **双构建对照**：旧 build PASS（47/47）/ 新 build FAIL 4（3 项＝事故原文，1 项＝新发现 N1）；引擎 `vm.SourceTextModule.link()`，不执行模块体 |

---

# 第 2 部分 · 覆盖审计：v1 漏了什么（**本节直接回答「计划完整吗」**）

## 2.1 优点覆盖矩阵（21 条，来源：learn-good-practices REPORT）

> `[双源]` = 官方与 QuWork 独立收敛同一结论（最高可信度）；`[官方]` = 官方独有；`[Q]` = QuWork 独有。
> 「v1 覆盖」列 = v1 是否有对应工作项；「v2 归属」= 本版落到哪个编号。

| 编号 | 优点 | 我方现状 | v1 覆盖 | **v2 归属** |
|---|---|---|---|---|
| **A1** | 内核只读资产，启动期绝不装依赖 [双源] | ✅ 已符合 | 未列（隐性满足） | 已符合（登记为「无需动作」）|
| **A2** | 壳与内核同版本同发布 [双源] | ⚠️ 未完全 | L12 | **A1** |
| **A3** | 宿主挂了也有原生恢复路径 [双源] | ❌ 未学 | L7 | **B12**（+ B18） |
| **A4** | 插件安装安全闸门（SSRF + zip-slip）[双源] | ⚠️ 部分（fetch 有 SSRF） | ❌ **未列** | **B16** |
| **A5** | 崩溃自带现场且容量有界 [双源] | ❌ 未学 | L9 | **B13** |
| **A6** | 说明性日志/指标不撒谎 [双源] | ✅ 部分 | ❌ **未列** | **B30** |
| **B1** | 两阶段安装批准 + 任务中断 fail-safe [官方] | ❌ 未学 | L10 | **B27** |
| **B2** | Windows PE 签名 + 验签流水线 [官方] | ❌ 未学 | L11 | **A2** |
| **B3** | 更新节流（±20% 抖动 + 失败翻倍 + 成功重置）[官方] | ❌ 未学 | ❌ **未列** | **B26** |
| **B4** | 崩溃报告来源分类 + 保留最新 10 份 [官方] | ❌ 未学 | L9（部分） | **B13** |
| **B5** | 自带 Python 运行时 + 离线装到 `$DSH_HOME` [官方] | ❌ 未学（待核） | ❌ **未列** | **A9** |
| **B6** | Office 三技能 + 结构检查器 + 交付质量闸门 [官方] | ⚠️ 缺结构检查器 | ❌ **未列** | **B24** |
| **B7** | 中英双语 + 壳词典 + 欢迎页跟随系统语言 [官方] | ⚠️ 部分 | ❌ **未列** | **A10** |
| **B8** | 0.1.7 设计系统（corner-shape/elevation/FOUC-free/token）[官方] | ❌ 未学 | ❌ **未列**（只在「收益」里含糊带过） | **A3** |
| **C1** | 单操作互斥（共享 operation，占用即 pending）[Q] | ⚠️ 仅人工锁 | L8 | **B15** |
| **C2** | Profile 三槽检查点 + 崩溃中间态穷举 [Q] | ❌ 未学 | L7（部分） | **B18** |
| **C3** | `writeAtomic` 全仓库统一 [Q] | ⚠️ 部分（脚本层有） | ❌ **未列** | **B2**② |
| **C4** | 归档安全闸门（zip-slip/symlink/NFKC/上限）[Q] | ❌ 未学 | ❌ **未列** | **B16** |
| **C5** | SSRF + 逐跳重定向复检 + 流式限长 [Q] | ⚠️ 无逐跳 | ❌ **未列** | **B16** |
| **C6** | Ed25519 release manifest + patchSet/patchDigest [Q] | ⚠️ 部分（patchDigest 已做） | L12（部分） | **A1** |
| **C7** | vendor 离线包 + 内置 pnpm + frozen-lockfile [Q] | ❌ 未学 | ❌ **未列** | **A8** |
| **C8** | 启动失败 → 自动诊断 → recovery proposal [Q] | ⚠️ 部分（只报错） | L7（部分） | **B12** |
| **C9** | 技能安装静态审计 + 确认闸门 [Q] | ❌ 未学 | ❌ **未列** | **B23** |
| **C10** | 技能注入 XML + `<location>` 绝对路径 [Q] | ❌ 未学（9KB 纯文本） | L4 | **B21** |
| **C11** | 崩溃现场（退出事件附 stdout/stderr tail + URL 脱敏）[Q] | ❌ 未学 | L9（部分） | **B13** |
| **C12** | 能力发现先行 + checked 分母 + `restart.supported` [Q] | ❌ 未学 | ❌ **未列** | **A6** |
| **C13** | 三级交付模型 + 版本并存回滚 [Q] | ❌ 未学 | ❌ **未列** | **A7** |

**v1 命中率：7/21（33%）** ⇒ **v2 补齐 14 条**。

## 2.2 缺点覆盖矩阵（13 类，来源：AUDIT-AND-PLAN + threeway PLAN + perf-diagnosis）

| 组 | 缺陷 | 我方实测现状 | v1 覆盖 | **v2 归属** |
|---|---|---|---|---|
| 运行态 **T1–T4** | 重复挂载 / 失败无原因 / self-heal 失效 / stale-tools | ✅ 已修（本轮） | ✅ | 已完成 |
| 运行态 **T5** | 插件布局三处分散（`plugins/` 40 + 仓库根 3 + `hy3-gateway` 30.7MB）；INVENTORY 与实际不符 | ❌ 未动 | ❌ **未列** | **B4** |
| 运行态 **T6** | `dsh-routing-suite` 无 package.json，内含 49.1MB injector 副本（**两份 super-injector**） | ❌ 未动 | ❌ **未列** | **B5** |
| 运行态 **T7** | `dsh-remote-workspace` 提交 48.2MB `node_modules/` | ❌ 未动 | ❌ **未列** | **B5** |
| 运行态 **T8** | 7 个插件缺 `license` | ❌ 未动 | ❌ **未列** | **B4** |
| 运行态 **T9** | 40 插件仅约 9 个有测试 | ❌ 未动 | ❌ **未列** | **B11** |
| **集群重叠** | 3 个插件（tier-router / provider-failover / inspection-guard）**同挂 `agent/request` 改道，无优先级** ⇒ 静默错误路由 | ❌ 未动 | ❌ **未列**（**v1 最大遗漏**） | **B1**（P0 级） |
| 集群重叠（其他） | 视觉链 4 / 内务链 5 / 可观测 3 / 工具渲染 2 / picker 2 | ❌ 未动 | ❌ **未列** | **B6–B10** |
| 补丁债 **G1** | 28 个补丁与内核强耦合、无 digest | ✅ P0-6 已做登记 | ✅ | 已完成 |
| 补丁债（第二层） | 「能插件化的就插件化」——补丁减债 | ⚠️ 只做了升级处置 A/B/C，**没做减法** | ⚠️ 部分 | **B2**② / U7 |
| **G2** | Windows 未签名 | ❌ 未动 | L11 | **A2** |
| **G3** | 原生恢复只告警不动作、依赖壳存活 | ❌ 未动 | L7 | **B12** |
| **G4** | 无归档/下载安全闸门 | ❌ 未动 | ❌ **未列** | **B16** |
| **G5** | 无统一单操作互斥 | ❌ 未动 | L8 | **B15** |
| **G6** | `dsh-atomic-write` 缺 Windows rename 重试 | ❌ 未动（**可立刻修**） | ❌ **未列** | **B2**① |
| **G7** | 无构建期导入守卫 | ❌ 未动 | ❌ **未列** | **B3**（**今日事故的防线**） |
| **G8** | Skill 注入为纯文本摘要（9KB → 锚定率 0%） | ⚠️ schema 已收敛，注入未改 | L4 | **B21** |
| **G9** | Skill 无安装审计闸门 | ❌ 未动 | ❌ **未列** | **B23** |
| **G10** | 无崩溃报告 | ❌ 未动 | L9 | **B13** |
| **G11** | 内核落后（缺 78 包） | 🔄 U0–U5 已做，U6 卡住 | ✅ | **U6-0 → U7** |
| **G12** | 自动更新关闭 + 无差分 | ❌ 未动 | ❌ **未列** | **B26/B29** |
| **G13** | UI 设计系统落后（`corner-shape` 9→0 / elevation 14→4 / primitives 502KB vs 289KB） | ❌ 未动 | ❌ **未列** | **A3** |
| 技能三套 schema | frontmatter 7 种模式并存 | ✅ L1/L1b 已收敛 | ✅ | 已完成 |
| 技能重复 | `log-analysis`/`log-analyzer`、`paper-summary`/`claude-paper-summary`、`code-review`/`chinese-code-review` | ❌ 未动 | ❌ **未列** | **B19** |
| 技能稀释 | 无关导入技能稀释 catalog（62 → ~40） | ❌ 未动 | ❌ **未列** | **B20** |
| 长会话卡 | 对话区**零虚拟化**，长会话全量建 DOM（perf-diagnosis B2） | ❌ 未动 | ❌ **未列** | **A12** |
| 设计纪律 S1–S14 | corner-shape / elevation / 字号阶梯 / token 权威 / 禁用复制控件 / 本地化 label 强制 … | ❌ 未动 | ❌ **未列** | **A3** |
| 思考/轨迹链路 | 官方 Trajectory 独立视图（TTFT/时长/token + 虚拟化 ±50 Node） | ❌ 缺 | ❌ **未列** | **A11** |

**v1 缺点命中率：约 6/20** ⇒ **v2 补齐 14 类**。

## 2.3 v1 的 5 个结构性缺陷（审查结论）

1. **收益全押在升级上** —— 今天的事故证明：只要 U6 卡住，43 插件治理、30 项稳定性机制、技能优化**全部停摆**。这是最严重的结构问题。
2. **把「已分析过的缺点」当成了「已解决的缺点」** —— AUDIT 报告里的 P0-5/P1-1..8/P2-1..7/P3-2..8/P4-2..5 共 30 项，v1 只吸收了 7 项进 L 阶段。
3. **缺阻塞项与依赖建模** —— 无「前置项」概念，导致新阻塞只能事后追加（本次就是手工补的）。
4. **验收口径不统一** —— U 轨有 6 要素+故障注入；B/L 项只有 4 列，且无「必须做故障注入」的硬约束（而 AUDIT 明确要求「通过了 ≠ 有效」）。
5. **无决策点集中区** —— 8 处需用户拍板散落全文，容易漏。

## 2.4 本次调查的新发现与口径订正（2026-09-27 20:50，全部【实测】）

| # | 项 | 结论 |
|---|---|---|
| **N1** | **陈旧产物仍在发布** | 新 build 的 `lib/windows-agent-presets.js` 引用 `@deepseek-ai/dsh-agent-presets` 已删除的 `PresetExistsError`，且**不被任何其他 lib 文件引用**（G5 只把源文件排除编译，旧产物仍被打包）⇒ 需要「excluded 源不得残留产物」的断言或清理。**由 B3 守卫首次运行抓到。** |
| **N2** | **体积口径订正** | `plugins/dsh-routing-suite` **53MB**（其中 `injector/` **52MB**）；`dsh-remote-workspace/node_modules` **50MB**（`du` 实测）。AUDIT 记 49.1MB / 48.2MB 属时点/口径差异 ⇒ **B5 实际可回收约 −102MB** |
| **N3** | **门禁现状订正** | `check-all.ps1` 现有 **20 个 step**（1.5–1.18 + Step 2/2.5/2.6/3/4）；新增 **Step 1.18** 后，**只要 dist 里最新 build 仍是被阻塞的 0.1.7，该步就会红** —— 这是**守卫生效的证据**，不是回归；U6-0 修好后自然转绿 |
| **N4** | **重复造轮子风险确认** | B3 若按初稿「新增 verify-bundle-imports」实现，会与既有 `verify-plugin-imports.mjs`（Step 1.11）职责重叠 ⇒ 已改为**互补**：1.11 管「能不能依赖它」，1.18 管「依赖的名字还在不在」 |
| **N5** | **`settings.yaml` 是用户的「全量设置文档」** | 实测 13,850 B / **8 个 section**（`ui-theme`/`ui-conversation`/`llm-pi-ai`/`agent-default-model`/`llm-deepseek`/`ui-onboarding`/`agent-presets`/`dsh-community-market`），**桌面 mode/port 反而不在其中**。0.1.7 只按「section 名＝entry id（含别名）」导入，**不匹配的 section 只记日志并留在 `settings.yaml.imported`** ⇒ **静默降级风险**（用户以为设置还在）。处置：**升级前备份**（已做：`_backups/settings-yaml-u6-0-20260927-211650/`）+ **升级后逐 section 生效值核对脚本**（U6-0b）+ 未生效项定点补救 ||

### B3 守卫的工程要点（写下来供复用，均已实测）

1. `vm.SourceTextModule.link()` **会做具名导出的链接期校验且不执行模块体** —— 探针验证：副作用模块（`throw`）未被触发。这是唯一能静态复现「启动期 SyntaxError」的机制。
2. **不能靠读 namespace 拿导出名**：evaluate 前 `Object.keys(ns)` 会因 TDZ 抛 `Cannot access 'A' before initialization`。
3. **vm 领域的错误对象 `instanceof Error` 为 false** ⇒ 错误分类必须用 `err.name` / `err.message`（否则 MISSING_EXPORT 会被误分类为 LINK_ERROR）。
4. **`vm.Module` 只能 link 一次** ⇒ 不能缓存模块对象（只能缓存文件文本），否则报 `Module status must be unlinked` / `Module has already been linked`。
5. **不可静态验证的目标**（CommonJS / `electron` / 解析失败）按「引用方实际请求的名字」生成占位模块，让校验继续往下走，同时把替代量**如实上报**（否则就是「假绿」）。


---

# 第 3 部分 · 三轨工作项总表

> **三轨的意义**：U 是**主线**（最高杠杆但风险最高、且今天已证明会卡）；B 是**地基**（不依赖内核升级，多数免重启，可在 U 卡住时继续产出）；A 是**深化**（依赖升级后的新包/新 API，收益最大但要等）。

## 轨道 U · 升级主线（内核 0.1.1-rc.2 → 0.1.7-rc.2）

| 编号 | 项目 | 关键动作 | 验证 | 回滚 | 风险 | 收益 | 重启 | 状态 |
|---|---|---|---|---|---|---|---|---|
| **U0** | 基线留痕 | gate / port-self-check / verify-patches | 131 项全 PASS | — | 零 | 升级前绿参照 | — | ✅ |
| **U1** | 锁 + 全量备份 | `global:*` 锁 + sessions/storages/两个 package.json | sha256 + Test-Path | 还原备份 | 低 | 可逆 | — | ✅ |
| **U2** | 改依赖 pin | `dsh 0.1.7-rc.2` / `cordis ~4.0.4` / `loader ~1.0.5` / 新增 `client-ui-chat`；全 0.1.7 线 + 4 特例 | git diff；npm 全检 0 缺失 | `git checkout` | 低 | 版本线对齐 | — | ✅ |
| **U3** | install + build + package | `yarn install`（335 包）→ `yarn build` → 打包 | tsc 0 错；build exit 0；新 build 目录 | 删新 build（junction 未动） | 中 | 产物就绪 | — | ✅ |
| **U3.5** | G1–G5 + client 适配 | ProfileTemplate / settings / jobs / pwsh Volatile / agent-presets 降级 | tsc 0 错；yarn build 0 | git + 备份 | 中 | 编译层对齐 | — | ✅ |
| **U4** | 补丁 A/B/C 处置 | A 退役 13（INFO-RETIRED）/ B 锚点更新 / C 保留重打 / C10 canon 重做 | verify-patches **79 checks ALL PASS** | 每脚本自带 `_backups/dist-*` | 高 | 补丁随内核换代 | — | ✅ |
| **U5** | 门禁重登记 | `patch-shape-gate` expectVersion → 0.1.7；manifest 重登记 | gate **ALL OK**；unsupervised 26/0/0 | 还原登记 | 中 | 防旧 canon 污染 | — | ✅ |
| **U6-0** | 🔴 **前置：settings 行迁移**（**今日新增阻塞项**） | ① `src/profile.ts` 去掉 `SETTINGS_FILE_PACKAGE` 断言 / `FileSettingsProvider.Config` / `resolveSpec`；② `readDesktopStartupSettings` 的 `mode`/`port` 改存 profile patch 或 desktop-shell entry config（0.1.7 的 settings 行无配置字段）；③ `onSettingsDocumentResolved` 钩子改语义；④ 客户端设置页真迁移；⑤ notifications 改 entry Config；⑥ tests 19 处旧 API | ① 新 build **能启动**（launcher 不再抛 SyntaxError）② `/health` 10/10 ③ 设置页读写 mode/port 生效且变更触发重启 ④ `yarn test` 适配后通过 | vendor git（12 文件未提交）+ `_backups/kernel-upgrade-*`；旧 build 始终可 promote 回 | **中高** | **解锁整个 U 轨**（不解决则新 build 永久不可启动） | 是 | ⏸ 待拍板 |
| **U6-0a** | ✅ **已实施完成（2026-09-27 22:20）** | `profile.ts` 删 `dsh-settings-file` 全链；新单一写入器 `src/desktop-shell-settings.ts`；`Config` += logLevel；notifications 5 开关改 entry Config；恢复窗动作删除；**N1 修复**（删 tsdown entry + 删 verify-packaged-runtime 必填引用 + 删 package.json 死导出）；tests 适配（29→13 错误，我引入的全部清零） | **打包态链接期守卫转绿**：新 build `win-unpacked-build202609272210` → `verify-dist-exports.mjs` **PASS（exit 0，45/45，事故 4 项 MISSING_EXPORT 全消失）**；`check-dist-integrity` OK | vendor git + `_backups/u6-0a-20260927-212313/` | 中 | **解锁 U 轨**（build 可启动） | — | ✅；报告 `outputs/2026-09-27-u6-0a-implemented/REPORT.md` |
| **U6-0b** | 设置连续性核对（8 section → describe() 差异表 + 定点补救） | 待 0.1.7 运行态 | `settings.yaml` 已备份 | — | 中 | 防静默降级 | 是 | ⏸ 待 promote |
| **U6-0c** | 设置页回补（私有 API POST + 客户端两节改接） | **✅ 已实施（2026-09-27 23:3x）**：contract/controller/写者/main/client-scope/API/tests；client/host tsc 0 错；3 spec 42 PASS；新 build 构建中 | 见 DECISION §3.10-3.12 | vendor git + `_backups/u6-0a-*` | 中 | 恢复可编辑（T-13 验收） | — | ✅（build 验证后 promote） |
| **U6-0** | 判断文档 | `outputs/2026-09-27-u6-0-settings-migration/DECISION.md`（8 条判断 + 逐文件改动 + D-9 补拍） | — | — | — | — | — | ✅ 判断已定 |
| **U6** | promote + 重启 + 冒烟 | 我 promote（**正常模式**，不用 `-Force`）→ **用户重启** → 冒烟 T-1..T-12 | 见 4.2 | 原生 junction 重建回旧 build（**勿用 promote-build 回滚**，见 4.5） | 高 | 升级落地 | 是 | ⏸ |
| **U7** | 收口 + 回归复测 | 删 A 组退役项与脚本；**回归复测清单**：`force-reasoning-effort` / `developer-role-guard` / 三个改道插件 / 视觉链 / pwsh 沙箱 / **agent-presets 降级后的功能缺口**；复核 loader 1.0.5 对 R8（热重载是否真可用） | 复测逐项有结论；CHANGELOG / memory / INDEX / `_backups` 四件套齐 | — | 中 | 维护面缩小 | 是 | ⏸ |

## 轨道 B · 地基与治理（**不依赖内核升级**，30 项）

> 编号沿用 `AUDIT-AND-PLAN` 的 P0-x/P1-x/… 溯源，括号内为原编号与针对的缺陷。

### B-0 先止血（2 项，P0 级）

| 编号 | 项目（针对） | 关键动作 | 验证（含故障注入） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **B1** | **模型路由仲裁器**（集群重叠；P0-5） | 3 个改道插件合并为**唯一 `agent/request` 出口**，内部固定顺序（inspection → tier → failover）+ 声明互斥 | **故障注入**：构造「三者同时命中」的请求 → 断言按序只改道一次、无双重改道 | 合并前旧插件可还原 | 中高 | **高**（消除静默错误路由） | 是 |
| **B2** | **原子写硬化**（G6 + C3；P0-8 + L3） | ① 移植 0.1.7 `renameAtomicTemp`（EACCES/EBUSY/EPERM，20→200ms，8 次）② 清点所有写点，产出「未走 atomic-write」清单 | ① **故障注入**：占用目标文件句柄 → 断言重试后成功；对照不打补丁必失败 ② 清单 0 遗漏 | `_backups/` + 反向脚本 | 低 | 中高（修真实写失败根因） | 是 |

### B-1 防线与结构（B3 已落地 + N1 新发现）

| 编号 | 项目（针对） | 关键动作 | 验证（含故障注入） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **B3** | **构建期具名导出守卫**（G7；P0-9）—— **今日事故的直接防线** · **✅ 已落地 2026-09-27** | **修正**：v1/v2 初稿写「新增 verify-bundle-imports.mjs」是**未查现状**的写法 —— 仓库其实已有 `scripts/verify-plugin-imports.mjs`（Step 1.11），但它只管**说明符纪律**并**把 `@deepseek-ai/*` 当宿主提供而完全不查导出名**；`check-dist-integrity.mjs` 只查 lib/main.js 的**相对**导入是否存在；`verify-runtime-closure.mjs` 只查依赖图闭合。**四者都看不见「具名导出被删」**。<br>**实际落地**：`scripts/verify-dist-exports.mjs` + `check-all.ps1` **Step 1.18**。用 `vm.SourceTextModule.link()` 做 V8 真实链接期校验（**不执行任何模块体**），目标＝`resolve-dist.mjs` 选出的**最新 build**（即将 promote 的那个）。 | **双构建对照（真实故障注入，非人造）**：① 旧 build `build202608272104`（0.1.1）→ **PASS**（47/47 链接干净，替代量如实上报 `COMMONJS_TARGET=18 UNRESOLVED=3`）；② 新 build `build202609271840`（0.1.7）→ **FAIL 4 项**，其中 3 项＝**今日事故原文**（`main.js`/`profile-dWJ_zWhP.js`/`profile.js` → `'SettingsProvider' does not exist`），第 4 项＝**新发现 N1**（见下）。探针自身先验证过（副作用模块未执行 / 存在的导出可链接 / 缺失导出抛 SyntaxError） | 新增脚本 + 门禁一步，摘除即恢复 | 低 | **高**（此类崩溃从「用户启动时」提前到「门禁/构建时」） | — |
| **B3-N1** | **新发现：陈旧产物仍在发布**（本次守卫首次运行即抓到） | `lib/windows-agent-presets.js` 引用 `@deepseek-ai/dsh-agent-presets` 已删除的 `PresetExistsError`；该文件**不被任何其他 lib 文件引用**（G5 已把源码排除编译，但旧产物随 build 一起被打包） | 守卫输出 `(not referenced by any other lib file - stale artifact?)`；**处置待拍板**：删除该产物（并在打包/清理环节加一条「excluded 源不得残留产物」的断言） | 删文件 | 低 | 中 | — |
| **B4** | **插件布局单一事实源 + 元数据合规**（T5/T8；P1-1） | 三个根级插件移入 `plugins/`；`plugins/INVENTORY.md` 变为**机器可校验**；7 个缺 license 补全；`check-all` 断言「INVENTORY ≡ 磁盘 ≡ 运行态 loader」 | 三处一致性断言；**故障注入**：手工加未登记插件 → 断言门禁报红 | 移动可逆 | 中 | 高 | 是 |
| **B5** | **仓库瘦身**（T6/T7；P1-2/P1-3） | `dsh-routing-suite` 移出 `plugins/` → 删 49.1MB injector 副本与 `.tgz`，改 `PROVENANCE.md` 指向活体；`dsh-remote-workspace` 移除 48.2MB `node_modules/` 改 lockfile | 断言活体 injector 可用；断言仓库不再含第二份 injector；`pnpm install --frozen-lockfile` 可跑 | 可还原 | 低-中 | 中高（**-97MB**） | 否 |
| **B6** | **视觉链 4 合 1**（P1-4） | `vision-engine` 为壳，内分 autoread / guard / rotator 模块 | **故障注入**：① 纯文本模型发图 → 走双胞胎 ② 拔掉 modlens → 降级提示 ③ 断言巡检只跑一次（T1 回归） | 旧插件可还原 | 中高 | 高 | 是 |

### B-2 重复收敛（5 项）

| 编号 | 项目（针对） | 关键动作 | 验证 | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **B7** | 内务链 5 合 1（P1-5） | crashpad/session-hygiene/temp-tracker/instance-janitor/self-maintenance → 各规则独立模块，共享 JSONL 轮转与状态源 | 逐规则故障注入（造 .dmp 堆积 / 大 session / test 临时文件 / 僵尸进程） | 可还原 | 中 | 中高 | 是 |
| **B8** | 可观测 3 件抽公共（P1-6） | `tool-audit`/`temp-tracker`/`health-dashboard` 的 JSONL + 1MB 轮转抽到 `dsh-host-services` | 三处行为等价 + 轮转单测 | 可还原 | 低 | 中 | 是 |
| **B9** | 工具渲染 2 合 1（P1-7） | `diagram-renderer` + `tool-renderers` 合并，共用 client 构建 | 两个工具卡正常渲染 | 可还原 | 低-中 | 中 | 是 |
| **B10** | 模型选择器 2 合 1（P1-8） | `model-whitelist` + `model-picker-group` 合一 | picker 白名单与分组同时生效 | 可还原 | 低 | 中 | 是 |
| **B11** | 插件测试覆盖补强（T9） | 为无测试插件分批补最小回归测试（优先级：注入器相关 / 守卫类 / host-services） | 覆盖数从 ~9 提升；`check-all` 纳入 | 新增文件 | 低 | 中高（改动有回归保护） | 否 |

### B-3 稳定性机制（照官方/QuWork 成熟做法，7 项）

| 编号 | 项目（针对） | 关键动作 | 验证（含故障注入） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **B12** | **原生恢复四选项**（A3/G3/C8；P2-1） | 退出 / 重启 / **禁用第三方插件**（`cordis.patch.yml` → `.bak-<ts>`，**不解析**）/ 备份 patch 并重启；**不依赖宿主存活**；失败如实报错 | **故障注入**：① 坏 YAML → 断言重命名成功 ② 悬空引用 → 恢复后可启动 ③ 占句柄致重命名失败 → 如实报错不假装成功 | 重命名天然可逆 | 中 | **很高**（消灭「重启打不开」） | 是 |
| **B13** | **崩溃报告 + 自带现场**（A5/B4/C11；P2-2） | 先落盘再弹窗（≤1s）；来源分类 `main/renderer/host/web-boot`；错误+cause ≤256KiB、host tail ≤64KiB、renderer console ≤64KiB；**保留最新 10 份**；凭证/URL 脱敏 | **故障注入**：三路各造一次致命错误 → 三类报告都生成且带现场；第 11 次后最旧被删且无关文件未动 | 删文件 + 摘接线 | 低-中 | 中高 | 是 |
| **B14** | **单实例锁 + profile 独占**（O2；P2-3） | 壳在**访问任何 profile 前**取进程生命周期单实例锁；文档化「壳独占 profile；多会话共享数据但不共享可执行包/lock」 | ① 双开断言第二个让路 ② 并发压测断言 profile 不被写坏 | 锁逻辑可摘 | 中 | 高 | 是 |
| **B15** | **单操作互斥运行时化**（C1/G5；P2-4） | 注入器 install/uninject/reload 加 `runExclusive()`，占用返回 `operation-pending`；与 task-scheduler **互补**（进程内 vs 跨进程） | 并发 5 install → 断言 1 成功 4 pending、profile 未损 | 包裹层可摘 | 中 | 高 | 是 |
| **B16** | **归档 + 下载安全闸门**（A4/C4/C5/G4；P2-5） | `lib/archive-guard.mjs`（zip-slip / symlink ancestor / NFKC 碰撞 / 上限 / 预检后解压）+ `lib/safe-download.mjs`（SSRF + `redirect:'manual'` 逐跳复检 ≤3 + 流式限长 + `wx`/`0600`）。**注**：`dsh-web-fetch-local` 已有 SSRF+size cap ⇒ 抽出复用 | **故障注入（必做）**：`../`、绝对路径、`C:\`、UNC、symlink ancestor、大小写碰撞、>100k 条目、设备文件、加密 zip、302→127.0.0.1、超长流 → 逐个断言被拒 | 新增文件 | 低 | 高 | 是 |
| **B17** | 插件清单每文件 sha256（P2-6） | `plugins/MANIFEST.json` 每文件 `size+sha256`（照 QuWork `unified-manifest.json`）；启动/安装抽样校验 | 改一字节 → 断言校验报红 | 删 manifest | 低-中 | 中高 | 是 |
| **B18** | **Profile 三槽检查点 + 回滚**（C2；P2-7） | 照 QuWork 七要点 + **两处偏离**：大 tarball 走内容寻址 / 快照前凭据脱敏 | **故障注入**：rotation 每步 kill → 断言收敛到合法三槽；写坏 `package.json` → 回滚后可启动 | 目录独立，删即失效 | 中 | **很高** | 是 |

### B-4 Skill 库（用户重点，7 项）

| 编号 | 项目（针对） | 关键动作 | 验证（可量化） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **B19** | 技能去重（P3-2） | `log-analysis`/`log-analyzer`、`paper-summary`/`claude-paper-summary`、`code-review`/`chinese-code-review` 三对合一；`diagram`/`diagram-design` 划清边界 | 相似度 + 描述重叠检测断言无近义重复 | 归档不删，可恢复 | 低 | 中高 | 否 |
| **B20** | 相关性裁剪（P3-3） | 无关导入技能移到 `~/.dsh/skills-archive/`（**不删**），默认目录 62 → 约 40 | 断言默认目录数量；**锚定率实测** | 移回即可 | 低 | 高 | 否 |
| **B21** | **技能 XML catalog 注入 + 锚定率**（C10/G8；P3-4）**核心 KPI** | catalog 从纯文本摘要改为 `## Skills (mandatory)` + XML `<available_skills>`，每技能只注 `<id>/<name>/<description>/<location>`（**绝对路径**，不注正文） | ① 注入文本体积断言显著下降 ② **锚定率前后对照**（先建可复现 prompt 集基线） | 加载器补丁反向 + AGENTS.md 备份 | 中 | **高** | 是 |
| **B22** | 技能双通道注入过滤（P3-5） | 只把 `enabled && modelInvocable` 注入 catalog（扁平 kebab 契约已由 L1c 修好） | 标记 `disable-model-invocation: true` 的技能不在 catalog，但用户仍可手动调用 | 补丁反向 | 低-中 | 中 | 是 |
| **B23** | 技能安装审计闸门（C9/G9；P3-6） | `lib/skill-audit.mjs`：`curl\|bash` / `rm -rf /` / `secret[:=]` 三规则；`riskLevel != low` → 挂起待确认（10min TTL）+ 返回 `auditReport`；支持 `installDisabled` | **故障注入**：含三规则的技能包 → 断言挂起 + 报告定位到行号 | 新增文件 | 低 | 中高 | 是 |
| **B24** | 交付质量闸门（B6；P3-7） | `docx`/`pptx`/`xlsx`：创建 → **重新打开** → 结构检查器 → 再交付；pptx 加渲染后视觉检查（复用 `deck-design` + `pptwise_preview`） | **故障注入**：造有缺陷 pptx → 断言拦下；正常产物通过 | skill 备份 + MANIFEST | 低 | 中高 | 否 |
| **B25** | 技能完整性基线（P3-8） | `MANIFEST.sha256` 覆盖全部技能并纳入 `check-all.ps1` | 改一字节 → 门禁报红 | 基线可再生 | 低 | 中 | 否 |

### B-5 更新链路与诚实性（5 项）

| 编号 | 项目（针对） | 关键动作 | 验证（含故障注入） | 回滚 | 风险 | 收益 | 重启 |
|---|---|---|---|---|---|---|---|
| **B26** | 更新节流 + 抖动 + 退避（B3/G12；P4-2） | 基础 10min + **±20% 独立抖动** + **失败翻倍上限 1h** + 成功重置；自动检查**不弹窗不下载** | 可注入时钟单测：抖动落 ±20%、失败翻倍至上限、成功归零 | 参数可回退 | 低-中 | 中 | 是 |
| **B27** | 两阶段批准 + 任务中断 fail-safe（B1；P4-3） | 下载就绪 → 批准 → **锁新请求 → 等已接收请求结束 → 查任务** → 再批准；超时**拒绝并解除准入锁**；任务未知/未授权/未收尾 → **阻止安装** | **故障注入**：模拟「任务未知」→ 断言阻止；「收尾超时」→ 断言拒绝且准入锁已释放 | 摘接线 | 中高 | 高 | 是 |
| **B28** | HTTP 逐连接空闲超时（P4-4） | 60000ms 内未收到响应头或后续字节即失败；活跃下载**无总时长限制** | 只连不发的服务器 → 断言 60s 失败；大文件不被总时长杀 | 参数可回退 | 低 | 中 | 是 |
| **B29** | 差分更新评估（G12；P4-5） | 评估 `differentialPackage` + 数据块复用 | 对比两次发布产物体积 | 配置可回退 | 低 | 中 | — |
| **B30** | 指标分母诚实性核查（A6；L2） | 核查 selfHeal / 各类「check 分母」日志是否实报分母（对应 T3 语义写反的同类问题） | grep + 抽样对照；产出报告 | 纯只读 | 低 | 中 | — |

**B 轨统计**：31 项（含 B3-N1）｜ 免重启 10 ｜ 需重启 18 ｜ 纯只读/文档 3 ｜ **已落地 1（B3）**。

## 轨道 A · 升级后架构深化（依赖 U 轨完成，13 项）

| 编号 | 项目（针对） | 关键动作 | 验证 | 风险 | 收益 | 依赖 |
|---|---|---|---|---|---|---|
| **A1** | 版本身份统一（A2/C6；O1） | 壳 + 内核 + pnpm **同一发布单元**；打包时校验 schema/壳版本/目标兼容/**文件完整性**；产出 runtime descriptor（含最终文件清单） | 篡改描述符一个 sha256 → 断言启动拒绝；版本不一致 → 打包失败 | 中 | 高 | U |
| **A2** | Windows 签名（B2/G2） | 二选一**如实执行**：① PE 签名+验签流水线 ② 明确接受未签名但在 README/安装引导**如实说明**并给绕过指引 | 签名后 `signtool verify`；未签名路径断言文档已说明 | 中 | 高 | U（发布链） |
| **A3** | **设计系统对齐**（B8/G13 + S1–S14） | 随 0.1.7 新 primitives/theme 落地：`corner-shape: superellipse(1.5)` + `@supports` 渐进增强；Elevation（0.5px 发丝描边 + 双层柔光 + menu backdrop-filter，高层级表面 `border:0`）；字号阶梯（secondary −1/−2，代码固定）；token 单一权威纪律；**禁用复制控件**纪律；**别学反例**「`--app-text-secondary:#999` on `#fff` = 2.85:1 低于 AA」 | 逐项 `@supports` 回退验证；token 计数对照（corner-shape 0→N / elevation 4→N）；对比度 ≥4.5:1 | 中 | 高（视觉与官方不再分叉） | U |
| **A4** | 复用官方 REST API / SDK（F1） | 启用升级后自带的 7 个 `dsh-api-*-controller` + 4 个 `dsh-sdk-*`，**不自研** | 接口冒烟 | 中 | 中高 | U |
| **A5** | Hooks 兼容（F2） | 启用 `dsh-hook-protocol` + `dsh-hooks-claude-code` + `dsh-hooks-codex` | Claude Code / Codex 生态样例跑通 | 中 | 中高 | U |
| **A6** | 能力发现 + 诚实指标（C12；F3） | 对外 `capabilities`（含 `stability` / `restart.supported`）+ `updates/summary`（含 **`checked` 分母**） | 接口返回结构断言；分母不为 0 时可读 | 中 | 中 | U |
| **A7** | 三级交付模型 + 版本并存回滚（C13） | runtime / bundled / remote 三级 + 插件版本并存回滚 | 回滚演练 | 中高 | 高 | U + B18 |
| **A8** | vendor 离线包 + 内置 pnpm（C7） | `vendor/` 离线包 + 内置 pnpm + frozen-lockfile 声明式安装；**支撑 A1 的「同一发布单元」** | 断网安装演练 | 中 | 中高 | U |
| **A9** | 自带 Python 运行时（B5） | numpy/pandas/docx/pptx… 离线装到 `$DSH_HOME` | 无系统 Python 环境下跑通 Office/数据技能 | 中 | 中 | U |
| **A10** | 本地化双语（B7） | 壳词典 + 欢迎页跟随系统语言 + primitives 的 label 强制（遗漏即类型错误） | 中英切换 + 类型检查强制 | 中 | 中 | U + A3 |
| **A11** | 思考/轨迹链路（09-24 §2） | Trajectory 独立视图：事件时间线 + **TTFT/生成时长/token 三指标**（**缺失时不可用，不伪造 0**）+ 思考块固定 13px/20px + Overview 标尺 + 虚拟化 ±50 Node | 长会话（万级事件）可用；指标缺失显示「不可用」 | 中高 | 中高 | U |
| **A12** | **长会话虚拟化**（对话区零虚拟化；perf-diagnosis B2） | 先复核 0.1.7 新 `dsh-client-ui-chat` 是否已内建虚拟化 —— **若已内建则本项降级为验证**；否则做对话区虚拟化 | 长会话切/滚帧率与内存对照 | 中高 | 高（切会话卡的根因） | U |
| **A13** | 崩溃现场深化 + 平台化（可选） | 与 B13 衔接的现场增强；按需对外扩展能力 | 按需 | 中 | 中 | U + B13 |

**A 轨统计**：13 项 ｜ 全部依赖 U 轨（A12/A13 部分可提前验证）。

## 3.x 依赖图与并行执行顺序

```
【可立刻并行 —— 不等升级】
B3 构建期导入守卫  ← ✅ 已完成（Step 1.18，双构建对照通过）
B3-N1 删陈旧产物 windows-agent-presets.js（守卫抓到；免重启）
B4 布局单一事实源   B5 仓库瘦身(-97MB)   B19 技能去重   B20 技能裁剪(需拍板)
B2 原子写硬化  B30 分母核查  B11 插件测试
B1 模型路由仲裁   B16 归档/下载闸门   B12 原生恢复   B13 崩溃报告   B15 互斥
B17 清单 sha256   B6–B10 重复收敛   B21 技能 XML 注入(需重启)   B23/B24/B25
   ↓（互不阻塞，随拍板推进）
【升级主线 —— 当前卡在 U6-0】
U6-0 settings 行迁移 → U3 重 build → U4 补丁复处置 → U5 门禁 → U6 promote + 你重启 + 冒烟 → U7 收口
   ↓
【升级后才做】
A1 身份统一 → A2 签名 / A8 离线包 → A3 设计系统 → A4/A5/A6 API/Hooks/能力发现
A7 三级交付 → A9 Python → A10 本地化 → A11 轨迹 → A12 长会话虚拟化
```

**关键结论**：**B 轨 30 项中有 23 项不依赖内核升级、9 项免重启** ⇒ 即使 U 轨继续卡住，仍然有大量确定性提升可交付（这解决了 v1 的结构性缺陷）。

## 3.y 重启清单（汇总）

| 类别 | 项 |
|---|---|
| **免重启**（热加载 / 下次调用生效 / 纯文档） | B3（✅已落地）、B3-N1、B5、B11、B19、B20、B24、B25、B29、B30 |
| **需重启**（用户执行） | B1、B2①、B4、B6–B10、B12–B18、B21–B23、B26–B28、U6、U7、A1–A13 |
| **纯只读** | B30（核查部分）、U0、P0-7 已完成项、E1 类预演 |

---

# 第 4 部分 · 测试矩阵

## 4.1 分阶段门禁（U 轨）

| 阶段 | 测试 | 判定 |
|---|---|---|
| U0 | gate / port-self-check / verify-patches 131 项 | 全 PASS（已验） |
| U3 | `yarn typecheck` + `verify:closure` + `verify:loader` + `yarn test` | 全绿 |
| U4 | 每个 apply 脚本 `EXACT-OK`/marker 计数 + `verify-patches.ps1` | 79 checks 全绿（已验） |
| U5 | `check-all.ps1`（unit 308+ / smoke / unsupervised REGISTERED≥20 DRIFTED=0） | ALL PASS（health-check pre-existing 除外） |
| **U6-0** | **新 build 能启动**（launcher 无 SyntaxError）+ `/health` 10/10 + 设置页 mode/port 读写 | **本项是 U 轨的硬门槛**（今日事故后新增） |

## 4.2 重启后冒烟 T-1..T-12（U6）

| # | 冒烟项 | 对应判定 |
|---|---|---|
| T-1 | Web GUI `127.0.0.1:43120` 可开 + `/health` 10 项 | 整体 |
| T-2 | 含 U+xx00 汉字（「开文件夹」「一方」）目录选择器 | A3 补丁 |
| T-3 | 打开**旧长会话**（session 迁移 + 滚动 + zstd） | A5/A6 |
| T-4 | 模型路由 tier-router 回归（`dev_model_route_test` 干跑） | 插件兼容 |
| T-5 | 设置→模型→获取可用模型弹窗搜索框过滤 | A4 |
| T-6 | `Remove-Item` 落到回收站 | C9 |
| T-7 | 长命令输出溢出 → **无弹窗**、不崩 | A2 |
| T-8 | 流式执行期间打字/滚动不卡 | B6 |
| T-9 | `agent/disposed` 日志无 `reading 'catch'` | C3(cordis) |
| T-10 | 会话投影缓存无 `non-plain-JSON` 告警 | C5 |
| T-11 | `dev_self_test` 结果（R8 复核：8/8 SKIP 或真可用） | loader 1.0.5 |
| T-12 | `node tests/plugins/injector-r2-a1-r7.test.mjs` 40 PASS | 注入器不回归 |
| **T-13（新）** | **设置页 mode/port 读写生效** + 变更触发重启提示 | **U6-0** |

## 4.3 B 轨验收（v1 缺失，v2 新增）

| 组 | 验收口径 |
|---|---|
| B1/B6–B10（合并类） | **行为等价 + 冲突消失**：合并前后同一场景输出一致；构造「同时命中」断言只生效一次；定时器/处理器数量不重复 |
| B2/B3/B12/B13/B16/B18/B23/B27 | **必须故障注入**（「通过了 ≠ 有效」）：见各项「验证」列，负向断言优先于正向 |
| B3/B4/B5/B17/B25 | **门禁断言**：改一字节 / 加一未登记项 / 改坏一个具名导出 → 必须报红（B3 已用「旧 build 绿 vs 新 build 红」真实对照验证） |
| B19/B20/B21/B22/B24 | **可量化对照**：技能数 62→~40；注入体积下降；**锚定率前后对照**；有缺陷产物被拦下 |
| B11/B14/B15 | 并发/双开断言（第二个让路 / 1 成功 4 pending / profile 未损） |
| B26/B28/B29 | 可注入时钟单测 + 网络故障注入 |

## 4.4 强制要求（三轨通用）

1. **每项必须有回滚路径**，且回滚演练过（或为「新增文件，摘除即恢复」）。
2. **有行为变更的项必须做故障注入**（负向断言）；只跑正向 PASS 不算验收。
3. **证据分级**：报告须标【实测】/【推断】/【未验证】，禁止把推理写成事实。
4. **四件套**：计划/CHANGELOG/当日 memory/`_backups` 齐全才登记 INDEX。

## 4.5 回滚纪律（今日事故教训，**重要**）

> **回滚旧 build 不能用 `promote-build.ps1`**：它的 `smoke-test.ps1` 已随升级改成校验 **0.1.7 形态**，对 0.1.1 构建必然 FAIL，脚本会「回滚到上一个目标」= **把你扔回坏 build**。
> 正确做法：原生 PowerShell 重建 junction（`[System.IO.Directory]::Delete` + `New-Item -ItemType Junction`），再用 `check-dist-integrity.mjs <asar> <lib>` 单独校验。
> 推论：只要「代码库已按 0.1.7 改、运行态仍在 0.1.1」，`smoke-test.ps1`/`verify-patches.ps1` 就会**全线红** —— 那是版本错位，**不是回归信号**。

---

# 第 5 部分 · 风险收益总评估

## 5.1 收益（分轨）

| 轨 | 确定性收益 |
|---|---|
| **U** | 内核追平 0.1.7（+78 包 / 7 项原生修复 / 新 `dsh-client-ui-chat` 渲染架构 / cordis 4.0.4 + loader 1.0.5）；退役 13 项补丁（维护面缩小） |
| **B** | **不依赖升级即可拿到**：坏导入在**构建期**被拦（今日事故类问题归零）、仓库 -97MB、插件重复收敛（43→约 26）、技能锚定率可量化提升、崩溃自带现场、原生恢复消灭「重启打不开」、单操作互斥消除半写状态、归档/下载闸门消除路径穿越与 SSRF、三槽检查点 |
| **A** | 版本身份/签名/离线包/设计系统/REST+Hooks/轨迹/长会话虚拟化 —— 与官方分叉收敛，可扩展性最大 |

## 5.2 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 升级致 GUI 打不开（**今日已发生一次**） | 高 | U6-0 独立验收门槛；旧 build 常驻=一滚回即恢复；**B3 构建期守卫**前置做掉可提前拦截同类问题 |
| 补丁处置错误（A 退役错 / 重写漏） | 中高 | A 组「先注释退役、冒烟后再删」；B 组按官方片段；C 组 EXACT-OK；T-1..T-13 一一对应 |
| C10 canon 覆盖新版 | 高 | 单独最小 diff（只加 no-cache），不整份回灌；gate 重登记 |
| settings 语义变化（mode/port 来源迁移） | 中高 | U6-0 单独批次 + T-13 验收 + 旧 build 回退 |
| 插件合并引入回归 | 中高 | 行为等价对照 + 冲突故障注入；旧插件保留可还原 |
| 多会话并发写 | 中 | `global:*` 锁 + B14/B15 运行时互斥（双保险） |
| 技能裁剪误伤 | 中 | **只归档不删除**，可一键移回（B20） |

---

# 第 6 部分 · 长期架构锚点映射

| 锚点 | U 轨 | B 轨 | A 轨 |
|---|---|---|---|
| **长期运行不出现问题** | 旧 build 常驻回滚 + 冒烟 13 项 | **B3 构建期守卫 / B12 原生恢复 / B13 崩溃现场 / B14 单实例锁 / B16 安全闸门 / B18 检查点** | A1 身份校验（篡改即拒启动） |
| **可维护性** | 退役 13 补丁 + gate 换代 | B4 单一事实源 / B7–B10 重复收敛（43→26）/ B2 原子写统一 / B25 完整性基线 | A8 声明式离线安装 |
| **可迭代性** | 内核追平 + loader 1.0.5 复核（热重载可能真可用） | B3 让「升级 = 一次构建即可判定」/ B17 清单 / B11 测试覆盖 | A4/A5 复用官方 API 与 Hooks 生态 |
| **可扩展性** | 官方原生实现接管 7 项 | B21 技能注入（用户重点）/ B23 审计闸门 / B24 交付闸门 | A3 设计系统 / A6 能力发现 / A7 三级交付 / A11 轨迹 / A12 虚拟化 |

---

# 第 7 部分 · 决策点清单（需用户拍板）

| # | 决策点 | 选项 | **推荐** |
|---|---|---|---|
| D1 | **U6-0 settings 迁移是否现在做** | ① 现在做 → 升级落地 ② 暂缓 → 留在 0.1.1 | **①**（否则 0.1.7 永久不可启动，U 轨全废） |
| D2 | **先做哪一轨** | ① 直接 U6-0 → ② 继续 B 轨免重启项 → ③ 混合 | **①**（**B3 已完成**，原「先 B3 再 U6-0」的第一步已落地 ⇒ 下一步就是 U6-0） |
| D3 | **B20 技能相关性裁剪**（62→~40） | ① 执行（只归档） ② 保守（不裁） | **①**（锚定率相关；可移回） |
| D4 | **B5 判定：目录选择器**（官方 in-app 浏览器替代原生桥） | ① 确认退役 ② 保留重写 | **①**（升级后由 T-2 冒烟校验） |
| D5 | **Windows 签名**（A2） | ① 签名流水线 ② 未签名但文档如实说明 | **②**（成本低、对齐官方「诚实立场」；签名待有证书再说） |
| D6 | **agent-presets 功能去留**（G5 降级后 Windows 守卫缺失） | ① 按 0.1.5 新 API 重写（保功能） ② 维持降级（记缺口） | **②**（先升级过关，专门批次再重做；已记入 U7 复测清单） |
| D7 | **43 插件合并**（B6–B10，43→约 26） | ① 全做 ② 只做 P0 级（B1 模型路由） ③ 分批 | **②→③**（先消 B1 静默错误路由，其余分批） |
| D8 | **B 轨与 U 轨是否交错重启** | ① 每批 B 项做完各自重启 ② 攒批一次重启 ③ 与 U6 合并重启 | **③**（重启次数最少；B 项多为宿主侧插件） |

---

# 第 8 部分 · 归档条件（分轨）

**U 轨**：U0–U7 全绿 + T-1..T-13 全过 + 每阶段 REPORT + 回滚路径 + loader 1.0.5 复核结论。

**B 轨**：所选批次全部完成，且每项 ① 有回滚 ② 有故障注入（行为变更类）③ 门禁全绿 ④ 四件套齐。

**A 轨**：按 D 阶段拍板范围完成，逐项有验收与回滚。

**全局**：`outputs/INDEX.md` 状态全更新；无待重启项（或已由用户重启验收）；`_backups/` 有对应快照。

**当前对话状态**：U0–U5 ✅；U6-0a ✅；**U6-0c ✅（构建中）**；B3 ✅；**下一步：守卫验证 → promote → 用户重启 → 合并验收（冒烟 T-1..T-13 + U6-0b 设置连续性 + U7 收口）**。**不可归档。**

---

# 第 9 部分 · 证据分级与诚实边界

## 9.1 证据分级约定（贯穿全表）

| 级别 | 含义 | 本计划中的例子 |
|---|---|---|
| 【实测】 | 本机文件系统 / 运行态 / npm registry 直接观测 | 所有包版本与导出名、junction 状态、`verify-patches` 结果、技能计数、体积数字 |
| 【推断】 | 由代码/结构推断，未在真实路径复测 | 3 个改道插件「是否真的冲突」（未构造同时命中请求）；「无关技能稀释 catalog 是锚定率崩掉的主因之一」；运行时读打包态而非 vendor 目录 |
| 【未验证】 | 只是计划，尚无证据 | B/A 轨全部未执行项；U6-0 的迁移方案尚未实施；官方 `src/` 实现细节（只读 README） |

## 9.2 未验证项清单（沿用并更新）

1. 3 个改道插件**实际是否冲突** —— 【推断】，B1 的故障注入会验证。
2. 会话能否被 v0→v4 迁移链**无损升级** —— 【未验证】，T-3 + 只读副本预演验证。
3. `apply-startup-resilience-patches.mjs` / `settings-resilience` / `exit-cleanup` 的**实际内容** —— P0-7 已部分查清（settings-resilience 源码级确认），其余待 U7。
4. 官方 `src/` 实现细节 —— 仅读 95KB README。
5. loader 1.0.5 是否修好 internal（R8 的 SKIP 是否可转真可用）——【推断】，U7 实测。
6. B5 目录选择器「退役而非重写」——【推断】，T-2 冒烟校验。
7. B20 裁剪对锚定率的**量化影响** —— 【未验证】，B21 的对照实验给出。

## 9.3 方法论教训（写入本计划，防止重犯）

1. **「通过了」≠「有效」**：验收必须包含负向断言（故障注入）。
2. **拿到吓人的数字先问「应用真的走这条路径吗」**（A0 轮两次自我证伪救场）。
3. **断言一个守卫会拦住某路径前，先把那个守卫读一遍**（R1 轮教训）。
4. **不要用带引号的字面量对 bundle 做文本探针**（rolldown 会规范化引号 ⇒ 假阴性）。
5. **回滚口径必须与被回滚对象的版本期望一致**（今日事故：0.1.7 化的 smoke 脚本对 0.1.1 构建判 FAIL，反而会把坏 build 装回去）。
6. **结构性风险要建在结构里**：任何「收益全部排在某个高风险步骤之后」的计划都是脆的 —— 本版三轨结构即为对策。
