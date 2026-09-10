# DSH 零风险改进计划

> 基于对 Hermes Agent CN Desktop 的分析，筛选出的**真正零风险且有实际提升**的改进项。
> 创建日期: 2026-09-11

## 判定标准

| 条件 | 说明 |
|------|------|
| **不修改现有行为** | 只做"追加"或"新插件"，不改动已有逻辑 |
| **不删除/不阻止** | 不拦截操作，不清理文件 |
| **纯观测性质** | 只记录、只展示、只告警 |
| **失败即静默** | 任何异常 catch → 忽略，不影响主流程 |
| **可配置关闭** | config 中 `enabled: false` 即完全禁用 |
| **零启动链影响** | 不在 main.js / boot 路径上，不阻塞启动 |

---

## 改进 1: 代码安全模式警告

**状态:** ✅ 已实现（`plugins/dsh-code-security-guard`，待重启加载新代码）
**优先级:** P0
**复杂度:** 低（已交付 ~230 行）

### 概述

当 Agent 通过 `write_file` / `edit` 写入包含危险代码模式时，在工具返回结果中**追加一行安全警告**（非阻塞）。

### 为什么零风险

- 文件**照常写入**，不阻止任何操作
- 只是在返回给模型的文本末尾追加警告
- 模型在下一轮会话中看到这个提醒，可以自我修正
- 如果规则匹配出错，最坏情况是多一行无害的警告文本

### DSH 现有基础

- `dsh-command-guard` 已有 shell 命令风险检测
- 但只监控 shell/exec 类工具，不覆盖 write_file/edit
- 可复用其 ring buffer + JSONL 模式

### 实现路径（2026-09-10 实测修订）

**方案 B（已采用）：新建 dsh-code-security-guard 插件**

⚠️ **关键平台限制（实测发现）**：DSH 的 `session/event` 事件对 `@dsh-external/*` 插件**不可用**——sessions 服务的 `emitCtx` 分发链不包含 loader.create 创建的 fiber ctx（证据：dsh-command-guard v1 的 session/event 审计 3 次启动零告警；当前会话 zstd 会话文件实测 445 个 tool/call 事件存在但插件收不到）。

✅ **正确路径**：`dsh-tools` 工具执行流水线 `tools/pre-execute → tools/execute → tools/post-execute → tools/result`（对 @dsh-external 已验证可用——command-guard v2 的 tools/pre-execute 生产运行）。其中 **`tools/post-execute` 可返回 `{kind:'accept', content:[...]}` 在工具结果上追加警告**——正是 Hermes transform_tool_result 的 DSH 等价实现。

- 改进 1 用 `tools/post-execute`：exec.name ∈ {write, edit, patch}（实测 DSH 内核工具名，无 write_file）→ 检查 exec.arguments（解析后对象）→ 命中危险模式 → `accept + content 追加警告`
- 改进 2 用 `tools/pre-execute`（记录 start）+ `tools/post-execute`（配对耗时/结果）

### 检测规则（从 Hermes 精选）

| 模式 | 风险 | 语言 |
|------|------|------|
| `eval(` + 用户输入 | 远程代码执行 | JS/Python |
| `os.system(` / `subprocess.call(shell=True)` | 命令注入 | Python |
| `pickle.load` / `pickle.loads` | 反序列化攻击 | Python |
| `yaml.load(` (无 SafeLoader) | YAML 注入 | Python |
| `dangerouslySetInnerHTML` | XSS | React |
| `innerHTML =` | XSS | JS |
| `verify=False` | TLS 降级 | Python |
| `exec(` + 变量 | 远程代码执行 | Python/JS |
| `new Function(` + 变量 | 远程代码执行 | JS |

### Hermes 参考实现

```yaml
# security-guidance/plugin.yaml
name: security-guidance
version: "0.1.0"
description: "Append security warnings to file-write tool results..."
hooks:
  - transform_tool_result
  - pre_tool_call
```

### 验证方式

1. ✅ 创建测试文件包含 `eval(user_input)` — 冒烟测试 12/12 命中
2. ✅ 确认文件正常写入 — 插件为纯观察者，不触碰写入路径
3. ✅ 确认返回结果中包含安全警告 — 实现为 agent/pre-step 注入提醒（DSH 无 transform_tool_result，走 session-hygiene 同款注入路径）
4. ✅ 确认警告不影响后续对话 — 注入格式与 session-hygiene 一致（role:user + source notice），全部 try/catch 静默

### 实现记录（2026-09-10）

