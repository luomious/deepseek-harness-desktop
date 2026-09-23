# deck-design skill：把"参考稿精髓"变成可复用能力（2026-09-22）

> 用户问题：① 确定不用再装别的 skill/插件吗？② `模型训练分析报告.pptx` 看着不错，当时是怎么生成的、能不能学会？
> 结论：**不用再装插件**；那份稿子**确实是 DSH 生成的**，而且当时的会话**已经把方法逆向成文档化契约**了 —— 但散落在 31 个脚本里、且内部互相矛盾。
> 本次把它提炼成一个**场景驱动**的全局 skill（`~/.dsh/skills/deck-design/`），并修掉工具链里 **6 处静默失效的缺陷**。

## 一、那份 PPTX 到底怎么来的

| 项 | 实测 |
|---|---|
| 作者 | **`DSH Agent`**（core props），创建 2026-09-08，最后由 `holmes sherlock` 于 2026-09-17 保存，rev 8 |
| 生成方式 | **不是插件**，是另一个会话**手写 python-pptx 脚本** |
| 规模 | 11 页 / 13.33×7.5in / 单 DEFAULT 版式 / 全部 autoshape 手绘 |
| 字体 | **仅 微软雅黑**（131 run）；主题字体仍是默认 Calibri（逐 run 指定） |
| 字阶 | 38 / 31 / 30 / 27 / 24 / 14 / 13 / 12 / 11.5 / 10.5 / 10 / 9.5 / 8.5 pt |
| 色板 | 主阶 `22303E→5F7080→93A5B3`；**恰好两个强调色** 琥珀 `E8A23B` + 青 `2E6F8E`；状态色 `3E8E62`/`C0504D`（低饱和） |
| 图表 | **6 个原生图表**（2 环形 + 3 簇状柱 + 1 折线带标记） |
| 密度 | 3716 字 / **平均 338 字/页** |
| 节奏 | 重-重-中×5-重-轻-轻-重；6 张图集中在连续 5 页；末段两页整页大图作呼吸页 |

**当时的生成逻辑（已被前一个会话写成注释）**：
`量测参考稿 → 写死设计契约 → python-pptx 复刻 → PowerPoint COM 渲染 PNG → 人眼回看 → QA 门禁`

## 二、真正"学到"的是什么 —— 不是那套数值，是决策逻辑

`build_weekly_v2_20260922.py` 里存着用户**逐字原话的四条否决意见**，第一条就是本次用户说的同一句话：

> **「分析参考模板的精髓，不要生搬硬套」**

它记录了 KEEP（低饱和色板 / 深-浅-深三明治 / 大数字+小注释卡片母题）与 DROP（27pt 标题 / 10pt 正文）。

### 而这里有一个**未解决的矛盾**（本次调查最重要的发现）

| 脚本 | 主张 |
|---|---|
| `build_weekly_v2_20260922.py:12-14` | 「DROP 掉参考稿 27pt/10pt 的小字阶。**pptx skill 要求标题 36-44pt、正文 14-16pt**；照抄参考稿的小字阶正是让旧稿读起来像密集文档的原因。」 |
| `build_v8m_v11m_board_20260922.py:13-19` | 「被否掉的稿子用了 TITLE 36 / BODY 13-14 / STAT 44，即参考稿字阶的 1.3-1.5 倍。**就是这一处改动让它读起来像通用 AI 稿**：同样画布上字号放大 1.4 倍 ≈ 每页信息量减半，于是每页都显得空而填充。**pptx skill 的"36-44pt/14-16pt"规则是给路演稿写的**，它被叠加到用户自己的参考体系之上，静默地覆盖了它。」 |

**两份脚本都自称"实测"，结论相反。** 项目最终出现了三档互不可比的字阶（36 / 27 / 20-22pt）。

**这不是"哪个数值对"的问题，而是"数值必须由场景推导"的问题。** 这就是"精髓 vs 生搬硬套"的分界线。

### 还查出 9 处 skill 与实测的真冲突（详见 skill 内 `references/conflicts.md`）

| # | `pptx` skill 说 | 实测/事实 |
|---|---|---|
| 1 | 标题 36-44pt、正文 14-16pt | 那是**路演**尺度；屏幕阅读的技术报告用 24-28 / 9.5-12 |
| 2 | 大数字 60-72pt | 实测最优 24-30pt；60pt 会吃掉半页 |
| 3 | 每份 deck 重选一套鲜明配色（给了 10 套高饱和预设） | 会重新引入被判为"AI 味"的饱和彩虹色；正解是**同一系列保持一致** |
| 4 | 每页必须有视觉元素 | 视觉元素 ≠ 图表；KPI 行/时间线/文字层级都算 |
| 5 | 字体安全清单（6 款西文） | 中文 `微软雅黑` 不在内；且 skill 要求的 ~10% slack **源码里一处都没实现** |
| 6 | 图表要保持原生 | `pptwise` 明令禁止把它的 `chart` 组件称为原生（导出为分组形状）—— **两个 skill 定义互斥** |
| 7 | — | `pptwise` 禁止作者写坐标；但复刻量测版式**必须**手写坐标（路线级二选一） |

## 三、建了什么：`deck-design` skill

位置：`~/.dsh/skills/deck-design/`（**免重启已生效**，已出现在运行时 skill 目录）

**设计原则：决策框架优先，参考稿只作一个校准点。**

