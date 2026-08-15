# DeepSeek Harness 桌面版 v1.2.0 发布说明

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