- 新建 `plugins/dsh-code-security-guard/`：`package.json` + `cordis.patch.yml` + `lib/index.js`
- 注册：`profile/desktop/package.json` 已加 `dependencies` link 行 + `dsh.profile.bundles` 项（模板 + 运行时均已同步，startup-verify V2 PASS）
- 内核实测：DSH 无 Hermes 的 `transform_tool_result`，但 `tools/post-execute` 的 `accept+content` 是等价实现；`session/event` 对 @dsh-external 不可用（详见上文平台限制）
- 验证证据：`node --check` OK；handler 冒烟 17/17 PASS（含危险命中+追加警告、去重、安全放行、非目标放行、审计配对、孤儿丢弃）；规则冒烟 12/12 命中 0/9 误报
- ⚠️ 平台热重载限制：`dev_reload_package` 依赖 `ctx.loader.internal`（当前桌面壳不可用），**代码修改需重启后由 loader 重新 import 生效**（junction 指向源目录，重启自动加载最新代码）

---

## 改进 2: 工具调用审计日志

**状态:** ✅ 已实现（`plugins/dsh-tool-audit`，待重启加载新代码）
**优先级:** P0
**复杂度:** 低（已交付 ~180 行）

### 概述

记录每次工具调用的元数据（工具名、参数摘要、耗时、成功/失败），写入 JSONL 审计日志。

### 为什么零风险

- 纯追加写入一个 JSONL 文件
- 不修改任何工具行为
- 失败即静默（catch → ignore）
- 有大小上限和轮转机制

### DSH 现有基础

- `dsh-command-guard` 已用 `tools/pre-execute` 拦截高危命令（已验证对 @dsh-external 可用）
- `dsh-session-hygiene` 已有 JSONL 审计日志写入模式
- 可复用这些基础设施

### 实现路径（2026-09-10 实测修订）

新建 `dsh-tool-audit` 插件，**不用 session/event**（对 @dsh-external 不可用，见改进 1 平台限制说明）：

1. `tools/pre-execute`：记录 {callId, name, args 摘要, startTs}
2. `tools/post-execute`：配对算 {durationMs, isError, resultSize} → 写 `~/.dsh/tool-audit/audit.jsonl`
3. 参数摘要 = {keys, chars}（不记录完整参数，隐私+体积）
4. 不注册工具、不注入内容，零模型上下文成本

### 记录内容

```json
{
  "ts": 1789033645223,
  "callId": "call_xxx",
  "tool": "write",
  "args": { "keys": ["file_path", "content"], "chars": 38 },
  "durationMs": 6,
  "isError": false,
  "resultSize": 10
}
```

### 提升点

- **问题排查:** 当 Agent 行为异常时，可以回溯工具调用历史
- **使用分析:** 哪些工具最常用、哪些经常失败
- **与 temp-tracker 配合:** 知道哪些文件是工具创建的

### 验证方式

1. 执行几次工具调用
2. 检查 `~/.dsh/tool-audit/audit.jsonl` 是否有记录
3. 确认记录内容完整
4. 确认不影响工具正常执行

---

## 改进 3: 临时文件追踪器

**状态:** ✅ 已实现（`plugins/dsh-temp-tracker`，已注入生效）
**优先级:** P0
**复杂度:** 低（已交付 ~190 行）

### 概述

通过 `tools/post-execute` 监听，记录 Agent 创建的临时文件路径到 JSONL，**只追踪不清理**。

### 为什么零风险

- 只写一个 JSONL 状态文件，不删除任何东西
- 不修改任何工具行为
- 用户可以随时查看追踪记录

### DSH 现有基础

- `dsh-session-hygiene` 已监控会话文件体积
- 但不追踪单个临时文件创建
- 可复用其文件系统扫描模式

### 实现路径（2026-09-10 实测修订）

新建 `dsh-temp-tracker` 插件（**不用 session/event**，对 @dsh-external 不可用，见改进 1 平台限制）：

1. `tools/post-execute`：检查 write/edit/patch 的 `exec.arguments.file_path` / `.path`
2. `guessCategory(path)`（纯函数，参考 Hermes disk-cleanup）：`test_`/`tmp_` 前缀、`.test.*` 后缀 → `test`；路径含 `cache` 目录段 → `temp`；猜不出类别不记录（避免噪音）
3. 同路径去重（已见 Map 上限 1000）→ 追加 `~/.dsh/temp-tracker/tracked.jsonl`（1MB 轮转）
4. 不注册工具、不注入内容、**绝不删除文件**

### 记录内容

```json
{
  "ts": "...",
  "path": "D:\\workspace\\test_output.py",
  "tool": "write_file",
  "sizeBytes": 1234,
  "category": "test"
}
```

### 提升点

- **为后续清理提供数据基础:** 用户可以查看哪些文件是临时创建的
- **与 session-hygiene 配合:** 提供更细粒度的卫生监控
- **问题排查:** 知道 Agent 创建了哪些文件

### Hermes 参考实现

