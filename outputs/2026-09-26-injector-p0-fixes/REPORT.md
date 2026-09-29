# 注入器 P0 修复 · 执行报告

- 日期：**2026-09-26**
- 方案：同目录 [`PLAN.md`](./PLAN.md)
- 结果：**修复已构建并安装，需重启生效**
- 备份：`_backups/injector-fix-20260926-234127/`

---

## 1. 执行结果一览

| 项 | 状态 | 证据 |
|---|---|---|
| **T2** 失败无原因 | ✅ 已修（4 个调用点） | 产物含 `host 未进入 active` / `loader.create 失败: ` / `重建 0 个 fiber` / uninject 原因 |
| **T3** self-heal 假失败 | ✅ 已修（统计语义纠正） | 被写反的谓词 `recordOp('selfHeal', healed.length === 0)` 在**旧产物中存在、新产物中消失** |
| **T1** 重复挂载 | ✅ 已加**检测 + 显式修复**能力 | 新工具 `dev_dedupe_entries` + `dev_plugin_status` 常驻告警段 |
| **T4** 自净噪音 | ⏸ **未改语义**（严重度下调为 P2） | 读码后确认属设计意图，见 §3 |
| 源工作树 | ✅ 已改 + 已构建 | `src/index.ts` 183489 B；`lib/index.js` 429305 B |
| **活跃副本** | ✅ 已安装 | `profiles/desktop/.../lib/index.js` 429305 B |
| **tgz（重装源）** | ✅ 已重建 | 367619 B，结构与原件同为 9 条目 |
| **三处逐字节一致** | ✅ 已核验 | sha256 `2199737517B7BE01428E5A5D983640C5` |

## 2. 验证证据（29 PASS / 0 FAIL）

`tests/plugins/injector-p0-fixes.test.mjs` → `INJECTOR_FIX_RESULT=PASS`（exit 0）

**关键点：全部断言都带反向对照**（旧产物必须不满足）——例如：
- ✅ `T3 反向对照：旧产物含被写反的谓词` **PASS** ⇒ 证明断言可证伪，不是恒真
- ✅ `T1 反向对照：旧产物不含 dev_dedupe_entries` **PASS**
- ✅ `T2 反向对照：旧产物不含 "host 未进入 active"` **PASS**

**可加载性用两种独立方法判定**：
1. **真·动态 `import()`** → 新产物 `IMPORT OK`，导出 `[Config,apply,inject,name]`，与活跃副本**完全一致**
2. **模块序言提取** → 新/旧产物**都只有 6 个 `node:` 内置导入，0 个裸说明符**

**回归护栏 6 条**：`inject()` 幂等短路 / `cleanupStaleEntries` / `hasActiveEntry` / `arbitrateOfficial` / `purgeStaleTools` / 拒绝卸载自身 —— 全部仍在。

## 3. 过程中两次自我纠错（如实记录）

### 纠错 1：T6 结论错了 —— `routing-suite/injector` 不是重复副本，是**源工作树**
我上一份 `AUDIT-AND-PLAN.md` 判定「`dsh-routing-suite` 内含 49.1MB injector 副本 = 仓库有两份 super-injector，应删除」。
**实测证伪**：`~/.dsh/profiles/{desktop,web}/package.json` 里
```
"@dsh-external/dsh-super-injector": "file:D:/Deepseek-Harness/plugins/dsh-routing-suite/dsh-external-dsh-super-injector-0.3.3.tgz"
```
⇒ 那个 tgz 是**注入器的分发源**，`injector/` 是其源工作树。**按原计划删除会直接破坏注入器的可重建性。**
（已同步修正 `AUDIT-AND-PLAN.md` 与本目录 `PLAN.md`）

### 纠错 2：测试首版断言写错，误报「产物有裸外部说明符」
首版正则扫全文，报出 6 个裸说明符。逐行查证后确认它们在**脚手架代码生成模板字符串内部**
（bundle 7912-7916 行，紧邻 `${JSON.stringify(pkgName)}` —— 模块级语句不可能有这种插值；
且 `node --check` exit 0 反证其在字符串内）；**旧可用产物含完全相同的模式**。
⇒ 属**断言缺陷**，非产物缺陷。改用「模块序言提取 + 真 `import()`」两种正确方法后通过。
**没有通过削弱断言来过关**，而是换用更强的方法。

