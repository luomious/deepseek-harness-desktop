# CHANGELOG

> DeepSeek Harness 桌面版版本发布记录。
> 合并自 release_notes_v115 ~ release_notes_v130（最新版本在前）。

---

## DeepSeek Harness 桌面端 v1.3.0 发布说明

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

---

## DeepSeek Harness 桌面端 v1.2.3 发布说明

## 修复内容（src/main.js / src/patch-dsh-native-picker.js）

| 改动 | 说明 |
|------|------|
| 窗口遮挡冻结 | 禁用 `CalculateNativeWinOcclusion`：窗口被其他窗口完全盖住（occluded）时 Chromium 会冻结渲染，切回窗口后 UI 长时间无响应（`backgroundThrottling: false` 不覆盖此行为）。现在窗口遮挡/最小化后再切回立即响应 |
| 启动加速 | npm prefix/root 结果缓存：`findDshBin`/`findPnpmBin`/`findNpmCli` 合计 6+ 次 `execSync` 只在启动时执行一次，且全部带 5s 超时（防 npm 挂起卡死启动）；`patch-dsh-native-picker.js` 同样缓存 |
| 版本比较重构 | `isNewer`（支持 semver pre-release）从 main.js 提取到 `src/lib/version.js`，桌面应用与 tests 共用同一实现（`tests/smoke-v119-logic.js` 已切换并补充用例） |
| asar 原子打包 | `build-app.ps1`：先打包到临时文件再 `Move-Item` 原子替换，打包失败/中断不会留下损坏的 app.asar |
| 打包卡死修复 | `src/package.json` 去除 UTF-8 BOM（Electron 30 读取 asar 内带 BOM 的 package.json 会在启动早期挂起，表现为无窗口/无渲染进程/无启动日志）；`build-app.ps1` 改用 `Copy-Item -Force` 替换（`Move-Item` 在目标被短暂占用时报 "file already exists"）并在 verify 阶段检查 BOM/JSON/version.js |
| 版本号 | `src/package.json` → 1.2.3 |

## 故障排查记录：重打包后 exe 启动卡死（BOM）

### 现象
重打包 app.asar（含 `src/lib/version.js` 提取与 npm 缓存改动）后，exe 启动无窗口、无渲染进程、无启动日志，主进程仅 ~52MB 且 CPU 近乎 0（挂起在 Electron 初始化早期，GPU 子进程参数中缺少 `CalculateNativeWinOcclusion`，证明 main.js 顶层尚未执行完）。

### 排查过程
- 新旧 asar 文件级 diff：main.js / version.js / patch / preload / icon / loading 内容与 hash 全部一致
- 唯一差异：`package.json`（178 → 204 字节），内容为 1.2.2 → 1.2.3 且**开头多出 UTF-8 BOM**
- 剥离 BOM 重打包（100,353 字节）→ 启动恢复正常（3-4 秒出窗口、3080 服务正常）

### 根因
Electron 30 读取 asar 内的 package.json 时对 UTF-8 BOM 处理异常，主进程在加载 main.js 之前挂起（表现为无任何启动日志）。BOM 是版本号从 1.2.2 改到 1.2.3 时编辑器写入的。

### 预防
`build-app.ps1` verify 阶段新增三项检查：package.json 无 BOM（必须 false）、JSON 可解析、lib/version.js 存在；打包后必须实际启动 exe 验证。

## 故障排查记录：rc.7 升级后"页面空壳 / 点击无响应"

### 现象
升级 DSH rc.7 后，界面变成空壳（只剩活动栏系统项），点击任何菜单无响应，控制台大量插件加载失败。

### 根因
rc.7 的 `dsh-client-ui-slots` 引入严格检查：

- `keyed slot requires options.key` —— 缺 `options.key` 直接抛错
- `slot not declared` —— 注册未在父条目 children 表声明的 slot 直接抛错

第三方插件 `@liustack/modlens`（settings.plugin.item 缺 key）与 `dsh-safe-delete`（settings.plugin.item 缺 key）注册失败；`dsh-remote-workspace` 注册的 `remoteFlow` slot 在 rc.7 核心包未声明 children。任一 loader entry 失败 → 整个 DSH 客户端初始化崩溃 → 空壳页面。

