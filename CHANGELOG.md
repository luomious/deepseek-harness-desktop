# CHANGELOG

> DeepSeek Harness 桌面版版本发布记录。
> 合并自 release_notes_v115 ~ release_notes_v130（最新版本在前）。
> 2026-08-21：release_notes_v115~v130.md 已合并入本文档并删除原文件（git 历史仍可追溯）。

---

## 2026-08-24 弹窗根因终结：Ollama 生命周期重写 + 识图引擎切云端（用户决定弃用本地模型）

### 根因（进程监控实证）
「重启后发消息弹 3 个 cmd 窗口」的真凶**不是** dsh 的 spawn，而是 **Ollama 自身**：
`ollama serve` 每次启动（应用启动自启 / 面板切回本地）会拉一批探测子进程
（`llama-server --list-devices`、`ollama gpu-discover` ×2、模型 runner），每个都创建**可见**控制台，
且 Win11「默认终端」把它们路由到 Windows Terminal/OpenConsole 显示（proc-watch.log 全程抓到）。
「发第一条消息看到 3 个」= 启动时自启 ollama 的探测风暴；叠加另一个会话并发跑命令/识图，观感更多。

### 并查实第二个 bug：stopOllama 泄漏（显卡空转元凶）
旧 `taskkill /F /IM ollama.exe` 打不到 `llama-server.exe`（UI 子系统）→ 每次云端↔本地切换泄漏
一个满载模型的 runner：实测残留 3 个孤儿、显存 7.7GB、GPU 70%+ 空转（用户看到的"没识图显卡也在跑"）。

### 修复（`plugins/dsh-vision-engine/lib/index.js`，随 01:14 重启已生效）
| 项 | 内容 |
|---|---|
| `startOllama` 重写 | 改 **wscript+VBS 静默启动**（写 `~/.modlens/ollama-serve-silent.vbs` 后 `wscript //B` 执行，纯 ASCII 源、%LOCALAPPDATA% 展开）；对照实验确认启动风暴期 WindowsTerminal/OpenConsole 托管不再出现；VBS 失败回退直连 spawn。**01:55 用户实测终验**：切回本地完整走一遍启动风暴（7 个探测子进程），零可见窗口（旧路径同场景 3+ 个）；随后切回云端，进程零残留 |
| `stopOllama` 重写 | `tasklist /FO CSV` 枚举 `ollama.exe`+`llama-server.exe` 全部 PID → 逐个 `taskkill /F /PID /T`；实测切换后零残留 |
| 底层追踪 | build2 与旧 dist 的 `dsh-subprocess-local` 补 spawn 追踪（`D:/Deepseek-Harness/spawn-trace.log`）+ 两处 taskkill 补 `windowsHide` |

### 用户决定：弃用本地模型（2026-08-24 01:46）
- 识图引擎切 **百炼 `qwen3-vl-plus`**（p-bailian-vl-plus），实测识别正常（4.4s，描述准确，key 有效）。
- 全部 ollama/llama-server 进程已杀净；**开机自启 `Ollama Serve.vbs` 已删除**（覆盖 08-23"自启永久保留"的旧决定，用户明确不再用本地）。
- 效果：显存 7.7GB→1.1GB，GPU 5%；Ollama 系弹窗与显卡空转从此消失。
- 若将来要回本地：面板切回「本地 Ollama」即可（新代码静默启动 + 干净停止），需重装/保留 Ollama 程序。

### 遗留（不阻塞）
- agent 工具（rg/powershell/taskkill 等）经 dsh 子进程层拉起时，`windowsHide`(SW_HIDE) 在个别场景仍可能被看见一瞬（干净 Electron 父进程对照实验证明参数本身有效，真实应用内差异未完全收敛）。根治原型：`patches/wip/koffi-noconsole-spawn/koffi-final.cjs`（koffi 直调 CreateProcessW + CREATE_NO_WINDOW，管道/退出码已打通，收尾待办）。

---

## 2026-08-24 构建链路统一：单一事实源 + 旧构建归档（根治"补丁打在旧目录/重启无变化"）

- **根因**：打包输出目录是动态的（`package-dir.mjs` 的 `DSH_OUT_DIR`，旧产物被锁定时换新目录，本次为
  `win-unpacked-build2`），而补丁/校验脚本写死了 `win-unpacked` / `win-unpacked-new` 路径 → 重建后补丁打到旧目录，
  运行中的新构建没打补丁 → 重启无变化。
- **修复**：新增 `scripts/resolve-dist.mjs` 单一事实源（与 `update-shortcuts.ps1` 同源：dist 下最新
  `DSH Desktop.exe`）；`port-user-patches.mjs` / `apply-winhide-patches.mjs` / `verify-patches.ps1` /
  `verify-features.ps1` / `rebuild-and-restart.ps1` 全部改为通过它解析构建目录，不再写死 dist 路径。
- **归档**：旧构建（`win-unpacked`、两个 `win-unpacked-new`、`.icon-ico`）统一移入
  `_backups/dist-archive/20260824-014115/`；dist 仅保留当前 `win-unpacked-build2`。
- **端口澄清**：新壳默认端口 = `43120`（`src/desktop-port.ts` `DESKTOP_DEFAULT_WEB_PORT`），非动态；
  旧壳 `3080` 已退役。
