# QuWork 全面对比分析 · 排版样式 / 思考链路 / 内核差距 · 分阶段升级方案

- 日期：2026-09-24
- 分析对象：`E:\QuWork`（QuWork Desktop v1.2.0，Electron 商业发行版）
- 对照对象：`D:\Deepseek-Harness`（DSH Desktop shell v2.0.2，内核 DSH **0.1.1-rc.2**）
- 本文是 `outputs/2026-09-24-analysis-quwork-vs-dsh/REPORT.md` 的**续篇**，新增三大切面：**排版样式**、**思考/轨迹链路**、**内核版本差距**，并给出**分阶段完整升级方案**
- 证据分级：**[实测]** / **[推断]** / **[未验证]**

---

## 第一部分 · 排版与样式

### 1.1 核心发现：QuWork 内并存**两套独立设计系统** [实测]

| | 外壳区（登录/引导/插件市场/设置） | 会话区（对话/轨迹/工具卡） |
|---|---|---|
| 技术栈 | **React + antd 797KB + Tailwind CSS v4** | DSH 官方 `dsh-client-ui-*` 插件族 |
| token 前缀 | `--app-*` + `--tw-*` + `--color-blue-*` | **`--dsw-*`（373 个）** |
| 字体栈 | `-apple-system, BlinkMacSystemFont, Segoe UI, Microsoft YaHei, sans-serif` | 系统字体栈（正文）+ **Montserrat**（仅欢迎页品牌字） |
| 入口 | `dist/index.html`（`lang="zh-CN"`，`theme-color: #f6f8fb`） | 内核 webserver 注入 index |
| 运行隔离 | 主窗口 | **独立 session partition `qurwork-deepseek-harness`** |

**[实测] 外壳 token 全表**（`dist/assets/index-CEolcHuS.css` 的 `:root`）：
```css
--app-primary:#0f1115;        --app-primary-hover:#2a2f38;
--app-link:#1483ff;           --app-success:#52c41a;   --app-danger:#ff4d4f;
--app-background:#fff;        --app-surface:#fff;      --app-surface-muted:#f5f5f5;
--app-login-background:#fff;
--app-notice-background:#fffbeb; --app-notice-border:#fde68a; --app-notice-icon:#f59e0b;
--app-danger-hover-background:#fef2f2; --app-danger-hover-text:#b91c1c;
--app-login-card-shadow:0 13px 50px #20202014;
--app-notification-shadow:0 10px 32px #2020202e;
--app-border:#f2f2f2e6;       --app-text:#202020;      --app-text-secondary:#999;
font-synthesis:none; text-rendering:optimizelegibility;
font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif
```

**值得学的点**：
1. **`--app-*` 语义化命名**（primary/surface/surface-muted/border/text/text-secondary/notice-*/danger-hover-*）——**按语义而非按色值命名**，换肤只改一处。我们的 `--app-*` 体系缺失。
2. **`--app-text-secondary:#999` 是危险值**：`#999` on `#fff` = **2.85:1**，低于 WCAG AA 正文 4.5:1。**[实测]** 这正好命中我们 AGENTS.md 里记录过的事故类型（「用 `#93A5B3` 作卡片正文 → 2.32:1」）。→ **我们别学这个值**，应改用 ≥4.5:1 的 secondary（如 `#5A5A5A` on white = 7.0:1）。
3. **`--app-border:#f2f2f2e6`** 用 8 位 hex（带 alpha）表达「极淡分隔线」——比 `rgba()` 更紧凑。
4. **`--app-notice-*` 三件套**（背景/边框/图标）成组定义 → 提示条换肤只改一组。
5. **`text-rendering:optimizelegibility` + `font-synthesis:none`** —— 前者开启连字/字距优化，后者**禁止浏览器合成粗体/斜体**（保证品牌字体只出现设计过的字重）。**[实测]** 我们的 CSS 无此两行。
6. **环境分级配置**（`app.config.js`）：每个远端 URL 都有 `dev/test/prod` 三份；`timeoutMs:30_000`、`maxResponseBytes:1_048_576`（1MB 上限，**响应体大小硬闸门**）。
7. **Node 运行时按 target 钉 sha256**（`darwin-arm64`/`darwin-x64`/`win32-x64` 各一条）→ 供应链可信。
8. **诚实标注**：`dsh.distributionBaseUrl: ''` / `manifestKeyId: ''` / `manifestPublicKey: ''` —— **远端 DSH 更新未配置**，所以 §REPORT 里那套 Ed25519 签名链**当前是 dormant 的**（`resolveRemoteUpdateCapability()` 返回 `'unconfigured'` → fail-closed）。**[实测]** 修正我上一份报告的推断：签名机制**存在但未启用**。

### 1.2 会话区（DSH 官方）样式体系 [实测 —— 这是最有价值的一层]

**权威规范**：`dsh-client-ui-theme` 的 6 张样式表，由 ui-theme 的**动态客户端 entry 依次导入**，编译后作为**插件持有的全局样式**注入 ⇒ **卸载与 HMR 会随 ui-theme 一同移除**（样式生命周期与插件生命周期绑定）：

| 样式表 | 职责 |
|---|---|
| `base.css` | 基础 |
| `corner-shape.css` | **圆角平滑** |
| `design-platform.css` | 颜色权威、diff 底色、滚动条 token 声明 |
| `scrollbar.css` | 滚动条重绑定（须排在 design-platform 之后） |
| `gradient-shadow-text.css` | 字号阶梯派生、阴影阶、elevation token |
| `shiki.css` | 语法高亮色 |

#### (a) 字号阶梯（排版核心）[实测]

```
用户设置 ui-theme.fontSize: 整数 12–17px（step 1，默认 14）
  → --dsh-content-font-size
  → 派生 --dsh-content-font-delta
  → 派生 --dsh-content-font-size-secondary
        ≤14px 时 = 设置值 − 1
        > 14px 时 = 设置值 − 2
        默认（14）⇒ 13px
  → 派生 --dsh-content-font-delta-secondary
```
**应用规则 [实测原文]**：
- **正文阶梯**：会话标题 + 基础文本（**用户气泡 + composer 草稿直接读正文字号变量对**）
- **低一档**：流内行的**标题、摘要、表格**读 `--dsh-content-font-size-secondary`
- **固定字号**：**小号文本与代码保持固定字号**（不随设置缩放）
- `MarkdownText variant="compact"`：**13px / 20px 行高**跟随内容字号设置；各级标题**保持同一字号 + 600 字重**；段落与列表用更紧凑间距；正文/链接/代码保持 **tertiary 颜色**，链接用**点状下划线**区分

