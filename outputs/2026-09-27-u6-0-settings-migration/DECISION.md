# U6-0 settings 行迁移 · 调查与判断（DECISION）

> 日期：2026-09-27 21:15 ｜ 状态：**判断已定，待实施**（实施＝纯代码 + 构建，不需重启；promote/重启在最后一步）
> 输入：`outputs/2026-09-27-incident-0.1.7-startup-crash/report.md`（崩溃根因）、`outputs/2026-09-27-b3-dist-export-gate/REPORT.md`（守卫，现为本项验收器）、master plan v2 §U6-0
> 授权：用户「你做好调查和分析，然后来判断，做好记录」⇒ 本轮**由我拍板**，理由与被否选项一并记录。

---

## 1. 调查结论（源码级，全部【实测】读码）

### 1.1 断裂面只有一处（比预估小）

`@deepseek-ai/dsh-settings-file` 在**整个 src 里只被 `profile.ts` 一个文件引用**：

| 位置 | 内容 |
|---|---|
| `profile.ts:23-26` | `import FileSettingsProvider, { resolveSpec as resolveSettingsFileSpec, type Config as SettingsFileConfig }` |
| `profile.ts:72` | `const SETTINGS_FILE_PACKAGE = '@deepseek-ai/dsh-settings-file'` |
| `profile.ts:120-140` | 纯函数 `desktopStartupSettingsFromSettings(document)` / `desktopShellModeFromSettings(document)` |
| `profile.ts:148-183` | `readDesktopStartupSettings(config)`（读 settings.yaml）/ `readDesktopShellMode(config)` |
| `profile.ts:707-716` | **assert**（settings 行必须是 settings-file）+ `FileSettingsProvider.Config(...)` + `resolveSettingsFileSpec(...)` + `hooks.onSettingsDocumentResolved(...)` + `readDesktopStartupSettings(...)` |
| `profile.ts:214 / 865` | `DesktopStartupRecoveryConfigurationPaths.settingsDocument`（传给启动恢复窗） |

调用链：`main.ts:684 prepareDesktopProfile(...)` + `main.ts:693 onSettingsDocumentResolved` → `main.ts:612-617 startupRecoveryConfigurationPaths` → `startup-recovery-window.ts:681/821/829 openConfigurationPath('settingsDocument')`（恢复窗的「打开配置文件」动作）。

### 1.2 mode/port 在 0.1.7 里其实**已经有家**

- `index.ts:100-115` 的 **插件 `Config`** 已声明 `mode` / `port`（外加窗口尺寸）——**这就是 `desktop-shell` 这一 entry 的配置**，由 profile patch 持久化。
- `index.ts:168-171` 的适配注释已写明：「0.1.7 下桌面设置就是插件自身的 Config，由 settings 服务自动暴露」。
- 旧 `DesktopSettings`/`DesktopSettingsSchema`（`index.ts:71-87`，namespace `dsh-desktop`，含 `mode/port/logLevel`）是 **0.1.1 的文件型 namespace 遗留**。
- `profile.ts:716` 读取的 `mode` 只用于「advanced 模式启用 ui-layout/ui-sidebar/ui-conversation 三行」+ 端口默认值 —— **完全可以从 composed rows 里读，不需要 settings 文档**。

### 1.3 尚未被接回的功能（当前是「静默降级」）

| 功能 | 现状 | 证据 |
|---|---|---|
| 设置页 Shell 节（mode/port/logLevel） | 客户端拿 **`unavailableScope` 占位** | `client/desktop-settings.ts:29-34,53-54` |
| 设置页 Notifications 节（5 开关） | 同上 | 同上 |
| 改 mode/port 触发重启 | 监听 `settings/document-updated` 并读 `dsh-desktop` 值 —— 该 namespace **已不存在** ⇒ **实际是死代码** | `index.ts:168-171`、`main.ts:1055-1057` |
| `logLevel` | 仍从 `settingsValue(ctx,'dsh-desktop')` 读 ⇒ 恒为默认 `info` | `main.ts:1054` |
| Notifications 开关 | `notifications.ts:107-110` 明确注释「设置为默认值，等 entry Config」 | `notifications.ts` |
| 「打开配置文件」恢复动作 | 指向 `~/.dsh/settings.yaml`（0.1.7 会把它导入后**改名为 `settings.yaml.imported`**）| `main.ts:613`、`startup-recovery-window.ts:821` |

