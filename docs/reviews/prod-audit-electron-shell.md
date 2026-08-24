# 生产就绪审计报告 — Electron 桌面壳与核心代码

- 审计日期：2026-08-24（只读静态审计，未修改任何代码/配置，未触碰运行进程）
- 审计对象：`vendor/deepseek-harness-desktop/dsh-plugin-desktop`（DSH Desktop v2.0.2，Electron 43.4.0，当前运行入口 `dist\win-unpacked`）
- 审计范围：壳源码 `src/**`、`package.json`（electron-builder 配置）、`tsconfig*.json`；上游内核仅查端口绑定与 CSP 相关面；未读 dist 产物、lockfile、node_modules 业务逻辑
- 严重级定义：**P0** 阻塞投产 / **P1** 投产前必修 / **P2** 投产后优化
- 证据路径均相对于 `vendor/deepseek-harness-desktop/dsh-plugin-desktop/`（下文简写为 `shell/`）

## 一、概述

该壳不是"Electron 包一个网页"的薄壳，而是一个工程化程度很高的产品级壳：DSH Web 服务以 Cordis Host 形式**内嵌运行于 Electron 主进程**（无独立 DSH 子进程），窗口安全基线、导航锁定、权限白名单、单实例守卫、端口回退、启动失败多层恢复、日志轮转与密钥脱敏均已就位。TS 全严格模式且**零 `any`、零 TODO/FIXME**。

主要短板集中在**发布与供应链侧**：Windows 产物未签名、自动更新下载的安装包无哈希/签名校验、asar 几乎全量解包。本地运行安全（本机攻击面）已做得很细（loopback 同源守卫、关键操作退出保护、崩溃取证）。

---

## 二、逐维度发现

### 维度 1：Electron 安全基线 — 结论：优秀，仅 2 处 P2

**已达标（证据）：**

1. 所有 BrowserWindow 均为安全配置：`contextIsolation:true / nodeIntegration:false / sandbox:true / webSecurity:true`
   - 主壳窗口（兼容+高级两种模式）：`shell/src/window-options.ts:31-37`、`:67-73`
   - 配置创建窗口：`shell/src/profile-create-window.ts:99-105`（另含 `nodeIntegrationInSubFrames:false, webviewTag:false`）
   - 启动恢复窗口：`shell/src/startup-recovery-window.ts:541-547`（同上）
2. 导航锁定：主窗口 `will-frame-navigate` + `will-redirect` 双重 origin 校验，非 `127.0.0.1:<port>` origin 一律 `preventDefault()`（`shell/src/electron-shell-generation.ts:136-160, 187-188`）；辅助窗口 `will-navigate` 全拒 + `will-attach-webview` 阻断（`shell/src/profile-create-window.ts:112-118`；`shell/src/startup-recovery-window.ts:555-562`）。
3. `setWindowOpenHandler`：所有 `window.open` 一律 `deny`，仅 http/https/mailto 转 `shell.openExternal`（`shell/src/electron-shell-generation.ts:191-203`）。
4. 权限白名单：`setPermissionRequestHandler` + `setPermissionCheckHandler` 仅放行 `notifications / clipboard-write / clipboard-sanitized-write`（`shell/src/main.ts:500-506`）。
5. preload 面极小：仅经 `contextBridge` 暴露 `webUtils.getPathForFile`（`shell/src/preload.ts:6-10`）。
6. 壳自有本地 API 有完整的同源+loopback 守卫：变更类请求必须精确 Origin 匹配，只读请求要求 `Sec-Fetch-Site: same-origin` + 同源 Referer，且 socket 地址必须是 loopback、Host 头必须一致（`shell/src/desktop-settings-route.ts:89-103`）；全部路由 POST-only + JSON-only + body 上限（`:221,245,276...`）。`/desktop/critical-busy` 仅接受 `127.0.0.1/::1` 来源否则 403（`shell/src/critical-busy-route.ts:18-21,49`）。
7. 恢复窗口自绘 HTML 全量 `escapeHtml`（`shell/src/startup-recovery-window.ts:349-455`），且三个原生页面均带严格 CSP meta（`shell/src/native-ui/profile-create.html:6`、`recovery.html:6`、`startup-recovery-window.ts:441`）。
8. Windows 生产菜单已 `removeMenu()` 且菜单模板无 DevTools 项（`shell/src/electron-platform.ts:46-63`）。