- **文档**：重写 `docs/BUILD.md`；新增 `docs/README.md` 索引（区分当前有效 / 历史归档）；
  `PRODUCTION-UPGRADE-PLAN.md` 加状态更新 banner；`AGENTS.md` 策展区"当前入口"改为 build2。
- **模型补丁恢复（0.1.1-rc.2 迁移"待跟进"项清零）**：`dsh-client-ui-settings-models` 的「获取可用模型」弹窗
  筛选（`pickQuery` 按名称/ID 过滤 + 无匹配空态 + **默认全不选**）与「模型目录」搜索（`filterModels` 双编辑器
  catalogQuery）均已重新实现；`dsh-host-frontend-static` 补回 no-cache；canon 存 `patches/bundles/`，接入
  `port-user-patches.mjs`（重建后重跑即恢复）。审计确认其余旧补丁已迁移或自动退役（serve-bundle-retry 目标代码
  重构消失、node-pty 上游已内置 try/catch、client-bundle-retry 前端已切 Vite、modlens/safe-delete 目标已不存在）。

---

## 2026-08-23 弹窗治理 + 退出保护机制 + Ollama 自启 + 生产上线方案（详见 docs/PRODUCTION-UPGRADE-PLAN.md）

- **弹窗治理（windowsHide ×8）**：插件 3 处（vision-engine 读图 / autoread 读图 / project-brief git）+ 桌面应用 4 处（dsh-subprocess-local / profile-materializer / open / default-browser）+ 源码 1 处（profile-materializer.ts）。启动 / 切换视觉模型 / 读图 / 打开外链全程无黑框（实测 hwnd=0）。
- **Ollama 开机自启**：VBS 隐藏启动（window 0）+ 环境变量；自启**永久保留**（切云端配置不删 VBS，只停进程，切回自动重启）。
- **退出保护机制（critical-guard）**：新建 `src/critical-guard.ts`、`src/critical-busy-route.ts`（`POST /desktop/critical-busy`，仅 loopback）；`shutdown.ts`/`main.ts`/`electron-shell-generation.ts`/`index.ts` 接入。busy 时点 ✕ 或退出会弹窗提醒，防止强制退出损坏配置。`tsc --noEmit` ✅，**待重建生效**。
- **koffi 报错定位**：`win-unpacked-new` 构建写入时序竞态（构建中打开 exe 读到半成品），非关闭导致；koffi 本体正常（3.1.5 实测）。预防：构建完成后等 1 分钟再启动。
- **生产上线方案**：`docs/PRODUCTION-UPGRADE-PLAN.md`（P0-P3 分阶段 + 防误删/防崩溃/回滚基线 + 重建验收清单）。
- **P1 执行（2026-08-23）**：修复 `~/.dsh/.agent-presets/router-standard/router-bootstrap.mjs` 缺失的 `bandOf`/`extractText` 模块导入（根治会话监听器 `ReferenceError` 刷日志，并恢复路由预设的弱模式引导功能）；bandof-diag 降级为安全 no-op（诊断完成，待下次重启后卸载）；新增 `scripts/apply-winhide-patches.mjs`（幂等重打 dist 级 windowsHide，覆盖 dev node_modules + 两个 dist）；web-fetch SSRF 审查达标（DNS 全解析防 rebinding / 全私网段 / 每跳重定向复查 / 1MB 上限，无需改动）。

## 2026-08-23 安全审计与加固 + 前端刷新/图标修复（详见 docs/migration-audit-2026-08-22.md §8）

- **安全审计**：4 高危/5 中危/8 低危。修复 H1 注入器任意目录删除（包名白名单）、H2 注入器 API CSRF（Origin 校验）、H3 vision-engine 任意文件读（路径规范化）、H4 staging RCE（默认禁用 DSH_STAGE_RESTORE=1 门禁）、M1 file-explorer 路径逃逸（realpath）、M2 remote-workspace ssh/docker 参数注入（assertSafeTarget）、M3 远程目录列举引号 bug、M4 context-lifecycle CSRF。
- **误删防护机制**：`scripts/guard-destructive.ps1` 危险命令守卫（递归删除仅限工作区内、盘根/通配符拦截；自检 7/7）。
- **前端刷新**：桌面壳 Windows 无应用菜单（removeMenu）→ Ctrl+R 从未注册；新增 `dsh-frontend-reload` 插件（右下角刷新按钮 + Ctrl+R 页面内兜底，已装 desktop+web）。
- **桌面图标空白修复**：快捷方式 IconLocation 指向已归档的 src\assets\icon.ico → 改指 legacy\src\assets\icon.ico。
- **验证**：功能终核脚本 `scripts/verify-features.ps1` 26/26 通过。

## 2026-08-23 合并迁移后功能修复：远程连接/「不在项目中工作」还原 + 插件兼容适配 + 迁移审计（详见 docs/migration-audit-2026-08-22.md）

### 现象
新会话「添加工作区…」处的 **SSH 远程连接** 与 **「不在项目中工作」** 功能消失；部分插件（file-explorer/system-notify 等）不工作。

