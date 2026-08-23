# 迁移审计记录：旧桌面壳 → 新壳（deepseek-harness-desktop）合并后功能修复与遗漏盘点

> 日期：2026-08-23　作者：DSH Agent（本会话）　关联脚本：`scripts/port-user-patches.mjs`、`scripts/fix-injector-loadcache.mjs`、`scripts/verify-core.mjs`
> 本文档被 `scripts/port-user-patches.mjs` 引用；请勿删除。

## 1. 背景

用户自研的旧桌面壳（`src/`，现归档于 `legacy/src/`，提交 `e4960bc` 原样 R100 迁移）被官方新壳
`vendor/deepseek-harness-desktop/dsh-plugin-desktop`（基于固定上游 deepseek-harness submodule，yarn patches + profile bundles 机制）取代。
合并后用户反馈：**新会话「添加工作区」处的 SSH 远程连接功能与「不在项目中工作」功能消失，部分插件不工作**。

## 2. 根因（三层叠加）

1. **核心客户端补丁未移植到新壳**：旧壳通过 `patches/reference/patch-manifest.js` 在启动时自愈重打 13 项 node_modules 补丁；新壳用自己的打包 dsh（app.asar.unpacked/node_modules，0.1.1-rc.2），
   其 `dsh-client-ui-workspace` / `dsh-client-ui-conversation` bundle 不含旧补丁 → 「不在项目中工作」菜单、remoteFlow 洞、纯聊天标签全部缺失。
2. **dsh-remote-workspace 的 `trusted()` 硬编码 Origin 端口 3080**（`plugins/dsh-remote-workspace/src/index.ts:596`）：新壳桌面端口不固定（43120 等）→ 所有 `/remote-ws` POST 被 403 → host API 整体失效
   （同族 4 个插件 file-explorer/skills-manager/vision-engine/context-lifecycle 已于 8/23 修复，唯独漏掉它）。
3. **remoteFlow 洞在 0.1.1-rc.2 只声明不渲染**：新壳 ui-workspace 仅 `directoryFlow` 有 `renderSlot` 调用，插件注册进 remoteFlow 也不可见 → 需要补 ADD_REMOTE 入口 + 渲染。

## 3. 已完成修复（2026-08-23，均已验证）

### 3.1 核心 bundle 补丁移植（dev + 打包 + canon 三副本一致）

| 目标 | 补丁 | 标记 | 校验 |
|---|---|---|---|
| `dsh-client-ui-workspace/lib/client.js` | remoteFlow 洞声明（sidebar/hero）· 不在项目中工作菜单（ADD_CHAT）· **ADD_REMOTE 远程连接入口 + remoteFlow 渲染**（还原 rc.7 UX）· 保留新壳 drop-target 补丁 | `const ADD_CHAT`/`const ADD_REMOTE`/`remoteFlow`/`menu.addChat`/`menu.addRemote` | node --check OK；dev==打包 SHA256 一致 |
| `dsh-client-ui-conversation/lib/client.js` | 纯聊天标签（chatOnly） | `const chatOnly`/`"chatOnly"` | node --check OK |
| 新壳 desktop profile `@liustack/modlens/dsh/index.js` | 无缝接管判定（`patchModlensTakeoverVerdict`） | `无缝接管补丁` | 与 web 版一致 |

- 权威源：全局 dsh 安装 `%APPDATA%\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\…`（旧系统维护、已含补丁、UTF-8 干净）。
- 副本：dev `vendor/…/dsh-plugin-desktop/node_modules/…`；打包 `vendor/…/dsh-plugin-desktop/dist/win-unpacked/resources/app.asar.unpacked/node_modules/…`；canon 存档 `patches/bundles/`（含 original/ 原始版备份，取自 yarn cache npm 原包）。
- ⚠️ 说明：`data-dsh-workspace-drop-target` 是新壳自己的 yarn patch 行（全局版没有），移植时已保留。

### 3.2 插件适配（dsh-remote-workspace）

