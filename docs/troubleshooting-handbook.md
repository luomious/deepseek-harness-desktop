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
| 插件市场（community-market）加载慢/可安装一直转圈/图标卡住 | §18 |
| 启动报 `invalid settings document` / settings.yaml 被写坏 | §19 |
| 后台旧实例滞留（8787 被旧网关占用 / crashpad 僵尸） | §20 |
| 打字卡顿 / 输入延迟（含「打字慢半拍显示」） | §21 |
| 上下滑动对话内容卡顿（滚动掉帧） | §22 |
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
| `scripts/gpu-mode.mjs` | GPU 模式查看 / 一键回滚（`--status` / `--software` / `--hardware`） | — |
| `scripts/apply-typing-lag-fixes.mjs` | 打字卡顿客户端 3 处修复重打（marker 幂等） | ✅ |
| `scripts/verify-patches.ps1` | 补丁 + 打字卡顿/GPU 策略/滚动锚点 marker 校验（**64 项**） | — |
| `scripts/apply-scroll-anchor-fixes.mjs` | 滚动锚点三处降本重打（canon→dev+pkg，`--check` 预演，marker 幂等） | ✅ |
| `scripts/apply-settings-resilience.mjs` | settings.yaml 反腐化补丁重打（startup 容错 + market catalogCache 隔离） | ✅ |
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

## 18. 插件市场（community-market）加载慢 / 可安装一直转圈 / 图标卡住

- **症状**：设置→插件市场「发现」搜索像没反应；「可安装」一直"正在检查可安装插件…"；列表出现但图标长时间空白/转圈。
- **根因**（2026-09-02 实测，两层）：
  1. **目录缓存过短 + 无失败回退**：上游目录源（`deepseek1024.com` / `api.dshfind.com`）从本机走内核受限通道**又慢又抖**（冷扫 5–8s，且直连失败率高）；community-market 内存目录缓存默认仅 **5 分钟**，且「可安装」与未过滤「发现」在扫描失败时**不回退**磁盘缓存 → 直接转圈/空白。
  2. **图标走 Node 原生 https 直连上游**：图标来自 `github.com` / `avatars.githubusercontent.com` / `deepseek1024.com` 图片，本机外网 HTTPS 直连不稳定；`restricted-image.js` 默认超时高达 **30s**、并发仅 **2**、失败不缓存 → 一个图标卡 30 秒，整页网格串行阻塞，失败图标**每次打开都重试再卡 30s**。
- **解决**（已打补丁并登记补丁体系，见 `scripts/` 与 `verify-patches.ps1`）：
  - 目录：`lib/host/routes.js` 注入 `cacheTtlMs: 4h` + 「可安装」/「未过滤发现」扫描失败回退 24h 磁盘缓存（stale 标记）。
  - 图标：`lib/media/restricted-image.js` 超时收紧（连接 3s / 首字节 5s / 总 8s）；`lib/media/service.js` 并发 2→8 + 失败 10 分钟 negative-cache。
  - **图标可达性**（2026-09-02 追加）：实测 `github.com` 主站在本机 TCP 超时、`avatars.githubusercontent.com` 200 可达；`lib/adapters/dsh-1024store.js` 的 fallback 头像域名 `github.com/{owner}.png` → `avatars.githubusercontent.com/{owner}?size=96`（同一 GitHub 头像资源）。
  - 重打脚本：`scripts/apply-community-market-no-lag.mjs`（routes.js）+ `scripts/apply-community-market-media-no-lag.mjs`（media + adapter），均已接入 `package-vendor.ps1`，`verify-patches.ps1` 含 4 项校验（no-lag / media timeouts / media service / adapter icon host）。
- **验证**：重启后 `/api/community-market/installable` 冷扫约 6s、热路径 <0.3s；`/api/community-market/catalog?q=archify` <20ms；`/api/community-market/assets?ref=…` 不可达图标 ≤8s 内返回（404→占位），可达图标 0.7–1.7s 出图；`verify-patches.ps1` 26 项 ALL PASS。
- **预防**：升级/重建后跑 `verify-patches.ps1`；若上游长期不可达，属环境网络问题（需恢复可用代理通道），补丁只能兜底"不卡"、不能保证出图。

## 19. settings.yaml 被写坏（启动报 `invalid settings document` / `Nested mappings are not allowed in compact mappings`）

