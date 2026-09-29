# 事故报告：0.1.7-rc.2 升级后桌面启动失败（`SettingsProvider` 导出断裂）

- 日期：2026-09-27 20:00 前后
- 触发：junction 已切到 `win-unpacked-build202609271840`（内核 0.1.7-rc.2），用户重启应用 → 弹出「DSH Desktop 启动失败」错误框
- 结论：**不是本次改动的编码错误，而是「settings 行没有跟着内核升级迁移」的结构性缺口**。已按规定**回滚 junction**（未重启应用），等待用户拍板前向修复方案。

---

## 1. 现象（截图原文）

```
file:///D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-deskt....9
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
        ^^^^^^^^^^^^^^^^
SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'SettingsProvider'
    at #asyncInstantiate (node:internal/modules/esm/module_job:327:21)
    ...
```

这是 **ESM 链接期（link time）错误**：报错发生在任何业务代码执行之前，属于「模块图整体不可加载」，不是运行期逻辑异常。

---

## 2. 根因链（逐环实测）

| # | 环节 | 证据 |
|---|---|---|
| 1 | 导入方：`@deepseek-ai/dsh-settings-file` 仍在 `import { SettingsProvider } from "@deepseek-ai/dsh-settings"` | 【实测】`node_modules/@deepseek-ai/dsh-settings-file/lib/index.js:9`（该行号与弹窗 `:9` 吻合） |
| 2 | 被导入方：0.1.7 的 `@deepseek-ai/dsh-settings` **删除了 `SettingsProvider`** | 【实测】`dsh-settings@0.1.7-rc.2` 唯一导出 = `{ SettingsConflictError, SettingsForms, redactSecrets }`（`lib/index.js:544`） |
| 3 | 旧内核（0.1.1）为什么没事 | 【实测】`dsh-settings@0.1.1-rc.2` 导出含 `SettingsProvider`（`lib/index.js:638`） |
| 4 | 桌面把 settings 行钉死在 settings-file | 【实测】`dsh-plugin-desktop/package.json:218-219`：`dsh-settings` 升 `0.1.7-rc.2`，`dsh-settings-file` 仍 `0.1.5-rc.3` |
| 5 | 为什么没升 settings-file | 【实测】npm 上 `dsh-settings-file` **不存在 0.1.7 线**：`next=0.1.5-rc.3`、`alpha=0.1.6-alpha.2`，最高正式版就是 0.1.5-rc.3 |
| 6 | 升到最高 alpha 也不行 | 【实测】`dsh-settings-file@0.1.6-alpha.2` **同样** `import { SettingsProvider }` → 该包全系与 0.1.7 不兼容 |
| 7 | 0.1.7 官方改成什么了 | 【实测】`@deepseek-ai/dsh-base/cordis.patch.yml:101-103`：<br>`- id: settings` / `name: '@deepseek-ai/dsh-settings'`（表单服务；持久化走 profile 的 Cordis patch，`settings.yaml` 只做一次性导入）。**官方全线已无任何包挂 `dsh-settings-file`**（仅 `dsh-agent-presets/package.json` 残留一处 devDep、`dsh-host-apiproxy` 一处报错文案提到它） |
| 8 | 崩溃点为何在 0.1.7 build | 【实测】新 build 打包态自带 `app.asar.unpacked/node_modules`：`dsh-settings=0.1.7-rc.2` + `dsh-settings-file=0.1.5-rc.3`；而桌面自身 `lib/profile-*.js:12` 静态 import 该包 ⇒ 启动即链接失败 |

**一句话**：**上游 0.1.7 淘汰了「文件型 settings provider」，我们的桌面 profile 还在用它，而它的全部已发布版本都依赖一个已被删除的导出。**

---

## 3. 为什么 P3 打包没拦住

- `tsc` 只看**我们自己的源码与类型**；坏点在**已发布三方包内部**的 ESM 导出名上，且 `skipLibCheck: true` 已开 ⇒ 编译期不可见。
- `yarn build` 成功、`check-dist-integrity` 的「相对导入齐全」契约也全过 —— 该契约只验证**相对**导入存在，不验证**裸包说明符的导出名**。
- 结论：这类缺陷只有在**真正启动**时才暴露（与官方「构建期导入守卫」的做法相对应，属于我们已知的 P0-G4 差距）。

---

## 4. 立即处置（已执行）

