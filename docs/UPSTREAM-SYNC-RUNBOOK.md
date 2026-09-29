# 上游同步 Runbook（官方发新版时照这个做）

> 建立：2026-09-28 ｜ 触发场景：官方发布新内核 / 桌面壳版本，需要同步
> 目标：把「升级后才发现打不开」变成「**升级前一条命令列出要改哪几行**」
> 全部工具**只读**，除 `_backups/kernel-surface/<label>.json` 快照外不写任何东西；不重启、不动配置。

## 0. 一句话流程

```
官方发版  →  update-watch 告警  →  upstream-sync 一条命令  →  按 action 清单修  →  执行升级  →  重启  →  冒烟
```

## 1. 感知：官方发版了吗

| 手段 | 命令 / 位置 |
|---|---|
| 手动雷达 | `node scripts/update-watch.mjs`（写 `_backups/update-watch-latest.json`） |
| 常驻巡检 | `dsh-self-maintenance` 每小时雷达巡检（节流 6h），翻转/超龄即桌面通知 |
| 直接看 | `npm view @deepseek-ai/dsh dist-tags` |

**判据**：`latest` 翻转 = 官方把 prerelease 转正（历史实测：`0.1.1-rc.2 → 0.1.2-rc.1` 就是雷达首跑命中）→ 进入第 2 步。

## 2. 评估：一条命令列出所有阻塞

```powershell
node scripts/upstream-sync.mjs
# 退出码 0=READY 可以走升级流程；1=BLOCKED，按 action 清单修；2=用法错误
node scripts/upstream-sync.mjs --json          # 机器可读
node scripts/upstream-sync.mjs --baseline 0.1.1-rc.2   # 指定对比基线快照
```

它串联四道互不重叠的检查：

| 阶段 | 脚本 | 回答什么问题 | 它会抓到什么 |
|---|---|---|---|
| `surfaceDiff` | `kernel-surface.mjs --diff` | 内核 API 面**变了什么** | 包增删、**具名导出增删（-160 个）**、bundle 装配条目增删、**服务不再提供（含 `settings` 本身）** |
| `configShapeDiff` | `verify-config-shapes.mjs --diff` | **Config 字段的性质变了吗** | **`plain -> Volatile<T>` 翻转**（0.1.1→0.1.7 实测 **25 处**，含 `dsh-pwsh-local::pwshPath` —— 今天 `config.pwshPath.get is not a function` 的元凶）、字段消失、类型变化 |
| `profileExports` | `verify-profile-exports.mjs` | **我的哪个插件**会链不上 | profile 59 个包里逐个 `MISSING_EXPORT` + `文件:行号` |
| `startupVerify` | `startup-verify.mjs` | profile **装配本身**健康吗 | V3 陈旧 `disabled:` id（= patch 与内核混版）、V8 补丁锚点丢失、bundle 不可解析、bundle 语法错 |
| `notes` | `update-watch.mjs` | 有没有更新版本 | dist-tags 快照（best-effort，永不阻塞） |

> **两类阶段的区别（判读要点）**：
> - `surfaceDiff` 与 `configShapeDiff` 是**增量备忘**（delta）——它们比较「基线内核 → 候选内核」，只要两者的差异在，就会一直报 FAIL。**这是给本次升级用的工作清单，不是"你刚弄坏了什么"**；换基线（例如下次 0.1.7→0.2.0）后它们只报那一段的新变化。
> - `profileExports` 与 `startupVerify` 是**真门禁**——它们看的是**当前状态**，必须绿才算能启动。

## 3. 三类阻塞的通用修法

### A. `kernel-surface --diff` 报移除
逐条对照 `[BREAKING]` 段：
- **移除的包** → 谁在 import 它？全仓 grep 包名，改用替代包或删除该用途。
- **移除的具名导出** → `profileExports` 阶段会直接点名受影响插件；对自研插件改 import；对第三方插件升版或禁用。
- **移除的服务** → 全仓 grep 服务名（`ctx.get('x')` / `inject:['x']`），改接新服务或补垫片（先例：`plugins/dsh-settings-scope-shim`）。
- **移除的 bundle 条目** → 检查 `~/.dsh/profiles/<active>/cordis.patch.yml` 是否有针对该 id 的 `disabled`/`config` 行；**陈旧 disabled 就是 V3 红**。

### B. `verify-profile-exports` 报 MISSING_EXPORT
按优先级：
1. **升版**（首选）：查该包最新版 `peerDependencies` 是否已指向目标内核
   `npm view <pkg> version peerDependencies` —— 指向就升，不指向就别赌。
2. **禁用**：临时 `- id: <entry> disabled: true`（记得 V3 要求 disabled 的 id 必须能在 insert 里找到）。
3. **自研插件改代码**：改 import → `node --check` → 重跑本门禁直到绿。

### C. `startup-verify` 报红
- **V3 陈旧 disabled**：profile patch 是为另一个内核版本写的 → 要么删该行，要么补对应 insert。
- **V8 补丁锚点 MISSING**：dist 侧整文件补丁丢了 → 跑 `node scripts/port-user-patches.mjs`（或对应 `apply-*.mjs`）重打，然后重跑。
- **V1/V4/V10**：bundle 不可解析 / 孤儿包 / 缺少 `dsh.bundle.patch` 声明 → 按 `deregister-plugin.mjs` 的删除协议清理运行态引用。

## 4. 执行升级（沿用 master plan U 轨）