**值得学的点**：
1. **「随设置缩放的阶梯」+「固定不动的代码/小字」分离** —— 这是排版上很成熟的决定：代码块缩放会破坏对齐与语义，所以固定。
2. **secondary 档随设置值动态取 −1 或 −2** —— 大字号时多降一档，保持视觉层级不塌。
3. **compact 变体各级标题同字号**（只靠 600 字重与间距区分）—— 避免紧凑卡片里标题比正文还大。
4. **链接用点状下划线而非颜色**（颜色留给 tertiary）—— 无障碍更稳（不依赖颜色单一通道）。

#### (b) 圆角：`corner-shape: superellipse(1.5)` [实测 —— 我们完全没有]

```css
@supports (corner-shape: superellipse(1.5)) { --dsw-corner-shape: ...; }
/* 通配选择器应用到所有元素及其 ::before/::after */
```
- 不支持的引擎**自动退回普通圆弧**（渐进增强，零风险）
- **正圆形状（`border-radius:50%` 的圆与胶囊）必须配对 `corner-shape: round`**，否则超级椭圆会把圆变形；由样式表 spec 跨全部包样式表强制这一配对

**[实测] 量化差距**：`corner-shape|superellipse` 出现次数 —— **QuWork 9 次 / 我们 0 次**。

#### (c) Elevation 系统 [实测 —— 我们只有 4 处，他们 14 处]

```
--dsw-elevation-stroke          0.5px 发丝描边（经可重绑的 --dsw-elevation-stroke-color）
--dsw-elevation-panel           ) 在描边之上叠两层极淡柔光
--dsw-elevation-prominent       )
--dsw-elevation-soft            composer 专用：更大模糊 + 更低透明度
--dsw-menu-backdrop-filter      半透明菜单材质
--dsw-shadow-lv*                阴影阶
```
**关键设计约束 [实测原文]**：**高层级表面设 `border: 0`**，用 elevation token 的描边代替 border ⇒ **不产生占布局的轮廓**（改描边不会引起 reflow）。派生 token **逐元素重声明**，使表面对描边色的重绑真实生效。

**值得学的点**：把「轮廓」从 `border`（占布局）改为**绘制层描边**（不占布局）——这是避免「换主题导致布局跳动」的正解。

#### (d) 滚动条重绑定 [实测 —— 设计精细度高]

```
body 上：--dsh-scrollbar-thumb / -hover 绑定到 l1 基础表面 token
高层级表面（菜单/浮层/对话框）：在自己的容器上重绑定为 l2 token
合法第三值：transparent（ui-sidebar 在指针不在栏内时就这样做）
--dsh-scrollbar-width        WebKit 默认 5px
--dsh-scrollbar-thumb-border ) 让「可见滑块窄、可拖动区域宽」
--dsh-scrollbar-track-margin ) 让轨道避开圆角两端
```
**两条渲染路径构造上互斥 [实测]**：Firefox 走 `@supports not selector(::-webkit-scrollbar)` 内的标准细滚动条；WebKit 系走伪元素 ⇒ 几何与 hover 定制只经伪元素路径生效。

#### (e) 品牌字体：Montserrat 只用于欢迎页 [实测]

```
lib/styles/brand-font.css + montserrat-{light(300),regular(400),medium(500)}.woff2 (62KB each)
+ Montserrat-OFL.txt（SIL Open Font License 随包分发）
font-display: swap
```
**规则 [实测原文]**：`brand-font.css` 导出本地 Montserrat；**Desktop 将同一份样式表、字体和许可证打包，用于欢迎页品牌文字的离线显示；普通界面保留系统字体栈。**
→ **品牌字体只用在品牌位，正文永远走系统栈**（保证中文/多语言渲染质量 + 零加载成本）。

#### (f) FOUC-free 主题引导 [实测 —— 极其值得学]

```
head CSS（任何脚本执行前）：color-scheme + body background-color + --dsh-boot-bg
   light: :root{color-scheme:light} body{background-color:#fff; --dsh-boot-bg:#fff}
   dark : :root{color-scheme:dark}  body{background-color:#151517; --dsh-boot-bg:#151517}
   system: light + @media(prefers-color-scheme:dark){dark}
body script（外壳挂载与模块脚本之前）：
   document.documentElement.dataset.dsThemeSource = preference
   document.body.toggleAttribute('data-ds-dark-theme', dark)
   document.body.style.setProperty('--dsh-content-font-size', `${fontSize}px`)
```
**注入方式 [实测]**：`ctx.on('webserver/index-inject', table => table.push(...bootThemeInjections(...)), { prepend: true })`
**效果**：**首帧绘制就采用所选调色板与字号** —— 无白闪、无字号跳动。

#### (g) 设计纪律（三条硬规则）[实测原文]

1. **「token 样式表是颜色值的唯一权威来源：设计系统中缺失的值会有意不补入；一律采用最接近的语义 token」** —— 缺色不许随手写 hex，必须用最近语义 token。
2. **「插件无法导入另一个插件的组件，因此本包是控件唯一可以共享的地方：合适的就复用，有意的视觉差异提升成 prop，而不是另起一份拷贝」** —— **禁止复制控件**；第二个包需要同一控件时，控件**上移**到 primitives。
3. **新增颜色值须「在同一变更中以一个静态尺度层级 + 一个语义别名的形式进入」** —— 加色必须同时定义尺度与语义。

### 1.3 组件库差距（量化）[实测]

| | QuWork 0.1.7-rc.1 | 我们 0.1.1-rc.2 |
|---|---|---|
| `dsh-client-ui-primitives` bundle | **502,818 B** | 289,403 B |
| CSS modules 数量 | **31** | 20 |
| `dsh-client-ui-theme` client.js | **97,709 B** | 80,114 B |
| `dsh-client-ui-theme` index.js | 4,227 B | 3,292 B |
| `dsh-client-ui-layout` client.js | **31,272 B** | 19,364 B |
| `dsh-client-ui-trajectory` client.js | **417,789 B** | 359,394 B |
| `--dsw-*` unique tokens | **373** | 350 |
| `corner-shape\|superellipse` | **9** | **0** |
| `elevation\|backdrop-filter\|shadow-lv` | **14** | **4** |

**我们有而 0.1.7 没有的 CSS module**：`ConnectionBanner.module.css`、`WebBlock.module.css`、`markdown/{CodeBlock,JsonBlock,MarkdownText,MessageText}.module.css` → **[推断]** 0.1.7 做了**结构重组**（`markdown/` 子目录被拉平；`ConnectionBanner` → `ConnectionIndicator`；`WebBlock` 并入其他卡片）。

