# 保留性评估：版本路线选择与资产保全（2026-09-29）

> 触发问题：用户要求「DSH 用官方最新桌面版本，然后适配我开发的功能与插件」，并在修不好时考虑「重新下载再适配」；硬约束＝**已开发的功能、插件、API、记录文档一律不能丢**。
> 本文是「仔细分析和调查哪一种方案最好」的结论：先给答案，再给实测依据与可核验的迁移流程。
> 配套机器可读基线：`outputs/2026-09-29-preserve-assessment/asset-manifest.json`（由 `scripts/snapshot-assets.mjs` 生成）。

---

## 1. 结论速览

| 判断 | 结论 |
|---|---|
| 「重新下载官方最新」能否解决问题 | **不能**。registry `dist-tags.latest = 0.1.7-rc.2`，**我们跑的内核就是 0.1.7-rc.2** —— 重装等于同一版本重装，现存问题会**原样跟过去**（它们全在我们自己的 profile / 插件 / 脚本层） |
| 「修不好」是否成立 | **不成立**。今天已定位并修复「点创建提供商→应用静默退出」的真正死因，并拿到端到端证据（见 §5） |
| 推荐路线 | **A：留在官方 latest（0.1.7-rc.2）先收口**；随后做 **B：把 dist 补丁逐类迁成客户端插件**（这是让"以后每次官方升级都便宜"的唯一办法）；**C（升 0.2.0-rc.x）只在需要新功能时才做** |
| 保留性 | A = 100% 不动资产；B = 插件/文档/API 全保、补丁条目减少；C = 需逐条重锚（文档与插件可全保，运行数据不动） |
| 唯一真正更新的东西 | 预发布线 `0.2.0-rc.1 / 0.2.0-rc.2`（registry 共 29 个版本）；本机 QuWork 运行时是 `0.1.7-rc.1`，**比本仓还旧一档** |

---

## 2. 现状基线（2026-09-29 实测）

| 层 | 值 |
|---|---|
| 桌面壳 | `dsh-plugin-desktop@2.0.2`（vendor，Electron 43.4.0） |
| DSH 内核 | runtime `0.1.7-rc.2` / dist 内 `0.1.7-rc.2` —— **= registry latest** |
| 构建产物 | `dist/win-unpacked-build202609272329`（另有 2 个历史构建目录） |
| 插件 | **41 个** / 11.2 MB（其中带客户端 13 个、自带 `cordis.patch.yml` 36 个） |
| profile | runtime 9 行 / template 8 行；bundles 51 = 51（V2 PASS）。差的 1 行是 `session-projection-cache` 的**本地配置覆盖**，非漂移 |
| 补丁集 | **46 条**（applier 32 / bundle 11 / reference 3），`patchDigest 320e27db…` |
| 补丁债（已自然退役） | registry 显式退役 1 条 + `verify-patches` 退役探针 5 条 = **6 条**已因上游实现或改版而失效 |
| 补丁目标分布 | 32 个 applier 中 **13 个打上游内核**（升级时最贵）、5 个打壳自身 `lib/`（自有可控）、其余为 bundle/profile 类 |
| 文档记录 | `CHANGELOG.md` 848 KB / **287 节**；`docs/` 57 篇；`outputs/` 67 目录 / INDEX 74 条登记 |
| 技能与预设 | 家目录 skills 62；仓库 skills-hub 94；agent-presets 3 |
| 运行数据 | `sessions` 412 MB / 292 文件；`.task-scheduler` 6.3 MB / 147；`.health` 3 |
| 预检（正确 profile） | **9/10 PASS**（唯一 FAIL：V4 孤儿 `@dsh-external` 包，待确认后清理） |
| 门禁 | `verify-patches` ALL PASS（98 检查）、smoke ALL PASS、窗口守卫单测 4/4 |

---

## 3. 必须保住的资产清单（保全集）

| 资产 | 载体 | 由谁保住 | 迁移时如何验证「没丢」 |
|---|---|---|---|
| 自研插件（41 个，含客户端 13 个） | `plugins/*`（仓库内，git 跟踪） | 与官方版本无关，**原地不动** | 快照 `--diff`：插件丢失=0、内容变化仅预期项 |
| profile 组合（bundles 51、行） | `profile/desktop/*` + `~/.dsh/profiles/desktop/*` | 迁移后重新登记即可 | V2（template == runtime bundles）+ 行 id 集合对比 |
| 补丁能力（46 条） | `patches/**` + `scripts/apply-*.mjs` + `verify-patches.ps1` | 每条要么重锚、要么迁移成插件、要么**显式退役**（都留档，不静默删） | `node scripts/patch-manifest.mjs --verify` + `verify-patches.ps1` 全绿 |
| API / 服务面（host 路由、client 插槽） | 插件 + shell `src/` + `cordis.patch.yml` | 由 shell 与插件共同提供 | `server-only` 健康探测 10/10 + 各插件自检路由 |
| 记录文档（CHANGELOG 287 节、docs 57、outputs 67） | 仓库文本 | 只增不删 | 快照对比节数/篇数/登记数只增不减 |
| 技能与预设（62 / 94 / 3） | `~/.dsh/skills`、`tools/dsh-skills-hub`、`agent-presets` | 独立于版本 | 快照计数对比 |
| 运行数据（会话 412 MB 等） | `~/.dsh/**` | **迁移不得触碰**（`DSH_HOME` 不进备份/不回滚） | 文件数只增不减（快照自动检查） |