- **症状**：启动/重启报 `dsh-plugin-desktop: invalid settings document at ...\settings.yaml: Nested mappings are not allowed in compact mappings at line N...`（可上百个解析错误）；重启失败。关闭弹窗「配置自检」（profile-guard）通过 ≠ 能启动——它只查 profile 悬空引用，不查 settings.yaml 的 YAML 语法（2026-09-03 事故实证）。
- **根因**（2026-09-03 逐字节复现定位）：社区市场（`dsh-community-market`）把 1024-store 插件目录快照（139 条，含 U+FFFD 乱码与内嵌 `description:`/`categories:` 字样的混合编码文本）持久化进共享 `settings.yaml`（`persistCatalogResponse → scope.update({catalogCache})`），坏数据序列化出非法 YAML → 下次启动 `readDesktopStartupSettings` 硬抛异常阻断 profile 装配。运行中实例按"最后好文档"策略会重写 settings.yaml（丢 catalogCache），形成坏↔好循环。
- **修复**（两层防御，2026-09-03，已登记补丁体系）：
  1. 启动容错（`profile.ts`/编译产物）：解析失败不再抛死——记 stderr 告警并回退默认 compatibility 模式/端口；settings.yaml 再坏也**不会阻断启动**。
  2. 根源隔离（market routes）：不再把原始目录快照写入 settings.yaml（目录仍在内存加载、过期按需重拉）。
  3. 重打/校验：`node scripts/apply-settings-resilience.mjs`（幂等）+ `verify-patches.ps1`（settings resilience 相关 4 项）。
- **排查/恢复命令**：
  ```powershell
  node -e "const {parseDocument}=require('D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/yaml');const fs=require('fs');const d=parseDocument(fs.readFileSync(process.env.USERPROFILE+'/.dsh/settings.yaml','utf8'),{prettyErrors:true});console.log('errors:',d.errors.length)"
  # 若 errors>0：确认当前 settings.yaml 是否为"最后好文档"（应用自愈重写后应 0 错误、无 catalogCache 段）
  ```
- **预防**：市场目录不再跨重启持久化（本次修复设计使然，代价=重启后首次打开市场重新拉取）；升级/重建后跑 `verify-patches.ps1`。
- **参考**：CHANGELOG 2026-09-03 settings.yaml 反腐化双保险。

## 20. 后台旧实例滞留（8787 被旧网关占用 / crashpad 僵尸）

- **症状**：应用多次重启后，旧代的 detached 子进程滞留在后台且用户不可见——表现为 `Get-Process 'DSH Desktop'` 里出现启动时间早于当前代的进程；hy3-free（hy3-gateway）8787 端口被「老一代」网关占用，新代网关子进程启动后 `EADDRINUSE` 秒退（`hy3-gateway/plugin-spawn.log` 里 `child exited code=0`）；另有 `--type=crashpad-handler` 僵尸（0 CPU/0 连接/无窗口）。旧代进程的进程名显示为 DSH Desktop，实为 electron-as-node 跑 `hy3-gateway/server.js` 的网关。
- **根因**：hy3-gateway 插件以 `detached` 方式 spawn 网关，Windows 上 detached 子进程随主进程退出后仍存活；旧网关一直占着 8787，导致每次重启新网关都绑不上端口（直到人工清理）。
- **修复**（两层机制，2026-09-03）：
  1. **代际接管**（`hy3-gateway/server.js`）：新增 loopback-only `POST /__hy3/takeover-shutdown`（token=sha256(key)，防误触）；`EADDRINUSE` 时不再直接退出——向占端口实例发 takeover 请求 → 旧实例 120ms 优雅退出 → 700ms 重试绑定（≤5 次）→ **新网关永远接管，旧实例自动退场**。
  2. **实例清道夫**（`plugins/dsh-instance-janitor`，零依赖 host）：启动即扫 + 每小时清扫，白名单自动清理「早于当前主进程启动」的旧代 crashpad-handler / 旧代 hy3 网关（杀后自动补拉新网关），其余旧进程仅记录+通知；护栏：绝不碰当前进程树/本进程/系统进程。
- **排查/恢复命令**：
  ```powershell
  # 查看实例
  Get-Process -Name 'DSH Desktop' | Select-Object Id,StartTime | Sort-Object StartTime
  Get-NetTCPConnection -LocalPort 8787,43120 -State Listen | Select-Object LocalPort,OwningProcess
  # 查网关持有者身份（应含 hy3-gateway\server.js）
  Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object CommandLine
  # 清道夫状态 / 手动触发一轮清扫
  Invoke-RestMethod http://127.0.0.1:43120/instance-janitor/status   # GET 查看
  Invoke-WebRequest http://127.0.0.1:43120/instance-janitor/status -Method POST  # 手动清扫
  # 动作日志
  Get-Content "$env:USERPROFILE\.dsh\instance-janitor.log"
  ```
