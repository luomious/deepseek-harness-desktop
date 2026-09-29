# 「优点全部学习」清单 · 官方 Desktop + QuWork → 我方 DSH

> 日期：2026-09-27 ｜ 类型：学习清单（分析 + 核验 + 执行批次）
> 前置材料：`outputs/2026-09-26-threeway-official-quwork-ours/AUDIT-AND-PLAN.md`（十二维度对撞 + 43 插件/28 补丁/62 技能裁决）、`outputs/2026-09-24-analysis-quwork-vs-dsh/REPORT.md`（QuWork 逆向 + 12 条可学）、`outputs/2026-09-27-upgrade-impact-0.1.7-rc.2/REPORT.md`（P0-7）。
> 本文为增量：**① 两产品优点去重合并总表 ② 我方现状实测核验（已学/未学/部分）③ 学习执行清单（优先级 + 重启需求）**。凡有「实测」标注均为本轮核验。

---

## 一、优点全集（官方 Desktop + QuWork，去重合并）

> 来源属性：`[官方]` = 官方 `@deepseek-ai/dsh-desktop` 0.1.7-rc.2；`[Q]` = QuWork 1.2.0；`[双源]` = 两者独立收敛同一结论（最高可信度）。

### A 组 · 双源确认（两家都做 ⇒ 是约束不是偏好）
| # | 优点 | 来源 | 我方现状 |
|---|---|---|---|
| A1 | **内核是只读资产，启动期绝不安装依赖**（官方"从不跑 pnpm" / Q"pre-extracted 不再解压"） | [双源] | ✅ 已符合（dist 内置完整依赖树） |
| A2 | **壳与内核同版本同发布**（官方同版本单元 / Q recipe+digest 绑定） | [双源] | ⚠️ 未完全（P4-8，需升级后统一身份） |
| A3 | **宿主挂了也有原生恢复路径**（官方四选项 / Q proposal+检查点） | [双源] | ❌ 未学（P2-1/P2-7，我们有 startup-verify 只报错） |
| A4 | **插件安装安全闸门**（下载侧 SSRF + 解包侧 zip-slip；Q 全做了，官方部分） | [双源] | ⚠️ 部分（fetch-local 有 SSRF；无统一归档闸门） |
| A5 | **崩溃自带现场且容量有界**（官方报告+保留10份 / Q stdout/stderr tail） | [双源] | ❌ 未学（有 log-write-guard 但无「退出即带现场」） |
| A6 | **说明性日志/指标不撒谎**（官方验证链 / Q `checked` 分母） | [双源] | ✅ 部分（P0-2 记原因已做；指标分母待查） |

### B 组 · 官方独有（更值得偷）
| # | 优点 | 证据 | 我方现状 |
|---|---|---|---|
| B1 | **两阶段安装批准 + 任务中断 fail-safe**（查询失败按有任务、批准后锁新请求、超时拒装） | AUDIT 1.1 安装批准行 | ❌ 未学（P4-3） |
| B2 | **Windows PE 签名+验签流水线**（任何构建模式不关闭完整性策略） | AUDIT 1.1 签名行 | ❌ 未学（P4-1，未签名） |
| B3 | **更新节流：±20% 抖动 + 失败翻倍 + 成功重置** | AUDIT 1.1 更新节流行 | ❌ 未学（P4-2） |
| B4 | **崩溃报告来源分类 + 保留最新 10 份** | AUDIT 1.1 崩溃诊断行 | ❌ 未学 |
| B5 | **自带 Python 运行时（numpy/pandas/docx/pptx…）+ 离线装到 $DSH_HOME** | AUDIT 1.1 运行时行 | ❌ 未学（我们靠系统 Python？待核） |
| B6 | **内置 Office 三技能 + 结构检查器 + 交付质量闸门** | AUDIT 1.1 Skill 行 | ⚠️ 我们有 Office 技能但缺结构检查器（P3-7） |
| B7 | **中英双语 + 壳词典 + 欢迎页跟随系统语言** | AUDIT 1.1 本地化行 | ⚠️ 部分 |
| B8 | **0.1.7 设计系统**（corner-shape superellipse / elevation / FOUC-free / token） | AUDIT 1.1 设计系统行 | ❌ 未学（P4 之后，随内核升级） |

