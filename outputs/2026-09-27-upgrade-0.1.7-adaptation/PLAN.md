# 升级 0.1.7 适配方案 · G2-G4（settings / jobs / pwsh-sandbox / agent-presets）

> 日期：2026-09-27 ｜ 关联：master plan P3（typecheck 全绿前置）
> 背景：P3-2 build 失败（40 TS 错误），G1（ProfileTemplate）已修复清零。本文给出剩余 G2-G4 的**逐处新 API 对照与改动方案**，供实施与记录。
> 原则：**行为等价迁移**（不引入新功能/不改变语义），0.1.7 新 API 为权威。

## G2 · settings（index.ts 14 处 / main.ts 4 / notifications.ts 6）

### 0.1.7 模型（实测）
- **namespace = 字符串**（`"ui-theme"`/`"locale"`/entry-id），`settingsNamespace('x')` 工厂已删，`SettingsNamespace` 为 Branded<string> 类型（`'x' as SettingsNamespace` 构造）。
- **注册**：无 `settings.register(ns, schema, opts)`。schema 通过**插件 Config** 自动成为 entry 设置（`SettingsNamespaceView {ns, schema, value, applies:'live', revision}`）。
- **读**：`ctx.settings.describe()` → `{writable, hasDocument, namespaces: view[]}`；value 是 resolved（含 default）配置。
- **写/提交**：`update(ns, patch, expectedRevision?)` / `replace(ns, section, expectedRevision?)` / `mutate(ns, ops, expectedRevision?)`。
- **事件**：`settings/updated` → **`settings/document-updated(ns, revision)`**。

### 改动清单
| 位置 | 现状（0.1.1） | 改为（0.1.7） |
|---|---|---|
| `src/index.ts:17` | `import { settingsNamespace } from '@deepseek-ai/dsh-settings'` | `import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'` |
| `:66-69` | `settingsNamespace('dsh-desktop')` 等 3 处 | `'dsh-desktop' as SettingsNamespace`（保留导出名供其他文件引用）；同名替换 |
| `:162-173` | `ctx.settings.register(DESKTOP_SETTINGS_NAMESPACE, DesktopSettingsSchema, {applies:'restart', validate})` | **删除**（0.1.7 由插件 Config 自动暴露；`DesktopSettingsSchema` 保留为类型，或并回 Config）。**validate 语义**：schema validation 由 Config z.object 承担（:105 已有 mode/port） |
| `:269-289` | `settings.watch(next => ...)` 重启 watch | 改为监听 `ctx.on('settings/document-updated', (ns) => { if (ns === DESKTOP_SETTINGS_NAMESPACE) { 读 describe 的新 mode/port 对比 config，变更则 requestRestart } })` |
| `:291-299` | `ctx.on('settings/updated', ...)` 2 处（theme/locale） | `ctx.on('settings/document-updated', ...)` + ns 比较（`(ns as string) === 'ui-theme'` / `'locale'`） |
| `:309` | `ctx.settings.get(UI_LOCALE_SETTINGS_NAMESPACE)?.preference` | 辅助 `readSettingsView(ctx, ns)`：`ctx.settings.describe().namespaces.find(v => v.ns === ns)?.value`；`(value as LocaleSettings | undefined)?.preference` |
| `:312` | `ctx.settings.get(UI_THEME_SETTINGS_NAMESPACE)` | 同上（theme value 含 preference；`undefined` 时保持抛错语义） |
| `src/main.ts:1054-1055` | `ctx.settings.get(...)` + `settings/updated` | 同上模式 |
| `src/notifications.ts:6,109-125` | `settingsNamespace` + `settings.register` + `settings/updated` | 同 index.ts 模式 |
| 事件消费者 | `next` / `namespace` 参数 | `document-updated` 只有 (ns, revision) → 事件内再 `describe()` 取值 |

### 验证
- typecheck 无 settings 相关错误
- 行为：desktop 设置（mode/port）仍可被读取、变更仍触发重启；theme/locale 跟随仍生效（冒烟 T-8 覆盖）

## G3 · jobs（notifications.ts 2 处）

### 0.1.7 模型（实测）
- `JobSnapshot` **不再导出** → `JobView`（`JobRegistry.list(): JobView[]` / `get(): JobView`）。
- `onJobDone` 不在 JobRegistry 方法 → `abstract readonly events: JobEvents`（事件源）。

### 改动清单
| 位置 | 现状 | 改为 |
|---|---|---|
| `notifications.ts:4` | `import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'` | `import type { JobView } from '@deepseek-ai/dsh-jobs'` |
| `:125` | `jobs.onJobDone?.(...)` 或 `onJobDone(snapshot)` | 需看用法：若是注册回调 → 改用 `jobs.events` 事件；若是读快照 → `jobs.get(id)`/`list()` |

> ⚠️ `notifications.ts` 的 `onJobDone` 用法**需先读该文件现场**再定具体替换（见实施步骤）。

## G4 · pwsh-sandbox（windows-pwsh-sandbox.ts 6 处）

### 0.1.7 模型（实测）
- `PwshLocalExecutor` 配置变 `Volatile<T>`（cordis 0.1.7 引入），取值 **`config.x.get()`**。
- `SandboxPwshExecutor` 的 override 点从 `runArgv/startArgv` → **`executeArgv(spec, callback)`**（execute 前拦截 argv）。