**发现：**

- **[P2-1] 主 GUI 窗口内容无 CSP。** 主窗口加载 `http://127.0.0.1:43120/`，上游 `@deepseek-ai/dsh-host-webserver`、`dsh-web`、`dsh-web-app` 的 lib 中均未发现 `Content-Security-Policy`（grep 验证），壳层也未通过 `session.webRequest.onHeadersReceived` 注入。缓解因素：内容全部来自本机 loopback、渲染进程已沙箱+隔离。建议：壳层注入兜底 CSP（`default-src 'self'; connect-src 'self'`）作为纵深防御。
- **[P2-2] macOS 生产菜单含 `toggleDevTools`/`reload`/`forceReload` 且未按 `app.isPackaged` 门控**（`shell/src/native-menu.ts:164-176`）。Windows 版不受影响。建议打包构建移除或门控。另：主窗口 `webPreferences` 未显式 `webviewTag:false`（`window-options.ts`），Electron 默认即 false，建议显式声明以防回归。

### 维度 2：进程与生命周期 — 结论：优秀，无阻塞项

**架构要点**：DSH Web 服务内嵌主进程（`DesktopWebServer` 继承上游 `WebServer`，`shell/src/webserver.ts:23`），因此不存在"DSH 子进程崩溃重启/僵尸 DSH"问题；生命周期风险被收敛为渲染进程与壳自身。

**发现：**

1. **windowsHide 覆盖核查（AGENTS.md 铁律）**——全部 spawn 点逐一核对：
   - `profile-materializer.ts:152-157`：`windowsHide:true` ✅（拉 node/pnpm）
   - `desktop-terminal.ts:704-711`：条件化——cmd 兜底路径 `windowsHide:true`（:700）；Windows Terminal/用户终端路径 `windowsHide:false + detached:true`（:676,686-688），这是**有意可见的用户终端窗口**，非闪黑框场景 ✅
   - `electron-runtime.ts:708-713`：NSIS 安装包 `windowsHide:false`——安装向导 UI 本就需要可见，合理 ✅
   - `shell-environment.ts:151-156`：仅 POSIX（zsh/bash/fish + `/usr/bin/env -0`），与 Windows 无关 ✅
   - `bin.ts:91`：CLI 拉起 electron 本体（GUI 子系统，无控制台），`stdio:'inherit'` ✅
   - 结论：**无违规闪框风险**，且每处偏离都有明确语义。
2. **单实例三重守卫**：启动先探测 43120 是否已有活 DSH（`__DSH_BOOT__` 标记）→ 有则直接退出（`shell/src/main.ts:267-285`）；清理 >2min 的陈旧 lockfile 防挂起（`:289-297`）；`requestSingleInstanceLock`（`:298-301`）；`second-instance` 聚焦现有窗口（`:488-491`）。`DesktopWebServer` 初始化时再做一次活体探测（`webserver.ts:42-49`）。
3. **崩溃与重启路径**：`render-process-gone`/`did-fail-load` 上报并触发启动失败流程（`electron-shell-generation.ts:161-179`）；渲染进程连续失败 ≥2 次自动打开系统浏览器兜底（`electron-runtime.ts:440-468`，探测端口后才 `openExternal`，URL 来自内部状态可控）；渲染启动 30s 超时（`electron-runtime.ts:96`）；原生启动恢复窗口 + 安装回滚 + profile checkpoint（`startup-recovery-controller.ts`、`install-recovery.ts`、`profile-checkpoint.ts`）。
4. **退出路径**：分级关闭——首个请求走 Cordis dispose + 5s 强制超时，第二个请求立即退出（`shutdown.ts:61-92`）；SIGINT/SIGTERM/before-quit 全路由（`:123-152`）；关键操作（补丁/安装）期间退出有弹窗守卫（`main.ts:433-451`、`electron-shell-generation.ts:82-123`、`critical-guard.ts`）。
5. **子进程清理**：安装器/终端 `detached+unref` 不泄漏（`electron-runtime.ts:709,725`；`desktop-terminal.ts:727`）；shell 环境捕获超时杀进程组（`shell-environment.ts:157-168`）；profile 物化树杀+超时（`profile-materializer.ts:81-86,156-200`）。
6. **ELECTRON_RUN_AS_NODE 治理**：需要以 node 跑 pnpm/CLI 处显式置 1（`pnpm.ts:459`、`profile-materializer.ts:144`）；给用户的终端环境主动清空该变量（`desktop-terminal.ts:425`、`desktop-cli.ts:22`）——细节到位。
- **[P2-3]** 渲染失败计数与浏览器兜底为进程内状态，壳自身主进程崩溃无自动拉起（设计如此，单机桌面可接受）；建议文档化"主进程崩溃需手动重启"。