### C 组 · QuWork 独有（更值得偷）
| # | 优点 | 证据 | 我方现状 |
|---|---|---|---|
| C1 | **单操作互斥**（install/uninstall 共享 operation，占用即 pending） | Q REPORT §8-1 | ⚠️ 有 task-scheduler 人工锁；无运行时互斥层（P2-4） |
| C2 | **Profile 三槽检查点 + 崩溃中间态穷举 + skip-next-healthy** | Q REPORT §8-2 | ❌ 未学（P2-7） |
| C3 | **`writeAtomic`（tmp-pid-uuid + rename）全仓库统一** | Q REPORT §8-3 | ⚠️ 部分（scripts/lib/atomic-write.mjs 存在，未铺到全部写点） |
| C4 | **归档安全闸门**（zip-slip/symlink ancestor/NFKC 碰撞/上限） | Q REPORT §8-4 | ❌ 未学（无统一 archive-guard） |
| C5 | **SSRF + 逐跳重定向复检 + 流式限长** | Q REPORT §8-5 | ⚠️ 部分（dsh-web-fetch-local 有 SSRF 3 hits，未逐跳） |
| C6 | **Ed25519 release manifest + patchSet/patchDigest** | Q REPORT §8-6 | ⚠️ 部分（P0-6 patchDigest 已做；无签名） |
| C7 | **vendor 离线包 + 内置 pnpm + frozen-lockfile 声明式安装** | Q REPORT §8-7 | ❌ 未学（依赖在线 npm） |
| C8 | **启动失败 → 自动诊断 → recovery proposal 交用户** | Q REPORT §8-8 | ⚠️ 部分（startup-verify 只报错） |
| C9 | **技能安装静态审计 + 确认闸门（installDisabled）** | Q REPORT §8-9 | ❌ 未学 |
| C10 | **技能注入 XML + `<location>` 绝对路径 + mandatory 措辞** | Q REPORT §8-10 | ❌ 未学（我们 9KB 纯文本 catalog → 锚定率 0%）——**本报告聚焦学习此项** |
| C11 | **崩溃现场自带（退出事件附 stdout/stderr tail + URL 脱敏）** | Q REPORT §8-11 | ❌ 未学 |
| C12 | **能力发现先行 + checked 分母 + restart.supported** | Q REPORT §8-12 | ❌ 未学 |
| C13 | **三级交付模型（runtime/bundled/remote）+ 版本并存回滚** | Q REPORT §3.1/3.3 | ❌ 未学 |

---

## 二、我方现状实测核验（2026-09-27，非推断）

| 项 | 实测结果 |
|---|---|
| 内核版本 | `@deepseek-ai/dsh@0.1.1-rc.2`（未升级；官方/QuWork 均为 0.1.7 线 ⇒ A2 成立） |
| 壳版本 | `dsh-plugin-desktop@2.0.2` |
| 插件 | plugins/ 40 目录 + 3 根级（context-lifecycle/stuck-loop-guard/vision-rotator）= 43 ⇒ **布局分散（T5/P1-1 未学）** |
| 补丁 | 28 个 apply-*.mjs；`patches/MANIFEST.json` **已存在**（P0-6 已学） |
| 技能 | 62 个 SKILL.md：**frontmatter 7 种模式并存**；仅 26% 有 `whenToUse`（16/62）、26% 有 metadata（16/62）；19 个只有 name+description ⇒ **C10/schema 收敛未学** |
| 原子写 | `scripts/lib/atomic-write.mjs` 存在（C3 部分学） |
| SSRF | `dsh-web-fetch-local/lib/index.js` 有 SSRF 防护（C5 部分学） |
| 归档闸门 | 无 archive-guard（C4 未学） |

---

## 三、学习执行清单（按优先级）

### 批次 1 · 免重启 + 低风险（本轮即可执行）
| # | 学什么 | 动作 | 验证 | 风险 | 收益 |
|---|---|---|---|---|---|
| L1 | **C10 技能注入优化（第一刀：schema 收敛）** | 62 技能 frontmatter 统一为 `name/description/whenToUse/version/metadata`；给缺失的 46 个补 `whenToUse`（从描述提取）；4 个缺 frontmatter 的补全 | schema 校验脚本：62/62 三字段齐全；门禁 lint-skills 不报新错 | 低（frontmatter 可回退） | **高**：为后续「XML 注入 + 锚定率」铺路（用户重点） |
| L2 | **A6 指标分母核查** | 检查 selfHeal/「check 分母」类日志是否实报分母 | grep 报告 | 低 | 中（诚实性） |
| L3 | **C3 原子写覆盖面核查** | 清点插件写点哪些未走 atomic-write；产出清单（不改代码，只登记） | 清单 0 遗漏 | 低 | 中（为批量改造铺路） |

