# plugins/ 插件登记表

> 单一事实源：每个插件的状态、热重载安全性、用途。
> 与 AGENTS.md structure 区互补（那里只列名字）。

## 状态说明

- **core**：生产必需，缺了会影响核心功能
- **experimental**：实验性，可安全卸载
- **deprecated**：已完成使命，待清理

## 热重载说明

- ✅ 可热重载：`dev_reload_package` 安全
- ❌ 必须重启：modlens 类（adapter 注册只在启动时发生，热重载会丢失）
- ⚠️ 建议重启：bundle 插件（热重载可能丢状态）

## 插件清单

### plugins/ 目录（24 个）

| 插件 | 状态 | 热重载 | 用途 |
|------|------|--------|------|
| `dsh-bandof-diag` | experimental | ✅ | bandOf 诊断工具（已完成使命，待卸载） |
| `dsh-deep-whale-main` | core | ✅ | DeepWhale 主插件 |
| `dsh-file-explorer` | core | ⚠️ | 右侧文件浏览器（details 面板） |
| `dsh-force-reasoning-effort` | experimental | ✅ | 强制 reasoning-effort 能力（无 reasoning 元数据的模型也显示思考强度控件） |
| `dsh-frontend-reload` | core | ✅ | 前端刷新按钮 + Ctrl+R（桌面壳 Windows 无应用菜单时的兜底） |
| `dsh-hy3-gateway` | experimental | ✅ | HY3 OpenAI 兼容网关自动启动（CloudBase 免费混元） |
| `dsh-host-services` | core | ⚠️ | 本地 HTTP API 样板收敛（trusted/readBody/registerLocalApi 单一事实源） |
| `dsh-model-picker-group` | core | ⚠️ | 模型选择器分组（供应商模型 + modlens 双胞胎排序） |
| `dsh-model-tier-router` | core | ⚠️ | 同源模型自动分级路由（简单任务走 low，复杂走 high） |
| `dsh-model-whitelist` | core | ⚠️ | 模型管理器（Settings → 模型管理，白名单控制可见模型） |
| `dsh-modlens-autoread` | core | ❌ | 纯文本模型图片自动识别（粘贴/发照片时自动调 modlens 读图） |
| `dsh-modlens-guard` | core | ❌ | ModLens 配置守卫（防 visionProvider 被关、60s 巡查） |
| `dsh-project-brief` | core | ⚠️ | AGENTS.md 自动生成（跨 agent 平台的项目说明） |
| `dsh-remote-workspace` | core | ⚠️ | SSH/WSL/Docker 远程工作区连接 |
| `dsh-routing-suite` | core | ✅ | 路由套件 |
| `dsh-self-maintenance` | core | ⚠️ | 应用内智能自检守护（取代计划任务）：每小时磁盘剩余（<5GB warn / <2GB error）+ 会话体积聚合判断，健康静默、异常 24h 去重通知，`/self-maintenance/status` 心跳；只观测绝不删文件；零依赖、`inject:['timer']` 惰性解析（2026-08-26 上线） |
| `dsh-session-history` | core | ⚠️ | Web-chat 风格会话历史弹窗 |
| `dsh-session-hygiene` | core | ⚠️ | 会话文件大小卫生监控：每小时 stat 扫描 `~/.dsh/sessions/`，>4MB 提醒 / >8MB 强烈告警（Electron 通知 + 对话注入），`/session-hygiene/report` 报表（148 会话 38ms），闲置 24h 超阈值标建议归档（不自动归档，内核无归档 API）；零依赖、自调度退避、bundle 装配（2026-08-25 上线；`dev_inject_plugin` 运行时注入在当前 DSH 构建不可用，见 CHANGELOG） |
| `dsh-session-watchdog` | core | ✅ | 会话续跑看门狗（定时检测中断/停滞的会话与目标，自动恢复续跑） |
| `dsh-skills-manager` | core | ⚠️ | Skills 管理器（设置页，系统/用户技能分类展示、编辑、新建） |
| `dsh-system-notify` | core | ⚠️ | 系统通知（任务/会话完成时弹 Windows toast） |
| `dsh-vision-engine` | core | ❌ | 图片识别模型配置中心（多配置切换、测试识别、额度监控） |
| `dsh-web-fetch-local` | core | ✅ | 本地 HTTP(S) 抓取（SSRF 防护 + 大小限制） |
| `dsh-web-search-bing` | core | ✅ | 免 key 必应搜索 |

### 根级守护插件（3 个）

| 插件 | 状态 | 热重载 | 用途 |
|------|------|--------|------|
| `dsh-context-lifecycle` | core | ✅ | token 生命周期管理（零依赖 host 模式） |
| `dsh-stuck-loop-guard` | core | ✅ | 失败循环守卫（零依赖 host 模式） |
| `dsh-vision-rotator` | core | ✅ | 视觉引擎轮转（与 vision-engine 配合） |

## 统计

- 总计: 27（plugins/ 24 + 根级 3）| core: 24 | experimental: 3 | deprecated: 0
- 可热重载: 12 | 必须重启: 3 (modlens 类) | 建议重启: 12 (bundle 类)