**关键点**：上面 7 层里只有第 3 层（补丁）与官方版本强耦合；其余 6 层与版本无关。所以"换官方版本"最多只影响 46 条补丁，**不可能碰到你的功能、插件、API、文档与会话数据**。

---

## 4. 四方案对比

| 方案 | 做什么 | 保留性 | 成本 | 风险 | 何时选 |
|---|---|---|---|---|---|
| **A 留在 latest 收口**（推荐，现在） | 清残留（V3/V4）、让门禁全绿、确认点击闭环 | 100% | 小（今天内） | 极低 | **默认**。官方 latest 就是当前版本，没有"更官方"的东西可换 |
| **B 补丁→插件迁移**（下一阶段） | 46 条三分类：官方已提供→删；可用客户端插件替代→迁入 `plugins/`（vendor AGENTS.md 明确要求扩展走 client plugin + profile composition）；必须打→保留并重新锚定 | 高（插件与文档全保） | 中（大头是 11 个客户端 bundle 补丁） | 中低（每步可回滚） | B 完成后，C 的成本会降一个量级 |
| **C 升 0.2.0-rc.x** | 换内核到预发布线并重锚全部补丁 | 中（文档/插件可全保，运行数据不动） | 大（参考 0.1.1→0.1.7 的适配量） | 中高（预发布线本身不稳） | **仅当需要 0.2.0 的新功能**时 |
| **D 换官方安装包** | 以外部安装包为基线重建 | 中低（取决于包来源） | 中 | 中 | 本机与 registry 均**未发现**独立官方桌面安装包；若你拿到，按 §6 runbook 走 |

---

## 5. A 方案的第一半已经完成：静默退出根因已修复并**端到端验证**

**根因**：点击「创建提供商」→ 设置写入触发 profile 热重载 → `reconcileProfilePatches()` 对**单一 root Include 条目** `entry.update({config:{… patches}})` → 所有 profile 行（含持有窗口的 `desktop-shell` 行）被 dispose+重建 → 行的 disposer 执行 `tray?.destroy()` + `window.destroy()` → 窗口数归零且**壳从未注册 `window-all-closed`** → Electron 隐式 `app.quit()` → 壳自己的 `before-quit` 守卫 `preventDefault()` + `requestQuit(0)` → 协调关闭 `app.exit(0)`：**无异常、无 dump、无日志、退出码 0**。

**修复**：模块级（不在可重载 fiber 内）注册 `window-all-closed` 守卫 —— 有主动退出请求时直接放行（不会导致关不掉）；否则抑制隐式退出并留 15 秒宽限，若窗口仍未回来则 `requestRelaunch()` 兜底重启。

**端到端证据**（2026-09-29 19:44–19:45，探针 + 应用日志对齐）：

| 时刻 | 事件 |
|---|---|
| 19:44:47.025 | profile 热重载（`[root] patch: entry "selftest-r2probe" not found`）—— 即点击引发 |
| 19:44:47.166 | `generation.release(): destroying window+tray` → `window closed id=1 → remaining windows=0` |
| 19:44:47 | 守卫抑制隐式退出：`window-all-closed without a quit request — implicit Electron quit suppressed` |
| 19:44:49 / 19:44:59 | **心跳继续**（进程存活 ≥12 s；修复前此处 1–2 s 内即死） |
| 19:45:02.99 | 15 s 宽限到期、窗口未回 → `no window came back 15s after suppressing the implicit quit — relaunching the shell` → `finalExit(0)` → `>>> relaunch()` |
| 19:45:26 / 19:45:39 | 新实例 pid 30832 启动、窗口重建、**至今存活** |

**结论**：「静默退出」已消除，退化为「自动重启一次（约 40 s）」。理想目标（重载后窗口原地回来、无需重启）仍待第二步优化，属非阻断项。

**可重复性：2/2 复现成功**。19:53:20 再次热重载 → 窗口销毁 → 进程存活约 15.7 s → 19:53:36 `finalExit(0)` + `relaunch()` → 19:53:49 新实例建窗存活。两次表现完全一致（探针 + 守卫日志双源对齐）。