**0.1.7 新增而我们没有的 CSS module（15 个）**：`Checkbox`、`CodeCard`、`ConnectionIndicator`、`DisclosureRow`、`FileTypeIcon`、`HoverCard`、`ImageLightbox`、`ImagePreview`、`PathLabel`、`SegmentedControl`、`SegmentedTabs`、`StateDot`(重写)、`Switch`、`Tag`、`TextShimmer`。

**组件目录亮点 [实测 `dsh-client-ui-primitives/README.zh.md`]**：
- **`Switch` 36×20**，`label` 必填 —— **「控件不可能在没有名称的情况下发布」**（无障碍内建）
- **`StateDot`**：10px 槽内 done(绿)/warning(琥珀)/error(红)/idle(中性灰) + tertiary 灰 14px 旋转 ongoing loading，**动画固定到文档时间零点 ⇒ 所有可见 loading 同相旋转**（避免多个 spinner 相位杂乱）；`aria-hidden`，名称由渲染点提供
- **`Tag` vs `Pill` vs `SegmentedControl`** 三者的判据被明确写死（只读徽章 / 可选中 chip / 互斥模式 tablist）
- **`DisclosureRow` 24px 紧凑折叠行**，用浅层 prop 比较 memo
- **产品图标双线重**：`Regular`(1px) / `Medium`(1.3px)，**名称不含画板尺寸**，`size` prop 控渲染尺寸 —— **「即使当前产品只用其中一种，也保留两种线重导出」**（API 不必二次扩展）
- **`LinkIconMedium` 站点识别表**：GitHub/GitLab/npm/PyPI/StackOverflow/MDN/Wikipedia/HN/YouTube/X/**Bilibili/知乎/掘金/CSDN**/Google/百度/DuckDuckGo/TikTok/Netflix/Spotify/Facebook/Instagram/Reddit/Telegram/WhatsApp/**微信/QQ/微博/淘宝**/速卖通/eBay/Quora/**V2EX**/Apple —— 中文互联网站点覆盖完整
- **`FileTypeIcon` 48 个代码/配置类别** + 传统 28px 图形；`classifyFileType` 匹配顺序：完整文件名 → 前缀 → 后缀 → 项目上下文 → 扩展名（**React 文件名优先于 TS/JS；Angular 后缀优先于基础扩展名；只有 `pubspec.yaml` 含 `flutter:` 时 Dart 才用 Flutter 图形**）
- **`MarkdownText` 流式渲染**：冻结已完成块、按已完成行推进顶层未闭合 fence、**从保存的 Shiki grammar state 增量高亮**、已完成 token 行进固定大小 React 分组、最终全量解析时未变化 fence **保留该 DOM**
- **`DiffBlock` 性能闸门**：片段超过 **256 次行增删**即停止精确比较，按粗粒度替换显示
- **本地化纪律**：primitives **无法读 locale**，每段文案必须经 label prop；**本包不拥有语言回退；遗漏会导致类型检查失败** ⇒ 编译期强制国际化

### 1.4 排版样式方面的可借鉴清单

| # | 做法 | 我们的现状 | 价值 |
|---|---|---|---|
| S1 | **`corner-shape: superellipse(1.5)`** 圆角平滑 + `@supports` 渐进增强 + 正圆配对 `round` | **0 处（已实测确认缺失）** | ★★★★☆ |
| S2 | **Elevation 系统**（0.5px 发丝描边 + 双层柔光 + menu backdrop-filter），高层级表面 `border:0` | **4 处 vs 14 处（确认缺失）** | ★★★★☆ |
| S3 | ~~FOUC-free 主题引导~~ | **已有（实测 4 处命中）⇒ 无需借鉴** | — |
| S4 | **字号阶梯 + secondary 动态派生（−1/−2）+ 代码固定字号** | 未验证 | ★★★★☆ |
| S5 | **token 单一权威 + 缺色不补 + 加色须配尺度与语义别名** | 无此纪律 | ★★★★☆ |
| S6 | **禁止复制控件；第二次需要就上移** | 无此纪律 | ★★★★☆ |
| S7 | **本地化经 label prop + 遗漏即类型错误** | 无 | ★★★☆☆ |
| S8 | **品牌字体（Montserrat）只用于品牌位，正文走系统栈 + OFL 随包** | 无 | ★★★☆☆ |
| S9 | **滚动条 token 重绑定 + 双渲染路径互斥 + 宽拖动区/窄滑块** | 未验证 | ★★★☆☆ |
| S10 | **`StateDot` 动画固定文档时间零点（loading 同相）** | 无 | ★★★☆☆ |
| S11 | **`--app-*` 语义 token + 8 位 hex 带 alpha + notice 三件套成组** | 无 | ★★★☆☆ |
| S12 | **`text-rendering:optimizelegibility` + `font-synthesis:none`** | 无（两行 CSS） | ★★☆☆☆ |
| S13 | 站点识别表含中文互联网（B站/知乎/掘金/CSDN/微信/QQ/微博/淘宝/V2EX） | 无 | ★★☆☆☆ |
| S14 | `Switch` 的 `label` 必填式无障碍内建 | 无 | ★★☆☆☆ |
| — | **反例**：`--app-text-secondary:#999`（2.85:1，低于 AA） | — | **别学** |

---

## 第二部分 · 思考 / 轨迹链路

### 2.1 `dsh-client-ui-trajectory`：417KB 的「思考轨迹」独立视图 [实测]

**[实测 README.zh.md 全文要点]**：

| 能力 | 细节 |
|---|---|
| **定位** | Trajectory 标签页：把 agent 活动**按执行顺序**组织为**事件记录**，含工具调用、子代理、系统提示词、用户消息、图片、**压缩（compaction）记录** |
| **思考列** | i18n key `column.think` = 「思考」；`usage.reasoning` = 「推理」 |
| **思考块排版** | **「流内的思考块使用紧凑 Markdown，采用极端固定的 13px 字号和 20px 行高，不受内容字号设置影响」**；**「标题只加粗，不放大字号或行高」** |
| **时间维度** | 每条记录带 **token 用量**（prompt/completion/total）、**生成时长**、**TTFT**（从请求开始到首个 token）；**历史重复保留 TTFT**；指标未返回时保持不可用（**不伪造 0**） |
| **Overview 标尺** | 固定在记录列上方，投影**整段会话的真实开始时间与耗时**，显示各记录 TTFT 与生成时长；悬停 500ms 显示精确时间；右键拖动平移、滚轮缩放 |
| **虚拟化** | **只渲染可见窗口 ± 50 个 target Node**；加载控件只暴露驻留 Node |
| **代码检视** | `run_code`（PTC）记录展示说明、输出、行号与语法高亮源码；「代码」页提供运行、查看原始 JSON、用 `{}` 切换按钮；**失败记录在记录行内显示错误码** |
| **压缩记录** | 按时间顺序显示，另有 **`Between turns` 桶**收纳无对应执行存在的压缩 |
| **系统提示词** | 请求头未变时显示为**沿用系统**，并提供感知的变更摘要（移动端工具目录）；**历史中的系统提示词保留不变**，只有当前请求头不同才显示更新 |
| **图片** | 走 Conversation 拥有的会话授权取用户登录态；**图片 URL 使用会话授权**；未就绪图片用本地化文本占位 |
| **原生内容** | 原始数据保留数据库顺序；**未渲染的表格与图片使用默认折叠展开** |
| **布局** | 要求会话层把 composer 作为固定底边；**预先 composer 的实时高度**，确保可滚动区域不小于滚动窗口；Summary 可在悬停聚焦前吸附 |
| **模型体验** | **「无。该包不注册任何面向模型的内容。」** |

