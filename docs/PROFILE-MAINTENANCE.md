# Profile 维护手册（DSH Desktop）

> 用途：**Profile（运行态插件装配）的权威维护文档**——任何 agent / 用户接手时先读本文，
> 即可独立完成完整巡检、安全删除插件、事故回滚。创建 2026-09-02，配套工具已全部实测。
> 关联：构建/补丁见 `docs/BUILD.md`；项目约定见根目录 `AGENTS.md`（「插件删除协议」条款）。

---

## 1. Profile 结构（先看这个，别凭感觉）

| Profile | 位置 | 状态 | 说明 |
|---|---|---|---|
| **desktop** | `~/.dsh/profiles/desktop/` | **唯一活跃运行 profile** | 桌面应用启动加载；模板在 `profile/desktop/`（`scripts/staged-profile-assemble.ps1` 装配）；`startup-verify` 默认 DSH_PROFILE=desktop |
| **web** | `~/.dsh/profiles/web/` | **遗留非活跃，不可删除** | 无启动路径引用；但它是 desktop 装配脚本的 `dsh-mcp-lens-0.1.0-rc.9.tgz` 来源，且 `cordis.patch.yml` 注释保留「super-injector 默认指向 web node_modules，desktop 必须覆盖」兜底 |
| **recover-web** | `~/.dsh/profiles/recover-web/` | 备用兜底（未激活，2026-09-03 新增） | 官方 web 模板纯净 Profile（仅 `dsh-base`+`dsh-web-app`，零自研插件/零补丁，无需 pnpm install）；desktop 启动失败时在恢复助手中选它兜底启动；幂等重建 `node scripts/ensure-recovery-profile.mjs recover-web --yes`；详见 `docs/RECOVERY-PROFILE.md` |

关键文件（每 profile）：
- `package.json` → `dependencies`（`link:`/`file:` 插件行）+ `dsh.profile.bundles`（加载清单；嵌套 `dsh:{profile:{bundles}}` 或历史点号键 `dsh.profile` 两种形态都兼容）。
- `node_modules/@dsh-external/<name>` → 插件实体（junction 指向 `D:\Deepseek-Harness\plugins\<name>`，或真实副本）。
- `cordis.patch.yml` → 装配补丁（含 super-injector 默认指向覆盖）。
- 核心 bundle（`@deepseek-ai/dsh-base` / `dsh-web-app`）由构建产物 `.../app.asar.unpacked/node_modules` 提供，**不**在 profile node_modules，**永不删除**。

---

## 2. 巡检工具链（每条都并入 check-all，但也可单独跑）

| 工具 | 命令 | 作用 |
|---|---|---|
| **startup-verify** | `node scripts/startup-verify.mjs` | 10 项启动预检：V1 bundle 可解析、V2 模板==运行时、V3 补丁、**V4 无孤儿 @dsh-external**、V5 dist junction、V6 核心文件、V8 补丁锚点、V9 插件语法、V10 bundle patch 声明。`--repair` 自动清悬空引用（先备份两份）；`--yes` 才删孤儿 junction |
| **scan-dangling** | `node scripts/scan-dangling.mjs` | 跨 profile 只读扫描：**DANGLING**（启动风险）/ STALE-DECL / ORPHAN / NOT-INSTALLED / INFO。`--strict` 有 DANGLING 才退出 1；`--plan` 输出修复预演（只读不执行）；`--json` 机器可读 |
| **check-all** | `powershell -File scripts\check-all.ps1` | 一键全检（Step 1.5 含 startup-verify / SLO 健康记录、**Step 1.6 scan-dangling --strict**、**Step 1.8 lint-skills 门禁**、Step 2 verify-patches 23 项…）。`-SkipSmoke -SkipTests` 跳过重步骤 |
| **dsh-maintenance** | `powershell -File scripts\dsh-maintenance.ps1` | 离线兜底：zombie 清理 / 大会话告警 / 陈旧锁 / 补丁健康 / **第 6 段 profile 悬空只读扫描** |

巡检判定：`scan-dangling --strict` 输出 `DANGLING=0 STALE-DECL=0 ORPHAN=0` 即为干净；
发现项按严重度处理——DANGLING 必须修（启动风险），STALE-DECL / ORPHAN 属卫生（低风险，清理前确认）。

---

## 3. 删除 / 归档插件协议（防「重启打不开」）

> 背景事故（2026-08-31）：归档 `dsh-tool-visibility` 只改了源码模板，漏了运行态 Profile 3 处引用
> → 悬空 junction → 重启报 `cannot resolve package "@dsh-external/dsh-tool-visibility"` 进恢复页。