### 改动清单
| 位置 | 现状 | 改为 |
|---|---|---|
| `:59` | `config.pwshPath.length > 0` | `config.pwshPath.get().length > 0`（Volatile 解包）|
| `:61` | `{...config, pwshPath}`（赋 string 给 Volatile） | 需按 Volatile 构造方式：`{...config, pwshPath: z.string().volatile().parse(pwshPath)}` 或对应 setter —— **实施时读 PwshConfig 的 pwshPath 类型** |
| `:111-119` | `override runArgv/startArgv` | **改为 override `executeArgv(spec, callback)`**：`return super.executeArgv(adaptedSpec, async (signal) => adapted.argv)`（签名依运行时 `executedArgv(spec, async(signal)=>{...})`）|

> ⚠️ `executeArgv` 精确签名（spec/callback 类型）实施时从 `SandboxPwshExecutor.d.ts` 或 index.js 确认。

## G5 · agent-presets（windows-agent-presets.ts 2 处 + 运行时兼容）

### 问题（实测）
- `agent-presets@0.1.5-rc.3` 仍 `settings.register(...)`（运行时），settings 0.1.7 **无 register ⇒ 加载即崩**。
- 该包 npm 最新 0.1.6-alpha.2 也仍用 register（不治本）。
- `PresetExistsError`/`UnknownPresetError` 不再导出（0.1.5 重构为 `RemoteError<'agent-preset/invalid'`）。

### 方案（待实施时验证）
- 优先：**用 0.1.5 的新 API 重写 `DesktopWindowsAgentPresets`**（`presetExists()/readComposition/discoverPresets` 等替代旧类的 resolve/copy/list）。但 `windows-agent-presets.ts` 继承的是 **0.1.1 的 `AgentPresets` 类**（已不存在）。
- 若重写成本高：**Windows preset 守卫功能在本轮升级中禁用/降级**（把 `desktop-windows-agent-presets` 插件标记 disabled 或功能走 Config 默认值），记入冒烟待查项，后续专门批次重做。
- **需用户决策**（影响功能可用性）：重写（保功能）vs 降级（升级先过、功能后补）。

## 实施顺序
1. G4（windows-pwsh-sandbox，改动最小、风险低）
2. G3（notifications jobs，先读现场）
3. G2（settings，最大件；先做 index.ts 主干 → main/notifications）
4. G5（agent-presets，单独决策后）
5. 每步 `typecheck` 增量变绿；全绿后 `yarn build`

## 回滚
- vendor git（`prod-baseline-20260823`）+ `_backups/kernel-upgrade-*` 全量还原；运行中应用未动。

---

## 实施结果（2026-09-27，已执行完成）

### 已完成（src 全绿）
| 组 | 改动 | 结果 |
|---|---|---|
| **G1** | ProfileTemplate 对象化（profile/profile-manager/desktop-plugins 8 处）+ 删 healProfilesModuleFallback | 0 错 |
| **G2** | index.ts（register 删、settingsValue helper、document-updated 事件、readLocale/Theme 改 describe）+ main.ts + notifications.ts | 0 错 |
| **G3** | jobs：JobSnapshot→JobView；onJobDone→events.subscribe（{owners:'all'} + settled/awaited 过滤）| 0 错 |
| **G4** | pwsh-sandbox：Volatile `.get()` 解包 + runArgv/startArgv→executeArgv（单统一 hook）| 0 错 |
| **G5** | **agent-presets 降级**：0.1.5 无 AgentPresets 类 + settings.register 崩 → profile.ts Windows 分支移除（全平台用上游 presets）+ windows-agent-presets.ts 进 tsconfig exclude | 0 错 |
| **client** | desktop-settings.ts `settingsScope.bind`（0.1.7 删）→ unavailableScope stub（设置页显示不可用不崩）；AdvancedFrame useSessions 参数显式类型 | 0 错 |

**验证**：`tsc -p tsconfig.json --noEmit` = **0 错误**；`yarn build` = **exit 0**（tsdown 78 文件 + vite 1884 modules + tsc emit 全过）。

### P-遗留项（升级后专门批次，不阻塞 build）
1. **client 设置页绑定**：desktop-settings.ts 用 `unavailableScope` 占位——真正迁移需用 0.1.7 的 `dsh-client-ui-settings` ConfigForms/remote.settings 重写桌面设置页数据流。
2. **Windows agent-presets 守卫**：minimal→standard 替换功能待按 agent-presets 0.1.5 新 API（presetExists/RemoteError）重做。
3. **notifications 自定义设置**：0.1.7 无 register → 设置保持默认，待改造成 entry Config。
4. **tests/**：tests 用旧 API（JobSnapshot/settingsNamespace/register 等 19 处）+ `dsh-llm-deepseek` 缺失——`yarn test` 需在 tests 适配后通过（不影响 build/product）。

### 教训（记录）
- 0.1.7 settings 模型：**namespace=entry Config 自动发现**，无 register/自定义 namespace；取值 describe()，事件 document-updated；Volatile<T> 用 .get() 解包；jobs 用 events.subscribe（settled 未 awaited 才通知）。