### 根因（三层）
1. **核心客户端补丁未移植到新壳**：旧壳 patch-manifest.js（13 项，启动自愈）随 src/ 归档 legacy/；新壳用自己的打包 dsh（0.1.1-rc.2，app.asar.unpacked），其 ui-workspace/ui-conversation bundle 不含 remoteFlow 洞、不在项目中工作菜单、纯聊天标签。
2. **dsh-remote-workspace trusted() 硬编码 3080**：新壳端口不固定（43120）→ /remote-ws 全 403 → host API 整体失效（同族 4 插件已修，唯独漏它）。
3. **0.1.1-rc.2 的 remoteFlow 洞只声明不渲染** → 需补 ADD_REMOTE 入口 + 渲染。

### 修复
| 模块 | 说明 |
|---|---|
| 核心 bundle 补丁移植 | dsh-client-ui-workspace：remoteFlow 洞 + ADD_CHAT（不在项目中工作）+ ADD_REMOTE（远程连接入口+渲染，还原 rc.7 UX），保留新壳 drop-target 补丁；dsh-client-ui-conversation：纯聊天标签。dev/打包/canon 三副本一致 |
| modlens 无缝接管补丁 | desktop profile 补上（与 web 对齐），粘贴不再误转路径 |
| dsh-remote-workspace 适配 | trusted() 动态端口；tools.register 包 ctx.effect；client 类型适配（SlotRegistry/connectWorkspace/sessions 注入）；verify-core 15/15 |
| 补 cordis.patch.yml | remote-workspace/file-explorer/system-notify（web 自动装配流用） |
| super-injector 兼容 | dev_plugin_status loadCache 崩溃修复（可选链，TS 源+两份 lib） |
| 装配补漏 | dshmarket 补进 desktop profile bundles（web 有、desktop 漏） |
| 记录 | docs/migration-audit-2026-08-22.md + scripts/port-user-patches.mjs（幂等重打） |

### 生效
- modlens 与 profile 装配：需完全退出桌面应用重开（遵守重启守则，等用户指示）；bundle 改动刷新浏览器即生效。
- 重启后预期：添加工作区菜单出现「不在项目中工作」「远程连接…」；dev_plugin_status 正常；桌面版粘贴图片不再变路径。

### 待决策
maid-atelier 皮肤双处禁用（无决策记录，当前保持禁用）；settings-models 搜索等 4 个旧补丁是否迁移；补丁固化机制（建议并入 vendor yarn patches/build 流程）。

---

## 2026-08-22 dsh 0.1.1-rc.2 升级后遗症修复：modlens 粘贴路径 + 启动自愈前移 + 核心补丁适配

### 现象
- 「继续版本更新」（npm 全局 dsh 0.1.0-rc.6 → **0.1.1-rc.2**，registry 最新）后，modlens 再次出现「粘贴只显示图像路径」；
- 点击桌面 exe 时桌面窗口与浏览器网页版同时在场；
- npm view / npm install 报 EPERM（写缓存目录被拒）。

### 根因（三层叠加）
1. **modlens 无缝接管补丁丢失**：`~/.dsh/profiles/web/node_modules/@liustack/modlens/dsh/index.js`
   的 `pasteTakeoverVerdict` 被重装覆盖（`dsh-vision-engine 无缝接管补丁` 标记消失）；且该清单项
   （`modlens-takeover-verdict`）只存在于工作区源码——**运行中的 app.asar（08-21 17:06 打包）根本不含此清单项**，
   即使启动时跑自愈也不会打上。
2. **自愈被端口占用跳过**：main.js 里 `reconcilePatches` 原先只在「端口空闲 → 自启服务」分支执行；
   3080 已被占用（网页版/残留进程）时整段跳过 → 升级覆盖的文件永远不会重打。
3. **实证**：`GET /modlens/paste?model=deepseek-v4-flash-0731` 返回 `{"takeover":true}`
   （纯文本模型被误判接管 → 客户端把粘贴转成路径文本）；`mimo-v2.5`/`glm-4v-flash` 返回 false。

### 修复
| 模块 | 说明 |
|------|------|
| modlens 补丁落盘 | 运行 `reconcilePatches` 成功打上 `modlens-takeover-verdict`（幂等验证 ok） |
| `src/main.js` | 原生目录选择器补丁 + `reconcilePatches` 移到端口检查**之前**，空闲与否都执行（幂等），根治「升级后补丁永不重打」 |
| patch-manifest 适配 0.1.1-rc.2 | `dsh-core-frontend-static-nocache` 锚点更新（`MIME[...] ?? ...` 已收敛为 `type` 变量，writeHead 行唯一）；`dsh-core-client-bundle-retry` 自动退役（前端改为 Vite modulepreload + 动态 import / `vite:preloadError`，旧 `<script>` 加载器已移除；瞬态 404 由服务端 `dsh-core-serve-bundle-retry` 兜底） |
| `src/lib/window-ui.js` | `setWindowOpenHandler`：DSH 自身 URL 的 `window.open` 改为主窗口内打开，杜绝「点链接又弹一个浏览器网页版」的双开表象 |
| second-instance | 唤起时补齐 `show()`（隐藏/最小化窗口也能被重新唤起） |
| 测试 | `tests/patch-manifest.js` 清单计数 12→13（新增 takeover 项）、临时样本补新锚点 → **64 项全绿** |
| npm EPERM | 确认为 DSH 沙箱（workspace-write）拦截所致，非缓存损坏；完整权限下 `npm view` 正常（最新 0.1.1-rc.2） |
| 待跟进（非致命） | `dsh-core-settings-models-search / fetch-search` 两补丁锚点在 0.1.1-rc.2 已重构（CSS 键改字母序、弹窗新增全选/取消全选按钮），当前报 PATCH-001 但不影响功能；需对新 bundle 重新推导约 18 组锚点后更新（本次未动，避免在无回归验证下盲改压缩产物） |

