---
name: diagram
description: "生成可交互的 SVG 图表卡片（架构图/流程图/时序图/状态图/ER图/示意图/项目进度看板等），内嵌会话流，支持复制源码、下载、缩放与平移。当用户要「画/生成架构图、流程图、时序图、状态图、示意图、进度看板」，问「项目进度如何/各阶段完成情况/里程碑/Roadmap」，或要求「用图形化解释/图解」某个概念时使用。"
whenToUse: "用户请求创建架构图、流程图、时序图、状态图、ER图、部署图、泳道图或一般示意图，或要求图形化解释概念时；用户明确提到 SVG 图表、可视化示意图时；用户询问项目/任务进度、各阶段完成情况、里程碑、Roadmap 时（直接用 board 参数生成进度看板）。"
invocation:
  trigger: auto
  modelInvocable: true
  userInvocable: true
---

# Diagram — 智能可交互 SVG 图表

## 核心原则：理解意图，自主设计

**你不只是画图工具，你是视觉设计师。** 用户说「帮我画」时，你必须：
1. **理解内容本质**——这段信息的结构是什么？对比？流程？层次？递进过程？
2. **自主决策形式**——单图还是分步？什么布局？需要统计卡吗？画布多大？——**你自己判断，不要问用户**
3. **一次性画好**——用户说「帮我画」，你直接给出最合适的方案

### 智能决策：单图 vs 分步

**自动选分步**（满足任一）：
- 内容有递进过程（逐步筛选、优化、展示）
- 内容有参数对比（不同阈值/方案的效果）
- 内容有阶段演进（算法各阶段、方案迭代）
- 用户说「展示过程」「演示步骤」「对比效果」「参数效果」

**自动选单图**：
- 内容是静态结构（架构总览、关系图、部署图）
- 内容是单一快照（当前状态、配置总览）

**关键**：用户说「画参数效果」→ 你自动判断为分步（3-4 个参数档位对比），**不需要用户说"用分步图"**。

### 智能决策：画布尺寸与布局

| 内容类型 | 画布宽 | 布局 | 分步？ |
|---|---|---|---|
| 架构总览 | 900-1050px | 分层容器 + 模块节点 | 否 |
| 参数对比 | 720-900px | 分步 + 统计卡 | 是 |
| 递进流程 | 720-900px | 纵向分层 + 分步 | 是 |
| 关系网络 | 800-1000px | 网状布局 | 否 |
| 方案演进 | 720-900px | 分步 + 指标条 | 是 |

**永远不要**画 1300px+ 大画布再缩小——字会缩到看不见。按显示尺寸作画：对话列窄（<800px）→ 画布 650-750px、字号 ≥18px。

## 先想后画（五步思考）

画图前**必须**完成五步，禁止拿到主题直接套骨架：

**Step 1 · 内容解构**：这段信息的真实结构是什么？
- **线性流水线**：A→B→C 顺序依赖
- **并行泳道**：一个输入分给 N 条并行路径再汇合
- **层次包含**：整体-部分、分层架构
- **循环/状态**：有回边、状态迁移
- **论证对比**：基线 → 改进 → 终值
- **递进过程**：逐步筛选/优化/展示 → 用分步

**Step 2 · 一句话主旨**：写下「读者看完这张图要带走的一个结论」——图里每个元素都必须服务它，服务不了的就删。

**Step 3 · 布局选型**（结构决定布局）：

| 结构 | 布局 |
|---|---|
| 线性 | TD / LR 单列直排 |
| 并行泳道 | 输入 → N 列并行 → 汇合 |
| 层次 | 嵌套容器由外到内 |
| 循环/状态 | 回边 + 状态节点 |
| 论证对比 | 三段式：主线 + 侧卡 + 指标条 |
| 递进过程 | 分步（stages）+ 统计卡 |
| **进度/完成度** | **进度看板（board）+ 可选阶段演进** |
| **场景/应用/系统组成** | **应用场景图（scene）** |

**进度类内容一律选进度看板**：用户问「项目进度怎么样」「各阶段完成多少」「里程碑达成情况」「画个 Roadmap 进度」→ 内容本质是**完成度数据**，不是结构关系。此时**必须用 board 参数**（数据驱动、内置模板），**不要手绘 SVG、不要用分步图凑**。

