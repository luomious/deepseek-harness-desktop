# DSH Desktop 工作区 · 全面架构与工程审计报告

> ⚠️ **计数口径已过时（2026-09-12 实测修正）**：本文是 **2026-09-07 的审计快照**，其中的「30 本地插件」等计数为当时值。
> 当前实测 = **插件 35 个**（`plugins/` 下 35/35 含 `lib/index.js`）+ 根级 3 个；**skill 顶层 61 个**（hub 源码 94）。
> 复算：`GET http://127.0.0.1:43120/health` · `node scripts/skill-inventory.mjs`。**本文的历史结论与判定保留不动**，仅提醒**计数勿直接引用**。

- 审计日期：2026-09-07
- 审计对象：`D:\Deepseek-Harness`（DSH Desktop v2.0.2 壳 + 30 本地插件 + 3 根级守护 + 108 脚本 + 补丁体系）
- 上游基线：`@deepseek-ai/dsh@0.1.1-rc.2`（upstream.json pin `b150a551`），Electron 43.4.0
- 方法：5 路并行只读调研（插件生态 / 安全 / 工程化 / 韧性 / 现场核实）+ 主审对关键结论的独立复核
- 说明：代理调研中"stuck-loop-guard / context-lifecycle 为空壳目录"一条经主审实测**证伪**（实为 316 / 455 行完整实现，含 node_modules），已剔除

---

## 〇、一句话总评

**这是一个"工程化意识极强、但把复杂度押在补丁与外挂守护上"的成熟单机系统。**

它已经越过了"能不能用"的阶段，处于 **1→N 的技术债务偿还期**：可观测性、原子写、锁回收、变更纪律均达到企业级水准；但**补丁体系（8 个整文件替换 + 10 个脚本注入）、测试门禁（0 集成/E2E）、规范工具链（无 ESLint/Prettier/husky）** 三处短板，决定了它目前**不具备"低成本长期演进"的能力**——每升级一次上游，就要付一次"升级税"。

---

## 一、成熟度评分卡

| 维度 | 评分 | 依据（证据） |
|---|---|---|
| **架构设计** | ★★★★☆ 8.0 | Cordis 插件总线 + 三层配置叠加 + bundle/patch 双通道，解耦干净；但 `runAsNode:true` 是架构性妥协 |
| **功能完整度** | ★★★★☆ 8.5 | 30 插件覆盖文件/视觉/路由/会话/运维/搜索，自给自足程度高 |
| **代码质量** | ★★★☆☆ 6.0 | 注释中文质量好、原子写工具化；但 9732 行单文件、shared-utils 复用率仅 3/30、裸 catch 26+ 处 |
| **安全性** | ★★★☆☆ 6.5 | 壳层★★★★★（全 sandbox+contextIsolation+loopback 三层强制）；插件层★★★☆☆；供应链★★☆☆☆ |
| **可维护性** | ★★★☆☆ 5.5 | 文档 48 篇质量高；但补丁整文件替换 + 50 个一次性脚本 + 硬编码路径是三大债务 |
| **可扩展性** | ★★★★☆ 7.0 | 插件化彻底、新增功能成本低；但双装配通道（bundle/patch-insert）是扩展时的认知负担 |
| **可迭代性** | ★★★☆☆ 5.0 | **最大短板**。补丁无自动 rebase、CI 只做 `node --check`、无类型门禁 → 改动风险高、回归靠人肉 |
| **长期运行稳定性** | ★★★☆☆ 6.0 | 守护齐全但多为"通知型"非"动作型"；主进程无看门狗；`~/.dsh` 已 1.3GB 无回收策略 |
| **工程化/测试** | ★★☆☆☆ 4.0 | 9 个单测 / 30 插件；CI 仅语法检查 + unit；无 lint / 无格式化 / 无 hook / 无 E2E |
| **文档治理** | ★★★★☆ 7.5 | 48 篇文档 + INVENTORY 单一事实源 + 事故复盘诚实（v6.4 失误记录）业界少见 |

**加权综合：6.4 / 10** —— 高于业余项目，低于可团队化协作的生产系统。

---

## 二、架构评估

### 2.1 分层（清晰，值得肯定）

