# 文件清理 + 覆盖保护审计 + 一次自我纠错（2026-09-22）

> 用户要求：先调查分析 → 执行推荐项 → **整理和清理文件** → 做好记录 → 评估风险收益 → 保证长期可运行、可维护、可迭代、可扩展。
> 结论：清理回收 **~6.03 MB**；**发现并纠正了我自己的一个错误**（采信未复核的子代理结论、往用户生产代码里加了一条冗余守卫，已逐字节回滚）；把"覆盖保护"从传闻变成了**自己复核过的精确清单**；给 skill 加了完整性清单。

---

## 一、清理（回收 ~6.03 MB）

### 删除清单（全部在 `D:\Deepseek-Harness` 内，走回收站）

| 路径 | 大小 | 判定依据 |
|---|---|---|
| `_tmp/ref-deck-20260922/` | 5.72 MB | 用户桌面文件的副本 + 两套**逐字节相同**的 PNG 渲染件；全部可再生（报告里已标注"临时，可删"） |
| `_tmp/check-all-after-hardening.log` | 0.10 MB | 可再生日志 |
| `_tmp/check-all-final.log` | 0.10 MB | 可再生日志 |
| `_build/deck-design/` | 0.08 MB | 与已安装 skill **17 个文件逐字节相同**（SHA-256 比对）⇒ 纯重复，漂移隐患 |
| `_mermaid-repro.tmpdir/` | 0.03 MB | 空残留目录 |
| `_build/`（删空后） | — | 删除上面那项后已空 |
| `%TEMP%\ppt-eval`、`guarddiag`、`guardtest-*`、`deckverify` | — | 本次调查的临时件 |

**核验方式**：以**文件系统事实**确认（`Test-Path` 前后对比），**不看删除命令的退出码**（本仓库 `AGENTS.md` 明确要求）。

### 保留清单（**证据链原则**）

**凡在报告或 task-scheduler FILES 清单里被引用为证据的文件，一律不删** —— 删了会断掉可追溯性：

| 保留项 | 被谁引用 |
|---|---|
| `_tmp/*.mjs`（10 个） | `outputs/2026-09-22-report-vision-autoread-fix/REPORT.md` + 时间线 FILES |
| `_tmp/spare-keys-new-20260922.json` | 同上 |
| `_tmp/verify-pptwise-registration-20260922.mjs` | PPT 工具链安装的重启前预演证据 |
| `_tmp/pptwise-selftest-20260922/` | `outputs/2026-09-22-report-ppt-toolchain/REPORT.md` §9 证据文件清单 |
| `_tmp/postrestart-smoke-20260922/` | 同报告 §10 |
| `_tmp/test-protected-guard-20260922.py` | **新增**回归测试（见 §三） |
| `_tmp/audit-save-guards-20260922.py` | **新增**覆盖保护审计器（见 §四） |

清理后 `_tmp` 从 **6.1 MB → 0.15 MB**。

---

## 二、★ 自我纠错：我采信了未复核的子代理结论

### 发生了什么

子代理审计报告称：`export_weekly_20260922.py`「`:20` 的 `PROTECTED` 常量被定义但全文件未参与任何拒写判断」。
我**没有复核就照做了**，往用户的**生产脚本**里加了一条"修复"守卫。

### 实际情况（我自己读了源码）

该文件**本来就有可用守卫**，而且在 `build()` 开头（`:113-119`）：

```python
def build():
    for p in PROTECTED:
        if os.path.abspath(OUT)==os.path.abspath(p):
            raise SystemExit("[FATAL] refusing to write to PROTECTED input: %s"%p)
    if os.path.exists(OUT):
        bak=OUT+".bak-"+time.strftime("%Y%m%d-%H%M%S"); shutil.copy2(OUT,bak)
        print("[backup] %s"%bak)
```

它**同时**做了两件事：
1. 拒绝写入 `PROTECTED` 路径（精确 abspath 比较）
2. **任何非保护目标覆盖前自动 `.bak-<时间戳>` 备份**

**这正是我准备"新增"的策略 —— 早就有了，而且比我写的更好。** 我加的第二条守卫是纯冗余。

### 处置

