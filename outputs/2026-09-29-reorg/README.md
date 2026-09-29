# D:\Deepseek-Harness 分类整理方案（2026-09-29）

> 调查结论 + 可执行整理计划。回答你的三个问题：插件能否归位、旧文件能否集中、构建新 DSH 再迁移是否可行。

---

## 一、你的三个问题，先给结论

| 问题 | 结论 |
|---|---|
| 能不能把插件都放到一起？ | **能**。有 **3 个插件散落在根目录**，应移入 `plugins/`。需同步改 **7 处引用**，风险中。 |
| 能不能先把旧文件放到一个文件夹？ | **能**。`legacy/` + 若干运行时残留可归档，**低风险**。 |
| 构建新 DSH 后再迁移数据，可行吗？ | **可行**，但要先纠正一个前提（见第三节）。 |

---

## 二、根目录分类调查结果

### 2.1 类别总览（38 个根级条目）

| 类别 | 条目 | 处理 |
|---|---|---|
| **基础设施**（保留） | `vendor/` `scripts/` `patches/` `docs/` `tests/` `outputs/` `assets/` `profile/` `.git/` `.github/` `.githooks/` 根级 md/json | 原位 |
| **插件（应统一）** | `plugins/`(41) + **`dsh-context-lifecycle/`** + **`dsh-stuck-loop-guard/`** + **`dsh-vision-rotator/`** | ⚠️ 后 3 个应移入 `plugins/` |
| **存档/备份**（已忽略） | `_backups/` `备份/` `_tmp/`(空) | 原位 |
| **缓存**（已忽略） | `.corepack/` `.electron-cache/` `.electron-builder-cache/` | 原位 |
| **本地运行时**（已忽略） | `hy3-gateway/`(30.8MB) `tools/`(309MB) `agent-presets/` `.workbuddy/` `diagrams/` `node_modules/`(空壳) | 按需 |
| **历史遗留** | `legacy/`(0.1MB, 20 文件) | ⚠️ 归档 |

### 2.2 三个散落插件详情

| 目录 | 包名 | 体积 | 内容 |
|---|---|---|---|
| `dsh-context-lifecycle/` | `@dsh-external/dsh-context-lifecycle@0.1.0` | 25.2 MB | lib/ src/ scripts/ node_modules/ |
| `dsh-stuck-loop-guard/` | `@dsh-external/dsh-stuck-loop-guard@0.1.0` | 25.2 MB | lib/ src/ scripts/ data/ node_modules/ |
| `dsh-vision-rotator/` | `@dsh-external/dsh-vision-rotator@0.1.0` | 0.1 MB | lib/ src/ scripts/ |

> 三者包名与 `plugins/` 内插件**完全同构**（都是 `@dsh-external/*` + lib/src）。
> 它们在 `plugins/verify-plugin-imports.mjs` 里被注释为 "root-level daemon plugins (same shape as plugins/)" ——
> **即历史遗留的散落，理应归入 `plugins/`。**

### 2.3 移动需同步修改的 7 处引用

| # | 文件 | 行 | 现状 |
|---|---|---|---|
| 1 | `scripts/verify-plugin-imports.mjs` | 105–107 | 硬编码根级三个目录名 |
| 2 | `scripts/check-all.ps1` | 35–36 | 遍历根级三个目录 |
| 3 | `scripts/syncheck-plugins.mjs` | 13 | 遍历根级三个目录 |
| 4 | `scripts/verify-api-catalog.mjs` | 200 | walk 根级三个目录 |
| 5 | `scripts/fix-security.mjs` | 15 | 硬编码 `dsh-context-lifecycle/lib/index.js` |
| 6 | `~/.dsh/profiles/desktop/package.json` | — | 3 条 `link:D:\Deepseek-Harness\<dir>` |
| 7 | `AGENTS.md` | 55–57 | 文档列出根级插件目录 |

**外加**：移动后需重跑 `scripts/repoint-profile-node-modules.mjs --apply` 重建 junction 农场。

### 2.4 澄清：`hy3-gateway/` 与 `plugins/dsh-hy3-gateway/` **不是重复**

| | 根 `hy3-gateway/` | `plugins/dsh-hy3-gateway/` |
|---|---|---|
| 性质 | **独立 Node 服务**（server.js + node_modules + apikey.local.txt） | **DSH 插件封装**（lib/ + cordis.patch.yml） |
| 作用 | 网关本体（跑在 :端口） | 把网关接进 DSH |
| gitignore | 已忽略 | 入库 |

⇒ 两者是**配套关系**，不能合并。根 `hy3-gateway/` 含密钥，保持忽略。

### 2.5 `profile/` 是模板，不是垃圾

`profile/desktop/` = profile 模板（`cordis.patch.yml` + `dsh-mcp-lens-*.tgz` + `package.json` + `pnpm-workspace.yaml`），
新建 profile 时从这里取源。**保留原位。**

---

## 三、纠正一个前提：没有「更新的版本」可构建

| 层 | 版本 | 事实 |
|---|---|---|
| 桌面壳 | **v2.0.2** | 本地 tag 最新；npm 上 `latest=2.0.0`（更旧） |
| 内核 | **0.1.7-rc.2** | 官方最新 |

