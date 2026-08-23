# DSH 故障解决手册（Troubleshooting Handbook）

> 2026-08-23 建立。汇总「旧壳 → 新壳合并迁移」及后续出现的所有问题/bug 的**症状、根因、解决、验证、预防**。
> 原则：**每个问题都给出可直接复制的命令/脚本路径**，后续同类问题按图索骥即可，无需重新排查。
> 一键自愈入口：`node scripts/fix-all.mjs`（幂等，按序执行全部修复脚本）。
> 功能终核：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-features.ps1`（26 项全绿）。

---

## 0. 快速索引（症状 → 条目）

| 症状 | 条目 |
|---|---|
| 添加工作区菜单缺「远程连接…」「不在项目中工作」 | §1 |
| 远程工作区连接保存/测试/建区报 403 | §2 |
| 远程面板打开但 UI 不出现（remoteFlow 不渲染） | §3 |
| 对话框/输入内容莫名消失、页面白屏 | §4 |
| Ctrl+R / Ctrl+Shift+R 没反应 | §5 |
| 桌面快捷方式图标空白 | §6 |
| 日志反复刷 `bandOf is not defined` | §7 |
| PowerShell 脚本中文乱码/解析报错 | §8 |
| `dev_plugin_status` 报 `loadCache` 崩溃 | §9 |
| 桌面版粘贴图片变路径 | §10 |
| 插件市场（dshmarket）桌面端消失 | §11 |
| 安全类问题（误删/任意文件读/命令注入） | §12 |
| 重打包 exe 后功能再次消失（补丁丢失） | §13 |
| 皮肤（maid-atelier）不生效 | §14 |
| 从模板重建 profile 后 bundles 丢光 | §15 |

---

## 1. 添加工作区菜单缺「远程连接…」「不在项目中工作」

- **症状**：新会话「添加工作区…」菜单没有这两项；远程工作区功能整体不可见。
- **根因**（三层叠加）：
  1. 核心客户端补丁未移植到新壳：旧壳 `patch-manifest.js` 启动自愈重打补丁，机制随 `src/` 归档后消失；新壳打包的 `dsh-client-ui-workspace`/`dsh-client-ui-conversation` bundle 无 remoteFlow 洞声明、无「不在项目中工作」菜单、无纯聊天标签。
  2. `dsh-remote-workspace` 的 `trusted()` 硬编码 Origin 端口 3080（见 §2）。
  3. 0.1.1-rc.2 的 remoteFlow 洞**只声明不渲染**，需补 ADD_REMOTE 入口 + 渲染（见 §3）。
- **解决**：
  ```powershell
  node scripts/port-user-patches.mjs   # 移植 remoteFlow/ADD_CHAT/ADD_REMOTE/纯聊天 + modlens 补丁（幂等）
  powershell -File scripts/verify-features.ps1   # 确认 workspace/conversation 标记 PASS
  ```
- **验证**：重启应用后开「添加工作区…」菜单应见「不在项目中工作」「远程连接…」两项；`verify-features.ps1` 的 workspace-dev/pkg、conversation-dev/pkg 全 PASS。
- **预防**：改完/重打包后必跑 `node scripts/fix-all.mjs`；bundle 改动在 `patches/bundles/` 临时副本先验证再替换。

## 2. 远程工作区 API 全部 403（trusted 端口硬编码）

- **症状**：远程连接面板保存/测试/浏览目录/建工作区全部失败，报「拒绝非本机请求」或 403。
- **根因**：`plugins/dsh-remote-workspace/src/index.ts` 的 `trusted()` 里 `if (o.port && o.port !== '3080') return false`——桌面版 Web 端口不固定（OS 分配，如 43120），Origin 端口 ≠ 3080 → 全拒。
- **解决**：已改为动态端口比对（Origin 端口 == 请求 Host 端口），host 已重编译（`lib/index.js`）。若再遇：检查 `lib/index.js` 是否含 `hostPort`（重编译后应含），否则 `cd plugins/dsh-remote-workspace && npx tsc -p tsconfig.host.json`。
- **验证**：面板「测试连接」；`node plugins/dsh-remote-workspace/scripts/verify-core.mjs`（15/15）。
- **预防**：新写 host HTTP 插件一律用动态端口（参考 file-explorer 的 trusted()）。

## 3. 远程面板注册成功但 UI 不出现（remoteFlow 洞只声明不渲染）

- **根因**：0.1.1-rc.2 的 ui-workspace 只对 `directoryFlow` 调 `renderSlot`，`remoteFlow` 仅在 children 表声明、无人渲染。
- **解决**：`scripts/port-user-patches.mjs` 的 ADD_REMOTE 补丁在 `WorkspacePickFlow` 增加菜单入口 + `renderRemoteFlow({open,onClose})` 渲染，hero/sidebar 两处透传。
- **验证**：dev/pkg bundle 含 `const ADD_REMOTE` 与 `renderRemoteFlow`；重启后菜单点击「远程连接…」弹出面板。

## 4. 对话框内容/未发送输入消失、页面白屏

- **症状**：正在输入的草稿丢失；或整页白屏/无响应。
- **根因**：① 渲染进程卡死（加载了瞬时非法 bundle / 插件事件异常）→ 未发送内容（浏览器内存态）随 reload 丢失；② 我曾有一次把 bundle 写坏（PS 5.1 GBK 编码往返，见 §8）留下危险窗口。
- **解决**：
  - 数据未丢（会话在 `~/.dsh/sessions/**/session.jsonl.zstd`）；页面刷新（右下角 ⟳ 或 Ctrl+R）恢复显示；
  - 卡死无响应 → 完全退出应用重开；
  - 未发送草稿无法找回（不落盘），只能重打。
- **预防**：bundle/服务文件改动必须「临时副本→`node --check`→原子替换」；不要直接在运行中应用的服务路径上写完再验证。

## 5. Ctrl+R / Ctrl+Shift+R 没反应

- **根因**：桌面壳 `electron-platform.ts` 的 Windows 策略 `configureApplication`/`refreshApplicationMenu` 空实现 + `configureWindow` 调 `removeMenu()`——**Windows 上应用菜单从未安装**，`role:'reload'` 快捷键从未注册。
- **解决**（已生效方案）：`plugins/dsh-frontend-reload` 插件——页面级 keydown 捕获 Ctrl(+Shift)+R 调 `location.reload()`，右下角悬浮 ⟳ 按钮。已装入 desktop+web（依赖/junction/insert 行）。
- **验证**：重启后按 Ctrl+R 应刷新；右下角出现 ⟳。
- **后续（可选）**：vendor 源码级原生菜单（Windows 策略 setApplicationMenu + reload role）需重打包 exe。

## 6. 桌面快捷方式图标空白

- **根因**：`.lnk` 的 `IconLocation` 指向 `D:\Deepseek-Harness\src\assets\icon.ico`——`src/` 已归档到 `legacy/`（后已删除），路径不存在。
- **解决**：改指 `D:\Deepseek-Harness\legacy\src\assets\icon.ico`（2026-08-23 已修；注意：legacy 已删时改用 exe 自身 `DSH Desktop.exe,0` 或新图标路径）。
- **命令**（若再空白）：
  ```powershell
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut("$env:USERPROFILE\Desktop\DSH Desktop.lnk")
  $l.IconLocation = 'D:\Deepseek-Harness\legacy\src\assets\icon.ico,0'
  $l.Save()
  ```

## 7. 日志反复刷 `bandOf is not defined`

- **症状**：`%APPDATA%\DSH Desktop\logs\dsh-*.log` 出现 `session/event listener threw: ReferenceError: bandOf is not defined`。
- **现状**：磁盘全量搜索（plugins/vendor/asar/unpacked）均无 `bandOf` 定义，判定来自**运行中旧代码/热更新模块**；不影响数据（仅事件监听抛错被吞）。
- **解决**：重启应用后观察日志是否消失；若仍存在，在 `logs` 里按时间戳定位会话并追踪该 listener 来源（候选：dsh-context-lifecycle / dsh-session-history 的 host 事件监听）。

## 8. PowerShell 脚本中文乱码/解析报错（PS 5.1 编码坑）

- **症状**：`.ps1` 里中文注释导致 `Missing closing '}'` 等解析错误；日志显示乱码（如 `鑷鏌寮傚父`）。
- **根因**：PowerShell 5.1 默认按 ANSI(GBK) 读取无 BOM 的 UTF-8 文件；UTF-8 中文字节被读成 GBK 后，**GBK 尾字节可能含 `'`/`"`** → 破坏字符串/脚本结构。
- **解决**：
  - 脚本一律**纯 ASCII**（注释用英文）；
  - 文件操作读 UTF-8 文件用 `Get-Content -Encoding UTF8`，写 UTF-8 用 Node（`fs.writeFileSync(f, s, 'utf8')`）或 `Set-Content -Encoding UTF8`（PW7 无 BOM）；
  - 不要用 PowerShell 字符串拼接去改含中文的文件（会做编码往返）。