### 3.1 必须同步的 4 处引用（2026-09-11 G1 修订：是 4 处不是 3 处）
1. 运行态 `~/.dsh/profiles/<p>/package.json` `dependencies` 的 `link:`/`file:` 行；
2. 同一文件 `dsh.profile.bundles` 数组项；
3. `node_modules/@dsh-external/<name>` junction（悬空或指向待删源）；
4. **模板 `profile/<p>/package.json` 的 deps + bundles**（漏掉会被 `startup-verify` **V2** 判 `template != runtime`）。

### 3.2 工具化流程（首选，2026-09-02 起）
```
# ① 预检（只读，列出 3 处引用，不写任何文件）
node scripts/deregister-plugin.mjs --plugin @dsh-external/<name>
# ② 确认后执行（自动备份 -> 改 package.json -> junction 走回收站 -> 自动 scan-dangling 验证）
node scripts/deregister-plugin.mjs --plugin @dsh-external/<name> --yes
# ③ 复核
node scripts/startup-verify.mjs && node scripts/scan-dangling.mjs --strict
```
护栏（工具内置）：默认只读预检；`--yes` 才动；每步先备份 `_backups/`；junction 回收站删除（仅删链接，target 保留）；**真实副本拒绝自动删**（需人工确认）；**核心 bundle 永不触碰**；原子写；清理后自动验证。运行中应用内首选 super-injector `dev_uninject_plugin`（卸 loader entry + 删 junction + 写 patch disabled，免重启无残留）。

### 3.3 手工兜底（工具不可用/非典型场景）
1. 备份：`Copy-Item ~/.dsh/profiles/<p>/package.json _backups/`；
2. 删 deps 行 + bundles 项（注意 JSON 逗号与两种 dsh.profile 形态）；
3. 删 junction：`Remove-Item <junction> -Force`（shell 已重定向回收站）；真实副本用回收站 API 确认后删；
4. 跑 `startup-verify`（V1/V2/V4）+ `scan-dangling --strict` 复核。

### 3.4 三段式退役（2026-09-16 实测定稿，缺一不可）

| 步 | 动作 | 漏做的后果（实测） |
|---|---|---|
| 1 | 热卸载：`dev_uninject_plugin(match=<name>)` —— 卸 loader entry + 写 profile patch `disabled` + 删 junction + 清 client 模块表（**免重启**） | **只做这一步** ⇒ `startup-verify` **V1/V10** 报 `package dir unresolvable`（profile deps/bundles 仍指着已删 junction） |
| 2 | 装配注销：`node scripts/deregister-plugin.mjs --plugin @dsh-external/<name> --yes` —— 清 §3.1 的 4 处（含模板） | **只做 1+2** ⇒ `startup-verify` **V3** 报 `stale disabled (no matching insert)` |
| 3 | **清 `disabled` 残留**：第 1 步会往 profile `cordis.patch.yml` 回写 `- id: <name> / disabled: true`；需原子写删除该行（含其注释行） | 留 V3 报红；且后续同名重装会与 `disabled` 冲突 |
| 4 | 复核：`startup-verify`（期望 **10/10**）+ `scan-dangling --strict`（期望 **0**）+ `/health`（期望 **200**） | 无这步则无法声称"干净退役" |

⚠️ **重启前 host 半区仍活（重要）**：热卸载**只清 loader 侧与 client 模块表**；2026-09-16 实测：卸载后
`GET /<routePrefix>/ping` 仍返回 **200 + 真实 JSON**（对照随机路径 404，排除 SPA 回退误判）。
⇒ **必须重启桌面应用**该插件的 host 半区才彻底消失（重启后 profile 已无引用，不会再加载）。
判"功能是否真没了"用**三重证据**：端点 404 ＋ 工具目录无该项 ＋ 新进程启动时间。

### 3.5 归档与台账同步（与 §3.4 同批必做）

- **归档路径（本仓惯例）**：`_backups/removed-<YYYY-MM-DD>-<plugin>/` —— 把 `plugins/<plugin>/` **与**
  `tests/plugins/<plugin>-*.test.mjs` **一起**搬入。**测试必须同走**：其 `import` 指向插件 `lib/`，不同走会让测试步骤失败。
- 档案内写 `README.md`：退役依据（实测证据，非感觉）/ 模块地图（哪些文件值得复用）/ 恢复步骤
  （搬回 + `node scripts/register-plugin.mjs --plugin <name> --yes` + 重启）/ **若复活该换哪个实现缝**。
- `plugins/INVENTORY.md`：删表行 **+ 重算所有计数**（标题目录数、表格行数、总计、core、bundle、必须重启）
  **+ 加一条计数纪律历史行** ⇒ 跑 `node scripts/audit-plugin-inventory.mjs`，期望 **11 PASS / 0 WARN**。
