# DSH 升级计划 · 会话归档交接文档

> 归档日期：2026-08-31
> 会话范围：WorkBuddy 学习 → DSH 全面升级方案（v1→v3）→ 分阶段执行（阶段 0-2、3a、6）
> 主文档：`E:\WorkBuddy\learn\DSH全面升级方案书v3-最终版.md`（方案）、`E:\WorkBuddy\learn\UPGRADE-EXECUTION-LOG.md`（执行记录，D 盘副本 `D:\Deepseek-Harness\docs\UPGRADE-EXECUTION-LOG.md`）

---

## 1. 会话产出总览

### 文档
| 文件 | 内容 |
|------|------|
| `E:\WorkBuddy\learn\WorkBuddy完整技术分析.md` | CodeBuddy 逆向：537 i18n、169 服务、TC3 签名、流式解析、27 项借鉴清单 |
| `E:\WorkBuddy\learn\DSH全面升级方案书v3-最终版.md` | 最终方案：开发性能三角（技能/连接器/工具调用）+ 稳定性 + 治理 + 五维评估 |
| `E:\WorkBuddy\learn\UPGRADE-EXECUTION-LOG.md` | 执行日志（阶段 0/1/2/3a/6 + 全部故障排查记录） |
| `E:\WorkBuddy\learn\workbuddy-i18n.json` | WorkBuddy 537 条 UI 文案（功能地图） |
| 本文档 | 会话归档交接 |

### 已交付能力
| 交付 | 位置 | 状态 |
|------|------|------|
| 启动预检 10 项 | `scripts/startup-verify.mjs`（V1-V10） | ✅ 接入 check-all Step 1.5 |
| 自愈单测 | `tests/plugins/startup-verify.test.mjs`（6 用例） | ✅ PASS |
| zstd 异步化（Option A） | `patches/bundles/dsh-session-persistence-jsonl-index.js` + `port-user-patches.mjs` ZSTD_MODULE | ✅ 重启验证无报错 |
| 工具流式可见性 | `plugins/dsh-tool-visibility/`（监听+环形缓冲+路由+JSONL） | ✅ 重启验证通过（关联修复：source.callId + turn/step + FIFO） |
| 命令风险评分库 | `plugins/dsh-command-guard/lib/risk-rules.mjs` + `tests/plugins/command-guard-risk.test.mjs`（12 用例） | ✅ 单测 PASS（插件装配受限见 §3） |
| SLO 健康看板 | `scripts/health-check.mjs` + `~/.dsh/.health/startup-history.jsonl` | ✅ 接入 check-all Step 1.5 自动记录 |

### 验证基线
- `check-all.ps1`：**ALL PASS**（Step 1 语法 + Step 1.5 health-check + Step 2 verify-patches 22 项）
- `startup-verify.mjs`：**10/10 PASS**
- 单测：startup-verify 6/6 + command-guard risk 12/12

---

## 2. 关键教训（后续开发必读）

1. **打包壳插件装配两套机制**：`desktopPlugins` 清单层（bundleId）≠ `cordis include loader` fiber 层。**新插件装配验证必须以 `dev_plugin_status`（loader entries 有 fiber）为准**，不能只看清单或文件级检查。command-guard 卡在此（清单 active、无 fiber、apply 不执行）——机制层限制，非代码缺陷。
2. **惰性依赖前先 inject 基础服务**：路由退避用 `ctx.setTimeout` 必须 `inject=['timer']`；`inject=[]` 时首次注册失败永不重试 → 永久 404。
3. **插件可靠形态**：单文件（无相对导入）+ bundles-only（patch 纯注释）+ inject timer——与 tool-visibility 一致（已验证）。
4. **热装/卸载多次操作会搅乱运行态**：验证 bundles 装配必须干净重启。
5. **PS 5.1 编码坑**：含中文 .mjs/.yml 勿用 PowerShell `Set-Content -Encoding UTF8` 写（会破坏文件）；用 write 工具或 Node。
6. **原子写纪律**（AGENTS.md 2026-08-29 事故印证）：运行路径文件必须临时副本→校验→原子替换。

---

## 3. 待办清单（后续会话可续）

### A. 立即项
| # | 项 | 说明 |
|---|----|------|
| A1 | **command-guard 装配残留清理** | ✅ **2026-08-31 完成**（执行日志「阶段 3a 收尾」段）：运行态+模板移除 bundles/dependencies 条目、删 junction；**插件目录 + 单测保留**（risk-rules 库可复用）；startup-verify 10/10 |
| A2 | tool-visibility/command-guard 的 cordis.patch.yml 坏文件（GBK 乱码）复核 | ✅ **2026-08-31 完成**：tool-visibility 重写为纯注释统一形态（去 insert）；command-guard 已是纯注释 |

### B. 后续阶段（方案书 v3）
| 阶段 | 内容 | 前置 |
|------|------|------|
| 3b | 技能状态卡 / 导入文件夹（增强 dsh-skills-manager，注意该插件并行会话维护，需加锁） | 需重启验证 |
| 3c | 连接器市场 / MCP roots 授权 | 需装配（先解决 A1 装配机制问题） |
| 4 | 集成面板（client bundle） | 需 client 装配路径 |
| 5 | P3 shell 渲染器 ×20 / Mention / 主题 | 高风险单独排期，需完整备份+回归 |
| 6 增强 | health-check 接定时巡检（self-maintenance 同款 timer）/ 告警通知 / 看板 UI | 需装配 |

### C. 遗留验证
| # | 项 | 状态 |
|---|----|------|
| C1 | zstd 大会话（11.4MB 实测文件）打开流畅性 | 重启后无报错，用户体验待确认 |
| C2 | command-guard 若未来接入：approval.request 拦截（v2） | ApprovalService.request 需 open turn + fail-closed，接入点已摸清 |

---

## 4. 验证命令速查

```bash
# 一键巡检（含 SLO 记录）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-all.ps1

# 装配预检单独跑
node scripts/startup-verify.mjs

# SLO 健康看板
node scripts/health-check.mjs            # 运行+记录+报告
node scripts/health-check.mjs --summary  # 仅汇总

# 工具调用可见性（tool-visibility）
curl http://127.0.0.1:43120/tool-visibility/status
curl http://127.0.0.1:43120/tool-visibility/recent

# 单测
node --test tests/plugins/startup-verify.test.mjs
node --test tests/plugins/command-guard-risk.test.mjs

# 回滚（zstd）
# 恢复 _backups/zstd-async-20260828/index.js.orig 到 dev + 构建两处副本
```

---

## 5. 备份与回滚
- zstd 补丁备份：`_backups/zstd-async-20260828/index.js.orig`（补丁经 port-user-patches ZSTD_MODULE 登记，重建可重打）
- 全部改动已登记 task-scheduler 时间线（dsh-upgrade-plan: stage0/1/2/3a/6）
- 执行日志 D 盘副本：`D:\Deepseek-Harness\docs\UPGRADE-EXECUTION-LOG.md`
