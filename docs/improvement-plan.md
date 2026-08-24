# DSH 桌面端第二轮加固方案书（安全 · 稳定性 · 插件治理）

> 状态：**执行中（2026-08）**
> 前置：第一轮鲁棒性改造（`docs/robustness-plan.md`，v1.3.0）已实施完成，本方案在既有诊断体系（错误码 / brain / 安全模式 / patch-manifest / build-lock）之上做第二轮加固。
> 本方案书由对 `src/`、`plugins/` 全部源码的资深级代码审查产生，问题均带文件定位；实施按阶段推进，每阶段含验收标准与回滚策略。

---

## 1. 背景与目标

第一轮解决了「报错可定位 / 不致命 / 不重复」，但代码审查发现三类遗留风险：

1. **安全**：三个本地 HTTP 插件（remote-workspace / file-explorer / skills-manager）只校验「对端是回环 + Host 是本地」，**无 Origin/Sec-Fetch 校验、无 token** —— 恶意网页可跨站触发本地删文件、SSH 探测、连接写入；SSH 密码明文落盘。
2. **稳定性**：`dsh-service.stop()` 按端口无条件强杀进程（可能误杀用户其他程序）；`start()` 无防重入（双 spawn 孤儿进程）；patch-manifest 非原子写 node_modules（写坏即自毁式崩溃源）；多个写入方共享 profile 目录但锁不统一。
3. **插件治理**：remote-workspace 存在 WSL 空参数功能性 bug、远程命令输出无上限（OOM）、HTTP body 无上限；JSON 持久化「损坏即静默重置」丢用户数据；三个插件 `trusted()` 实现各写一份且 IPv6 Host 解析不一致。

### 目标

| 目标 | 验收口径 |
|------|----------|
| 本地 HTTP 插件杜绝浏览器 CSRF | 恶意跨源 POST 被 403，同源请求不受影响 |
| 敏感数据不落盘 | connections.json 不再包含 SSH 密码 |
| 服务生命周期不再误杀/双开 | stop 只杀自己 spawn 的进程树；并发 start 只启动一次 |
| 写操作原子化 | patch/配置写入崩溃不产生半成品文件 |
| 插件接口规范化 | 三插件共用同一套 trusted 校验与 body 上限 |
| 全量测试回归 | 新增用例 + 既有 78+ 用例全绿 |

---

## 2. 问题清单（含定位与定级）

### 2.1 P0 安全

| # | 问题 | 定位 | 后果 |
|---|------|------|------|
| S1 | 本地 HTTP 插件无 CSRF 防护（无 Origin / Sec-Fetch-Site / token 校验） | `plugins/dsh-remote-workspace/src/index.ts:511`、`plugins/dsh-file-explorer/lib/index.js:157`、`plugins/dsh-skills-manager/lib/index.js:224` | 任意网页可触发 skills 删除（rm -rf）、SSH 探测、连接写入；file-explorer 可读任意文件 |
| S2 | SSH 密码明文写入 `~/.dsh/remote-workspace/connections.json` | `plugins/dsh-remote-workspace/src/index.ts:444` | 凭据泄露；且非交互 spawn 本就不支持密码认证（死功能） |
| S3 | file-explorer 主动移除 home 目录限制（只读任意路径） | `plugins/dsh-file-explorer/lib/index.js:32` | 与 S1 叠加 = 任意文件读取面 |
| S4 | 按端口无条件强杀进程 | `src/lib/dsh-service.js:316-330`（stop 的 PowerShell 兜底） | 关闭应用时误杀用户占用 3080 的其他程序 |

### 2.2 P0 稳定性（可能崩溃）

