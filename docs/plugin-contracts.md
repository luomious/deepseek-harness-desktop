# DSH 插件契约文档（v1）

> 目的：方案书 v3 §7.1「契约版本化」落地。新插件 / 新能力必须满足对应契约，
> 由质量闸门（单测 + 契约文档 + verify-features 增量）把关。
> 状态标注：✅ 已生效（有实现）；📝 草案（规划中，注意官方上游可能原生实现，见 `docs/UPDATE-ASSESSMENT.md`）。

---

## 1. 工具调用事件契约 v1（✅ 已生效，dsh-tool-visibility 实现）

事件源：内核 `session/event` 总线（`tool/call` + `tool/result`），只读观察者，不干预 agent 循环。

记录字段（JSONL 落盘 `~/.dsh/tool-visibility/events.jsonl`，1MB 轮转）：

| 字段 | 类型 | 说明 |
|------|------|------|
| callId | string | 工具调用 ID（`tool/result` 位于 `message.source.callId` / `content[0].toolCallId`，系统内部 UUID 与模型侧 `call_00_` 不一致时用 (turn,step)+时间窗 FIFO 回退匹配） |
| name | string | 工具名 |
| status | enum | `pending` → `done` \| `error` |
| startedAt / finishedAt | number | 时间戳（ms） |
| durationMs | number | 耗时 |
| argsSummary | string | 参数摘要（截断 200 字符） |

路由：`GET /tool-visibility/status`、`GET /tool-visibility/recent`
可靠性：环形缓冲 200 条 + 全 try/catch + webServer 惰性解析与指数退避（依赖 `inject: ['timer']`）+ 零模型上下文开销（不注册工具）。

---

## 2. 连接器 manifest 契约 v1（📝 草案）

> 规划：连接器 = 技能 + 图标 + 工具 + MCP 捆绑分发单元（WorkBuddy `CONNECTOR_COS_CONFIG` 机制）。
> **状态判断（2026-08-31）：本地不实现**——官方上游 `0.1.2-alpha.1` 已原生新增 mcp-client 等 34 个依赖，
> 优先走官方升级路径（见 UPDATE-ASSESSMENT.md 触发条件 3/4），避免重复造轮子。

| 字段 | 说明 |
|------|------|
| name / version / author | 标识 |
| icons / skills / tools / mcp | 捆绑内容清单 |
| SHA-256 | 强校验（复用 dsh-skills-manager 市场下载器） |

---

## 3. 技能 frontmatter 契约 v1（📝 草案 / 部分实现）

| 字段 | 说明 | 状态 |
|------|------|------|
| name / description | 标识 | ✅ dsh-skills-manager 已支持 |
| triggers / when-to-use | 触发意图（规范化校验器 P2-A-2） | 📝 未实现 |
| 执行规范段 | Agent 执行规范（零交互 / 禁伪造 / 首次加载演示） | 📝 模板未建 |

---

## 4. 插件服务契约 v1（✅ 已生效，实证于 19 个工作插件）

装配（2026-08-31 实证修正，见 `UPGRADE-EXECUTION-LOG.md`「阶段 3a 收尾修正」段）：

| 层 | 要求 |
|----|------|
| cordis.patch.yml | **必须含 `- insert:` 块**（`- id:` / `name:` / `config.enabled`）——这是 cordis include loader 创建 fiber 的**装配入口**；纯注释形态 = 无装配入口 |
| 模块形态 | 单文件、无相对导入（loader 解析最稳） |
| inject | 用 `ctx.setTimeout` 前必须 `inject: ['timer']`，否则首次路由注册失败后永不重试 |
| 清单层 | profile package.json：dependencies + bundles + junction + 模板同步（startup-verify V2 守护） |
| 装配验证 | **以 `dev_plugin_status` loader entries 有 fiber 为准**，不能只看清单 active 或文件级检查 |

质量闸门：`node --test` 单测 + 本文档登记 + verify-features 增量。

---

*首次建立：2026-08-31（升级计划 A 组收尾）。*