- **预防**：机制常驻自动处理；若重启后网关无 `child exited` 记录（plugin-spawn.log）即接管成功；旧实例残留=0 属预期。
- **参考**：CHANGELOG 2026-09-03 后台旧实例自动清理机制。

## 21. 打字卡顿 / 输入延迟（三层：GPU 被强制关闭 × 客户端全量 DOM 扫描 × 输入框覆盖层）

- **症状**：在对话框打字有明显卡顿/延迟，回合**流式输出期间**尤甚；空闲时也有轻微滞后。用户 2026-09-16 报告。
- **根因（实测 + 读运行中代码，非推断）**：
  1. **渲染被三重降级**：快捷方式 `DSH Desktop.lnk` 带 `--disable-gpu`，`apply-gpu-opaque-patches` #1/#5/#6 又加 `disableHardwareAcceleration()` + `--in-process-gpu` + `--disable-gpu-compositing` + 关掉遮挡/后台节流 ⇒ **每帧纯 CPU 光栅、合成器在主进程、不节流**。历史原因：本机显示适配器含 **GameViewer / spacedesk 虚拟适配器**，2026-09-07 曾因 GPU 子进程崩溃循环出「鬼影透明窗」。
  2. **客户端插件在每次 DOM 变动/击键做全量扫描**：`dsh-diagram-renderer`（观察 `document.body` 子树 → 全文档 `querySelectorAll('[data-tool]')`）、`dsh-session-history`（80ms 去抖读**外层回合** `textContent` + 全串空白正则）、`better-sidebar`（`#root` 子树观察 + 1.5s `locate()` 全文档 query）。
  3. **输入框覆盖层（2026-09-17 补——用户「慢半拍显示」的主因）**：内核把输入框 textarea 渲染成**全透明**（`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:3463`：`.uV2eYG_input{color:#0000;-webkit-text-fill-color:transparent}`，只留 `caret-color`），你看到的字符由 React 拼的覆盖层 `div[data-input-backdrop]`（`:4024-4030`）绘制 ⇒ 每个字符的上屏时机 = `input` → 输入状态机 → store `publish()`（`:1454-1462`）→ **React 提交 → 布局 → 覆盖层绘制**；主线程任何占用都把这一个字往后推。中文 IME 组字串同样被透明掉（placeholder 有自带 `-webkit-text-fill-color` 所以仍可见，反证该属性作用范围）。加剧项：`ConversationRoot:7161` / `ConversationSession:7406` 均 `useInput((s) => s)` 订阅**整个输入态**但 **2026-09-17 更正：这一层远比原先写的轻** —— 每行 `ChatNodeSeat` **已 `react.memo` + 按单节点订阅**（`:5480-5481`）⇒ **不是**「整树重算」（原「全库 `React.memo(` 命中 0」系我 grep 的 **假阴性**，真实文本为 `react.memo)(`）；真实代价仅「ChatView 重跑 `order.map` + 每行 props 浅比较（无 DOM 工作）」；`dsh-client-connection/lib/client.js:10149` 每条 WS 消息同步 `JSON.parse` + Zod 全量校验（实测单次 48–61ms 长任务）。**上游 0.1.3-alpha.2 已把 textarea 改成 contenteditable（bundle 内 `jsx("textarea")`=0）——官方已删掉这个覆盖层结构。**

## 22. 上下滑动对话内容卡顿（滚动锚点每帧强制布局 × sticky 重绘 × 无虚拟化）