### 批次 2 · 需重启 + 低-中风险（就绪后由你重启验收）
| # | 学什么 | 动作 | 风险 | 收益 |
|---|---|---|---|---|
| L4 | **C10 技能 XML 注入 + 锚定率对照** | 技能 catalog 从纯文本摘要改为 `<available_skills>` + `<id>/<name>/<description>/<location>`；锚定率前后实测 | 中 | **高**（核心 KPI） |
| L5 | **C9 技能安装审计闸门** | curl\|bash / rm -rf / secret 三规则 + 确认闸门 | 低-中 | 中高 |
| L6 | **B6/P3-7 交付质量闸门** | docx/pptx/xlsx 重新打开 + 结构检查器 | 低 | 中高 |

### 批次 3 · 高风险 / 需拍板（学习但须专门设计）
| # | 学什么 | 注意 |
|---|---|---|
| L7 | **A3/C2 Profile 检查点 + 原生恢复**（P2-1/P2-7） | 涉及壳启动链路，高风险 |
| L8 | **C1/P2-4 单操作互斥运行时化** | 注入器核心 |
| L9 | **A5/B4/C11 崩溃报告 + 现场** | 需方案设计 |
| L10 | **B1/P4-3 两阶段批准 + 任务中断 fail-safe** | 更新链路 |
| L11 | **B2/P4-1 Windows 签名** | 决策（签名 or 如实说明） |
| L12 | **A2/C6/P4-7/P4-8 内核升级 0.1.7 + 身份统一** | 按 P0-7 清单，最高风险 |

---

## 四、本轮执行

按「先调查后执行 + 确定有提升」，本轮落地 **L1（skill schema 收敛）**——免重启、低风险、对用户重点（skill 库）有直接提升，且是 C10（注入优化）的前置。其余批次见「需要你拍板」。

### L1 已执行（2026-09-27）

**动作**：给 46 个缺 `whenToUse` 的技能补上该字段（frontmatter 末尾插入，保留原正文；`_tmp/skill-when-converge.cjs` 半自动 + 46 条手写触发文案）。

**结果（实测）**：
| 指标 | 前 | 后 |
|---|---|---|
| 有 `whenToUse` | 16/62 (26%) | **62/62 (100%)** |
| frontmatter 可解析 | — | **62/62** |
| lint-skills FAIL | 0 | **0**（TOTAL 169 PASS） |
| body 完整性 | — | size delta = 插入文案长度（109/86/69/132 B 抽查 4 例），正文无损 |

**备份**：`_backups/skills-schema-r8-20260927-140924/skills-backup/`（62 技能全量）。

**局限（如实）**：`whenToUse` 文案由我手写（基于各技能 description 的触发语义），**未经自动化质量断言**；L4（XML 注入 + 锚定率对照）才是「注入优化」的终极验证，L1 只是 schema 前置。

### L1b 已执行（2026-09-27，metadata 扁平 5 键收敛）

**动作**：给 56 个缺扁平 metadata 的技能补 `metadata: {version, owner, status, tags, since}`（46 个整块新增 + 10 个 hermes 嵌套内合并，不破坏 hermes）；6 个已有扁平 5 键的技能跳过。`_tmp/skill-metadata-converge.cjs`。

**结果（实测）**：
| 指标 | 前 | 后 |
|---|---|---|
| 有扁平 metadata 5 键 | 6/62 | **62/62** |
| YAML 解析（vendor yaml 包） | — | **62/62 无错** |
| lint-skills 用户段 WARN | 56 | **2**（消 54，剩 2 为既有 nested-invocation） |
| lint-skills TOTAL WARN | 163 | **109** |
| `skill-inventory.mjs` missing metadata | 46+ | **0**（EXIT 0） |

**备份**：`_backups/skills-metadata-r8-20260927-144827/skills-backup/`（62 技能全量）。