```
1. 场景画像（交付方式/受众/目的/页数预算/数据量/有无参考稿）—— 未说明就问，不静默假设
2. 由「内容量 ÷ 页数预算」推出 pacing 档位（spoken / briefing / report / reference）
3. 锁定不变量（跨场景不变）：单主色支配 60-70% + 恰好 2 个强调色 / 语义色绑定 /
   单一字族 / **标题:正文 ≥ 2.5×**（这才是真规则，不是"标题 36pt"）/ 固定页脚 /
   原生图表 / 禁饰条 / 数据可溯源 / 绝不覆盖
4. 图表按**数据形状**选（不是凑数量）
5. 有参考稿 → 量测校准（复制不变量、重推数值）
6. 构建 → PowerPoint COM 渲染 → 机械 QA → 人看
```

文件：

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 决策流程 + 不变量 + 冲突速查 |
| `references/scenario-pacing.md` | 四档 pacing 表 + **物理容量算式**（`≈292,500/pt²` 字符）+ 推导步骤 + 反例 |
| `references/design-invariants.md` | 9 条不变量 + 参考稿作为一个**校准点**（明确标注"别照抄"）+ 已知缺陷 |
| `references/chart-selection.md` | 数据形状→图表决策表 + 实测图表规范（无图表标题 / 单系列无图例 / 柱线关数据标签 / 轴范围） |
| `references/conflicts.md` | 12 处冲突逐条列出（原文对照），并给出裁决 |
| `scripts/` | 12 个工具（见下） |

## 四、修掉的 6 处工具缺陷（都是"看起来通过了"的静默失效）

| 缺陷 | 证据 |
|---|---|
| `_qa_render.py` 图表数值提取读 `<c:pt>.text`（恒为 `None`）⇒ **该项检查一直静默失效** | 实测：旧写法 `[None×6]`，正确写法取子节点 `<c:v>` 得 **79 个真实值** |
| 同一脚本 **PASS 判定只依赖 1/4 项**，另 3 项只打印不判定 | 子代理审计确认 `:109-111` |
| 强调色**硬编码**成某项目配色，且我第一版改为"扫全 deck 填充"后**匹配到 23 种颜色**（等于失效） | 实测输出；最终改为**只取图表系列色** |
| `_qa_layout.py` 把**故意出血**（背景 `y=-0.82`）报成越界错误 | 参考稿实测 5 条告警中 1 条是误报 |
| `_analyze_style.py` 的 `card fills` 判定字符串不匹配（`MSO_FILL_TYPE.SOLID (1)` vs `SOLID (1)`）⇒ 恒为空 | 子代理定位 |
| `_fit_check.py` 退出码恒 0；`render_pptx.ps1` 无条件删 `-OutDir` 下所有 PNG；PNG 按字符串排序（`幻灯片10` 排在 `幻灯片2` 前，**节奏序列错乱**） | 审计 + 实测 |

另有 `_qa_numbers_ppt_a.py` 的反造假守卫是**空转**（`FORBIDDEN` 只 print 不判定）—— 属项目专属脚本，未纳入。

## 五、验证证据

**故障注入 6/6 通过**（`scripts/self_test.py`：故意弄坏一份已知good的 deck，确认每道门禁都会响）：

```
PASS baseline qa_layout: no BOUNDS/FIT on good deck
PASS baseline fit_check on good deck (expect 0)
PASS F1 empty chart cache -> qa_render flags it
PASS F2 out-of-canvas shape -> qa_layout BOUNDS
PASS F3 overflowing text -> fit_check OVERFLOW
PASS F4 missing PNG -> qa_render MISMATCH
6/6 gates fired as expected
```

**在真实参考稿上的实测**：

| 工具 | 结果 |
|---|---|
| `qa_render.py` | PASS / exit 0；图表值 `chart4 mAP50 cats=39 vals=39`；背景序列 `DLLLLLLLDLD`；1 条 WARN（第 10 页整页图片页 ink 低，属预期） |
| `fit_check.py` | 0 overflow / exit 0 |
| `qa_layout.py` | 4 条 OVERLAP（**需人工判断**，非缺陷）；出血误报已消除 |
| `render_deck.ps1` | 11/11 页导出 PNG（**PowerPoint COM，无需 LibreOffice**） |
| `qa_pptx.py` / `qa_text.py` / `qa_chartdata.py` | 均正常 |

## 六、怎么用

重启后（实际上**免重启已生效**）直接自然语言触发即可：

- 「做一份周报 PPT，给管理层看，不要像 AI 做的」
- 「参考这份稿子的风格做一份，但内容不一样」
- 「这份 PPT 太密了 / 太空了 / 图表跟数据不匹配」

或手动跑门禁：

```bash
python ~/.dsh/skills/deck-design/scripts/qa_render.py <png_dir> <deck.pptx>
python ~/.dsh/skills/deck-design/scripts/fit_check.py <deck.pptx>
```

## 七、维护与迭代

- **构建源**：`D:\Deepseek-Harness\_build\deck-design\`（工作区内的可审阅副本；改完再同步到 `~/.dsh/skills/deck-design/`）。
- **改动任何门禁后**必须重跑 `self_test.py` —— 一道从不报警的门禁就是橡皮图章。
- **加入新的校准点**时：在 `references/design-invariants.md` 追加一节，明确标注它对应的**场景**，不要直接改 pacing 表。
- **已知待办**：`pptwise` 路线的 `chart` 组件不产生原生图表，若要"图表原生 + 引擎管版式"兼得，需要 pptwise 侧支持；目前只能二选一。

## 八、状态

- skill 已安装并**免重启生效**（运行时 skill 目录已出现 `deck-design`）。
- 未改动用户项目内任何脚本；未安装任何新插件；未新增 Python 依赖（`python-pptx` / `Pillow` 本机已有）。
- 参考稿副本与渲染件在 `_tmp/ref-deck-20260922/`（临时，可删）。