**场景类内容一律选 scene**：用户说「画个应用场景图」「这系统用在哪」「整体方案示意」「产线怎么布置的」→ 内容本质是**若干实体 + 它们之间的关系**，此时**用 scene 参数**（数据驱动、内置图标库与自动布局），**不要手绘 SVG 挨个摆矩形**——手绘最容易出现的就是排版错乱、字号不一、连线压字。

**Step 4 · 取舍**：节点 >14 个时依次砍——细节降级为副文字 → 降级为图下文字说明 → 删除；**绝不为了全面而塞**。

**Step 5 · 选通道**：结构简单线性 → mermaid（快）；并行泳道/复杂构图/分步 → 手绘 SVG（表达力强）。mermaid 画不出的结构别硬套。

## 工具调用契约

### 模式 ①：Mermaid 自动布局

```
render_diagram({
  title: '简短标题',
  mermaid: 'flowchart TB\n  A[开始] --> B[处理]\n  B --> C{通过?}\n  C -->|是| D[发布]\n  C -->|否| E[修复]'
})
```

Mermaid v11 本地引擎自动布局。节点文字 ≤ 10 字/行；多行代码用真实换行。

### 模式 ②：手绘 SVG（含分步）

```
render_diagram({
  title: '图标题',
  svg: '<svg ...>...</svg>',
  stages: [  // 可选：分步交互
    { "id": "s0", "title": "阶段1", "description": "说明文字",
      "layers": ["s0"],
      "stats": [{"label": "指标名", "value": "数值"}] },
    { "id": "s1", "title": "阶段2", ... }
  ]
})
```

### 模式 ③：进度看板（board —— 进度类内容首选）

项目/任务进度、阶段完成情况、里程碑、Roadmap —— **只传数据，内置模板自动生成**（无需手写 SVG，视觉自动统一）。

```
render_diagram({
  title: 'RK3588 边缘部署进度',
  board: {
    overall: { label: '整体进度', pct: 41 },   // 可选，缺省 = 各 item 均值
    items: [
      { label: '硬件选型与采购', pct: 100, status: 'done',    note: 'RK3588 已到货' },
      { label: 'BSP / 驱动适配', pct: 80,  status: 'active',  note: 'NPU 驱动联调中' },
      { label: '模型转换与量化', pct: 45,  status: 'active' },
      { label: '产线联调',       pct: 0,   status: 'blocked', note: '等相机到货' },
      { label: '性能优化',       pct: 0,   status: 'pending' }
    ]
  }
})
```

**status 语义（色彩即状态）**：

| status | 含义 | 颜色 | 何时用 |
|---|---|---|---|
| `done` | 完成 | 终值绿 | pct = 100 |
| `active` | 进行中 | 靛蓝主色 | 0 < pct < 100 |
| `blocked` | 阻塞 | 橙 | 卡住 / 等外部依赖（note 写清原因） |
| `pending` | 未开始 | 中性灰 | pct = 0 |

- `status` 可省略 → 按 pct 自动推断；也接受中文「完成 / 进行中 / 阻塞 / 未开始」与常见英文变体（wip / todo 等）。
- `note`（可选）：补充说明，hover 显示，**不占版面**（保持一行式极简排版）。
- `overall`（可选）：顶部整体进度条；缺省取各 item 均值。

**动态演进（stages + board）**：要让看板随时间/阶段推进，给 `stages`，**每项只写变化量**（按 index 与基线合并，未写的字段继承基线）：

```
render_diagram({
  title: 'RK3588 边缘部署进度',
  board: { items: [ /* 基线：当前状态 */ ] },
  stages: [
    { id: 'w1', title: '第 1 周 · 硬件到位', description: '核心板到货，BSP 启动。',
      board: { overall: { pct: 22 }, items: [{ pct: 100 }, { pct: 40 }, { pct: 0 }] } },
    { id: 'w2', title: '第 2 周 · 驱动攻坚',
      board: { overall: { pct: 33 }, items: [{}, { pct: 65 }, { pct: 15 }] } }
  ]
})
```