### 「同时打开桌面版和网页版」结论（初判有误，以补充章节为准）
- 初判：桌面壳代码里没有 `openExternal` 直开浏览器的路径（全仓仅菜单/外部导航/弹窗三处），
  开机启动项（Startup + 注册表 Run）也无 dsh/网页版条目，因此曾归结为"浏览器标签已存在 + 3080 服务共享"。
- **此结论不完整**：真正的元凶是 `dsh web` 启动时默认 `openBrowser: true` 会**自动打开默认浏览器**，
  桌面壳 spawn 时未传 `--no-open`。详见下节「补充（同日二次排查）」。修正后：`dsh-service.js` 已传
  `--no-open`，点 exe 不再自动弹网页版；单实例锁仍只约束桌面实例。

### 生效方式
modlens 是服务端插件，**必须完全退出桌面应用后重新打开**（禁止 `dev_reload_package` 热重载）。
重启后验证：`GET /modlens/paste?model=deepseek-v4-flash-0731` 应返回 `{"takeover":false}`，粘贴直接显示图片。

### 补充（同日二次排查）：双开真因 = dsh web 自动开浏览器；粘贴"路径"为旧文本残留
- **双开真因**：`dsh web` 启动默认 `openBrowser: true`（dsh-web-app `startup.js`，日志明示
  "opening the default browser; pass --no-open to disable"），桌面壳 spawn `node bin.js web` 时
  **未传 `--no-open`** → 每次点 exe 启动服务都会自动打开浏览器网页版。修复：`src/lib/dsh-service.js`
  `start()` 改为 `['web', '--no-open']`（桌面版自带窗口，不再外弹浏览器；想用网页版可手动开
  `http://127.0.0.1:3080`）。`dsh web --help` 实测确认该参数存在。
- **粘贴"还是路径"实证**：重启后（02:37）`GET /modlens/paste?model=deepseek-v4-flash-0731` 已返回
  `{"takeover":false}`，且 `C:\Temp\modlens-dsh-paste` 重启后**没有任何新目录**（最新 `p-e1qmID`
  创建于 02:36:59，即旧实例被杀前 6 秒）→ modlens 已不再把粘贴转路径。用户看到的"路径"是
  **旧路径文本残留在输入框/历史消息里**（02:18 与 02:36:59 两次旧代码转换的产物）。vision-engine
  粘贴预览（focusin/input/900ms 轮询 + `/vision-engine/paste-img` 回源 200）会在输入框聚焦时把
  路径渲染成图片卡；历史消息里的裸路径文本属正常显示（消息区不做回源）。
- **窗口区分**：`window-ui.js` 桌面窗口标题追加「（桌面版）」后缀，与浏览器网页版一目了然。

---

## 2026-08-22 更新兼容性机制：更新前评估风险 / 更新后自检 / 一键回滚（v1.4.0 开发中）

> 起因：0.1.0-rc.6 → 0.1.1-rc.2 升级后 modlens 失效、粘贴显示路径复发。为「防止再次出现更新后无法正常使用」，
> 给检查更新流程加了完整的安全网。更新检查现在分三步：**先评估 → 再安装 → 后自检（可回滚）**。

### 新机制
| 阶段 | 模块 | 说明 |
|------|------|------|
| 更新前评估 | `src/lib/update-compat.js`（新增）+ `update-check.js` | 用户点「立即更新」后先弹「更新前兼容性检查」：版本跨度（主/次/rc→正式版）、当前补丁自愈健康度（`probeManifest` 只读探测，不写盘）、新版本 Node 引擎要求（registry 尽力而为）、磁盘空间；结论分 通过/有注意事项/高风险，高风险默认按钮为「取消」 |
| 补丁只读探测 | `patch-manifest.js` 新增 `probeManifest` | 与 `reconcilePatches` 同清单、只读不写盘，评估与自检共用 |
| 更新后自检 | `update-check.js` + `update-compat.js` | 安装并校验版本后自动跑自检：补丁健康 + 服务就绪（端口/`__DSH_BOOT__`）；异常弹窗提示，可**一键回滚到旧版本**（`npm install -g @deepseek-ai/dsh@<旧版>` + 重启服务 + 重载 UI）；「稍后重启」路径在服务重启后再补跑一次含 HTTP 的自检（UPD-002 记录） |
| 注入方式 | `main.js` | `createUpdateCompat({ profileDir, execNode, findNpmCli, dshService, errorLog })` 注入 `assessCompatibility / postUpdateSelfTest / rollback`；未注入时 update-check 默认跳过，原流程完全兼容（测试全走默认路径验证） |
| 错误码 | `UPD-003`（回滚）、`UPD-002`（重启后自检异常） | 与既有 UPD-001 一起进诊断日志 |