### 修复（改动在 node_modules / 插件源码，dsh 升级会被覆盖）
1. `@liustack/modlens/dsh/client.js`：`settings.plugin.item` 注册补 `key: 'modlens'`
2. `dsh-safe-delete/lib/client.js`：`settings.plugin.item` 注册补 `key: 'safe-delete'`
3. rc.7 核心 `dsh-client-ui-workspace/lib/client.js`：`sidebar.workspaces` / `conversation.hero.workspace` children 表补 `remoteFlow` 声明，并重打全部远程工作区功能（ADD_REMOTE 入口、WorkspacePickFlow/WorkspaceBrowser 渲染、中英文 locale）
4. 备份：`C:\Temp\opencode\client.js.modified-rc7.bak`（核心改动）、`modlens-index-modified.js`（modlens host 改动）

## 故障排查记录：modlens 配置卡片在"设置 → 插件"页消失

rc.7 的插件卡片渲染改为按 host 端 `settings.describe` 返回的 namespaces 过滤（卡片 key 必须在服务名单中），而 modlens host 端按旧版假设不注册 namespace → 卡片静默消失。

修复：`@liustack/modlens/dsh/index.js` 增加 `ctx.inject(['settings'])` 注册值无关 namespace（可调用 schema，无需 schemastery 依赖），卡片恢复显示（引擎选择 / API 密钥 / 自动复用 / 保存全部可用）。

## 功能改进（dsh-remote-workspace 插件，改动在 plugins/ 源码）

| 改动 | 说明 |
|------|------|
| 面板居中 | 远程连接面板从右上角浮层改为居中模态（全屏遮罩 + fixed 居中，点击遮罩关闭），适配窄窗口 |
| 自动加载 | 修复面板打开时永远显示"加载中…"：挂载时自动调用 `list` 拉取已保存连接/远程工作区，不再需要手动点"刷新" |

## 稳定性验证（v1.2.3）

- 9 分钟长观察：0 挂起、0 console 错误、JS 堆稳定 112MB（无泄漏）
- 12 轮快速交互压力（设置/新会话/添加工作区）：0 挂起
- 全插件实证：16 个 bundle 加载、设置页 7 个 section + 4 张插件卡片全部渲染
- 事件日志/崩溃转储无 DeepSeek Harness 崩溃记录

## 环境清理（v1.2.3）

