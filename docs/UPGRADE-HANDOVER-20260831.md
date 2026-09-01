# DSH 升级计划 · 会话归档交接文档

> 归档日期：2026-08-31 → 2026-09-02（最终归档）
> 会话范围：WorkBuddy 学习 → DSH 全面升级方案（v1→v3）→ 分阶段执行（阶段 0-2、3a、3b、6）+ A/B 组收尾 + command-guard v2 + prompt-enhance 工具化 + 阶段 A 已有功能审计 + 官方 v2.0.4 评估
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
| `docs/EXISTING-FEATURES-AUDIT.md` | **阶段 A 已有功能审计**：27 项借鉴清单中 5 项已内置可跳过、5 项真缺失、1 项 slot 待实现 |
| `docs/CLIENT-ASSEMBLY-FEASIBILITY.md` | **B 专项 client 装配可行性报告**：路径已打通、tool.call.toolview slot 存在 |
| `docs/plugin-contracts.md` | **契约文档 v1**：工具事件✅/连接器草案/技能部分/插件服务✅ |
| 本文档 | 会话归档交接 |

### 已交付能力
| 交付 | 位置 | 状态 |
|------|------|------|
| 启动预检 10 项 | `scripts/startup-verify.mjs`（V1-V10） | ✅ 接入 check-all Step 1.5 |
| 自愈单测 | `tests/plugins/startup-verify.test.mjs`（6 用例） | ✅ PASS |
| zstd 异步化（Option A） | `patches/bundles/dsh-session-persistence-jsonl-index.js` + `port-user-patches.mjs` ZSTD_MODULE | ✅ 重启验证无报错 |
| 工具流式可见性 | `plugins/dsh-tool-visibility/`（监听+环形缓冲+路由+JSONL） | ✅ 重启验证通过（关联修复：source.callId + turn/step + FIFO） |
| 工具调用可见面板（client 展示） | `plugins/dsh-tool-visibility/lib/client.js`（设置页 settings.section「工具调用可见性」，2s 轮询 /recent） | ✅ 2026-08-31 晚落地，重启验证 client bundle 服务 200 |
| 命令风险检测（3a 翻案） | `plugins/dsh-command-guard/`（insert + 单文件 + inject timer） | ✅ **终验通过**：fiber [active]、/command-guard/status 200、risk-rules 12 单测 PASS |
| 命令风险 v2（approval 拦截） | `plugins/dsh-command-guard/lib/index.js`（`tools/pre-execute` waterfall） | ✅ **生效**：fiber active、fail-closed |
| 提示词增强（#1） | `plugins/dsh-prompt-enhance/`（`prompt_enhance` 工具，agent 自动调用） | ✅ **2026-09-02 工具化**：删设置面板，注册 `prompt_enhance` agent 工具（inject:['tools']） |
| SLO 健康看板 | `scripts/health-check.mjs` + `~/.dsh/.health/startup-history.jsonl` | ✅ 接入 check-all Step 1.5 自动记录 |
| SLO 定时巡检（脚本） | `scripts/health-task-run.ps1` + `install-health-task.ps1` | ✅ 脚本就位，注册计划任务可选（需管理员） |
| 契约文档 v1 | `docs/plugin-contracts.md`（工具事件✅/连接器草案/技能部分/插件服务✅） | ✅ 2026-08-31 |
| 技能导入文件夹（3b） | `plugins/dsh-skills-manager/`（importFolder API + 用户 tab 导入 UI） | ✅ 2026-08-31 实测导入成功（echo-greet 验证后清理）；跨平台 node:fs 实现 |

### 验证基线
- `check-all.ps1`：**ALL PASS**（Step 1 语法 + Step 1.5 health-check + Step 2 verify-patches 22 项）
- `startup-verify.mjs`：**10/10 PASS**
- 单测：startup-verify 6/6 + command-guard risk 12/12

---

## 2. 关键教训（后续开发必读）