```
Electron 壳 (vendor/)          ← 安全基线教科书级
  └─ Cordis Host（内嵌 DSH 内核）  ← 无独立子进程，省一层 IPC
       ├─ 官方 bundle 层（@deepseek-ai/dsh-*）
       ├─ profile bundle 层（37 个）
       └─ patch-insert 层（8 个本地插件）
            └─ 本地插件 plugins/（link: 装配）
```

**优点**：Cordis 的 `inject` 依赖声明 + `ctx.effect` 自动 disposer，天然支持热插拔与卸载还原，这是比大多数 Electron 应用先进的架构选择。

**隐患（架构级）**：

| 问题 | 证据 | 影响 |
|---|---|---|
| `electronFuses.runAsNode: true` | `package.json:296-298` | Electron 官方安全基线要求熔断此项。当前 `electron.exe` 可被 `ELECTRON_RUN_AS_NODE=1` 驱动执行任意 JS，绕过 asar 完整性 |
| 双装配通道长期并存 | `docs/PLUGIN-STANDARDIZATION.md:13-20` | bundle 27 + patch-insert 8，历史爆发过 3 次"双装配冲突"事故；新插件作者极易踩坑 |
| 插件无完整性校验 | `~/.dsh/profiles/desktop/package.json:11-27` 全 `link:` 本地路径 | 无签名/hash，任何能写 `plugins/` 的代码（含被 prompt injection 诱导的 agent）下次启动即 RCE |
| 硬编码绝对路径装配 | 同上，`link:D:\Deepseek-Harness\...` × 30 | 换机器/改盘符即全链路失效，不可复现构建 |

**一个实测发现的一致性缺陷**：
```
"@dsh-external/dsh-self-maintenance": "link:D:\\\\Deepseek-Harness\\\\plugins\\\\dsh-self-maintenance"
```
该项是**四反斜杠**（JSON 双重转义），其余 30 项均为双反斜杠。当前能工作，但任何重写该文件的工具都会产生不一致，且是"曾经被某脚本二次转义"的痕迹 —— 建议统一。

### 2.2 与上游/官网的对照

| 项 | 本项目 | 上游现状 | 差距 |
|---|---|---|---|
| 内核版本 | `0.1.1-rc.2`（100+ 包精确锁版） | **v0.1.2-rc.1 已发布** | 落后一个 RC |
| 桌面壳 | v2.0.2，分支 `prod-baseline-20260823`（HEAD `0f5ae64`） | 有远端 `luomious/prod-baseline-20260823` ✅ | 已解决"无远端"历史 P1 |
| profile 模板 | 44 deps / 37 bundles | 运行态 44 / 37 | **已对齐** ✅（P1-C3 已修复） |
| 会话格式 | v1 | **v0.1.2 升级至 v2，persistence API 破坏性变更** | ⚠️ 升级即炸（见 §7） |

---

## 三、功能与插件生态

### 3.1 现状：30 + 3 插件，覆盖度很高

`plugins/INVENTORY.md` 是**单一事实源**，质量在个人项目里罕见（含装配方式、热重载安全性、用途三列）。功能覆盖：文件浏览、图表渲染、视觉引擎、模型路由/白名单/分级、会话卫生/看门狗/历史、实例清道夫、自检守护、任务调度锁、远程工作区、本地搜索/抓取、技能管理、UI 性能 —— 已经是一个**自洽的桌面 Agent 工作台**。

### 3.2 问题