- 删除临时测试脚本 56 个、`tools/npm-cache2` 缓存 63MB
- 旧备份文件集中归档到 `C:\Temp\opencode\backups-web-20260818\`
- 待处理：`.dsh-trash` 回收区 48MB（含已删除的 dsh-skill-manager 插件，可恢复，确认后清空）

## 已知问题

- 偶发冻结（未复现）：一次关闭远程面板后短暂无响应（约 20s），reload 恢复；窗口最小化/遮挡嫌疑最大，occlusion 开关已预防，建议观察
- modlens / safe-delete / 核心包改动在 node_modules，**dsh 升级会被覆盖**，需按上文重新应用

---

## DeepSeek Harness 桌面版 v1.2.2 发布说明

## 修复内容（src/main.js）

| 改动 | 说明 |
|------|------|
| 插件挂载补齐 | 非 `dsh.bundle` 声明的第三方插件（如通过 pnpm add 安装但未声明 bundle 的）也能被正确挂载，不再遗漏 |
| console-message 新签名适配 | 适配新版 Electron `console-message` 事件参数签名变化（旧 4 参数 → 新 Event/level/message/line/sourceId），避免前端日志捕获失效或报错 |
| 端口精确匹配 | 端口占用判断从"包含匹配"改为精确端口匹配，防止 `3080` 误匹配到 `30801` 等端口 |
| 诊断日志轮转 | 启动日志/前端日志单文件上限 1MB，超出后截半保留（防无限增长占满磁盘） |
| 版本号提升 | `src/package.json` → 1.2.2 |

## 排查记录：「新会话无反应」真正根因

### 背景
v1.2.1 后用户反馈点击「新会话」仍无反应。通过新增的前端日志捕获
（`%TEMP%\dsh-desktop-renderer.log`）直接定位：

```
new session failed: SessionCreateError: agent-preset-not-found:
agent-presets: preset "native" not found (available: standard, code, minimal, cordis)
```

### 根因
`~/.dsh/settings.yaml` 中 `agent-presets.default` 被设为 `native`，但当前 DSH 版本
实际可用的 preset 只有 `standard / code / minimal / cordis`，没有 `native`。
每次点「新会话」后端创建会话时找不到 preset，前端表现为「没反应」。

### 修复
`~/.dsh/settings.yaml` → `agent-presets.default: standard`，重启应用生效。

### 配置全面核查（无其他类似问题）
- `ui-conversation.busyEnter: steer` ✅ 合法枚举（queue | steer）
- `agent-default-model: opencode-go / deepseek-v4-flash / reasoningEffort: high` ✅ 该模型支持 off~high
- `llm-pi-ai.providers`（opencode-go / xiaomi-token-plan-cn）✅ 渠道存在，API key 已配置

## 已知设计行为（非 bug）
会话中发送过图片后，DSH 会阻止切换到不支持图片输入的模型
（`model-unavailable: does not accept image input, but this session already contains images`），
且当前版本无删除单条消息 API → 解锁方法为**新建会话**或长期使用多模态默认模型。

---

## DeepSeek Harness 桌面版 v1.2.1 发布说明

## 核心修复：端口被僵死进程占用时自愈，不再闪退

### 背景
用户多次反馈「点击新会话没反应」「关闭应用重新打开还是不行」。排查发现：

1. **DSH 服务进程会意外退出**（此前手动拉起的服务进程 PID 11344 在运行中消失，
   3080 端口只剩 TIME_WAIT 残留）
2. **exe 启动时的缺陷**：当 3080 端口被一个"僵死"进程占用（进程还在监听端口，
   但不响应 HTTP 请求）时：
   - `isPortListening(3080)` 返回 true（端口能 connect 成功）
   - `isDSH` 验证请求 3 秒超时 → 判定"端口被占用且不是 DSH 服务"
   - **直接弹窗 + app.quit() 退出** → 用户看到"打开就闪退/没反应"

### 修复内容（src/main.js）
| 改动 | 说明 |
|------|------|
| 新增 `killProcessOnPort()` | 通过 netstat 解析占用端口的 PID，taskkill /f /t 强制清理（Windows）/ fuser -k（macOS/Linux），无 shell 注入面 |
| 新增 `waitPortReleased()` | 轮询等待端口释放（10 次 × 500ms） |
| whenReady 逻辑重构 | 端口被占用且 isDSH 验证失败时：**先清理占位进程 → 等待端口释放 → 自动启动自己的 DSH 服务**，不再直接退出；仅当清理失败才弹窗提示 |

### 验证
- `main.js` 语法检查通过
- `killProcessOnPort` netstat 解析逻辑测试通过
- 重新打包 `app.asar`（86.3 KB），buildDshEnv/applyNativePickerPatch/requestSingleInstanceLock 均在
- 3080 端口已完全释放，exe 打开将走自启动分支

### 使用说明
重新打开桌面版 exe 后：
1. exe 检测 3080 端口 → 无服务 → 自动 `startDSH()` 拉起 DSH
2. 若端口被残留僵死进程占用 → 自动清理并重试（不再闪退）
3. 服务就绪后加载 Web UI

### 其他说明
- 此前 v1.2.0 已把 DSH 后端迁移到独立位置（`AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`），
  并修复 WorkBuddy NODE_OPTIONS shim 注入问题（buildDshEnv）
- 若仍遇到问题，请确认：完全退出旧 exe 实例后再打开（单实例锁）

---

## DeepSeek Harness 桌面版 v1.2.0 发布说明

## 核心改进：DSH 后端彻底独立于 QClaw

### 背景
桌面版依赖的 DSH 后端包（`@deepseek-ai/dsh`）此前安装在 QClaw 的 npm 全局目录
（`C:\Users\<user>\AppData\Roaming\QClaw\npm-global\`）。虽然桌面版本身是独立应用，
但后端包位置与 QClaw 耦合，且发现以下隐患：

1. **WorkBuddy shim 注入导致 DSH 服务异常退出**（本次修复的核心 bug）
   - WorkBuddy 通过环境变量 `NODE_OPTIONS=--require=...genie-safe-delete.cjs` 向所有 node
     子进程注入文件删除保护 shim，会把 `fs.unlinkSync` 重定向为 trash 操作。
   - DSH 服务启动时要 heal `~/.dsh/profiles/node_modules` 下的 junction（需 unlink 重建），
     被 shim 拦截后启动失败 → 表现为「服务崩溃 / 新会话无反应 / 卡顿」。
   - 修复：桌面版启动 DSH 时使用干净环境变量（`buildDshEnv()`），剔除
     `CODEBUDDY_SAFE_DELETE_*`、`GENIE_TRASH_DIR`、`BASH_ENV`，并移除 `NODE_OPTIONS`
     中的 safe-delete shim 引用。

2. **DSH 后端包迁至用户级 npm 全局目录**
   - 新位置：`C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`
   - 与 QClaw 完全解耦：不依赖 QClaw 目录、不依赖 QClaw 的 node。
   - `findDshBin()` / `findPnpmBin()` / `findNpmCli()` 的候选顺序调整：
     用户级全局（Roaming\npm）优先，QClaw 降为最后兜底。
   - 补丁脚本 `patch-dsh-native-picker.js` 搜索顺序同步调整。

### 变更文件
| 文件 | 变更 |
|------|------|
| `src/main.js` | 新增 `buildDshEnv()`；`findDshBin`/`findPnpmBin`/`findNpmCli` 候选顺序调整；`startDSH` spawn 使用干净 env |
| `src/patch-dsh-native-picker.js` | 搜索顺序：Roaming\npm 优先，QClaw 最后兜底 |
| 环境 | dsh 复制到 `AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`；profile 194 个 junction 重指新位置 |

### 验证结果
- 独立 dsh 完整启动：`HTTP 200`，3080 端口正常监听
- 服务进程确认使用 `C:\Program Files\nodejs\node.exe` + `Roaming\npm\...\dsh\lib\bin.js`（非 QClaw）
- profile 194 个符号链接全部指向新位置，零悬空
- 补丁脚本识别新位置 worker.cjs 为 already-fixed
- `main.js` / `patch-dsh-native-picker.js` 语法检查通过

## 其他检查结论
- DSH 服务（3080）：正常，HTTP 200
- QClaw openclaw-gateway（3896）：正常，HTTP 200
- 插件（5 个开发插件）：全部存在且加载正常
- 会话/工作区：3 个工作区正常
- 内存：使用率 81.5%（总 15.7G，剩 2.9G）——建议关闭闲置应用（原神占用 2.2G）避免服务被挤掉
- D 盘剩余 7.2G——注意磁盘空间

---

## v1.1.9 — 全面代码审计修复：更新流程健壮性与窗口恢复

### 背景

对 `src/main.js`（1689 行）做了一次全面审计，重点检查更新流程、窗口生命周期、服务恢复与编码处理。修复 6 处问题。

### 修复内容

**Bug 1（中）：更新期间 npm install -g 可能因文件占用失败（Windows）**
- 原实现：`stopDSH()` 后固定等待 2 秒就执行 `npm install -g`。taskkill 是异步的，若 dsh 进程树未完全退出，npm 覆盖 `@deepseek-ai/dsh` 全局包目录时可能报 `EPERM`（文件被运行中进程占用）
- 修复：改为**轮询等待端口释放（最多 5 秒）**，确认 dsh 进程树退出后再执行 npm install

**Bug 2（中）：更新后「稍后重启」失败无用户提示**
- 原实现：`waitForDSH()` 超时失败只 `console.error`，用户无感知，应用停在"服务已停止"状态
- 修复：超时失败时弹窗提示「DSH 更新成功，但服务未能重新启动，请重启应用」

**Bug 3（中）：双击图标唤起（second-instance）不恢复 DSH 服务**
- 原实现：第二个实例唤起时只聚焦窗口。若 DSH 服务已停止（用户手动结束进程），窗口停留在白屏/loading 状态
- 修复：唤起时检测端口，若服务未运行则 `startDSH()` + `waitForDSH()` + 重新加载 Web UI（与 activate 分支逻辑对称）

**Bug 4（低）：activate 分支未应用原生目录选择器补丁**
- whenReady 启动路径已应用 `applyNativePickerPatch()`，但 activate（macOS 窗口全关后重新激活）分支没有；若 DSH 重装后 worker.cjs 被覆盖，该路径会绕过补丁
- 修复：activate 分支 `startDSH()` 前同样调用补丁（幂等）

**Bug 5（低）：插件管理窗口 loadURL 缺少 .catch**
- 极端情况下（data: URL 加载异常）会产生 unhandled rejection
- 修复：添加 `.catch` 并记录日志

**Bug 6（可读性）：checkForUpdates 的 `} else {` 缩进错乱**
- 原代码 `if (hasUpdate) {...} else {...}` 的 else 分支缩进异常，逻辑正确但极易被误读/后续回归（例如误以为「稍后再说」会弹「已是最新版本」）
- 修复：重构为清晰的顺序分支，并在「稍后再说」处显式 `return`，杜绝歧义（行为不变，已用测试锁定）

### 回归测试

新增 `tests/smoke-v119-logic.js`（25 个断言）：
- `isNewer` 语义版本比较 15 例（含 pre-release、数字/字符串标识符、null、数字类型）
- `checkForUpdates` 决策矩阵 10 例（silent/手动 × 有/无更新 × 立即更新/稍后再说）

结果：**25/25 通过**

### 文件

- `src/main.js`：6 处修复（约 +35 行）
- `tests/smoke-v119-logic.js`：新增回归测试（约 130 行）

---

## v1.1.8 — 新建工作区路径末尾被截断的根本修复

### Bug 修复

**严重：DSH 原生目录选择器（Win32 IFileOpenDialog）返回路径末尾汉字被吞**

- **现象**：在 DSH 桌面版「新建工作区」选择 `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发`，后端 `workspace.create` 报错：
  > `cannot create a workspace at "C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备": ENOENT ...`
  即末尾「开发」两个汉字被吞。

- **根因**：`@deepseek-ai/dsh-host-directory-picker-native` 子进程 `worker.cjs` 中，`readUtf16` 函数通过 koffi 读取 COM `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)` 返回的 LPWSTR 时，**只检查单字节是否为 0**（`bytes[end] !== 0`）就当作 UTF-16 null 终止符。
  但汉字「**开**」Unicode U+5F00，UTF-16LE 编码为 `0x00 0x5F`——**低位字节恰好是 0x00**。循环走到「开」字时误判为字符串结束，于是末尾的「开发」两个汉字被截掉。

- **通用性**：任何路径在某个字符的 UTF-16LE 低字节为 0 时都会被截断（不仅「开发」），覆盖范围广。

- **修复**：把 null 终止符检测改为「**连续 2 字节都为 0** 才认为结束」，这是 UTF-16 LE null 终止符（`\0\0`）的唯一正确判定。

```js
// 旧版（有 bug）
while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;

