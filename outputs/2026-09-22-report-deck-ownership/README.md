# PPT 工具链「产出归属」治理 — 报告

> 日期：2026-09-22 ｜ 对象：`C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发\scripts\ops\ppt\`
> 承接：`2026-09-22-report-deck-risk-assessment`（R0 已由提交 `ae3814e` 处置）
> 本次处置：**R1（多脚本争抢同一产出文件）** —— 建立单一事实源 + 可重跑的只读校验器

---

## §0 一句话

我没有去"删掉 5 个旧脚本"（那是**推断**，不是事实），而是先把"**谁拥有哪个产出文件**"
变成**可登记、可校验、可重跑**的事实，并让校验器在归属未定时**故意报红**。
执行过程中还发现：**这个目录此刻正被另一个会话并发写入**，所以按规范我**让路**，
没有去改任何既有脚本。

---

## §1 为什么推荐这一步

三个候选里，只有它同时满足"长期不出问题 + 可维护 + 可迭代 + 可扩展"：

| 候选 | 收益 | 风险 | 判断 |
|---|---|---|---|
| **产出归属注册表 + 校验器**（本次） | 消除"哪个是权威版"的歧义；把一次性审计变成**常驻可重跑**的检查；新增生成器有扩展契约 | **纯新增文件，零行为改变** | ✅ **做** |
| 给 15 处写入点加覆盖保护 | 防覆盖 | **改变运行时行为**，可能打断用户既有流程；影响面最大 | 排后 |
| 加 `.gitattributes` | 消除 CRLF 翻转 | 仓库级策略变更；**实测 diff 仍干净**，危害低 | 排后（等你拍板） |

关键理由：**"哪个脚本是权威版"是人做的判断，不是可以推导的事实。**
所以它必须被**登记**，而不是被写死在代码里。登记 + 校验 = 可维护；
"未登记就报红" = 可扩展；校验器本身可重跑 = 可迭代。

---

## §2 调查发现

### §2.1 事实：同一产出被多个脚本写入（实测）

`python _check_ownership.py` 扫出 **35 个脚本 → 16 个写入者 → 15 个不同产出路径 → 5 组冲突**：

| 产出路径 | 写入它的脚本数 |
|---|---|
| `…\Desktop\周报\周报_YOLO板端对比与39类缺陷治理综合报告.pptx` | 2 |
| `…\Desktop\周报_YOLO板端对比与39类缺陷治理综合报告.pptx` | 4 |
| `…\Desktop\基于深度学习的缺陷检测边缘设备开发\周报_YOLO板端对比与39类缺陷治理综合报告.pptx` | **5** |
| `…\Desktop\周报_任务A_YOLO版本板端性能实测对比.pptx` | 2 |
| `…\Desktop\周报_任务B_39类缺陷识别准确度归因与提升.pptx` | 2 |

全部**无覆盖保护**（见 §2.3）。

### §2.2 ★ 并发发现：执行期间有另一个会话在写同一个目录

时间线（均为实测 mtime / 进程表）：

| 时刻 | 事件 |
|---|---|
| ~20:45 | 我首次列目录：35 个文件，最新是 `generate_infographic_weekly_report.py`（18:46:17） |
| 20:47:07 | `pythonw` 启动 3 个进程 —— **不是 PPT**，是 `scripts/ops/bench/train_clean_arms_20260922.py --worker --stage base --block 9` 等**训练任务**（CPU 78.4s，仍在跑） |
| **20:47:39** | **新文件出现**：`generate_graphical_weekly_report.py`（51.4 KB）—— 我列目录时**还不存在** |
| **20:48:14** | 三份周报成品**同时**被重写（1422747 B，SHA 前缀 `E7334E80B842181C`），与 `generate_graphical_weekly_report.py` 的 3 个保存点吻合 |

⇒ **另一个会话正在迭代周报生成器**，且它就是当前成品的产出者。
我先前"权威版 = `generate_infographic_weekly_report.py`"的判定**在执行期间就已经过期**。

**据此我按规范让路**（AGENTS.md 多对话铁律 §5「基线防覆盖」）：
我 acquire 时 `baseChange: null`，而目标目录**在读取之后被他人改过** ⇒ 属于 **STALE_BASE**。
所以我**没有**去改那 6 个既有脚本（原计划的 `STATUS:` 注释头），**只新增文件**。

> 这也反过来证明本步骤的价值：**"哪个是权威版"不是一个能一次算完的事实，
> 它在几分钟内就会变**。只有登记 + 校验能跟上。

**报告收尾时（21:01）它还在变**：`generate_graphical_weekly_report.py` 于 **20:59:04**
被再次编辑（52653 → 52794 字节），成品于 **20:59:52** 被第三次重写
（1422820 B，新 SHA 前缀 `9AABB3947DA4131A`）。

⇒ 因此本报告与 `deck_ownership.json` 里的一切 mtime / 字节数 / 哈希
**都是"某一时刻的快照"，不是当前值**。已在 `deck_ownership.json` 顶部加
`snapshot_warning` 明确标注。**要看当前状态就重跑校验器** —— 它读的是实时目录。

### §2.3 ★ 自我纠错：我上一轮的审计标签是**假阳性**

我早先的审计脚本把 `generate_infographic/flawless/visual` 三个脚本标为"有 `exists()` 检查"。
**逐行复核后是错的**：

| 脚本 | `os.path.exists()` 实际检查的是 | 保存点 |
|---|---|---|
| `generate_infographic_weekly_report.py` | `:1340` **输入截图** `shot_path` | `:1446/1448/1452` 无保护 |
| `generate_flawless_weekly_report.py` | `:928` **输入图片** `gui_img` | `:988/991` 无保护 |
| `generate_visual_workspace_weekly_report.py` | `:409/443/465/515/542/574/602` **全是输入图片** | `:661/666` 无保护 |

⇒ **4 个写周报的脚本，保存点全部无保护**；`generate_workspace_weekly_report.py` 连
`exists()` 都没有。这与上次那个"25 行回看窗口假阳性"是**同一类错误**（把别处的检查当成守卫）。
**本次记录在案，避免第三次。**

### §2.4 顺带发现：2 处产出是**相对路径**

| 脚本 | 相对产出 | 后果 |
|---|---|---|
| `export_weekly_20260921.py:23` | `reports_v1\phase2\周报_板端对比与39类治理与FPGA进度_20260921.pptx` | 在哪个目录下运行就落到哪里 |
| `export_deck_v2_20260921.py:19` | `reports_v1\phase2\钢材表面缺陷检测系统汇报_v2_…_20260921.pptx` | 同上 |

不是错误，但是**脆弱点**，已由校验器以 `[!]` 报出。

### §2.5 已排除的：孤儿脚本

`generate_weekly_task_decks.py`（15:37）、`generate_executive_weekly_decks.py`（15:53）
写的 `周报_任务A/B_…pptx`，在**整个 Desktop 树里不存在**（实测搜索 0 命中），
项目内也**没有任何文档引用**这 6 个脚本中的任何一个 ⇒ 纯一次性生成器，标记安全。
状态登记为 `retired`（**已决定**，不是"未决"）。

---

## §3 交付物（3 个新文件，均在 `scripts/ops/ppt/`）

| 文件 | 作用 |
|---|---|
| `deck_ownership.json` | **单一事实源**：产出路径 → 归属脚本 / 状态 / 证据。当前 3 条 `pending`、2 条 `retired` |
| `_check_ownership.py` | **只读**校验器。不写文件、不跑生成器、不打开 pptx |
| `_self_test_ownership.py` | 故障注入回归测试（在**临时沙箱**里跑，不碰真目录） |
| `TOOLCHAIN.md` | 人类可读指南：危险点、现状表、校验器用法、**新增生成器的扩展契约** |

校验器检测项：`[C]` 未登记冲突 ／ `[U]` 归属未决（**故意红**）／ `[S]` 陈旧登记
／ `[M]` 登记不符 ／ `[?]` 解析盲区（**如实列出，绝不静默丢弃**）／ `[!]` 相对路径产出。

**当前实测输出**：

```
[scan] 35 scripts -> 16 writer scripts, 15 distinct output paths, 5 collision group(s)
[U] ownership undecided (gate is red on purpose)      <- 3 条
[!] relative output path(s) (2)
RESULT: FAIL  (ownership pending for 3 path(s)) -- expected until a human decides the owner
        0 unresolved save target(s), 5 collision group(s)