| 严重度 | 问题 | 证据 |
|---|---|---|
| **高** | `dsh-routing-suite` 是 vendored 外部仓库，`injector/lib/index.js` **9732 行单文件** | 全仓最大可维护性风险点；且是独立 clone（非真 submodule），钉扎形同虚设 |
| **高** | 关键配置/安全补丁文件**非原子写** | `dsh-host-services/lib/index.js:205`、`dsh-modlens-guard/lib/index.js:152,173` 直接 `writeFileSync`；崩溃即永久损坏（2026-08-29 原子写事故同型） |
| **中** | shared-utils 复用率仅 **3/30** | `dsh-host-services/lib/shared-utils.js` 提供 `registerRouteWithRetry`/`createDedupNotifier`，但仅 hygiene/janitor/maintenance 用；另有 5 插件各自重写样板（`file-explorer:318`、`model-whitelist:136`、`remote-workspace:719`、`skills-manager:294`、`vision-engine:885`） |
| **中** | 前端 `client.js` 裸 fetch 无超时 | `file-explorer/client.js:22`、`model-picker-group:115`、`skills-manager:10`、`vision-engine:245`、`model-whitelist:326` —— 弱网/服务挂起即 UI 假死 |
| **中** | 定时器/句柄未清理 | `system-notify/client.js:85` keepAlive 无 clear；`model-picker-group/client.js:358`；`session-hygiene/index.js:267` 自调度链无 abort |
| **中** | 过度吞异常 | `force-reasoning-effort` 14 处 `catch {}`（含 L219 业务失败）、`command-guard` 12 处、`host-services` 自身 6 处 |
| **低** | 15/30 插件无 README | — |
| **低** | 构建残留入库 | `host-services/lib/.shared-utils…tmpdir/`、`modlens-autoread/test/…tmpdir/`、`skills-manager/_backups` |
| **低** | 根级 3 守护插件不在 `plugins/` | 违反"自家规范"，新接手者必踩 |

### 3.3 已修好的历史 P1（本次核实确认 ✅）

- `file-explorer` 默认仅 `~` 目录（`lib/index.js:302-309`，`DSH_FILE_EXPLORER_UNRESTRICTED=1` 才放开）✅
- `spawn-trace.log` 调试残留已清零 ✅
- vendor 仓已有远端 ✅、profile 模板已回灌对齐 ✅
- task-scheduler 死锁懒回收（`core.js:88-94`）✅ —— 这是长期运行的优秀设计
- `dsh-context-lifecycle`（455 行，token 压力→自动 compact/新会话决策）、`dsh-stuck-loop-guard`（316 行，失败签名检测+分级注入）**实现完整且质量高** ✅

---

## 四、安全性

### 4.1 做得极好的（壳层）

1. 全窗口 `contextIsolation:true` + `nodeIntegration:false` + `sandbox:true` + `webSecurity:true`（`window-options.ts:33-36,69-72`）
2. preload 仅暴露 `getPathForFile`（`preload.ts:6`），攻击面极小
3. loopback 三层强制（`webserver.ts:29-31` 非 127.0.0.1 直接抛错）
4. 日志密钥脱敏（`mask-secrets.ts:1-62`，覆盖 `sk-`/Bearer/Basic/URL 凭据）
5. 自研路由统一 `trusted()` 同源守卫范式
6. 历史 P0（内核 WS 无鉴权）经实测已被上游 `isTrustedApiRequest()` 栅栏阻断（P0 降级）

### 4.2 风险清单

| 级别 | 风险 | 证据 | 建议 |
|---|---|---|---|
| **High** | `runAsNode:true` 未熔断 | `package.json:296-298` | 评估 sandbox trampoline 是否真需要；若必需，改用一个独立的小 node shim 而非主 electron 二进制 |
| **High** | 插件无签名/hash 校验，super-injector 对本地源码 `eval/new Function` | `profiles/desktop/package.json:22`（`file:...tgz`）；`docs/archive/自检与安全审计.md:25` | 加 SHA-256 白名单 + 加载前静态扫描；把 `plugins/` 移出 agent 可写范围 |
| **Medium** | 业务路由无统一 CSRF token，仅设置路由做 Origin 校验 | `desktop-settings-route.ts:38-72` 有，其余无 | 全路由统一 origin 白名单 + 随机 token |
| **Medium** | agent 命令执行无默认 allowlist | `windows-pwsh-sandbox.ts:71-93`（argv 传递，无 `shell:true` ✅，但无白名单） | 默认启用 `dsh-command-guard` 白名单模式 |
| **Medium** | 补丁覆盖上游安全修复风险 | `verify-patches.ps1:9` `$ErrorActionPreference='SilentlyContinue'` | 改 Stop + 显式捕获；补丁登记时附"上游 CVE 影响"说明 |
| **Low** | 凭据明文落盘 | `~/.dsh/settings.yaml`、`hy3-gateway/apikey.local.txt` | 接入 Windows DPAPI |
| **Low** | `adm-zip ^0.6.0` 历史 zip-slip 类问题；无 `npm audit` 例行 | `package.json:244` | 接入 Dependabot + 定期 audit |

---

## 五、自我修复与长期运行（用户最关心）

