# dsh-tool-renderers

按 WorkBuddy 优化 DSH · 阶段 1（#11 工具渲染器 keyed 卡）落地插件。

## 作用

为 DSH 特有、原本只走通用兜底卡（`GenericToolCard`）的工具，注册 `tool.call.toolview`
keyed 渲染器，在会话流中显示紧凑摘要卡（工具名 + 状态 + 参数摘要 + 结果首行）。

已注册 key（wire 工具名）：

| 工具 | 卡标题 | 摘要字段偏好 |
|---|---|---|
| `get_goal` | Get Goal | goalId / goal_id / id / goal |
| `create_goal` | Create Goal | content / objective / description |
| `update_goal` | Update Goal | action / goalId / goal_id / id |
| `job_output` | Job Output | jobId / job_id / id |
| `job_list` | Job List | — |
| `job_kill` | Job Kill | jobId / job_id / id |
| `subagent` | Subagent | task / prompt / description |
| `subagent_fork` | Subagent (Fork) | task / prompt / description |
| `read_image` | Read Image | path / file_path / filePath / url |
| `tool_search` | Tool Search | query / keywords |
| `tool_describe` | Tool Describe | name / tool / toolName |
| `tool_call` | Tool Call | name / tool / toolName / arguments |
| `dev_plugin_status` | Plugin Status | — |
| `workflow` | Workflow | meta.name（workflow: 前缀）/ script / name / description |
| `ralph` | Ralph Loop | task / objective / description |
| `mcp_call` | MCP Call | server / tool / toolName / name |
| `mcp_search` | MCP Search | query / keywords |

## 机制（依据）

- slot：`tool.call.toolview`（`dsh-client-ui-tool` 在 `conversation.chat.node` 声明，
  `kind: keyed`，`scope: session`）。
- 渲染：`renderSlot("tool.call.toolview", owner, { entryKey: toolName, fallback: GenericToolCard })`
  —— 按 `entryKey`（= wire 工具名）匹配；未命中回退通用卡。
- 内置已占用 key（勿重复注册）：`ask_user_question`、`bash`、`edit`、`write`、`read`、
  `grep`、`glob`、`todo_write`、`web_search`、`web_fetch`。

## 结构

```
plugins/dsh-tool-renderers/
  package.json       # dsh.bundle.patch + dsh.client(web)
  cordis.patch.yml   # insert 装配入口（id: dsh-tool-renderers）
  lib/index.js       # host stub（无 host 逻辑）
  lib/client.js      # 手写 lazy-CJS bundle，注册 keyed 渲染器
```

## 迭代（新增一个工具渲染器）

1. `lib/client.js` 的 `TITLES` / `SUMMARY_KEYS` 各加一行，key = 该工具的 wire 名；
2. `TOOL_KEYS` 数组加入该 key；
3. `node --check lib/client.js`；
4. 干净重启验证（`dev_plugin_status` 出现 `dsh-tool-renderers` fiber + 会话里触发该工具，
   卡渲染为自定义摘要而非通用卡）。

> 防御性：`ToolSummaryCard` 对 running/settled 两种 block 形态与缺失字段全部兜底，
> 不抛异常（UI 错误边界之下也不崩）。

## 回滚

```bash
# 预检（只读）
node scripts/deregister-plugin.mjs --plugin @dsh-external/dsh-tool-renderers
# 确认后执行
node scripts/deregister-plugin.mjs --plugin @dsh-external/dsh-tool-renderers --yes
node scripts/startup-verify.mjs && node scripts/scan-dangling.mjs --strict
```
（或运行态内 super-injector `dev_uninject_plugin`：卸 loader entry + 删 junction + 写 patch disabled。）