| 项 | 内容 |
|---|---|
| 动作 | `dist\win-unpacked` junction 由 `win-unpacked-build202609271840`（0.1.7，坏）→ **`win-unpacked-build202608272104`（0.1.1，可用）** |
| 方式 | 原生 PS 删除 junction 后重建（`[System.IO.Directory]::Delete` + `New-Item -ItemType Junction`） |
| 校验 | 回滚前 LinkType=Junction、回滚后 Target 正确、稳定入口 `DSH Desktop.exe` 存在；目标构建 `dsh-settings=0.1.1-rc.2`（含 `SettingsProvider`）；`scripts/check-dist-integrity.mjs <asar> <lib>` = **OK（unpacked 契约 + 15 相对导入）** |
| 锁 | `task-scheduler acquire tk-mujrzpbw-ac4b2b78` → 变更 → `release --summary`（已登记） |
| 未做 | **没有重启应用**（遵守重启守则）；新 build 目录**未删除**，原地保留可再 promote |

### 为什么没有走 `scripts/promote-build.ps1` 回滚

该脚本的回滚路径会先对目标跑 `smoke-test.ps1`；而 `smoke-test.ps1` 已在 0.1.7 升级中改写为**校验 0.1.7 形态**（如 `ui-workspace ADD_WORKSPACE (0.1.7)`）。对 0.1.1 构建跑它必然 FAIL ⇒ 脚本会「回滚到上一个目标」= **把我们扔回坏 build**。因此本次改用等价的原生 junction 重建，并单独跑通用的完整性校验。

> 附带影响：**当前 0.1.1 运行态下，`smoke-test.ps1` / `verify-patches.ps1` 的 0.1.7 期望会全线报红** —— 这是「代码库已按 0.1.7 改、运行态回退到 0.1.1」的必然错位，不是新故障。

---

## 5. 前向修复需要什么（未执行，待拍板）

要让 0.1.7 build 真正可启动，**必须把 settings 行从 settings-file 迁走**，牵涉面：

1. **profile 装配**：`src/profile.ts` 的 `SETTINGS_FILE_PACKAGE` 断言（`:707-708`）、`FileSettingsProvider.Config(...)`（`:717`）、`resolveSettingsSpec`（`:714`）、`hooks.onSettingsDocumentResolved`。
2. **桌面启动参数**：`readDesktopStartupSettings()`（`:148-183`）当前从 settings YAML 文档读 `mode`（simple/advanced）+ `port` ⇒ 需改存到 profile patch / desktop-shell entry config。
3. **客户端设置页**：`settingsScope` 仍是占位（升级适配时降级为 `unavailableScope`）。
4. **notifications 设置**：需改为 entry Config。
5. **测试**：`tests/` 19 处旧 settings API。
6. 迁移后需重新 build + 重跑 P4 补丁处置 + P6 冒烟。

**风险/收益**：收益 = 0.1.7 升级真正落地（内核追平 + 退役 7 补丁）；风险 = 中等（触及启动参数来源与设置持久化语义，需专门批次 + 冒烟），**旧 build 始终是回滚路径**。

---

## 6. 证据边界（诚实标注）

- 【实测】以上所有包版本、导出名、行号、junction 状态、完整性校验均来自本机文件系统与 npm registry 查询。
- 【推断】「运行时读取的是打包态自带 `app.asar.unpacked` 而非 vendor 目录」—— 依据是打包态自带完整 `node_modules`（281 个 `@deepseek-ai` 包）+ `launcher.js` 的 main 图校验基于自身目录；**未在 Electron 进程内直接复测**（需用户重启才能确认）。
- 【未验证】用户重启后 `GET http://127.0.0.1:43120/health` 是否 10/10 全绿 —— 这是本次回滚的唯一验收口径。

---

## 7. 待用户决策

- **A（推荐先做）**：留在 0.1.1 运行态；我按 §5 出一份「settings 迁移」专项计划（含测试矩阵与回滚），批准后实施 → 再重跑 promote/冒烟。
- **B**：暂缓 0.1.7，先把仓库侧已 0.1.7 化的门禁/脚本与 0.1.1 运行态解耦（避免 smoke/verify 长期红）。
- **C**：其他（如先复核 vendor 目录是否真未被运行时引用 — 可加一次带调试端口的诊断重启，需用户批准）。