### 测试
- `tests/update-compat.js`（新增）：parseVersion / satisfiesNode / assessUpdate 9 类场景（补丁级 ok、次版本 warn、主版本 block、rc→正式版 warn、补丁失效 warn、Node 不满足 block、磁盘过小 block/偏少 warn、引擎缺失 skip）/ probeManifest 只读不写盘 / rollback 参数 → 30 项全绿。
- `tests/update-check.js` 扩展 4 个分支：兼容性高风险取消、兼容性通过继续更新、自检异常继续使用、自检异常一键回滚 → 42 项全绿。
- `tests/run-all.js` 纳入 update-compat → **15/15 文件全绿**。

### 使用体验
- 更新前：弹窗展示风险清单（如「次版本升级，自愈补丁需重新验证」「磁盘不足」「Node 版本不满足」），用户可「仍然更新 / 取消」；
- 更新后：自检发现异常时弹窗给出「继续使用新版本 / 回滚到 <旧版本>」，回滚全自动完成；
- 静默检查（启动时）不弹窗，仅系统通知，行为不变。

---

## 2026-08-21 modlens 视觉体系重构：本地引擎 + 自动读图 + 选择器精简（v1.4.0 开发中）

### 背景
`(modlens vision)` 包装模型在密集截图（如整页模型列表）上无法识别图片：
根因是智谱 `glm-4v-flash` 输出硬上限 1024 token，密集截图的结构化 JSON 被截断
（`finish_reason=length`），modlens 解析失败；claude-cli 兜底因额度 402 失效。

### 变更
| 模块 | 说明 |
|------|------|
| 本地视觉引擎 | 部署 Ollama 0.32.15 + `qwen2.5vl:7b`（模型存 `D:\ollama-models`，VBS 隐藏开机自启）；modlens `openai` 槽指向 `http://localhost:11434/v1`，`extraBody={"max_tokens":4096}` + `structuredOutput=true`（修复 7B 偶发不守 JSON schema）。实测：普通图 8s、密集截图 45s 内，4 类图全部通过 |
| 新厂商纳入 | modlens `families` 加入 `gpt`（cordis.patch.yml + dsh-modlens-guard 同步），duoyuanx 的 gpt-5.x 获得 `(modlens vision)` 包装 |
| 自动读图插件 | 新增 `plugins/dsh-modlens-autoread`：`agent/pre-step` 自动判定当前模型模态（`inputModalities`），纯文本/未知模型发照片时自动调 modlens 读图（支持图片块 + pasteToPath 路径两种入口），无需再选 `(modlens vision)` 双胞胎；同一图片缓存、异常 fail-open |
| 选择器精简 | `dsh-model-picker-group` 新增「隐藏 (modlens vision) 双胞胎」开关（默认开），选择器只显示普通模型；当前正在使用的双胞胎保留显示直至切换 |
| 文档整理 | `release_notes_v115~v130.md`（10 个）合并进 CHANGELOG 后删除；`modlens-free-engines.md` 更新为本地引擎状态与切换命令 |
| 清理 | `.gitignore` 补 runtime 数据/构建产物规则；untrack 守护插件 `.map`/`.d.ts`/`events.jsonl`；watchdog 空转日志节流（30s→10min 一条） |

### 模型管理列表隐藏 modlens 双胞胎（同 08-21 精简方向）

- 现象：设置 → 模型 → 模型管理（`dsh-model-whitelist`）里仍列出全部 `(modlens vision)` 双胞胎（如 duoyuanx 的 gpt-5.x 双胞胎），与选择器「隐藏双胞胎」（默认开）不一致。
- 根因：模型管理面板走 `llm.models` 读**全量原始目录**（未过 `api.sessions.models` 的 picker 包装层），其 `mergeGroups` 只做同源合并、从不过滤双胞胎条目；“隐藏双胞胎”逻辑只存在于 `dsh-model-picker-group`（仅包 `sessions.models`）。modlens 因 `dsh-modlens-guard` 保持启用，双胞胎持续注册。
- 修复（`plugins/dsh-model-whitelist/lib/client.js`，浏览器硬刷新生效，无需重启服务）：
  - `mergeGroups` 按 `model.name` 含 `(modlens vision)` 过滤双胞胎，并丢弃过滤后为空的纯包装分组；
  - 「全选」/总数/「已选」计数只统计可见条目；
  - 「确定」提交时仅剔除存储里残留的双胞胎 key（目录暂缺的厂商 key 原样保留）。

### 图片识别模型设置面板（`@dsh-external/dsh-vision-engine`，v1.4.0 开发中）