### 5.1 韧性能力矩阵

| 机制 | 覆盖 | 证据 | 评级 |
|---|---|---|---|
| 启动自愈 ZombieCleanup | 有 | `~/.dsh/super-injector/self-heal.log`（86KB） | B |
| 僵尸/旧实例清道夫 | 启动+每小时，白名单杀 crashpad/旧网关 | `instance-janitor/lib/index.js:181-191` | B |
| 锁过期自动回收 | TTL + pid 存活 + MAX_LOCKS 512 | `task-scheduler/lib/core.js:88-94,173-179` | **A** |
| 会话卫生监控 | >4MB 提醒 / >8MB 告警，**只观测不删** | `session-hygiene/lib/index.js:13-19` | C |
| 磁盘监控 | <5GB warn / <2GB error | `self-maintenance/lib/index.js:274-278` | C |
| 卡死循环守卫 | 失败签名检测 + 分级注入 | `dsh-stuck-loop-guard/lib/index.js:198-272` | **A** |
| 上下文生命周期 | token 压力→compact/新会话决策 | `dsh-context-lifecycle/lib/index.js:61-78` | **A** |
| 命令风险拦截 | pre-execute 评分 | `command-guard/lib/index.js:176-196` | A |
| **主进程崩溃自动重启** | **无** | 全仓无 watchdog | **D** |
| **日志全局轮转** | **部分** | 见下 §5.3 | **D** |

### 5.2 长期运行最可能出问题的场景（按 概率×影响 排序）

1. **主进程崩溃无人拉起**（高×致命）—— 唯一 SPOF，无自愈闭环。Electron 不自带，需外部任务计划/服务看门狗。
2. **`~/.dsh` 已膨胀至 1.3GB 且无回收策略**（高×中）
   - 实测：`profiles` 783M（desktop 656M + web 127M）、`sessions` 372M、attachments 50M、storages 40M
   - 单项目会话 `--D-Deepseek-Harness--` 已达 **249M**，而 session-hygiene 只按**单文件** >4MB 判定，**不做目录聚合** → 249M 会话永不触发告警
   - 归档需手动 `archive-big-sessions.ps1`
3. **日志无轮转，正在实时增长**（高×中）
   - 实测：`super-injector/dsh-force-reasoning-effort.log` 570KB（23:34 仍在写）、`model-tier-router.log` 443KB、`session-watchdog.log` 189KB（00:34 仍在写）
   - 仅 instance-janitor(256KB) / command-guard(1MB) 有轮转，**super-injector 目录整体无轮转**
4. **升级后补丁失效复发**（中×高）—— `patches/bundles/dsh-session-persistence-jsonl-index.js` 是 **57KB 整文件替换**，上游一改即作废
5. **provider 故障不切换**（中×中）—— `model-provider-failover` 默认 `fallback:{}` no-op，冷却态重启清零
6. **modlens 视觉链静默失效**（中×中）—— guard/autoread/picker-group/vision-engine 靠 aria-label 字符串 + 路由名隐式联动，无版本化契约，任一改名即静默失效
7. **settings/profile 并发写竞态**（低×致命）—— task-scheduler 锁是 **opt-in**，deregister/startup-verify 未强制持锁；2026-08-29 原子写事故可重演
8. **旧代无窗口 DSH 进程堆积**（中×高）—— janitor 对非白名单旧进程只 `reported` 不杀
9. **GUI 卡顿只通知不恢复**（中×中）—— self-maintenance 连续 3 次失败仅弹"建议重启"
10. **磁盘耗尽**（低×致命）—— 磁盘监控阈值 5GB/2GB，但项目自身数据增长无上限，两者不联动

### 5.3 90 天无人干预还缺什么

- [ ] 外部进程看门狗（崩溃/无响应自动拉起主进程）
- [ ] 真自愈动作层：目前守护**几乎全是"通知型"**，缺"自动清磁盘 / 自动归档 / 自动重启"
- [ ] 全局日志轮转（统一到 `~/.dsh/logs/` + 大小/天数双阈值）
- [ ] `~/.dsh` 配额与清理策略（sessions 按目录聚合 + 自动归档；profiles 清理；attachments TTL）
- [ ] 写锁强制化（所有 profile/settings 写入路径经 task-scheduler）
- [ ] 启动自愈钩子：启动时跑 `verify-patches`，缺失自动重打