---

## 6. 若将来要走 B/C：可核验迁移 runbook

1. **冻结基线**：`node scripts/snapshot-assets.mjs`（写 `asset-manifest.json`）→ 记下 7 层数字。
2. **备份**：仓库 git tag/commit + `_backups/` 快照；**`DSH_HOME`（会话/技能/健康）排除在外，不备份也不回滚**。
3. **换基线**：B 不动内核；C 走 `node scripts/upstream-sync.mjs` + `scripts/package-vendor.ps1` 重建干净 dist。
4. **逐条重锚补丁**：`node scripts/patch-apply.mjs`（每条 anchor 漂移都会**响亮失败**，不会静默跳过）→ 每条三选一：重锚 / 迁成客户端插件 / 显式退役（留档）。
5. **重放 profile 与插件**：插件目录不动；profile 重登记后跑 `node scripts/startup-verify.mjs`（V1–V10）。
6. **门禁**：`verify-patches.ps1` → `check-all.ps1` → smoke → 单测 → 未登记改动检查。
7. **回归点击**：用户点一次「创建提供商」，跑 `node scripts/verify-create-provider-exit.mjs` 判定 VERIFIED / DIED / INCONCLUSIVE。
8. **对账**：`node scripts/snapshot-assets.mjs --diff <before>` —— 要求：插件丢失=0、文档节数/篇数/登记数只增不减、运行数据文件数不下降。

---

## 7. 未决项（不阻断 A）

| 项 | 状态 | 处理 |
|---|---|---|
| V4 孤儿包 `@dsh-external/dsh-settings-scope-shim` | **已修复（10/10 PASS）** | 根因＝壳的「健康检查点还原」把 profile 回滚到 09-27 快照，丢掉 4 项 0.1.7 依赖声明 + shim 依赖行 + shim patch 行，只剩 junction。**修法＝恢复声明（不是删链接）**：`reapply-profile-0.1.7.mjs --apply`（13 项全 OK）→ `pnpm install --lockfile-only`（218,151 → 222,873 B，`--frozen-lockfile` 探针 exit 0）→ 检查点快照同步（防再次回滚） |
| 提供商**是否落盘** | **已落盘（先前判断已更正）** | 第二次点击（19:53:20）写入 `cordis.patch.yml`：`llm-pi-ai` → `config.providers.qw`（`openai-completions` / `https://tokenrhythm.studio/v1` / `glm-5.1`，200k 上下文），4323 → 4760 B。第一次点击（19:44:47）未见落盘，原因未取到 |
| `health-check` 采样被宿主 `DSH_PROFILE=web` 污染 | 已修代码 | `startup-verify`/`health-check`/`check-all` 改为显式 `--profile desktop`，不再继承宿主会话变量 |
| 8 个孤儿 junction（1 desktop + 7 web） | 仅 desktop 1 个属本仓 profile | 其余属 QuWork profile，**不动** |
| 重载后窗口**不原地恢复** | 已确证边界，未做改造 | 热重载拆掉持有窗口的 `desktop-shell` 行后，同一进程内**没有**再建窗（探针该进程无 `window created`，壳在该时间窗零日志），故目前靠 15 s 兜底 relaunch（点击一次 ≈ 40 s 重启）。要根除需壳侧改造（重载后重建窗口，或把行持久化进 profile patch），且**必须先验证不会双挂载**（`npm run verify:loader` 无头校验）⇒ 需要单独窗口 + 重建，本会话未动手 |
| 静默退出**回归监控** | 已补 | `scripts/exit-ledger.mjs`（六类结局账本）+ `tests/plugins/exit-ledger.test.mjs`（5/5）+ `check-all` Step 1.23（info-only，命中 `SILENT_WINDOW_LOSS` 即告警）。实测全天 9 次运行：`SILENT_WINDOW_LOSS=0` |
| 历史 SLO 采样里我误记的 1 条 FAIL（profile=web, 3/10） | 待你决定 | 删除需二次确认（属运行数据） |
| 3 个 info 级未登记文件 | 非阻塞 | `docs/README.md`、`docs/UPSTREAM-SYNC-RUNBOOK.md`（[info]）与 `plugins/dsh-settings-scope-shim/_backups-probe-1790655211.bak`（陈旧备份，删除需你点头） |

---

## 8. 如何随时证明「没丢」

```powershell
node scripts/snapshot-assets.mjs                      # 生成当前快照
node scripts/snapshot-assets.mjs --diff outputs\2026-09-29-preserve-assessment\asset-manifest.json
```

输出直接给出：插件丢失/新增/内容变化、内核与壳版本变化、补丁条目增减、CHANGELOG 节数、outputs 登记数、运行数据文件数升降。