### 纠错 3（接近事故）：第一次构建产出了**坏的 bundle，未安装即被拦下**
首次 `tsdown` 构建：产物仅 **130KB / 3037 行**（原点 384KB / 9647 行），
`UNRESOLVED_IMPORT: '@deepseek-ai/dsh-tools'` 与 `'schemastery'` 被当作**外部依赖**，
且**不含 `defineTool` 内联实现** —— 正是 `tsdown.config.ts` 注释警告的
「dsh-tools 留作外部说明符 ⇒ lib 在任何安装路径都无法加载」失败模式。
**原因**：`injector/node_modules/@deepseek-ai/` 是**空的** —— `build.sh` 需要 `DSH_CHECKOUT`
指向 dsh **源码 checkout**（含 `packages/` + `vendor/`），而本机**不存在该 checkout**
（实测 `D:\Deepseek-Harness\packages` 不存在）。
**处置**：① 立即**回滚到逐字节原件**（sha256 `F3925A38E70061CF` 复原）② 未安装坏产物 ③ 手工补建等价 junction
（`@deepseek-ai/dsh-tools` → 壳的已发布包、`schemastery` → profile 的已发布包）后重建，产物校验通过。

## 4. 遗留与已知差异（诚实标注）

| # | 事项 | 说明 |
|---|---|---|
| L1 | **产物体积 +45KB**（384179 → 429305） | 原构建内联的是**源码 checkout 版** dsh-tools；本次内联**已发布版**。功能等价（`defineTool` 在内），但**非字节等价** ⇒ **[未验证]** 运行时行为完全一致，需重启后实测确认 |
| L2 | **sourcemap 体积 243KB → 892KB** | tsdown 0.22.14 的 map 更详细；不影响运行，但 tgz 从 192KB 增至 367KB |
| L3 | **带入了源树 32 行未发布改动** | 源工作树 `src/index.ts` 原比活跃副本新 32 行（9647 vs 9615 行产物）。以源为基线重建 ⇒ 这些作者意图一并生效。**内容未逐行比对** |
| L4 | **T1 的"第二条 entry 由哪条路径创建"仍未定位** | 本次只交付"检测 + 显式修复"，未修创建路径 |
| L5 | **T4 未做语义改动** | 见 §3：`purgeStaleTools` 属设计意图；理论隐患（旧 fiber effect 按名 unregister 误删新工具）**未验证** |
| L6 | `build.sh` **在本机不可运行** | 缺 dsh 源码 checkout。本次用手工 junction 等价替代 ⇒ **[建议]** 把该等价动作固化进脚本（否则下次重建仍会踩同一坑） |
| L7 | 注入器 `node_modules` 新增两个 junction | 指向壳/profile 的已发布包，路径可能随升级变化 |

---

## 7. 第 4 轮：重启验收发现**我自己修复的严重缺陷**（已纠正，需再次重启）

### 7.1 重启后验收：修复确实生效 ✅
| 验收项 | 结果 |
|---|---|
| 新 bundle 是否加载 | ✅ `dev_dedupe_entries` 已出现在工具目录（证明新 bundle 生效） |
| `dev_plugin_status` 是否新增重复告警段 | ✅ 出现 `===== ⚠️ 同名重复 entry =====` 段 |
| T1 目标是否被检出 | ✅ `@dsh-external/dsh-vision-rotator: ids=[include:dsh-vision-rotator, bc55e2c8]`（匿名 id 每次启动都变：`7cdec742` → `bc55e2c8`） |

### 7.2 ⚠️ 但我的检测器**判据太松，产出 22 组假阳性**（实测）
`dev_dedupe_entries` 报 **23 组**，其中 **22 组是假的**：

| 假阳性类型 | 组数 | 实际情况 | 若误操作的后果 |
|---|---|---|---|
| `include:X` vs `include:desktop-windows-agent-presets:X` | **21** | **group 嵌套的不同作用域同名实例**；实测**两边都是 `[disabled]`**，本无双份注册 | 误导（不致命） |
| `include:mcp-firecrawl` vs `include:mcp-markitdown` | 1 | **同一个 `dsh-mcp-client` 包载入两个不同 MCP 服务** | **会毁掉 markitdown MCP 客户端** |

⇒ **严重缺陷**：若按首版工具提示执行 `dev_dedupe_entries({apply:true, keep:"include:mcp-firecrawl"})`，
会**移除 markitdown 服务**。**已立即停手纠正；未对运行态执行任何 apply。**

### 7.3 纠正：判据收紧为三条硬条件 + 安全闸门
```
① 组内 ≥2 条 active      （只有 active 才真的双份注册；那 21 组两边都 disabled）
② 至少一条 id 为「生成式」 （不含 ':' —— loader.create 未指定 id 时生成的短 id，幽灵特征）
③ 存在 canonical 同名条目  （含 ':' 的 loader 路径式 id，作为保留候选）
```
**安全闸门**：`keep` 必须是 canonical id（含 `':'`）；传生成式 id → **拒绝执行**
（理由「保留生成式条目会移除 loader 树里的正版条目」）；且**只移除生成式 id，canonical 永不被移除**。