### 1.4 **重大发现（N5）：`settings.yaml` 是用户的「全量设置文档」，桌面部分反而不在里面**

`~/.dsh/settings.yaml`（**13,850 B，mtime 2026-09-27 13:53**，即今日仍在写入）含 **8 个 section**：

| section | 0.1.7 是否有同名 entry id | 判定 |
|---|---|---|
| `ui-theme` | ✅ `ui-theme` | 直接映射（上游自动导入） |
| `ui-conversation` | ✅ `ui-conversation` | 直接映射 |
| `llm-pi-ai` | ✅ `llm-pi-ai` | 直接映射 —— **用户全部自定义 provider/模型在此**（opencode-go / SenseNova …）|
| `agent-default-model` | ✅ `agent-default-model` | 直接映射 |
| `llm-deepseek` | ✅ `llm-deepseek` | 直接映射 |
| `ui-onboarding` | ❌ 无同名 | 上游 README 明列别名 `ui-onboarding → ui-settings-general` ⇒ **可导入** |
| `agent-presets` | ❌ 无同名（有 `agent-preset-registry`）| **存疑**：消费者是本轮已降级（G5）的 Windows preset 守卫 ⇒ 很可能**无消费者** |
| `dsh-community-market` | ❌ 无同名 | **存疑**：需确认市场 bundle 的 entry id（profile patch 里未见该行） |

**⇒ 三个后果（必须记录）**

1. **桌面 mode/port 根本不在旧文档里**（无 `dsh-desktop` / `dsh-desktop-notifications` section）⇒ **U6-0a 没有「旧值迁移」负担**，只需把读取/写入改家。
2. **真正的风险面是这 8 个 section**：0.1.7 的 `dsh-settings` 会**导入一次**（按 section 名 = entry id，带别名），把文件改名为 `settings.yaml.imported`；**不匹配的 section 只记日志并留在改名文件里**（= 用户以为设置还在，实际未生效）。
3. 因此 **U6-0 必须带一条「设置连续性核对」**：逐 section 对比「旧 YAML 值 → 新内核 `settings.describe()` 生效值」，产出差异表；对无消费者的 section 明确记为「已停用」而不是「静默丢失」。

---

## 2. 判断（我拍的板，含被否选项）


### D-1 mode/port/logLevel 的家 ⇒ **`desktop-shell` entry 的插件 Config**（profile patch 持久化）
- **理由**：0.1.7 原生模型就是「entry 的 Config」；我方的「唯一写者 + 原子写 + 可回滚」纪律与 A0（`session-projection-cache` profile 覆盖）先例完全一致。
- 被否：① 继续用文件型 settings provider —— **该包全系与 0.1.7 不兼容（无 0.1.7 版本，alpha 同样 import 已删除的导出）**，物理上不可行；② 造一个自研文件 provider —— 多一个长期维护面，且 0.1.7 的 settings 服务已把持久化收敛到 profile patch。

### D-2 设置页的写入通道 ⇒ **走我们自己的 `/api/desktop/settings`（新增 POST），不走 0.1.7 ConfigForms**
- **理由**：① 该 API 已是**我们自持**、严格同源回环、有独立契约与路由（`desktop-settings-{contract,route,controller}.ts`）；② `controller` 已经具备 `scheduleRestart()`（mode/port 改完必须重启 —— 现成能力）；③ `dsh-client-ui-settings` 的 ConfigForms 是**本轮新引入的上游 alpha 面**，我们没有任何现成消费代码，赌它＝把可用性押在上游 churn 上；④ 写 profile patch 与 D-1 同一写者。
- 被否：让字段变 `.volatile()` 以并入官方设置 UI（`dsh-settings` README：forms 只投影 volatile 字段）。**留作将来可选**（若日后想并入官方设置页），本轮不做。