- **预防**：AGENTS.md 安全守则已写明；写脚本前检查有无中文。

## 9. `dev_plugin_status` 报 `Cannot read properties of undefined (reading 'loadCache')`

- **根因**：super-injector `listPlugins()` 访问 `ctx.loader.internal.loadCache` 未判空（新壳 loader internal 结构变化）。
- **解决**：`node scripts/fix-injector-loadcache.mjs`（可选链 `ctx.loader.internal?.loadCache?.keys() ?? []`，覆盖 desktop 副本 + 源码 lib + TS 源）。
- **验证**：`dev_plugin_status` 正常返回；desktop 副本 lib 含 `internal?.loadCache?.keys`。
- **注意**：`plugins/dsh-routing-suite/dsh-external-dsh-super-injector-0.3.3.tgz` **未重打包**——`pnpm install --force` 重装会回退，需重跑本脚本（建议改为 `link:` 指向已修源码）。

## 10. 桌面版粘贴图片变路径文本

- **根因**：modlens「无缝接管」补丁只打在 web profile，desktop profile 的 modlens 未打 → 被接管模型粘贴被误转路径。
- **解决**：`node scripts/port-user-patches.mjs`（同步 desktop modlens `dsh/index.js`，标记 `无缝接管补丁` / `lowered0`）。
- **注意**：desktop 的 modlens 文件是 pnpm store 硬链接，`pnpm install --force` 可能回退 → 重跑脚本。