---

## 六、工程化与测试

| 项 | 现状 | 证据 | 评级 |
|---|---|---|---|
| 单元测试 | 9 个 `.mjs`，覆盖约 8/30 插件 | `tests/plugins/` | D |
| CI | 仅 `node --check` + `node --test` | `.github/workflows/check.yml:17-27` | D |
| 类型门禁 | 无（插件有 tsconfig strict 但 CI 不跑 tsc） | `check.yml` 未含 tsc | D |
| ESLint / Prettier / EditorConfig | **根工作区全部缺失** | 根目录无配置文件 | F |
| git hooks / husky / commitlint | **无** | `.git/hooks` 无自定义 | F |
| E2E / Playwright | 仅 diagram-renderer 一处，可跳过 | `check-all.ps1:128-147` | D |
| 真启动冒烟 | **无**（smoke 强制 `-SkipRuntime`，startup-verify 只做语法检查） | `promote-build.ps1:111`、`startup-verify.mjs:239` | D |
| 构建可重复 | 中（junction 换版 + 回滚完善，但路径硬编码 + 代理硬编码） | `package-vendor.ps1:7-8,10-15` | C |
| 补丁治理 | 8 个 bundle 有 SHA-256 MANIFEST；但**另有 ~10 个 apply-*.mjs 脚本补丁未登记哈希** | `patches/bundles/MANIFEST.md` | C |

**补丁体系的根本问题**（最重要的一条）：

`verify-patches.ps1:63-71` 用 `Select-String -SimpleMatch` 做**子串匹配**校验 —— 即"marker 字符串存在即 PASS"。这意味着：
- marker 在但语义损坏 → 仍 PASS（假成功）
- 上游改动使补丁逻辑失效但保留 marker → 仍 PASS
- 项目自己就吃过这个亏（`port-user-patches.mjs:52` 注释承认曾 "rebuild silently lost"）

**结论：补丁体系目前是"能发现问题、但发现不了最危险的那种问题"的状态。**

---

## 七、上游升级风险（战略级）

上游已发布 **v0.1.2-rc.1**，含**会话格式升级至 v2、Session persistence API 破坏性变更**。而本项目：

1. 100+ 个 `@deepseek-ai/*` 包精确锁在 `0.1.1-rc.2`
2. 有一个 **57KB 整文件替换**的补丁正打在 `dsh-session-persistence-jsonl/index.js` 上（zstd 异步解压修复）
3. 另有 7 个 bundle 补丁整文件替换客户端 UI 产物

**→ 升级 0.1.2 时，这 8 个补丁几乎必然全部失效，且会话格式 v2 与现有 372M 历史会话存在兼容断层。**

这是当前**最高优先级的战略决策点**，而非技术问题。

### 三个选项

| 方案 | 做法 | 成本 | 风险 |
|---|---|---|---|
| **A. 冻结** | 永久锁 0.1.1-rc.2，自维护安全补丁 | 低（短期） | 安全修复无法回流，债务随时间线性增长 |
| **B. 回流**（推荐） | 把 8 个补丁整理成 upstream PR，逐步消除 | 中（一次性高） | 上游接受周期不确定，需维护 fork 过渡 |
| **C. 跟随** | 跟 0.1.2，每次重做补丁 | 高（每次） | **升级税**，且会话迁移风险 |

**建议：走 B，以 A 为过渡。** 先把最有把握的 2-3 个补丁（zstd 异步解压、目录选择器）提 PR，剩下的维持 fork；同时把补丁从"整文件替换"重构为"最小 diff + 运行时 monkey-patch"，把升级冲击面从 100% 降到 5%。

---

## 八、冗余度与债务清单