### 维度 3：端口管理 — 结论：优秀，无发现

- 默认 43120（`shell/src/desktop-port.ts:4`），冲突时顺序 +1 最多回退 32 个端口，仅对真实 `EADDRINUSE` 重试，失败服务器显式关闭（`webserver.ts:50-64`）。
- **loopback 绑定为三层强制不变量**：`DesktopWebServer` 构造函数非 `127.0.0.1` 直接抛错（`webserver.ts:29-31`）；profile 组装时硬编码 `host:'127.0.0.1'` 并注释"launcher security invariant, not user config"（`profile.ts:805-806`）；壳插件注册时再校验 `ctx.webServer.host`（`index.ts:151-153`）。用户可配端口但**不可配绑定地址**——正确。
- 端口配置经 schema 校验 0-65535（`index.ts:107`）。

### 维度 4：错误处理与可观测性 — 结论：优秀，无阻塞项

- `uncaughtException`：记录后经退出协调器致命退出（`desktop-logger.ts:57-72`，接线 `main.ts:424-428`）；`unhandledRejection` 由上游 `@deepseek-ai/dsh-app-boot` 的 `installFailLoud` 接管（`node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1066-1067`，已验证）；`child-process-gone`（GPU/utility 等）持久化记录（`desktop-logger.ts:38-54`）。
- 日志轮转：单文件 10MB、目录上限 200MB、保留 7 天（`main.ts:328-333`，`log-files.ts` 分段命名）。
- **密钥脱敏**：所有落盘/回显日志经 `maskSecrets`（`desktop-logger.ts:85`），覆盖 sk- 形、Bearer/Basic、Cookie/Authorization 头、敏感 query 参数与命名字段（`mask-secrets.ts:19-61`）。壳源码中未发现任何硬编码密钥（grep 验证）。
- 错误码体系：更新下载有稳定错误分类（`update-download.ts:22-29`）；退出码带 NTSTATUS 十六进制渲染（`desktop-logger.ts:33-35`）。
- 崩溃取证：Crashpad **仅本地** `uploadToServer:false`（`crash-evidence.ts:41-49`）；`active-run.json` 脏关机检测（`main.ts:361-379`）；生命周期事件 JSONL 证据链（`lifecycle-events.ts:22-26`）；一键诊断导出（带超时与体积上限，`diagnostic-export.ts:10-13`）。

### 维度 5：TS 工程质量 — 结论：优秀

