# 示意图风格变体计划（v9.4 · 布局三向 + 四套视觉身份）

> 2026-09-10 立项。起因：用户反馈「风格统一一眼 AI / 排版一模一样」。
> 状态：**✅ 已完成**（2026-09-10，3 次提交）。

## 调研结论（2026-09-10）

- **archify**（对标，tt-a1i.github.io/archify）：5 种图型自动匹配（架构/泳道工作流/时序/数据流/状态机）× **4 套视觉身份**（Classic / Signal Flow / Blueprint / Editorial），共用同一几何契约，每套配深浅双主题。模板感的解法 = 布局随内容变 + 视觉身份随内容变。
- **Napkin AI**：同一文本按内容匹配不同视觉形式（流程图/导图/信息图）。
- **Mermaid/ELK**：direction TB/BT/LR/RL 四向 + 泳道。
- 我们 v9 现状 = 1 布局（vertical 三分组）× 1 视觉（暖纸卡）→ 千图一面根因。

## 推荐方案：一期全量

### 1. 布局三向（scene 新参数 `layout`）

| 值 | 形态 | 适用 |
|---|---|---|
| `vertical` | 现状：组纵排、组内 2-3 列卡 | 分层架构（默认兜底，代码不动） |
| `horizontal` | 左→右泳道：每组一列竖排卡，列间横沟槽走线 | 流程/管道/生命周期（≤4 组最佳） |
| `radial` | hub-spoke：中心卡居中，辐条卡左右两翼纵排，连线直线辐射 | 中心系统 + 周边依赖（1 个节点连出 ≥3 线） |

**auto 推断规则**（按序判定，v9.4 修正版）：
1. flows 中水平推进占比（from 在前组且 to 在后组且组间连线 ≥60%）且组数 ≤4 → `horizontal`
2. 存在单节点度数占比 ≥75% **且** 该节点连接方向一致（入度或出度 ≥60%）→ `radial`；双向中转节点（如内核）不触发
3. 其余 → `vertical`

### 2. 四套视觉身份（scene 新参数 `preset`，design.js 实现）

| preset | 底色 | 卡片形态 | 强调 |
|---|---|---|---|
| `paper`（现状） | 暖纸 #FBFCFB | 白卡描边 + 左 3px 色条 | 类型色 10 类 |
| `blueprint` | 深蓝图纸 #0B1E33 | 透明底双细白描边 + 等宽小标注（mono 角标） | 青白线 + 单点青强调 |
| `editorial` | 米白 #FAF8F4 | 无底色，底部 1px 分隔线 + 序号编排（01/02…） | 灰阶为主 + 单强调色（橙红 #C2410C） |
| `signal` | 冷白 #F6F8FA | 实底浅色卡 + 1.5px 粗边无阴影 | 高对比类型色 + 粗连线 2px |

每套 preset 均含 light/dark 双主题变量（沿用 `svg{}` 作用域 + prefers-color-scheme 机制）。

**auto 选 preset 规则**：cloud/data 类型占比高 → `blueprint`；person/external 占比高（叙事类）→ `editorial`；flows ≥8（密度高）→ `signal`；默认 `paper`。

### 3. SKILL 协议（模式④补参数）

- `layout?: 'auto'|'vertical'|'horizontal'|'radial'`、`preset?: 'auto'|'paper'|'blueprint'|'editorial'|'signal'`
- 选型指引：分层架构→vertical；流程/管道→horizontal；中心服务→radial；infra→blueprint；叙事/方案→editorial；密流→signal

## 实施清单（按序）

- [x] S1 design.js：PRESETS 变量表（4 套 × light/dark）+ `buildCssVars` 接受 preset
- [x] S2 scene-v2.js：normalize 接受 layout/preset（校验+缺省 auto）
- [x] S3 scene-v2.js：horizontal 布局函数（组→列、列间沟槽、跨列线 3 情形路由）
- [x] S4 scene-v2.js：radial 布局函数（hub 定位、两翼纵排、直线辐射 + 防标签压卡）
- [x] S5 scene-v2.js：auto 推断 + 卡片/连线/chip 渲染按 preset 分支
- [x] S6 index.js：schema 透传 layout/preset（additionalProperties 合规）
- [x] S7 smoke 扩展：同数据 ×3 布局 ×4 preset 快照 + 无 NaN/undefined 检查（21 组合 ALL PASS）
- [x] S8 Chrome 截图目检（auto 各触发一次 + 强制各 preset；modlens OCR 通过）
- [x] S9 SKILL.md + 用户级同步；CHANGELOG V9-11~V9-14 补记
- [x] S10 node --check 全过 → 用户重启 → 会话内实图验收 → git 提交（3 commits: e5820b4 + 8c3c0a6 + 23c1cb0）

## 补充修复

- **auto radial 误判修复**（8c3c0a6）：hub 度数 ≥75% 且入/出度单向 ≥60% 才选 radial，避免双向中转节点（如 DSH 内核）被误判
- **自适应按钮可点击 + 出血 ±100px**（23c1cb0）：`自适应` 文字改为按钮（点击反馈「✓ 视图已适配」），卡片出血 ±80→±100px

## 验证清单

- [x] smoke ALL PASS（21 组合）
- [x] auto 推断命中正确（构造 3 组用例各触发一种布局）
- [x] 截图目检：无文字截断/连线穿卡/chip 压字；四套 preset 气质差异肉眼可辨
- [x] 旧调用（无新参数）行为与 v9.3 完全一致（回归）

## 回滚

`git revert` 单提交；实施前快照 `_backups/diagram-v94-pre-<ts>/`（scene-v2/design/index/SKILL 四文件）。

## 风险与缓解

- 布局引擎大改 → vertical 路径代码不动；horizontal/radial 为新增分支，bug 只影响显式/auto 命中场景
- preset 遗漏变量 → 变量表集中一处 + 渲染只用变量名（禁止硬编码色）
- 重启疲劳 → 一次开发轮一次重启；S7/S8 全过才通知重启