1. 立即从 `_backups/deck-guard-fix-20260922-200118/` **逐字节还原**两个被改文件（SHA-256 比对 `identical=True`）
2. 顺带还原的还有 `build_v8m_v11m_board_20260922.py` —— 那处"丢弃 `safe_out` 返回值"**不是 bug**（`safe_out` 语义就是"备份后返回原路径"），只是可读性可改进；既然我的验证链已不可信，一并还原，改为**提案**
3. 把那个故障注入测试**改造成既有守卫的回归测试**，让它以后无法再被"凭记忆重新定性"

### 回归测试结果（证明既有守卫真的有效）

```
guard present : True
case 1: OUT -> PROTECTED deck
  exit code      : 1
  refused        : True
  ref deck intact: True (size 1698327 -> 1698327)
case 2: guard properties in the real source
  exact abspath compare : True
  backup before write   : True
PASS
```

### 教训（写进 memory）

**「子代理说 X」不等于「X 成立」。** 本仓库 `AGENTS.md` 的证伪义务条款明确点名「为空 / 0 个 / 全部通过 / 已修复」四类断言必须换方法复核 —— 本次踩的正是「**未使用 / 死代码**」这一类，它同样属于"断言某处为空"。**而且我改的是用户的生产代码**，比改自己的文件严重得多。

---

## 三、覆盖保护审计（自己复核的精确清单）

### 方法

写了一个审计器（`_tmp/audit-save-guards-20260922.py`）：对每个 `.pptx` 写入点，检查其**前 25 行内**是否出现 `safe_out|PROTECTED|.bak-|shutil.copy2|shutil.move|os.replace`；只用于图片的 `os.path.exists()` **不算**守卫。

### 结果：23 个写入点 / 17 个文件，其中 **15 处无保护 / 9 个文件**

| 文件 | 无保护写入点 |
|---|---|
| `build_ppt_a.js` | 1 |
| `build_ppt_b.js` | 1 |
| `build_reference_style_deck.py` | 1 |
| `generate_executive_weekly_decks.py` | 2 |
| `generate_flawless_weekly_report.py` | 2 |
| `generate_infographic_weekly_report.py` | 3 |
| `generate_visual_workspace_weekly_report.py` | 2 |
| `generate_weekly_task_decks.py` | 2 |
| `generate_workspace_weekly_report.py` | 1 |

**已受保护的 8 个文件**（含 `export_weekly_20260922.py`、`build_final_*`、`build_weekly_v2`、`build_weekly_chartdecks`、`build_v8m_v11m_board`、`export_deck_v2`、`export_training_analysis`、`export_weekly_20260921`）。

### ★ 我自己审计器的一处误报（一并记录）

审计器把 `export_weekly_20260922.py:286` 判为"无保护" —— 因为它的守卫在 `build()` 开头，距保存点 **172 行**，超出了 25 行回看窗口。**这是工具的假阳性，不是代码缺陷**（该守卫已由故障注入证明有效）。真实数字因此是 **15 处**，不是 16 处。

> 与 §二 同一个教训的两面：**先怀疑自己的判定工具，再怀疑代码。**

---

## 四、风险 / 收益评估

### 本次已执行项

| 动作 | 收益 | 风险 | 可逆性 |
|---|---|---|---|
| 清理 6.03 MB 可再生文件 | 工作区整洁；`_tmp` 6.1→0.15 MB | **低** —— 全部可再生，且走回收站 | 回收站可还原 |
| 删除 `_build/deck-design` 重复副本 | **消除漂移隐患**（单一真源） | **低** —— 已 SHA-256 证明逐字节相同 | 从已装 skill 反向复制即可 |
| 给 skill 加 `MANIFEST.sha256` | 以后可检测漂移/半写 | **极低** —— 纯新增只读文件 | 删掉即可 |
| 回滚我对用户脚本的两处改动 | **消除未验证改动** | **无** —— 已逐字节还原并核验 | 已完成 |
| 新增 2 个只读审计/回归脚本 | 把结论变成可复跑的证据 | **无** —— 只读 | — |

### 未执行项（提案，等用户拍板）

