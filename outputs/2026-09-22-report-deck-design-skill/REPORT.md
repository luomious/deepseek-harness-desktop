# 详细调查记录：参考稿逆向、设计维度分析与工具链审计

- 日期：2026-09-22
- 调查对象：`C:\Users\机械革命\Desktop\模型训练分析报告.pptx` + `scripts/ops/ppt/`（31 个脚本）+ 两个已装 skill
- 方法：3 个并行子代理（正交切面：工具盘点 / 设计维度 / 版面逆向）+ 主代理交叉复核与实测
- **全程对用户项目只读**；唯一的副本与渲染件在 `D:\Deepseek-Harness\_tmp\ref-deck-20260922\`

---

## 1. 参考稿完整版面系统（实测，非估算）

### 1.1 网格

```
canvas          13.333 × 7.500 in (12192000 × 6858000 EMU)
margin          0.55（文字块）/ 0.50（图表与页脚）
content width   12.20
title box       0.55, 0.32, 12.20 × 0.62   @ 27.0pt bold  #22303E
eyebrow         0.57, 0.95, 12.20 × 0.34   @ 11.5pt       #5F7080
首屏内容起      y ≈ 1.35 – 1.95
footer left     0.50, 7.08, 7.50 × 0.30    @ 8.5pt        #93A5B3
page number     11.60, 7.08, 1.20 × 0.30   @ 8.5pt
card gaps       0.22（4 卡行）/ 0.30 横 + 0.25 纵（2×2）/ 0.25（结论双卡）
```

> **注意**：项目内此"不变量"已漂移 —— `build_v8m_v11m_board_20260922.py:44` 写 `0.55, 12.23, 7.02`，而 `build_weekly_chartdecks_20260922.py:49` 写 `0.55, 12.20, 7.08`。同一"实测不变量"两个值 ⇒ 这正是"必须把 token 写进单一文件"的理由。

### 1.2 八个版面原型

| id | 原型 | 签名 |
|---|---|---|
| A1 | 封面 | 满版深底 `1B2A38`（出血 `y=-0.82`）；标签胶囊；38pt 白标题；31pt 琥珀副标题；3 张 KPI 卡（w 3.90 h 1.35，间距 0.20） |
| A2 | 内容页页眉 | 27pt 标题 @y0.32 + 11.5pt 导语 @y0.95；二级小标题 14ptB @y1.50 |
| A3 | 4 卡 KPI 行 | y1.50 h1.95 w2.95，x=0.55/3.72/6.89/10.06；数字 30ptB、标签 13ptB、说明 9.5pt |
| A4 | 2×2 KPI 阵 | w5.90 h1.85，x=0.55/6.75，y=1.55/3.65；底部通栏深色汇总条 |
| A5 | 图表 + 侧栏 | 图 0.50,1.40,~9.3×5.3；深/浅面板 x≈10.0 w≈2.75 |
| A6 | 图 + 表分栏 | 左图 ~5.6–6.6 宽；右表/卡 6.15–6.55 宽 |
| A7 | 整页图片 | 单 PICTURE，无标题无页脚无文字 |
| A8 | 结论页 | 左右等大双卡（深 + 白描边），y/h 完全一致，间隙 0.25 |

### 1.3 页面节奏

```
序  原型                          形状  字符  图  轻/重
1   A1 封面                        16   205   0   重（视觉重、信息轻）
2   A2+A3 总览（KPI+时间线+结论栏）  40   744   0   最重
3   A5+A6 图+表                     9   526   1   重
4   A5 图+三档卡                    10   322   1   中
5   A5 大图+侧栏                     8   333   1   中
6   A5 大图+双卡                    11   367   1   中
7   A5 双图+注释                     9   255   2   中
8   A4 2×2 KPI+汇总条               22   483   0   重
9   A7 整页图                        1     0   0   极轻（呼吸页）
10  A7 整页图                        1     0   0   极轻（呼吸页）
11  A8 结论                        11   481   0   重
```

规律：**内容页刻意控制在 ≤11 形状**，靠大图表撑版面而非堆小元素；6 张图集中在**连续 5 页**；末段两页整页图作视觉呼吸；首尾深色收束。

### 1.4 图表规范（6/6 实测）

- **一律不设图表标题**（`c:title`=0 且 `c:autoTitleDeleted`=1），标题由图上方 14ptB 文本框承担
- **图例**：多系列才有；单系列一律无
- **数据标签**：柱/折线**全部 `<c:delete val="1">` 关闭**；仅饼环开启
- **轴**：mAP 类固定 0–1；`chart6` 用 **0.5–0.85 截断轴**放大里程碑差异
- `gapWidth=150`；环形 `holeSize` 62 / 48；折线 `smooth=0`
- 图表内字体 `Arial`，等效 7.5–12pt；网格 `D6E0E9`；轴线隐去、刻度线 none
- 数值细节由**旁边 9.5–14pt 卡片**承担，而非图内标签 —— 这是密度决策（39 类目下标标签会挤到 8pt 以下）

### 1.5 参考稿自身的缺陷（不要复现）

- **页码错误**：11 页的稿子页脚写「共 10 页」，且第 7 页标成「第 8 页」—— 从第 7 页起整体偏移 1
- 封面底色 `y=-0.82` 是**故意出血**，朴素越界检查会误报
- 第 2 页两处文本框在 45% 阈值下重叠但观感正常 ⇒ OVERLAP 类告警需人工判断

---

## 2. 工具链盘点结论（31 个脚本）

### 2.1 通用可复用（11 个，零项目路径，只吃 argv）

`_qa_pptx.py`（包结构）· `_qa_text.py`（文本 dump）· `_qa_layout.py`（越界/溢出/重叠）·
`_qa_chartdata.py`（读内嵌 workbook）· `_qa_render.py`（无视觉渲染 QA）· `_fit_check.py`（CJK 溢出）·
`_dump_ref_layout.py`（几何 dump）· `_inspect_deck_style.py`（风格反推）· `_analyze_style.py`（风格统计）·
`_extract_deck_text.py`（文本抽取）· `render_pptx.ps1`（COM 渲染）

这 11 个构成完整的"无渲染器 pptx QA 工具箱"，**已全部纳入 skill**（其中 6 个修了缺陷）。

### 2.2 项目专属（19 个，不该带走）

- Node 生成器 ×2（`build_ppt_a.js` / `build_ppt_b.js`）—— 均用 **pptxgenjs**，经 `C:/Temp/pptgen/node_modules/pptxgenjs` 绝对路径 require
- Python 生成器 ×13（`generate_*` ×6、`export_*` ×4、`build_weekly_*` ×3 等）
- 项目专属校验 ×4（`_check_ab_stale.py`、`_verify_decks_clean.py`、`_audit_claims.py`、`_qa_numbers_ppt_a.py`）
- 一次性 ×2（`inspect_slides.py`、`_apply_deck_corrections.py`）

### 2.3 审计发现的其他缺陷（未纳入 skill，仅记录）

| 缺陷 | 证据 |
|---|---|
| `_qa_numbers_ppt_a.py` 的 `FORBIDDEN` 反造假守卫**是空转** —— 唯一使用处只 `print` 一行 note，从不检查也不改退出码 | `:146-152` |
| `build_ppt_b.js` 定义了 `SHEET` PNG 却全文件无 `addImage`/`addPicture` ⇒ 腰折示意页可能没图 | `:11` vs 全文 |
| **7 处 `save()`/`writeFile` 无同名保护**，直接覆盖桌面文件 | `generate_flawless:988/991`、`generate_workspace:737`、`generate_visual:661/666`、`generate_infographic:1446/1448/1452`、`export_weekly_20260922:286`、`build_ppt_a.js:658`、`build_ppt_b.js:588` |
| 对照：另 6 个脚本**已加保护**（`safe_out` / `.bak-<stamp>`） ⇒ 同目录策略不一致 | `build_weekly_chartdecks:82-93`、`build_final:74-93`、`build_weekly_v2:528`、`export_deck_v2:729`、`export_weekly_20260921:753`、`export_training_analysis:655` |
| `build_v8m_v11m_board:432` 调用 `safe_out(OUT)` **但丢弃返回值**，`:433` 仍 `prs.save(OUT)` ⇒ 备份确实发生但属易碎写法 | 实测代码 |
| `export_weekly_20260922.py:20` 的 `PROTECTED` 定义但**全文未参与拒写判断** | 全文 291 行 |
| `refstyle` 注释写 27pt，代码实为 `Pt(22)`；`export` 用 `Calibri` 却自称克隆微软雅黑稿；`infographic` 引入 `黑体` 作 heading | 注释 vs 代码 |
| `_apply_deck_corrections.py` 是**唯一会写文件**的审计脚本，且写入目标是清单外的 `scripts/ops/export_integrated_master_deck.py` | `:37-38` |

---

## 3. 设计维度分析：不变量 vs 变量

### 3.1 不变量（跨场景不该变）—— 全部由实测驱动

画布 13.333×7.5 · 边距 0.55 · 内容宽 12.20 · 页脚 y≈7.08 @8.5pt · 低饱和 6+4 色板（含 pass/fail 语义绑定）·
单一字族 · 弱化网格（轴线隐去 + 0.5pt 网格）· 原生可编辑图表 · 数据可溯源 · 绝不覆盖产出 ·
禁饰条 / 饱和色 / 高密度

依据原文：`build_v8m_v11m_board_20260922.py:42`「ALL of these are measured off the reference deck, not invented.」；
`build_weekly_chartdecks_20260922.py:17`「This script replicates the reference's MEASURED grid instead of guessing」

### 3.2 变量（必须随场景变）

| 变量 | 驱动因素 | 原文依据 |
|---|---|---|
| 字号 | 路演稿 vs 技术报告 | `v2:66`「type scale raised to the skill's spec」→36/14/44 **vs** `v8v11:18`「restores the reference's measured scale」→27/10/30 |
| chars/slide | 阅读 vs 演示 | `final:24`「target <= 300 chars/slide」；`chartdecks:10`「338 \| 550 \| 456 ← 62% too dense」 |
| 页数 | 议题数 + 用户反馈 | `v2:27`「"页面有点多了" 18 -> 9 pages」 |
| 版式节奏 | 避免呆板 | `final:8`「"去AI化，不要太呆板" -> varied layouts」 |
| 图表类型 | **数据形状** | `v2:16-25` 完整决策表 |
| 图表数量 | 议题数 | `final:24`「>= 10 native editable charts」（参考稿仅 6） |
| 文字量 | 图表优先 | `final:7`「"尽量多用图表描述，文字只做简单说明和结论"」 |

### 3.3 **原文未覆盖**的维度（skill 必须自己补）

- 口头演讲 vs 阅读型文档
- 3 页执行摘要 vs 40 页数据附录
- 受众身份分层（管理层 / 工程师 / 客户）
- 媒介差异（打印 / 投影 / 屏幕）
- 「什么算路演稿」的判定标准 —— 原文只出现「written for pitch decks」一词，**无任何判定规则**

⇒ 这 5 个缺口正是 skill 的 `scenario-pacing.md` 要补的：把「路演 vs 报告」从口号变成**可操作的档位表**。

---

## 4. 冲突清单（12 处，其中 9 处真冲突）

完整逐条对照见 skill 内 `references/conflicts.md`。摘要：

| # | 主题 | 性质 |
|---|---|---|
| 1 | 标题/正文字号 | **真冲突，且项目内部相反** |
| 2 | 饰条 / 卡片边条 | 与 skill 一致，但项目内未统一（`execdeck`/`final` 仍保留 `accent_bar()`） |
| 3 | 调色板（每份重选 vs 锁死一致） | 真冲突 |
| 4 | 信息密度单位（chars / 无 / 组件数） | 方向一致，**三方不可换算** |
| 5 | 每页必须有视觉元素 | 真冲突 |
| 6 | 大数字 60-72pt vs 24-30pt | 真冲突 |
| 7 | 字体安全清单（西文 6 款）vs 微软雅黑 | 真冲突，且 10% slack 无人实现 |
| 8 | 「原生图表」定义 | **两个 skill 之间互斥** |
| 9 | 谁拥有几何（禁止坐标 vs 全手排） | 真冲突（路线级） |
| 10 | 主题真源（绑定一次 vs 每次重测） | 真冲突，且实测内部已漂移 |
| 11 | 页数来源（容量推导 vs 硬编码） | 真冲突 |
| 12 | 密度量化单位 | 三方不可换算 |

---

## 5. 本次交付的 skill

`~/.dsh/skills/deck-design/`（**免重启热加载已生效**）

```
SKILL.md                            决策流程 + 不变量 + 冲突速查
references/scenario-pacing.md       四档 pacing + 物理容量算式 + 推导步骤 + 5 个实例
references/design-invariants.md     9 条不变量 + 参考稿作校准点 + 已知缺陷
references/chart-selection.md       数据形状→图表 + 实测图表规范 + 反模式
references/conflicts.md             12 处冲突逐条裁决
scripts/                            12 个工具（含 self_test.py 故障注入）
```

**核心设计取舍：不给"正确数值"，给"推导数值的方法"。** 参考稿的 27pt/338 字只作为 `report` 档的一个校准点被引用，且明确标注"别照抄"。

---

## 6. 验证证据

### 6.1 故障注入（6/6）

```
PASS baseline qa_layout: no BOUNDS/FIT on good deck
PASS baseline fit_check on good deck (expect 0)
PASS F1 empty chart cache -> qa_render flags it
PASS F2 out-of-canvas shape -> qa_layout BOUNDS
PASS F3 overflowing text -> fit_check OVERFLOW
PASS F4 missing PNG -> qa_render MISMATCH
6/6 gates fired as expected
```

### 6.2 缺陷修复的对照实测

| 项 | 修复前 | 修复后 |
|---|---|---|
| 图表数值提取 | `[None, None, None, None, None, None]`（恒空，检查静默失效） | `chart4 mAP50 cats=39 vals=39`，真实数值 |
| 强调色 | 硬编码某项目配色；我第一版改为"扫全 deck"后匹配到 **23 种颜色**（等于失效） | 只取图表系列色 → `2E6F8E / A3B8C7 / E8A23B`（3 种，正是真实系列色） |
| 出血误报 | 参考稿报 5 条，含 1 条误报（`BOUNDS (0.23,-0.82)`） | 报 4 条，**全为需人工判断的 OVERLAP**，硬告警 0 |
| 页序 | 字符串排序 ⇒ `幻灯片1,10,11,2,...`，节奏序列错乱 | 自然排序 ⇒ 背景序列 `DLLLLLLLDLD`（正确） |
| PASS 判定 | 只依赖 1/4 项 | 每项都进退出码 |
| 渲染器清理 | 无条件删 `-OutDir` 下所有 `*.png` | 拒绝含 `.pptx` 的目录；清理需 `-Clean` 显式开启 |

### 6.3 未做视觉断言

本次**没有**声称"我看过幻灯片"。`read_image` 只返回图像元数据（与当时那个会话遇到的情况一致），
因此一律以 `qa_render.py` 的机械检查作为证据。这也是 `qa_render.py` 存在的理由。

---

## 7. 未做 / 待决策

| 项 | 说明 |
|---|---|
| 未装任何新插件 | 现有三套（pptx / pptwise / deck-design）已覆盖"文件操作 / 生成引擎 / 设计决策与验收"，再装只会加剧指令冲突 |
| 未装 LibreOffice | **PowerPoint COM 已可用**（实测 11/11 页导出），无需 soffice |
| 未改动用户项目脚本 | 7 处无覆盖保护的 `save()` 只在报告里记录，等用户决定是否统一 |
| pptwise 的 `chart` 非原生 | 「图表原生 + 引擎管版式」目前不可兼得，需上游支持 |
| 参考稿副本 | `_tmp/ref-deck-20260922/`（含 1.7MB 副本 + 22 张 PNG），临时件，可删 |
