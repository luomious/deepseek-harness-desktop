# 第 5 轮 · 验收 6 步全过 + P0-6 补丁集身份登记

- 日期：**2026-09-26**
- 前置：`PLAN.md`、`REPORT.md`（注入器 P0 修复）
- 本轮两件事：**① 第二次重启后的 6 步验收（含故障注入）② 执行 P0-6**

---

## 一、6 步验收：**全部通过**

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `dev_dedupe_entries` 只报真重复 | ✅ | 从 **23 组降到 1 组**，22 组假阳性全部消除；输出 `@dsh-external/dsh-vision-rotator` / `canonical: [include:dsh-vision-rotator]` / `生成式: [08954a04]`，且**只报告不改动** |
| 2 | 安全闸门拒绝生成式 `keep` | ✅ | `dev_dedupe_entries({apply:true, keep:"08954a04"})` → `ERROR: keep 必须是 canonical id（含 ':'）…保留生成式条目会移除 loader 树里的正版条目，拒绝执行` |
| 3 | 用 canonical `keep` 修复 | ✅ | `{apply:true, keep:"include:dsh-vision-rotator"}` → `已移除 1 个生成式重复 entry`；复查 `未发现「真重复」entry`；`self-heal.log` 有 `dedupe-entries` 记录 |
| 4 | selfHeal 不再假失败 | ✅ | `dev_heal_links` → `OK: 全部 link: 依赖 junction 健康（无需修复）`；`stats.json` 的 `selfHeal` 由 **2✓/4✗ → 3✓/4✗**（健康检查现在记 **ok**） |
| 5 | 失败带可读原因（T2） | ✅ | **故障注入**证明，见下 |
| 6 | `/health` 全绿 | ✅ | `count:10, failed:[]`，10 项全 ok |

### 1.1 T2 故障注入（决定性证据）

**为什么必须注入**：`lastFailures` 里原有 5 条是 08-20/08-24 的**历史**记录，`reason` 为空——我的修复**不追溯历史**，所以看旧记录无法证明修复生效，必须制造一次**新的**失败。

**探针**：`@dsh-external/dsh-t2-probe`（无 BOM 的 `package.json` + 存在但一 import 即抛的 `lib/index.js`）。
**第一次尝试失败**：用 PowerShell `Set-Content -Encoding UTF8` 写出的 package.json 带 **BOM**，被 `dev_inject_plugin` 的**预检**在 `loader.create` **之前**拦下（`package.json 带 UTF-8 BOM —— tsdown/JSON.parse 无法解析`）⇒ 该路径也早退，不产生我要的失败。改用 node 写文件（无 BOM）后探针通过预检。

**结果**：