- 新增插件 `plugins/dsh-vision-engine`：设置 → 「图片识别模型」面板（order 13），解决「想换识别引擎只能手改配置/敲命令」的痛点，并回答「粘贴为什么显示路径」。
- 功能：
  - **多配置管理**：本地 Ollama / API 预设（智谱 GLM-4V / 阿里百炼 Qwen-VL / 硅基流动 / Gemini / 自定义 OpenAI 兼容），增删改 + 一键「设为当前」；切换即写 `~/.modlens/config.json` 对应 provider 槽（读-改-写保留 extraBody/structuredOutput），下一次识别立即生效（CLI 每次读配置）；
  - **测试识别**：拖图/选图 → host 跑 modlens CLI → 显示耗时/摘要/OCR 预览，并记账；
  - **额度监控**：渠道余额尽力而为（硅基 /user/info、智谱 balance、百炼 /api/v1/token，失败降级显示「渠道未提供公开额度接口」；本地显示「本地推理，无 API 额度」）+ 本机用量统计（今日/近7天/累计，按配置分组，数字滚动动画）；用量由面板测试 + `dsh-modlens-autoread`（新增受保护动态导入 `recordUsage`，缺失时静默跳过）记账；
  - **粘贴模式说明**：展示当前 `pasteToPath` 状态并解释「粘贴显示路径」原因；
  - **特效 UI**：渐变发光激活卡、状态点脉冲、测试 shimmer、卡片浮入、hover 上浮、数字滚动（纯 CSS + rAF，无性能风险）。
- 安全：apiKey 只在 host 侧读写，浏览器只见「已保存/未设置」；额度/测试请求全部 host 发起；写配置前重读文件防与 modlens 自带卡互覆盖。
- 生效：host 路由已热挂载（`/vision-engine/config|test|usage|balance|ollama`）；**client 面板需完全退出桌面应用重开（新插件进 boot graph 必须重启）后硬刷新**。

### 图片识别模型 v2：图形化监控 + 免费模型配置 + 粘贴图片预览（同 08-21）

- **额度/用量图形化**：渠道余额大数字 + 今日成功率环形仪表（SVG 渐变圆环动画）、近 14 天识别量柱状图（成功绿/失败红，逐根生长动画）、按配置横向进度条（失败红色段），数字全部滚动动画；数据来自 `/vision-engine/usage` 新增的 `series` 日序列。
- **预置免费多模态模型配置**（已写入 `~/.modlens/vision-engine.json` 并激活其一，同步写入 modlens 配置）：
  - `qwen3.7-flash-2026-07-15`（用户提供 key，已激活，接口地址按硅基流动）
  - 硅基流动免费视觉：`Qwen/Qwen2.5-VL-7B-Instruct`、`Qwen/Qwen2.5-VL-3B-Instruct`、`Qwen/Qwen2-VL-7B-Instruct`、`THUDM/GLM-4V-9B`（同一 key）
  - 智谱 `glm-4v-flash`（免费，模板，留空待填自己的 key）
  - 本地 Ollama（当前收编，可一键切回）
  - ⚠️ 接口地址按硅基流动假设，若 key 属其他渠道，在面板「编辑」改 baseUrl 或反馈后调整。
- **粘贴图片预览**：composer 出现 `modlens-dsh-paste` 路径时，在输入框上方渲染原图缩略卡（host 新增 `GET /vision-engine/paste-img`，仅允许读 paste 根目录防任意文件读取；卡上 × 可移除并同步清路径文本）。路径文本仍保留（它是自动读图的触发信号），但视觉上看到的是图片。

### 图片识别模型 v3：修复与增强（同 08-21）

- **修复配置名乱码**：此前 PowerShell 5.1 发送 JSON 用非 UTF-8 编码导致中文配置名落盘损坏；改为 UTF-8 字节体重写 9 个配置，已逐项验证落盘中文正确。
- **key 渠道探测（结论）**：用服务端网络对用户 key 实测——硅基流动 `/user/info` HTTP 401、智谱 balance HTTP 401、百炼 token HTTP 404 → **该 key 不属于这三家或已失效**。当前引擎切回本地 Ollama 保底；修复需用户提供正确渠道/baseUrl 或有效 key（面板「测试识别」验证）。
- **粘贴预览可点击放大**：点击缩略卡弹出全屏灯箱（点击/Esc 关闭），不再“点不开”。
- **配置列表按厂商分组**：同一厂商一个卡片（栏），栏内下拉直接切换该厂商的其它模型（立即设为当前），每模型行保留 编辑/删除；激活组带发光动画。
- **新增免费渠道模板**：智谱 `glm-4v-flash`（免费）、Google Gemini 2.5 Flash（免费额度，AI Studio 领 key）、OpenRouter `meta-llama/llama-3.2-11b-vision-instruct:free`（OpenRouter 领 key）；硅基 4 个免费视觉模型保留。key 留空待用户填写。

### 模型选择器「无缝接管」：默认 modlens 版本，粘贴即图片（同 08-21）

- 背景：粘贴显示路径的根本原因是当前对话模型未声明图片输入（DSH 服务端准入硬拦图片块）。modlens 的 `pasteToPath`（路径文本 + 自动读图）是纯文本模型的唯一通道；`(modlens vision)` 双胞胎声明了图片输入所以粘贴显示原生图片。
- 改造 `plugins/dsh-model-picker-group`（浏览器硬刷新生效，无需重启）：
  - **选择器只显示普通模型一个版本**（不再显示 `xxx (modlens vision)` 双胞胎条目，也删除「隐藏双胞胎」开关与旧丢弃逻辑）；
  - **无缝接管**：选中任何普通模型时，`selectModel` 静默改写为它的 modlens 渠道（`plainMap` 按 provider+model 命中）→ 会话模型 = modlens 版本（声明图片输入）→ **粘贴直接显示图片**（原生缩略图，可点开），发送时 modlens 自动读图；
  - `current` 改写到上游坐标（无 `(modlens vision)` 后缀），选择器高亮/标签显示普通名；
  - 孤儿 modlens 组（上游不在场，如白名单只勾 modlens 版本）仍以厂商名独立成组可正常选中；`enabled` 总开关保留（关闭即恢复原始列表）。
