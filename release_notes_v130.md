# DeepSeek Harness 桌面端 v1.3.0 发布说明

## 新功能（鲁棒性改造：报错可定位 / 不致命 / 不重复）

| 功能 | 模块 | 说明 |
|------|------|------|
| 诊断决策引擎（大脑） | `src/lib/brain.js` + `loop-detect.js` | 感知→诊断→决策→反馈→学习闭环。错误指纹归并；回环检测（同指纹累计失败≥2 判环 → 强制升级破坏等级）；节流（同指纹同动作 10 分钟限 1 次）；全局预算（自动动作 10 次/小时）；经验表（.dsh-brain.json 持久化，成功率优先、等级优先）。任何故障循环最多触发有限次自动动作 |
| 启动超时自动恢复 | main.js | BOOT-004：服务 30s 未就绪 → 自动清理端口重启（restart → kill-port → 判环升级 → 兜底弹窗），跨启动生效 |
| 渲染崩溃自动恢复 | main.js | RENDER-001：崩溃 5 秒后自动 reload（节流限次，连续崩溃自动停止） |
| 熔断 / 安全模式 | `src/lib/safe-mode.js` | 连续启动失败 ≥3 次（1 小时窗口）→ 备份并移出全部第三方 bundle，仅核心功能启动；安全模式 boot 成功自动清计数（防永久困住）；异常退出（强杀）下次启动自动恢复配置。实测：隔离 14 个插件 → 强杀 → 下次启动全部恢复 |
| 诊断中心（错误码日志） | `src/lib/error-log.js` + `error-codes.js` | 结构化 JSON 行（ts/level/code/title/hint/msg/ctx），15 个错误码带解决指引（日志即手册），1MB 截半防膨胀 |
| dsh 服务输出落盘 | main.js | dsh 进程 stdout/stderr 完整写入 `%TEMP%\dsh-service.log`（截半），运行中报错不再只留退出时 4KB |
| 导出诊断报告 | main.js | 帮助菜单一键收集 4 类日志 + 环境/版本/插件清单 + brain 状态/安全模式备份 → zip，报错时直接发文件定位 |
| 补丁自愈清单 | `src/lib/patch-manifest.js` | modlens namespace/key、safe-delete key 补丁登记清单，dsh/插件升级覆盖后启动自动重打，失配记录 PATCH-001 |
| npm 路径收敛 | `src/lib/npm-paths.js` | execSyncSafe / npm prefix/root 缓存 / dsh·pnpm·npm-cli 定位 / patch 根目录查找唯一定义（main.js 与 patch 共用），移除 QClaw 冗余兜底 |

## 测试与实测

- 新增单测：brain-logic 26 + safe-mode 16 + error-log 20 + patch-manifest 16 = **78 项**（另原 smoke 25 项无回归）
- 故障注入实测：
  - 移走 `@deepseek-ai/dsh` 包启动 → 错误日志立即记录 `BOOT-001` + 解决指引 → 恢复后正常
  - 伪造 3 次启动失败 → 自动进入安全模式（bundles 仅剩核心、BOOT-005 落盘、核心功能正常）→ 强杀 → 再次启动自动恢复 14 个第三方插件
  - 本机已补丁场景 → patch-manifest 幂等跳过（ok）

## 错误码速查

| 码 | 含义 | 解决指引 |
|----|------|----------|
| BOOT-001 | DSH 服务启动失败 | 执行 `npm install -g @deepseek-ai/dsh` |
| BOOT-002 | DSH 服务进程异常退出 | 查看 `%TEMP%\dsh-service.log` 尾部 |
| BOOT-003 | 端口 3080 被非 DSH 进程占用 | 手动关闭占用程序 |
| BOOT-004 | 服务 30 秒未就绪 | 检查网络/配置；查看 dsh-service.log |
| BOOT-005 | 连续启动失败进入安全模式 | 逐插件启用排查 |
| RENDER-001 | 渲染进程崩溃 | 已自动恢复（限次）；复发导出诊断报告 |
| RENDER-002 | 渲染进程无响应 | 导出诊断报告 |
| PLG-001/002/003 | 插件加载失败类 | 按插件开发规范 / 检查 slot 声明 |
| NPM-001/002/003 | 依赖操作失败类 | 检查网络/权限后重试 |
| PATCH-001 | 补丁自愈失配 | 导出诊断报告反馈开发者 |

## 故障排查记录

### 安全模式"永久困住"缺陷（测试中发现并修复）
安全模式 boot 成功但未清除启动失败计数 → 每次启动都误判安全模式（第三方插件永不恢复）。修复：安全模式启动成功时清空 BOOT-002/004 失败计数并持久化。

### 日志截半中文计数缺陷（测试中发现并修复）
截半按字符数判断上限，日志含中文（3 字节/字符）时 1MB 上限永不触发。修复为字节语义 + 行对齐（不切断多字节字符/JSON 行）。

## 版本号

`src/package.json` → 1.3.0