**值得学的点**：
1. **「思考」是独立视图而非对话内联** —— 对话区保持干净，轨迹区承载完整因果链。这与我们的做法（思考内联在对话流）是根本不同的信息架构选择。
2. **思考块字号固定（13px/20px）且标题只加粗不放大** —— 明确把「思考」定位为**元信息**而非正文，避免长思考链把版面撑爆。
3. **TTFT / 生成时长 / token 三指标上时间轴** —— 把「性能可观测性」做成用户可见功能，而不只是日志。
4. **指标缺失时保持不可用，不显示 0** —— 诚实性设计（对应 §dshmarket 的 `checked` 分母哲学，同一个团队的价值观）。
5. **虚拟化窗口 ± 50 Node + 只渲染可见** —— 长会话（万级事件）可用。
6. **Overview 标尺 + 缩放平移 + 悬停精确时间** —— 面向「长会话取证」的交互设计。
7. **`Between turns` 桶** —— 承认「有些记录不属于任何一轮」这个真实情况，而不是硬塞进某一轮。

### 2.2 相关包：我们有 / 我们缺 [实测]

| 包 | 我们 | 作用 |
|---|---|---|
| `dsh-client-ui-trajectory` | ✅ 359KB（旧） | 轨迹视图 |
| `dsh-client-ui-model-selection` | ✅（`reasoningEffort` 10 处，与新版一致） | 每模型思考强度选择 |
| `dsh-client-ui-tool` | ✅ | 工具卡（注释提到可 append reasoning 块类型） |
| `dsh-client-ui-chat` | ❌ **缺** | 对话视图（0.1.7 新增） |
| `dsh-client-ui-session` | ❌ **缺** | 会话视图 |
| `dsh-session-turn-outline` | ❌ **缺** | **轮次大纲**（排版相关） |
| `dsh-session-turn-outline` / `dsh-session-stats` | ❌ / ✅ | 轮次统计 |
| `dsh-token-meter` | ✅ | token 计量 |
| `dsh-agent-tool-presentation` | ✅ | 工具呈现 |
| `dsh-repeat-tool-reminder` | ✅ | 重复工具提醒 |

### 2.3 我们的 `dsh-force-reasoning-effort` 与上游立场的张力 [实测]

**上游立场（`dsh-client-ui-settings-models` 两处注释原文）**：
> "There is deliberately **no reasoning-effort control**, here or on the editor card: effort is a **per-MODEL capability**, and the models under one provider **disagree** about it, so a provider-scoped control can only be set to a value **some of them reject**. The composer's model picker offers **each model its own levels** instead."
> "Reasoning effort is deliberately absent: ... **`cordis.patch.yml` keeps the profile field for a deployment that knows its route.**"

**我们的插件（`dsh-force-reasoning-effort` README 原文）**：
> 给「catalog 标记为 `reasoning: false` 的模型（如 gpt-4o 等非推理模型）」「手写 provider 的 `models` 但没写 `reasoningEfforts` 的模型」「catalog 里没收录的模型」注入 `reasoning: true` + `thinkingLevelMap`，**让模型选择器对所有模型都显示思考强度控件**。

**分析 [实测 + 推断]**：
- 我们的插件**走的是每模型元数据注入**（而非上游反对的 provider 级全局控件）⇒ **不直接违反上游设计**。
- 但**目标不同**：上游刻意**不给非推理模型**显示控件（"a value some of them reject"）；我们的插件**刻意给所有模型**显示控件。**[推断]** 对 `reasoning: false` 的模型强行注入 `reasoning: true` 可能触发上游 `dsh-llm.resolveCallFor()` / `resolveReasoningLevel()` 的 `UNSUPPORTED_REASONING_EFFORT` 拒绝（我们 README 自己也记录了这条校验）——**这是需要实测确认的风险点**。
- **行动**：内核升级到 0.1.7 后，**catalog 覆盖度会变**（0.1.7 的 pi-ai 目录可能已补全多模态/推理元数据）。**必须先复测「还有多少模型缺 reasoning 元数据」，再决定插件是否仍需要** —— 避免维护一个上游已修好的补丁。

---

## 第三部分 · 内核版本差距（硬数据）

### 3.1 总量 [实测]

| | QuWork | 我们 |
|---|---|---|
| DSH 内核版本 | **0.1.7-rc.1** | **0.1.1-rc.2** |
| `@deepseek-ai/*` 包数 | **277** | **199** |
| **我们缺失** | **78 个包** | — |
| 内核 Node | 24.21.0 / ABI 137 | 未核对 |
| pnpm | 10.34.5（内置分发） | 未核对 |

> **[实测] 修正**：我们的 `INDEX.md`（2026-09-16）记录「官方内核已到 0.1.5-rc.2」。**QuWork 实测装载 0.1.7-rc.1** ⇒ 上游又前进了两个 minor（0.1.5 → 0.1.7）。

### 3.2 缺失的 78 个包（按价值分组）[实测]