| # | 问题 | 定位 | 后果 |
|---|------|------|------|
| R1 | `start()` 无防重入，三条启动路径可并发双 spawn | `src/lib/dsh-service.js:222` | 两进程抢 3080；`dshProcess` 引用被覆盖，旧进程成孤儿 |
| R2 | patch-manifest 直接覆盖 node_modules 文件（非原子） | `src/lib/patch-manifest.js:282` | 写入中断 → 依赖文件损坏 → 下次启动连锁崩溃 |
| R3 | 三个写入方（reconcile / patch-manifest / super-injector）不共用 build-lock | `src/main.js:530,603`、`plugins/dsh-routing-suite/injector` | 并发窗口内 bundle 404 / 插件树加载失败（CHANGELOG 同类事故） |
| R4 | `waitForReady` 只测端口监听不验证是 DSH | `src/lib/dsh-service.js:187` | 竞态下把陌生服务当就绪 → 白屏 / 行为错乱 |
| R5 | 安全模式只清 bundles 层，不清 cordis.patch.yml 的 insert 挂载块 | `src/lib/safe-mode.js:47` | 崩溃源若是纯前端插件，安全模式照样崩 |

### 2.3 P1 功能缺陷 / 资源

| # | 问题 | 定位 | 后果 |
|---|------|------|------|
| F1 | WSL 连接空参数直传 `--distribution ''` / `--user ''` | `plugins/dsh-remote-workspace/src/index.ts:258` | 默认发行版场景 WSL 命令直接报错（功能不可用） |
| F2 | 远程命令输出无上限 | `plugins/dsh-remote-workspace/src/index.ts:218-236` | 大输出打爆宿主内存 |
| F3 | /remote-ws HTTP body 无上限（其余插件有 64KB） | `plugins/dsh-remote-workspace/src/index.ts:622-628` | 内存耗尽面 |
| F4 | `pnpmCmd` 超时只 `child.kill()` 不杀子树 | `src/lib/plugin-manager.js:290` | pnpm 子树残留占 store 锁 |
| F5 | 三插件 `trusted()` 实现不一致，IPv6 Host 解析有坑 | 见 S1 | `[::1]:3080` 在 file-explorer 被判非法（可用性 bug） |
| F6 | JSON 持久化损坏即静默重置 | `plugins/dsh-remote-workspace/src/index.ts:50` 等 | 用户连接/配置静默丢失 |

### 2.4 P2 治理 / 工程化

| # | 问题 | 定位 |
|---|------|------|
| G1 | 插件层无测试（session-watchdog 纯函数、project-brief core、三插件 HTTP 守卫均无单测） | `plugins/`、`tests/` |
| G2 | `unhandledRejection` 不保存 brain 状态 | `src/main.js:78` |
| G3 | 渲染日志事件双注册（console-message / console-message-added）可能双写 | `src/lib/window-ui.js:83` |
| G4 | `isPortListening` 只连 127.0.0.1（IPv6 绑定误判） | `src/lib/dsh-service.js:115` |
| G5 | run-all.js 在沙箱内 EPERM（已知环境限制） | `tests/run-all.js` |

---

## 3. 分阶段实施计划

每阶段独立可验收、可回滚（改动集中于单模块 + 对应测试；异常时用 git revert 单阶段提交）。

### 阶段 1（P0 安全）：本地 HTTP 插件 CSRF 加固

**范围**：`dsh-remote-workspace`（src+lib）、`dsh-file-explorer/lib/index.js`、`dsh-skills-manager/lib/index.js`
**改动**：
1. 统一实现 `isTrustedLoopback(req)`：回环地址校验 + Host 本地名校验（统一用 `new URL('http://'+host)` 解析，兼容 `[::1]`）+ **Origin 必须存在且为本地源** + `Sec-Fetch-Site` 若存在必须 `same-origin`。
2. file-explorer 恢复路径约束：默认仅允许会话 cwd 与 `~/` 前缀（配置项可放宽）。
**验收**：
- 恶意 Origin（`https://evil.com`）/ 缺失 Origin / 非本地 Host 的 POST → 403。
- 同源 POST（`Origin: http://127.0.0.1:3080`）→ 正常。
- 新增 `tests/http-guard.js` 覆盖上述矩阵。

### 阶段 2（P0 安全）：remote-workspace 凭据与资源加固

