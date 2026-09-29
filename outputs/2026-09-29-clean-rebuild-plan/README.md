# DSH Desktop 彻底重来方案（2026-09-29）

> 目标：把当前「dist 补丁硬撑」的状态，换成「官方最新内核 + 干净壳 + 你的插件」，且过程中任何一步都能回滚。

---

## 0. 先纠正一个前提：没有「更新的版本」可下载

| 层 | 版本 | 事实 |
|---|---|---|
| 桌面壳 `dsh-plugin-desktop` | **v2.0.2** | 本地 git tag 最新就是 v2.0.2；npm 上 `latest=2.0.0`（**更旧**） |
| 内核 `@deepseek-ai/dsh` | **0.1.7-rc.2** | 已是官方最新 |

⇒ **「下载最新版覆盖」没有对象**。任何重装都会落在同一组版本上。

### 但真正的好消息：你的壳源码已经含 0.1.7 适配

`vendor/deepseek-harness-desktop` 里有 **28 个源码文件改动 + 4 个新增**，例如：

| 文件 | 内容 |
|---|---|
| `src/desktop-shell-settings.ts` **(新增)** | 0.1.7 删掉文件型 settings 后，桌面设置的唯一持久化模块 |
| `src/profile.ts` (+209) | `dsh.bundle.patch` 支持 string \| string[]（0.1.7 变更） |
| `src/main.ts` | 401 鉴权修正、**`installWindowAllClosedGuard`（「创建提供商退出」的源码级守卫）** |
| `src/shutdown.ts` (+73)、`src/windows-pwsh-sandbox.ts` | 退出协调 / 沙箱适配 |
| `src/desktop-settings-*.ts` | 设置控制器适配 |

**这就是你最初要的「源码级适配」，只是从未提交。** 所以「彻底重来」的正确形态是：

> **用这份源码重新构建壳** → dist 里的补丁大部分变成源码能力 → 再配一个干净 profile。

---

## 1. 备份（Phase 0｜必须先做）

### 1.1 代码基线 ✅ 已完成
- 主仓 145 文件已 commit（工作区干净）
- 壳源码适配已存档：`patches/vendor-v2.0.2-source-adaptation.patch`（1.15 MB，**含新增文件**）

### 1.2 数据冷备（**必做，约 1.7 GB**）

| 数据 | 路径 | 体积 | 内容 |
|---|---|---|---|
| 会话 | `~/.dsh/sessions` | 412 MB | **289 条历史对话** |
| profile | `~/.dsh/profiles/desktop` | 672 MB | 插件与依赖 |
| 存储 | `~/.dsh/storages` | 121 MB | 会话索引/投影缓存 |
| 应用数据 | `%APPDATA%\DSH Desktop` | 505 MB | 设置快照/日志/生命周期 |
| 模型配置 | `~/.dsh/settings.yaml.imported` | 14 KB | **18 provider / 75 模型** |

```powershell
# 建议备份到另一个盘（E:\ 或移动硬盘），不要放 D:\ 同盘
$BK = 'E:\dsh-backup-20260929'
New-Item -ItemType Directory -Force $BK | Out-Null
robocopy "$env:USERPROFILE\.dsh\sessions"  "$BK\sessions"  /E /R:1 /W:1 /NFL /NDL
robocopy "$env:USERPROFILE\.dsh\storages"  "$BK\storages"  /E /R:1 /W:1 /NFL /NDL
robocopy "$env:USERPROFILE\.dsh\profiles\desktop" "$BK\profile-desktop" /E /R:1 /W:1 /NFL /NDL
robocopy "$env:APPDATA\DSH Desktop" "$BK\appdata" /E /R:1 /W:1 /NFL /NDL
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.imported" "$BK\" -Force
```

### 1.3 记录基线（5 分钟）

```powershell
cd D:\Deepseek-Harness
node scripts/patch-manifest.mjs --verify            # 补丁集身份
node scripts/resolve-dist.mjs > "$BK\dist-path.json" # 当前 dist 位置
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "$BK\"
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.yml" "$BK\"
node -e "const p=require('C:/Users/机械革命/.dsh/profiles/desktop/package.json');require('fs').writeFileSync(process.env.USERPROFILE+'/.dsh/plugin-list.json', JSON.stringify(p.dependencies,null,2))"
```

**回滚点 R0**：此时不做任何修改，随时可停。

---

## 2. 保住资产（Phase 1）

### 2.1 插件分档（决定重来后装什么）

| 档 | 插件 | 说明 |
|---|---|---|
| **核心必备** | `dsh-host-services`、`dsh-web-search-bing`、`dsh-web-fetch-local`、`dsh-session-history`、`dsh-session-hygiene`、`dsh-self-maintenance`、`dsh-context-lifecycle`、`modlens`、`dsh-tool-search`、`dsh-better-sidebar`、`dsh-bash-terminal`、`dsh-ui-performance`、`dsh-context`、`dsh-diagram-renderer`、`dsh-crashpad-hygiene`、`dsh-memory-files`、`dsh-diff-guard`、`dsh-developer-role-guard`、`dsh-prompt-enhance` | 你日常真正用的 |
| **按需** | `dsh-model-*`（whitelist/picker/tier-router/inspection-guard/provider-failover）、`dsh-vision-*`、`pptwise`、`dsh-office-tools`、`dsh-tool-renderers`、`dsh-session-watchdog`、`dsh-stuck-loop-guard`、`dsh-task-scheduler`、`dsh-super-injector`、`dsh-command-guard`、`dsh-code-security-guard`、`dsh-temp-tracker`、`dsh-tool-audit` | 想留就留，逐个验证 |
| **建议先不装** | `openviking-memory`（服务器未运行，每次启动刷 15s 警告）、`mcp-firecrawl`（`npx -y` 拉包卡 30–60s）、`mcp-markitdown`、`@vectorize-io/hindsight-coding-agents`、`dshmarket` | **启动慢/报错的主要来源** |