// 新版（已修复）
while (end + 1 < bytes.length) {
  if (bytes[end] === 0 && bytes[end + 1] === 0) break;
  end += 2;
}
```

### 持久化补丁

DSH 包重装后会覆盖 `worker.cjs`，因此加了一个幂等补丁脚本，**每次启动 DSH 服务前自动应用**：

- 新增 `src/patch-dsh-native-picker.js`：
  - `findDshNodeModulesRoot()` 按 `npm prefix -g` / `npm root -g` / QClaw 默认位置（`AppData/Roaming/QClaw/npm-global/node_modules`）等多源定位 DSH 全局 node_modules
  - `applyPatch()` 读取 `worker.cjs`，检测 `FIXED_MARK` 已存在则跳过，否则按精确正则替换旧版 while 条件
  - 可独立执行：`node src/patch-dsh-native-picker.js`
- `src/main.js`：顶部引入补丁模块，启动 DSH 服务之前调用 `applyNativePickerPatch()`，**失败时降级为 console.warn 不阻塞启动**

### 单元验证

- `readUtf16Old("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备"`（精确复现用户报错）
- `readUtf16New("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备开发"`（完整）

### 用户操作

- **直接用原路径就行**：之前为绕过此 bug 在 `D:\` 创建的 junction `D:\edge-defect-dev` 可以保留作双保险，也可以随时删除（`rmdir D:\edge-defect-dev`）——junction 删除不会影响原文件夹内容。
- 重新启动 DeepSeek Harness 桌面版（让 worker.cjs 修复 + main.js 启动 hook 生效）后，`C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发` 应能直接添加为工作区。

### 文件

- `src/main.js`：顶部新增 require；DSH 启动前新增补丁调用（~7 行）
- `src/patch-dsh-native-picker.js`：新增（约 100 行）
- `C:\Users\机械革命\AppData\Roaming\QClaw\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs`：readUtf16 已修复
  - 备份：`worker.cjs.bak.20260815134405`

---

## v1.1.7 — dialog null 防御与更新检查健壮性

### Bug 修复

**Bug 1（中）：菜单"检查更新"缺 .catch() 保护**
- `checkForUpdates(false)` 是 async 函数，菜单 click handler 中调用但未 catch
- 如果内部抛出未预期异常，会变成 unhandled promise rejection
- 修复：添加 `.catch(err => console.error(...))`

**Bug 2（中）：dialog 调用缺少 mainWindow null 防御**
- 所有 `dialog.showMessageBox(mainWindow, ...)` / `dialog.showMessageBoxSync(mainWindow, ...)` 直接引用 mainWindow
- 如果用户在更新检查期间关闭主窗口，mainWindow 为 null 可能导致异常
- 修复：checkForUpdates 和 performUpdate 内引入 `const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null` 局部变量
- 所有 dialog 调用改用 `win`，进度窗口 parent 改为 `undefined`（Electron 允许无 parent）
- 菜单"关于"同样修复

### 代码质量改进

- `pluginWin` 声明位置从 IPC 区移至 `openPluginManager` 函数前，消除前向引用
- `preload.js` 末尾补换行符
- 清理已删除的 `logs/` 截图和 `release_notes_v113.md` / `release_notes_v114.md`

### 测试

- v1.1.7 专项测试：15/15 通过
- v1.1.3 安全专项：41/43（2 个旧测试正则误报）
- v1.1.4 专项：12/12 通过
- v1.1.4 静态扫描：16/17（1 个 innerHTML 误报，有 esc 转义保护）
- isNewer：15/15 通过
- 启动回归：全部通过（启动/HTTP 200/8s 无崩溃/退出无孤儿进程）

### 文件

- `src/main.js`：1531 行 / ~71KB
- `src/preload.js`：675 字节（8 白名单方法）
- `app.asar`：76457 字节

---

## v1.1.6 修复、安全加固与插件管理增强

## 🐛 严重 Bug 修复

- **修复 src/main.js 加载即崩溃**：commit 4ee96d7 在新增 zlib 导入时误将 `const os = require('os')` 替换掉，导致 `os.homedir()` 抛 ReferenceError、应用无法从源码启动。已恢复 os 导入（commit 84e5ce3）
- **修复打包产物与源码不一致**：重新打包 app.asar，确保发布物包含 v1.1.5 全部修复（此前 asar 仍是 v1.1.4 时代代码，自动更新/版本获取等修复未进包）

## ✨ 插件管理增强

- **安装/卸载后列表自动刷新**：新增 `plugin:list` IPC 与前端 `refreshInstalled()`，安装或卸载插件后已安装列表即时更新，无需重启插件管理窗口（替代原先卸载后整页 reload）
- **错误信息友好化**：新增 `friendlyPnpmError()`，把 pnpm 原始英文输出（网络错误/权限不足/包不存在/依赖冲突/IGNORED_BUILDS 等）解析为可读的中文提示
- **IGNORED_BUILDS 识别为部分成功**：pnpm 10+ 安全策略拦截依赖构建脚本时（node-pty 等原生模块），包实际已安装，UI 现在标记为"安装成功 + 警告"而非"失败"
- **插件列表过滤核心依赖**：`getInstalledPlugins()` 不再展示 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 等核心包，只列出可管理的第三方插件，避免误导

## 🔒 安全加固

- **拦截服务端重定向**：主窗口补 `will-redirect` 处理（此前仅拦截客户端导航），外部站点 302/307 跳转一律拦截，杜绝钓鱼/误导面
- **插件管理窗口导航白名单**：仅放行原始 data: URL 的重载（卸载插件后 location.reload()），杜绝窗口被引导到外部页面继承 preload 注入的 electronAPI
- **进度窗口导航封锁**：更新进度窗口禁止一切导航
- **CSP**：进度窗口与插件管理窗口的 data: HTML 增加 Content-Security-Policy
- **拒绝 HTTPS 降级重定向**：更新检查只跟随 https 重定向，拒绝降级到 http://

## ✅ 验证

- 语法检查 + 整文件加载冒烟测试通过
- 导航守卫行为测试 10/10（will-redirect 拦截/放行、导航白名单、同 URL 重载）
- asar 与源码逐字节一致，部署验证通过

## 使用

- 桌面版：重启 DeepSeek Harness.exe 生效
- 源码：npm install -g @deepseek-ai/dsh 后运行

---

## v1.1.5 Bug 修复与安全加固

## 🐛 严重 Bug 修复

- **修复自动更新实际执行失败的根因**：`performUpdate` 用 `process.execPath`（Electron 可执行文件 electron.exe / 打包 exe）执行 npm-cli.js，会启动 Electron GUI 而非执行 npm，导致更新必然失败。改用 `findDshBin()` 定位的 node.exe 直接执行，更新超时放宽至 3 分钟（npm install -g 可能耗时 1-2 分钟）
- **修复 `getInstalledVersion` 主路径完全失效**：旧代码把 npm 参数（`list -g ... --json`）错误地传给 dsh bin.js 执行（spawn node dsh-bin.js list -g ...），永远拿不到版本，全靠兜底路径。改为 node 直接执行 npm-cli.js 查询全局版本
- **修复 `getInstalledVersion` 兜底被跳过**：npm list 失败（如包未安装 exit 1）会抛错直接跳出外层 try，导致后续 fallback 永远不执行。拆分为独立 try 块，fallback 1（findDshBin 反推）+ fallback 2（npm prefix -g）双保险
- **修复跨平台 node 定位失败**：`where node` 是 Windows 专属命令，macOS/Linux 上会抛错，且兜底路径全是 Windows 路径（C:\Program Files\nodejs），导致非 Windows 平台找不到 node 无法启动。改为按平台选择 where/which，兜底路径分平台（/usr/local、/opt/homebrew 等）

## 🔒 安全加固

- **主窗口移除 preload 注入**：主窗口加载的是远程 DSH Web UI（http://127.0.0.1:3080），此前会注入 preload 暴露 `electronAPI`（可调用 checkUpdate 弹窗等）。移除后远程内容零权限，preload 仅保留给插件管理窗口（本地 data: URL）
- **URL 校验从 startsWith 升级为精确 origin 匹配**：`will-navigate` 原用 `url.startsWith(DSH_URL)`，`http://127.0.0.1:3080.evil.com` 这类 URL 可绕过校验并继承权限。新增 `isDSHOrigin()` 严格比较 protocol/host/port
- **进度窗口版本号 HTML 转义**：版本号来自 npm registry（远程数据），拼入 HTML 前转义，防 HTML 注入
- **路径白名单补充 cmd 元字符**：`%` `!` `^` 等 PowerShell/cmd 解析字符加入拒绝列表

## 🛠️ 健壮性修复

- **DSH 崩溃检测不再依赖 stdout 文本**：`startDSH` 原通过检测 stdout 是否包含 `127.0.0.1` 判断"已启动"，若输出格式变化则标志永不置位，崩溃时既不弹窗也不退出。改为基于 promise 结算状态（spawn 成功即 settle），逻辑可靠
- **修复 activate 白屏（真正修完）**：v1.1.4 声称修复 macOS 激活白屏，但原逻辑仅在服务未运行时加载 UI —— 若服务已在运行，窗口会永远停在 loading.html。现无论服务状态，激活后都加载 Web UI
- **停止服务统一无 shell 执行**：taskkill / powershell / fuser 全部改为 `shell: false`，与项目"全程无 shell"安全策略一致
- **重定向相对路径解析**：getLatestVersion 跟随 301/302 时，location 可能为相对路径，现用 `new URL(location, base)` 解析为绝对 URL
- **端口占用验证支持 gzip 响应**：若 DSH 返回 gzip 压缩 HTML，原逻辑读原始字节判断 `__DSH_BOOT__` 会误判"端口被占用"，现先解压再判断；解压异常时回退原始字节，避免 promise 永不结算导致应用卡死
- **更新后"稍后重启"分支 loadURL 补 catch**：避免 unhandled rejection
- **pnpm/npm CLI 兜底路径分平台**：findPnpmBin / findNpmCli 的 fallback 在 macOS/Linux 使用 /usr/local/lib/node_modules 等路径
- **目录选择对话框指定 parent 窗口**：dialog:selectFolder 绑定插件管理窗口，避免在 modal 上错位
- **核心依赖卸载硬保护**：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 在主进程层禁止卸载（原仅 UI 提示，可被绕过）
- **file: 协议路径规范化**：本地插件路径前缀大小写不敏感识别（File:/FILE:），并清理尾部反斜杠/斜杠，防 pnpm 解析异常
- **loading.html 加载补 catch**：避免本地文件加载失败导致 unhandled rejection
- **更新失败自动恢复服务**：更新流程开始前已 stopDSH，若 npm install 失败（网络/超时/权限），catch 分支现自动重启 DSH 服务并重新加载 UI，不再让应用停在"服务已停止"状态

## ✅ 验证

- 语法检查通过（main.js + preload.js）
- 逻辑回归测试 21/21 通过（isDSHOrigin 前缀绕过、escVer 转义、跨平台 where/which、路径元字符、版本反推）
- 真实环境验证：dsh 版本反推成功（0.1.0-rc.6）、npm-cli.js 定位成功
- 未提交的 v1.1.5 工作区改动（端口占用校验、启动早期快速失败、spawn 事件 resolve、关于对话框 await）已随本版本入库

## 使用

- 桌面版：重新打包后运行 DeepSeek Harness.exe
- 源码：npm install -g @deepseek-ai/dsh 后运行

---

## 2026-08-19 插件：modlens 配置守卫 + 模型选择器合并排版

### 背景

`~/.dsh/profiles/web/cordis.patch.yml` 的 modlens 配置块在 22:58 被加了
`visionProvider: false`，导致全部 "(modlens vision)" 包装模型从对话区模型选择器
消失（modlens 插件仅在 `visionProvider !== false` 时注册视觉包装 provider）。
同目录备份 `cordis.patch.yml.bak.20260819225850` 证明此前没有这一行。

### dsh-modlens-guard（配置守卫，host 插件）

- **立即恢复**：apply 时移除 modlens 配置块中的 `visionProvider: false`；
- **热生效**：通过 `ctx.loader.entries()` 定位 modlens 条目并 `entry.update()`
  以启用状态重建 fiber，无需重启服务即可看到 (modlens vision) 模型；
- **定时巡查**：每 60s 检查，`visionProvider: false` 再次出现立即恢复并写日志
  `~/.dsh/super-injector/modlens-guard.log`；
- **families 锁定**：把 modlens 的 `families` 强制为全量 9 家
  (`deepseek/glm/mimo/qwen/kimi/minimax/seed/grok/sensenova`)，防止被改回 3 家
  导致 qwen/kimi 等失去 modlens 版本；
- 端到端自测通过（哨兵文件模拟攻击 → 自动恢复 → 热重建）。
- 临时关闭：cordis.patch.yml 顶部加 `# modlens-guard: off`。

### dsh-model-picker-group（模型选择器合并排版，client 插件）

- 把每个厂商的 "(modlens vision)" 模型**合并进该厂商自己的分组**，紧随原版
  模型之后展示（用户要的"放在一起"效果），而不是两个相邻分组；
- 难点：选择器选中模型时用 `provider = 分组id`、且 modlens 双胞胎的 model id
  与上游相同。客户端三步做安全：① 合并分组时双胞胎 id 改写为
  `<原id> (modlens vision)`（不撞车）；② 把 `current` 改写到合并坐标让高亮
  命中；③ 拦截 `api.sessions.selectModel`，选中双胞胎时改回真实 modlens 包装
  渠道再提交给 host；
- 设置页「模型选择器排版」卡片，开关默认开（localStorage
  `dsh.model-picker-group.v1`），关掉即恢复原排版；
- 与模型管理白名单可组合（白名单关闭时互不干扰）。

### modlens families 扩展为全量

`families` 从 `['deepseek','glm','mimo']` 扩为 9 家，让所有纯文本模型都有
(modlens vision) 版本（modlens 的 shouldWrap 自动排除原生视觉模型与已声明
image 输入的模型，加全量安全）。实测：tokenrhythm 17 个模型全部有 modlens
版本（含 qwen3.7/3.8-max、kimi-k2.5/2.6/2.7-code、minimax-m2.5/2.7、
seed-2.1-turbo/pro）；sennsenova 5 个全部；合计 33 个 modlens vision 模型。

### 验证

- node 端到端测试全过（真实加载 client.js：合并、current 改写、selectModel
  改回、开关关闭透传）；
- 运行中服务实时拉取 llm.models 确认 modlens 分组与模型数量；
- 守卫日志记录恢复/热重建全链路。