阶段切换时**进度条平滑过渡 + 百分比 count-up**；交互卡带 ◀ ▶ 自动播放（2.5s/阶段）、阶段点跳转、键盘 ← → / 空格。

> ⚠️ **别混用两种进度条**：进度看板的进度条 = **真实完成度**；分步图（模式 ② stages）的进度条 = **播放时间轴**。问「进度如何」用 board，问「过程/原理」用分步图。

### 模式 ④：应用场景图（scene —— 场景类内容首选）

「应用场景」「整体方案」「系统组成」「产线布置」「系统架构」这类**若干实体 + 关系**的图 —— **只传数据**，v9 渲染内核自动完成：语义配色、分组分区、智能字号、自动网格布局 + 连线路由、深浅双主题。

```
render_diagram({
  title: '工业缺陷检测 · 应用场景',
  scene: {
    subtitle: '相机采集 → 边缘推理 → PLC 剔除',   // 可选
    groups: [   // 可选：分区/分层/泳道（未入组节点自动成末组）
      { id: 'g1', name: '感知层', members: ['cam'], color: 'device' },
      { id: 'g2', name: '边缘层', members: ['core'], color: 'core' },
      { id: 'g3', name: '执行/展示', members: ['plc', 'hmi'], color: 'frontend' }
    ],
    actors: [
      { id: 'cam',  name: '海康工业相机', type: 'device', desc: 'MV-CA050-12UC / 500 万像素' },
      { id: 'core', name: 'RK3588 推理盒', type: 'core', highlight: true, desc: 'YOLOv8 + TensorRT FP16' },
      { id: 'plc',  name: 'PLC 剔除机构', type: 'backend', desc: 'NG 信号 → 气动剔除' },
      { id: 'hmi',  name: '上位机看板',   type: 'frontend', desc: 'PyQt5 实时统计' }
    ],
    flows: [
      { from: 'cam',  to: 'core', label: '图像帧', kind: 'sensor' },
      { from: 'core', to: 'plc',  label: 'NG 信号', kind: 'control' },
      { from: 'core', to: 'hmi',  label: '检测结果', kind: 'data' }
    ],
    footer: ['节拍：120ms / 件', '目标 mAP50 ≥ 0.90'], showFooter: true   // 默认不渲染图下要点面板，需显式 showFooter:true
  }
})
```

**语义类型 `type`（决定配色 + 默认图标；缺省按 `icon` 自动推断，旧 icon-only 参数全兼容）**：
`frontend` 前端（cyan）· `backend` 后端（emerald）· `data` 数据/存储（violet）· `cloud` 云服务（amber）· `security` 安全（rose）· `bus` 消息总线（orange）· `external` 外部（slate）· `person` 人员（blue）· `device` 设备（teal）· `core` 核心（indigo）

**图标 `icon` 库（20 个）**：`core` · `camera` · `lidar` · `plc` · `screen` · `person` · `robot` · `agv` · `shelf` · `glass` · `workpiece` · `generic` · `database` · `shield` · `cloud` · `globe` · `queue` · `api` · `doc` · `key`（写错自动回落 `generic`）

**字段约束**：
- `actors` 每个必须有 `name`（缺名的会被丢弃）；`id` 省略自动补 `a0/a1…`；`highlight: true` 标核心节点（类型色描边 + 「核心」徽章）；上限 14 个
- `groups`（可选，≤6 组）：`{ name, members:[actorId], color? }` —— 表达层/边界/泳道；`color` 取上表 type key，给分区淡色底板
- `flows` 的 `from`/`to` **必须引用真实存在的 id** —— 指向不存在节点的连线会被自动剔除（写错不报错，只是不画）
- `kind`：`data`（默认，indigo 实线）/ `sensor`（teal 实线）/ `control`（amber 虚线）/ `event`（violet 点线）/ `security`（rose 长虚线）
- `theme`：`auto`（默认，跟随系统深浅自适应）/ `light` / `dark`
- `footer`：要点面板，字符串或字符串数组，≤6 条；**默认不渲染**，必须同时 `showFooter: true` 才在图下显示
- `desc` 支持 `\n` 或 `/` 分段；v9 自动词换行 ≤2 行（超长只省略号收尾，不溢出）