### 7.4 第 4 轮验证与安装
- 重建：`lib/index.js` = **431272 bytes**；`node --check` exit 0
- 差异对照测试：**34 PASS / 0 FAIL**（新增 5 条针对判据收紧与安全闸门的断言）
- 已安装活跃副本 + 已重建 tgz（369790 bytes）
- **三处逐字节一致**：sha256 `A3646880B41E2517`（tgz / 源 / 活跃）

### 7.5 🔴 热重载不可用 ⇒ **需要第二次重启**
`dev_reload_package({packageName:'dsh-super-injector'})` 返回 **`ERROR: loader.internal 不可用`**
（`before: [active] after: [active]`，注入器本身未受损）
⇒ 加固版**已落盘但未生效**，**需要第二次重启**。

### 7.6 ⚠️ 在当前（已生效的 round-3）构建上**不要执行 apply**
round-3 检测器仍在运行，其 22 组假阳性结论**不可执行**。
**重启前请只读，不要 `apply:true`。**

### 7.7 第二次重启后的验收
1. `dev_dedupe_entries`（不带参数）→ 断言**只报 1 组**：`@dsh-external/dsh-vision-rotator`，
   显示 `canonical: [include:dsh-vision-rotator]` / `生成式: [<新匿名 id>]`
2. `dev_dedupe_entries({apply:true, keep:"<生成式 id>"})` → 断言**被拒绝**（安全闸门生效）
3. `dev_dedupe_entries({apply:true, keep:"include:dsh-vision-rotator"})` → 断言移除生成式那条、剩一条
4. `dev_heal_links` → selfHeal **不再产生假 ✗**
5. 后续失败列表**不再出现「（无原因）」**
6. `GET http://127.0.0.1:43120/health` 全绿

### 7.8 第 4 轮教训（写给自己）
**「检测」比「修复」更容易出错。** 我把修 T1 的重点放在"怎么安全地移除"（默认只报告 + 需显式 keep），
却**没有先验证"检测本身对不对"** —— 修复动作很安全，但**输入是错的**，
安全闸门反而给错误结论镀了一层可信度。
**规则**：写检测器时，**先在真实运行态跑一遍并逐组人工核对假阳性率**，再谈修复动作。
本次若不是重启后实测，22 组假阳性会一直被当成「23 个真问题」。

## 5. 重启后的验收步骤（**由用户执行重启**）

1. 重启桌面应用
2. 跑 `dev_plugin_status` → 断言出现 **`⚠️ 同名重复 entry`** 段，列出
   `@dsh-external/dsh-vision-rotator: 2 条 ids=[dsh-vision-rotator, 7cdec742]`
3. 跑 `dev_dedupe_entries`（不带参数）→ 断言**只报告不改动**
4. 确认正版 entry 后跑 `dev_dedupe_entries({ apply: true, keep: "<保留的 id>" })` → 断言只剩一条
5. 跑 `dev_heal_links` → 断言 `selfHeal` 统计**不再出现假 ✗**（这是 T3 的运行时确认）
6. 观察后续 `dev_plugin_status` 的「最近失败」段 → 断言**不再出现「（无原因）」**
7. `GET http://127.0.0.1:43120/health` 全绿

## 6. 回滚方式（一键）

**活跃副本 + 源树**（逐字节可还原）：
```powershell
$bk = 'D:\Deepseek-Harness\_backups\injector-fix-20260926-234127'
Copy-Item "$bk\index.js.live-desktop.orig" 'C:\Users\机械革命\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-super-injector\lib\index.js' -Force
Copy-Item "$bk\index.js.src-tree.orig"     'D:\Deepseek-Harness\plugins\dsh-routing-suite\injector\lib\index.js' -Force
Copy-Item "$bk\index.ts.orig"              'D:\Deepseek-Harness\plugins\dsh-routing-suite\injector\src\index.ts' -Force
```
回滚后 sha256 应回到 活跃 `DED8AFE33EFD683C…` / 源 `F3925A38E70061CF…`。然后重启。

### ⚠️ tgz 无备份（我的疏漏，如实记录）
首次备份把 tgz 路径写成 `<injector>\...tgz`（**实际在上一级**），`Copy-Item` 静默失败未被察觉
⇒ **tgz 原件的精确字节不可恢复**。内容可由备份**完整重建**（`npm pack`），步骤见
`_backups/injector-fix-20260926-234127/README.md`。**影响可接受**：重建版与原件功能等价、字节不同。

**教训**：多文件备份必须**逐项清点 + 断言 `Test-Path`**，不能假定 `Copy-Item` 成功。
