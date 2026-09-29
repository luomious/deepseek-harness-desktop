# P0-1～P0-4 注入器缺陷修复 · 方案与执行记录

- 日期：**2026-09-26**
- 目标：修复注入器运行时暴露的四项缺陷（T1 重复挂载 / T2 失败无原因 / T3 self-heal 假失败 / T4 自净噪音）
- 对象：`plugins/dsh-routing-suite/injector/`（源工作树）→ 活跃 profile `desktop` 的已安装副本
- 备份：`_backups/injector-fix-20260926-234127/`

## 0. 关键前置发现（改变了原计划）

### 0.1 注入器的真实分发链 [实测]

```
源工作树  D:\Deepseek-Harness\plugins\dsh-routing-suite\injector\        (含 .git/src/node_modules)
   ↓ 打包
tgz       plugins\dsh-routing-suite\dsh-external-dsh-super-injector-0.3.3.tgz
   ↓ profile 用 file: 引用安装
desktop   ~\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-super-injector\  (仅 lib/ 构建产物，活跃)
web       ~\.dsh\profiles\web\node_modules\@dsh-external\dsh-super-injector\      (Junction → 源工作树)
```

`~/.dsh/profiles/{desktop,web}/package.json` 里：
```json
"@dsh-external/dsh-super-injector": "file:D:/Deepseek-Harness/plugins/dsh-routing-suite/dsh-external-dsh-super-injector-0.3.3.tgz"
```

**⇒ 修正我上一份报告的错误结论**：我原判「T6 `dsh-routing-suite` 内含 49.1MB 的 injector 副本 = 仓库有两份 super-injector，应删除」是**错的**。
`routing-suite/injector/` 是**源工作树**，那个 tgz 是**分发源**。**按原计划删除会直接破坏注入器的可重建性**。已在 `AUDIT-AND-PLAN.md` 与本文件中标注修正。

### 0.2 活跃 profile = `desktop` [实测]
`~/.dsh/settings.yaml` 的 `profileName: desktop`。**要改的文件是 `profiles/desktop/.../lib/index.js`**（不是 web，web 是 Junction 指向源）。

### 0.3 源与已安装副本已不同步 [实测]
| | 行数 | bytes | sha256(前16) |
|---|---|---|---|
| 源工作树 `lib/index.js` | 9647 | 384179 | `F3925A38E70061CF` |
| **活跃副本** `desktop/lib/index.js` | **9615** | **381918** | `DED8AFE33EFD683C` |

⇒ 源树比活跃副本**新 32 行**但从未生效。**修复必须同时落两处**（源 + 活跃副本），否则要么不生效、要么被重装还原。

## 1. 根因定位（读代码确认，含一次假设证伪）

### T2 失败无原因 —— 确认 [实测]
`recordOp(kind, ok, reason?)`（`:1859`）**接受 reason**，但调用点不传：
- `:1983` `recordOp('inject', hostOk)` ← 无 reason
- `:2064/:2065` `recordOp('uninject', …)` ← 无 reason
- `:1365` `recordOp('reload', rebuilt > 0)` ← 无 reason
- **更严重**：`:1969` `loader.create` 抛错时 `return` 早退，**根本没调 recordOp** ⇒ 该类失败未被计数

⇒ `:2618` 渲染 `f.reason || '（无原因）'` ⇒ 所有失败都显示"（无原因）"。

### T3 self-heal 假失败 —— 确认（语义反了）[实测]
`:2537` `recordOp('selfHeal', healed.length === 0)`
**"没有需要修的链接"（=健康）被记为 FAIL**；只有真的修了东西才记 OK。
⇒ `selfHeal 2✓/4✗` 里那 4 次失败其实是**4 次健康检查**。**这是纯粹统计语义 bug，让健康系统看起来在坏。**

### T1 重复挂载 —— 原假设被证伪，根因收敛为"两个 entry 都 active" [实测]
**证伪**：`inject()`（`:1920-1985`）**已有幂等保护** ——
```
:1939 cleanupStaleEntries(pkgName)      // 清理同名残留
:1941 if (hasActiveEntry(pkgName)) return 'INFO: 已激活运行，跳过注入'
```
所以重复 entry **不是** `dev_inject_plugin` 造成的。
**真正的缺口**：`cleanupStaleEntries()`（`:1680-1693`）在 `:1686` **跳过 active entry** —— 而 vision-rotator 的两个 entry **都是 active**，所以清理逻辑完全看不见它们。
`scheduleHeal()`（`:807-880`）只自愈**注入器自身**（`pkgName = … ?? '@dsh-external/dsh-super-injector'`），与 vision-rotator 无关。
⇒ **能确定的**：检测/清理链路对"多个同名 active entry"**没有覆盖**。**不能确定的**：哪条路径创建了第二个 entry（未验证，不编造）。