- **症状**：滚动消息列表掉帧、发涩（用户 2026-09-17 报告，与打字卡顿同会话）。
- **根因（三层，实测为静态读码 + 官方同源对照）**：
  1. **A 层（主因）**：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:5744-5767` 的 `onScroll`（`:5776` 挂载，passive）在**不在底部**（`:5752` 到底早退）时**每滚动帧**执行锚点计算 `scrollPosition():5566` → `pagingAnchor():5539-5564`：`getBoundingClientRect()`×2–3、**每帧** `querySelector("[data-composer-seat]")` 子树扫描（`:5541`）、**≤4 次 `document.elementsFromPoint()`**（`:5542-5557`）、命中失败回退 `[...querySelectorAll("[data-chat-anchor-key]")]` 并对**每一行**读 `getBoundingClientRect()`（`:5559-5563`）= **O(行数) 强制同步布局**。放大器：composer `onWheel` **non-passive**（`:3688`），指针在输入框上滚到边界时写 `host.scrollTop += deltaY`（`:3686`）→ 再触发一次。
  2. **B 层（绘制/合成）**：滚动口内两个常驻 sticky 层每帧重定位 + 其下渐变/阴影圆角卡重绘（`:7120` `.wSkVaW_composerSeat{z-index:7;渐变}`、`:5452` `.Md3f7G_toBottomSlot{z-index:8}`、`:3463` 卡片 `box-shadow`+`border-radius:22px`）；**全库几乎无合成/包含提示**（`will-change` 仅 `better-sidebar:2449` 且只在拖动时、`translateZ(0)` **0 处**）；**9 处「每帧重绘」型 infinite 动画**（`left` 扫光 ×5：`conversation:9353/9559`、`tool:627/1128`、`skill:11`；`background-clip:text` 微光 ×3：`conversation:4254/5452`、`better-sidebar:8357`；`box-shadow` ×1：`vision-engine:179/183`，多在流式门控内）。
  3. **C 层（天花板）**：主列表**无虚拟化**（`:5851` `order.map(ChatNodeSeat)`）；窗口「最近 **50** 条消息」起步、每次「加载更早」**+50**（`dsh-client-runtime:7585`/`7391`）⇒ 成本随已加载行数线性增长（`trajectory` 视图反而有虚拟化：`:4349/4354/4374`）。另有本机自创的 Rule 9（`content-visibility:auto` + `contain-intrinsic-size:auto 240px`，官方无此机制）可能加剧快滚抖动。
- **官方同源对照（定位加速器）**：0.1.3 把聊天渲染搬到**新包** `@deepseek-ai/dsh-client-ui-chat`（`ui-conversation` 里数出 0 是「代码搬走」而非「删除」——**这里曾误判过一次**），**没上虚拟化**，却在同一算法上做了三处降本：单点命中（`ui-chat:1956`）、**二分查找**（`:1962-1968`）、被动滚动 + 500ms 合并 + `scrollend` 结算（`:1905/:2348-2360`）。
- **修复（两层，均刷新生效、免重启）**：
  1. **S1 · Rule 11（纯 CSS）**：`plugins/dsh-ui-performance/lib/client.js` 加 `[data-conversation-scroll]{contain:paint}` + `[data-composer-seat]{contain:layout}`（**故意不给 seat `contain:paint`**：slot 子节点可能有下拉层会被裁切）。
  2. **S2′ · 内核 dist 三处降本**：`node scripts/apply-scroll-anchor-fixes.mjs`（幂等/原子/备份/`--check`/锚点漂移 fail-loud）—— ① 逐行 rect → **二分 O(log n)**；② 命中点 **4→1**；③ seat 查询 → **WeakMap 缓存 + `isConnected`**。**权威源 `patches/bundles/dsh-client-ui-conversation-client.js`（canon）**，打补丁后回灌 dev + packaged 两处 ⇒ `port-user-patches.mjs` 不会冲掉。
- **验证**：`--check` 预检 DRIFT 0/0/0（exit 1）→ 施加 `3/3` + 回灌 + `ALL OK` → 幂等二次运行 → **服务端实取 200 且含 3 marker、旧代码 0 命中** → 门禁 **ALL PASS (64 checks)** → **故障注入**：还原 canon 后门禁**恰好 1 条** FAIL（canon 那条）⇒ 归因唯一。
- **一键回滚**：`_backups/scroll-anchor-fixes-*/`（canon/dev/pkg 三份 `.before`）覆盖回 dev+pkg → 刷新；Rule 11 删块 → 刷新。
- **排查命令**：
  ```powershell
  node scripts/apply-scroll-anchor-fixes.mjs --check     # 补丁是否在位（3 处）
  node scripts/probe-dsh-cpu.mjs 15 1000      # 零注入 CPU 采样（滚动期间跑才有意义）
  powershell -NoProfile -File scripts\verify-patches.ps1 # 应 ALL PASS (64 checks)
  ```
- **预防**：滚动类问题先看「每事件/每帧的强制同步布局」与「sticky + 无包含提示」这两类；**不要**只改 CSS——JS 层不收敛，滚动卡顿会留残留（本次三路审计结论一致）。
- **量化证据（先量再改，不要先怀疑 React）**：空闲 main ~32% / renderer ~9%；**流式期间 main 100–170% / renderer 60–108%（≈1 核被渲染占满）= 打字排队的那一段**（样本 `_backups/cpu-idle-baseline-20260916-223547.log`）。修复后：流式 renderer 30–47%（第一步）→ **19–27%**（第二步开硬件加速后）；`keydown/input` 的 inputDelay **p50 = 0ms、p95 ≤ 13ms**，loopLag p95 6ms，帧率 178–180fps。
- **修复（三层，均已入补丁体系 + 门禁）**：
  1. **客户端层（刷新页面即生效）**：`node scripts/apply-typing-lag-fixes.mjs`（幂等 / 原子写 / 先备份 / marker 判定 / 锚点漂移即 fail-loud）——diagram 重扫收窄到 `[data-conversation-scroll]` 且只对「新增子树真含 `[data-tool]`」排程；session-history 增加行文本缓存 `rowText`（改读行元素、正则前先 `slice(0,400)`）；ui-performance 新增规则九 `[data-chat-anchor-key] { content-visibility:auto; contain-intrinsic-size:auto 240px }`。
  2. **渲染路径（需重启）**：`node scripts/apply-gpu-opaque-patches.mjs`（patch #7）——默认开硬件加速 + `--force_high_performance_gpu`，**窗口保持不透明** `#202124`（不透明后即使 GPU 失效也只回退软件渲染，不会再透视）。
  3. **输入框原生绘制（2026-09-17，刷新页面即生效，免重启）**：`plugins/dsh-ui-performance/lib/client.js` 新增 **Rule 10**（marker `dsh typing-lag fix 2026-09-17 (native composer text)`）——① `[data-input-scroll] textarea[data-phase]:not(:disabled)` 把文字交回 **textarea 原生绘制**（不再等 React 提交）+ ② `[data-input-backdrop]{z-index:2;color:transparent}` 让装饰层只负责装饰并置顶。门禁 marker 误删时从 `_backups/typing-lag-native-text-*/client.js.before` 还原。
  - **门禁（防插件重装/重建后静默丢失）**：`scripts/verify-patches.ps1` 的 6 条 `typing-lag: *`（2026-09-16 三条分别对应 `plugins/{dsh-diagram-renderer,dsh-session-history,dsh-ui-performance}/lib/client.js` 的 marker `dsh typing-lag fix 2026-09-16 (...)`； 2026-09-17 再增 `aria poll cache` 与 `native composer text` ×2）+ `gpu policy: hw accel default (lib/main)`（marker `dsh-gpu-policy-2026-09-16`）；失败提示直接给出重打命令。