### D-3 `settings` 行本身 ⇒ **不再由桌面 push 任何 config**（交给 base bundle）
- 0.1.7 的 `@deepseek-ai/dsh-base/cordis.patch.yml:101-103` 已挂 `- id: settings / name: '@deepseek-ai/dsh-settings'`（无配置字段）。我方 profile.ts 的 assert 与 Config push **整体删除**。

### D-4 旧的 `~/.dsh/settings.yaml` ⇒ **不改写它，改为「核对 + 补救」**（据 §1.4 修正）
- 0.1.7 原生会在 Loader 稳定后**导入一次** `settings.yaml`：按 section 名 = entry id 写进对应 entry，然后把文件改名为 `settings.yaml.imported`；不匹配的 section **只记日志并留在改名文件里**。
- 我们的 section 名是 `dsh-desktop` / `dsh-desktop-notifications`，而 entry id 是 `desktop-shell` / `desktop-notifications` ⇒ **必然走「不匹配」支路**（用户设置会「消失」）。
- **实测修正**：旧文档里**没有** `dsh-desktop` / `dsh-desktop-notifications` section ⇒ 桌面设置**无值可迁**（当前就是默认值）。
- 因此真正的迁移面是 **§1.4 的 8 个 section**（主题/会话/模型/provider/preset/市场）。判断：**不预先改写用户的 13.8KB 文档**（改写风险高于收益，且上游有内置导入器），而是：
  1. **升级前**把 `settings.yaml` 与其全部 `.bak-*` 一起备份（已由 `_backups/kernel-upgrade-*` 覆盖 sessions/storages，需**补一份 settings.yaml**）；
  2. **升级后**跑「设置连续性核对」（D-8）逐 section 比对生效值；
  3. 对未生效的 section 做**定点补救**（写进 profile patch 的对应 entry config），而不是整份迁移。

### D-5 启动恢复窗的「打开配置文件」⇒ **改指 profile patch**
- 0.1.7 里用户可编辑的真实配置是 `~/.dsh/profiles/desktop/cordis.patch.yml`（该路径**已在同一结构体里**：`main.ts:614 profilePatch`）。指向即将被改名的 `settings.yaml` 会给出**误导性内容**。
- 做法：`DesktopStartupRecoveryConfigurationPaths.settingsDocument` → 改名为 `profilePatchFile`（或直接复用既有 `profilePatch` 字段），并同步 `startup-recovery-window.ts` 的动作与文案。

### D-6 实施批次 ⇒ **三批：U6-0a 解阻塞 / U6-0b 设置连续性 / U6-0c 设置页回补，同一次重启合并验收**
- **U6-0a（必须）**：让 0.1.7 build **能启动** —— 清断裂面（profile.ts 等）+ mode/port 改家 + 恢复窗指向 + 删陈旧产物（D-7）。
- **U6-0b（必须）**：**设置连续性** —— 备份 `settings.yaml` + 核对脚本（D-8）+ 未生效 section 的定点补救。
- **U6-0c（功能）**：设置页 Shell/Notifications 两节恢复可编辑（私有 API POST + 客户端改接线）。
- **理由**：a 是唯一硬阻塞，做完即可用 **Step 1.18 守卫转绿**证明「build 可启动」；b 防止用户 13.8KB 配置「看似还在、实际未生效」；c 面最大（客户端+路由）。三者共用**同一次重启**验收，避免多次重启打断。