| 组 | 包 | 价值 |
|---|---|---|
| **REST API 面（7）** | `dsh-api-account-controller`、`-job-`、`-session-`、`-settings-`、`-terminal-`、`-workspace-`、`-workspace-files` | ★★★★★ 内核自带 HTTP API，外部集成的基础 |
| **SDK（4）** | `dsh-sdk-app`、`dsh-sdk-protocol`、`dsh-sdk-minimal`、`dsh-sdk-jsonrpc-server` | ★★★★★ 第三方集成入口 |
| **会话格式迁移（6）** | `dsh-session-format`、`-catalog`、`-v0-to-v1`、`-v1-to-v2`、`-v2-to-v3`、`-v3-to-v4` | ★★★★★ **逐版本迁移链**（0.1.1 会话升到 0.1.7 必需） |
| **Hooks 兼容（3）** | `dsh-hook-protocol`、`dsh-hooks-claude-code`、`dsh-hooks-codex` | ★★★★★ **兼容 Claude Code / Codex 的 hook 协议** |
| **PTC（3）** | `dsh-ptc-runtime`、`dsh-ptc-runtime-node`、`dsh-workflow-ptc` | ★★★★☆ 程序化工具调用运行时 |
| **客户端 UI（18）** | `dsh-client-ui-chat`、`-session`、`-approval`、`-plugin-manager`、`-schedule`、`-open-in-app`、`-settings-{account,agent-loop,shell,subagent,web-search}`、`-sidebar-{browser,documentpreview,files,right,terminal}` | ★★★★☆ **对话/会话/审批/侧边栏文件·终端·浏览器** |
| **客户端基础（4）** | `dsh-client-file-upload`、`-store`、`-resources`、`dsh-chunked-list` | ★★★★☆ |
| **experimental（8）** | `-agent-team`(+profile/`-client-ui-`/`-tool-`)、`-speech-to-text`(+api/sensevoice)、`-voice-input`(+client-ui/bundle) | ★★★☆☆ 语音输入 / agent 团队 |
| **Office（3）** | `dsh-office-to-pdf`、`libreoffice-kit`、`libreoffice-kit-win32-x64` | ★★★☆☆ |
| **Webhook（2）** | `dsh-webhook`、`dsh-webhook-github` | ★★★☆☆ |
| **会话增强（3）** | `dsh-session-turn-outline`、`dsh-session-log-deepseek`、`dsh-compaction-image-offload` | ★★★☆☆ |
| **其他（17）** | `dsh-agent-preset`(+registry)、`dsh-config-editor`、`dsh-plugin-manager`、`dsh-package-manifest`、`dsh-lazy-require`、`dsh-hmr`、`dsh-http-proxy`、`dsh-mcp-resources`、`dsh-win32-process`、`dsh-util-{crypto,time,values,workspace-path}`、`dsh-web-fetch-http`、`dsh-tool-present`、`dsh-tool-workspace-dependencies`、`dsh-workspace-changes`、`dsh-skill-office`、`dsh-plugin-package-inventory-deepseek`、`dsh-deepseek-account`(+platform)、`dsh-deepseek-llm-api-extensions`、`dsh-acp`(+app)、`dsh-deque`、`node-addon-system` | ★★★☆☆ |

### 3.3 **重要修正：我上一份报告的两处结论需要改** [实测]

1. **`dsh-atomic-write` 我们已经有**（199 包里包含它）⇒ 原 P0-1「新增 `lib/atomic-write.mjs`」**应改为「在自有插件中改用官方 `dsh-atomic-write`」**。官方实现比我的提案更强：
   - `writeFileAtomic`：`.<12hex>.tmp` + **`flag:'wx'` 独占创建**（拒绝跟随被植入的 symlink）；mode 随 rename 生效（**无 chmod 竞态**）；**替换 symlink 目标本身而非写入其指向**
   - **Windows 瞬时 rename 重试**：`EACCES`/`EBUSY`/`EPERM` 指数退避 20→200ms，最多 8 次 —— **这是我们完全没有的 Windows 硬化**
   - `withFileLock`：`wx` 创建 `<file>.lock` 兄弟文件做**跨进程写者锁**，指数退避 + 超时（默认 2000ms）；**从不删除已存在的锁**（「文件年龄无法证明其持有者已停止；孤儿恢复是运维动作」）
   - **明确声明 `fsync` 崩溃持久性不在范围内**
   - **「读者无锁，因为 rename 提交是原子的」**
2. **`dsh-client-ui-theme` / `-primitives` / `-trajectory` / `-layout` 我们也有**，但**版本落后**（见 §1.3 量化表）⇒ 原计划里「移植样式」应改为「**内核升级后自动获得**，只需复核差异」。

### 3.4 **实测确认：我们的 `dsh-atomic-write` 缺 Windows rename 重试（可立刻修）** [实测]

逐行比对两侧 `dsh-atomic-write/lib/index.js`：

| 特性 | QuWork 0.1.7-rc.1 | 我们 0.1.1-rc.2 |
|---|---|---|
| `writeFileAtomic`（`.<12hex>.tmp` + `flag:'wx'` + rename） | ✅ | ✅ |
| `withFileLock`（`wx` 创建 `<file>.lock` + 指数退避 + 超时） | ✅ | ✅ |
| `isLockContention`（EEXIST 直接判、EPERM 需 lstat 确认） | ✅ | ✅ |
| **`renameAtomicTemp`：Windows 瞬时 rename 重试** | ✅ `EACCES`/`EBUSY`/`EPERM`，20→200ms 指数退避，**最多 8 次** | ❌ **裸 `rename(temp, filename)`，零重试** |
| **Windows 单次未确认 EPERM 重试**（锁竞争） | ✅ | ❌ |

**影响 [推断]**：Windows 上杀毒软件 / 索引器 / 文件监视器短暂占用目标文件时，rename 会抛 `EACCES`/`EBUSY`/`EPERM`。**0.1.7 会自动重试并成功，我们会直接失败**——这正是我们历史上「文件只更新一半 / 写失败」类事故的**一个可能根因**。
**行动**：**这是不依赖 P0 的立刻可修项** —— 把 0.1.7 的 `renameAtomicTemp`（约 20 行）移植进本地 `dsh-atomic-write`（或改用 0.1.7 版本），列入 P2-2 的第一步。

### 3.5 **实测确认：我们已有 boot-theme 注入，但无 corner-shape** [实测]

| 检查项 | 结果 |
|---|---|
| 我们的 `dsh-client-ui-theme/lib/client.js` 含 `ds-dark-theme` / `dsh-boot-bg` / `index-inject` / `dsThemeSource` | **4 处命中 ⇒ 已有 FOUC-free 引导机制** |
| 我们的 `corner-shape` | **0 处 ⇒ 确认缺失**（0.1.7 有 9 处） |

⇒ 修正 §1.4 的 S3：**FOUC-free 引导我们已有**（应从「借鉴清单」移到「已具备」）；**corner-shape（S1）与 elevation（S2）确认缺失**，是 P1 的真实工作项。

---

## 第四部分 · 分阶段完整升级方案

> **总原则**：**能靠内核升级拿到的，不要自己写**（§3.3 教训）。自研只做内核**没有**的产品层能力（插件市场 / 检查点 / 桥 / 品牌壳）。
> 本方案为 **plan**，未执行任何写入。每阶段可独立验收、独立回滚。