- **一键回滚**：渲染层 `node scripts/gpu-mode.mjs --software` → 重启（回到软件渲染；不会再出鬼影，因为窗口不透明）；客户端层删掉 3 处 marker 或重装插件后重跑 `apply-typing-lag-fixes.mjs`；输入框层（Rule 10）用 `_backups/typing-lag-native-text-*/client.js.before` 覆盖回插件（或删掉该块）→ 刷新页面。
- **排查命令**：
  ```powershell
  node scripts/gpu-mode.mjs --status                    # hardware / software
  # 逐进程 CPU 采样（判断吃满的是 main 还是 renderer；流式期间采样才有意义）
  Get-Counter '\Process(DSH Desktop*)\% Processor Time' -SampleInterval 1 -MaxSamples 5
  # 门禁：6 条 typing-lag + GPU 策略 marker（应 ALL PASS 59 checks）
  powershell -NoProfile -File scripts\verify-patches.ps1
  # 进程归属（哪个 pid 监听 43120 = 内核 main）
  Get-NetTCPConnection -LocalPort 43120 -State Listen | Select-Object OwningProcess
  ```
- **预防**：性能类问题先量「**renderer 单核占用**（空闲 vs 流式两段对比）+ 主线程 longtask」，再查启动参数与客户端扫描；`--disable-gpu` 这类「为稳定牺牲性能」的旧权衡会在数月后以「打字卡」的形式回来要账。
- **参考**：CHANGELOG 2026-09-16 三节（根因定位 / 根治第二步 / 纳入门禁）+ 2026-09-17 两节（收口 / 输入框原生绘制 Rule 10）；产出 `outputs/2026-09-17-report-typing-lag-fix-and-residue-cleanup/` 与 `outputs/2026-09-17-report-typing-lag-native-text/`。