1. **打包壳插件装配：`cordis.patch.yml` 的 `- insert:` 块是 fiber 装配入口**；`desktopPlugins` bundles 清单只是清单层（清单 active ≠ loader 已装配）。**新插件装配验证必须以 `dev_plugin_status`（loader entries 有 fiber）为准**，不能只看清单或文件级检查。command-guard 早期失败为相对导入/inject 缺失所致，后期改纯注释后必然失败（无 insert = 无装配入口）；2026-08-31 晚已实证并修正（见执行日志「阶段 3a 收尾修正」段）。
2. **惰性依赖前先 inject 基础服务**：路由退避用 `ctx.setTimeout` 必须 `inject=['timer']`；`inject=[]` 时首次注册失败永不重试 → 永久 404。
3. **插件可靠形态**：cordis.patch.yml 含 `- insert:`（装配入口）+ 单文件（无相对导入）+ `inject: ['timer']`——与 tool-visibility 等 19 个工作插件一致（2026-08-31 晚实证）。
4. **热装/卸载多次操作会搅乱运行态**：验证 bundles 装配必须干净重启。
5. **PS 5.1 编码坑**：含中文 .mjs/.yml 勿用 PowerShell `Set-Content -Encoding UTF8` 写（会破坏文件）；用 write 工具或 Node。
6. **原子写纪律**（AGENTS.md 2026-08-29 事故印证）：运行路径文件必须临时副本→校验→原子替换。
7. **Windows 平台 `ctx.shell` 后端 = pwsh**（dsh-pwsh-local，`pwsh -Command` 直通，无 POSIX 翻译）：`find`/`printf`/`cat` 不可用；`mkdir -p`/`rm -rf` 恰好被 PowerShell 别名层容忍。**插件内文件遍历/读取优先 node:fs**（跨平台），POSIX 命令仅限 Linux 环境（2026-08-31 importFolder 实证，见执行日志 3b 修复记录）。
8. **开发新插件前先确认 DSH 内核是否已有等价功能**：dev_plugin_status（现有 loader entries）+ UI 全景扫描——避免重复造轮子（2026-09-01 dsh-context-usage 回滚事件）。

---

## 3. 待办清单（后续会话可续）

### A. 立即项
| # | 项 | 说明 |
|---|----|------|
| A1 | **command-guard 装配残留清理** | ✅ **2026-08-31 完成**（执行日志「阶段 3a 收尾」段）：运行态+模板移除 bundles/dependencies 条目、删 junction；**插件目录 + 单测保留**（risk-rules 库可复用）；startup-verify 10/10 |
| A2 | tool-visibility/command-guard 的 cordis.patch.yml 复核 | ✅ **2026-08-31 完成（含回归修正）**：曾误判 GBK 乱码并改为纯注释 → 重启后 tool-visibility 无 fiber/路由 404 → 取证确认 **insert 块是装配入口** → 已恢复 insert（干净 UTF-8 + insert），详见执行日志「阶段 3a 收尾修正」 |

### B. 后续阶段（方案书 v3）
| 阶段 | 内容 | 前置 |
|------|------|------|
| 3b | 技能状态卡 / 导入文件夹 | ✅ **第一版 2026-08-31 完成**：importFolder API + 用户 tab 导入 UI（实测导入成功）；技能状态卡基础（徽章/启停）已有。第二版可加：原生目录选择器、导入后自动启用 |
| 3c | 连接器市场 / MCP roots 授权 | 让位：官方上游 0.1.2-alpha.1 已含 mcp-client 等，等官方 stable 迁移获得，不重复造轮子 |
| 4 | 集成面板（client bundle） | ✅ 路径已打通（B 专项：dsh.client + slots，tool-visibility 面板为范例）；面板功能按需增量 |
| 5 | P3 shell 渲染器 ×20 / Mention / 主题 | 渲染器可走 `tool.call.toolview` keyed 卡（无需改 shell）；Mention 待验证输入框 slot；主题维持搁置 |
| 6 增强 | health-check 定时巡检（✅ 2026-08-31 脚本就位：`health-task-run.ps1` + `install-health-task.ps1`，注册计划任务可选）/ 告警通知 / 看板 UI | 告警/看板需装配 |

### C. 遗留验证
| # | 项 | 状态 |
|---|----|------|
| C1 | zstd 大会话（11.4MB 实测文件）打开流畅性 | 重启后无报错，用户体验待确认 |
| C2 | command-guard approval 拦截（v2） | ✅ **生效**：`tools/pre-execute` waterfall + fail-closed，fiber active |

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

# 健康巡检 runner（手动跑一次，追加 SLO 记录 + 更新提醒）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\health-task-run.ps1
# 注册每日自动巡检（09:05，需管理员权限，可选）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-health-task.ps1

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

