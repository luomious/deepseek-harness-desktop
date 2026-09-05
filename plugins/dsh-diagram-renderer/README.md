# dsh-diagram-renderer

在 DeepSeek Harness 会话流中渲染**可交互的 SVG 图表卡片**（架构图 / 流程图 / 时序图 / 状态图 / ER 图 / 示意图等），开箱支持：**自适应免缩放展示**（宽度铺满、高度随图、右上角「自适应」标记）、复制源码、下载 `.svg` / 导出 PNG、全屏矢量细读；mermaid 引擎本地离线可用；并在设置页提供「图表」管理分区。

## 能力一览

| 面 | 机制 | 位置 |
|---|---|---|
| 工具 | `render_diagram`（host 注册，SVG 入参 → 校验清洗 → 原子落盘 → 返回信封） | `lib/index.js` |
| 渲染 | `tool.call.toolview` keyed 渲染器（交互 SVG 卡） | `lib/client.js` |
| 管理 | `settings.section` id=`diagram-renderer`（设置页「图表」分区） | `lib/client.js` |
| 触发 | skill `diagram`（对 agent 说「画架构图/用图形化解释…」即触发） | `skill/SKILL.md` |

## 接口契约（信封格式）

工具结果文本携带机器可读信封（HTML 注释，对模型可见但视觉无扰）：

```
<!--dsh-diagram:begin {"v":1,"title":"...","path":"diagrams/xxx.svg","bytes":1234}-->
<svg ...>...</svg>
<!--dsh-diagram:end-->
```

- `v`：信封版本（当前 1）
- `title`：卡片工具栏标题
- `path`：相对当前会话 cwd 的保存路径（工作区 `diagrams/` 目录）
- `bytes`：清洗后 SVG 字节数

client 渲染器两条通道分层解析：**turnTail 事件流走严格信封匹配**（信封缺失一律忽略——防止 read/skill 结果里的文档文本被误判成图，v4 幻影卡根治）；工具节点 keyed 卡（仅 `render_diagram` 结果）保留裸 `<svg>` 回退以兼容旧格式。

## 安全（纵深防御）

- **host 侧**（`sanitizeSvg`）：正则清除 `<script>/<foreignObject>/<iframe>/<object>/<embed>`、`on*` 事件属性、非 `#` 锚点的 `href/xlink:href`、全部 `src`；大小上限 512 KB。
- **client 侧**（`sanitizeSvgDom`）：DOMParser 解析后逐节点清除危险元素与属性，再序列化注入（`dangerouslySetInnerHTML` 前必经）。
- 失败降级不崩：解析失败/无 SVG → 回退摘要卡；复制/下载失败 → 静默兜底。

## 落盘与原子写

- 保存目录：`<会话 cwd>/diagrams/<文件名干>-<yyyymmdd-HHMMSS>.svg`
- 原子写：先写 `.tmp-<pid>-<ts>` 再 `rename`，无截断中间态（符合仓内原子写纪律）。

## 结构

```
plugins/dsh-diagram-renderer/
  package.json       # dsh.bundle.patch + dsh.client(web)；peerDeps 范围声明
  cordis.patch.yml   # insert 装配入口（id: dsh-diagram-renderer）
  lib/index.js       # host：render_diagram 工具（defineTool + ctx.effect）
  lib/client.js      # 手写 lazy-CJS bundle：自适应 viewer + MermaidWidget + settings 分区
  assets/mermaid.min.js # vendored mermaid v11.4.1 UMD（本地引擎，host /diagram-vendor 路由伺服）
  skill/SKILL.md     # diagram skill 源文件（安装到 ~/.dsh/skills/diagram/）
  tests/             # 管线回归（pipeline-test2.html + pw-run-pipeline.py，15 项断言）+ 活体探针（fiber 巡检 / 自适应卡度量）
  README.md
```

## 迭代（加一种图类型 / 交互）

1. 图类型扩展：只需在 skill 里补「何时选哪种图」的指导，渲染器与工具**无需改动**（SVG 是通用载体）。
2. 工具栏扩展：`lib/client.js` 的 `DiagramViewer` 增加按钮与对应处理函数即可。
3. 更复杂交互（节点点击弹出详情、关联高亮）：改 `DiagramViewer`，在 SVG 元素上用事件委托（`<g data-name>` 约定，阶段 2）。
4. 改后 `node --check lib/index.js lib/client.js`；热装配或重启后验证（遵守重启守则）。

## 安装 / 回滚

```bash
# 热装配（免重启）
dev_install_package dsh-diagram-renderer（本地目录）
# 预检卸载（只读）
node scripts/deregister-plugin.mjs --plugin @dsh-external/dsh-diagram-renderer
# 确认后执行
node scripts/deregister-plugin.mjs --plugin @dsh-external/dsh-diagram-renderer --yes
node scripts/startup-verify.mjs && node scripts/scan-dangling.mjs --strict
```

（或运行态内 super-injector `dev_uninject_plugin`。）

## 阶段计划

- 阶段 1 ✅：最小闭环——工具 + 渲染卡 + skill + 设置分区。
- 阶段 2 ✅：富交互——⋮ 菜单（下载 .svg / PNG / 复制 / 源码）、PNG 2x 导出、操作反馈。
- 阶段 3 ✅（2026-09-05）：长期健康——管线回归固化 `tests/`、Playwright 活体探针、严格信封防幻影（v4）、mermaid 本地引擎、自适应免缩放卡（v5）、CHANGELOG 登记。
- 阶段 4 ✅（2026-09-06）：节点 hover 高亮 + 点击详情弹层（事件委托，兼容 `<g data-name>` / mermaid `g.node`）；管线回归纳入 check-all.ps1 Step 2.5。