### T4 `purge-stale-tools` —— 严重度下调 [实测]
`:2371-2397`：apply 时**无条件**删除所有 `dev_*` 工具，然后 `safeRegister` 重新注册自己的 12 个。
江是"清残留再注册"的**设计意图**（注释：清除历史版本裸注册残留的僵尸闭包）。
⇒ 每次 reload 必留一条 audit ⇒ **是噪音，不是故障**。理论隐患：旧 fiber 的 effect 清理若按名 unregister，可能误删新实例工具（**未验证**）。
**⇒ 严重度从 P0 下调为 P2**，只做降噪 + 可观测，不做语义改动。

## 2. 改动方案

### 修 A（T2）失败必带原因
- `inject()`：捕获 `loader.create` 异常文本 → `recordOp('inject', false, reason)`；成功但 host 未激活 → 带 reason
- `uninject()` / `reload()`：同上补 reason

### 修 B（T3）修正 selfHeal 统计语义
- 健康检查完成即记 `ok`；仅异常时记 `fail` 并带 reason；返回值区分「已修复 N 个」/「无需修复」

### 修 C（T1）同名 active entry 的**检测 + 显式修复**
- 新增 `dev_dedupe_entries` 工具：**默认只报告**；`apply:true` + `keep:<id>` 才动手（`entry.parent.remove(entry.id, true)`，复用 `cleanupStaleEntries` 同一 API）
- `dev_plugin_status` 输出追加「重复 entry 告警」段，让它**始终可见**
- **设计理由**：静默自动 dispose 有杀死正确实例的风险（两个都 active，无法从代码可靠判定哪个是"正版"）⇒ 选择"暴露 + 显式修复"而非"静默自动杀"

### 修 D（T4）降噪
- `purgeStaleTools()` 的 audit 行补上「本次仅重新注册，非遗留故障」语义；日志级别 info

## 3. 验证方式
1. `node --check` 构建产物语法
2. **独立故障注入测试** `tests/plugins/injector-fixes.test.mjs`：
   - 修 A：喂入 `recordOp('inject', false)` 无 reason → 断言渲染出可读原因（不再"（无原因）"）
   - 修 B：断言「无需修复」路径记 **ok**，异常路径记 **fail 且带 reason**（**反向对照**：旧语义下必红）
   - 修 C：构造 2 个同名 active entry 的假 loader → 断言报告 2 条；`keep` 指定后断言只留 1 条
3. `scripts/check-all.ps1` 全绿
4. **需重启**后实操验证：`dev_plugin_status` 应显示 vision-rotator 重复告警；`dev_dedupe_entries` 报告 2 条

## 4. 回滚方式
`_backups/injector-fix-20260926-234127/`：
- `index.ts.orig`（源）
- `index.js.src-tree.orig`（源构建产物）
- `index.js.live-desktop.orig`（活跃副本）
- tgz 原件
一键回滚 = 三处覆盖回原件 + 重启。

## 5. 风险与收益
| | |
|---|---|
| **风险** | **中**（触及注入器核心；但改动均为"观测/统计/显式工具"，**不改变注入与自愈的主路径行为**；修 C 默认只报告不动手） |
| **收益** | 高（T2 让失败可排障、T3 让健康不再被误报为故障、T1 让重复挂载可见且可一键修复） |
| **需重启** | **是**（注入器是宿主侧插件，改动需重启装配） |

## 6. 诚实边界
1. **T1 的第二条 entry 由哪条路径创建 —— 未验证**。本方案只做"检测 + 显式修复"，不修"创建路径"（因为没定位到）。
2. **T4 的理论隐患（旧 fiber effect 按名 unregister 误删新工具）—— 未验证**，故不做语义改动。
3. **修 C 的 `keep` 判定需要人工指定** —— 因为两个 entry 都 active，代码无法可靠判定哪个是正版。
4. 源工作树与活跃副本的 32 行差异**内容未逐行比对** —— 本次以源工作树为基线重建，可能把源树的未发布改动一并带入（**已知并接受**：源树是作者意图）。
