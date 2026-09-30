# DSH Desktop v2.0.16 升级：数据迁移清单与隔离记录

> 日期：2026-09-30
> 目的：**只做记录，不执行迁移**。把「必须保住的数据」定死位置与哈希，把「旧版干扰面」列清，并验证新版首启会发生什么。
> 状态：调查完成 · 隔离方案待用户确认后执行

---

## 0. 结论前置

1. **没有任何数据在 `D:\DSH-Desktop` 里。** 该目录 3,218 MB / 124,654 文件全部是 v2.0.2 过时产物，可整体删除，不影响任何用户数据。
2. **用户数据全在两处，都在 `D:\DSH-Desktop` 之外**：`C:\Users\机械革命\.dsh\` 与 `C:\Users\机械革命\AppData\Roaming\DSH Desktop\`。
3. **新版数据根与旧版逐字节相同**（`dsh-home-paths` 新旧包 107 行代码完全一致）→ 仍是 `~/.dsh`。装完自动读到 292 条会话，**无需手工迁移**。
4. **会话格式无需迁移**：新旧内核的 `dsh-session-format-catalog` 都是 `currentVersion: 4`。
5. **唯一会"被跳过"的是插件**：实测你 51 个 bundle 中 **8 个**声明了与 `0.2.0-rc.1` 不匹配的 peer 范围，会被**跳过而非阻断启动**；其余 43 个正常加载。你自己的 `@dsh-external/*` 插件因为写了 `>=0.0.1-rc <2` 宽松范围，**全部通过**。
6. **旧版仍有活的自动更新**（`updates/state.json` 记录已弹过 `2.0.5`）→ 这是必须处理的干扰点，否则可能被旧版拉去装别的版本。

---

## 1. 版本事实（三源交叉验证）

| | 本地在用（旧） | 官方最新（待装） |
|---|---|---|
| 壳 `dsh-plugin-desktop` | **2.0.2** | **2.0.16** |
| 内核 `@deepseek-ai/dsh` | 0.1.7-rc.2 | **0.2.0-rc.1** |
| `@deepseek-ai/cordis` | 4.0.4 | 4.0.4（**相同**） |
| cordis-plugin-loader | 1.0.5 | 1.0.5（**相同**） |
| 会话格式 `currentVersion` | 4 | 4（**相同**） |
| profile 状态 `STATE_VERSION` | **1** | **2**（← 唯一格式变更点） |

安装包：`C:\Users\机械革命\Downloads\DSH-Desktop-2.0.16-x64-Setup.exe`
269,333,800 B · SHA256 `0d330450cbaa9e1b5ac0420e35ff4db6afd82d73f4bcc3a9c3e421ef4fe6fa2c`（与官方一致）

新版结构变化：不再用 `resources/app.asar`，改为 **`resources/app/` 明文目录**（26,038 文件 / 1.16 GB 解包后）—— 意味着日后可直接读/改源码，不必再解包 asar。

---

## 2. 【必须保留】迁移清单

### 2.1 主数据根 `C:\Users\机械革命\.dsh`（合计 ≈ 1.72 GB）

| 项 | 文件数 | 体积 | 性质 | 处置 |
|---|---|---|---|---|
| `profiles/` | 59,204 | 1,005.7 MB | **活动配置 + 插件体**（含 `desktop/node_modules` 51 bundle） | **保留**，见 §2.2 |
| `sessions/` | 292 | 412 MB | **292 条历史对话 / 9 个工作区** | **最高优先级保留** |
| `storages/` | 278 | 121.4 MB | 会话索引、投影缓存、`workspace.json`（7 个工作区注册） | 保留 |
| `attachments/` | 387 | 81.3 MB | 对话附件 | 保留 |
| `.task-scheduler/` | 151 | 6.2 MB | 任务调度器状态 | 保留 |
| `super-injector/` | 30 | 2.1 MB | 插件注入器运行时状态 | 保留 |
| `tool-audit/` `tool-visibility/` | 2 / 2 | 1.6 / 1.3 MB | 插件审计数据 | 保留 |
| `.dsh-usage-ledger.json` | 1 | 1.2 MB | 用量账本 | 保留 |
| `skills/` | 116 | 0.7 MB | 用户技能 | 保留 |
| `memory-guard/` `.agent-presets/` `_backups/` | 2 / 35 / 34 | 0.3 / 0.2 / 0.2 MB | 记忆守卫、预设、settings 备份 | 保留 |
| `.credentials.yaml` | 1 | 1,838 B | **26 个 API Key**（见 §2.3） | **最高优先级保留** |
| `AGENTS.md` | 1 | 15,769 B | 全局 agent 指令 | 保留 |
| `settings.yaml.imported` | 1 | 14,209 B | **18 个模型 provider 定义的唯一存活副本**（见 §4.6） | **最高优先级保留** |

### 2.2 活动 profile `C:\Users\机械革命\.dsh\profiles\desktop\`（最关键）

这是**实时配置的真正所在**，不是 `~/.dsh/settings.yaml`。

| 文件 | 大小 | SHA256 | 作用 |
|---|---|---|---|
| `package.json` | 7,238 B | `052B5A39…56B3C16` | `dsh.profile.bundles` = **51 个 bundle** + 59 条依赖 |
| `cordis.patch.yml` | 4,692 B | `D1E03E59…0F62EABA` | 插件启用/禁用覆盖、MCP（firecrawl / markitdown，**含一把 API Key**）、模型 provider `qw`、压缩/搜索/标题等调参 |
| `pnpm-lock.yaml` | 222,873 B | `6C0B4436…4692DDE3` | 依赖锁定 |
| `node_modules/` | — | — | 49 个第三方 bundle 实际代码（`@dsh-external/*` 为指向 `D:\Deepseek-Harness\plugins\` 的链接） |

> ⚠️ `cordis.patch.yml:88` 内嵌 `FIRECRAWL_API_KEY`。备份/外传该文件时注意脱敏。

### 2.3 `.credentials.yaml` 键名（**只记名不记值**）

`OPENCODE_GO` · `SENNSENOVA` · `DEEPSEEK` · `DUOYUANX` · `TOKENRHYTHM01` · `OPENROUTER` · `YIDONG` · `HY3_PROXY` · `JUSTDOWORK` · `ZHIPU` · `BAIDU_QIANFAN` · `GOOGLE_AI_STUDIO` · `SILICONFLOW` · `VOLCENGINE_ARK` · `BAI` · `GROQ` · `SAMBANOVA` · `QINIU` · `AMD` · `MODELSCOPE` · `TOKENROUTER` · `CODECRAFT` · `APINEX` · `TOKENRY`（均后缀 `_API_KEY`，共 24 个）+ `version` / `refs` / `records`
文件 SHA256：`2FC795CF…5E7A8A4B`

### 2.4 桌面壳数据 `C:\Users\机械革命\AppData\Roaming\DSH Desktop\`

| 项 | 文件数 | 体积 | 迁移价值 |
|---|---|---|---|
| `profile-selection/state.json` | 1 | 72 B | **需要版本迁移**：当前 `version:1`，新版要求 `2`（见 §4.5） |
| `desktop-market/state.json` | 2 | 0.1 KB | 市场选择 = `community-market` |
| `health-snapshots/` | 11 | 232.3 KB | 健康状况历史 |
| `plugin-install-recovery/` | 6 | 400.1 KB | 一次插件安装失败的 `.before` 快照（可恢复用） |
| `updates/state.json` | 1 | 53 B | 旧版自动更新状态（已弹 `2.0.5`） |
| `lifecycle-events/` | 1 | 5.8 KB | 生命周期事件 |
| `diagnostics/` | 3 | 1,512.5 KB | 诊断包 |

### 2.5 已在手的完整冷备（回滚点，**勿动**）

`D:\Deepseek-Harness\备份\2026-09-29-full\` ≈ 927 MB，含：
`sessions/`（292 散文件）· `storages/`（278 散文件）· `profile-desktop.tar.gz`（195 MB，原 830 MB / 43,665 文件）· `appdata.tar.gz`（198 MB，原 505 MB）· `config/`（6 文件）· `meta/`（9 文件）· `README.md`（还原步骤）

另：`2026-09-29-cleanup`（728 MB）· `2026-09-29-isolated-old-build`（1.6 GB / 40,150 文件）· `2026-09-29-reorg`

---

## 3. 【可弃】清单

### 3.1 `D:\DSH-Desktop\`（3,218 MB / 124,654 文件）— 待你确认后删除

| 子目录 | 文件数 | 体积 | 为何可弃 |
|---|---|---|---|
| `vendor/` | — | 3,199 MB | v2.0.2 壳源码 + 依赖 + 我建的构建；工作区 `vendor/` 是同一份且是活动构建 |
| `plugins/` | 340 | 11.5 MB | **逐文件 SHA256 比对：0 个独有文件**，全部是 `D:\Deepseek-Harness\plugins\` 的子集 |
| `_backups/` | 33 | 3.6 MB | 构建时 dist 补丁备份，v2.0.16 下无意义 |
| `patches/` | 22 | 3.1 MB | v2.0.2 补丁体系，工作区 `patches/` 已完整持有 |
| `scripts/` | 131 | 1.0 MB | v2.0.2 配套脚本镜像，工作区 `scripts/` 为最新 |
| `data/` `outputs/` `downloads/` | 0 | 0 | **全空** |
| `_check-deps.mjs` `_diagidx.mjs` `_findclean.mjs` `_findsrc.mjs` `_restore-deps.mjs` | 5 | — | 我留的临时诊断脚本 |
| `_tmp/` | — | — | 本次调查解包暂存（v2.0.16 解包 1.16 GB），可留可删 |

**删除前的引用检查（已全部执行，0 命中）**：

| 检查项 | 结果 |
|---|---|
| 工作区全库搜索路径 `DSH-Desktop`（排除 node_modules/.git/备份/产出） | 命中的全是**产品名** `dsh-desktop`（npm 包名 / namespace 常量）或我自己写的记录，**无路径引用** |
| 三处 `node_modules` / `plugins` 的符号链接目标（含 `@scope/` 二级） | **0 个**指向 `D:\DSH-Desktop` |
| 桌面 + 开始菜单快捷方式的目标 / 参数 / 工作目录 | **0 个**指向它 |
| `D:\DSH-Desktop` 内部的 `.lnk` / `.url` | **0 个** |
| Windows 计划任务（`DSH`/`Harness`/`dsh` 匹配） | **0 个**引用它（`ATP-DSH-Web` 指向 `D:\Deepseek-Harness`，且已 `Disabled`；其余 `dsh_*` 是 RK3588 训练脚本，与 DSH 无关） |
| `storages/workspace.json` 的 7 个工作区 | **不含** `D:\DSH-Desktop` → 删除不会留下失效工作区条目 |

→ **结论：`D:\DSH-Desktop` 完全惰性，可整体删除。**

### 3.2 旧便携构建（`D:\Deepseek-Harness\vendor\...\dist\win-unpacked-build202609292211`）

v2.0.2 + 28 处源码适配 + 17 处 dist 补丁，`verify-patches` ALL PASS。
**这些补丁对 v2.0.16 全部无意义**（我们折腾的 6 类「壳↔0.1.7 接口缺口」在新版本本就不存在）。
建议：新版验收通过后再处置；`备份/2026-09-29-full/meta/` 已留源码适配 patch 可重放。

---

## 4. 旧版干扰面（4 个风险点 + 1 个格式变更）

### 4.1 ⚠️ 旧快捷方式仍指向旧构建

```
C:\Users\机械革命\Desktop\DSH Desktop.lnk
C:\Users\机械革命\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk
  → D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe
```
（`dist\win-unpacked` 是 junction，指向 `win-unpacked-build202609292211\win-unpacked`）
**风险**：误启动旧版 → 与新版共用 `~/.dsh` → 单实例锁冲突 + 旧内核改写新版写入的数据。

### 4.2 ⚠️ 旧版自动更新是活的

旧构建内置 `desktop-updates` 插件：`enabled` 默认 `true`，首查延迟 60 s，之后每 6 h 一次。
`%APPDATA%\DSH Desktop\updates\state.json` = `{"version":2,"lastPromptedVersion":"2.0.5"}`
→ **已经弹过一次更新提示**。若旧版被启动，可能再次下载并拉起安装程序。

### 4.3 ⚠️ 两版共用 `~/.dsh` 与 `%APPDATA%\DSH Desktop`

版本不是隔离的：数据根一致（§0.3）。**绝不能同时运行两版**。装完后旧版必须不可启动。

### 4.4 ℹ️ `settings.yaml.imported` 不是"丢失的配置"

新旧内核的 `dsh-settings` 都含同一段 `importLegacyDocument()`：启动时把 harness home 里的 `settings.yaml`
逐 section 导入 profile，**导入前先改名为 `settings.yaml.imported`**（一次性、防重复）。
日志证据（`logs\dsh-2026-09-29.error.log`）显示这次导入早已发生，且逐 section 报
`section llm-pi-ai … was not imported into entry llm-pi-ai` —— 即**该文件是导入后的残留物，不是实时配置**。
实时配置在 `profiles/desktop/cordis.patch.yml`（见 §2.2）。**新版不会读它，也不影响新版。**

### 4.5 ℹ️ 唯一的格式变更：`profile-selection/state.json` v1 → v2

| | 旧 | 新 |
|---|---|---|
| `STATE_VERSION` | 1 | 2 |
| 内容 | `{"version":1,"active":"desktop","lastKnownGood":"desktop"}` | 只认 `{version:2, active}` |

新版 `loadState()` 对解析失败**容错**：返回 `defaultState()`（= `{version:2, active:"desktop"}`）并置 `recovered: true`。
你当前 `active` 本就是 `desktop` → **重置后结果相同，无数据损失**，文件会被自动改写成 v2。

### 4.6 🔴 **更正**：你的 18 个模型 provider 只存在于 `settings.yaml.imported`

> 本节更正第一版记录中的错误结论（我曾把该文件写成"可弃的历史遗留"）。**它是迁移的核心资产之一。**

实测（`profiles/desktop/cordis.patch.yml` L116-128）：活动 profile 的 `llm-pi-ai` 段**只声明了 1 个 provider**：

```yaml
- id: llm-pi-ai
  config:
    providers:
      qw:
        apiKeyEnv: QW_API_KEY
        baseURL: https://tokenrhythm.studio/v1
        models: [ glm-5.1 ]
```

而 `settings.yaml.imported` 里有 **18 个 provider / 75 个模型**（`tokenry` `opencode-go` 等，`apiKeyEnv` 对应 `.credentials.yaml` 里的 24 个 key）。
`profiles/web/cordis.patch.yml` **没有 providers 段**（先前 grep 命中 `sensenova` 只是 modlens 的 `families` 白名单，非 provider）。

**为什么没迁进去**：日志逐条记录了失败——
```
[settings-forms] settings: section llm-pi-ai of C:\Users\机械革命\.dsh\settings.yaml.imported
                 was not imported into entry llm-pi-ai
   at async SettingsForms.importLegacyDocument (…/dsh-settings/lib/index.js:356)
```
在 `dsh-2026-09-28.error.log:649` 与 `dsh-2026-09-29.error.log:314` **各出现一次** → 说明 `settings.yaml` 被某处重新写出过，导入因此重跑并再次失败。

**对迁移的直接含义**：新版上来之后，模型侧看到的是 `qw` 一个 provider（且 `QW_API_KEY` 并不在 `.credentials.yaml` 的 24 个 key 里）。
把 18 个 provider 从 `settings.yaml.imported` 重新落进 profile 的 `llm-pi-ai.config.providers`，是**这次迁移里工作量最大、也最不能忘的一步**。
旁证副本：`~/.dsh/_backups/settings.yaml.bak-2026-09-15T13-14-12-294Z`（14,667 B，比 .imported 更大）与 `profiles/desktop/cordis.patch.yml.bak-20260902-203039`（apikey 备份，含 provider 段）。

### 4.7 ⚠️ 更正：`guard-destructive.ps1` 有一处漏判

预检 `Remove-Item -LiteralPath D:\DSH-Desktop -Recurse -Force` 返回 **PASS**（未拦截），与脚本注释声称的"工作区外一律拦截"不符。
原因：破坏性原语正则要求标志**紧跟命令名**（`remove-item\s+-recurse`），而 `-LiteralPath <路径>` 插在中间 → 匹配失败 → `prim = false` → 直接放行。
其自带 self-test 的 7 个用例都没覆盖 `-LiteralPath` 这种写法。
**因此本次删除的安全性不依赖该预检**，而依赖 §3.1 的六项引用检查（0 命中）。建议后续给该正则补 `-LiteralPath` 容忍（属另一轮）。

---

## 5. 实测：新版首启会发生什么

用**新版自带的判定函数** `@deepseek-ai/dsh-app-boot` → `evaluatePluginCompatibility(manifest, {}, "0.2.0-rc.1")`
扫描 profile 的 `node_modules` 与工作区插件（可重放，见 `eval-compat.mjs`）：

```
运行时版本: dsh 0.2.0-rc.1
检查到第三方包: 573
  其中声明了 @deepseek-ai/dsh* peer 且匹配 : 9
  其中不兼容                           : 8
```

判定规则（源码 `index.js:286-313`）：只查 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`；
`workspace:^|~|*` 视为当前运行时；`includePrerelease: true`。

**命中 8 个（全部在 51 个 bundle 清单内）**：

| 包 | 声明范围（节选） |
|---|---|
| `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2` | `dsh-client-runtime: ^0.0.1-rc.1` |
| `dsh-bash-terminal@0.3.15` | 11 项 `^0.1.5-rc.1` |
| `dsh-better-sidebar@0.22.1` | 14 项 `^0.1.7-rc.1` |
| `dsh-find-plugin@0.3.7` | `dsh-tools: ^0.1.0-rc.6` |
| `dsh-mcp-lens@0.1.0-rc.9` | `dsh-subprocess`/`dsh-tools: ^0.1.0-rc.6` |
| `dsh-office-tools@1.0.3` | 5 项 `^0.1.0-rc.6 \|\| …` |
| `dsh-tool-search@0.1.5` | 6 项 `^0.1.7-rc.2` |
| `dshmarket@1.40.0` | `dsh-settings: ^0.1.0-rc.7 \|\| …` |

**处理方式 = 跳过，不是阻断**（源码 `index.js:912-913`）：
> "Unreadable bundles, and bundles whose own dsh peers the profile does not exempt, are **skipped without changing the manifest** and listed in `skippedBundles`"

启动时对每个跳过的 bundle 打印一行 stderr（`reportSkippedBundles`，`index.js:515`）；匹配不到插件的 `cordis.patch.yml` 行也是"warn 并跳过"（`index.js:55`）。
→ **应用照常启动**，43 个 bundle 正常加载。

放行手段（谨慎）：`dsh plugin allow-version` 或插件管理器 → 写入 profile 内 `compatibility.json`
（`PROFILE_COMPATIBILITY_FILENAME`，逐 `包名@版本` × 逐运行时版本授权，需显式 `--accept-risk`）。

**通过的关键项**：你自己的 41 个 `@dsh-external/*`（写 `>=0.0.1-rc <2`）· `@openviking/dsh-memory-plugin` · `dsh-safe-delete` · `dsh-context` · `@liustack/modlens` · `@liustack/modsearch` · `@liustack/pptwise` · `@vectorize-io/hindsight-coding-agents`

另：新建 profile **不需要联网**——`initProfile()` 只写 `package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml` 三个文件（`dsh-app-boot/index.js:576-592`），bundle 从应用自带 `node_modules` 解析。

---

## 6. 隔离方案（**待你确认后才执行**）

目标：新版干净启动、旧版不可干扰、旧数据一个不丢。

| 步骤 | 动作 | 可逆性 |
|---|---|---|
| 1 | 关闭所有 DSH Desktop 进程（当前**无进程在跑**，已确认） | — |
| 2 | 旧快捷方式改名加后缀 `(旧 v2.0.2 勿用)`，避免误启动（§4.1） | 改名，可逆 |
| 3 | 运行 v2.0.16 安装包（装到 `%LOCALAPPDATA%\Programs\`，独立于旧构建） | 可卸载 |
| 4 | **首启前**把 `~/.dsh/profiles/desktop` 整体移出为 `~/.dsh/profiles/.desktop.v2.0.2-keep`（§6.1） | 移动，可逆 |
| 5 | 启动新版 → 验证：主界面能开 · 会话列表完整（292 条）· 模型 provider · 能聊天 | — |

### 6.1 为什么移动 profile 是安全的（源码级验证）

新版 `beginDesktopProfileStartup()`（`profile-manager-DZ2V7TPG.js:361-383`）：
- profile 的识别标志是**目录内存在 `package.json`**（`PROFILE_MANIFEST_FILENAME = "package.json"`）→ 移走后 "desktop" 不再被发现
- 条件 `(current.active === "desktop" || noProfilesExist) && !discovered.some(name === "desktop")` 成立
  → 调用 `materializeDefaultDesktopProfile(home)` → **新建一个干净的默认 desktop profile**
- 会话/存储**不受影响**：`~/.dsh/sessions`、`storages` 在数据根，与 profile 目录无关 → 292 条会话照常可见

> 选 `desktop` 而非 `web`/`recover-web`：新版把 `desktop` 视为 **launcher 拥有**的默认 profile，
> 缺失时会自动重建；而 `web`/`recover-web` 缺失则交给恢复窗口处理。

**替代方案（不移动 profile）**：直接沿用旧 profile 启动。结果可预测——8 个 bundle 被跳过，43 个加载，
其余功能正常，截图/日志会有 8 行 `skipping profile bundle …`。若新版起不来，它自带的**恢复窗口**
（`DesktopStartupRecoveryController`）支持逐个禁用 bundle + 回滚 last-known-good。

**两案取舍**：要"最稳"选移动；要"尽量保留插件现状"选沿用。**建议先移动**——先把新版跑通拿到基线，
再按 §7 逐个决定哪些插件值得放行。

---

## 7. 还原手册

### 只还原会话（最常用）
```powershell
$BK = 'D:\Deepseek-Harness\备份\2026-09-29-full'
robocopy "$BK\sessions" "$env:USERPROFILE\.dsh\sessions" /E /R:1 /W:1
```

### 还原实时配置（profile）
```powershell
Copy-Item "$BK\config\profiles__desktop__cordis.patch.yml" `
  "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
Copy-Item "$BK\config\profiles__desktop__package.json" `
  "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Force
```
（若已执行 §6 步骤 4：先把 `.desktop.v2.0.2-keep` 改回 `desktop`）

### 全量还原
见 `D:\Deepseek-Harness\备份\2026-09-29-full\README.md`（含 `tar -xzf` 解压 appdata / profile-desktop）。

### 旧构建回滚
快捷方式指回 `D:\Deepseek-Harness\vendor\deepseek-harness-desktop\dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe`
（该构建 `verify-patches` ALL PASS，可用），并把 §6 步骤 4 的 profile 目录改回 `desktop`。

---

## 8. 附：证据文件

| 文件 | 内容 |
|---|---|
| `data-inventory.json` | 机器可读清单：路径、文件数、体积、关键文件 SHA256、可删判据 |
| `plugin-compat.json` | 8 个不兼容包 + 9 个带 peer 的兼容包完整清单 |
| `eval-compat.mjs` | 实测脚本（用新版自带判定函数；已实测输出与记录一致，可重放） |

---

## 9. 执行顺序（**待你确认**）

### 9.1 安装 exe —— 需要你来点

安装包是 **NSIS GUI 安装程序**（内含 `$PLUGINSDIR\app-64.7z`），必须交互式运行；且按本项目的重启守则，我**不自动启动/重启桌面应用**。所以这一步交给你：

1. **先确认没有 DSH Desktop 在跑**（我刚查过当前**无进程**）
2. 双击 `C:\Users\机械革命\Downloads\DSH-Desktop-2.0.16-x64-Setup.exe`
   （269,333,800 B · SHA256 `0d330450cbaa9e1b5ac0420e35ff4db6afd82d73f4bcc3a9c3e421ef4fe6fa2c`）
3. 默认装到 `%LOCALAPPDATA%\Programs\` —— **与旧构建 `D:\Deepseek-Harness\vendor\...` 完全分离**
4. 装完安装包会建**自己的**快捷方式（与旧的两个同名，旧的需要先让位，见 9.2）

### 9.2 我可以在你确认后帮你做的（按顺序）

| # | 动作 | 风险 | 可逆 |
|---|---|---|---|
| A | 旧快捷方式加后缀 `(旧 v2.0.2 勿用)`（桌面 + 开始菜单各 1 个） | 无 | 改名可逆 |
| B | 删除 `D:\DSH-Desktop\`（3,218 MB / 124,654 文件）—— 已跑 `guard-destructive.ps1` 预检 + 上式六项引用检查 | 无 | 有冷备 |
| C | 首启前把 `~/.dsh/profiles/desktop` 移为 `.desktop.v2.0.2-keep`（§6.1） | 低 | 移动可逆 |
| D | 你启动新版，我核对结果（会话 292 条 / 模型 / 聊天） | — | — |

**A + B 可以先做**（与启动无关，纯清理 + 防误启动）。
**C 必须在首次启动新版之前决定**——启动一次后新版可能已改写 profile 选择状态。

### 9.3 需要你拍板的一件事

首次启动新版时，旧 profile（51 个 bundle，其中 8 个会被跳过）怎么处理：

- **方案一（建议）**：先移走旧 profile → 新版全新干净启动，**先确认新版本身能跑通**，插件日后再逐个评估放行
- **方案二**：沿用旧 profile 直接启动 → 预期 8 个 bundle 被跳过、43 个加载，功能基本可用；起不来时用新版自带的恢复窗口逐个禁用

---

---

## 10. 执行记录（2026-09-30）

### 10.1 已执行（用户确认后）

| # | 动作 | 结果 |
|---|---|---|
| 1 | 清空 `D:\DSH-Desktop` **全部内容**（保留目录本身，作为新版安装目标） | **125,200 文件 / 3,219.2 MB / 13 个顶层条目，76 s 完成**；目录现存 0 子项 |
| 2 | 旧快捷方式改名（防误启动旧版） | 桌面 + 开始菜单各 1 个 → `DSH Desktop (旧 v2.0.2 勿用).lnk` |
| 3 | 移出旧活动 profile | `~/.dsh/profiles/desktop` → **`~/.dsh/_backups/desktop-profile-v2.0.2-20260930`** |

删除清单：`deletion-manifest-DSH-Desktop.json`（每顶层条目含文件数/字节数/mtime 范围/`listingSha256`，≤1 MB 文件附内容 SHA256）。
生成脚本：`D:\Deepseek-Harness\_tmp\gen-delete-manifest.mjs`。
工具：`scripts\lib\remove-longpath.ps1`（项目自带的 robocopy 空目录镜像 + Remove-Item，长路径安全）。

**为什么移到 `_backups/` 而不是就地改名**：`listDesktopProfiles()` 只扫描 `<home>/profiles`，且 profile 的识别标志是「目录内存在 `package.json`」。
移到 `_backups/` 可让 profile 机制**完全看不到它**；就地改名成 `.desktop.v2.0.2-keep` 反而会被当成一个合法 profile 列出来。
**还原方式**：把它移回 `~/.dsh/profiles/desktop` 即可（内部 pnpm 结构含原绝对路径，必须回到原位置）。

### 10.2 安装器事实（来自壳的 electron-builder 配置，已核实）

```json
{ "appId": "ai.deepseek.dsh.desktop", "productName": "DSH Desktop",
  "nsis": { "oneClick": false, "perMachine": false, "allowElevation": true,
            "allowToChangeInstallationDirectory": true,
            "createDesktopShortcut": true, "createStartMenuShortcut": true,
            "shortcutName": "DSH Desktop" } }
```

- `oneClick: false` + `allowToChangeInstallationDirectory: true` → **向导有「选择安装位置」页**，可直接填 `D:\DSH-Desktop`。
- `perMachine: false` → 按用户安装，**不需要管理员权限**；不会出现"所有用户/仅我"那页。
- 安装器会新建自己的 `DSH Desktop` 快捷方式（旧的那个已改名，不冲突，留着当回滚指针）。
- 内置更新器拉起下载好的安装包时用 `spawn(installerPath, ["--updated","--force-run"])`，**不传 `/D=`** —— 即更新走的是注册表里记的上次安装位置。

### 10.3 首次启动会发生什么（预期）

- 新版启动 → `beginDesktopProfileStartup()` 发现 `profiles/desktop` 缺失且 `active === "desktop"` → `materializeDefaultDesktopProfile()` **新建干净 profile**。
- `initProfile()` 只写 3 个文件（`package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml`），**不需要联网**；bundle 从应用自带 `node_modules` 解析。
- **292 条会话应当照常出现**（在 `~/.dsh/sessions`，与 profile 目录无关）。
- **插件一个都不会加载**（避免 §5 的 8 个不兼容 bundle 问题）。
- **模型 provider 为空**：干净 profile 没有任何 provider，也没有 `qw` —— 需要新增一个，或用 DeepSeek 官方账号登录后才能聊天。
- 应用内可能先出现 setup 向导（模式 compatibility/extended/advanced、市场、通知等开关）。

### 10.4 待办

- **迁移轮（另开）**：从 `~/.dsh/_backups/desktop-profile-v2.0.2-20260930` 抄回 bundle 声明与调参；
  把 18 个 provider 从 `settings.yaml.imported` 落进新 profile 的 `llm-pi-ai.config.providers`。
- **CHANGELOG 乱码修复（另开一轮）**：2,346 处 U+FFFD 需凭上下文重写；写入必须用显式 UTF-8（勿用 `Add-Content`）。
- **`guard-destructive.ps1` 漏判修复（另开一轮）**：让 `-LiteralPath` 插在命令名与破坏性标志之间时仍能命中。
- 旧便携构建 `D:\Deepseek-Harness\vendor\...\dist\win-unpacked-build202609292211`：新版验收通过后再处置。

### 10.5 安装与首启实测结果（2026-09-30 01:43）

| 项 | 实测 |
|---|---|
| 安装位置 | `D:\DSH-Desktop\DSH Desktop\`（D 盘；**未**落到默认 `%LOCALAPPDATA%\Programs`） |
| 版本（磁盘实测） | 壳 **`dsh-plugin-desktop@2.0.16`** + 内核 **`@deepseek-ai/dsh@0.2.0-rc.1`**，运行时 node v24.18.1 |
| 新快捷方式 | `DSH Desktop` → `D:\DSH-Desktop\DSH Desktop\DSH Desktop.exe` |
| 旧快捷方式 | 保留为 `DSH Desktop (旧 v2.0.2 勿用)` → 旧构建，作回滚指针 |
| 新建 profile | `~/.dsh/profiles/desktop/` —— **只有 4 个文件**：`package.json` 211 B、`cordis.patch.yml` 217 B、`cordis.yml` 3 B、`pnpm-workspace.yaml` 61 B |
| 新 profile 的 bundles | `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`，**依赖 0 条** |
| 首启日志 | **0 个 bundle 被跳过**、无错误；唯一告警为 `workspace-registry ... session header is missing`（1 条会话被过滤出工作区成员，无害） |
| 会话 | **292 条完好** |
| 工作区注册 | **7 个完好**（`workspace.json` 仍可解析，schema 未被改写） |
| 存储文件 | 未被改写：`workspace.json` 9/29 15:12、`session_projcache.json` 9/29 02:25、`.credentials.yaml` 9/28 22:26 |
| 旧 profile 存档 | `~/.dsh/_backups/desktop-profile-v2.0.2-20260930` —— **41,610 文件 / 671.8 MB** |

**预测兑现情况**：§10.3 预言的 `materializeDefaultDesktopProfile()` → `initProfile()` 行为完全成立 ——
新建 profile 只落 4 个文件、依赖 0 条、离线完成，因此 §5 那 8 个不兼容 bundle **根本没有机会被加载**。

**额外发现**：新版 `dsh-community-market` 主动从 `settings.yaml.imported` 迁走 1 项市场设置到 durable storage
（`logs/host/dsh-2026-09-30.log:1`），但该文件本身未被改动（mtime 仍为 9/29 15:53）→ 18 个 provider 仍安全存于其中。

**当前缺口**：新 profile **没有任何 provider**，应用能开、会话可见，但**尚不能聊天**。
需新增一个 provider，或用 DeepSeek 官方账号登录（`.credentials.yaml` 的 24 个 key 都还在，未被清）。

---

调查与执行完成。本次**未改动任何用户数据内容** —— 唯一的用户数据位置变更是 10.1 的第 3 项（移动，可逆）。
