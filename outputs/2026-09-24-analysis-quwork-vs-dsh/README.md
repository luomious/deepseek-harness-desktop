# QuWork 逆向分析 · 与 DSH Desktop 的彻底对比与优化方案

> **入口**：[`REPORT.md`](./REPORT.md)（完整报告，12 节）
> **分析对象**：`E:\QuWork`（QuWork Desktop v1.2.0，Electron 商业发行版，厂商「广州微浮信息科技有限公司」）
> **对照对象**：`D:\Deepseek-Harness`（DSH Desktop v2.0.2，自研）
> **方法**：只读逆向 —— asar 解包（14725 文件）+ 运行时状态取证 + 4 天日志聚类；结论全部带 `路径:行号` 或命令证据
> **未执行任何写操作到 `E:\QuWork`**；解包产物在 `_tmp/quwork-recon/`

---

## 一句话结论

**QuWork 的本质 =「DSH 内核的商业外壳 + 插件市场 + 多层更新回滚体系」。它没有 fork 内核，而是把 DSH 0.1.7-rc.1 当作「按 recipe 可复现构建的只读运行时」嵌入，全部产品化能力做在 Electron 主进程与 Cordis 补丁层上。**

最值得学的**不是功能，是工程纪律**：事务化写入、检查点回滚、供应链签名、下载/解包安全闸门、单操作互斥 —— 恰好命中 DSH 历史上反复踩坑的领域（重启打不开 / 插件悬空 / 覆盖事故）。

---

## 核心发现速览

| 维度 | QuWork 做法 | 我们的差距 |
|---|---|---|
| **插件** | 三级交付（runtime/bundled/remote）+ 每文件 sha256 + vendor 离线包 + `--frozen-lockfile` 声明式安装 + **单操作互斥** | 靠 `dev_install_package` + task-scheduler 人工加锁；无 vendor 离线包 |
| **Skill** | 多根发现 + frontmatter 双通道（模型可调/仅用户可调）+ **XML `<location>` 注入**（不注正文）+ **安装前静态审计 + 确认闸门** | catalog 为纯文本摘要（AGENTS.md 自记「9KB catalog 使锚定率 81%→0%」）；无审计 |
| **更新** | 四层：外壳(electron-updater) → 运行时(Ed25519 签名 manifest) → profile(三槽检查点) → 远端插件(desired/installed 收敛) | 有 `patches/` + `_backups/`，无自动检查点/回滚、无补丁 digest |
| **Bug** | 13K 行日志 / 仅 8 error（6 个同一网络原因）；崩溃自带 stdout/stderr tail + URL 脱敏 | 有 log-write-guard，但无「退出即带现场」 |
| **架构** | 契约层独立(`shared/`) + 域边界清晰 + 内核零 fork（补丁层定制） | 直接改 dist 产物，内核升级即丢 |

---

## 最强的一条：Profile 三槽检查点

`profile-health-checkpoint-service.js`（33KB）是**教科书级 crash-safe 三槽轮转**：

- **实盘验证**：`%APPDATA%\qurwork-desktop\dsh-profile-checkpoints\web\{latest,previous,older}\` 各含 `manifest.json`（per-file sha256 + sourceDigest + contentDigest + generation）+ `payload/`
- 槽位租约（Promise 链互斥）→ 候选目录 `.candidate-<pid>-<uuid>` → 校验 → 原子发布
- **穷举崩溃中间态并收敛**（`recoverInterruptedPublishUnlocked`：按 latest/previous/older/`.old` 存在组合推断卡在哪步并补齐）
- capture 前后 + 发布前**三次 `sourceDigest` 比对**（TOCTOU）
- **`skip-next-healthy.json`（带 generation）防「恢复后立刻又拍坏快照」的循环**

**核心洞察：把崩溃当成正常路径来设计** —— 不是 try/catch 兜底，而是穷举中间态 + 确定性收敛。

---

## 我们别学的（QuWork 的缺陷）

| 缺陷 | 证据 |
|---|---|
| **`bridgeToken` 明文写入 `cordis.patch.yml`**，且该文件是检查点备份对象 → token 扩散到 3 个槽位 | `dsh-plugins\active\cordis.patch.yml:6` |
| pnpm guard 可绕过（带引号/大小写变体不匹配保护名单） | `qurwork-pnpm-guard.cjs` |
| 更新源单点 `img1.rrzuji.cn`，不可达直接向用户报 error | 日志 3× |
| 检查点冗余存 998KB `package.tgz` × 3 槽 | `latest/previous/older/payload/profile/package.tgz` 均 998322B |
| `session-notifier` 空载荷 warn ×12（噪音） | 日志聚类 |
| `exitCode 1073807364`(NTSTATUS) 未翻译，落入 UNKNOWN | `failure-diagnostic-service.js:159` vs 日志 `:1582` |
| 技能能力就绪但内置内容为空（`resources/skills` 不存在） | §1 实测 |

---

## 优化方案（批次化，均为 plan，未执行）

- **P0 地基**（低风险高杠杆）：`lib/atomic-write.mjs`（统一原子写）、`lib/archive-guard.mjs`（归档安全闸门）、`lib/safe-download.mjs`（SSRF + 逐跳复检 + 流式限长）
- **P1 核心机制**（中风险高价值）：**单操作互斥**、**Profile 三槽检查点 + 回滚**（差异点：大 tarball 走内容寻址、快照前凭据脱敏）、**启动失败 → 可执行修复方案**
- **P2 增强**：补丁 digest 登记、skill 注入改造（XML + location）、技能安装审计、崩溃现场自带 + NTSTATUS 翻译、离线插件包、对外更新 API
- **不采纳**：单一 pre-extracted 运行时（开发态需热改）、`delivery: remote`（super-injector 更强）、检查点冗余存大文件、明文 token 进 patch 层

详见 [`REPORT.md`](./REPORT.md) §10（含每项的 目标/涉及文件/改动点/验证方式/回滚方式/风险收益）。

---

## 诚实边界（未验证项）

1. `patchSet: qurwork-ui-and-windows-fixes` 的**具体补丁内容**未找到实体（仅有 digest）
2. `staging-manifest.json`（5MB）仅抽样，未全量解析
3. 检查点**实际被触发回滚**的次数为 0（日志无 `checkpoint.restore`）—— 机制存在但本机未被使用
4. `qurwork-dsh-bridge` 的 `client.js`(27KB) 完整行为未细读
5. 更新包是否**真校验 `publisherName`** 未实测（generic provider 通常不做 Authenticode 校验，**[推断]** 未校验）
6. `exitCode 1073807364` 归因基于数值域推断，未与 Windows 事件日志交叉验证
