# R1「幽灵 loader entry」根治：根因 + 修复 + 验证（2026-09-27）

> 触发：用户拍板「行，做好记录」。R1 自第 2 轮发现、开了 3 轮未解，本次定位并修复。
> 性质：**注入器源码改动**（宿主侧插件）⇒ **需重启生效**（热重载不可用：`loader.internal 不可用`）。
> 证据分级：**【实测】**= 本机命令输出；**【读码】**= 源码/产物行号；**【证伪】**= 反向对照。

---

## 1. 症状（跨 4 次启动的硬数据）

`dev_plugin_status` / `dev_dedupe_entries` 每次都报同名重复 entry，而**匿名 id 每次启动都不同**：

| 启动轮次 | 幽灵匿名 id | canonical 条目 |
|---|---|---|
| 第 2 轮 | `7cdec742` | `include:dsh-vision-rotator` |
| 第 4 轮 | `bc55e2c8` | 同上 |
| 第 5 轮 | `08954a04` | 同上 |
| 本次（A0 重启后） | **`777fe02f`** | 同上 |

后果：`dsh-vision-rotator` 的 **60s 巡检跑两遍**（双份定时器/处理器）。

---

## 2. 根因（**源码行号级，无推断**）

### 2.1 直接线索（本次重启日志，完整顺序）

```
01:44:29.782 [I] [super-injector] 清理残留 entry include:dsh-vision-rotator（loading）
01:44:30.014 [I] [super-injector] 自动恢复 @dsh-external/dsh-vision-rotator
```

### 2.2 调用链

```
:2302  await inject(e.dir)                                        ← restore() 启动自动恢复
:2303  logger.info('[super-injector] 自动恢复 %s', e.name)       ← 日志出处（已定位，非推测）
   ↓
:1943  cleanupStaleEntries(pkgName)
:1690    if (st === 'active') continue                           ← 只放过 active
   ⇒ 正在 `loading` 的 canonical 条目被当「残留」**删除**
   ↓
:1945  if (hasActiveEntry(pkgName)) return ...                   ← :606 也只认 active ⇒ 此时为假
   ↓
:1971  await ctx.loader.create({ name: pkgName, config: {} })     ← **不传 id**
```

`FIBER_NAMES = ['pending','loading','active','failed','disposed','unloading']`（`:530`）。

### 2.3 幽灵 id 的生成机制（从 loader 自己的源码读到）

`node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`：

```js
async create(options) {
  const id = this.tree.ensureId(options);        // :49
  const existing = this.tree.store[id];          // :50
  const entry = existing ?? (this.tree.store[id] = new Entry(...));  // :51  ← 命中则复用
  ...
}
ensureId(options) {
  if (!options.id) do
    options.id = Math.random().toString(16).slice(2, 10);   // ← 8 位十六进制
  while (this.store[options.id]);
  return options.id;
}
```

`Math.random().toString(16).slice(2,10)` 的格式（8 位 hex）**与四个观测到的幽灵 id 完全一致** ⇒ 机制坐实：**不传 `id` 就每次现抽一个**，与任何东西都不可匹配。

### 2.4 慢动作重放

1. 启动时 profile 声明的 `include:dsh-vision-rotator` 处于 **`loading`**（fiber 未就绪）。
2. `restore()` 调 `inject()` → `cleanupStaleEntries` 判定它「不是 active」⇒ **删掉这个健康条目**。
3. `hasActiveEntry` 自然为假 ⇒ 继续走 `loader.create`，且 **不传 id**。
4. loader 现抽一个 8 位 hex id ⇒ **幽灵诞生**。
5. canonical 随后被 include 层重新声明 ⇒ 两条都 active ⇒ **双份 60s 巡检**。

---

## 3. 【自我纠错】报告 §8 里的一句话是错的

原报告写：「**只修 D1 即可止血**（canonical 不再被删 ⇒ `hasActiveEntry` 为真 ⇒ 跳过注入）」。

