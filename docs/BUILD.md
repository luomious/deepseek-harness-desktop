# DSH Desktop 构建指南（生产用）

> 桌面应用本体：`vendor/deepseek-harness-desktop/dsh-plugin-desktop`（DSH Desktop v2，Electron）。
> 插件生态：根目录 `plugins/`（link 加载，改后重启 dsh 生效，无需重建）。
> Web 端口默认 `43120`（源：`vendor/.../dsh-plugin-desktop/src/desktop-port.ts` 的
> `DESKTOP_DEFAULT_WEB_PORT = 43_120`；可被桌面设置覆盖）。旧壳端口 `3080` 已退役。

## 单一事实源（务必遵守）

**桌面快捷方式固定指向 `dist\win-unpacked\DSH Desktop.exe`**（这是一个 **junction**，
由 `scripts\promote-build.ps1` 换版时重指）。这就是"当前入口"，路径永不改变，
**不再产生 buildN 递增歧义**：

- 打包只产出到 `dist\win-unpacked-build<N>`（`package-dir.mjs`，不再自动改快捷方式）；
- 应用停止后运行 `promote-build.ps1 -From dist\win-unpacked-build<N>` → 换 junction + 静态自测；
- 快捷方式永远不变（指向 `win-unpacked`），双击即当前版本。

> ⚠️ **强制规则（2026-08-24 起）**：`promote-build.ps1` 在 DSH Desktop **运行中会拒绝换指**
> （避免"旧 exe + 新资源"混合态；`-Force` 仅限刻意热切换）；`package-vendor.ps1` 在应用运行中也
> 会跳过自动 promote 并提示手动执行。**换版流程 = 停应用 → promote（静态 smoke）→ 启动 → 跑完整
> smoke（含运行时路由）**。完整 smoke：`powershell -File scripts\smoke-test.ps1`。

> 注：并发开发的 `scripts\resolve-dist.mjs`（"dist 下最新 exe"动态解析）仍存在，
> 供补丁脚本定位最新构建用；它与 junction 入口并存，不冲突。

## 打包链路

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\package-vendor.ps1
```

- `package-vendor.ps1` → `yarn workspace dsh-plugin-desktop package:dir` →
  `scripts/package-dir.mjs`（electron-builder `--dir`）。
- 输出目录由环境变量 `DSH_OUT_DIR` 控制（未设置时 `package-dir.mjs` 用 `dist/win-unpacked`）；
  electron-builder 会在该目录下再生成 `win-unpacked/` 子目录。
- 打包成功后 `package-dir.mjs` 自动调 `scripts/update-shortcuts.ps1`，把快捷方式指向 dist 下最新 exe。
- ⚠️ 运行中的旧产物被锁定时，把 `DSH_OUT_DIR` 指到新目录（本次即 `dist/win-unpacked-build2`）。

## 完整构建流程（受控重建）

```powershell
cd D:\Deepseek-Harness\vendor\deepseek-harness-desktop
git submodule update --init --recursive   # 仅首次/子模块为空时
corepack yarn install --immutable
corepack yarn typecheck                    # 必须全绿
# 打包（见上；可用 DSH_OUT_DIR 指定新目录）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\package-vendor.ps1
```

## ⚠️ 构建后（重要）

1. **等 1 分钟再启动 exe** —— 构建仍在写 `app.asar.unpacked` 时启动会报
   `Cannot find module 'koffi'`（读取半成品，时序竞态）。
2. **重打补丁**（自动解析当前最新构建，无需手动指路径）：
   `node scripts/port-user-patches.mjs` → `node scripts/apply-winhide-patches.mjs` →
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-patches.ps1`（确认 ALL PASS）。
3. **启动后验收**：`http://127.0.0.1:43120` 正常、插件清单完整、无黑框、
   退出保护（`POST /desktop/critical-busy` 后点 ✕ 弹窗）正常。

## 插件开发（无需重建）

- 改 `plugins/<name>/lib/*.js` → 重启桌面应用（遵守重启守则，等用户指示）或对非 modlens 插件热重载。
- 改后 `node --check` 校验语法。
- **严禁**对 `@liustack/modlens` 热重载（会丢 adapter 注册卡死服务）。

## 回滚

- 源码：`git reset --hard <提交点>`
- 运行构建：从 `_backups/dist-archive/` 取回旧构建，或备份 `app.asar` / `app.asar.unpacked` 后覆盖。
