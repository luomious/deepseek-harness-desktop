# DSH 运行时诊断报告：卡顿 / 更新后启动失败 / 旧实例

- 日期：2026-09-07 09:40
- 方法：运行态实测（进程/端口/磁盘）+ 代码级根因扫描 + 关键结论主审复核
- 状态：**只读诊断，未修改任何项目文件**

---

## 〇、三个问题的直接答案

| 问题 | 答案 | 关键证据 |
|---|---|---|
| **打开卡顿** | **是，且会随时间变慢**。会话目录已 372M / 269 个文件，启动时**同步遍历 + 同步 zstd 解压** | `readdirSync(this.root)`；`PublicZstdFrameDecoder` 用 `zstdDecompressSync` |
| **更新后重启失败** | **风险确实存在，且无回滚能力**。更新包**只校验 PE 魔数**（MZ+PE），无哈希无签名；且只有 **1 个 build 目录**，装坏了没有退路 | `update-download.ts:421-454`；dist 仅 `win-unpacked-build202608272104` |
| **打开旧实例** | **会**。发现 **5 个孤儿 crashpad 进程**，且清理代码是**死代码**（永远匹配不到） | `instance-janitor/lib/index.js:104-105` vs `:181` |

---

## 一、运行态实测（现场快照）

| 项 | 实测 |
|---|---|
| 43120 端口 | **无监听** |
| 8787（hy3） | **无监听** |
| DSH / electron 主进程 | **0 个**（应用当前未运行） |
| **孤儿 crashpad** | **5 个**：PID 8128 / 19548 / 28000 / **15960（今天 9:23）** / **19892（今天 9:31）** |
| `dist/`（工作区根） | **不存在** |
| 真实构建位置 | `vendor/deepseek-harness-desktop/dsh-plugin-desktop/dist/` |
| junction | `win-unpacked` → `win-unpacked-build202608272104/win-unpacked` |
| **可用 build 数** | **1 个**（无回滚目标） |
| 更新器残留 | `~/AppData/Local/dsh-plugin-desktop-updater/installer.exe` **127MB**（8/22） |
| 会话数据 | 372M / **269 个文件** / 最大单文件 11.9MB(zstd) |
| `~/.dsh` 总计 | 1.3GB |

> **注**：工作区根的 `dist/` 不存在，说明你日常启动的是 **vendor 下那个 build**（8/27 构建）。
> 若按旧文档在根目录找 dist 会扑空——`PROJECT_README.md` 仍描述旧路径，需更正。

---

## 二、问题一：打开卡顿

### 根因（按影响排序）

| # | 根因 | 证据 | 影响 |
|---|---|---|---|
| **C1** | **启动时同步遍历会话根目录** | 会话持久化补丁 `readdirSync(this.root)`（同一补丁 `:1334`） | 269 个文件 / 372M，遍历成本随会话数线性增长 |
| **C2** | **公共解码器用同步 zstd 解压** | 同补丁 `:456-482`，`PublicZstdFrameDecoder.decode` 内 `zstdDecompressSync(source.subarray(...))` `:468` | 大帧恢复时**阻塞主线程**，表现为界面卡死 |
| **C3** | **前端无节流轮询** | `plugins/dsh-vision-engine/lib/client.js:895` `setInterval(..., 3000)` 每 3 秒全量重渲染 | 运行期持续占用渲染线程 |
| C4 | 启动早期多处同步 IO | `desktop-plugins.ts:226,340` `readFileSync`；`desktop-runtime-environment.ts:132,156,165` `readdirSync`；`electron-runtime.ts:81` | 冷启动叠加 |
| C5 | 插件枚举串行无耗时日志 | `desktop-plugins.ts:403-414` `for...of` 逐包构建清单（无 `Promise.all`） | 37 个 bundle 顺序执行，且**出了慢也无法定位** |

### 为什么"越来越卡"

会话数据只增不减，而 `session-hygiene` 只按**单文件** >4MB 判定：

| 项目 | 数值 | 是否触发告警 |
|---|---|---|
| 单项目会话目录 `--D-Deepseek-Harness--` | **250M** | ❌ 不触发（只看单文件） |
| 最大单文件 | 11.9MB | ✅ 触发（但无自动动作） |
| 会话文件总数 | 269 | — |

→ **250M 的项目目录永远不会被告警**，只有单个文件超 4MB 才提示，且提示后**无自动归档**。