## 记录

- 2026-09-03 创建插件骨架；host `render_diagram`（defineTool 契约照抄 dsh-project-brief）；client keyed toolview + settings 分区；skill 源文件。
- 2026-09-03 阶段 1 完成并验证：`node --check` 全部通过 → skill 经 skills-manager `importFolder` 安装至 `~/.dsh/skills/diagram/`（技能目录已识别）→ `dev_install_package`（profile=desktop）热装配成功（loader `[active] @dsh-external/dsh-diagram-renderer`，client ✓）→ 端到端：调用 `render_diagram` 生成三层架构示例，原子落盘 `diagrams/architecture-sample-20260903-221837.svg`（3192 B），信封返回正常。task-scheduler 锁已 release（tk-mtlg4i71）。
- 2026-09-04 「对话直接内嵌图」通道：新增 host 路由 `GET /diagram-files/<file>.svg`（serve 最近 render_diagram 落盘的 SVG 字节，仅内存注册表防穿越）；`render_diagram` 返回文本首行附带 markdown 图片 `![title](http://127.0.0.1:<port>/diagram-files/<file>.svg)`，agent 照抄进回复即由 MarkdownText 内嵌渲染（图片只认绝对 http(s)，此路由满足）。skill 同步补充「必须粘贴图片行」指引（仓库副本已更新；用户目录副本因沙箱受限待重启后手工/API 同步）。**注意：打包壳无 loader.internal，host 改动须重启桌面应用生效**。
- 2026-09-04 阶段 2 富交互（client.js）：显示框放大（`height: min(560px, 72vh)`，min 320px）、**首次渲染自动铺满容器宽度**（fit-to-width，图更大、文字更清晰）、工具栏右上角 **⋮ 菜单**（下载 .svg / 保存为图片 PNG（canvas 2x 导出）/ 复制代码 / 查看代码（内嵌源码层））、操作反馈提示（"代码已复制 / PNG 已导出"）、深色主题随 DSW 变量。**纯 client 改动：刷新页面即生效，无需重启。**

## 重启说明（重要）

- `lib/index.js` 的 host 改动（/diagram-files 路由 + markdown 图片行）在打包壳下**无法热重载**（`dev_reload_package` 报 loader.internal 不可用），必须**重启桌面应用**。
- 重启后：新画图时 agent 回复会带 `![...](http://127.0.0.1:43120/diagram-files/...)` → 图直接内嵌对话流（无需刷新、无需交互卡）；页面刷新后交互卡（复制/下载/缩放/⋮ 菜单）同时可用，双通道并存。
- `lib/client.js` 改动（阶段 2 交互卡）**只需刷新页面**（client bundle 按请求读盘 + no-cache），无需重启。
- 重启动作由用户执行（遵守重启守则）。
- 2026-09-05 渲染管线根因修复 + 引擎本地化（WorkBuddy 同款离线）：① Playwright fiber 探针实锤交互卡空白根因——DSH 更新后工具结果 block 不再是 `{type:'text'}`，client `resultText` 落入 JSON.stringify 兜底 → 信封整体被 JSON 转义（实测 props.svg：`"`×1106、`\n`×143、真实换行×0）→ DOM 解析全毁只剩 `\n` 字面量。② `resultText` 重写为形状自适应（string / {text} / {output} / {content} 递归），`parseEnvelope` v2 检测转义并反转义（任一段命中即两段 force，修复 mermaid 少转义对漏网）。③ mermaid 引擎本地化：vendored `assets/mermaid.min.js`（v11.4.1 UMD）+ host 新路由 `GET /diagram-vendor/mermaid.min.js`，客户端本地优先、CDN 兜底（路由需重启生效）。④ 管线单元测试 `pipeline-test2.html` + `pw-run-pipeline.py`：15/15 PASS。⑤ client 改动刷新即生效、历史坏卡自动恢复；host `/diagram-vendor` 路由需重启一次。
- 2026-09-05 **v4 根因修复**：① turnTail 严格信封 + `looksLikeRealSvg`（≥200 字符含 viewBox/width）——根治 14/15 幻影空卡（read/skill 结果里 SKILL.md 文档文本的字面 `<svg>` 占位符被误提取成图）；② `forceExplicitSize` 显式像素尺寸——根治 `width="100%"` 在 fit-content 容器内塌缩为 217×127 小图；③ WorkBuddy 纸面卡（#F7F6F2 卡身 + 恒定纯白画布，不随暗色主题变黑）。
- 2026-09-05 **v5 自适应免缩放卡（卡片即相框）**：移除全部缩放/平移控件，fit-width + 高度随图宽高比 hug（下限 260px / 上限 min(78vh,720px)），超高图卡内滚动；ResizeObserver 自动重排；工具栏精简为 全屏 + ⋮。SKILL 新增「**按显示尺寸作画**」规范（画布 960–1050px、节点字 ≥17px，禁大画布缩小——用户实测字体小根因）。整理：回归测试固化 `tests/`，调试产物归档 `_backups/diagram-debug-20260906/`（41 项，零删除）。