**何时仍用模式 ② 手绘 SVG**：需要精确控制坐标、画非网格结构（时间轴、矩阵、树形、对比分栏）时用模式 ②；只是「几个东西怎么连」一律用 scene。

## 分步交互图（stages 协议）

### SVG 结构约定（分层式，一个 SVG 装全部阶段）

- 公共背景/常显元素放 `<g data-stage="all">`（始终可见）
- 每个阶段一组 `<g data-stage="s0">`、`s1`…，仅该阶段显示
- stages 数组每项 `{ id, title, description?, layers?, stats? }`
- `layers` 列出该阶段要显示的层 id（`"all"` 自动常显）；省略 `layers` 则显示全图
- `stats`（推荐）：该阶段数字概览 `[{ label, value }]` × ≤6，渲染在图下方统计卡
- 阶段数量 2–6 最佳；每阶段只画"这一步新增/变化"的内容
- 说明与统计显示在图下方面板（不遮挡图）
- **分步图画布建议 720–900px 宽**

### 动画效果

渲染器自动附加：
- 阶段切换 320ms 上浮渐入 + 400ms 亮度高光
- 自动播放时控制条进度条 + 当前阶段点脉冲
- `prefers-reduced-motion` 自动降级

## 设计系统（v9 —— scene 数据驱动渲染内核，与对话内联图完全同源）

scene 模式由 v9 内核自动渲染，规则已内置；手绘 SVG（模式 ②）请遵循同一套规范保持一致：

**画布与字号**：
- 画布宽 **680 恒定**（viewBox `0 0 680 <H>`；安全区 x=40..640），H = 最底元素 + 24；信息多就增高，不压扁留白
- **智能字号（内核自动，手绘时手动执行）**：标题 17→15→14→13 逐级缩放，**绝不截断标题**；卡名 13→12→11 缩放后才允许省略；描述 11px 词换行 ≤2 行
- 字重只有 **400 / 500** 两档；最小字号 11px

**语义色彩系统（scene 的 `type` 决定配色，10 类）**：

| type | 语义 | 基色 | | type | 语义 | 基色 |
|---|---|---|---|---|---|---|
| frontend | 前端 | cyan #0891B2 | | person | 人员 | blue #2563EB |
| backend | 后端 | emerald #059669 | | device | 设备 | teal #0D9488 |
| data | 数据/存储 | violet #7C3AED | | core | 核心 | indigo #4F46E5 |
| cloud | 云服务 | amber #D97706 | | security | 安全 | rose #E11D48 |
| bus | 消息总线 | orange #EA580C | | external | 外部 | slate #64748B |

**配色纪律**：卡片 = 白/纸面底 + 1px 中性描边 + **左侧 3px 类型色条** + 类型色图标；highlight = 类型色描边 1.5px + 同色 10% 淡填充 + 「核心」徽章；分组 = 类型色 6% 淡底底板。同一张图**类型色 ≤3 种**（多则降级为 neutral）。

**流量 `kind` 线型**：data=indigo 实线 · sensor=teal 实线 · control=amber 虚线 6 3 · event=violet 点线 2 4 · security=rose 长虚线 9 4；箭头一律标准 chevron marker（viewBox 0 0 10 10，`M2 1L8 5L2 9`，stroke-width 1.5）。

**双主题**：scene 默认 `theme:'auto'` —— SVG 内嵌 CSS 变量 + `@media (prefers-color-scheme:dark)`，一份图亮暗自适应（变量作用域 `svg{}`，inline 注入不污染宿主页面）；可 `theme:'light'|'dark'` 强制。手绘 SVG 也可用 `style="fill:var(--dsh9-*)"` 同构实现。

**分组分区（`scene.groups`）**：每个分组渲染为圆角 14 淡色底板（带名称 + 类型色圆点），表达层/边界/泳道；跨组连线走组间沟槽，卡片下层绘制避免横穿。