---

## 6. 最终状态（2026-09-02 最终归档）

### 方案书 v3 执行总结

| 分类 | 状态 | 说明 |
|------|------|------|
| P0 稳定性五件套 | ✅ 全部完成 | startup-verify 10/10、verify-features 50 全绿、SLO 3/3 |
| P2-A-0 工具流式可见性 | ✅ host + client 面板均完成 | host 监听+路由+JSONL；设置页面板 2s 轮询 |
| P2-A-5 命令风险检测 | ✅ v1 审计 + v2 approval 拦截 | fiber active、fail-closed |
| 3b 技能导入文件夹 | ✅ 实测成功 | importFolder API + 跨平台 node:fs |
| #1 提示词增强 | ✅ 工具化 | `prompt_enhance` agent 工具，自动判断调用；已删设置面板 |
| SLO 看板 + 巡检脚本 | ✅ 就位 | 注册计划任务可选 |
| 契约文档 + 可行性报告 + 功能审计 | ✅ 入库 | 插件服务契约 / client 装配路径 / 阶段 A 审计 |
| 官方 v2.0.4 评估 | ⏸️ 暂缓 | 触发条件 0/5（alpha 未脱离）；机制已沉淀 |
| #6 上下文用量 | ❌ 回滚 | 功能已内置（轨迹栏旁），插件冗余+报错，已清理 |

### 阶段 A 已有功能审计结论（避免重复造轮子）

**5 项已内置可跳过**：#6 上下文用量、#7 消息折叠、#8 错误横幅、#12 @mention、#15 主题系统
**1 项 slot 已有待实现**：#11 工具专用渲染器（`tool.call.toolview`）
**5 项真缺失**：#1 增强提示词（✅ 已做）、#3 记忆系统、#9 插件范围、#10 Subagent watcher、#16 Mermaid/LaTeX

### 剩余计划（后续会话可续，全部可选）

> 阶段 1 已于 2026-09-02 落地（`plugins/dsh-tool-renderers/`，覆盖 goal/jobs/subagent 8 个 key；
> 详见 CHANGELOG + UPGRADE-EXECUTION-LOG「阶段 1」段）；**待重启终验**。

| 阶段 | 内容 | 风险 | 说明 |
|---|---|---|---|
| 阶段 1 | #11 工具渲染器 keyed 卡（P1，唯一剩余） | 中 | ✅ **已落地待重启终验**：`tool.call.toolview` keyed 渲染器已注册（get_goal/create_goal/update_goal/job_output/job_list/job_kill/subagent/subagent_fork）；startup-verify 10/10 |
| 阶段 2 | #3 记忆系统（P2） | 中 | 优先等官方 stable；急需可做最小版 |
| 阶段 3 | #16 Mermaid/LaTeX（P2） | 中 | 按需增量 |
| 阶段 4 | #9 插件范围 / #10 watcher / 3c / v2.0.4（P3） | 零 | 等官方；定期跑 check-update-compat.mjs |

### 已验证的插件可靠形态（后续开发标准）

```
cordis.patch.yml 必须含 - insert:（id/name/config enabled）  ← 装配入口
单文件（无相对导入）                                       ← 避免 loader 解析问题
inject: ['timer']（用 ctx.setTimeout 前）                 ← 惰性依赖先注入
inject: ['tools']（注册 agent 工具，用 defineTool）        ← 工具注册标准
bundles 清单 + dependencies + junction + 模板同步           ← 清单层，必须一致
host API 注册用 host-services registerLocalApi（POST）     ← webServer prefix 拒 POST（405）
```

### 关键教训（9 条）

- **教训 1-7**：见 §2（insert 装配入口 / inject timer / 单文件 / 干净重启 / PS 编码 / 原子写 / pwsh shell）
- **教训 8**：开发新插件前先确认 DSH 内核是否已有等价功能（dev_plugin_status + UI 全景扫描）——避免重复造轮子（dsh-context-usage 回滚事件）。
- **教训 9**：host API 注册必须用 `host-services` 的 `registerLocalApi`（默认 POST + JSON body + Origin 校验），不能用 `webServer.register` prefix（拒 POST → 405）（prompt-enhance 405 修复实证）。

---

*本文件由多次会话增量维护。最终更新：2026-09-01。*
