# 打字「慢半拍」根因再定位 + 输入框原生绘制修复（2026-09-17）

> 用户诉求：「感觉 dsh 打字框还是有延迟，解决什么原因，有没有办法解决。先看看是不是有问题」→「按你最推荐的方案执行」。
> 本目录是这批工作的成品记录：现状核实 → 新根因（三层）→ 修复 → 验证 → 回滚 → 诚实边界。

## 一、结论（一页）

| # | 问题 | 结论 | 状态 |
|---|---|---|---|
| 1 | 上一轮两项修复是否还在 | **都在位**（GPU 硬件加速在运行态 `lib/main.js:52-58` 走硬件分支；4 条 typing-lag marker 齐全；renderer 空闲 CPU **8%**，阈值 25%）⇒ **不是旧根因复发** | ✅ 实测 |
| 2 | 真正的「慢半拍」根因 | **输入框可见字符不是 textarea 画的**：textarea 被内核渲染为全透明（只留光标），你看到的字由 React 覆盖层 `div[data-input-backdrop]` 画 ⇒ 每个字符必须等 `input`→状态机→store→**React 提交→布局→绘制** | ✅ 代码级实测 |
| 3 | 处置 | `plugins/dsh-ui-performance/lib/client.js` 新增 **Rule 10**（纯 CSS）：文字交回 textarea 原生绘制 + 装饰层置顶 | ✅ 刷新生效，免重启 |
| 4 | 防复发 | `verify-patches.ps1` 新增 2 条 marker 检查（静态 56→**58**）⇒ **ALL PASS (59 checks)**；故障注入证明可失败 | ✅ 已入闸 |

## 二、现状核实（先证明「不是旧问题」）

| 项 | 证据 |
|---|---|
| GPU 加速 | `dist/…/app.asar.unpacked/lib/main.js:42-59`：`__dshGpuOff` 为假时 `removeSwitch("disable-gpu"/"in-process-gpu"/"disable-gpu-compositing")` + `force_high_performance_gpu`；`dsh-gpu-off.flag` 不存在 ⇒ 硬件分支 |
| 客户端 4 处修复 | marker 在盘（diagram×2 / session-history / ui-performance Rule 9 / model-picker）；`GET /plugins/@dsh-external/dsh-ui-performance/client.js` → 200 且含 Rule 9 |
| renderer 是否被榨干 | `GET /self-maintenance/status` → `rendererCpuPct=8`（2026-09-17 09:19:48Z 采样），`currentStreak=0` |
| 会话规模 | 最近会话 `session.jsonl.zstd` 最大 **17.7MB** ⇒ 会话 DOM 很大，有渲染放大器 |

## 三、新根因（三层，逐层带证据）

### 3.1 显示层（主因，实测）

- `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:4031-4055` 渲染 `<textarea value={draft}>`；其 CSS（同文件 `:3463` 的 `css$17`）为：
  `.uV2eYG_input{color:#0000;-webkit-text-fill-color:transparent;caret-color:…;position:absolute;inset:0}`
  ⇒ **输入的文字完全透明，textarea 只提供光标与收键**。
- 真正显示的是它下面的 `div[data-input-backdrop]`（`:4024-4030`，`aria-hidden` + `pointer-events:none`），内容由 `draft` + 装饰拼出（`:3890-3973`）。
- 于是每个字符的可见时机 = `input` 事件 → `keyboard.setDraft`（`:3793`）→ store `publish()`（`:1454-1462`）→ React 提交 → 布局 → 覆盖层绘制。**主线程上任何占用都会把这一个字符推迟**，这正是「慢半拍」。
- 中文输入法加倍吃亏：原生组字串也被 `-webkit-text-fill-color:transparent` 透明掉（placeholder 有自己的 `-webkit-text-fill-color` 所以还看得见，这反过来印证该属性的作用范围）。

### 3.2 放大层（推断，高置信，未在本机插桩实测）

- `ConversationRoot:7161` 与 `ConversationSession:7406` 都写 `useInput((s) => s)` —— 订阅**整个输入状态**；`ConversationRoot:7275-7283` 渲染的正是 `[data-conversation-scroll]` + `renderSlot("conversation.session")`（整条消息列表）。
- ~~运行态全部 `@deepseek-ai/*/lib/client.js` 内 `React.memo(` 命中 **0** ⇒ 无 memo 边界，父级重渲染穿透整棵子树。~~ **【2026-09-17 更正·证伪】** 该「命中 0」是我 grep `\.memo\(` 的**假阴性**（真实文本是 `react.memo)(`）。实测 `ChatNodeSeat` **已 `react.memo` 且按单节点订阅**（`ui-conversation/lib/client.js:5480-5481`）。⇒ 本层真实代价仅为「ChatView 重跑 `order.map` + 每行 props 浅比较（O(N) 次比较、**无 DOM 工作**）」，**远小于原推断**；「会话越大越慢」的说法**不成立**。
- ⇒ 每敲一个字都要重算整棵会话树；会话越大越慢（当前会话 17.7MB）。**留待 P1 实测后再动。**

### 3.3 阶梯层（实测，历史探针 34 份报告）