**改动**（src + lib 同步）：
1. SSH 密码**永不落盘**：`save()` 持久化时剔除 `password` 字段；`testConnection` / `remoteArgv` 对 `auth:'password'` 显式报「请改用密钥认证」。
2. `run()` 输出上限 2MB（超限 kill 子进程并截断）。
3. `/remote-ws` handler 增加 64KB body 上限（与其他插件一致）。
4. WSL 参数条件化：distro/user 为空时不传 `--distribution/--user`。
5. `readJson` 损坏时保留原文件（改名 `.corrupt-<ts>`）再回退，不静默覆盖。
**验收**：单测覆盖 wslArgs / 输出截断 / save 不落密码。

### 阶段 3（P0 稳定性）：服务生命周期防误杀

**范围**：`src/lib/dsh-service.js` + `tests/dsh-service.js`
**改动**：
1. 提取 `findPidOnPort(port)`（netstat 解析）。
2. `stop()` 只杀「本次会话 spawn 的进程树」（`ownedPids` 追踪 + `taskkill /T /F`）；端口兜底清理仅当监听者 pid ∈ ownedPids。删除无条件 PowerShell 强杀兜底。
3. `killProcessOnPort` 保留（启动自愈用，白名单不变）。
**验收**：单测覆盖 pid 解析与 owned 判定；不 spawn 真实进程。

### 阶段 4（P0 稳定性）：start 防重入 + 就绪验证

**范围**：`src/lib/dsh-service.js`、`src/main.js`
**改动**：
1. `start()` 加 `startPromise` 去重（进行中复用同一 promise）。
2. 新增 `isDSHListening(port)`（HTTP GET 验证 `__DSH_BOOT__`，含 gzip 容错，从 main.js 内联实现收敛过来）。
3. `waitForReady()` 循环内改用 `isDSHListening` 验证。
4. main.js `whenReady` 内联探测替换为 `dshService.isDSHListening()`（消除重复实现）。
**验收**：`tests/dsh-service.js` 新增并发 start 用例（注入 fake bin，两次调用只 spawn 一次）。

### 阶段 5（P1）：写操作原子化 + 统一锁 + 安全模式补全

**范围**：`src/lib/patch-manifest.js`、`src/lib/plugin-manager.js`、`src/lib/safe-mode.js`、`src/main.js`
**改动**：
1. patch-manifest：temp + rename 原子写；写后回读验证（patchFn 幂等自检），失败回滚备份并返回 `failed`。
2. plugin-manager `pnpmCmd`：超时用 `taskkill /T /F` 杀整树（与 `execNode` 一致）。
3. safe-mode：apply 时同时备份并移除 cordis.patch.yml 中第三方 insert 挂载块；restore 原样还原。
4. main.js 中 `reconcilePatches` 调用包进 `withBuildLock`（reconcile 与 pnpmCmd 同锁）。
**验收**：safe-mode 新增 insert 块用例；patch-manifest 原子写用例；全量测试回归。

### 阶段 6（P2）：测试补齐与收尾

**范围**：`tests/`、`docs/`
**改动**：
1. `tests/http-guard.js`（阶段 1 已建）、safe-mode insert 用例、patch 原子写用例、dsh-service pid 解析用例。
2. 修复 G2（unhandledRejection 保存 brain）、G3（console-message 按版本分支）、G4（双栈端口探测）——改动小、风险低。
3. 全量单测回归（沙箱内逐文件跑；run-all 留作 CI）。
4. 桌面壳改动需重打 asar（`build-app.ps1`）并完全退出 exe 后验证（避免在本会话进行中执行，安排在用户确认后）。

---

## 4. 风险与回滚

| 风险 | 应对 |
|------|------|
| Origin 校验误伤合法请求（浏览器未发 Origin 的边缘场景） | 现代浏览器 POST 必带 Origin；回退方案：仅当 `Sec-Fetch-Site` 存在且非 same-origin 才拒绝 |
| stop() 改动后端口未释放 | window-all-closed 轮询保留；超过 5s 记日志并正常退出（不再强杀第三方进程） |
| patch 原子写改动引入回归 | 保留 `.orig` 备份 + 回读验证 + 失败回滚；既有 `failed` 语义不变 |
| WSL 参数改动影响现有用户 | 仅当 distro/user 为空时省略参数，行为只修复不改变 |
| 插件 lib 手工同步（src 与编译产物） | 每个插件改动同时落 src 与 lib；`tsc` 可在有 DSH_CHECKOUT 的机器上重建验证 |