| 类别 | 数量/体积 | 处置 |
|---|---|---|
| 一次性调试脚本（未跟踪） | ~50 个（`check-*.py/ps1`、`deep-diag.ps1`、`final-diag.py`、`test-v7.py`、`read-*.ps1` 等） | 迁入 `tools/`（已 gitignore）或删除 |
| `_backups/`（工作区） | 71MB / 103 项 | 已大幅改善（历史 4.56GB/22.8万），补 TTL 策略 |
| `~/.dsh` 运行时 | **1.3GB** | 见 §5.2 |
| 重复 HTTP 客户端（SSRF 守卫） | `web-fetch-local` 与 `web-search-bing` 几乎逐行复制（含 DNS-rebinding TOCTOU 修复） | 高风险收敛，需单独评审（HANDOVER 已登记 P3） |
| 重复 log helper / 原子写 | tier-router / failover / janitor / task-scheduler / hy3 各一套 | P3 收敛 |
| 根 `package.json` 与 vendor 副本 | 同构重复，根侧不可运行 | 明确标注或删除 |
| 硬编码路径 | 历史记录 55 处，已修 6 处 | 剩余需批量扫描 |

---

## 九、改进路线图（按 ROI 排序）

### P0 —— 战略决策（本月内定方向）

1. **上游策略定案**：选 A/B/C（推荐 B+A 过渡）。在动任何代码前先定，否则所有重构都可能白做。
2. **补丁体系减害**：8 个整文件替换 → 最小 diff / 运行时 patch 层；`verify-patches` 从子串匹配升级为 SHA-256 + 关键行为断言。

### P1 —— 3 个 Sprint 内（直接提升"长期不出问题"）

| # | 事项 | 预期收益 |
|---|---|---|
| 3 | **外部看门狗**：任务计划/服务监控主进程，崩溃自动拉起 | 消除唯一 SPOF |
| 4 | **全局日志轮转**：统一 `~/.dsh/logs/`，大小+天数双阈值，覆盖 super-injector | 防磁盘耗尽 |
| 5 | **`~/.dsh` 配额治理**：sessions 按**目录聚合**告警 + 自动归档；attachments TTL | 1.3GB → 可控 |
| 6 | **写锁强制化**：profile/settings 所有写入经 task-scheduler | 防 2026-08-29 事故重演 |
| 7 | **非原子写清零**：`host-services:205`、`modlens-guard:152/173` 改 tmp+rename | 防配置永久损坏 |
| 8 | **前端 fetch 统一超时**：抽 `clientFetch()` 带 AbortController + 重试 | 防 UI 假死 |
| 9 | **CI 升级**：加 `tsc --noEmit` + lint + 真启动冒烟（launch→wait→assert） | 从"能编译"到"能跑" |
| 10 | **规范工具链**：根加 ESLint + Prettier + EditorConfig + husky pre-commit | 可维护性质变 |

### P2 —— 季度内

11. shared-utils 复用率 3/30 → 20/30（退避注册、去重通知、log、原子写、HTTP client）
12. `dsh-routing-suite` 9732 行拆分（先按职责切成 5-8 个模块，不动行为）
13. 双装配通道收敛为单通道（每迁 1 个重启验证）
14. 15 个无 README 插件补齐 + 30 个插件补纯逻辑单测（先补 tier-router/failover/hygiene）
15. 根级 3 守护插件移入 `plugins/`
16. 构建残留 / 50 个一次性脚本清理
17. 插件完整性校验（SHA-256 白名单）

### P3 —— 有机会再做

18. `runAsNode` fuse 熔断改造
19. 凭据 DPAPI 加密
20. modlens 视觉链契约文档化（防静默失效）
21. 路由三件套（tier-router / router-standard / force-reasoning）组合语义文档化

---

## 十、结论

**这个项目最值得肯定的不是代码，而是工程纪律**：48 篇文档、`INVENTORY.md` 单一事实源、事故复盘诚实记录自己的判断失误（v6.4）、每次改动先 acquire 锁再备份再原子写再验证 —— 这些习惯在个人项目里非常罕见，也是它能长期跑下去的真正原因。

**最需要警惕的是"补丁依赖"**：目前系统有 18 个补丁点、10 个守护插件在对抗上游的不稳定与自身的历史缺陷。这套机制在过去 2 个月救了它很多次，但**它的成本随上游迭代线性增长，且失败模式是"静默"的**。在上游已经发布 0.1.2 破坏性变更的当下，这是必须正面处理的战略问题，而不是继续打补丁能绕过去的。

**一句话建议**：先把"上游策略"和"补丁减害"两件事定下来，再谈其他优化 —— 否则所有重构都可能在上一次升级中作废。

---

*本报告基于只读调研，未修改任何文件。所有结论均附文件路径与行号证据。*