**错在哪里**：`hasActiveEntry` 只认 `active`，而那一刻 canonical 是 **`loading`** ⇒ **仍会走 `create`**。因此**只修 D1 不足以止血**，必须同时让**守卫**把 `loading`/`pending` 视为「已在装配」。这是本次修正的原因。

---

## 4. 修复内容（7 处，全在 `injector/src/index.ts`）

| # | 位置 | 改动 | 作用 |
|---|---|---|---|
| **D1** | `:1690` | `if (st === 'active')` → `if (st === 'active' \|\| st === 'loading' \|\| st === 'pending')` | **不再删掉启动中的健康条目** |
| **D2a-1** | 新函数（插在 `hasActiveEntry` 之前） | 新增 `hasLiveEntry()`：`active/loading/pending` 视为 live | 给守卫用，报告路径不动 |
| **D2a-2** | `:1945` | `hasActiveEntry(pkgName)` → `hasLiveEntry(pkgName)` | `loading` 时**直接跳过注入**（真正止住重复） |
| **D2a-3** | `:2288` | `hasActiveEntry(e.name)` → `hasLiveEntry(e.name)` | restore 同样跳过 |
| **D2b-1** | `:857`（scheduleHeal） | `create({ name, config: cfg })` → `create({ id: pkgName, name, config: cfg })` | 稳定 id，重复注入**复用**同一条 |
| **D2b-2** | `:1971`（inject） | 同上（`config: {}`） | 同上 |
| **D2b-3** | `:2841`（dev_install_package） | `create({ name })` → `create({ id: name, name })` | 同上 |

**未动**：`:1990`（`hostOk` 报告）与 `:3414`（registry 列表 `active:` 字段）保持 `hasActiveEntry` 语义 —— 报告要的是「是否 active」，守卫要的是「是否已装配」，两者语义不同，**故意区分**。

**为何传 `id` 安全**：`ensureId` 只做真值判断（不校验格式），且 `store` 命中即**复用** ⇒ 传稳定 id 使重复 create 幂等，而非报错。

---

## 5. 验证

### 5.1 构建

- 环境：`injector/node_modules/schemastery`（Junction）+ `@deepseek-ai/dsh-tools`（Junction）**均在**；host 配置 `alwaysBundle: (id) => !id.startsWith('node:')` ⇒ 两者被**内联**。
- 构建日志的「Detected dependencies in bundle」**含** `@deepseek-ai/dsh-tools` 与 `schemastery` ⇒ 这正是区分好包与第 3 轮那个坏包（130KB、未内联）的关键检查。
- 结果：`lib/index.js` **431,272 → 432,136 bytes**（+,864）；`node --check` exit 0；`IMPORT OK exports=Config,apply,inject,name`。

### 5.2 测试 `tests/plugins/injector-r1-ghost-fix.test.mjs`：**21 PASS / 0 FAIL**

| 组 | 内容 | 结果 |
|---|---|---|
| **A** | 交付产物确带新判据（两处，`action=continue` 1 处 / `return true` 1 处） | ✅ |
| **B** | **故障注入**：把 bundle 里**实际的判据表达式**抽出来用 `new Function` 求 6 种状态判定表 | ✅ 两处均完全符合规格，且都**放过 `loading`** |
| **C** | **反向对照**：旧 bundle（备份）在同一判定表上 **`loading` 行不合格**（`old.loading=false`） | ✅ **证明行为确实变了**（否则测试无效） |
| **D** | 幽灵机制复现：不传 id → `0bd35802` vs `49f760f2`（**每次都不同**）；传 id → 稳定 `pkg`；交付产物 3 处 create 均带 id | ✅ |
| **E** | 回归护栏：第 3–5 轮修复全部仍在（P0-2 原因、P0-3 selfHeal 语义、P0-4 安全闸门 + 判据、arbitrateOfficial、幂等守卫） | ✅ 7/7 |

