# 滚动卡顿（上下滑动对话内容）根因分析与修复（2026-09-17）

> 用户诉求：「我上下滑动对话内容也会卡顿」→「先进行调查和全面分析然后给出解决方法」→「按照你推荐的来做」。
> 本目录是这批工作的成品记录：三路只读审计 → 官方同源对照 → 我方复核 → 修复（S1+S2′）→ 验证（含故障注入）→ 回滚 → 诚实边界。

## 一、结论（一页）

| # | 结论 | 证据 |
|---|---|---|
| 1 | **主因（A 层）**：会话滚动处理器在「不在底部阅读」时，**每个滚动帧**都做「锚点计算」——≥2 次强制同步布局 + **最多 4 次 `elementsFromPoint()` 命中测试** + 每帧一次 `querySelector("[data-composer-seat]")` 子树扫描 + 命中失败时**逐行** `getBoundingClientRect()`（O(行数) 同步布局） | `ui-conversation/lib/client.js:5744-5767` → `scrollPosition():5566` → `pagingAnchor():5539-5564`；三路独立审计均列第 1 |
| 2 | **官方同源对照坐实**：0.1.3 把聊天渲染搬到**新包** `@deepseek-ai/dsh-client-ui-chat`，**没上虚拟化**，却在**同一算法**上做了三处降本（命中点 4→1 / 回退 O(n)→**二分 O(log n)** / 被动滚动 + 500ms 合并 + `scrollend` 结算） | 我方亲自下载 `ui-chat@0.1.3-alpha.2` 复核：`package/lib/client.js:1956`（单点 `viewport.top + 1`）、`:1962-1968`（`while (low < high)` 二分）、`:1970`（命中后仅 1 次 rect） |
| 3 | **放大项（B 层）**：滚动容器内两个常驻 sticky 层（composer 座位 z-index:7 + 渐变、回到最新槽 z-index:8 + 阴影圆角）；全库几乎**没有合成/包含提示**（`will-change` 全树仅 1 处且只在拖动时、`translateZ(0)` 0 处、CSS `contain` 不在对话路径）；9 处「每帧重绘」型 infinite 动画（`left` 扫光 / `background-clip:text` 微光 / `box-shadow`），多在流式门控内 | `:7120`、`:5452`、`:3463`；CSS 全量普查（59 个 client.js） |
| 4 | **天花板（C 层）**：主会话列表**无虚拟化**（`order.map(ChatNodeSeat)`），窗口「最近 50 条消息」起步、每次「加载更早」+50 ⇒ 滚动成本随已加载行数线性增长 | `:5851`；`dsh-client-runtime:7585/7391` |
| 5 | **处置**：S1（Rule 11 包含性隔离，纯 CSS，刷新生效）+ S2′（内核 dist 三处补丁，照官方实现，刷新生效） | 见 §四、§五 |
| 6 | **未做**：运行态毫秒量化（三路审计与我方复核**全部是静态读码**）；A/B（Rule 9 去留、自定义滚动条）留给体感与后续实验 | 见 §七 |

## 二、方法（谁提供了什么证据）

| 线 | 范围 | 产出 |
|---|---|---|
| 子代理 A | 59 个 `client.js` 的 **CSS/绘制层**全量普查 + 逐条定位 | 12 条排序结论、动画计数（38 `@keyframes` / 57 `animation:` / 18 `infinite`） |
| 子代理 B | **每个滚动事件都跑的 JS** 全量枚举（内核 + 工作区插件 + profile 第三方） | 13 条排序；必答「普通场景只有 1 条热回调」「主列表无虚拟化」「滚动期 setState 清单」 |
| 子代理 C | **官方 0.1.3** 对照（含压缩性判定、逐符号计数、机制逆向、可回移性） | 关键更正：机制**不是删除而是整包搬到新包** `ui-chat`；三处降本与行号 |
| 主代理（我） | 独立复核 + 端到端取证 | 亲自下载 `ui-chat` 包复核二分/单点；核对 canon 与在跑副本字节一致；补丁/门禁/故障注入/服务端实取 |

## 三、根因分层（含被排除的假设）

**A 层（JS 主线程，唯一每滚动帧都跑的重路径）**
- `A1` 无 rAF/去抖的 `onScroll`（`:5776`，体 `:5744-5767`），仅在「不在底部」进入重路径（`:5752` 到底早退）。
- `A2` 重路径成本：`getBoundingClientRect()`×2–3；**每帧** `querySelector("[data-composer-seat]")`（`:5541`，全子树扫描）；`document.elementsFromPoint()`×≤4（`:5542-5557`，每点 `closest()`）；命中失败时 `[...querySelectorAll("[data-chat-anchor-key]")]` + **逐行** `getBoundingClientRect()`（`:5559-5563`）。
- `A3` 放大器：composer `onWheel` **non-passive**（`:3688`），指针在输入框上滚到边界时写 `host.scrollTop += deltaY`（`:3686`）→ 再次触发 A1。