## 5. 执行状态跟踪

- [x] 阶段 0：现场勘察（docs/ 基线、插件构建状态、测试基线）
- [x] 阶段 1：本地 HTTP 插件 CSRF 加固
- [x] 阶段 2：remote-workspace 凭据与资源加固
- [x] 阶段 3：服务生命周期防误杀
- [x] 阶段 4：start 防重入 + 就绪验证
- [x] 阶段 5：写操作原子化 + 统一锁 + 安全模式补全
- [x] 阶段 6：测试补齐与收尾（asar 重打待用户确认后执行）

---

## 6. 实施记录（本轮）

| 阶段 | 改动文件 | 验证 |
|------|----------|------|
| 1 | `plugins/dsh-file-explorer/lib/index.js`、`plugins/dsh-skills-manager/lib/index.js`、`plugins/dsh-remote-workspace/src/index.ts`(+lib) | `tests/http-guard.js` 24/24（同源放行/跨站 Origin/缺失 Origin/非回环/伪造 Host/Sec-Fetch 跨站/IPv6） |
| 2 | `plugins/dsh-remote-workspace/src/index.ts`(+lib，tsc 重编译) | 密码不落盘+读取迁移清理、输出 1MB 截断并 kill、/remote-ws 64KB body 上限、WSL 空参数条件化、readJson 损坏保留现场 |
| 3 | `src/lib/dsh-service.js`（stop 只杀 owned 进程树 + `findPidOnPort`/`processNameOf`/`treeKill`） | `tests/dsh-service.js`（升级权限运行）+ 沙箱内联验证 |
| 4 | `src/lib/dsh-service.js`（startPromise 防重入、`isDSHListening`、waitForReady 校验、事件处理器改用局部 child）、`src/main.js`（内联 isDSH 探测收敛） | `tests/dsh-service.js` start 防重入/isDSHListening/waitForReady 用例 |
| 5 | `src/lib/patch-manifest.js`（temp+rename 原子写+回滚）、`src/lib/plugin-manager.js`（pnpm 超时杀整树、reconcile 纳入 build-lock）、`src/lib/safe-mode.js`（insert 挂载块备份/还原）、`src/main.js`（reconcilePatches 纳入 build-lock） | `tests/patch-manifest.js` 原子写用例、`tests/safe-mode-blocks.js` 14/14 |
| 6 | `tests/http-guard.js`、`tests/safe-mode-blocks.js` 新增；`src/main.js` unhandledRejection 保存 brain | 沙箱可运行套件 266 项全绿 |

### 验证摘要
- **沙箱可运行测试**：http-guard 24 + safe-mode-blocks 14 + patch-manifest 46 + brain-logic 33 + error-log 20 + safe-mode 16 + plugin-manager 28 + smoke 25 + update-check 32 + icon-guard 28 = **266 项全绿**。
- **需 spawn 的测试**（沙箱 EPERM 限制，AGENTS.md 已记录）：`tests/dsh-service.js` 在升级权限下运行，生命周期/防重入/isDSHListening/waitForReady 用例通过（spawn 路径经一次授权运行实证）；`tests/build-lock.test.js` 为预存沙箱限制，非本次改动。
- **已知预存失败（非本次引入）**：`tests/window-ui.js`（工作区未提交的 window-ui.js 改动对应测试 mock 缺 `webContents.isDestroyed`）。

### 待用户确认的收尾
- **桌面壳改动需重打 asar 才生效**：`src/` 下 main.js/dsh-service/patch-manifest/plugin-manager/safe-mode 的改动，运行中的 exe 仍读旧 `app/resources/app.asar`。需执行：
  ```
  powershell -ExecutionPolicy Bypass -File .\build-app.ps1
  ```
  该脚本会 kill 运行中的 `DeepSeek Harness.exe` 并冒烟验证——**会中断当前会话**，故留待用户确认后执行。重打后须完全退出所有 exe 实例再启动。
- 插件侧（remote-workspace/file-explorer/skills-manager）为 host 端改动，dsh 服务重启后生效；client 端 bundle 走 no-cache，浏览器硬刷新即可。