- 验证：mock 加载 bundle 断言通过（分组无双胞胎条目、current 改写无后缀、孤儿组正常）。

### 无缝接管·实战修复与教训（同 08-21）

- **现象**：接管后（选择器显示普通名、会话已切到 modlens 包装）粘贴**仍是路径**；MiMo-V2.5 却能原生贴图。
- **根因链（三层）**：
  1. modlens 只包装 **DeepSeek/GLM 家族的纯文本模型**（其 README 明文）——MiMo-V2.5 是**原生视觉模型**（xiaomi 渠道，DSH 准入直接放行图片），根本不在接管范围内；
  2. 接管成功后会话模型 = `modlens-<provider>`（声明 `image` 输入，DSH 准入放行图片块）✓，但 modlens **浏览器端**的粘贴判定按**选择器 label（模型名）**走 `GET /modlens/paste?model=<label>` → host `pasteTakeoverVerdict`：label 无 `(modlens vision)` 后缀 → 扫描普通 provider 匹配到同名纯文本模型 → `takeover:true` → **客户端把粘贴转成路径**；
  3. **补丁**：modlens `dsh/index.js` `pasteTakeoverVerdict` 开头增加——label 中的模型名若命中 modlens 自己包装 provider（`ownProviders`）里的模型，直接 `return false`（原生粘贴）；已登记 patch-manifest 自愈条目 **`modlens-takeover-verdict`**（dsh 升级覆盖后自动重打）。
- **坑 1（本次卡死根因）**：对 `@liustack/modlens` 执行 `dev_reload_package` 热重载会**丢失 adapter 注册** → 会话切到 `modlens-xxx` 时报 `no adapter registered for provider "modlens-tokenrhythm01"` → 服务卡死。**modlens 是服务端插件，代码改动一律重启应用，禁止热重载**。
- **坑 2**：原生视觉模型（MiMo-V2.5 等）贴图正常≠接管生效，排查时勿混淆。
- **新增诊断设施**：picker-group 每次处理模型目录/切换模型时自动上报到 `~/.modlens/picker-diag.log`（POST /vision-engine/diag，host 落盘），无需用户抄控制台；日志含 groups 列表、modlens 组、接管映射条数、select 命中/未命中。

### 配置速查
- modlens：`~/.modlens/config.json`（openai → localhost:11434/v1 / qwen2.5vl:7b）
- Ollama：`%LOCALAPPDATA%\Programs\Ollama`，模型在 `D:\ollama-models`，`OLLAMA_MODELS`/`OLLAMA_CONTEXT_LENGTH=8192`
- 切回智谱/百炼命令见 `modlens-free-engines.md`

---

## 模型管理增强：获取可用模型弹窗搜索（v1.4.0 开发中 · 补丁层）

> 设置 → 模型 → 提供方「获取可用模型」弹窗（「选择要添加的模型」）新增候选模型搜索栏。

### 变更

| 功能 | 模块 | 说明 |
|------|------|------|
| 弹窗搜索栏 | `patch-manifest.js`（`patchSettingsModelsFetchSearch`） | 候选列表上方全宽搜索框（复用 `modelSearch` 胶囊样式），按模型名/ID 相关度过滤并重排；无匹配显示空态 |
| 状态管理 | 同上 | 弹窗打开/关闭自动清空搜索词；**默认全不选**（不再把目录中没有的模型全部预勾选），只勾选手动选择要添加的模型 |
| 勾选反馈 | 同上 | 底部「添加所选」按钮实时显示已勾选数量（如「添加所选 (3)」） |
| 自愈 | 同上 | 登记 `dsh-core-settings-models-fetch-search` 清单项，`dsh` 升级覆盖后启动自动重打 |

### 测试

- `tests/patch-manifest.js`：弹窗搜索补丁用例扩展到 11 条（含「默认全不选」「v1→v2 迁移」）；清单集成计数为 12 项（6 applied + 2 ok + 4 skipped，幂等后 8 ok）。共 63 条全过。

### 生效方式

改的是全局 client bundle，**无需重启服务**，浏览器硬刷新即可（客户端 bundle 按请求读盘 + no-cache）。

---

## 插件中心（v1.4.0 开发中 · 源码层，未打包）

> 借鉴 `fufankeji/deepseek-harness-studio` 的插件发现/热点/推荐能力，以「不引入上游源码、不破坏现有鲁棒性工程」为前提落地。方案见 `docs/plugin-center-proposal.md`。

### 新增功能