### 阶段依赖图

```
P0 内核升级（0.1.1-rc.2 → 0.1.7-rc.1）
 ├─→ P1 设计系统与排版对齐        （升级后自动获得，只需复核+补品牌层）
 ├─→ P2 插件体系硬化              （用官方 atomic-write + 单操作互斥 + 闸门）
 ├─→ P3 更新与回滚                （profile 检查点 + patch digest）
 ├─→ P4 Skill 体系                （审计 + 注入改造）
 ├─→ P5 思考/轨迹与可观测性        （升级后获得 chat/session/turn-outline）
 └─→ P6 平台化                    （API/SDK/webhook/hooks compat）
```

---

### 阶段 P0 · 内核升级 0.1.1-rc.2 → 0.1.7-rc.1（最高杠杆，也最高风险）

- **目标**：一次拿到 78 个包（API/SDK/hooks 兼容/PTC/新 UI/格式迁移链），并为后续所有阶段解锁。
- **涉及文件**：`vendor/deepseek-harness-desktop/dsh-plugin-desktop/package.json`（`@deepseek-ai/dsh` 版本）、`patches/bundles/*`（**全部补丁必须重打或重写**）、`scripts/apply-*.mjs`（全部）、`scripts/verify-patches.ps1`、profile 的 `package.json` + `cordis.patch.yml`。
- **改动点**：
  1. **先做补丁清点**：列出当前所有 dist 补丁（`log-write-guard`、`profile-guard`、`tool-search-image-passthrough`、`json-storage-orphan-tmp-sweep`、`gpu-mode` 等）→ 逐个判定「上游是否已修」（例如 `dsh-atomic-write` 可能已让 orphan-tmp-sweep 变冗余；`dsh-session-format*` 迁移链可能改变会话目录结构）。
  2. **利用官方迁移链**：`dsh-session-format-v0-to-v1 → v1-to-v2 → v2-to-v3 → v3-to-v4` + `-catalog` ⇒ **会话数据有官方升级路径**，不必自己写迁移。
  3. **重打补丁**：按 `patches/bundles/` + `apply-*.mjs` 三件套纪律，逐个适配新 dist 产物。
  4. **`dsh-atomic-write` 替换自研原子写**（见 §3.3）—— 顺带删掉我们的 orphan-tmp-sweep（如果官方已覆盖）。
- **验证方式**：
  - `node scripts/startup-verify.mjs`（V1/V2/V4）
  - `node scripts/verify-patches.ps1` 全绿
  - `scripts/check-all.ps1` 全绿（当前基线 81 checks）
  - **故障注入**：故意弄坏 1 个补丁 → 断言门禁报红（证明门禁不是假绿）
  - **会话兼容实测**：拿一个旧会话（0.1.1 格式）在新内核打开，断言能读、能续跑
  - **`/health` 10 项探测**全绿
  - **真实 GUI 验证**：刷新 `http://127.0.0.1:43120` 后功能可用
- **回滚方式**：`_backups/kernel-upgrade-<ts>/` 全量存档 + git tag；`patches/bundles/` 保留升级前副本；profile 的 `package.json`/`cordis.patch.yml` 双份备份（照 QuWork 的检查点做法）。**必须保留「一键回退到 0.1.1-rc.2」的路径**。
- **风险/收益**：风险 **高**（触及启动链路 + 全部补丁 + 会话格式）；收益 **极高**（78 包 + 解锁后续全部阶段）。
- **门禁**：**本阶段不通过，后续阶段一律不做**（否则在旧内核上做样式/检查点等于白做，升级时要重来）。

---

### 阶段 P1 · 设计系统与排版对齐（P0 后）

- **目标**：会话区样式与 0.1.7 对齐；补上我们缺的 15 个 primitive；建立「token 权威 + 禁复制控件」纪律；修掉可访问性缺陷。
- **涉及文件**：内核升级自动带来的 `dsh-client-ui-{theme,primitives,layout,trajectory}`；自研品牌层 `plugins/dsh-*/lib/**`（client CSS）；`~/.dsh/` 下客户端样式覆盖（若有）。
- **改动点**：
  1. **复核 0.1.7 的 6 张样式表**是否已在我们的 GUI 生效（`corner-shape`、`elevation`、`scrollbar` 重绑定、`gradient-shadow-text` 字号阶梯）；缺失则说明我们的 index 注入链没接上 → 定位 `webserver/index-inject`。
  2. **字号阶梯落地**：确认 `ui-theme.fontSize` 12–17px 生效，且「代码/小字固定、流内行标题摘要低一档」符合预期。
  3. **FOUC 检查**：冷启动录屏/截图首帧，断言**无白闪、无字号跳动**；若我们的壳包了额外 DOM，需保证 boot script 仍先执行。
  4. **修 `--app-*` 对比度缺陷**：把 `#999` 类 secondary 文案改为 ≥4.5:1（如 `#5A5A5A`）；**跑对比度检查脚本**（我们的 `deck-design` skill 已有此类检查，复用到 UI）。
  5. **采纳三条设计纪律**：写进项目 `AGENTS.md`（token 单一权威 / 禁复制控件 / 加色须配尺度+语义）。
  6. **品牌层**：若需品牌字体，照 QuWork「只用于品牌位 + OFL 随包」的方式，不侵入正文栈。
- **验证方式**：
  - **对比度检查**：脚本扫描渲染后 DOM 的正文/背景对比度，断言 ≥4.5:1（大字号 ≥3.0:1）
  - **首帧检查**：截图比对，断言无 FOUC
  - **字号阶梯实测**：设置 12 / 14 / 17px 三档，断言正文/流内行/代码三类各自符合规则
  - **组件盘点**：断言 0.1.7 的 15 个新 primitive 可用（写一个探针页渲染全部）
- **回滚方式**：样式层改动可单独回滚；纪律写入 `AGENTS.md` 前先备份。
- **风险/收益**：风险 **低-中**；收益 **中高**（视觉一致性 + 无障碍 + 长期可维护）。

---

### 阶段 P2 · 插件体系硬化