### 2.2 模型配置迁移方式
`settings.yaml.imported` 是 0.1.1 段名，0.1.7 已改名。迁移时按 0.1.7 段名重写（已有 `LEGACY_SECTION_ENTRIES` 映射）。

---

## 3. 用源码重建壳（Phase 2｜核心步骤）

> 这一步把「17 处 dist 补丁」变成「源码能力」。**需要应用完全关闭。**

```powershell
# 3.1 确认源码适配在位
cd D:\Deepseek-Harness\vendor\deepseek-harness-desktop
git status --porcelain          # 应看到 28 M + 4 ??

# 3.2 依赖（首次或升级后）
$env:COREPACK_HOME='D:\Deepseek-Harness\.corepack'
corepack yarn install --immutable

# 3.3 构建 + 打包（package-vendor.ps1 会自动：打包 → 重放补丁 → 验证 → promote）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\package-vendor.ps1
```

`package-vendor.ps1` 结束时会：
1. 打出新 `dist/win-unpacked-buildNNNN`
2. 重放全部 `scripts/apply-*.mjs`（含 `apply-shell-0.1.7-gaps.mjs`）
3. 跑 `verify-patches.ps1`（应 **ALL PASS**）
4. 应用关闭时自动 promote 到稳定入口

**回滚点 R1**：新 build 起不来时，旧 build 仍在 `dist/win-unpacked-build202609272329`，用 `promote-build.ps1 -From <旧目录>` 切回。

---

## 4. 干净 profile（Phase 3）

```powershell
# 4.1 新建独立 profile（不动现有 desktop）
# 应用内：设置 → Profile → 新建（或命令行）
node D:\Deepseek-Harness\scripts\select-desktop-profile.mjs --profile <新名> --apply
```

要点：
- **只登记第 2 节「核心必备」插件**，一次加 3–5 个，每次启动验证一遍
- 坏 MCP 一个都不加（`openviking-memory` / `mcp-firecrawl` / `mcp-markitdown`）
- 模型 provider 按第 2.2 节的 0.1.7 段名写入

**回滚点 R2**：`select-desktop-profile.mjs --profile desktop` 切回旧 profile。

---

## 5. 迁移数据（Phase 4）

| 数据 | 做法 | 风险 |
|---|---|---|
| **会话（289 条）** | 复制/软链 `~/.dsh/sessions` 到新 profile 共享同一目录 | 低（只读为主） |
| 模型配置 | 按 0.1.7 段名写入新 profile patch | 中（段名要对） |
| 插件配置 | 只搬「核心必备」那批的 `cordis.patch.yml` 行 | 低 |
| 应用数据（日志/快照） | **不迁移**（避免把旧状态带过来） | — |

> 会话按工作区分组（Deepseek-Harness 123 条、桌面项目 122 条…）。0.1.7 对旧格式更严，约 32 条解析失败会被跳过——**文件不丢**，只是列表里看不到。

---

## 6. 验证与验收（Phase 5）

```powershell
cd D:\Deepseek-Harness
node scripts/patch-manifest.mjs --verify
powershell -File scripts/verify-patches.ps1          # 期望 ALL PASS
node scripts/verify-profile-exports.mjs --profile <新名>
node tests/create-provider-regression.mjs
Invoke-WebRequest http://127.0.0.1:43120/health | Select-Object -Expand Content
```

人工验收清单：

| # | 动作 | 期望 |
|---|---|---|
| 1 | 双击启动 | ≤20s 出窗口 |
| 2 | 设置 → 模型 → **创建提供商** | **窗口不消失**，提供商写入 |
| 3 | 左侧切换工作区 | 历史会话列出 |
| 4 | 新建对话发消息 | 正常回复 |
| 5 | 打开设置页各项 | 不报错 |

---

## 7. 时间与风险

| 阶段 | 预估 | 风险 | 回滚 |
|---|---|---|---|
| 0 备份 | 20–40 min | 无 | — |
| 1 资产归档 | 10 min | 无 | — |
| 2 源码重建壳 | 30–90 min | 中（构建可能失败） | R1 promote 旧 build |
| 3 干净 profile | 20–40 min | 低 | R2 切回 desktop |
| 4 数据迁移 | 20 min | 中（模型段名） | 备份在 `$BK` |
| 5 验证 | 20 min | — | — |

**总计：约 2–3.5 小时**（构建耗时长）。

---

## 8. 诚实的取舍说明

1. **不推荐**真的「删干净重装」：壳没有更新版本，且会丢掉那 28 个文件的源码适配。
2. **推荐**本方案的「源码重建 + 干净 profile」：既保住适配成果，又甩掉历史包袱。
3. **若只想先能用**：跳过 Phase 2/3，只做 Phase 4 的「坏 MCP 全禁 + 缩插件」，1 小时内可见效。

---

## 9. 需要你决定的三件事

1. **备份盘位置**（现在默认 `E:\dsh-backup-20260929`，D 盘同盘备份意义不大）
2. **新 profile 名字**（建议 `clean` 或 `work`）
3. **是否执行 Phase 2 重建**（耗时长，但收益最大）

确认后我按 Phase 顺序执行，每完成一phase 停下来等你验证再继续。
