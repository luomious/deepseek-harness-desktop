# Profile 加固归档交接（2026-09-02）

> 用途：本轮「Profile 完整性加固」的完整归档记录，供会话归档后任何 agent / 用户接力。
> 配套可运行手册：`docs/PROFILE-MAINTENANCE.md`（结构 / 巡检 / 删除协议 / 回滚 / SOP）。
> 触发事故：2026-08-31 归档 dsh-tool-visibility 只改源码模板、漏运行态引用 → 重启报
> `cannot resolve package "@dsh-external/dsh-tool-visibility"` → 进恢复页。

## 一、根因与修复链路

| 阶段 | 交付 | 作用 |
|---|---|---|
| 0 根因修复 | `apply-profile-guard.mjs` 补丁（关闭/退出「配置自检」弹窗）+ 插件删除协议条款 | 关闭时即可发现"删插件没注销"残留，杜绝重启打不开 |
| 0 回归 | `tests/plugins/profile-guard.test.mjs`（12 项）+ `startup-verify --repair` | 锁定注入语义与修复安全（不再误删核心 bundle） |
| 1 巡检防退化 | `scan-dangling.mjs`（DANGLING/STALE-DECL/ORPHAN… + `--plan` 只读预演）；`check-all` Step 1.6；`dsh-maintenance` 第 6 段 | 发现问题自动化：任何 profile 改动自动复检 |
| 2 定位定案 | web profile 调研 → **保留**（装配依赖源，不可删），写入 AGENTS.md「Profile 定位」 | 消除"是不是死代码"的长期疑问 |
| 3 删除工具化 | `deregister-plugin.mjs`（预检只读默认 + `--yes`：备份/回收站/自动验证）；测试 5 项 | 删插件同步 3 处引用半自动，杜绝人肉漏项 |
| 4 文档沉淀 | `docs/PROFILE-MAINTENANCE.md` + 索引/AGENTS 引用 | 新 agent 只看文档即可独立维护 |

## 二、工具链速查（全部实测全绿）

| 工具 | 命令 | 状态 |
|---|---|---|
| startup-verify | `node scripts/startup-verify.mjs` | 10/10 PASS |
| scan-dangling | `node scripts/scan-dangling.mjs --strict` / `--plan` | 0 发现 |
| verify-patches | `powershell -File scripts\verify-patches.ps1` | 23 ALL PASS |
| check-all | `powershell -File scripts\check-all.ps1 -SkipSmoke -SkipTests` | ALL PASS（Step 1.6 含 scan-dangling） |
| deregister-plugin | `node scripts/deregister-plugin.mjs --plugin <name> [--yes]` | 预检只读 + 执行 + 自动验证 |
| 回归测试 | `node --test tests/plugins/scan-dangling.test.mjs tests/plugins/deregister-plugin.test.mjs tests/plugins/profile-guard.test.mjs` | 11+12 全过 |

## 三、本轮已清理/归档

- web profile：3 个孤儿 junction 回收站删除；maid-atelier 失效 `file:` 声明移除（保留副本+bundle）。
- `_backups/` 收拢：tool-visibility 事故备份 + 5 个历史 `package.json.bak-*` 移入 `~/.dsh/_backups/`。
- `~/.dsh/profiles/desktop` 下 `.bak*` 残留归零；活跃 profile 未动。

## 四、验证基线（重启后实测）

- `startup-verify` 10/10；`scan-dangling --strict` 0 发现；`verify-patches` 23 全绿；`check-all` ALL PASS；
- 健康历史（health-check SLO）：10 次启动 100% 成功；
- profile-guard 关闭自检已随重启生效（运行进程为补丁后代码）。

## 五、收尾清理与后续建议

### 2026-09-02 收尾：多余文件整理 + 大会话归档（已完成）
- **大会话归档**：`archive-big-sessions.ps1 -Execute` 归档 3 个 >8MB 闲置会话（27.7MB，session-696d9c45 / session-34b88ace / session-49ca9d5e）→ `_backups/archived-sessions-20260901-193016/`（manifest.txt 可回滚）。
- **多余文件清理**：删除 `tests/plugins/` 测试残留 `.tmpdir`、`spawn-trace.log`、`~/.dsh/_backups` 中被 deregister 测试污染的 8 个副产物；保留 7 个真实备份。
- **备份隔离修复**：`deregister-plugin` 支持 `DSH_BACKUPS_DIR`（测试指向临时目录），防测试污染真实 `_backups`（before=0 / after=0 验证通过）。

### 后续建议（剩余）
1. `scan-dangling` / `deregister-plugin` 可接入 CI 或定期巡检（当前已入 check-all Step 1.6）。
2. web profile 若未来彻底退役（desktop 装配不再依赖其 tgz），再评估整体归档。
3. 若再遇大会话累积（>8MB 且闲置>24h），按 `docs/PROFILE-MAINTENANCE.md` §6 SOP 第 7 条归档。