```python
# disk-cleanup/__init__.py
def _on_post_tool_call(tool_name, args, result, ...):
    """Auto-track ephemeral files created by recent tool calls."""
    candidates = _extract_paths_from_write_file(args)
    for path_str in candidates:
        _attempt_track(path_str, ...)
```

### 验证方式

1. 执行 write_file 创建临时文件
2. 检查 `~/.dsh/temp-tracker/tracked.jsonl` 是否有记录
3. 确认记录内容完整
4. 确认不影响文件创建

---

## 改进 4: 系统健康仪表盘端点

**状态:** ✅ 已实现（`plugins/dsh-health-dashboard`，已注入生效）
**优先级:** P1
**复杂度:** 低（已交付 ~110 行）

### 概述

注册 `/health/dashboard` 聚合端点，汇总磁盘剩余 + 各监控插件的 JSONL 统计。

### 为什么零风险

- 纯只读查询，聚合已有数据
- 不修改任何现有端点
- 全部 best-effort，任一源失败 -> null

### DSH 现有基础

- `dsh-self-maintenance` 已有 `/self-maintenance/status`（statfsSync 磁盘检测 + registerRouteWithRetry 路由模式，本插件复用）
- `dsh-command-guard` 已有 `/command-guard/status`
- `dsh-session-hygiene` 已有 `/session-hygiene/status`

### 实现路径（2026-09-10 已落地）

新建 `dsh-health-dashboard` 插件（不改动现有插件，纯新增）：

1. `registerRouteWithRetry`（host-services shared-utils，与 self-maintenance 同款）注册 `/health/dashboard`
2. handler 聚合：磁盘 `statfsSync(~/.dsh)` + 各插件 JSONL 行数统计（command-guard / code-security-guard / tool-audit / temp-tracker；session-hygiene 默认 null 可配置）
3. 全部 best-effort：文件不存在/不可读 -> null

### 聚合内容（实测返回）

```json
{
  "plugin": "@dsh-external/dsh-health-dashboard",
  "ok": true,
  "generatedAt": "2026-09-10T11:09:23.880Z",
  "disk": { "freeGB": 30.2, "available": true },
  "plugins": {
    "commandGuard": { "alerts": null },
    "codeSecurityGuard": { "alerts": 1 },
    "toolAudit": { "records": 94 },
    "tempTracker": { "tracked": 1 },
    "sessionHygiene": { "events": null }
  }
}
```

### 提升点

- **统一监控视图:** 一个端点看全貌
- **便于未来做 dashboard UI 集成**
- 顺带暴露 command-guard v1 审计静默失效的事实（alerts 恒 null，见平台限制说明）

### 验证方式

1. ✅ 访问 `http://127.0.0.1:43120/health/dashboard` — 返回聚合 JSON
2. ✅ 确认各字段完整 — disk + 4 插件统计
3. ✅ startup-verify 9/10 PASS（42 bundles，V1/V2/V4 全过）

---

## 汇总（2026-09-10 全部完成）

| 改进 | 状态 | 实现插件 | 风险 | 实测验证 |
|------|------|---------|------|---------|
| 代码安全警告 | ✅ | `dsh-code-security-guard` | **零** | write 危险内容 → 结果追加警告 + alerts.jsonl |
| 工具调用审计 | ✅ | `dsh-tool-audit` | **零** | 94 条审计记录（tool/args/耗时/成败/结果大小） |
| 临时文件追踪 | ✅ | `dsh-temp-tracker` | **零** | test 文件 → tracked.jsonl（category/sizeBytes） |
| 健康仪表盘 | ✅ | `dsh-health-dashboard` | **零** | /health/dashboard 返回磁盘+4插件聚合 |

**共同特征**：纯新增插件（不改现有）、纯观察/只读、失败静默、可配置关闭、不触碰启动链路。

---

## 不建议做的改进（有风险）

| 改进 | 风险点 | 为什么不建议 |
|------|--------|-------------|
| 自动清理临时文件 | 可能误删 | 需要精确的分类规则，边界条件多 |
| 统一模型注册表 | 需重构现有插件 | 影响已有的 failover/tier-router 逻辑 |
| 成就系统 | 性能影响 | 扫描会话历史可能阻塞 |
| 多平台适配器 | 维护负担 | 不符合 DSH 桌面编码助手定位 |

---

## 实施建议

1. **按优先级实施:** 先做 P0（代码安全警告、工具审计、临时追踪），再做 P1（健康仪表盘）
2. **独立插件:** 每个改进做成独立插件，互不影响
3. **复用基础设施:** 利用已有的 ring buffer、JSONL 写入、路由注册模式
4. **渐进式:** 先实现最小可用版本，再逐步完善规则
5. **可配置:** 所有插件都支持 `enabled: false` 完全禁用