## 11. 插件市场（dshmarket）桌面端消失

- **根因**：装配遗漏——dshmarket 有依赖、已安装，但未进 desktop profile 的 `dsh.profile.bundles`（web 有）。
- **解决**：已加入（bundles 25 项）。若再遇：编辑 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 补 `"dshmarket"`。

## 12. 安全类问题（误删/任意文件读/命令注入/CSRF）

- **审计结论**：4 高危 / 5 中危 / 8 低危（2026-08-23，详见 `docs/migration-audit-2026-08-22.md` §8）。
- **已修复**（`node scripts/fix-security.mjs`）：
  - H1 注入器 `inject()` 包名未校验 → `..` 逃逸 + `rmSync` 可删任意目录 → npm 包名白名单（lib+src）；
  - H2 `/super-injector/api` 无 Origin 校验 → CSRF 注入/卸载 → Origin+Sec-Fetch-Site 校验（lib）；
  - H3 vision-engine `paste-img` `../` 穿越读任意文件 → 段规范化 + 拒绝盘符/UNC（lib）；
  - H4 staging `new Function` 持久化 RCE → 默认禁用（`DSH_STAGE_RESTORE=1` 才恢复，lib）；
  - M1 file-explorer `isPathAllowed` 无 realpath（junction 逃逸）→ realpath+前缀校验；
  - M2 remote-workspace ssh `-oProxyCommand` / docker option 注入 → `assertSafeTarget`；
  - M3 `listRemoteDir` 双引号包 sq() 导致 `[ -d ]` 恒失败（功能 bug）→ 去多余引号；
  - M4 context-lifecycle `/decide` 无 Origin → CSRF 触发压缩 → Origin+Sec-Fetch-Site 校验。
- **误删防护**：`scripts/guard-destructive.ps1`——递归/强制/格式化删除仅限工作区内；盘根/用户目录/通配符一律拦截；自检 7/7。用法：
  ```powershell
  . .\scripts\guard-destructive.ps1
  if (Test-DestructiveCommand $cmd) { throw "已拦截危险命令: $cmd" }
  ```
- **已知遗留**：injector `src/index.ts` 与 `lib/index.js` 校验不一致（src 路由缺 H2，需重建统一）；`dev_build_plugin` 执行插件 build.sh（仅限本地可信插件）。

## 13. 重打包 exe 后功能再次消失（补丁丢失）

- **根因**：核心 bundle 补丁只存在于运行目录（dev/dist node_modules），不在 vendor yarn patches / 构建流程里；`yarn install` / 重打包会还原为原始文件（8/23 14:30 已发生过一次）。
- **解决**：
  ```powershell
  node scripts/fix-all.mjs   # 一键重打全部补丁（幂等）
  powershell -File scripts/verify-features.ps1
  ```
- **建议（未做）**：把补丁固化进 `vendor/patches/dsh-client-ui-workspace@0.1.1-rc.2.patch` 等，或挂进 `package-vendor.ps1`/`rebuild-and-restart.ps1`。