`outputs/2026-09-27-master-plan-upgrade-and-learning/PLAN.md` 的 U0–U7 即完整 runbook。要点：
1. **锁 + 全量备份**：`global:install` / `global:build` 锁；sessions（397 MB）/ storages / 两个 `package.json` / vendor git。
2. **改依赖 pin** → `yarn install` → `yarn build` → 打包出**新 build 目录**（旧 build 原地保留 = 天然回滚）。
3. **补丁处置**：A 组退役 / B 组按官方片段重做 / C 组保留重打 → `verify-patches.ps1` 全绿。
4. **门禁换代**：`patch-shape-gate` 的 `expectVersion` 改成新版本；`kernel-surface --snapshot` 存新快照。
5. **重跑第 2 步**：`upstream-sync` 必须 **READY** 才 promote。
6. **切内核（顺序不可颠倒，且必须在应用关闭时做）**：
   a. `node scripts/repoint-profile-node-modules.mjs --apply` —— 把 `~/.dsh/profiles/node_modules`
      的 junction 农场重指向 **入口 junction** `dist\win-unpacked`。
      **为什么必须**：本机实测农场有 **199 条指向绝对路径的旧 build 目录**
      （`win-unpacked-build202608272104` = 0.1.1），而 profile 插件正是经它解析 `@deepseek-ai/*`
      （实测解析到 v0.1.1-rc.2）。`promote-build.ps1` 只切 `dist\win-unpacked`，**动不了农场**
      ⇒ 不先重指向，新内核 + 新依赖线的插件会互相链不上。默认 dry-run，`--apply` 才写，
      并留 `_backups/profile-node-modules-repoint-<ts>/catalog-before.json` 可逐条回滚。
   b. `promote-build.ps1 -From <build>` —— 切入口 junction；跑静态冒烟，失败自动回滚。
   c. **用户重启** → 冒烟。

## 5. 回滚纪律（血泪教训）

- **回滚勿用 `promote-build.ps1`**：它的 `smoke-test.ps1` 已经「新版本化」，对旧 build 会判 FAIL 并**把你自动回滚到坏 build**。回滚请用原生 junction 重建。
- 会话格式迁移**源文件逐字节不变**（`dsh-session-persistence-jsonl/README.zh.md:82`），但**无 downgrade 支持**（`:160`）⇒ 新内核写过的新会话在旧内核里读不到；回滚前先整目录备份 sessions。
- `settings.yaml`：0.1.7 会导入一次并**改名为 `settings.yaml.imported`**，升级前必须把该文件另存副本，否则恢复源会被顶掉。

## 6. 覆盖不到的三类（已知边界，下一批）

| 未覆盖 | 现状 | 补齐方向 |
|---|---|---|
| **Config schema 形状漂移** | 今日实例：`config.pwshPath.get is not a function`（0.1.7 的 `Volatile<T>` 包装）；`tsc` 0 错但运行时炸 | 快照每个 entry 的 Config schema 形状（类型/是否 Volatile），与插件构造处比对 |
| **钩子 payload / decision 形状漂移** | 实例：`agent/pre-step` 的 `additionalContexts` 放进 payload 永不生效（必须改 `decision.messages`）；`PreToolDecision` 新增 `cancel`/`ask` | 快照 `dsh-tool-cordis` 的 api-catalog（decision kinds / 钩子签名）并 diff |
| **客户端服务「提供↔消费」错配** | 实例：0.1.7 删了 `settingsScope` 提供者，`settings-models`/`conversation` 仍 inject；`providedServices()` 目前只读宿主 entry，**不读 `lib/client.js`** | 扩展 `providedServices` 覆盖客户端半，并产出「被消费但无人提供」清单 |

> 这三类正是「运行期才炸、静态门禁看不见」的残留面。在补齐之前，**第 4 步的冒烟不能省**。

## 7. 工具索引

| 脚本 | 作用 | 退出码 |
|---|---|---|
| `scripts/upstream-sync.mjs` | 一条命令总检（本 runbook 第 2 步） | 0 READY / 1 BLOCKED |
| `scripts/kernel-surface.mjs` | `--snapshot` / `--diff` / `--list` 内核 API 面快照与漂移 | 1 = 有破坏性变更 |
| `scripts/verify-config-shapes.mjs` | 内核 `Config` schema 形状快照与漂移（**volatile 翻转**是崩溃级） | 1 = 有 plain→volatile 翻转或字段消失 |
| `scripts/verify-client-services.mjs` | 客户端服务「被消费但无人提供」缺口（与基线内核比对，只报新增） | 1 = 有新增提供缺口 |
| `scripts/verify-profile-exports.mjs` | profile 插件具名导出门禁（区分会加载/仅声明） | 1 = 有加载中包的 MISSING_EXPORT |
| `scripts/verify-inventory.mjs` | 台账 ≡ 磁盘 ≡ 运行态一致性 + **退役队列**（决定=退役但仍装配） | 1 = 台账漂移 |
| `scripts/repoint-profile-node-modules.mjs` | 把 profile 的 junction 农场重指向**入口 junction**（跟随 promote） | 1 = 有条目重指向失败 |
| `scripts/patch-manifest.mjs` | 补丁集身份 + `patchDigest`（改过 applier/bundle 后须 `--write` 重登记） | 1 = 静默漂移 |
| `scripts/verify-dist-exports.mjs` | dist 打包态链接期导出门禁（B3，只盖 dist 自身） | 1 = 链接失败 |
| `scripts/startup-verify.mjs` | 启动预检 V1–V10（只读） | 1 = 有 FAIL |
| `scripts/update-watch.mjs` | 官方版本雷达 | 恒 0 |
| `scripts/patch-shape-gate.mjs` | 补丁的上游形状锚点（fail-closed） | 1 = 形状漂移 |