### D-7 N1（陈旧产物）⇒ **删 tsdown entry + 清产物 + 加断言**（保留源文件）
- 根因【实测】：`tsdown.config.ts:30` 把 `'windows-agent-presets': 'src/windows-agent-presets.ts'` **列为构建 entry**；`tsconfig.json` 只 exclude 了**类型检查** ⇒ tsdown 照旧产出（`lib/windows-agent-presets.js` 1533 B，18:40 重建、18:41 打包）。
- 判断：**移除该 entry**（停产出）+ 清 `lib/` 与 dist 内的陈旧产物 + 新增断言「**被 tsconfig exclude 的源，其产物不得出现在 lib/**」；**保留源文件**（U7「Windows preset 守卫重做」要用，已记 P-遗留 #2）。
- 被否：只删产物（下次 build 又回来）。

### D-8 设置连续性 ⇒ **必须做「逐 section 生效值核对」，并补一份 `settings.yaml` 备份**
- **理由**：0.1.7 的导入器把**不匹配的 section 留在改名文件里**（`settings.yaml.imported`）——用户会以为设置还在。这是**静默数据降级**，正是本项目最忌讳的失败模式（「日志/指标不撒谎」）。
- 做法：新增核对脚本（读旧 YAML + 读新内核 `settings.describe()`，逐 section 逐键比对）→ 产出 `outputs/<date>-settings-continuity/DIFF.md`；未生效项按 D-4 第 3 步定点补救。
- 备份：`~/.dsh/settings.yaml` + `settings.yaml.imported`（升级后）+ 全部 `.bak-*` 一并纳入 `_backups/kernel-upgrade-*`。

---

## 3. 逐文件改动清单（U6-0a）

| # | 文件 | 改动 |
|---|---|---|
| 3.1 | `src/profile.ts` | 删 `dsh-settings-file` import / `SETTINGS_FILE_PACKAGE` / `FileSettingsProvider.Config` / `resolveSettingsFileSpec` / `onSettingsDocumentResolved` 钩子调用；`readDesktopStartupSettings` 改为**从 composed rows 的 `desktop-shell.config` 读**（保留 `DesktopShellMode` 校验 + 端口范围校验）；删除对 `settings` 行的 assert 与 config push |
| 3.2 | `src/profile.ts`（类型） | `DesktopStartupRecoveryConfigurationPaths.settingsDocument` → `profilePatchFile`（值与 `main.ts:614` 的 `profilePatch` 同源） |
| 3.3 | `src/main.ts` | 删 `onSettingsDocumentResolved` 钩子与 `settingsDocument: join(homeDir,'settings.yaml')`；`startupRecoveryConfigurationPaths` 改填 profile patch；`logLevel` 改从 shell Config 读（`:1054`）；重启监听改 **entry id `desktop-shell`**（`:1055-1057`）|
| 3.4 | `src/index.ts` | shell `Config` **新增 `logLevel`**（补齐功能）；`DesktopSettings`/`DesktopSettingsSchema` 与 `DESKTOP_SETTINGS_NAMESPACE` 处置：**退役**（仅保留迁移脚本需要的读取常量）——注意 `main.ts:45` 的 import 同步 |
| 3.5 | `src/notifications.ts` | 为 notifications entry **新增 `Config`**（`enabled` + 4 个 notify 开关，默认与现 `DEFAULT_SETTINGS` 一致），从 Config 读值，删死掉的 namespace 监听 |
| 3.6 | `scripts/settings-continuity.mjs`（新，U6-0b） | **核对 + 定点补救**：解析 `settings.yaml` / `settings.yaml.imported` 的 8 个 section，与 0.1.7 `settings.describe()` 生效值逐键比对 → 输出差异表；对未生效 section 生成 profile patch 补丁（`withFileLock` + 原子写 + `.bak-<ts>`），**默认只报告，`--apply` 才写入** |
| 3.7 | `src/startup-recovery-window.ts` | `openConfigurationPath('settingsDocument')` → 指向 profile patch；文案（en/zh）同步为「打开配置文件（profile patch）」 |
| 3.8 | `tsdown.config.ts` | 删 `windows-agent-presets` entry（D-7） |
| 3.9 | `tests/` | 适配（settings 相关用例旧 API）；为迁移脚本补单测（旧值 → patch 写入 → 幂等重跑不重复写）|

### U6-0c（设置页回补，同批重启验收）

| # | 文件 | 改动 |
|---|---|---|
| 3.10 | `desktop-settings-contract.ts` / `-route.ts` / `-controller.ts` | `/api/desktop/settings` **新增 POST**：`shell`（mode/port/logLevel）与 `notifications`（5 开关）；控制器写 profile patch + 校验 + `scheduleRestart()`（仅 mode/port 需要） |
| 3.11 | `client/desktop-settings.ts` + `DesktopSettingsSection.tsx` | 两节从 `SettingsScope` 改接私有 API（`unavailableScope` 删除）；busy/错误态沿用现有 `BusyOperation` 机制 |
| 3.12 | 断言（新） | 「被 tsconfig exclude 的源不得残留产物」纳入 `check-dist-integrity.mjs` 或 Step 1.18 之外的新 step |

---

## 4. 验证矩阵

| 阶段 | 验证 | 通过判据 |
|---|---|---|
| 静态 | `tsc -p tsconfig.json --noEmit`（含 client/tests 两套） | 0 错误 |
| **解阻塞** | 重新 build → **`node scripts/verify-dist-exports.mjs`** | **exit 0**（当前 4 项 FAIL 必须归零 —— 这是 U6-0 的验收器） |
| 完整性 | `node scripts/check-dist-integrity.mjs <新 build>` | unpacked 契约 + 相对导入全绿 |
| 连续性（U6-0b） | 核对脚本：① `llm-pi-ai` / `ui-theme` / `agent-default-model` / `llm-deepseek` / `ui-conversation` 五项生效值 = 旧 YAML 值 ② `ui-onboarding` 经别名生效 ③ `agent-presets` / `dsh-community-market` 给出「无消费者/未生效」明确结论 ④ 备份可回滚 | ①-④ 全过，且差异表归档 |
| 门禁 | `check-all.ps1`（**真实终端**） | 仅 pre-existing 项（health-check / Step 2.6 patch drift）红 |
| 冒烟（用户重启后） | T-1..T-13 + **T-13 扩展**：设置页改 mode/port → 提示重启 → 重启后生效；改 notifications → 立即生效 | 全过 |
| 回归 | 「advanced 模式仍能启用三行」「logLevel 生效」「恢复窗『打开配置文件』指向 patch 且可打开」 | 3/3 |

## 5. 风险与回滚

| 风险 | 等级 | 缓解 / 回滚 |
|---|---|---|
| 迁移写坏 profile patch | 中 | `withFileLock` + 原子写 + `.bak-<ts>`；patch 是纯文本可手工还原；旧 build 常驻可 promote 回 |
| mode/port 语义变化（从「文档」到「entry config」） | 中 | 保留 `DesktopShellMode` 校验与默认值；T-13 验收；用户设置经 3.6 迁移不丢 |
| 客户端改接私有 API 引入回归 | 中 | 沿用既有 busy/error 机制；先只改数据源不改编排 |
| 删 tsdown entry 影响其它产物 | 低 | 单条 entry 删除；`yarn build` 后看产物清单（78 → 77 文件）并核对 |
| 上游 `dsh-settings` 0.1.7 行为与 README 不符 | 低-中 | 已在 §1.2 用**实际入口配置**（dsh-base 的 101-103 行）核对过；迁移后 Step 1.18 + 冒烟双验证 |

## 6. 诚实边界

- 0.1.7 的 settings 服务「volatile 字段才投影到 forms」为 **README 陈述**，本机未构造 form 实验验证（不影响 D-2 的选择，因为我们自己写 patch）。
- `startup-recovery-window.ts` 的文案改动涉及 en/zh 两套 locale，改动点已列但**未逐条阅读全部文案键**（实施时逐个确认）。
- 核对脚本对「非 YAML / 异常 section」的处理策略：**只记日志、不写入、不删除**（fail-open 于用户数据，fail-closed 于写操作）。
- 「0.1.7 的导入器按 section 名=entry id（含别名表）导入」为 **README 陈述**；我按 entry id 集合做了静态比对（§1.4），但**未在真实 0.1.7 进程里观察过导入行为**（升级后才可见）⇒ `ui-onboarding` 的别名映射属【推断】。
- `agent-presets` / `dsh-community-market` 是否真的「无消费者」**未逐包读码确认**，留给 U6-0b 的核对脚本给结论。