- `@deepseek-ai/dsh-client-connection/lib/client.js:10149`：`serverRequestSchema.parse(JSON.parse(event.data))` —— 每条 WS 消息主线程同步解析 + Zod 全量校验。
- 探针 LoAF 归因：长任务/长动画帧**全部**指向 `handleMessage`（invoker `DOMWebSocket.onmessage`），单次 **48–61ms**；14 个窗口累计 longtask 15 次 / **3183ms**。

### 3.4 上游佐证（为什么这不是「我们环境特殊」）

官方 **0.1.3-alpha.2** 的 conversation bundle：`jsx("textarea")`=**0**、`contenteditable`=16、`-webkit-text-fill-color:transparent` / `_backdrop` / `_mirror` 全 **0**
⇒ 官方已把输入框重写为 contenteditable 富文本编辑器，**等于把这个覆盖层结构删掉了**。本机 0.1.1-rc.2 是老结构。

## 四、修复（P0：Rule 10，纯 CSS / 刷新生效 / 免重启）

文件：`plugins/dsh-ui-performance/lib/client.js`（走现成的 CSS 注入机制 `ensureCss()`，零 React 依赖）

```css
[data-input-scroll] textarea[data-phase]:not(:disabled),
[data-input-scroll] textarea:not(:disabled) {
	color: var(--dsw-alias-label-primary) !important;
	-webkit-text-fill-color: currentColor !important;
}
[data-input-backdrop] {
	z-index: 2;
	color: transparent !important;
}
```

- 第一段：**文字回到浏览器原生绘制**（与 `input` 事件同帧出现，不再等 React），中文组字串一并回原生；`:not(:disabled)` 保留 workspace-trigger 惰性态原样。
- 第二段：覆盖层只负责装饰并**置顶**在文字之上。装饰各自类仍有颜色（`hlToken`/`textRef`/`chip`/`hint`/icon），因为父级 transparent 只影响「自己没有颜色声明」的纯文本段。
- 选择器全用 `data-*` 结构属性（`data-input-scroll` / `data-phase` / `data-input-backdrop`），上游重建改 hash 类名也不会静默失效。

## 五、验证（全部实测）

| 检查 | 结果 |
|---|---|
| `node --check plugins/dsh-ui-performance/lib/client.js` | exit **0** |
| 反引号计数 | **2**（仅模板字符串定界符） |
| marker 计数 | Rule 10 = 1、Rule 9 = 1（**无重复施加**） |
| 服务端实取 `GET /plugins/@dsh-external/dsh-ui-performance/client.js` | **200**，含 Rule 10 + 选择器 ⇒ 刷新即生效（未重启） |
| `verify-patches.ps1` | **ALL PASS (59 checks)**，exit 0；静态 56→**58**，新增 `typing-lag: native composer text` + `(css)` |
| 故障注入 | 复制件删掉 marker 后同一检查命中 **False**（真文件 True）⇒ 该检查真能失败 |

## 六、回滚

| 层 | 方式 | 生效 |
|---|---|---|
| Rule 10 | 用 `_backups/typing-lag-native-text-20260917-175705/client.js.before` 覆盖回插件文件（或删掉 Rule 10 块） | 刷新页面 |
| 门禁 2 条 | 删 `verify-patches.ps1` 里那 2 行（不涉及运行路径） | 立即 |
| 备份位置 | `_backups/typing-lag-native-text-20260917-175705/`（`client.js.before`、`verify-patches.ps1.before`、`faultinj/`） | — |

## 七、诚实边界

- **过程失误（已拦下）**：初版把 CSS 注释写成含反引号的样式，而 CSS 位于 JS 模板字符串内 ⇒ 模板提前闭合、`node --check` 失败。**门禁的语法完整性检查当场拦下**；这期间服务端短暂可取到坏文件（若恰好刷新，只会丢该插件的 CSS，不会损坏会话数据），修复后已复核 200 + 内容正确。
- ~~**§3.2 是推断**：未在本机对「每击键整树重渲染」做插桩；只证明「订阅整个输入态 + 全库无 React.memo」这一结构，未测其毫秒数。~~ **【2026-09-17 更正·自查证伪】** 「全库无 React.memo」**已被推翻**（`ChatNodeSeat` 已 memo + 单节点订阅）；原结论源于我 grep 正则的假阴性。现存未验证项只剩「根/会话层重渲染 + 每行 O(N) props 浅比较」的毫秒量级。
- **未做真实 UI 走查**：本次未用 Playwright/探针在页面内量「击键 → 上屏」真实延迟；结论基于运行态代码、服务端实取、门禁与既有探针报告。若刷新后体感仍慢，下一步应注入临时探针量化（需要用户敲几个字）。
- **未做（等确认）**：P1 收窄 `useInput(s=>s)`（内核 dist 补丁，需进 patches 三件套）；P2 `handleMessage` 大消息旁路/异步化；P3 升级官方 0.1.3+（已有 `_backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md` 与 Phase 2 手册）。
- **装饰层视觉代价**：chip / `@` 引用在原生文字之上会多出原始字形（图标替换效果减弱）——纯视觉、可秒回滚。
