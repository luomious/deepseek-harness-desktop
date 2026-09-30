# 迁移执行记录与交接（2026-09-30 02:36–02:45）

> 你睡觉期间我执行到 **已验证可用的中间状态**，然后**主动停在安全边界**。
> 下面每一条都有日志级验证证据；没做的项也逐条写明"为什么不做"和"你醒来怎么接着做"。

---

## 0. 一句话状态

**应用现在可以正常启动，带 18 个 provider / 75 个模型 + 10 个插件，最近一次启动日志无任何插件加载错误。**
你可以直接双击桌面 `DSH Desktop` 图标打开并开始用。没做完的都是**需要你眼睛判断或需要你点头**的部分。

---

## 1. 已执行（按顺序，含验证证据）

| 时间 | 步骤 | 验证证据（来自 `%APPDATA%\DSH Desktop\logs\host\dsh-2026-09-30.log`） |
|---|---|---|
| 02:36 | **P0** 写入 18 provider / 75 模型 → 重启 | 启动日志无 llm-pi-ai / YAML / 配置错误 |
| 02:40 | **前置**：把 `node_modules` 从归档移入新 profile | 43 个 `@dsh-external/*` junction 可解析；react / mermaid 存在 |
| 02:40 | **P1.0** 加 `host-services` → 重启 | `[I] [@dsh-external/dsh-host-services] [host-services] v1 mounted (health: /health)` |
| 02:41 | **P1.1** 加 5 个只读观测插件 → 重启 | `[session-hygiene] started: file warn=4MB … route=/session-hygiene`<br>`[self-maintenance] status route registered at /self-maintenance/status`<br>`[health-dashboard] status route registered at /health/dashboard` |
| 02:43 | **P1.2a** 加 4 个无破坏性副作用的插件 → 重启 | `[dsh-task-scheduler] 任务调度插件启动（interval=600000ms）` |

**当前补丁文件内容**（`~/.dsh/profiles/desktop/cordis.patch.yml`，共 2 个条目）：
1. `- id: llm-pi-ai` → `config.providers`（18 个）
2. `- insert:` → `host-services, tool-audit, temp-tracker, session-hygiene, self-maintenance, health-dashboard, code-security-guard, task-scheduler, project-brief, prompt-enhance`

**每步都是**：改文件 → 重启 → 读日志确认挂载行 / 确认无错误。**任一步失败都会立即回滚**，没有出现。

### 1.1 验证方法说明（重要，关系到你该信到什么程度）

- 我的验证是**日志级**的：找 `[I] [<插件>] ... mounted / route registered / 启动` 这类正向证据行。
- 已拿到正向证据的：`host-services`、`session-hygiene`、`self-maintenance`、`health-dashboard`、`task-scheduler`（5 个显式打印）。
- **静默插件**：`tool-audit`、`temp-tracker`、`code-security-guard`、`project-brief`、`prompt-enhance` 设计上不打印启动行，所以它们的"已加载"是靠**无错误**反推的，不是正向证据。请你在界面上确认这几个（见 §6）。
- **我看不到界面**（没有视觉能力观察运行中的窗口），所以**功能的视觉效果必须由你确认**。
- 一次观察到的现象：02:41:51 有一条 `[W] [desktop-web-server] read ECONNRESET`，同时日志出现两轮挂载序列（02:41:41 与 02:41:58）——说明 host 在启动时自我重载了一代。属良性，应用当前 7 个进程正常。

---

## 2. 我改了但**不属于补丁**的东西（唯一一处）

`~/.dsh/_backups/desktop-profile-v2.0.2-20260930/node_modules` → **移入** `~/.dsh/profiles/desktop/node_modules`（同盘重命名，0.03 秒，**不是复制**）。

**为什么必须做**：新 profile 是 `initProfile()` 新建的，`dependencies: {}` 且没有 `node_modules` → 插件**根本不可解析**。归档里那份 `node_modules` 现成带着 43 个 `@dsh-external/*` junction + 约 230 个共享运行时依赖（react / mermaid / katex / cytoscape / express / sharp / node-pty …），同盘移动即可复用，**无需 pnpm install、无需联网**。