| 改动 | 文件 | 说明 |
|---|---|---|
| trusted() 动态端口 | `src/index.ts` | Origin 端口与请求 Host 端口一致（同 file-explorer 实现），不再硬编码 3080 |
| tools.register 包 ctx.effect | `src/index.ts` | 防 HMR/卸载残留与重复注册 |
| client 类型适配 | `src/client/index.ts` | `SlotsService`→`SlotRegistry`（dsh-client-runtime/client）；`workspaces` 补 `connectWorkspace`；`RemoteWorkspace` 补 `nativeId?` |
| startSession 用 connectWorkspace | `src/client/index.ts` | 失败会 reject，重试逻辑恢复生效；`sessions` 加入 inject |
| 补 cordis.patch.yml | `plugins/dsh-remote-workspace|cordis.patch.yml`（另 file-explorer/system-notify 同补） | 供 web profile 自动装配流 |

- 验证：host `npx tsc -p tsconfig.host.json` 0 错；client `npx tsdown` 27.5KB；`node scripts/verify-core.mjs` 15/15 通过；node --check 全过。

### 3.3 兼容修复（dsh-super-injector）

- `dev_plugin_status` 崩溃（`Cannot read properties of undefined (reading 'loadCache')`）根因：`listPlugins()` 未判空 `ctx.loader.internal.loadCache`（新 loader internal 结构变化）。
- 修复：`scripts/fix-injector-loadcache.mjs` 幂等替换为可选链，覆盖 desktop 副本 + 源码 lib + TS 源。
- ⚠️ 待办：`plugins/dsh-routing-suite/dsh-external-dsh-super-injector-0.3.3.tgz` 未重打包（重装会回退），建议改 `link:` 指向已修源码或重打包。

### 3.4 装配补漏

- **dshmarket 补进 desktop profile bundles**（web 有、方案有、desktop 漏；依赖已装未加载）。
- 三个插件（remote-workspace/file-explorer/system-notify）加载机制确认：**经 profile `cordis.patch.yml` insert 行加载**（非 bundles）——加载器 `profile.ts:683-690` 合并 `filteredProfile.patches`，无需改 bundles（加了反而会 `assertUniqueEntryIds` 失败）。

## 4. 生效方式（重启守则）

- modlens（服务端）与 profile 装配：**必须完全退出桌面应用重开**；核心 bundle 改动刷新浏览器即可（no-cache）。
- 重启后验证：
  - 新会话「添加工作区…」菜单应出现「不在项目中工作」与「远程连接…」两项；远程连接弹窗可新建 SSH/WSL/Docker 连接。
  - `dev_plugin_status` 不再报 loadCache 错误；`dev_injected_list` 正常。
  - 桌面版粘贴图片不再转路径（modlens 无缝接管）。

## 5. 遗留 / 待决策项

| # | 事项 | 状态 | 建议 |
|---|---|---|---|
| 1 | **maid-atelier 皮肤**：desktop `cordis.patch.yml` + `.dsh-market/state.json` 双重禁用（web 同） | **已决策（2026-08-23 用户确认）：保持禁用**；模板 profile/desktop/cordis.patch.yml 已补 disabled 行，防模板重建意外启用 |
| 2 | 补丁固化机制：`port-user-patches.mjs` 未进 vendor yarn patch / build 流程，**重打包后补丁会再次消失**（8/23 已发生一次） | 待加固 | 转成 `vendor/patches/dsh-client-ui-workspace@0.1.1-rc.2.patch` 等，或挂进 `package-vendor.ps1` / `rebuild-and-restart.ps1` |
| 3 | settings-models 搜索 ×2 / serve-bundle-retry / frontend-static-nocache 补丁：新壳 bundle 无 | 待决策 | 迁移进 vendor patches 或正式放弃（新壳机制已部分覆盖） |
| 4 | 旧壳 `buildDshEnv()`（CODEBUDDY_SAFE_DELETE/GENIE_TRASH_DIR/NODE_OPTIONS shim 清理）新壳无对应 | 待评估 | WorkBuddy 宿主场景仍有 shim 注入风险 |
| 5 | 权限白名单（notifications/clipboard-write）新壳无 `setPermissionRequestHandler` | 待评估 | Electron 默认放行，安全面变宽 |
| 6 | 原生目录选择器 worker.cjs UTF-16 bug：新壳 bundle 内仍含 buggy line | 待确认 | 确认新壳是否仍走 `dsh-host-directory-picker-native` 路径 |
| 7 | `profile/desktop/` 模板 stale（bundles 仅 2 项 vs 实际 25 项）：重跑 install-desktop.ps1 会产出裸 profile | 待回写 | 把装配批次固化进 `scripts/staged-profile-assemble.ps1`，模板保持最小 |
| 8 | `plugins/dsh-routing-suite` 从未入库（.gitignore）；`patches/` + 两个修复脚本未 git 提交 | 待提交 | 建议提交或归档，防换机丢失 |
| 9 | super-injector 注册表 `~/.dsh/super-injector/registry.json` 全局共享，双 profile 共用有竞态 | 观察 | 无即时风险 |