- `tsconfig.json:13-21`：`strict:true` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noFallthroughCasesInSwitch` + `noUnusedLocals/Parameters` + `verbatimModuleSyntax`——超严格组合；共 5 套 tsconfig 全部纳入 `typecheck`（`package.json:117`）。
- 全源码 **0 处 `any` / `as any`，0 处 eslint-disable，0 处 TODO/FIXME/HACK**（grep 验证）。
- 接口导向 + 依赖注入缝（测试可替换 `spawn`/`request`），几乎每个导出符号有 JSDoc。
- `prepack` 跑全量门禁：build+typecheck+test+4 项运行时验证+许可证校验（`package.json:116-135`）。

### 维度 6：打包发布 — 结论：最大短板，2 项 P1

- **[P1-1] Windows 产物无代码签名。** `win.signAndEditExecutable:false`（`package.json:349`），`build.win` 无任何证书配置；而 macOS 侧配置了 `hardenedRuntime:true + notarize:true`（`package.json:329-332`）。后果：SmartScreen 拦截/告警、产物可被篡改后无法察觉。对外分发投产前必须补齐签名。
- **[P1-2] 自动更新安装包无完整性校验。** 更新流程：版本探测（严格 SemVer、4KB 响应上限、`redirect:'error'`、`no-store`，`update-checker.ts:98-129`，实现质量高）→ 用户确认 → 下载 → **仅校验容器魔数**（PE 头/DMG `koly` 尾，`update-download.ts:421-456`）→ 直接 `spawn` 执行（`electron-runtime.ts:704-713`）。全文件无哈希/签名（grep `sha256|signature|checksum` 零命中），信任完全押在 `https://www.dshdesktop.cn` 的 TLS 与端点自身安全上（下载请求用 `redirect:'follow'`，`update-download.ts:116`，与版本检查的 `redirect:'error'` 不一致）。缓解项：下载前用户确认 + 确认后再复核一次版本（`update-lifecycle.ts:169-201`）、1GB 体积上限、私有文件权限。修复建议：服务端随版本接口下发安装包 SHA-256（或签名），下载后校验再执行；中长期补 Windows 签名并校验签名链。
- **[P2-4] asar 名存实亡。** `asar:true` 但 `asarUnpack` 覆盖 `lib/**` + `node_modules/**`（`package.json:287-294`），代码几乎全量落盘于 `app.asar.unpacked`（为 koffi 等原生模块所需）。叠加无签名，产物防篡改能力≈0。属已知架构权衡，建议在威胁模型文档中明示，并依赖 P1-1 的签名兜底。
- **[P2-5] `electronFuses.runAsNode:true`**（`package.json:296-298`）：架构必需（以 `ELECTRON_RUN_AS_NODE=1` 复用 exe 跑 pnpm/CLI，`pnpm.ts:459`），但意味着拿到 exe 者可当 node 解释器使用。建议评估其余 fuses（如 `onlyLoadAppFromAsar`）并在安全说明中登记该权衡。
- 版本管理：单一事实源 `package.json` 运行时读取（`electron-runtime.ts:80-86`，当前 2.0.2）；Electron 43.4.0 peer+dev 双锁定（`package.json:254-256,270`）；更新轮询默认启动后 60s、此后每 6h，15s 请求超时（`updates.ts:31-33`）。

---

## 三、亮点

1. **loopback 绑定三层强制**（构造器抛错 / profile 硬编码 / 插件注册复核），端口可配而绑定地址不可配。
2. **单实例三重守卫**（活体端口探测 → 陈旧锁清理 → SILO），覆盖了 lockfile 丢失/残留两种真实故障。
3. **本地 API 的同源+loopback 双重守卫**（`desktop-settings-route.ts:89-103`），在纯本机应用中罕见地认真。
4. **启动失败多层恢复**：原生恢复窗口 / 浏览器兜底 / 受保护安装回滚 / profile checkpoint，互为独立保护层。
5. **可观测性闭环**：轮转日志 + 密钥脱敏 + 生命周期 JSONL + 本地 Crashpad + 脏关机检测 + 诊断导出。
6. **全严格 TS、零 any、零 TODO**，`prepack` 全量门禁；更新检查器的防御式解析（体积上限、严格 SemVer、重定向策略）是教科书级实现。

## 四、投产结论

**有条件通过。**

- 壳层**本地运行安全与工程质量达到投产标准**：无 P0；窗口安全、进程生命周期、端口、错误处理、TS 质量五个维度全部达标或优秀。
- 若投产形态为**对外/公开分发**：必须先完成 **P1-1（Windows 代码签名）与 P1-2（更新产物哈希/签名校验）**——二者叠加构成供应链单点风险（未签名产物 + 仅 TLS 信任的更新通道）。
- 若投产形态为**内网/受控分发**（当前项目实际形态）：可将两项 P1 登记为已知风险与整改计划后投产，P2 五项列入投产后迭代。
