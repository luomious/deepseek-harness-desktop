# 事故报告：2026-09-07 DSH 启动失败（15:26–16:10）

- 级别：P1（应用无法启动）· 状态：**已修复并闭环** · 影响数据：无任何丢失
- 关联：SELF-2（safe-delete-shim）、PROC-5（端口预检）、阶段 1 门禁验证

## 时间线（本地时间）

| 时间 | 事件 | 结果 |
|---|---|---|
| 14:13 | batch3 部署 disable-auto-update（updates.js）+ stale-lock-60s | — |
| 14:40 | **用户正常启动 DSH → 完整成功**（日志可证：全部插件启动、session-hygiene 新阈值生效） | ✅ |
| ~15:00 | 用户关闭 DSH（留下 `plugin-install-recovery\state.json.lock`） | — |
| 15:08 | 部署 port-preflight + quit-lock-cleanup（main.js） | — |
| 15:26–15:41 | 助手启动测试 ×2 → **install-recovery 阶段失败**（EQ_DELETE 抛错） | ❌ |
| 15:47 | **修复①**：shim 加瞬态旁路（SELF-2b），install-recovery 通过 | ✅ |
| 15:50–16:10 | 启动测试 ×4 → **renderer-startup 阶段失败**（renderer 被 killed, exitCode 1） | ❌ |
| 16:03 | 二分：临时摘除 15:08 两补丁 → 仍失败 → **排除 main.js 补丁** | 证据 |
| 16:15 | `--no-sandbox --no-proxy-server` 启动 → **完整成功**（startup.run.completed） | 突破 |
| 16:20 | 单变量确认：仅 `--no-sandbox` → 完整成功；winreg 查证系统代理含 `127.*` 绕过 | 定案 |

## 根因（两个独立问题，先后叠加）

### 根因 1（真实回归，已修复）：SELF-2 shim 拦截链误伤瞬态锁文件
- 链路：启动 → install-recovery 阶段 rimraf `plugin-install-recovery\state.json.lock`
  （应用自身持有句柄）→ shim 把删除劫持到"回收站→隔离"→ 两路均失败
  → 抛 EQ_DELETE → rimraf 失败 → 恢复窗口 ERR_FAILED → `startup.run.failed` 退出。
- 上一次成功运行（14:40）未触发是因为当时该锁文件不存在（上一会话正常退出）。
- **修复（SELF-2b，patches/bundles/safe-delete-shim.cjs）**：
  1. **瞬态旁路**：`*.lock` / `*.tmp` / `*.tmp-*` 直接走原始 fs 删除（stock 语义，不进回收站/隔离）；
  2. **竞态委托**：回收站失败且隔离时目标已消失 → 委托回原始 fs 调用
     （ENOENT 为 stock 语义，Node rimraf 将 ENOENT 视为成功），不再抛 EQ_DELETE。
- 用户数据保护不变：非瞬态文件仍是"回收站 → `_quarantine` 隔离 → 抛错"，绝不静默硬删。
- 验证：`tests/plugins/safe-delete-shim.test.mjs` **9/9 PASS**（新增测试文件）；
  修复后 install-recovery 阶段稳定通过。

### 根因 2（测试环境假象，非 DSH 问题）：Job 嵌套导致 Chromium 沙箱 renderer 被杀
- 助手所有启动测试均从 WorkBuddy 会话内发起 → 子进程被关进 WorkBuddy 的 Job 对象
  （`CREATE_BREAKAWAY_FROM_JOB` 实测 PermissionError = 该 Job 禁止脱离）。
- Chromium 沙箱 renderer 初始化需要脱离父 Job → 无法脱离 → renderer 被"killed"(exitCode 1)，
  健康上报超时 → host 判定 renderer boot failed → 连带恢复窗口 ERR_FAILED。
- 证据链：①用户 14:40 双击启动完整成功（同版本 dist）；②仅 `--no-sandbox` 即完整成功；
  ③winreg 确认系统代理 ProxyOverride 含 `127.*`/`<local>`（排除代理拦截）；
  ④剥离代理环境变量仍失败（排除环境变量）。
- **结论：用户正常双击启动不受任何影响；DSH 程序与数据零损坏。**

## 排除项（均已实证，防止未来误判）
- 15:08 的 port-preflight / quit-lock-cleanup 补丁 → 二分摘除后仍失败，排除；已从备份恢复。
- disable-auto-update（updates.js）→ 14:40 成功运行时已存在，排除。
- 代理（系统代理 / HTTP_PROXY 环境变量）→ 系统代理有 loopback 绕过；剥离 env 后仍失败，排除。
- dist client.js（9/3 的两个）→ mtime 早于成功运行，排除。

## 修复产物与回滚
| 项 | 路径 |
|---|---|
| 修复后 shim 源 | `patches/bundles/safe-delete-shim.cjs`（SELF-2b 标记，12 处） |
| 部署副本 | dist `app.asar.unpacked/lib/safe-delete-shim.cjs`（运行时实际加载件） |
| 回归测试 | `tests/plugins/safe-delete-shim.test.mjs`（9/9） |
| 备份（修复前） | `_backups/fix-20260907-shimfix-154357/`（含 shim 源、unpacked/asar 副本、main.js.before-bisect） |
| asar 内旧副本 | 未重打包（被 unpacked 影子遮蔽，不生效；下次重建自然更新） |

## 防复发
1. **SELF-2b**（已完成）：瞬态文件旁路 + 竞态委托，永久消除"锁文件删除失败→启动失败"路径。
2. **ENV-1 启动环境约定（文档化）**：DSH 不得从"无 breakaway 权限的 Job 嵌套环境"
   （如 agent 工具会话）启动——renderer 沙箱会被杀；以后助手测试一律用
   `--no-sandbox` 探测启动或请用户双击验证。已写入计划文档 1.1 节。
3. 回归测试纳入 tests/（node --test 可重复执行），重建后必跑。

## 教训
- 部署到启动链路的补丁，必须在"有残留锁"的 dirty 状态下做过启动测试（本次 14:40 的
  clean 状态掩盖了 SELF-2 对 dirty 状态的破坏）。
- 测试环境本身可能成为故障源：先问"启动方式与用户一致吗"，再怀疑代码。