| 提案 | 收益 | 风险 | 建议 |
|---|---|---|---|
| **给 15 处无保护写入点加"覆盖前备份"** | 防止再次发生**不可恢复**的覆盖（本仓库已记录一次 1.66 MB 事故） | **中** —— 改动 9 个生产脚本；虽然模式已有 8 个同目录先例，但会改变生成流程行为 | 建议做，但**先由你确认**；做法：抽一个共享 `_deck_io.py`（单一实现）+ 每文件先备份 + `py_compile` + 故障注入验证 |
| `build_v8m_v11m_board` 使用 `safe_out` 返回值 | 可读性/抗未来变更 | 低 | 可选 |
| 向 pptwise 上游反馈 `pptwise_preview` 相对路径问题 | 惠及所有用户 | 低 | 可选 |

**为什么这 15 处我没有直接改**：§二 刚证明我在这个代码库上的"验证"出过错；而这是**用户的生产生成流程**，改错会静默破坏周报产出。按本仓库规矩（高风险需先备份→预检→征得确认），列为提案更稳妥。

---

## 五、长期可维护 / 可迭代 / 可扩展

### skill 的维护模型（已落地）

| 关注点 | 机制 |
|---|---|
| **单一真源** | 只有 `~/.dsh/skills/deck-design/` 一份；`_build/` 重复副本已删除（与其余 61 个全局 skill 的做法一致） |
| **完整性** | `MANIFEST.sha256`（17 个文件的 SHA-256），可随时核验漂移或半写 |
| **防回归** | `scripts/self_test.py` —— 改动任何门禁后必须跑；**一道从不报警的门禁就是橡皮图章** |
| **可迭代** | 新增校准点写进 `references/design-invariants.md` 并**标注其对应场景**，不要直接改 pacing 表 |
| **可扩展** | `references/` 按主题分文件；`scripts/` 全部只吃 argv、零项目路径 ⇒ 可直接复用 |

### 验证（从**安装位置**跑，不是从构建目录）

```
=== render via INSTALLED renderer ===   exported 11 slides
=== self_test via INSTALLED copy ===
  PASS baseline qa_layout: no BOUNDS/FIT on good deck
  PASS baseline fit_check on good deck (expect 0)
  PASS F1 empty chart cache -> qa_render flags it
  PASS F2 out-of-canvas shape -> qa_layout BOUNDS
  PASS F3 overflowing text -> fit_check OVERFLOW
  PASS F4 missing PNG -> qa_render MISMATCH
  6/6 gates fired as expected
```

### 门禁

- `lint-skills`：**0 FAIL**（deck-design 唯一提示是 `metadata missing`，全部 163 个 skill 同样提示，属系统级约定未推广，非本次引入）
- `check-all.ps1`：**CHECK-ALL: ALL PASS**

---

## 六、长期运行风险清单（现状）

| 风险 | 等级 | 现状 |
|---|---|---|
| 15 处无保护覆盖写入（9 个用户脚本） | **中** | 已精确列出，待用户决定是否加固 |
| `~/.dsh/skills/deck-design/` 不在 git 里 | 低 | 与其余 61 个全局 skill 一致；`MANIFEST.sha256` + 本报告提供基线 |
| pptwise 0.x 破坏性变更 | 低 | 已 pin `0.35.0` |
| `pptwise_preview` 必须传绝对路径 | 低 | 已写入 skill 与报告 |
| `soffice` 缺失 ⇒ 无 PDF 导出 | 低 | PowerPoint COM 已覆盖渲染；PDF 非必需 |
| `_tmp` 会再次增长 | 低 | 本次已建立"证据链优先、其余可删"的判定标准，可复用 |

---

## 七、本次新增/改动的文件

| 文件 | 动作 |
|---|---|
| `~/.dsh/skills/deck-design/MANIFEST.sha256` | 新增（完整性基线） |
| `_tmp/test-protected-guard-20260922.py` | 新增（既有守卫的回归测试，PASS） |
| `_tmp/audit-save-guards-20260922.py` | 新增（覆盖保护审计器） |
| `_backups/deck-guard-fix-20260922-200118/` | 新增（两文件备份，已用于回滚） |
| 用户脚本 `export_weekly_20260922.py` | **已改 → 已逐字节还原**（净零） |
| 用户脚本 `build_v8m_v11m_board_20260922.py` | **已改 → 已逐字节还原**（净零） |