**测试自身的一个 bug 与修正（值得记）**：首轮 19/1，失败项是「P0-4 安全闸门」——查证后代码在 `:10094` **存在**，只是 **rolldown 把单引号规范成了双引号**（`keep.includes(":")`），我的探针用了单引号 ⇒ **假阴性**。改用**引号无关**的探针（中文拒绝文案）后 21/0。⇒ **规则：对 bundle 做文本探针时，不能用带引号的字面量。**

### 5.3 交付与一致性

| 项 | 结果 |
|---|---|
| 活跃副本安装 | 431,272 → **432,136 B**，tmp+rename，**无 tmp 残留** |
| tgz 重建 | **371,052 B / 9 条目**（与原结构一致） |
| **三处逐字节一致** | sha256 **`E486916C2D3102189B4CB426274AB58273D40D434B4196D15F1B54DEBE0EA34A`**（源 lib / 活跃副本 / tgz 内） |

### 5.4 备份（可回滚）

`_backups/injector-r1-fix-20260927/`：`index.ts.orig`（154,274 字符）、`lib-index.js.orig`（431,272 B / `A3646880B41E2517…`）、`lib-index.live-desktop.js.orig`（431,272 B）、`tgz.orig.tgz`（369,790 B）、`extract/`。
**本次 tgz 原件已先备份**（修正第 3 轮「tgz 路径写错导致原件不可恢复」的疏漏）。

---

## 6. 重启后验收清单

1. `dev_dedupe_entries` 应报 **0 组真重复**（现有那组 `include:dsh-vision-rotator` vs `777fe02f` 消失）。
2. `dev_plugin_status` 的「⚠️ 同名重复 entry」段应**消失**。
3. 日志中**不再出现** `清理残留 entry include:dsh-vision-rotator（loading）`；预期出现 `已在装配（active/loading/pending），跳过注入`。
4. `dev-vision-rotator` 的 60s 巡检**只跑一遍**（可看其自身日志/状态）。
5. 第 3–5 轮回归项仍绿（`dev_heal_links` 不报假 ✗、失败列表带原因、`/health` 10/10）。

---

## 7. 未验证 / 诚实边界

- **需重启才生效**；本轮**未验收**（重启动作由用户执行）。
- 测试的 B 组是**对判据表达式的判定表验证**（抽自交付产物、真实求值），**不是**在真实 loader 上跑一遍 boot；真实 boot 验收见 §6。
- `D2b` 传 `id` 的效果依赖于 loader `store` 命中的**复用**语义（已读源码坐实），但**未在真实 loader 上做「先删除 canonical 再注入」的端到端复现**。
- 若未来 `dsh-vision-rotator` 的 canonical 来源（profile/bundle）被移除，行为将从「跳过注入」变为「首次创建」，此时 `id` 带来的幂等性是唯一的防线。

---

## 8. ★ 门禁抓到一个**真实耦合**（本轮第二个值得记的事）

首次跑 `check-all.ps1` 的结果是 **1 FAIL / 306 pass**，失败项是**第 3/5 轮那个测试**：

```
FAIL  回归：inject() 幂等短路仍在（已激活则跳过）
```

**它拦下的是真东西**：`inject()` 的幂等短路探针指向的中文文案被我改了（`已激活运行，跳过注入` → `已在装配（active/loading/pending），跳过注入`）。

**判定：断言过时，不是不变量被破坏。** 理由：该不变量的语义是「已挂载则短路跳过」，修复后**仍成立且被拓宽**（覆盖 `active`+`loading`+`pending`），而**拓宽的正是修这个 bug 的关键**。

**处置**：把它改成**更强**的断言（两条而非一条，并内联写明为何强化），**不删不强弱化**：