## 14. 皮肤（maid-atelier）不生效

- **状态**：**已决策保持禁用**（2026-08-23 用户确认）。desktop `cordis.patch.yml` + `.dsh-market/state.json` 双重禁用，模板 `profile/desktop/cordis.patch.yml` 已回写 disabled 行。
- **如需启用**：删除两处 disabled（profile patch + market state）+ 模板行，重启。

## 15. 从模板重建 profile 后 bundles 丢光

- **根因**：`profile/desktop/package.json` 模板只有 2 个 bundle，部署态 25 个；装配批次在 `scripts/staged-profile-assemble.ps1`（不更新模板）。
- **解决**：不要用旧模板重跑 `install-desktop.ps1`；以当前 `~/.dsh/profiles/desktop/package.json`（25 bundles）为准；重建后跑 `verify-features.ps1` 核对。

---

## 附：修复脚本速查

| 脚本 | 作用 | 幂等 |
|---|---|---|
| `scripts/fix-all.mjs` | **一键自愈入口**（按序跑下面三个） | ✅ |
| `scripts/port-user-patches.mjs` | 核心 bundle 补丁（remoteFlow/不在项目中工作/ADD_REMOTE/纯聊天）+ modlens | ✅ |
| `scripts/fix-injector-loadcache.mjs` | super-injector loadCache 崩溃 | ✅ |
| `scripts/fix-security.mjs` | 安全漏洞 H1-H4/M1-M4 | ✅ |
| `scripts/guard-destructive.ps1` | 危险命令守卫（删除前预检） | — |
| `scripts/verify-features.ps1` | 功能终核 26 项 | — |
| `scripts/verify-core.mjs` | remote-workspace 核心逻辑 15 项 | — |

> 所有脚本纯 Node/PowerShell，路径硬编码 `D:\Deepseek-Harness`（本机）；跨机需改 `scripts/*.mjs` 顶部的根路径常量。
## 16. better-sidebar 侧边栏不可用（chunk "terminal": client module system unavailable）

- **症状**：右侧边栏（explorer 文件树/编辑器/终端）整体不出现；页面控制台报 `chunk "terminal": client module system unavailable`；`dev_plugin_status` 显示 `better-sidebar [disabled]`。
- **根因**：① dsh-better-sidebar 0.13.x 按 rc.7/rc.8 开发，其 chunk-loader 依赖 shell 暴露的 client module system，0.1.1-rc.2 不暴露 → chunk 加载失败；② 包内 cordis.patch.yml 的 `!!js` 双挂载守卫在 rc.2 loader 下误判为 true → 插件被自动 disabled。
- **解决**：
  1. 升级到 0.15.2（chunk-loader 自带模块系统注入，不再依赖 shell）：`pnpm --dir C:/Users/<user>/.dsh/profiles/<desktop|web> add dsh-better-sidebar@^0.15.2`；
  2. 在两个 profile 的 cordis.patch.yml 追加 `- id: better-sidebar
  disabled: false`（profile 层覆盖包内守卫）。
- **验证**：重启后侧边栏出现；`dev_plugin_status` 显示 `better-sidebar [active]`。
- **预防**：升级 dsh 大版本后检查第三方插件的 !!js 守卫与 chunk-loader 兼容性。
## 17. dsh-frontend-reload 装配易失（pnpm add 清掉手动 link 依赖 → 自愈清理 insert 行）

- **症状**：重启后右下角无 ⟳ 刷新按钮、Ctrl+R 无效；`dev_plugin_status` 无 frontend-reload；但插件目录/junction 都在。
- **根因**：① `pnpm add <pkg>` 重写 profile package.json 时会丢弃**未进 lockfile 的手动 link 依赖**；② 重启时装配自愈（reconcile）发现 insert 行引用的包不在 dependencies → 把 cordis.patch.yml 里的 insert 行也清掉 → 插件彻底不被挂载。
- **解决**（三件套缺一不可）：
  1. package.json 加回依赖：`"@dsh-external/dsh-frontend-reload": "link:D:\Deepseek-Harness\plugins\dsh-frontend-reload"`；
  2. `pnpm --dir <profile> install`（把 link 依赖注册进 lockfile，以后再 pnpm 操作不会丢）；
  3. cordis.patch.yml 加回 insert 行：`- insert: { id: frontend-reload, name: @dsh-external/dsh-frontend-reload }`。
- **预防**：新增手动 link 依赖后立即 `pnpm install` 入 lockfile；`verify-features.ps1` 已含 frontend-reload-dep 检查（防复发）。