- **目标**：把「并发改 profile 导致重启打不开」从**人肉纪律**变成**架构不可能**；补安全闸门。
- **涉及文件**：`plugins/dsh-super-injector/lib/**`（注入器）、新增 `lib/archive-guard.mjs`、新增 `lib/safe-download.mjs`、`plugins/*/lib/**` 的写点、`scripts/check-all.ps1`。
- **改动点**：
  1. **单操作互斥**（照 `plugin-market-service.js:228-295`）：在 injector 的 install/uninject/reload 与所有 profile 写入服务上加 `runExclusive()`，占用中返回 `{ok:false, errorCode:'operation-pending'}`。与现有 task-scheduler **互补**（task-scheduler 管跨进程/跨会话；本机制管进程内）。
  2. **改用官方 `dsh-atomic-write`**：把 `plugins/*/lib/**` 里所有裸 `writeFileSync`/`writeFile` 直写运行路径的调用替换为 `writeFileAtomic`；对「读-改-写」循环用 `withFileLock`。
  3. **归档安全闸门** `lib/archive-guard.mjs`：移植 `archive-security.js` 的 5 个函数（zip-slip / **symlink ancestor 写入检查** / **NFKC 大小写碰撞** / 大小·条目·深度上限 / 预检后解压）；接到所有解包点。
  4. **下载安全闸门** `lib/safe-download.mjs`：SSRF 防护（IPv4/IPv6 私有段 + DNS 解析校验）、`redirect:'manual'` 逐跳复检（≤3）、流式限长、`flags:'wx'` + `mode:0o600`、魔数嗅探。
  5. **vendor 离线包**（可选，视是否需要无网安装）：照 `dshmarket` 的 `offline-store.tgz` + 内置 pnpm + `--frozen-lockfile` 声明式安装。
