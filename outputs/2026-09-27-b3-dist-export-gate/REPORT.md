# B3 打包态具名导出守卫 · 落地报告（`verify-dist-exports.mjs` + check-all Step 1.18）

> 日期：2026-09-27 ｜ 性质：**代码落地 + 真实故障注入验证**（免重启）
> 关联：`outputs/2026-09-27-incident-0.1.7-startup-crash/report.md`（今日事故）、`outputs/2026-09-27-master-plan-upgrade-and-learning/PLAN.md` v2 轨道 B / B3
> 触发：用户「先做好分析和调查，确定文档都完整后执行下一步」⇒ 调查发现 B3 需**修正后再做**，随后落地。

---

## 1. 调查结论（先纠正计划，再动手）

| # | 调查发现 | 影响 |
|---|---|---|
| **1** | 仓库**已有** `scripts/verify-plugin-imports.mjs`（`check-all.ps1` **Step 1.11**，2026-09-10 F14） | v2 初稿写「新增 verify-bundle-imports.mjs」会**重复造轮子** |
| 2 | Step 1.11 的规则是**说明符纪律**：只允许 `node:*`、`@deepseek-ai/*`（**视为宿主提供，完全不检查导出名**）、`react`、自身相对文件 | 它**结构上不可能**发现今日问题 |
| 3 | `check-dist-integrity.mjs` 只校验 lib/main.js 的**相对**导入是否存在 | 裸包导入不在其射程 |
| 4 | `verify-runtime-closure.mjs`（`yarn verify:closure`）只校验依赖图**闭合** | 与导出名无关 |
| 5 | `tsc`（skipLibCheck 已开）只看我们自己的源码 | 已发布包内部缺陷不可见 |

⇒ **B3 的真实缺口是「具名导出存在性」**，而不是「导入能否解析」。据此把 B3 从「新增解析守卫」修正为「**新增链接期具名导出守卫，与 Step 1.11 互补**」：1.11 管「能不能依赖它」，新守卫管「依赖的名字还在不在」。

---

## 2. 技术可行性先验证（探针实验，**先验证探针本身**）

在写正式脚本前，先用最小实验确认机制（`C:\Temp\dsh-probe-exports.mjs`）：

| 实验 | 结果 | 结论 |
|---|---|---|
| 缺失具名导出时 `link()` 的行为 | `SyntaxError: The requested module './index.js' does not provide an export named 'SettingsProvider'` | **与运行时崩溃原文一致** ⇒ 可静态复现 |
| 存在的具名导出 | link 通过 | 无假阳性 |
| 被导入模块有副作用（`throw`） | link **未执行**模块体 | **安全**：不跑代码 |
| `Object.keys(module.namespace)`（link 后、evaluate 前） | `ReferenceError: Cannot access 'A' before initialization` | **不能靠读 namespace 取导出名** ⇒ 只能靠 V8 的链接期校验 |
| `export * from` 一个 default-only 模块 | OK，keys=`[]` | 语义符合预期 |

---

## 3. 交付物

| 文件 | 变更 |
|---|---|
| `scripts/verify-dist-exports.mjs` | **新增**（约 340 行）。对 `resolve-dist.mjs` 选出的**最新 build**（即将 promote 的那个）的 `resources/app.asar.unpacked/lib/*.js` 逐个 `link()`；解析器支持 `node_modules` 上溯、`exports`/`module`/`main`、包 `type`、相对路径补扩展名 |
| `scripts/check-all.ps1` | **新增 Step 1.18**（含问题背景注释；PS 5.1 ASCII 注释；`$totalFail` 累计） |
| `outputs/.../PLAN.md`（v2） | B3 标注 ✅ 已落地 + 修正条目；新增 §2.4「新发现与口径订正」（N1–N4）；决策 D2/验收口径/重启清单同步 |

---

## 4. 验证（**真实故障注入，非人造**）

用 dist 里两个真实 build 做对照——比伪造一个坏导入更有说服力：

| 目标 | 结果 |
|---|---|
| `win-unpacked-build202608272104`（内核 **0.1.1**，已知可用） | **PASS / exit 0**：`47 lib modules, 47 linked clean`；替代量如实上报 `COMMONJS_TARGET=18 UNRESOLVED=3`（不假装全绿） |
| `win-unpacked-build202609271840`（内核 **0.1.7**，启动崩溃） | **FAIL / exit 1**，4 项 `MISSING_EXPORT`：<br>• `lib/main.js` → `'SettingsProvider'`（进口方 `bin.js`）<br>• `lib/profile-dWJ_zWhP.js` → `'SettingsProvider'`（进口方 `main.js`）<br>• `lib/profile.js` → `'SettingsProvider'`（**无其他文件引用**）<br>• `lib/windows-agent-presets.js` → `'PresetExistsError'`（**无其他文件引用**） |

**首 3 项 = 今日事故原文**（`@deepseek-ai/dsh-settings` 0.1.7 删除了 `SettingsProvider`，`dsh-settings-file@0.1.5-rc.3` 仍在 import）⇒ **守卫若早存在，这次崩溃会在门禁/打包阶段被拦下**。