```

**红是有意的**：在你拍板归属之前，它就该红。

---

## §4 验证（故障注入，`_self_test_ownership.py`）

AGENTS.md 要求：「它通过了」≠「它有效」。所以除了正向，还做了**反向 + 正向对照**。

| 测试 | 做法 | 期望 | 结果 |
|---|---|---|---|
| T1 基线 | 沙箱原样 | FAIL，且**只有** `[U]` | ✅ `kinds={'U': 3}` |
| T1b 盲区 | 同上 | `[?]` 解析盲区 = **0** | ✅ `unresolved=[]` |
| **T2 注入冲突** | 给一个**单写入者**路径注入第二个写入脚本 | 报**新的** `[C]` | ✅ `kinds={'U':3,'C':1}`，且**点名** `钢材表面缺陷检测_周报_20260922.pptx` |
| **T3 错归属** | 登记 `owner` 改成不存在的脚本 | 报 `[M]` | ✅ `kinds={'U':2,'M':1}` |
| **T4 陈旧登记** | 登记一个没人写的路径 | 报 `[S]` | ✅ `kinds={'U':3,'S':1}` |
| **T5 正向对照** | 把归属**全部判定** | **必须变绿** | ✅ `ok=True exit=0 findings=[]` |

```
FAULT-INJECTION SUMMARY: 8/8 PASS
```

**T5 是关键**：它证明"红"意味着**真有东西没决定**，而不是一个永远红的假检查。

> 开发过程中 T1b 曾失败（3 处解析盲区）。我没有放宽断言，而是**补全解析形状**
> （跨行 `os.path.join`、三元透传 `safe_out(A if c else B)`、全字面量相对 join），
> 把盲区从 **3 → 0**。另外我第一版把 `retired` 误判成"未决"，也已修正。

---

## §5 风险 / 收益

**收益**

1. 消除 R1 的核心危害：**"哪个是权威版"不再靠记忆和 mtime 推断**。
2. 把一次性审计升级为**常驻、可重跑**的检查 —— 同类事故复发会立刻可见。
3. 新增生成器有**明确契约**（登记 + 校验必须绿），可扩展。
4. 附带查实：4 个周报脚本**保存点全部无保护**（修正了我自己上一轮的假阳性标签）、
   2 处相对路径产出。

**风险**

| 项 | 评估 |
|---|---|
| 是否改变运行行为 | **否**。3 个新增文件；未改任何既有脚本一行 |
| 是否影响产出 | **否**。不触碰任何 `.pptx`，不跑生成器 |
| 是否波及运行中服务 | **否**。纯静态文件；与训练任务、Web GUI 无关 |
| 可逆性 | **完全可逆**。删除 3 个新文件即恢复原状（它们无外部引用） |
| 解析器误报风险 | 存在，但**只影响报告不影响产出**；且盲区**如实列出**而非隐藏 |
| 长期维护成本 | 低。校验器只依赖 Python 标准库；登记表只在归属变更时改 |

**等级：低风险 / 中高收益。**

---

## §6 回滚

```powershell
Remove-Item "C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发\scripts\ops\ppt\deck_ownership.json"
Remove-Item "...\scripts\ops\ppt\_check_ownership.py"
Remove-Item "...\scripts\ops\ppt\_self_test_ownership.py"
Remove-Item "...\scripts\ops\ppt\TOOLCHAIN.md"
```

无外部引用（已实测：全项目无文档引用这 4 个文件名），删除不影响任何东西。

---

## §7 待你拍板 / 本次**未做**

1. **★ 归属判定（唯一需要你决定的）**
   把 `deck_ownership.json` 里 3 条 `pending` 改成 `authoritative` + 填 `owner`。
   我的**建议**（已写进 `recommended_owner`，但**明确标注为建议不是事实**）：
   `generate_graphical_weekly_report.py` —— 最新（20:47:39）且是当前成品的产出者。
   **但它的成稿质量我没有独立核验过**，且它的作者会话可能还在迭代，建议**等它停下来再定**。
2. **未做**：给 6 个脚本加 `STATUS:` 注释头。原因：并发写入中 + 基线已陈旧（见 §2.2），
   且登记表 + 校验器已覆盖该需求（机器校验优于散文注释）。
3. **未做**：15 处保存点覆盖保护。改变行为，影响面最大，排后。
4. **未做**：`.gitattributes`。仓库级策略变更；实测 `git diff` 仍干净，危害低，等你拍板。

**无待重启项** —— 本次全是静态文件，不需要重启任何东西。

---

## §8 执行记录（可复核）

| 动作 | 命令 / 证据 |
|---|---|
| 锁定资源 | `task-scheduler acquire --resources "...\scripts\ops\ppt,D:\...\outputs\INDEX.md,D:\...\memory\2026-09-22.md"` → `tk-muco6oyu-4302891f` |
| 并发取证 | `Get-CimInstance Win32_Process`（3 个 pythonw = 训练脚本）；目录 mtime 20:47:39 / 产出 20:48:14 |
| 孤儿取证 | 全 Desktop 树搜 `任务A\|任务B\|方案A\|方案B` → **0 命中**；项目文档搜 6 个脚本名 → **0 命中** |
| 假阳性取证 | 逐行读 `:1340` / `:928` / `:409,443,465,515,542,574,602` → 全是**输入图片** |
| 语法/JSON | `python -m py_compile` 通过；`json.load` → `outputs=5` |
| 校验器（真目录） | `python _check_ownership.py` → `FAIL (ownership pending for 3 path(s))`，`0 unresolved` |
| 故障注入 | `python _self_test_ownership.py` → **8/8 PASS**（含 T5 正向对照绿） |
| 产物核验 | 3 份成品逐字节相同：`1422747 B` / SHA 前缀 `E7334E80B842181C` / mtime `20:48:14`（**随后 20:59:52 被并发会话再次重写为 `1422820 B` / `9AABB3947DA4131A`，故所有数值仅为快照**） |
| 网络检索 | `web_search` 两次 —— **只返回噪声**（无关日文/词典站），**无可采纳的上游惯例**；本方案基于本仓库既有惯例（`_qa_*.py` 只读工具模式）与 AGENTS.md 事故教训，未生搬外部做法 |
| **★ 机制发现** | `task-scheduler acquire` **从短命 shell 里拿的锁会在 shell 退出后立刻失效**：实测 acquire 于 `ts=1790081297397`，**~95 秒后**被 `auto-reclaimed`，`reason = status-lazy-reclaim (pid dead + heartbeat expired)`。⇒ **agent 的"拿锁→干活→释放"跨多次 shell 调用时，锁实际上形同虚设**，`release --summary` 也会因"已无锁可释放"而**丢失登记**（首次 release 返回 `released: []`）。**规避**：把 acquire 与 release 放在**同一个进程**里执行（本次用 `node -e` 包住两步），登记才落到时间线（已实测写入，`ts=1790082277800`） |
| 项目门禁 | `scripts/check-all.ps1` → **`CHECK-ALL: ALL PASS`** |

**新增文件清单**（均在 `scripts/ops/ppt/`）：

```
deck_ownership.json         单一事实源（归属登记）
_check_ownership.py         只读校验器
_self_test_ownership.py     故障注入回归测试（8/8）
TOOLCHAIN.md                人类可读指南 + 扩展契约
```

**构建源**（工作区暂存，可再分发）：`_tmp/ppt-ownership-20260922/`
