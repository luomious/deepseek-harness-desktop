# DSH 已有功能审计（EXISTING-FEATURES-AUDIT）

> 日期：2026-09-01 ｜ 依据：dev_plugin_status loader entries + 源码 grep（unpacked node_modules）
> 目的：避免重复造轮子（教训 8），确认27 项 WorkBuddy 借鉴清单中哪些 DSH 已内置

---

## 审计结果

| WorkBuddy # | 借鉴项 | DSH 状态 | 证据 | 结论 |
|---|---|---|---|---|
| #1 增强提示词 | 增强/改写按钮 | ❌ **缺失** | `ui-input-trigger` 无 enhance/boost/rewrite 按钮 | **需做** |
| #3 记忆系统 | Agent/会话双级记忆 | ❌ **缺失** | `ui-conversation` 无 memory 关键词；内核无独立记忆插件 | **需做**（或等官方） |
| #6 上下文用量 | token 使用百分比 | ✅ **已有** | `token-meter [active]` + `ui-conversation` usage 追踪 + `ui-trajectory` token 统计 + `ui-model-selection` contextWindow | **跳过** |
| #7 消息折叠 | n 个工具调用折叠 | ✅ **已有** | `ui-conversation`：Tool calls disclosure chrome、collapse、fold | **跳过** |
| #8 错误横幅 | 网络检测/重试/反馈 | ✅ **已有** | `ui-message-feedback [active]`：error.code 处理、feedback 机制 | **跳过**（形态不同但功能覆盖） |
| #9 插件三范围 | user/project/local | ❌ **缺失** | `ui-settings-plugins` 无 scope/install range | **需做** |
| #10 Subagent watcher | 文件热更新 | ❌ **缺失** | `tool-subagent-control` 无 fileWatch/watcher | **需做** |
| #11 渲染器 keyed 卡 | 工具专用卡片 | ⚠️ **slot 存在，未实现** | `tool.call.toolview` slot 已确认，需逐个注册 | **按需增量** |
| #12 @mention 体系 | 多类型 @ 触发 | ✅ **已有** | `ui-input-trigger` 有 `registerSource` API；4 个源已注册：commands、@pluginId、reference、skill | **跳过**（机制已有，可按需加新源） |
| #15 主题系统 | 6 维度主题 | ✅ **已有** | `ui-theme [active]`：accentColor/grayColor/radius/scaling 等 CSS 变量 | **跳过** |
| #16 Mermaid/LaTeX | 图表/公式渲染 | ⚠️ **LaTeX 已内置；Mermaid 缺失** | `dsh-client-ui-primitives` MarkdownText：`katex`+`mdast-util-math` 已启用（`mathFromMarkdown()`、`math`/`inlineMath` → `renderTexToReact`）✅；三 client 包均无 `mermaid`，CodeBlock 无 slot 注入点 ❌ | **LaTeX 跳过（已内置）；Mermaid 暂缓** |

## 审计结论

**已内置（可跳过）**：#6、#7、#8、#12、#15 — **5 项**
**slot 已有、需实现**：#11 — **1 项（✅ 2026-09-02 已落地，见 dsh-tool-renderers）**
**部分缺失**：#16 — **LaTeX 已内置（primitives katex+math），仅 Mermaid 缺失（无注入点，暂缓）**
**真正缺失**：#1（✅ 已做 prompt_enhance）、#3、#9、#10 — 4 项
**等官方**：#3（记忆系统）、#9（插件范围）— 官方 alpha 已含相关能力，可等 stable

## 修正后的后续计划

| 优先级 | 项 | 理由 |
|---|---|---|
| **P1** | #11 工具渲染器 keyed 卡 | ✅ **已落地 2026-09-02**：dsh-tool-renderers 覆盖 17 个 DSH 工具 |
| **P1** | #1 增强提示词 | ✅ **已做 2026-09-02**：prompt_enhance agent 工具化 |
| **P2** | #3 记忆系统 | 中风险（需新建插件），或等官方 stable |
| **P2** | #16 Mermaid（仅 Mermaid） | LaTeX 已内置；Mermaid 无 slot 注入点，改内核/DOM hack 中高风险且不可迭代，**暂缓**（等官方或用户明确需要再做） |
| **P3** | #9 插件三范围 | 等官方 stable（alpha 已含相关能力） |
| **P3** | #10 Subagent watcher | 开发体验改进，非核心 |

---

*本审计由阶段 A 执行，避免教训 8（重复造轮子）。2026-09-02 修正：LaTeX 实为已内置（初版误判），Mermaid 仍缺失但无低风险落地路径。*