**收益**：技能元数据成完整治理契约（version/owner/status/tags/since）——后续可机器筛选/审计/排序/失效管理（QuWork 四元组 + 官方 metadata 语义的学习落地）；门禁 WARN 显著下降（163→109），噪音清除。

**局限（如实）**：`tags` 为通用空数组（未按内容语义填充——那需逐技能阅读）；`version: 0.1.0`/`since` 为治理基线默认（非内容真实版本历史）；这两个字段的价值在后续**按内容维护**时体现，当前仅满足契约完整性。

## 五、诚实边界

- 优点全集引用自既有分析（AUDIT/QuWork REPORT），本轮只做了现状核验（二），未重新逆向官方/QuWork（材料仍有效，10 天内未变）。
- L1 的 `whenToUse` 提炼为**半自动**：从 description 提取 + AI 润色，需人工抽查质量。
- L1b 的 metadata 值为**契约默认**（version 0.1.0 / owner local-dsh / status active / tags [] / since 2026-09-27），非内容语义审计产物；tags 按内容填充留待后续维护。
- 未学项的大项（批次 3）已列清单，具体设计待用户拍板后单独开展。

---

## 六、L1c 已执行（2026-09-27，invocation 死配置清理，免重启）

**问题**：`diagram` / `firecrawl-usage` 的 frontmatter 带**嵌套 `invocation:{}`**（`trigger/modelInvocable/userInvocable` camelCase）。内核 `parseInvocationPolicy`（`dsh-skill-filesystem lib/:843-853`）**只读顶层扁平 kebab 键**（`disable-model-invocation`/`user-invocable`），嵌套块**完全不读** ⇒ 作者以为在控制调用策略，实际**无效**（lint 对此 WARN）。另：顶层 camelCase 遗留键会被 `rejectLegacyInvocationKey` **throw → skill 忽略**（本轮两技能 camelCase 在嵌套内，未触发 throw，但仍是死配置）。

**修复**：删除两技能嵌套 `invocation:` 块（`_tmp` 脚本行级删除 + 原子写）：
- `diagram`：删块 → 默认策略 = `modelInvocable:true / userInvocable:true`（双通道，作者意图「auto + 都可调」）
- `firecrawl-usage`：删块 + 保留既有 `disable-model-invocation: true` → `modelInvocable:false / userInvocable:true`（仅用户可调，意图明确）

**验证（实测）**：
- 内核策略模拟：diagram `modelInvocable=true/userInvocable=true`；firecrawl `false/true`；无 invocation 残留
- lint-skills 用户段：**62 PASS / 0 FAIL / 1 WARN**（nested-invocation WARN 2→0；剩 1 = `firecrawl-usage body 631 行` 既有流程型超长）
- TOTAL：169 PASS / 0 FAIL / **108 WARN**（109→108）
- 本次启动后 0 条 `invalid invocation` 日志；skill-filesystem watcher 自动重载

**备份**：`_backups/skills-invocation-fix-20260927/`（2 文件 orig）。

**收益**：消除「作者以为生效实际无效」的隐性控制配置（内核语义、lint 注释、实测三证）；调用策略真实生效；门禁噪音再减。

**局限**：`trigger: auto` 语义未单独落地（该键在扁平契约里本就不存在，属嵌套专有；扁平契约只有 model/user 两个布尔通道）。

---

## 七、L4（XML 注入 + 锚定率）调查结论（待拍板，未执行）

- **结论**：技能模型态注入分两路：**① catalog 注入**（available_skills 列表 → system prompt，AGENTS.md 自记「9KB catalog 使锚定率 81%→0%」）与 **② 内容注入**（`renderSkillContent` `<skill_content>`，dsh-skill lib `:57-69`，已是 XML 形态）。
- **差距**：catalog 注入当前是**纯文本 name+description 列表**（QuWork C10 的 XML + `<location>` 绝对路径 + 只注 id/name/description 的做法是官方未做的优化）；内容注入已是 XML。
- **落地成本**：需改 dsh-tool-skill / system-prompt 相关加载器（dist 补丁或 profile 层）+ **锚定率评测方法**（anchored-standard 实测要有可复现 prompt 集）⇒ **需重启 + 中风险 + 评测基建**。
- **建议**：作为独立批次（L4），待技能 schema 收敛（L1/L1b/L1c 已完成）后开展；本轮不执行。