**B 层（绘制/合成，结构性）**
- `B1` 两个常驻 sticky 层每帧重定位 + 其下渐变色带/阴影圆角卡重绘（`:7120`、`:5452`、`:3463`）。
- `B2` 无合成/包含提示（普查：`will-change` 全树 1 处、`translateZ(0)` 0 处）⇒ 滚动内容层反复重绘。
- `B3` 9 处「每帧重绘」型 infinite：`left` 扫光 ×5（`conversation:9353/9559`、`tool:627/1128`、`skill:11`）、`background-clip:text` 微光 ×3（`conversation:4254/5452`、`better-sidebar:8357`）、`box-shadow` 动画 ×1（`vision-engine:179/183`）。
- `B4` 自定义 `::-webkit-scrollbar`（`theme:127`）——理论上可能让滚动条走主线程（**未验证**，A/B 极便宜）。
- `B5` 大面积 `border-radius`+`overflow:hidden`（CONV 46/29 处）⇒ 圆角裁切重绘。
- `B6` **758KB 全局样式表**常驻注入（`@huanlin/…office:40438`）；已核实该插件**确实在 profile bundles 里**。

**C 层（结构性天花板）**
- `C1` 主列表无虚拟化（`:5851`）；窗口 50 条/页（`dsh-client-runtime:7585`，`loadOlder` +50）。
- `C2` Rule 9 `content-visibility:auto`+`contain-intrinsic-size:auto 240px`（**本机自创**，官方没有）——快滚时按需渲染 + 估高修正（后果为推断）。
- `C3` trajectory 视图**有**虚拟化（`trajectory:4349/4354/4374`，@tanstack/virtual-core）⇒ 上虚拟化在本仓有先例，但主列表改造量远大于 A2 补丁。

**已排除**：GPU 关闭（运行态走硬件分支）；renderer 饱和（空闲 8%）；大面积 `backdrop-filter`（只在弹窗遮罩）；`scroll-behavior`/`overflow-anchor` 冲突（0 命中）；`chatScroll.save` 落盘（只是 `Map.set`）；vision-engine 的 window 捕获相 scroll（无 chip 时立即 return）；better-sidebar 的 scroll 监听（挂 `visualViewport`，普通滚轮不触发）。

## 四、修复 S1：Rule 11 包含性隔离（纯 CSS · 刷新生效 · 免重启）

文件 `plugins/dsh-ui-performance/lib/client.js`：

```css
[data-conversation-scroll] { contain: paint; }
[data-composer-seat]      { contain: layout; }
```

- `contain:paint` 把失效范围限定在滚动口盒子内（`overflow:hidden auto` 本来就裁切，**不会新遮任何东西**）；`contain:layout` 隔离 sticky 带的重新布局。
- **故意不给 seat 加 `contain:paint`**：其 slot 子节点可能挂下拉层（会被裁切）。
- 选择器走 `data-*` 结构属性，上游重建改 hash 类名不会静默失效。
- 预期收益**未量化**（B 层占比未知）；零风险、可秒回滚。

## 五、修复 S2′：滚动锚点三处降本（内核 dist · 照官方实现 · 刷新生效）

脚本 `scripts/apply-scroll-anchor-fixes.mjs`（幂等 / 原子写 / 先备份 / marker 判定 / **锚点漂移即 fail-loud** / `--check` 预演）。
**落地位置**：权威源 `patches/bundles/dsh-client-ui-conversation-client.js`（canon）先打补丁，再回灌 **dev 树 + packaged app** 两处 ⇒ `port-user-patches.mjs`（从同一 canon 恢复）**不会把我的补丁冲掉**。

| # | 改动 | 官方出处（已复核） |
|---|---|---|
| 1 | 回退查找：**逐行 rect 全量扫描 → 二分查找**（`while (low < high)`，O(n)→O(log n)） | `ui-chat:1962-1968` |
| 2 | 命中测试：**4 点 → 1 点**（`viewport.top + 1`） | `ui-chat:1956` |
| 3 | `[data-composer-seat]` 查询：**每帧子树扫描 → WeakMap 缓存 + `isConnected` 复验** | 本机既有模式（model-picker aria poll cache） |

刻意**不做**的两件（保持行为不变）：不做 500ms 合并采样（官方为降本牺牲了锚点新鲜度，会影响「加载更早/流式 prepend 后的位置复位」精度）；不改 `left` 扫光动画（需知各组件几何，且有视觉代价）。

## 六、验证（全部实测）