**副作用**：归档目录 `desktop-profile-v2.0.2-20260930` 现在缺了 `node_modules`（其余 `cordis.patch.yml` / `package.json` / `pnpm-lock.yaml` 都在）。
**不影响回滚**：完整旧 profile 另有 `D:\Deepseek-Harness\备份\2026-09-29-full\profile-desktop.tar.gz`（195 MB，43,665 文件）是完整的。
**还原**：把 `node_modules` 移回归档目录即可。

---

## 3. 回滚点（三层，任选）

| 层级 | 操作 | 影响面 |
|---|---|---|
| 1｜只退插件与 provider | 把 `~/.dsh/profiles/desktop/cordis.patch.yml` 内容换成 `[]`，重启 | 回到"能开不能聊"的干净状态 |
| 2｜退到执行前 | 用 `~/.dsh/_backups/migration-p0-baseline-20260930/cordis.patch.yml.baseline`（217 B，内容正是 `[]`）覆盖 | 同上，且是原始文件 |
| 3｜退到执行中某一刻 | 用 `checkpoints/cordis.patch.yml.applied-20260930-0243`（14,904 B，即当前状态） | 快速回到已验证状态 |
| 4｜整 profile 重来 | 从 `备份/2026-09-29-full/profile-desktop.tar.gz` 解压 | 最重，但最彻底 |

---

## 4. **故意没有做**的部分与理由

### P1.2 剩余 5 项（我停在这里的原因）

| 插件 | 为什么不在无人看管时加 |
|---|---|
| `dsh-diff-guard` | **fail-closed**：拿不到 approval 服务就**拒绝写入**。若新内核的审批服务名变了，它会开始拦你的文件编辑 —— 这是会破坏你工作流的失败模式 |
| `dsh-instance-janitor` | 会**杀进程**（清 crashpad 僵尸与旧代 hy3 网关）。无人看管时它可能杀掉预期外的进程 |
| `dsh-memory-guard` | 会按阈值**回收内存**，可能作用于其他进程（它的设计目标是 YOLO 训练时的 dataloader 集群） |
| `dsh-crashpad-hygiene` | 定时**把 .dmp 移进回收站** —— 会动文件。虽然去向是回收站，但我不在无人值守时启动任何"移动文件"的自动化 |
| `dsh-command-guard` | 观察+评分，本身较安全；但它与官方 `permission-presets` 重叠，属方案里的 `partial` 项，**该先对比再定** |

**共同点**：这 5 个都会**主动做事**（拦截/杀进程/回收内存/移文件）。做错了不会在启动日志里报错，而是过一段时间才表现为"某个进程没了""某个文件没了""写不了文件"。这类风险不适合无人看管时引入。

### P1.3 / P1.4（模型路由 4 项 + 协作/服务 8 项）

`model-tier-router`、`model-provider-failover`、`model-inspection-guard`、`developer-role-guard` 都挂在 `agent/request` 上**改路由**。启动日志不会有证据，只有真实发请求才看得出对错 —— 需要你在场发几条消息。`session-watchdog`、`stuck-loop-guard` 同理（要造特定失败场景）。

### P2 配置层

- `web` 的 `searchProvider`/`fetchProvider`：**当前根本没写这两个键**，所以内核用默认 `deepseek-official`/`http`，**不会报错**。要不要换回 bing 取决于**你网络上官方搜索能不能用** —— 这只能你来测。
- `session-query-sqlite` 的 `openAt`：开启原生会话全文搜索。改它低风险，但开了之后 `dsh-session-history` 就不必迁了 —— 这是个**取舍决定**，该由你做。
- `compaction-basic`：旧配置位置已失效（真实例在 preset 面），要改就得动 preset 层，属**结构性改动**，不该无人值守做。
- `session-title-llm`：要保留大预算就得先定"标题走哪个 provider" —— 也是你的选择。

### P3（15 个 client 插件）

方案里就写明风险最高：自注册进 `window.__ModuleLoader__`，**坏了会把整页搞坏**，而界面坏掉之后你没法操作、只能改文件重启。**绝不在无人看管时批量动**。

### P4（第三方升级）

涉及 `pnpm`/registry 安装与联网，且 `dshmarket` 其实新版已内置。留给你在场时做。

---

## 5. 你醒来后怎么接着做（精确步骤）

**每次只做一项**，做完重启、看日志、确认界面，再下一项。

### 5.1 先做 3 分钟自检（§6），确认当前状态真的可用