### 建议

| 优先级 | 动作 | 风险 |
|---|---|---|
| **P0** | 会话卫生改为**按目录聚合**告警（>150MB 即提示），并启用自动归档 | 低（只移动不删除） |
| **P0** | 归档当前 250M 项目会话里的旧会话（手动 `scripts/archive-big-sessions.ps1`，默认 dry-run） | 低 |
| P1 | 排查 `PublicZstdFrameDecoder` 是否可在恢复路径改异步 | 中（安全敏感补丁，需单独评审） |
| P1 | `vision-engine` 轮询 3s → 事件驱动或加节流 | 低 |
| P2 | 插件枚举改并行 + 加耗时日志 | 低 |

---

## 三、问题二：更新会不会导致下次重启失败

### 结论：**会，且当前没有任何兜底**

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| **U1** | **更新包只校验 PE 魔数** | `src/update-download.ts:421-454` 只检查 DOS `MZ`(0x4d5a) + PE 魔数 `PE\0\0`；`electron-runtime.ts:708` 随即 `spawn(installerPath, ['--updated','--force-run'], {detached:true})` 执行 | 下载被截断/损坏/被替换的安装包**照样执行**；NSIS 失败后 DSH 侧无兜底 |
| **U2** | **只有 1 个 build，无回滚目标** | dist 下仅 `win-unpacked-build202608272104` | 装坏了只能退回 8/27 版本，而该版本也可能被覆盖 |
| **U3** | **无半安装检测** | `update-download.ts:184-213` `pendingDesktopUpdateArtifact` 只检查"文件还在 + 版本≥当前" | 安装途中关机/强杀 → 下次启动无迁移、无恢复 |
| **U4** | **回滚只覆盖配置，不覆盖应用本体** | `startup-recovery-window.ts:247` "does not restore node_modules" | profile/插件能回滚，应用本体不能 |
| **U5** | **孤儿安装包无人清理** | `~/AppData/Local/dsh-plugin-desktop-updater/installer.exe` 127MB；清理逻辑 `electron-runtime.ts:680-701` 只认 `updates/pending-installer.json` 记录的路径，**该文件不在此路径** | 越积越多，状态脏污 |

### 好消息

- 更新**不是全自动**：`update-lifecycle.ts:174` 需 `confirmDownload` 弹窗，用户点"Restart and Install"才装
- 自动检查可关：`src/updates.ts:30-34` `enabled: true, intervalMs: 6h` → 可设 `enabled: false`
- **无 `quitAndInstall` 调用**（全仓无 `autoUpdater`），不是 electron-updater 标准路径，是自己实现的

### 建议（**单机定位下强烈建议**）

| 优先级 | 动作 | 理由 |
|---|---|---|
| **P0** | **关闭自动更新检查**（`enabled: false`） | 单机模式下无需自动更新；改为"升级日"手动走已验证的构建流程 |
| **P0** | **升级前保留 ≥2 个 build** | 当前只有 1 个，等于没有回滚。`promote-build` 切换前先归档旧 build |
| **P0** | **走本地构建升级，不走在线 installer** | 已有 `package-vendor.ps1` + `promote-build.ps1` + `verify-patches` 完整链路，比在线 installer 可控得多 |
| P1 | 删除 127MB 孤儿 installer.exe | 纯清理，无功能影响（**需你确认**） |
| P2 | 给更新加 SHA-256 校验 | 若继续用在线更新则需做；若走本地构建则不必 |

---

## 四、问题三：打开的是旧实例

### 4.1 已确认的 Bug：crashpad 清理是死代码

`plugins/dsh-instance-janitor/lib/index.js`：

```js
// :104-105 —— 查询集只有两类
$list += Get-CimInstance Win32_Process -Filter "Name='DSH Desktop.exe'";
$list += Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%hy3-gateway%server.js%'";
```

```js
// :181 —— 却在找 crashpad 的命令行特征
if (cl.includes('--type=crashpad-handler')) { ... killPid(pid) ... }
```

**crashpad 的进程名是 `crashpad_handler.exe`**，既不匹配 `Name='DSH Desktop.exe'`，也不含 `hy3-gateway` 命令行
→ **查询结果集里根本没有 crashpad，`:181` 分支永远进不去** → 死代码。

**实测印证**：当前 5 个孤儿 crashpad（含今天 9:23、9:31 新产生的）。