| 功能 | 模块 | 说明 |
|------|------|------|
| 插件目录/发现 | `src/lib/plugin-catalog.js` | npm registry 搜索（keywords:dsh-plugin），归一化 + 人气/近期排序 + 内存缓存(TTL) + 优雅降级（任何失败返回空列表/旧缓存，绝不抛异常） |
| 一键安装 | `src/lib/window-ui.js` | 「发现插件」标签页：浏览/搜索/一键安装，复用既有安全安装（无 shell + 包名白名单） |
| 热点推送 | 同上 | 「人气 / 最新」排序切换 |
| 规则版推荐 | `recommendByRule` | 基于已装插件关键词的同类推荐 |
| 需求式推荐 | `recommendByQuery` | 「一句话帮我推荐」：本地关键词匹配（含中文→英文映射），零 LLM 依赖、零 API 额度消耗 |
| 目录失败诊断 | `src/lib/error-codes.js` | 新增 `PLG-004` 错误码 |

### 安全约束（沿用既有基线）

- 网络请求只在主进程；渲染层 CSP `default-src 'none'` 不放开。
- 目录/推荐 IPC 只读且仅插件管理窗口可调（`isPluginManagerSender` 校验）。
- 远程数据双层防御：渲染前 `esc()` 转义 + 安装前 `validateArg('pkg')` 白名单。

### 测试

- `tests/plugin-catalog.js`：40 条用例（网络失败/缓存/降级/排序/推荐，全部不抛异常）。
- `tests/window-ui.js`：92 条用例（IPC 来源校验 + 新增 catalog/recommend 授权）。

### ⚠️ 未打包

本条目改动均为 `src/` 源码 + 测试，**尚未重打 app.asar**。桌面 exe 要看到效果，需执行 `build-app.ps1` 并完全退出旧实例后重启（见 PROJECT_README.md）。

---

## 故障排查记录：dsh 服务反复崩溃 / 界面打不开 / "Failed to load plugins"（2026-08-20）

### 现象
应用打不开：`%TEMP%\dsh-service.log` 与 `%TEMP%\dsh-desktop-error.log` 反复出现
`BOOT-002 dsh 进程运行中意外退出 code=1`（自动重启 3 次用尽后弹窗），前端控制台报
`Failed to load plugins / failed to import loader entry (@deepseek-ai/dsh-session-log-export):
client-modules: bundle script /plugins/@deepseek-ai/dsh-session-log-export/client.js?rev=... failed to load`。

### 根因（两层问题叠加）

**第一层（致命，导致 dsh 崩溃）：`@dsh-external/dsh-context-lifecycle` 激活失败拖垮整棵插件树**
- 该插件由 super-injector 以 junction 链接注入 profile
  （`web\node_modules\@dsh-external\dsh-context-lifecycle` → `D:\Deepseek-Harness\dsh-context-lifecycle`），
  其 `cordis.patch.yml` 插入自身条目，`inject` 声明依赖
  `['agents', 'compaction', 'tokenMeter', 'webServer']`；
- 但 **compaction 服务未在 web profile 激活树中**：`dsh-compaction`（抽象接口）+ `dsh-compaction-basic`（实现）
  均不在 web 依赖/激活列表（`dsh-web-app` / `dsh-base` 都不依赖它）→ 插件永远
  `pending (waiting for service: compaction)` → dsh-app-boot 判定
  `1 entry did not activate` → **整个插件树加载失败 → dsh 进程 code=1 退出**。

**第二层（连带，前端报错）：`@deepseek-ai/dsh-session-log-export` 孤儿包 bundle 404**
- 该包是根级 `profiles\node_modules\@deepseek-ai\` 下的非 pnpm 安装残留（`.pnpm` 中无对应），
  却被 loader 扫到生成 entry → 因插件树崩溃导致 `/plugins/` 服务未建立 → 前端加载其
  client.js 得到 404 → 渲染端报 "Failed to load plugins"。

### 排查过程中的坑（避免重蹈）
1. **`disabled` 条目 id 必须精确匹配 insert 条目的 id**：context-lifecycle 的 insert id 是
   `dsh-context-lifecycle`（无 `@` 前缀），写成 `@dsh-external/dsh-context-lifecycle` 不匹配 → 禁用无效。
2. **junction 改名 `.disabled` 无效**：loader 按包内 `package.json` 的 `name` 字段识别并扫描，
   不按目录名；改目录名不会阻止扫描。
3. **删 junction 会被 super-injector 重建**：super-injector 运行时维护仓库插件注入，删除后数秒内
   自动重建链接 → 单纯删链接不能解决问题。
4. **compaction 是接口不是实现**：只装 `@deepseek-ai/dsh-compaction`（抽象 seam）不够，
   还需 `dsh-compaction-basic` 提供实现且二者都进入激活树。

### 修复（当前已生效，应用可正常打开）
1. `~/.dsh/profiles/web/cordis.patch.yml`：修正 disabled 条目 id 为 `dsh-context-lifecycle`
   （匹配 insert 条目），使该开发中插件跳过激活 → 插件树加载成功。
2. `profiles\node_modules\@deepseek-ai\dsh-session-log-export` 改名
   `.disabled`（非 pnpm 孤儿包，loader 不再生成 entry）。
3. 若后续要**真正启用** dsh-context-lifecycle：移除 disabled 条目，并在 web profile 启用
   `dsh-compaction` + `dsh-compaction-basic`（加入激活树），且确认二者在激活列表中
   （注意 super-injector 会重建链接，删除无用）。

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