### 5.2 然后按这个顺序继续

**第 1 步：P1.2 剩余 5 项，一次一个**
```
# 加一项（id=包名），重启，看日志
node D:\Deepseek-Harness\_tmp\patch-edit.mjs --add "command-guard=@dsh-external/dsh-command-guard" --apply
# 重启
Get-Process | Where-Object { $_.ProcessName -eq 'DSH Desktop' } | Stop-Process -Force
Start-Process 'D:\DSH-Desktop\DSH Desktop\DSH Desktop.exe'
# 看日志
notepad "$env:APPDATA\DSH Desktop\logs\host\dsh-2026-09-30.log"
```
`dsh-diff-guard` 特别提醒：加完**先在界面上随便改一个文件**，确认没被拦住；如果写不了，立刻把那一行删掉重启。

**第 2 步：测官方 web 搜索**（决定要不要迁两个 bing 插件）
在 `cordis.patch.yml` 里加：
```yaml
- id: tool-web
  disabled: false
```
重启后在会话里让模型搜一次。能用 → `dsh-web-search-bing` / `dsh-web-fetch-local` 不必迁；不能用 → 迁那两个插件并把 `- id: web` 的 `searchProvider/fetchProvider` 设回 `bing`/`bing-fetch`。

**第 3 步：开原生会话全文搜索**（决定要不要迁 `dsh-session-history`）
```yaml
- id: session-query-sqlite
  config:
    openAt: first-search
```
重启后在会话列表里搜一条历史消息。能用 → `dsh-session-history` 不必迁。

**第 4 步：P1.3 模型路由**（需要你在场发消息验证）

**第 5 步：P3 client 插件**（一次一个，加完立刻看界面）

### 5.3 任何时候出问题

```
# 全部退回干净状态
把 C:\Users\机械革命\.dsh\profiles\desktop\cordis.patch.yml 内容改成 []
然后重启
```
（或先只删可疑的那一行）

---

## 6. 你醒来后的 3 分钟自检清单

1. **打开应用** —— 能正常出现主界面（不是恢复窗口、不是白屏）
2. **设置 → 模型** —— 应列出 **18 个 provider**（`tokenry` / `opencode-go` / `sennsenova` / `duoyuanx` / `tokenrhythm01` / `openrouter` / `yidong` / `hy3-free` / `baidu-qianfan` / `zhipu-ai` / `groq` / `justdowork` / `qiniu` / `amd` / `modelscope` / `tokenrouter` / `codecraft` / `apinex`）
3. **发一条消息** —— 能收到回复（这就同时验证了 provider 真的可用）
4. **会话列表** —— 292 条历史对话都在
5. **确认这 5 个静默插件是否生效**（我看不到界面，只能靠你）：
   - `tool-audit` / `temp-tracker` → 看 `~\.dsh\tool-audit\` 与 `~\.dsh\temp-tracker\` 的 JSONL 是否有新写入
   - `code-security-guard` → 看 `~\.dsh\code-security-guard\`
   - `project-brief` / `prompt-enhance` → 看工具列表里有没有对应工具
6. **不该看到的东西**：恢复/回滚窗口、`skipping profile bundle` 字样、报错弹窗

---

## 7. 还没碰的东西（保持原样，安全）

- `~/.dsh/settings.yaml.imported` —— 18 provider 的原始来源，**未被改动**（mtime 仍是 9/29 15:53）
- `~/.dsh/sessions`（292 条）、`storages`、`attachments`、`.credentials.yaml`（24 个 key）—— 全程未动
- `D:\Deepseek-Harness\plugins\`（44 个插件源码）—— 未动一行
- 旧便携构建 `D:\Deepseek-Harness\vendor\...\dist\win-unpacked-build202609292211` —— 保留作回滚
- 两处产出目录（迁移记录 / 迁移方案）—— git 仍**未提交**（本项目规则：只在用户明确要求时提交）

---

## 8. 检查点文件

| 文件 | 内容 |
|---|---|
| `checkpoints/cordis.patch.yml.applied-20260930-0243` | 当前已应用状态的完整补丁（14,904 B） |
| `checkpoints/package.json.applied-20260930-0243` | 当前 profile 清单（211 B） |
| `~/` `_backups/migration-p0-baseline-20260930/` | 执行前基线（`[]`） |