- **验证方式**：
  - **并发压测**：同时 5 个 install → 断言恰好 1 成功、4 返回 `operation-pending`、profile 未被破坏
  - **故障注入（必做）**：恶意样本集逐个断言被拒 —— `../` 越界、绝对路径、`C:\`、UNC、symlink ancestor、大小写碰撞、超 100k 条目、设备文件、加密 zip、超长流、302 到 `127.0.0.1`
  - **原子写故障注入**：rename 前 kill → 断言原文件完好、无残留 `.tmp`
  - **Windows 瞬时错误**：模拟 `EBUSY` → 断言重试成功（验证官方包的重试真的生效）
  - `node --check` + `scripts/check-all.ps1` 全绿
- **回滚方式**：新增文件可删；调用点替换逐个可回退（`_backups/` + git）。
- **风险/收益**：风险 **中**（改热路径）；收益 **高**（消灭并发事故 + 供应链安全）。

---

### 阶段 P3 · 更新与回滚

- **目标**：给「能启动的状态」自动存档；补丁可信登记；启动失败可自助修复。
- **涉及文件**：新增 `lib/profile-checkpoint.mjs`、`scripts/profile-checkpoint.mjs`、`lib/startup-diagnosis.mjs`、`patches/manifest.json`（新增）、`scripts/verify-patches.ps1`、`scripts/startup-verify.mjs`。
- **改动点**：
  1. **Profile 三槽检查点**（照 `profile-health-checkpoint-service.js` 七要点）：`latest/previous/older` + `.candidate-<pid>-<uuid>`；`acquireSlotLease()` Promise 链互斥；**穷举崩溃中间态收敛**；capture 前后 + 发布前**三次 `sourceDigest` 比对**；`pendingHealthy + waiters + drain()` 合并捕获；**`skip-next-healthy.json`（带 generation）**防恢复后立刻拍坏快照；manifest 记 `sourceDigest/contentDigest/generation/files[].sha256/present`。
     - **两处必须偏离 QuWork**：① 大 tarball 走**内容寻址引用**（避免它的 3×998KB 冗余）② 快照前对 `bridgeToken`/`apiKey` 类字段**脱敏**（避免它的凭据扩散缺陷）。
  2. **补丁 digest 登记**：`patches/manifest.json` 记 `patchSet` + `patchDigest`（照 `runtime.json`），`verify-patches.ps1` 校验 digest 而非仅存在性。
  3. **启动失败 → 可执行修复方案**：`lib/startup-diagnosis.mjs` 产出 `proposal`（`plugin-order-adjustment` / `dangling-reference-cleanup` / `checkpoint-restore`），复用现有 `deregister-plugin.mjs --yes` 预检逻辑；CLI/UI 展示原因+影响面，用户确认后执行。
  4. **远端更新签名链**（若将来要远端内核更新）：移植 `release-manifest.js` 的 Ed25519 校验（`keyId` + target + 受信 HTTPS 前缀 + `strictBase64` 往返校验 + zod `.strict()`），三要素缺失即 fail-closed。
- **验证方式**：
  - **检查点故障注入（必做）**：在 rotation 每一步（写候选后 / rename 之间 / rename 后）kill 进程 → 重启断言 `recoverInterruptedPublish` 收敛到合法三槽且 latest 可用
  - **回滚演练**：故意写坏 `package.json` → 启动失败 → 回滚 → 断言恢复可启动
  - **skip 标记验证**：恢复后立即触发 capture → 断言被跳过
  - **digest 篡改检测**：改一个字节 → 断言 `verify-patches.ps1` 报红
- **回滚方式**：检查点目录独立于运行路径，删除即失效；代码为新增。
- **风险/收益**：风险 **中**；收益 **很高**（直接消灭「重启打不开」类事故）。

---

### 阶段 P4 · Skill 体系

- **目标**：技能注入更省 token、更易命中；安装有审计闸门。
- **涉及文件**：`~/.dsh/skills/**`（现有 40+ skill）、skill 加载器相关补丁、新增审计模块、`plugins/` 下技能管理插件。
- **改动点**：
  1. **注入格式改造**（照 `skill-manager.js:275-286`）：改成 XML + `<location>` 绝对路径 + `mandatory` 措辞，**只注入 `id/name/description/location` 四元组、不注正文**。
     - **这直接回应我们 `AGENTS.md` 记录的问题**：「9KB skill catalog 使锚定率 81%→0%」—— 四元组注入能大幅压缩 catalog 体积。
  2. **双通道**：支持 `disable-model-invocation`（模型不可调但用户可调）与 `user-invocable`。
  3. **多根发现**：用户根 + `$DSH_BUNDLED_SKILL_DIR` + appPath/skills + resources/skills，内置技能不可删。
  4. **安装审计闸门**：移植 `audit()` 三规则（`curl|bash` / `rm -rf /` / `secret 访问`）+ 高风险挂起待确认 + `installDisabled` 动作 + 路径包含校验 + `isSkillId()` 白名单。
- **验证方式**：
  - **锚定率实测**：改造前后各跑一组「该触发 skill 的 prompt」，断言触发率提升（**这是可量化的验收指标**）
  - **catalog 体积**：断言注入文本从 9KB 量级降到 KB 以下
  - **审计故障注入**：构造含 `curl|bash` 的技能包 → 断言挂起 + 返回 `auditReport`
- **回滚方式**：skill 目录可整体备份/还原；加载器改动为补丁可摘。
- **风险/收益**：风险 **中**；收益 **高**（token 成本 + 命中率 + 安全）。

---

### 阶段 P5 · 思考/轨迹与可观测性（P0 后主要靠升级获得）

- **目标**：让「思考」与「性能」成为用户可见的一等公民。
- **改动点**：
  1. **验收升级带来的 `dsh-client-ui-chat` / `-session` / `dsh-session-turn-outline`**：确认对话区/会话区/轮次大纲可用。
  2. **Trajectory 验收**：确认「思考」列、TTFT/生成时长/token 三指标、Overview 标尺、`Between turns` 桶、代码检视均可用。
  3. **复测 `dsh-force-reasoning-effort` 的必要性**（§2.3）：统计升级后仍缺 `reasoning` 元数据的模型数量；**若上游已补全，则卸载该插件**（避免维护冗余补丁）。
  4. **崩溃现场自带**：进程退出事件附 `stdoutTail`/`stderrTail`（各 ≤1536 字符 / ≤30 行）+ **URL/凭据脱敏**（照 QuWork 的 `[REDACTED_URL]`）；补 **NTSTATUS 退出码翻译表**（修 QuWork 自己的 D6 缺陷 —— `1073807364` = `0x40010004`）。
  5. **失败诊断**：移植 `failure-diagnostic-service.js` 的失败分类 + 日志摘录（`KEY_ERROR_PATTERN` 正则、`OUTPUT_EVIDENCE_TTL_MS:5min`、记录数/字节上限）。
- **验证方式**：轨迹页真实长会话（≥1000 事件）滚动流畅度；TTFT/token 与内核记账交叉核对；故障注入杀进程断言退出事件带现场且已脱敏。
- **回滚方式**：脱敏/诊断为新增代码；插件卸载走 `dev_uninject_plugin`。
- **风险/收益**：风险 **低-中**；收益 **中高**（可观测性 + 排障效率）。

---

### 阶段 P6 · 平台化（可选，按需）

- **改动点**：
  1. **对外更新/能力 API**（照 `UPDATE-API-V1.md`）：暴露 `capabilities`（含 `stability` / `restart.supported`）+ `updates/summary`（含 **`checked` 分母**）；**能力发现先行**，`restart.supported:false` 时客户端必须隐藏重启按钮。
  2. **REST API / SDK**：0.1.7 自带 `dsh-api-*-controller`（7 个）与 `dsh-sdk-*`（4 个）→ 直接复用，不自研。
  3. **Hooks 兼容**：`dsh-hook-protocol` + `dsh-hooks-claude-code` + `dsh-hooks-codex` → 可复用 Claude Code / Codex 生态的 hooks。
  4. **Webhook**：`dsh-webhook` + `dsh-webhook-github`。
- **验证方式**：契约测试（`capabilities` 字段完整性 + `checked` 语义）；SDK 冒烟调用。
- **风险/收益**：风险 **中**（新增对外接口面）；收益 **中**（生态集成）。

---

## 第五部分 · 优先级总表与建议

| 阶段 | 内容 | 风险 | 收益 | 依赖 | 建议 |
|---|---|---|---|---|---|
| **P0** | 内核升级 0.1.1-rc.2 → 0.1.7-rc.1 | **高** | **极高** | — | **先做**，且**先出补丁清点报告** |
| **P1** | 设计系统与排版对齐 | 低-中 | 中高 | P0 | P0 后立即验收 |
| **P2** | 插件体系硬化 | 中 | 高 | P0 | 可与 P1 并行 |
| **P3** | 更新与回滚 | 中 | 很高 | P0 | **最高价值**，建议紧接 P2 |
| **P4** | Skill 体系 | 中 | 高 | 独立 | 可与 P2/P3 并行 |
| **P5** | 思考/轨迹与可观测性 | 低-中 | 中高 | P0 | P0 后验收 + 补诊断 |
| **P6** | 平台化 | 中 | 中 | P0 | 按需 |

**我的建议顺序**：
1. **P0 的第一步不是升级，而是「补丁清点 + 会话格式影响评估」**（只读，低风险）→ 产出「哪些补丁上游已修 / 哪些必须重写 / 会话能否迁移」的清单。**没有这份清单就升级 = 赌博。**
2. 清单出来后再决定 P0 的执行窗口。
3. P2-2（改用官方 `dsh-atomic-write`）与 **P3（检查点）是收益最高的两项**，且**不依赖 P0 的全部成果**（atomic-write 我们已有）→ **可以立刻做**。

**立刻可做（不依赖 P0）**：
- **P2-2a**：**移植 0.1.7 的 `renameAtomicTemp`（Windows 瞬时 rename 重试）进本地 `dsh-atomic-write`** —— 约 20 行，**收益明确、风险极低**（§3.4 已实测确认我们缺这一段）
- **P2-2b**：`plugins/*/lib/**` 改用官方 `dsh-atomic-write`（包已在本地，零新增依赖）
- **P2-1**：单操作互斥（纯新增包裹层）
- **P2-3/P2-4**：归档/下载闸门（纯新增文件）
- **P4-4**：技能安装审计（纯新增）
- **P5-4**：崩溃现场自带 + 脱敏（纯新增）

---

## 第六部分 · 诚实边界

1. **[未验证]** QuWork 的 DSH web UI 是否**实际使用**了 0.1.7 的 `corner-shape` / elevation（我只验证了代码里存在，未截图验证渲染效果）。
2. **[已核实 → 见 §3.5]** ~~我们的 GUI 当前是否已有 FOUC-free 引导~~ ⇒ **已有**。
3. **[未验证]** 我们的 `ui-theme.fontSize` 设置是否生效（未实测）。
4. **[已核实 → 见 §3.4]** ~~`dsh-atomic-write` 版本是否一致~~ ⇒ **不一致：我们缺 Windows rename 重试**。
5. **[未验证]** 会话格式迁移链（v0→v4）能否把我们现有的会话无损升级（需实测）。
6. **[推断]** 0.1.7 primitives 的「结构重组」（`markdown/` 拉平、`ConnectionBanner`→`ConnectionIndicator`、`WebBlock` 并入）—— 由文件清单差异推断，未读 changelog 确认。
7. **[推断]** `dsh-force-reasoning-effort` 对 `reasoning:false` 模型强行注入元数据可能触发 `UNSUPPORTED_REASONING_EFFORT` —— 未实测。
8. **[未验证]** 我们是否已有 elevation 系统的**部分**实现（`elevation|backdrop-filter|shadow-lv` 我们 4 处 vs 他们 14 处 ⇒ 有少量但不成体系）。
9. 本文**未执行任何写入**；所有分析基于只读取证。