> 这个 bug 已**主审复核确认**（不是代理误报）。

### 4.2 其他旧实例风险

| # | 风险 | 证据 | 表现 |
|---|---|---|---|
| **I1** | **janitor 只在应用运行期工作** | `index.js:239-240` `if (config.sweepOnStart) void sweep(); ctx.setInterval(...)` | 应用不开 → 永不清理 → **孤儿只增不减**（死锁） |
| **I2** | 非 DSH 进程占 43120 → **启动直接失败** | `webserver.ts:56-59` 重试耗尽后 `throw cause` | 表现为"完全打不开" |
| **I3** | 旧代 DSH 占 43120 → 新实例自杀，旧实例存活 | `main.ts:281-284` `app.quit()`；`second-instance` 处理 `main.ts:498-501` 只 `show()` **不杀旧实例** | **"打开的永远是旧实例"** |
| **I4** | 陈旧 lock 有 2 分钟阈值 | `main.ts:294` `Date.now() - mtimeMs > 2*60*1000` 才删 | 2 分钟内快速重启会 `requestSingleInstanceLock` 失败直接退出 |

**I3 很可能就是你说的"打开的是旧实例"**：如果你启动过一次没退干净，再点启动，
新进程探测到 `__DSH_BOOT__` 就自己退出了，把窗口焦点还给旧实例——**旧实例永远不死**。

### 建议

| 优先级 | 动作 | 风险 |
|---|---|---|
| **P0** | **修 janitor 查询**：加入 `Name='crashpad_handler.exe'`（一行） | 低（纯增量查询） |
| **P0** | **清理当前 5 个孤儿 crashpad** | 低，**但需你确认 PID 后执行** |
| **P1** | `second-instance` 时提供"重启为新实例"选项，而非只 `show()` 旧窗口 | 中（改启动链路） |
| **P1** | 加外部看门狗（方案书阶段 1 已规划），解决"应用不开就没人清理"的死锁 | 中 |
| P2 | 陈旧 lock 阈值 2 分钟 → 可配置 | 低 |

---

## 五、修复优先级汇总

| 优先级 | 项 | 类型 | 是否需重启 |
|---|---|---|---|
| **P0** | 关闭自动更新检查 | 配置 | 是 |
| **P0** | 会话按目录聚合告警 + 归档 250M 大会话 | 数据 | 否 |
| **P0** | 修 janitor crashpad 查询（一行） | 代码 | 是 |
| **P0** | 保留 ≥2 个 build 作为回滚目标 | 流程 | 否 |
| **P0** | 清理 5 个孤儿 crashpad + 127MB installer | 运行时 | 否 |
| P1 | `vision-engine` 轮询节流 | 代码 | 是 |
| P1 | `second-instance` 重启选项 | 代码 | 是 |
| P1 | 外部看门狗 | 新增 | 否 |
| P2 | 插件枚举并行 + 耗时日志 | 代码 | 是 |
| P2 | 更新加 SHA-256 | 代码 | 是 |

---

## 六、需要你决策（我不擅自执行）

| # | 事项 | 说明 |
|---|---|---|
| **D1** | 是否清理 5 个孤儿 crashpad（PID 8128 / 19548 / 28000 / 15960 / 19892）？ | 均为孤儿（无对应主进程），低风险，**但按安全守则需你明确同意** |
| **D2** | 是否删除 127MB 的 `installer.exe` 残留？ | 8/22 的安装包，已无 pending 记录 |
| **D3** | 是否归档 250M 项目会话里的旧会话？ | 默认 dry-run 先看清单，确认后再移 |
| **D4** | 是否关闭自动更新检查？ | 单机定位建议关；关后升级走本地构建 |
| **D5** | 是否现在修 janitor 那一行查询？ | 一行改动，但需重启生效 |

---

## 七、一个额外的发现（文档失真）

`PROJECT_README.md` 与部分脚本仍指向**工作区根的 `dist/`**，但实测根目录 `dist/` **不存在**，
真实构建在 `vendor/deepseek-harness-desktop/dsh-plugin-desktop/dist/`。

→ 新会话按文档操作会在第一步就扑空。建议更正文档（方案书 P2 已列"文档对齐"，此项应提前）。

---

*本报告为只读诊断，未修改任何项目文件。所有结论均附实测数据或文件路径+行号。*
