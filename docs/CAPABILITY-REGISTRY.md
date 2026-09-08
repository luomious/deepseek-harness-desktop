# DSH 能力注册表（CAP-3 · 单一事实源）

> 回答一个问题："这台 DSH 到底有哪些能力、怎么触发、什么状态。"
> 分层索引：本文件只做顶层地图，细节链接到各层的事实源文档，不重复维护。
> 更新纪律：新增/下线任何能力，必须同步本表对应行。
> 生成基线：2026-09-07（CAP-1/3 完成日）· skill 总数 18（6 方法论 + 12 hub 直装）

---

## 1. Skill 层（模型按需加载 · `~/.dsh/skills/` rank400）

> 触发方式：模型依据 frontmatter `description` 自动匹配加载；用户可直接点名。
> 格式门禁：`node scripts/lint-skills.mjs`（90/90 PASS）；直装审计：`~/.dsh/skills/.hub-install-manifest.json`。

### 1.1 自研方法论（6 个，本项目产出）

| Skill | 用途 | 触发场景 |
|---|---|---|
| evidence-driven-audit | 证据驱动审计 | 审计代码/配置，要求实锤不猜测 |
| falsification-check | 证伪检查 | 方案评审前先找反例 |
| multi-step-tracking | 多步追踪 | 长任务进度管理 |
| parallel-execution | 并行执行 | 多任务并发编排 |
| subagent-orchestration | 子代理编排 | 复杂任务拆分给子代理 |
| verify-by-fault-injection | 故障注入验证 | 验证自愈/容错逻辑真实有效 |

### 1.2 hub 直装（12 个，CAP-1 · 选单 `scripts/hub-skills.selection.json`）

| Skill | 用途 | 触发场景 | 离线可用 | 备注 |
|---|---|---|---|---|
| docx | Word 文档创建/编辑/解析 | 提到 .docx/.dotx | ✅（首次用需 pip 装 python-docx） | 官方 skill，单文件指令型 |
| pptx | PPT 创建/编辑/解析 | 提到 .pptx/.potx | ✅（同上，python-pptx） | 同上 |
| xlsx | Excel/CSV 读写/公式/图表 | 表格文件为主任务 | ✅（openpyxl/pandas） | 同上 |
| pdf | PDF 读取/合并/拆分/OCR/表单 | 提到 .pdf | ✅（pypdf 等） | 同上 |
| diagram-design | 52 种技术图表（架构/流程/时序…） | 需要技术图表 | ✅（自带 HTML 模板） | 含 templates/examples |
| security-audit | 代码安全审计 | 审计请求 | ✅ | |
| dep-auditor | 依赖漏洞/健康度/许可证审计 | 检查 package.json/go.mod 等 lockfile | ✅（可离线读本地 lockfile） | 报告中文 |
| zh-docgen | 代码库中文技术文档生成 | 文档生成请求 | ✅ | |
| dispatching-parallel-agents | 多任务并行分发 | ≥2 个无依赖任务 | ✅ | 与 subagent-orchestration 重叠 → 共存观察（CAP-6） |
| verification-before-completion | 完成前强制验证 | 宣称完成/修复之前 | ✅ | 方法论型 |
| systematic-debugging | 系统化调试流程 | 遇 bug/测试失败 | ✅ | 方法论型 |
| test-driven-development | TDD 红绿重构 | 写功能/修 bug 前 | ✅ | 方法论型 |

**未装（有意排除）**：`web-artifacts-builder`（面向 claude.ai 环境写死）；其余 59 个留在 hub 按需扩装——只需往选单 JSON 加一行重跑脚本，零代码改动（可扩展性）。

**维护命令**：
```bash
node scripts/install-hub-skills.mjs            # 按选单安装/更新
node scripts/install-hub-skills.mjs --dry-run  # 预览
node scripts/install-hub-skills.mjs --remove <name>  # 回滚单个（仅限 manifest 登记）
node scripts/lint-skills.mjs                   # 格式门禁
```

## 2. 插件层（30 个 · 事实源 `plugins/INVENTORY.md`）

> 装配/热重载/状态以 INVENTORY.md 为准，此处只列能力分组速览。

| 分组 | 插件 | 能力 |
|---|---|---|
| 会话与数据 | session-history / session-hygiene / session-watchdog / context-lifecycle(根) | 会话索引、卫生告警（目录聚合 150/250MB）、续跑守护、上下文生命周期 |
| 宿主服务 | host-services / task-scheduler / remote-workspace / file-explorer / project-brief | v1 API、跨进程文件锁、远程工作区、文件浏览、项目简报 |
| 模型路由 | model-tier-router / model-whitelist / model-picker-group / model-provider-failover / force-reasoning-effort | 分层路由、白名单、选择器分组、故障切换、思考强度注入 |
| 视觉与画图 | vision-engine / modlens-autoread / modlens-guard / vision-rotator(根) / diagram-renderer / tool-renderers | 图像理解、自动读图、profile 守卫、轮换、图表渲染、工具渲染 |
| 安全守护 | command-guard / stuck-loop-guard(根) / web-fetch-local / hy3-gateway | 命令风险拦截、死循环守卫、本地抓取、网关 |
| 自愈运维 | instance-janitor / self-maintenance / system-notify / frontend-reload / ui-performance / routing-suite | 孤儿清理、自检守护、通知、前端热载、UI 性能、路由套件 |
| 效率 | prompt-enhance / skills-manager / web-search-bing | 提示增强、skill 管理（rank400 读写）、Bing 搜索 |

## 3. 脚本工具箱（`scripts/` · 命令行触发）

| 脚本 | 用途 | 频率 |
|---|---|---|
| task-scheduler.mjs | 跨进程文件锁（status/acquire/release） | 共享文件编辑前 |
| startup-verify.mjs | 启动链路 10 项校验 | 每次改动后 |
| check-dist-integrity.mjs | dist 完整性 | 每次改动后 |
| lint-skills.mjs | skill 格式门禁（LINT-1） | skill 增改后 |
| install-hub-skills.mjs | hub skill 直装/回滚（CAP-1） | 扩装时 |
| verify-patches.ps1 | dist 补丁存在性校验 | 部署后 |
| dsh-maintenance.mjs | 日志轮转 + 磁盘配额（DATA-2/3） | 可定期/手动 |
| apply-*.mjs（15 个） | 补丁幂等重放 | 重建后 |
| promote-build.ps1 | 换版（≥2 build 门禁） | 升级日 |
| resolve-dist.mjs | 定位当前 build 路径 | 被其他脚本引用 |

## 4. 宿主能力（DSH 内核 + 桌面壳）

| 能力 | 触发/入口 | 状态 |
|---|---|---|
| Web GUI | 127.0.0.1:43120（仅回环） | core |
| 会话持久化 | zstd + JSONL 索引（补丁保护） | core |
| skill_search | 模型工具，发现 skill 层 | core（新装 skill 热更新可见，无需重启） |
| 升级冻结 | 自动更新已关（UPD-2），走本地构建 | 单机决策 |
| 启动自愈 | 残留锁 60s 恢复 / 端口预检弹窗 / 退出清锁 | 阶段 1 已部署 |

## 5. 明确没有的能力（防幻觉）

- 图像/视频/3D **生成**：无（CAP-5 待决策，接云端则破离线）
- 在线服务依赖：无（单机离线；升级日才访问上游）
- 多用户/远程：单用户单机