## 6. 迁移时间线（git）

`52fe6b0`(8/22 19:54 合并启动) → `61f1b65`(vendor 入 gitignore) → `1483a43`(desktop profile 模板) → `13ca2bc`(staged 装配引擎) → 批次1-5 → `c23d116`(总结，17 检查点全绿) → `9f62cdb`/`0e451dd`(插件 403 修复) → `e4960bc`(旧壳归档 legacy) → `e63ff2a`(desktop modlens families 补齐——「装配时遗漏」实锤) → `d3f3290`(vendor pnpm 11.21.0) → `3ba27b1`(重打包成功)。

## 7. 可重打/恢复指引

```powershell
# 核心 bundle + modlens 补丁重打（幂等；全局 dsh 为权威源）
node scripts/port-user-patches.mjs
# super-injector loadCache 兼容修复（幂等；TS 源 + 两份 lib）
node scripts/fix-injector-loadcache.mjs
# 插件核心逻辑自测
node plugins/dsh-remote-workspace/scripts/verify-core.mjs
```

**关键路径速查**：
- 全局 dsh：`%APPDATA%\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
- 新壳 dev bundle：`vendor\deepseek-harness-desktop\dsh-plugin-desktop\node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js`
- 新壳打包 bundle：`vendor\…\dist\win-unpacked\resources\app.asar.unpacked\node_modules\@deepseek-ai\…`
- 补丁存档：`patches\bundles\`（canon + original）
- 旧补丁清单留档：`patches/reference/patch-manifest.js`（13 项）

## 8. 安全审计与加固（2026-08-23，详见 scripts/fix-security.mjs）

审计（子代理只读）结论：4 高危 / 5 中危 / 8 低危。已修复：

| 编号 | 位置 | 漏洞 | 修复 |
|---|---|---|---|
| H1 | injector inject() | 包名未校验，`..` 经 join 逃逸后 rmSync 可删任意目录 | npm 包名白名单正则（lib+src） |
| H2 | injector /super-injector/api | 无 Origin 校验 → 本地恶意网页 CSRF 注入/卸载 | 增加 Origin+Sec-Fetch-Site 校验（lib 运行版；src 待重建同步） |
| H3 | vision-engine paste-img | `../` 穿越读任意图片文件 | 段规范化 + 拒绝盘符/UNC/绝对路径（lib） |
| H4 | injector restoreStaging | new Function 持久化 JS → 跨重启 RCE | 默认禁用，需 DSH_STAGE_RESTORE=1（lib；src 无此函数） |
| M1 | file-explorer isPathAllowed | 无 realpath，junction 逃逸读主目录外 | realpath+规范化前缀校验（lib） |
| M2 | remote-workspace | ssh host 以 `-` 开头 → -oProxyCommand 本机命令注入；docker 容器名 option 注入 | assertSafeTarget 校验（host 已重编译） |
| M3 | remote-workspace listRemoteDir | sq() 被双引号再包 → `[ -d ]` 恒失败 | 去掉多余双引号（功能修复） |
| M4 | context-lifecycle /decide | 无 Origin → CSRF 触发会话压缩 | 增加 Origin+Sec-Fetch-Site 校验（lib） |

防护机制：`scripts/guard-destructive.ps1`（危险命令守卫，自检 7/7 通过）。遗留：injector src 与 lib 校验不一致（需重建统一）；bandOf 事件监听报错未定位（疑为运行中旧代码/热更新模块，重启后观察）。
