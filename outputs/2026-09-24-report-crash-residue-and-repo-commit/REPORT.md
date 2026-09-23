# 崩溃残留清扫 + 仓库入库（2026-09-24 收尾轮）

> 主题：把前几轮列出的「待拍板」项做完整调查、给出判断、执行能执行的、并留下可复核证据。
> 关联：`outputs/2026-09-23-report-vision-modality-misjudgment/ROUND8-full-selfcheck.md`（全面自检）、`CHANGELOG.md`（第六轮）、`.workbuddy/memory/2026-09-24.md`。

---

## 一、结论先行（三项判断 + 执行状态）

| 事项 | 判断 | 执行 | 依据 |
|---|---|---|---|
| 仓库 **32 项未提交变更**（13 修改 + 19 未跟踪） | **应入库**：全部是已验收的补丁 / 测试 / 脚本 / 报告，长期不提交 = 一旦误删或磁盘故障就永久丢失（本项目已发生过一次不可恢复事故） | ✅ 分 2 个提交入库；`_tmp/` 探针脚本写入 `.gitignore` **不入库** | 变更清单见 §三；每个提交都可 `git reset` 回滚 |
| `~/.dsh/storages/` 下 **2 个 0 字节孤儿 `.tmp`** | **确认是硬杀残留**（不是设计行为、不是活文件） | ✅ 回收站删除 + 新增「清扫」硬化补丁防复发 | mtime 与当日两个 minidump **精确对应**；活文件对照见 §二 |
| `_backups` **≈130 MB** | **不动**：D: 剩 59.3 GB，无空间压力；其中 96.2 MB 是 7 个大会话的**唯一副本**（原件已被 `archive-big-sessions.ps1` **移动**而非复制），且该脚本的公开契约是「restore = 搬回去」——压缩或跨盘搬运会直接破坏可逆性 | ⛔ 保留（本条是判断，不是遗漏） | §四构成表 + 磁盘实测 |

另有两项**查完判定不需要动作**：

- **会话库 368.1 MB 不必现在归档**：实测最大的 17.1 / 16.1 / 13.9 MB 三个会话 `AgeD=0`（今天仍在写），而 `archive-big-sessions.ps1` 的门禁是 `IdleHours=24` —— 它**正确地跳过了**正在使用的会话。这不是缺陷，是设计。
- **`session_projcache.json` 已回落**：重启后淘汰生效，61.0 MB → 53.1 MB（261 条），本轮复查 52.8 MB，未再反弹。

---

## 二、孤儿 `.tmp` 定性（决定性证据：抓到一个「活文件」作对照）

### 2.1 三个样本

| 文件 | 大小 | mtime | 定性 |
|---|---|---|---|
| `.01ae560d-…-664c700575be.tmp` | 0 B | 2026-09-23 **19:22:18** | 崩溃残留（与 19:22 的 Crashpad 转储同刻） |
| `.a5003d55-…-f7a3053fac51.tmp` | 0 B | 2026-09-23 **14:45:27** | 崩溃残留（与 14:45 的 Crashpad 转储同刻） |
| `.a8608484-…-bc0a99d65b89.tmp` | 0 B | 本轮调查期间出现 | **活文件**：20 秒轮询内消失（写入中 → rename 发布完成） |

第三行是本轮**最有价值的观测**：它排除了「这个目录里的 0 字节 tmp 都是残留」这个错误假设，并直接给出**年龄门**的实证依据 —— **活 staging 文件的寿命 < 5 秒**（一次 53 MB projcache 整份重写的耗时），所以「超过 10 分钟未被动过的 `.<uuid>.tmp`」可以安全判定为死文件。

### 2.2 代码根因（实测 `路径:行号`）

`vendor/…/app.asar.unpacked/node_modules/@deepseek-ai/dsh-storage-json/lib/index.js:25-57`：

```js
const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
const handle = await open(tmp, "wx", 384);   // 建 staging 文件
... writeFile / sync / close ...
await rename(tmp, path);                      // 原子发布
...
} catch (error) { await rm(tmp, { force: true }); throw error; }   // ← 唯一清理点
```

清理**只在同一个函数的 catch 里**：进程被硬杀（OOM / SIGKILL / 断电）时 catch 永不执行，staging 文件就永久留在目录里 —— **内核里没有任何代码会再去回访这个目录**。两个 mtime 与两个 OOM minidump 精确对应，闭合了因果。

---

## 三、硬化补丁：`dsh patch json-storage-orphan-tmp-sweep v1`

| 项 | 内容 |
|---|---|
| 目标 | `dist/…/node_modules/@deepseek-ai/dsh-storage-json/lib/index.js`（**重建会静默丢失**） |
| 锚点 | 3 处（导入表加 `readdir/stat`、`writeAtomic` 前插入清扫 helper、staging 文件名计算后调用清扫） |
| 判据 | ① 严格名字形状 `^\.[0-9a-f]{8}-…\.tmp$`（UUID v4 形状）② **mtime 超过窗口**（默认 600000 ms，`DSH_STORAGE_ORPHAN_TMP_MS` 可覆盖） |
| 成本 | 每目录**每进程只列一次**目录（`orphanTmpSweptDirs` 幂等集），且**先把目录记为已扫再列目录**（失败目录不重试） |
| 安全 | 所有错误全吞（清扫永不弄挂写入路径）；`removed > 0` 才打一行日志 |
| 应用 | `node scripts/apply-json-storage-orphan-sweep.mjs`（幂等 + `--dry-run` + 锚点唯一性断言 + 备份 + 原子写 + 回读） |
| 门禁 | `scripts/verify-patches.ps1` **+2 条** ⇒ `79 static + 3 chunk + 1 integrity + 46 syntax = 80 checks`，**ALL PASS** |
| 故障注入 | `tests/dist/json-storage-orphan-tmp-sweep.test.mjs` —— **补丁前 3/4 红（其中 1 条断言直接指向「旧孤儿必须被回收」）→ 补丁后 4/4 绿** |
| 备份 | `_backups/dist-json-storage-orphan-sweep-2026-09-23T16-17-07-200Z/` |
| 生效 | **下次启动**（dist 模块已加载在内存里） |