所以「构建新的 DSH 项目」有**两种正确解释**：

| 方案 | 含义 | 保留 | 代价 |
|---|---|---|---|
| **A. 原地重建（推荐）** | 用当前 `vendor/` 源码（含 **28 文件适配**）重新 build，让适配真正编译进 dist | 51 插件 / 模型 / 会话全部保留 | 30–90 min 构建 |
| B. 全新 checkout | 新目录 clone → 全新配置 | 干净 | 要重配一切，且**丢掉那 28 文件适配** |

⇒ **推荐 A**。它的收益正是你最初的目标：把「17 处 dist 补丁」升级为「源码能力」。

---

## 四、整理方案（四阶段，可分段执行）

### 阶段 1：旧文件集中归档（**低风险，建议先做**）

```powershell
# 移到 备份\2026-09-29-reorg\
- legacy/                     (0.1 MB, 旧脚本/测试)
- 可选：tools/markitdown/      (308 MB, 若禁用 markitdown MCP)
- 可选：hy3-gateway/           (30.8 MB, 若不用该网关；含密钥，只移动不删)
```

**收益**：根目录条目减少；**风险**：低（`legacy/` 无引用；后两项需你确认）。

### 阶段 2：插件归位（**中风险，需完整验证**）

```
plugins/
  ├─ (现有 41 个)
  ├─ dsh-context-lifecycle/     ← 从根移入
  ├─ dsh-stuck-loop-guard/      ← 从根移入
  └─ dsh-vision-rotator/        ← 从根移入
```

执行顺序（**必须按序**，否则门禁会红）：

1. 改 5 个脚本的硬编码路径（2.3 的 #1–#5）
2. `Move-Item` 三个目录到 `plugins/`
3. 改 profile 的 3 条 `link:` 路径（#6）
4. 重跑 `repoint-profile-node-modules.mjs --apply`
5. 改 `AGENTS.md`（#7）
6. 验证：`verify-patches.ps1` ALL PASS + `check-all.ps1` + `verify-plugin-imports.mjs`

**回滚**：备份在 `备份/2026-09-29-full/profile-desktop/` + git（脚本改动可 revert）。

### 阶段 3：源码重建壳（**核心收益**）

```powershell
# 应用须完全关闭
cd D:\Deepseek-Harness\vendor\deepseek-harness-desktop
corepack yarn install --immutable
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Deepseek-Harness\scripts\package-vendor.ps1
```
`package-vendor.ps1` 会自动：打包 → 重放补丁 → verify-patches → 应用关闭时 promote。

**回滚点**：旧 build 仍在 `dist/win-unpacked-build202609272329`，`promote-build.ps1 -From <旧>` 切回。

### 阶段 4：新建干净 profile + 数据迁移

```
新 profile（建议名 clean）
  ├─ 只装「核心必备」插件（一次 3–5 个，逐个验证）
  ├─ 坏 MCP 一律不装（openviking / npx firecrawl / markitdown）
  └─ 数据迁移：
       sessions/    ← 复制 备份\2026-09-29-full\sessions（289 条）
       models       ← 按 0.1.7 段名写入（源：settings.yaml.imported，18 provider/75 模型）
       插件配置      ← 只搬核心插件那批 cordis.patch.yml 行
```

**回滚点**：`select-desktop-profile.mjs --profile desktop` 切回旧 profile。

---

## 五、完整时间线

| 阶段 | 内容 | 工时 | 风险 | 回滚 |
|---|---|---|---|---|
| 0 | 冷备（**已完成** 1.87 GB） | — | — | — |
| 1 | 旧文件归档 | 10 min | 低 | 移回即可 |
| 2 | 插件归位（3 个 + 7 处引用） | 30 min | 中 | git revert + 备份 |
| 3 | 源码重建壳 | 30–90 min | 中 | promote 旧 build |
| 4 | 新 profile + 数据迁移 | 40 min | 中 | 切回 desktop profile |
| **合计** | | **2–3 h** | | |

---

## 六、我的建议顺序

1. **先做阶段 1**（10 分钟，纯归档，零风险）——立刻让根目录清爽
2. **再做阶段 3**（重建壳）——**收益最大**，且不依赖阶段 2
3. **阶段 2（插件归位）放最后**——它风险最高（7 处引用 + junction 重建），而收益只是「结构统一」；等重建稳定后再做，出问题也好定位
4. **阶段 4** 在 3 之后

> 换句话说：**插件归位是「整洁」，源码重建是「治病」，先治病再整理。**

---

## 七、记录规范（本方案执行时遵循）

| 记录 | 位置 |
|---|---|
| 变更日志 | `CHANGELOG.md` |
| 产出归档 | `outputs/2026-09-29-reorg/README.md` + `outputs/INDEX.md` |
| 操作留痕 | `备份/2026-09-29-reorg/manifest.json`（逐文件 + SHA256） |
| 目录规范 | `docs/DIRECTORY-CONVENTIONS.md`（已建立，执行后同步更新） |
