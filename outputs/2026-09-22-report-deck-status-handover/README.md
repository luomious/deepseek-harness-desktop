# PPT 工具链加固 — 收尾状态与交接记录

> 日期：2026-09-22 22:1x ｜ 对象：`C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发\scripts\ops\ppt\`
> 目的：**归档前的单一状态页**。这一页能回答"现在到底什么状态、什么还没做、能不能归档"。
> 承接：`2026-09-22-report-ppt-toolchain` → `…-deck-design-skill` → `…-deck-cleanup-and-hardening` → `…-deck-risk-assessment` → `…-deck-ownership` → `…-deck-write-guard`

---

## §0 一句话

**我这边的四步加固全部完成、全部验证通过、全部门禁绿。**
唯一没做的是**需要你拍板的两件事**，以及**当前产出者脚本 `generate_graphical_weekly_report.py` 还没接写入保护** ——
它**归另一个会话所有**，我按规范没动它。
**不需要重启任何东西。**

---

## §1 已完成并验证（本轮全量复核，22:1x）

| # | 加固 | 状态 | 复核证据 |
|---|---|---|---|
| 1 | `scripts/ops/ppt/` 纳入 git | ✅ | 提交 `ae3814e`（35 文件）；本次改动在其之上，`git diff --stat` 可查 |
| 2 | 产出归属登记 + 只读校验器 | ✅ | `_check_ownership.py`：40 脚本 → 18 写入者 → 17 产出路径 → 5 组冲突；**0 解析盲区** |
| 3 | 写入保护（保存前自动备份） | ✅ | `_deck_guard.py` + 4 个周报脚本 8 个保存点；**13 增 0 删** |
| 4 | 三个自测套件 | ✅ | **14/14** + **17/17**（A/B 25/25） + **11/11** = **42 条断言全绿** |
| 5 | 项目门禁 | ✅ | `scripts/check-all.ps1` → **`CHECK-ALL: ALL PASS`** |
| 6 | 时间线登记 | ✅ | 0 个活跃锁；`ppt-write-guard:写入保护加固` 的 summary 已在时间线 |

**7 个新增文件**（均在 `scripts/ops/ppt/`，全部完好）：

```
_deck_guard.py               3287 B   写入保护
_self_test_deck_guard.py     5146 B   守卫单元测试 14/14
_self_test_wired_guard.py    9008 B   端到端 + A/B 回归测试 17/17 (A/B 25/25)
_check_ownership.py         18743 B   产出归属只读校验器
_self_test_ownership.py      7436 B   归属故障注入 11/11 (T1–T6)
deck_ownership.json          7486 B   产出归属单一事实源
TOOLCHAIN.md                11163 B   人类可读指南 + 扩展契约
```

**4 个周报脚本的写入保护接线**（复核 refs 数 = 1 import + N 个保存点）：

| 脚本 | `backup_before_write` 引用 |
|---|---|
| `generate_workspace_weekly_report.py` | 2（1 import + 1 保存点） |
| `generate_visual_workspace_weekly_report.py` | 3（1 + 2） |
| `generate_flawless_weekly_report.py` | 3（1 + 2） |
| `generate_infographic_weekly_report.py` | 4（1 + 3） |

---

## §2 ★ 并发会话：查清了什么、没查清什么

**查清的（文件级证据，确凿）**：另一个写入者整晚在同一目录迭代，最后一次写是 **21:58:26**（脚本）/ **21:58:37**（成品）。
实测**观察 120 秒无任何写入**，即**当前空闲约 18 分钟**。

**没查清的（我做了 4 种尝试，都失败，如实记录）**：

| 尝试 | 结果 |
|---|---|
| 最近 45 分钟内被写过的会话 transcript | 只有 **2 个**：`--D-Deepseek-Harness--\session-5008baba`（**经核实是我自己** —— 它的最后一次工具调用就是我的 shell 命令）与 `--C-Users-…-开发--\session-c9cd3f33`（**928 B，仅头部配置，21:37 后未再增长**） |
| 用户项目工作区最近会话 | `session-8d2fcb37`（13.4 MB）—— 读其尾部：**`turn/end` @ 20:50:15**，即**它 20:50 就结束了**，不是 21:36/21:50/21:58 那三次编辑的作者 |
| `~/.dsh/tool-audit/audit.jsonl`（0.5 MB / 2732 行）搜该脚本名 | **0 命中** |
| `storages/session_projcache.json`（107 MB / 443 会话）搜该脚本名与 `scripts\ops\ppt` | **0 命中** |

**推断（标注为推断，不是实测）**：最可能是
**`session-c9cd3f33`（用户项目工作区，`danger-full-access` + 审批 `never`，约 21:37–21:44 创建）正处于一个长 turn 中，
transcript 到 turn 结束才落盘**，所以文件层面看不到它的活动。
但 **21:36:15 那次编辑早于该会话创建时间**，所以**不能排除存在第二个写入者**。

**⇒ 结论：我无法指认到具体会话 id。请你自己确认那个会话是否已经收尾。**

---

## §3 交付现状（22:18 实测）

| 位置 | 状态 |
|---|---|
| `…\Desktop\周报\周报_YOLO….pptx` | **1430617 B / 21:58:37 / `A49E88E0CC0E`** ← **最新，且只有这一份** |
| `…\Desktop\周报_YOLO….pptx`（桌面根目录） | **不存在** |
| `…\Desktop\基于深度学习…开发\周报_YOLO….pptx` | 1422820 B / **20:59:52** / `9AABB3947DA4` ← **旧版** |

**⇒ 交付是分裂的**：最新设计只在 `周报\` 子目录，工作区那份停留在 20:59。

**已有 4 份 `.bak-` 保住了两个会被销毁的版本**：

| 备份时间 | 内容 |
|---|---|
| `…212336` × 2 | **20:59:52 那版**（1422820 B） |
| `…214635` × 2 | **21:36:44 那版**（1422806 B）＋ 20:59:52 那版 |

> 这两个版本**现在只存在于这些 `.bak-` 里** —— 另一会话的后续迭代已经把它们覆盖掉了。
> 这是"没有备份就会永久丢失"的**现场复现**，也是本次加固最直接的收益。

---

## §4 待你拍板（4 件，都不是我该替你决定的）

| # | 事项 | 我的建议 |
|---|---|---|
| 1 | **★ 归属判定**：把 `deck_ownership.json` 里 3 条 `pending` 改成 `authoritative` + 填 `owner` | **先别定**。证据已被销毁（18:46 版没了），产出者会话可能还会继续；等它确认收尾再定 |
| 2 | **★ `generate_graphical_weekly_report.py` 接写入保护** | 它是**当前产出者**却**唯一没有保护**。接法 = 1 行 import + 1 行调用。**但它归另一个会话所有**，我按规范没动。**若你确认那个会话已收尾，我可以补上** |
| 3 | **交付是否统一到一处** | 现在最新版只在 `…\Desktop\周报\`，工作区那份是旧版，桌面根目录那份已不存在。要不要统一由你定 |
| 4 | `.gitattributes`（CRLF 翻转）／`build_reference_style_deck.py` 无保护（非交付路径） | 均为低优先，`git diff` 实测仍干净 |

---

## §5 一个未完全干净的小事（如实记录，未追到底）

项目门禁的时间线里有 `unsupervised-change` 记录（**门禁本身仍 ALL PASS**），涉及：

- `scripts/ops/export_integrated_master_deck.py`（21:11:41）—— 在 `scripts/ops/` 下，**不是我的改动**
- `scripts/ops/ppt/export_deck_v2_20260921.py`、`export_weekly_20260921.py`（21:51:41）—— 这两个文件 mtime 是**凌晨 02:1x**，
  即**并非 21:51 被改**，而是"相对很久以前的某次 release 未登记"的**历史欠账**
- `D:\…\outputs\INDEX.md`、`.workbuddy\memory\2026-09-22.md` 等

**其中一条是我造成的**：我 21:04 用 `node -e` 做时间线登记时，资源路径转义多了一层反斜杠，
登记落在 `D:\\Deepseek-Harness\\…`（双反斜杠）这种**不匹配真实路径**的 key 上。
我在 21:49:39 用**正确的单反斜杠路径**重新登记过（时间线可见），但**旧的错误 key 记录无法追溯删除**（append-only 日志）。

**影响**：仅"未登记改动"清单里有历史噪声，**不影响锁语义、不影响门禁结果**。我**没有**为此去改 `changes.jsonl`（那会破坏审计日志的只增语义）。

---

## §6 重启

**无待重启项。** 本次全部是静态文件（`.py` / `.json` / `.md`）+ 用户项目里的脚本，
**不涉及内核、桌面壳、补丁、dist、node_modules、插件注册** —— 与 Web GUI（http://127.0.0.1:43120）启动链路无关。
门禁 `check-all.ps1` 与 `startup-verify` 均通过。

---

## §7 归档判断

**我这边可以归档**：4 步加固全部完成、42 条断言全绿、门禁 ALL PASS、记录齐全
（本页 + 5 份前序报告 + `outputs/INDEX.md` 6 行 + `.workbuddy/memory/2026-09-22.md` 七节 + 时间线）。

**但归档前请确认一件事**：§2 里那个**我无法指认的并发会话**是否已经收尾。
如果它还在迭代同一个目录，那么 `deck_ownership.json` 里的 `candidates` 会在几分钟内再次过期 ——
**不是错误，机制本来就是为此设计的**（校验器会报 `[W]` 登记漂移，重跑 `python _check_ownership.py` 即可看到当前真相），
但归档时你应该知道这件事还活着。