**测试包含一条负向对照**：把窗口临时改成 1 小时，则「5 分钟前的孤儿」必须**保留** —— 证明真正保护并发写入的是**年龄门**而不是名字（名字只负责「不碰非 staging 文件」）。

---

## 四、`_backups` 构成与「为什么不动」

| 目录 | 大小 | 性质 | 判断 |
|---|---|---|---|
| `archived-sessions-20260923-202006/` | **96.2 MB** | 7 个大会话 `session.jsonl.zstd`（10–17.7 MB/个，**已 zstd 压缩**） | **唯一副本**，保留 |
| `_probe/` | 10.1 MB | 早期会话的探针脚本/快照（260 文件） | 保留（体量小、可能被报告引用） |
| `upstream-probe-0.1.3-alpha.2/` | 3.9 MB | 上游 0.1.3-alpha.2 兼容性调研材料（319 文件，`IMPACT-REPORT.md` 被 `verify-patches.ps1` 注释引用） | 保留（**有活跃引用**） |
| 其余 120+ 目录 | 各 ≤2.8 MB | 各轮改动的回滚备份 | 保留 |

- **磁盘**：C: 剩 30.7 GB / D: 剩 59.3 GB（`_backups` 在 D:）⇒ 无空间压力。
- **压缩无收益**：最大项已是 zstd 压缩产物，二次压缩近似无效。
- **搬盘破坏契约**：`archive-big-sessions.ps1` 头部写明「reversible move, NOT delete」「restore = move back」，把归档目录搬到别处会让「搬回去」这个操作不再成立。

---

## 五、仓库入库（提交内容与理由）

提交前的实测清单：**13 修改 + 19 未跟踪 = 32 项**（此前记录的「30 项」为上一轮快照，本轮为实测值）。

- **提交 1**（视觉/模态链路）：`plugins/dsh-modlens-autoread/**`、`plugins/dsh-vision-engine/lib/index.js`、`plugins/dsh-model-picker-group/**`、`dsh-vision-rotator/src/index.ts`（真图探针）、`scripts/classify-settings-modalities.mjs`、`scripts/check-stale-modlens-twins.mjs`、相关测试与两份视觉报告。
- **提交 2**（稳定性 + 门禁 + 记录）：`scripts/apply-{projcache-guard,json-storage-retry,json-storage-orphan-sweep,context-undefined-tool-fix,cordis-task-catch-fix}.mjs`、`tests/dist/**`、`plugins/dsh-host-services/lib/index.js`、`scripts/verify-patches.ps1`、`scripts/README.md`、`CHANGELOG.md`、`outputs/INDEX.md`、`.gitignore`、`profile/desktop/package.json`（pptwise/office-tools 依赖）。
- **不入库**：`_tmp/`（1.26 MB 一次性探针脚本）⇒ 已加进 `.gitignore`，理由写在文件里。

---

## 六、风险与回滚

| 动作 | 风险 | 回滚 |
|---|---|---|
| dist 补丁 | 低（不改正常写入路径；只多一次 readdir/目录/进程；错误全吞） | `copy` 回 `_backups/dist-json-storage-orphan-sweep-2026-09-23T16-17-07-200Z/*.bak` 覆盖目标文件 |
| 删 2 个孤儿 tmp | 极低（0 字节、无句柄、已定性为残留） | 走**回收站**，可还原 |
| 2 个 git 提交 | 低（纯新增/提交，未 push） | `git reset --soft HEAD~2`（回到提交前的工作区状态） |
| `.gitignore` 加 `_tmp/` | 极低 | 删掉那 3 行 |

---

## 七、方法论（本轮新增的两条，已可复用）

1. **判定「残留」必须先找「活样本」作对照**。第一轮快照里三个 0 字节 tmp 长得一模一样，若直接全删就会把**正在写入的 staging 文件**删掉（虽不致命，但会真断一次写入）。抓到一个活样本并量出「寿命 < 5 秒」，才把「10 分钟年龄门」从拍脑袋变成实证。
2. **补丁器的自检要只解析「可独立成立的片段」**。首版 `--dry-run` 报 `Unexpected token ')'` —— 因为我把自己注入的、**故意未闭合**的锚点行（`async function writeAtomic(path, data) {`）也塞进了 `new Function(...)` 做语法校验。改为只校验 helper 部分后通过。这类「自检误报」若放过，下次就会有人把正确的锚点删掉去迎合校验器。

---

## 八、未执行项（明确记录，不是遗漏）

| 项 | 为什么不执行 |
|---|---|
| 归档今天的 3 个大会话（17.1/16.1/13.9 MB） | 门禁 `IdleHours=24` 要求闲置满 24h；它们 `AgeD=0` 仍在写 ⇒ 等闲置后跑 `archive-big-sessions.ps1 -Execute` 即可 |
| 降 `HARD_CAP` 到 200 / 改按体积淘汰 | 当前 52.8 MB 稳定、无 OOM 复发；过度调参会牺牲冷读命中率，收益不明 |
| Crashpad 转储（2×34 MB） | `crashpad-hygiene` 的 `maxKeep=2` 设计值，非泄漏 |
| `compaction-basic` 双 `[active]` | 存疑未闭环，改 loader 组合风险高于收益 |
