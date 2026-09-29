# U6-0a 实施完成 · 0.1.7 build 已可启动（链接期守卫转绿）

> 日期：2026-09-27 22:20 ｜ 性质：**代码落地 + 构建 + 真实守卫验收**
> 关联：`outputs/2026-09-27-u6-0-settings-migration/DECISION.md`（§7 实施记录，逐文件改动与 D-9 判断）、`outputs/2026-09-27-incident-0.1.7-startup-crash/report.md`、`outputs/2026-09-27-b3-dist-export-gate/REPORT.md`
> 状态：**新 build `dist/win-unpacked-build202609272210` 通过打包态链接期守卫（exit 0）⇒ 0.1.7 启动阻塞解除**。**未 promote**（等 U6-0c 与设置连续性核对后由用户重启合并验收）。

---

## 1. 结论（先结论）

| 项 | 结果 |
|---|---|
| **打包态链接期守卫（U6-0 的验收器）** | `node scripts/verify-dist-exports.mjs` → **PASS / exit 0**（`45 lib modules, 45 linked clean`；替代量如实上报 `COMMONJS_TARGET=16 UNRESOLVED=3`）。**事故原 4 项 `MISSING_EXPORT`（SettingsProvider ×3 + PresetExistsError ×1）全部消失** |
| **构建完整性** | `node scripts/check-dist-integrity.mjs <新 build>` → **OK**（unpacked 契约 + 14 相对导入） |
| **N1 陈旧产物** | 修复：删 `tsdown.config.ts:30` entry + 删 `verify-packaged-runtime.ts` 两处必填引用 + 删 `package.json` 死子路径导出 ⇒ 新构建 **不含 `windows-agent-presets.js`**（此前 it 是「被排除编译却仍被产出并打包」的陈旧产物） |
| **dist 补丁重打** | 6/8 OK；**2 项 fail-closed（已知 P-遗留，非本次引入）**（见 §4） |
| **打包** | `electron-builder --dir` → `dist/win-unpacked-build202609272210`（完整布局：exe + `app.asar` + `app.asar.unpacked`（281 个 `@deepseek-ai` 包））；**曾因** `verify-packaged-runtime` 仍把 `windows-agent-presets.js` 列为**必填**而中断，删除后产物完整 |

---

## 2. 代码改动（全部 tsc 绿；与 DECISION §7.2 一致）

核心链：`src/profile.ts` 删除 `dsh-settings-file` 全链（import/常量/读取/断言/钩子）→ `mode/port/logLevel` 改读 composed `desktop-shell` 行；新增**单一写入器** `src/desktop-shell-settings.ts`（`withFileLock` + `writeFileAtomic` + 注释保留 + Linux 拒 advanced）；`index.ts` 的 `Config` 加 `logLevel` 并删 0.1.1 的 settings namespace 遗留；`notifications.ts` 的 5 开关改为该 entry 的 Config；恢复窗「打开配置文件」动作删除；`main.ts` 的 logLevel 改读 `prepared.logLevel`。

类型检查：`tsconfig.json` / `client` / `native-ui` / `tests.client` = **0 错误**；`tsconfig.tests.json` = **29 → 13 错误（净 -16）**，剩余全为 **pre-existing** 0.1.7 适配遗留（P-遗留 #4）。

---

## 3. 关键判断（实施中补拍，已写入 DECISION §7.1 = D-9）

`dsh-settings` 0.1.7 的 `describe()` **只投影 volatile 子树**，`update()` 对无 volatile 字段的 entry 直接抛错 ⇒ 若走官方设置面必须把所有字段改成 `Volatile<T>` 并改全部调用点。**既然 D-2 已选定自持 API，就不为不用的通道付出该代价** ⇒ 用自持写入器（单一写者），重启由写者驱动。

## 4. 已知遗留（诚实列出，均非本次引入）

| 项 | 说明 | 归属 |
|---|---|---|
| `port-user-patches` **fail-closed** ×2 | `dsh-client-ui-workspace`（workspace ADD_CHAT 上游已重写）+ `dsh-session-persistence-jsonl`（zstd 锚点漂移）⇒ 守门员按设计拒绝把旧 canon 写到已迁移的上游 | **P-遗留 B3**（需按官方片段重做 canon） |
| `apply-winhide-patches` **anchor missing** ×2 | `dsh-sandbox-local`（patch #15 windows-acl runner node）在 vendor 与新构建中都缺锚点 | **P-遗留 B1** |
| 单测剩余 13 个错误 | 全为 0.1.7 适配遗留（windows-\* / JobSnapshot / 缺包 / subprocess handle） | **P-遗留 #4** |

**性质**：这些是**功能层退化**（app 可启动，个别补丁未重打），需独立批次重做，**不阻塞 promote**。

## 5. 工程教训（已写入 DECISION §7.4，复用价值高）

1. sandbox 内 `corepack yarn` / `scripts/package-vendor.ps1` **全部不可用**（报「系统找不到指定的路径」）⇒ 构建必须**直接 node 逐步调用**（icons → clean → tsdown → vite → tsc → electron-builder）。
2. **`verify-packaged-runtime.ts` 是 electron-builder 的 `afterPack` 钩子**，硬性要求列出的每个文件存在 ⇒ 删一个构建 entry 必须**同步删它的必填引用**（否则打包中断）。
3. **electron-builder 即使 `afterPack` 校验失败，磁盘上的产物也已完整**（失败发生在布局完成后）⇒ 若校验已修复，可直接复用该目录，不必重打。

---

## 6. 下一步（按 DECISION D-6 三批推进）

- **U6-0c（推荐，立即）**：设置页回补 —— `/api/desktop/settings` 新增 POST（复用 `writeDesktopShellSettings` + `scheduleRestart`）+ 客户端 Shell/Notifications 两节从 `unavailableScope` 改接。**免重启**，完成后重 build → 守卫保持绿。
- **U6-0b（依赖 0.1.7 运行态）**：设置连续性核对（`settings.yaml` 8 section → `settings.describe()` 生效值差异表 + 定点补救）。
- **promote + 用户重启**：三者（a/b/c）共用一次重启合并验收，随后冒烟 T-1..T-13。

---

## 7. 证据

| 断言 | 级别 | 出处 |
|---|---|---|
| 守卫在新 build 上 PASS（exit 0、45/45、4 项事故报错消失） | 【实测】 | `C:\Temp\vde-newbuild.txt` |
| 完整性 OK | 【实测】 | `check-dist-integrity.mjs` 输出 |
| 新构建不含 `windows-agent-presets.js`；`writeDesktopShellSettings` 存在于包内（`lib/index.js`） | 【实测】 | 文件系统 grep |
| 2 项补丁 fail-closed / anchor missing 属已知遗留 | 【实测】 + 【推断】（与 P-遗留 B1/B3 一致） | `C:\Temp\u60a-patches.log` |
| tests 剩余 13 错误全为 pre-existing | 【实测】 | `tsc -p tsconfig.tests.json --noEmit`（基线 29 → 现在 13） |