### 新发现 N1：陈旧产物仍在发布

`lib/windows-agent-presets.js` 引用 `@deepseek-ai/dsh-agent-presets` 已删除的 `PresetExistsError`，且**不被任何其他 lib 文件引用** —— G5 只把**源文件**排除编译，**旧产物仍随 build 打包**。守卫输出已用 `(not referenced by any other lib file - stale artifact?)` 标出。
**处置待拍板**：删除该产物，并在打包/清理环节加一条「excluded 源不得残留产物」的断言。

---

## 5. 已知边界（不假装全绿）

- **CommonJS 目标不可静态验证**：Node 用 cjs-module-lexer 在运行时合成具名导出 ⇒ 守卫对这类目标使用「按引用方实际请求的名字」生成的占位模块，**并把数量如实上报**（旧 build：`COMMONJS_TARGET=18`）。这意味着 CJS 侧的「导出名被删」仍需运行时/上游保证。
- **`electron` 等宿主专有请求**：记为 `UNRESOLVED`（旧 build 3 条），不阻断校验其余图。
- **只覆盖 `app.asar.unpacked/lib/`**：插件侧 bundle 由既有 Step 1.11 + 各插件自测覆盖；后续可扩到 `plugins/*/lib`（属 B3 的扩展项，未做）。
- **门禁当前会红**：dist 里最新 build 仍是被 U6-0 阻塞的 0.1.7 ⇒ Step 1.18 红是**守卫生效的证据**，U6-0 修好后自然转绿。**这同时给了 U6-0 一个现成的验收器。**

---

## 6. 回滚

- 删除 `scripts/verify-dist-exports.mjs` + 移除 `check-all.ps1` 的 Step 1.18 块（`check-all.ps1` 的改动在 git 工作树内，可 `git checkout`）。
- 无运行时影响（纯门禁脚本，不参与打包与应用启动）。

---

## 7. 证据分级

| 断言 | 级别 |
|---|---|
| 旧 build PASS / 新 build FAIL 4 项（含报错原文与文件）| 【实测】本机运行输出 |
| Step 1.11 / check-dist-integrity / verify-runtime-closure 的覆盖范围 | 【实测】读码 |
| 「若早存在即可拦住本次事故」 | 【推断】（机制一致：同为 V8 链接期校验；但未在打包流水线上实测阻断，因为 build 已完成） |
| 陈旧产物不影响启动（无人引用） | 【推断】仅静态引用分析，未在 Electron 内实测 |

---

## 8. 门禁集成验证（`check-all.ps1` 全量运行，含归因）

**运行结果：`CHECK-ALL: 4 FAILED` / exit 4**（在**沙箱内**由本轮执行；见下方归因）

| # | 失败项 | 归因 | 判定 |
|---|---|---|---|
| 1 | **Step 1.18 `dist export gate (1)`** → 4 violations | 目标＝dist 里**最新 build**（`build202609271840`，0.1.7），它正是被 U6-0 阻塞的那个 | **✅ 预期内**（守卫生效的证据，U6-0 修好后必须转绿） |
| 2 | Step 1.12 `unregistered runtime changes (1)` | **沙箱伪影**：`node` 内 **`spawnSync git EBUSY` / EPERM** ⇒ 该步无法真正执行基线与工作区比对 | **【实测】重跑即绿**：按脚本指引 `git status --porcelain --untracked-files=all \| node scripts/check-unsupervised.mjs --stdin` → **REGISTERED=28 DRIFTED=0 UNREGISTERED=0**，本轮两处改动均已登记（`scripts/check-all.ps1` / `scripts/verify-dist-exports.mjs` ← `session:b3-dist-export-gate`） |
| 3 | Step 3 `unit tests exited with code 1`（`fail 18`） | 【推断】**沙箱伪影**：失败项全为 `deregister-plugin` / `register-plugin` / `scan-dangling` 系列（这些用例需要 spawn 子进程与写文件）；同一次运行的 Step 1.5 health-check 已明确报 `spawnSync node.exe EBUSY`（env-blocked），部分用例也被标注 `SKIP spawn 不可用（EBUSY）` | **待复测**：需在**真实终端**（非沙箱）重跑以确认 |
| 4 | Step 2.6 `patch drift detected (bundle ready, target missing markers)` → `perf5-session-decode-streaming (dist:out-of-sync, dev:out-of-sync)` | **非本次引入**：本轮改动仅「新增一个门禁脚本 + check-all 增加一步 + 文档」，未触碰 `patches/`、`dist/`、任何 `apply-*.mjs` | **pre-existing，留待独立处置**（脚本给出的修法是 `node scripts/patch-apply.mjs apply` —— 会**写入 dist**，且当前最新 build 是坏的 0.1.7，**现在不能执行**） |

**结论**：本轮改动本身**没有引入任何新失败**；`check-all` 需要在**真实终端**上复跑一次以获得干净基线（沙箱内至少 2 项属环境限制）。