- `_backups/` 在 `.gitignore` 内 ⇒ **档案不进 git**（源码仍可从 git 历史找回）；因此档案必须自带说明，别指望 git 留痕。
- 记录三件套：`CHANGELOG.md` 新节 ＋ `.workbuddy/memory/<date>.md` ＋ task-scheduler `acquire → release`
  （**文件级**登记，否则 `check-unsupervised --strict` 报 `DRIFTED` 阻塞）。
- ⚠️ **提交前用全量 `git status --porcelain --untracked-files=all` 核对，禁止按文件名过滤**：
  模板 `profile/<p>/package.json` 的**路径里不含插件名**，按名字 grep 会漏掉它。
  2026-09-16 实测踩到：退役 `dsh-orchestrator` 的提交 `1f6adec` 漏了模板 2 行，
  由另一会话以 `6646f45 fix(profile): 补退 …（1f6adec 遗漏）` 补上。**校验方式**：
  `git show --stat HEAD` 的文件数应与"计划改动清单"逐项对齐（本次应为 23 文件，实际 22）。

---

## 4. 回滚

| 场景 | 回滚方式 |
|---|---|
| package.json 改错 | 从 `_backups/`（备份命名 `profile-<p>-package-*`）拷回 |
| junction 删错 | 回收站还原，或重建 link：`New-Item -ItemType Junction -Path <link> -Target <target>` |
| startup-verify --repair 误删 bundle | 备份两份在 `_backups/`，`startup-verify` 输出提示恢复路径 |
| dist 补丁（profile-guard 等） | `_backups/dist-profile-guard-*/` 原件拷回 + 重跑 `apply-*.mjs` |

---

## 5. 事故复盘速查（同类坑位）

- **删插件漏注销 → 重启打不开**：3 处引用同步清（见 §3）；首选工具 + startup-verify 复核。
- **--repair 误删核心 bundle**：`--repair` 会先备份；恢复后确认 `@deepseek-ai/dsh-base` / `dsh-web-app` 在 bundles 且构建产物存在（V1/V4 兜底）。
- **web profile 被当死代码**：**不可删**（装配依赖源），见 §1 表格。
- **package.json 编辑破坏 JSON / 逗号**：用 `deregister-plugin`（原子写）或备份 + `node -e "JSON.parse(...)"` 校验。
- **PowerShell 中文乱码 / 语法错**：脚本注释用纯 ASCII；路径警惕元字符。
- **热卸载 ≠ 注销**：`dev_uninject_plugin` 后 host 半区仍在当前进程（端点仍 200），且 profile 引用未清 ⇒ 见 §3.4 三段式 + 重启。
- **跨盘/大目录搬移**：`renameSync` 跨盘（C:→D:）报 **EXDEV**；`fs.cpSync` 曾触发 **0xC0000409 fail-fast**（无栈无输出）
  ⇒ 改用**逐文件 `readFileSync/writeFileSync` + SHA-256 内容校验**搬，再删源。
- **回收站判据（F13 扩展）**：`[Microsoft.VisualBasic.FileIO.FileSystem]` 类型在本 `shell` 后端**未加载**
  （需先 `Add-Type -AssemblyName Microsoft.VisualBasic`）；用 `try/catch{}` 静默吞异常会**假成功**。
  判成败一律看文件系统事实，最稳是**回收站项数前后对比**（本次实测：35→35 未增 ⇒ 那次是永久删除）。

---

## 6. 完整巡检 SOP（新 agent 照做）

1. `node scripts/scan-dangling.mjs --strict` → 期望 0 发现；有发现用 `--plan` 看预演。
2. `node scripts/startup-verify.mjs` → 期望 10/10（含 V4 无孤儿）。
3. `powershell -File scripts\verify-patches.ps1` → 期望 23 ALL PASS。
4. 一次性深检：`powershell -File scripts\check-all.ps1 -SkipSmoke -SkipTests`。
5. 改动 profile 前：先 `node scripts/task-scheduler.mjs status` 查锁，`acquire` 后动手、`release --summary` 登记。
6. 任何删/归档前：`deregister-plugin --plugin <name>` 预检 → 确认 → `--yes` → 复核。
7. 大会话卫生（`~/.dsh/sessions` 单目录 >8MB 且闲置>24h 会导致加载卡顿）：`powershell -File scripts\archive-big-sessions.ps1`（默认 dry-run）→ 确认后 `-Execute` 归档到 `_backups/archived-sessions-<date>/`（可逆移动，manifest.txt 记录原路径可还原）。2026-09-02 已归档 3 个（27.7MB，见 `archived-sessions-20260901-193016`）。