**形状与连接**：卡片 rx=10，分组 rx=14，徽章 rx=4；文字框内 `dominant-baseline="central"` 垂直居中；连线 1.5px 且 `fill="none"`。**克制原则**：无渐变 / 无投影 / 无发光 / 无 emoji（图标用几何 path）/ 无旋转文字；一图只讲一件事。

**DSH 渲染偏差（手绘 SVG 必须带上）**：
- **背景**：根元素第一子元素 `<rect x="0" y="0" width="100%" height="100%" style="fill:var(--dsh9-dp)"/>`（或纯白）——暗色主题穿透防护
- **显式宽高**：根元素带 `width="680" height="<H>"`（交互卡 wrapper 需要像素尺寸，`width="100%"` 会塌缩成缩略图）
- **可访问性**：根元素加 `role="img"`，紧跟 `<title>` + `<desc>`

**v8 逃生门**：极少数需要旧引擎的调用给 scene 加 `engine:'v8'`（不建议长期使用）。

## 自适应出图原则

卡片按「fit-width + 高度随图」自适应渲染（卡片即相框，用户零缩放）：

1. **画布宽固定 680**：所有坐标按 680 设计，显示端等比放大——**禁止**画 1000px+ 大画布再靠 fit 缩小（字号会被压小变糊）。
2. **高度**：H = 最底元素 + 24；信息多就增高，**不要**为凑比例压扁留白。
3. **信息密度**：一行 ≤3 节点、一屏 ≤4 层（进度明细行例外）；塞不下就砍副文字/拆图，不靠缩放救。

## SVG 编写规范

1. 根元素 `<svg viewBox="0 0 680 H" width="680" height="H" role="img">`，首子元素放白色背景 rect，随后 `<title>`/`<desc>`。
2. 字号按上文层级表：主标题 15/500、节点 13、副字 12–13、最小 **11px**；字重仅 **400/500**。
3. 文字超宽**必须截断**（用省略号），绝不溢出安全区 40..640。
4. 排版呼吸感：节点间距 ≥60px（进度行 40px 基准）；每行最多 3 个节点；留白即设计。
5. 禁止：`<script>`、`on*` 事件属性、非 `#` 开头的 `href/src`；不用渐变/阴影/emoji/600/700 字重。
6. 结构化（推荐）：给每个节点 `<g id="node-xxx" data-name="节点名">…</g>`。

## 动效（推荐 · 与分步图天然配合）

在 SVG 根内嵌 `<style>` 即可加纯 CSS 动效。**分步图每步层重显会重放动画——正好做成"这一步的讲解动画"**。

即用模板：
- **箭头流动**：`.flow{stroke-dasharray:10 8;animation:dshflow 1.1s linear infinite}@keyframes dshflow{to{stroke-dashoffset:-18}}`
- **点脉冲**：`.pulse{animation:dshpulse 1.6s ease-out infinite}@keyframes dshpulse{0%{r:4;opacity:1}70%{r:10;opacity:.25}100%{r:4;opacity:1}}`
- **描线生长**：`.draw{stroke-dasharray:600;stroke-dashoffset:600;animation:dshdraw 1.2s ease forwards}@keyframes dshdraw{to{stroke-dashoffset:0}}`

**克制原则**：只给关键路径加动效；加 `@media (prefers-reduced-motion:reduce){*{animation:none !important}}` 尊重无障碍。

## 展示策略

交互卡（自适应免缩放/下载/PNG/全屏）会在回复下方自动出现——默认不要把 markdown 图片行粘贴进回复。

仅在以下情况粘贴图片行：用户明确要求图文混排、本会话交互卡渲染异常、用户要直链分享。

## 流程

1. 理解需求 → **智能判断**图类型和形式（不要问用户）
2. 用 SVG 组织好布局（先算好坐标网格）
3. 调用 `render_diagram` 传入 title + svg +（可选）stages
4. 卡片出现后，如需修改，重新调用并说明改动点

## 注意

- 图要**一次画好**：SVG 是结构化代码，别边画边试；先规划坐标再写。
- 复杂系统可拆成多张图（每张聚焦一个层次），不要塞一张图。
- 用户对图提出修改意见时，基于原 SVG 增量改，重调 `render_diagram`。