```js
check('回归：inject() 幂等短路仍在（已在装配则跳过）', src.includes('跳过注入') && src.includes('hasLiveEntry(pkgName)'));
check('回归：幂等短路已强化为覆盖 loading/pending', src.includes("st === 'active' || st === 'loading' || st === 'pending'"));
```

**结果**：`injector-p0-fixes.test.mjs` **34 → 35 条断言**，**35 PASS / 0 FAIL**；重跑门禁 **`CHECK-ALL: ALL PASS`（exit 0）**。

**为什么值得记**：这是本项目「改运行路径 → 门禁变红 → 判定是过时断言还是真回归 → 更新/修复 → 重跑」闭环的**第三次生效**（前两次见第 4/5 轮）。它同时提醒：**改中文日志文案会打断基于文案的探针**——以后探针优先用**标识符/结构**（如 `hasLiveEntry(pkgName)`），文案只作为辅助。

---

## 9. 重启后验收：**通过（5/5）** · 含一处「我的预测写错了」

重启时刻：`webserver http layer up (257s)` 反推 ≈ 02:41（本机）。

| 步 | 验收项 | 实测 | 判定 |
|---|---|---|---|
| 1 | `dev_dedupe_entries` | **「OK: 未发现『真重复』entry」** | ✅ **4 轮来首次** |
| 2 | 重复 entry 告警段 | **消失**；`dsh-vision-rotator` 以**稳定 id** 出现（列表里不再是 8 位 hex） | ✅ |
| 3 | 日志无 `清理残留 entry …（loading）` | 全天 3 条，时间戳 `00:34:15`×2 / `01:44:29` **全在旧启动**；**本次启动 0 条** | ✅ |
| 4 | 无重复注入 | `inject` 统计 **453✓/94✗ 未增**（守卫直接跳过）；`自动恢复` 本次启动 **0 条** | ✅ |
| 5 | 回归项 | `/health` **200 / count=10 / failed=0**；`dev_heal_links` → **全部 link: 依赖 junction 健康（无需修复）**；运行的就是新构建（sha256 **MATCH**、**432,136 B**） | ✅ |

### 9.1 ⚠️ 我的预测错了一处（如实记录）

§6 验收清单第 3 步我预期出现 `已在装配（active/loading/pending），跳过注入`，**实测 count=0**。

**原因**：跳过发生在 **`restore()` 的 `continue`（`:2288`）**，根本**没走到 `inject()`** —— 而那句话在 `inject()` 内部。所以：
- `已在装配` 不出现是**预期行为的副作用**，不是失败；
- 同理 `自动恢复`（`:2303`，在 inject 之后）也不出现，与 `inject` 统计未增三者**互相印证**。

**教训**：写验收清单时，**「预期日志」必须与「实际会执行到的那行代码」对齐**。我当时凭记忆写的是 `inject()` 里的文案，没确认跳过发生在哪一层。**行为结论不受影响**（其余 4 项证据已独立坐实），但这条预期是错的。

### 9.2 一个新发现：R7 `dev_self_test` 文档/实现不符

系统提示把它描述为「6 步全链路回归演练（注入假插件 / 热重载 / 自重载节流 / 预检拦截 / 卸载即净 / patch 写入合法性）」，**实测只跑 1 项**：

```
===== 注入器自检（PASS 0/1）=====
- [FAIL] checkout 探测 — 无 DSH_CHECKOUT
```

该 FAIL 属**已知 R3 环境限制**（本机无 dsh 源码 checkout），**非本轮回归**。但「宣称 6 步、实际 1 步」是一处**文档与实现不符**，已记为 **R7**（待拍板）。

### 9.3 不能由本次验收区分的项

- 「60s 巡检只跑一遗」未直接实测，而是**由「无重复 entry」推断**（单实例 ⇒ 单定时器）。属【推断】。

---

**结论**：**R1 闭环**。从第 2 轮发现问题到本次修复，共经历 4 轮；根因、修复、测试、交付、重启后验收均已留下可核验证据。