| 检查 | 结果 |
|---|---|
| 预检 `apply-scroll-anchor-fixes.mjs --check` | 3 处目标全 `DRIFT 0/0/0`，exit **1**（符合预期） |
| 施加 | `canon patched (3/3 edits)` + 回灌 2 处 + `ALL OK（3 edits, 2 targets, syntax clean, canon == packaged）`，exit **0** |
| 幂等 | 二次运行 = `canon already patched` + `up-to-date ×2` + `ALL OK`，exit 0（无重复施加） |
| 服务端实取 | `GET /plugins/@deepseek-ai/dsh-client-ui-conversation/client.js` → **200**，3 个 marker 各 1；旧的 `const points = [` 与 `rows.filter((row) =>` 命中 **0** ⇒ **刷新生效，未重启** |
| Rule 11 服务端实取 | `GET /plugins/@dsh-external/dsh-ui-performance/client.js` → **200**，含 Rule 11 与 `contain: paint` |
| 语法 | `node --check` exit 0；反引号计数 = 2（仅模板定界符） |
| 门禁 | `scripts/verify-patches.ps1` **ALL PASS (64 checks)** exit 0（静态 58→**63**，新增 4 条 scroll-anchor + 1 条 containment） |
| **故障注入** | 把 canon 还原为补丁前版本 ⇒ 门禁**恰好 1 条** FAIL（`scroll-anchor: canon copy (patches/)`），pkg 三条仍 PASS，exit 1 ⇒ **归因唯一、该检查真能失败**；重打后复跑全绿 |
| canon 一致性 | canon 与 packaged 副本**字节相同**（脚本内断言） |

## 七、回滚

| 层 | 方式 | 生效 |
|---|---|---|
| S2′ | `_backups/scroll-anchor-fixes-2026-09-17T11-25-20-556Z/`（canon/dev/pkg 三份 `.before`）覆盖回对应文件（dev+pkg 两处；canon 可留补丁态） | 刷新页面 |
| S2′ 门禁 4 条 | 删 `patches/bundles` 判定行 / `verify-patches.ps1` 里那 5 行 | 立即 |
| S1 Rule 11 | 删掉 Rule 11 块（或 `_backups/typing-lag-native-text-20260917-175705/client.js.before` 整文件回滚——注意该备份**不含** Rule 11） | 刷新页面 |

## 八、诚实边界

- **三路审计与我的复核全部是静态读码**，没有任何一条被运行态量化；排序依据是「机制性质 + 官方同源修法」，不是毫秒。
- **未做的体感/量化实验**：① 刚重启（只加载最近 50 条）时滚动是否仍卡（判断与行数是否相关）；② `scripts/probe-dsh-cpu.mjs` CPU 采样；③ `_backups/diag-perf-probe/` 探针（LoAF 的 `forcedStyleAndLayoutDuration` + 按脚本名归因）——**这是唯一能把 A1/A2 变成实测数字的手段**。
- **待决策的 A/B**：Rule 9（`content-visibility`）去留；自定义滚动条（B4）；office 插件 758KB 样式表（B6）。
- **本批附带更正**：我先前写进 CHANGELOG/docs/memory/报告的「全库 `React.memo(` 命中 0 ⇒ 一个字重算整棵会话树」是**假阴性**（真实文本 `react.memo)(`），`ChatNodeSeat` 实为 `react.memo` + 单节点订阅（`ui-conversation:5480-5481`）；四处记录已就地更正。
- **过程失误（两次同类，均被门禁当场拦下）**：在这份 CSS 里写了**反引号**注释（`` `will-change` ``），而整段 CSS 是 JS 模板字符串 ⇒ 模板提前闭合、`node --check` 失败。**同一坑第二次**，现已在 Rule 11 注释里写成硬约定：「本样式表内禁止反引号」。

## 九、证据索引

| 内容 | 位置 |
|---|---|
| 补丁脚本（幂等/原子/备份/fail-loud/`--check`） | `scripts/apply-scroll-anchor-fixes.mjs` |
| 权威源（canon）与原件 | `patches/bundles/dsh-client-ui-conversation-client.js`、`patches/bundles/original/dsh-client-ui-conversation-client.js.orig-npm` |
| 备份（补丁前 canon/dev/pkg 三份 + 故障注入用的还原副本） | `_backups/scroll-anchor-fixes-2026-09-17T11-25-20-556Z/`、`…-11-27-41-913Z/` |
| 门禁 | `scripts/verify-patches.ps1`（`scroll-anchor: *` ×4 + `scroll: containment`） |
| CPU 采样器（零注入） | `_tmp/scroll-probe/sample-dsh-cpu.mjs` |
| 现成探针（LoAF 归因，需注入） | `_backups/diag-perf-probe/` |
| 官方对照包（本次亲自下载复核） | `_backups/cleanup-redundant-files-2026-09-17T11-40-05-300Z/evidence/upstream-ui-chat-0.1.3-alpha.2-lib-client.js`（`@deepseek-ai/dsh-client-ui-chat@0.1.3-alpha.2` 的 `lib/client.js`；清理时自 `_tmp/upstream-verify/` 转存） |
| 排障手册 | `docs/troubleshooting-handbook.md` **§22 滚动卡顿** |
| 变更记录 | `CHANGELOG.md` 2026-09-17「滚动卡顿…」节 |