| 指标 | 注入前 | 注入后 |
|---|---|---|
| `inject` ok/fail | 452/**93** | 452/**94**（**原来 `loader.create` 抛错路径完全不计入**，现已计入） |
| 新失败记录 `reason` | — | **`loader.create 失败: failed to import loader entry 5c62bb5c (@dsh-external/dsh-t2-probe): T2-PROBE: intentional load failure to verify reason capture`** |
| 旧 4 条记录 | `reason=''` | 仍 `''`（正确：不追溯历史） |

**清理**：junction / 探针目录 / `registry.json` 均无残留（逐项断言）。

### 1.2 一个加强结论：幽灵是**每次启动新建的**

匿名 id 三轮观测：`7cdec742` → `bc55e2c8` → `08954a04` —— **每次都不同**。
⇒ **T1 的幽灵不是历史残留，而是每次启动被重新创建**。这把 T1 的定性从"清理历史垃圾"改为"**存在启动期重复装配**"，也解释了为何 `cleanupStaleEntries()`（跳过 active）永远看不见它。
**⇒ 新的待查项**：启动期哪条路径重新创建了它（见 §四 遗留）。

---

## 二、P0-6：补丁集身份登记 —— **先做减法，再做加法**

### 2.1 ⚠️ 关键发现：既有工具已覆盖大半（差一步就重复造轮子）

接入前先查门禁现有步骤，发现仓库**已有**：

| 既有工具 | 已覆盖 |
|---|---|
| `scripts/verify-bundle-manifest.mjs`（155 行，Step 1.10） | **按 SHA-256 + size 校验 `patches/bundles/*`（含 `original/` 回滚基线）**，带 `--json` / `--fix` |
| `scripts/verify-plugin-imports.mjs`（Step 1.11） | 插件源码相对说明符存在性 + 裸说明符门禁（= 我曾提的 A4「构建期导入守卫」的等价物） |
| `scripts/patch-shape-gate.mjs`（Step 1.16）、`patch-apply.mjs scan`（Step 2.6） | 目标侧形状门禁 + 注册表漂移 |
| `scripts/lint-skills.mjs` / `skill-inventory.mjs`（Step 1.8/1.9） | 技能质量 + 安全门禁（= 我曾提的 C2 的等价物） |
| `verify-patches.ps1` 第 9-22 行 | **已有「退役候选」清单**（对照 official 0.1.3-alpha.2 判定哪些补丁上游已修）= **P0-7 已有基础** |

⇒ 因此**砍掉**了原方案里与它们重复的部分，本脚本只保留真正的缺口。

### 2.2 真正的缺口（本脚本的增量）

**28 个 `scripts/apply-*.mjs` 补丁器从未被任何门禁摘要过。** 补丁器被**删除或改动**时，
`verify-patches.ps1` 的 ~80 项标记检查**可能仍然全绿**（标记字符串可由别的路径满足），
于是"这一套补丁"失去身份而无人察觉 —— 与它已修的 T13/O14（标记存活但文件损坏）同类。

### 2.3 交付物

- **`scripts/patch-manifest.mjs`**：`--write` 生成 / `--verify` 校验（默认 verify）
  - 登记 **40 条目 = 28 applier + 9 bundle + 3 reference**，逐条 sha256
  - 派生聚合 **`patchSet`（`dsh-desktop-dist-patches`）+ `patchDigest`**
  - `--verify` 四类断言：① patchSet 身份 ② **覆盖率交叉断言**（磁盘集合 ≡ 登记集合，分 added/removed/changed 三类点名）③ patchDigest ④ **覆盖度下限守卫**（applier ≥ 20，覆盖塌陷不得通过 —— 同 `verify-patches.ps1` 的纪律）
  - 头部**显式写明与 `verify-bundle-manifest.mjs` 的分工**：bundle 内容权威归后者，本脚本只把 bundle 哈希作为 **patchDigest 的输入**参与聚合，**不重新裁决**
- **`patches/MANIFEST.json`**：`patchDigest = 1011c247fca9e604…`，40 条目
- **`scripts/check-all.ps1` 新增 Step 1.17**（照 Step 1.10 既有模式；含 FAIL 提示与 HINT）

### 2.4 验证：故障注入 **7 PASS / 0 FAIL**

`tests/scripts/patch-manifest-faultinject.test.mjs`：

| 例 | 断言 | 结果 |
|---|---|---|
| 基线 | 未注故障时 verify 通过 | ✅ |
| **A** 未登记新增（造 `apply-__faultinject__.mjs`） | FAIL 且点名 `unregistered` + 文件名 | ✅ |
| **B** 内容漂移（给已登记 applier 追加一个字节） | FAIL 且点名 `content drift` + 文件名 | ✅ |
| **C** 条目消失（临时重命名 applier） | FAIL 且点名 `missing` + 文件名 | ✅ |
| 还原 | verify 回到 PASS | ✅ |
| 还原 | victim **逐字节一致**（`Buffer.compare`） | ✅ |
| 还原 | 无 faultinject 残留 | ✅ |

三例均 `try/finally` 保证还原；仓库复查 `apply-*.mjs 数量 = 28`（未变）。

### 2.5 门禁结果

`CHECK-ALL: ALL PASS`（exit 0）；新增行 `=== Step 1.17 ===` → `PATCH-MANIFEST: ALL PASS`。

**过程中门禁先报红一次**，原因是 `check-unsupervised.mjs`（Step 1.12）判定我新增/改动的
`scripts/patch-manifest.mjs`、`tests/scripts/patch-manifest-faultinject.test.mjs`、`CHANGELOG.md`、
注入器 tgz **未登记**（AGENTS.md：改 `scripts/` 后必须登记）。已按协议 `acquire → release --summary` 补登记，
复查 `REGISTERED=19 DRIFTED=0 UNREGISTERED=0`，阻塞项 0。**该门禁生效，不是假绿。**

---

## 三、本轮教训

1. **接入前必须先查"是否已有等价实现"**：我原方案的 P0-6/P0-9/C2 有相当部分**仓库已有**
   （`verify-bundle-manifest` / `verify-plugin-imports` / `lint-skills`）。若不先查就写，
   会造出**第二套事实源**——正是我自己在插件审计里批评的问题。
   **做法**：砍掉重复部分，只留真实缺口，并在脚本头部**写明分工**。
2. **"修好了"必须用新证据证明，不能靠旧记录**：T2 的旧 5 条失败记录永远显示"（无原因）"，
   只有**制造一次新失败**才能证明修复。这就是故障注入不可替代的原因。
3. **验收本身要能发现设计缺陷**：第 4 轮正是靠"重启后真跑一遍"才发现 22 组假阳性。
4. **PowerShell `Set-Content -Encoding UTF8` 会写 BOM** —— 在需要 JSON 被 `JSON.parse`/tsdown 解析的场景会静默致病（本次第一次探针就因此失败）。用 node 写文件。

---

## 四、遗留（诚实标注）

| # | 事项 | 状态 |
|---|---|---|
| R1 | **幽灵 entry 的创建路径仍未定位** | 已排除 `dev_inject_plugin`（有幂等短路）；**已确认它每次启动新建** ⇒ 指向**启动期某条重复装配路径**。`dev_dedupe_entries` 已能检测+一键修复，但**根因未修** |
| R2 | 产物内联的是**已发布版** dsh-tools（原为源码 checkout 版），+45KB | 运行时一致性由本轮 6 步验收**间接支持**（工具全部可用、health 全绿），但**未做逐行为对比** |
| R3 | `build.sh` 在本机不可运行（缺 dsh 源码 checkout） | 建议把「手工建 junction」固化进脚本，否则下次重建仍踩同一坑 |
| R4 | 源树 32 行未发布改动被一并带入 | 未逐行比对 |
| R5 | **P0-7 尚未执行** | 但已发现 `verify-patches.ps1` 第 9-22 行**已有退役候选清单**与 `_backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md` ⇒ P0-7 应**先读这两处**再补 0.1.7 的判定，而不是从零开始 |
| R6 | 技能审计相关（C2）与 `lint-skills.mjs` 重叠 | 需按本轮同样的方法先查覆盖，再决定补什么 |
