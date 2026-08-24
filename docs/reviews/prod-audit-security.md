# DeepSeek Harness Desktop — 投产前安全专项审计报告（横切面）

- **日期**：2026-08-24（审计执行日）
- **范围**：D:\Deepseek-Harness 全仓横切安全（网络暴露、loopback 鉴权、机密管理、供应链、文件/操作安全、远程执行、仓库泄密）。插件内部代码质量由并行子代理审查，本报告不重复。
- **方法**：只读/无创（未修改任何文件；对 43120 仅做 3 次无害 GET 探测）；证据均附文件/命令位置。
- **对象版本**：DSH Desktop v2（dsh-plugin-desktop 2.0.2）+ DSH 内核 @deepseek-ai/dsh@0.1.1-rc.2，Windows 桌面部署，Web GUI @ http://127.0.0.1:43120。

---

## 1. 威胁模型

本项目是一台**运行在用户日常办公机上、具备 shell/文件等高危工具能力**的本地 Agent。四类威胁主体：

| 威胁主体 | 能力 | 关注面 |
|---|---|---|
| **本机恶意进程**（同用户权限） | 可读用户任意文件、可连任意 loopback 端口 | 窃取 `~/.dsh` 凭据与 API key；直接调用 43120/8787 未鉴权接口 |
| **恶意网页（DNS rebinding / 跨域请求）** | 诱导用户浏览后，向 127.0.0.1 发起请求/WS | 劫持 Agent 会话 → 借 shell 工具实现 RCE；盗用本地网关额度 |
| **供应链** | npm 上游包、RC/dev 版本、未签名二进制、自动更新通道 | 上游投毒/意外破坏性变更直达生产；更新被篡改 |
| **插件自身**（21 个自研插件 + 超注入器） | 运行时注入、可注册路由/工具 | 路由鉴权缺失、命令注入、密钥落盘 |

核心事实：Agent 的 shell 能力意味着**任何能驱动会话通道的攻击者等价于获得用户权限的 RCE**，因此 loopback HTTP/WS 通道的鉴权是全局安全中枢。

---

## 2. 逐维度发现

### 2.1 网络暴露面 ✅ 总体良好

**实测监听端口（Get-NetTCPConnection -State Listen 聚合）**：项目相关仅两个，均为 loopback：

| 端口 | 绑定 | 进程 | 用途 |
|---|---|---|---|
| 43120 | 127.0.0.1 | DSH Desktop | Web GUI + 内核 API/WS |
| 8787 | 127.0.0.1 | DSH Desktop（hy3-gateway 子进程） | 本地混元 hy3 OpenAI 兼容网关 |

**未发现本项目任何 0.0.0.0 监听**（机器上其余 0.0.0.0 端口属 VMware/系统服务，与本项目无关）。

**代码级强制**：`vendor\deepseek-harness-desktop\dsh-plugin-desktop\src\webserver.ts:29-31` 构造函数硬性要求 `config.host === '127.0.0.1'`，否则抛错；上游 `dsh-host-webserver` 仅接受 127.0.0.1/0.0.0.0 两值且默认 loopback 姿态（其 README）。`hy3-gateway\server.js:150` 显式 `server.listen(PORT, '127.0.0.1')`。

> **F-NET-1（P2）**：`_backups` 中的历史 dist 归档仍含旧版可执行副本，若被误启动可能以旧（更弱）配置监听；见 2.5。

### 2.2 loopback 鉴权 ⚠️ 壳层自研路由优秀，内核通道缺失（本报告最高危发现）

**壳层自研路由——全部有 Origin 防护（亮点）**：
- `desktop-settings-route.ts:52-102` 实现 `isSameOriginLoopbackRequest`：校验 socket+Host 停留在配置的 loopback origin；变更类请求要求**精确 Origin**，只读 GET 允许 `sec-fetch-site: same-origin`+同源 referrer。9 条 `/desktop/*` 私有路由（设置/Profile/市场/终端/诊断导出，`index.ts:185-211`）全部套用。
- `directory-picker-route.ts:43,62`、`renderer-boot.ts:62`：精确 Origin，不符 403。
- 插件侧 `dsh-remote-workspace\src\index.ts:598-620` 的 `trusted()`：loopback 对端 + Host 本地名校验 + **强制 Origin 存在且为本地源** + Origin 端口与 Host 端口一致 + `sec-fetch-site` 纵深校验，并配 64KB 请求体上限（:733）。这是教科书级的 DNS rebinding 防护实现。
- 实测（3 次无害 GET）：伪造 `Host: rebind.evil.example` 访问 `/` 返回 200（主页静态内容，浏览器 SOP 下跨域不可读，风险低）。

**发现的缺口**：

> **F-AUTH-1（P0，阻塞投产）内核 `/api` 桥与下行 WebSocket 无 Origin/Token 校验，DNS rebinding 可劫持 Agent 实现 RCE。**
> - 证据 1：`dsh-plugin-desktop\node_modules\@deepseek-ai\dsh-host-webserver\README.md:21` 明确声明 “**No TLS, auth, or origin policy** — … deployment hardening … deliberately out of scope for the dev-facing v1”（/api HTTP 桥与下行 WS 是 connection 插件的路由，webserver 只交付裸 socket）。
> - 证据 2：对全部 `@deepseek-ai` 安装包代码 grep `sec-websocket-origin|checkOrigin|headers.origin` **零命中**——WS 握手不校验 Origin。
> - 攻击链：用户浏览恶意页面 → DNS rebinding 将攻击域解析到 127.0.0.1 → 页面发起 `ws://127.0.0.1:43120/...`（WebSocket 不受同源策略约束、无预检）→ 内核无 Origin/token 校验 → 攻击者驱动 Agent 会话 → shell 工具 = 用户权限 RCE。
> - 缓解因素：仅 loopback 绑定（外网不可达）；攻击需用户在应用运行时访问恶意页面。但对"日常办公机 + 高危工具"的威胁模型，这正是最典型的本地 Agent 沦陷路径（同类事故在 Jupyter/Ollama/本地 LLM 生态中反复出现）。
> - 修复：上游补丁或登记补丁在 WS upgrade 处校验 `Origin === http://127.0.0.1:<port>`；更稳妥为内核通道引入启动时随机 token（Electron 侧注入，`__DSH_BOOT__` 已具备注入点）。
> - 备注：修复落在上游包内，需走上游 PR 或既有补丁自愈机制登记；投产前必须闭环或正式风险接受+补偿控制。

> **F-AUTH-2（P2）`/desktop/critical-busy` 仅校验 socket loopback，无 Origin/Host 校验。**
> - 证据：`critical-busy-route.ts:18-21,49`（`isLoopback` 只看 `remoteAddress`）；实测伪造 `Origin: http://evil.example` 的 GET 返回 200。
> - 影响：DNS rebinding 页面可 POST 置位/清除"关键操作忙"标志——清除标志可能让用户在补丁写入中途关窗造成损坏态，或置位干扰退出。影响面小，但与壳层其他路由防护标准不一致。
> - 修复：复用 `isSameOriginLoopbackRequest`。

> **F-AUTH-3（P1）hy3-gateway（8787）完全无鉴权且全响应 `access-control-allow-origin: *`。**
> - 证据：`hy3-gateway\server.js:35,90,120`（CORS `*`）、:115-135（无任何 token/Origin/Host 检查）。
> - 影响：任意用户访问的网页可直接跨域调用 `POST http://127.0.0.1:8787/v1/chat/completions`（OPTIONS 预检全放行；text/plain 简单请求连预检都不需要）——盗用云开发免费额度/配额、把本网关当免费 LLM 代理；响应可被攻击页面读取。
> - 修复：启动时生成随机 token 经环境变量注入 DSH provider 配置，网关校验 `Authorization`；删除 `access-control-allow-origin: *`（默认拒绝跨域）。

### 2.3 机密管理 ✅ 总体良好，2 处注意

**存放位置（仅列文件名，未读内容）**：
- `~\.dsh\.credentials.yaml`（0.6 KB）、`~\.dsh\settings.yaml`（6.4 KB）——DSH 凭据/设置中心，明文 YAML（dsh-credentials/settings-file 上游机制）。
- `~\.dsh\remote-workspace\connections.json` / `workspaces.json` —— 远程连接描述（host/port/user/keyPath），**不含密码**。
- `~\.dsh\super-injector\*.log`、`registry.json` —— 插件注册/自愈状态，无密钥。
- 工作区内 `hy3-gateway\apikey.local.txt` —— CloudBase API key 明文（`start.ps1:7,12` 读入环境变量）。

**日志密钥扫描**：对 `~/.dsh` 全部日志及工作区 8 个 `*.log`（排除 _backups/node_modules）用模式 `sk-[A-Za-z0-9_-]{16,}|api[_-]?key|bearer|authorization|CLOUDBASE_APIKEY` 扫描——**0 命中**。壳层 `mask-secrets.ts`（覆盖 api_key/bearer/长 token 等 20+ 形态）已接入 `desktop-logger.ts` 与 `log-files.ts`，日志管线有主动脱敏。✔

**发现**：

> **F-SEC-1（P2）`hy3-gateway/apikey.local.txt` 明文密钥落盘于工作区。** 整个 `hy3-gateway/` 已被 `.gitignore:98` 忽略、`git ls-files` 确认**未被跟踪**（✔ 无仓库泄密），但本机恶意进程可直接读取。建议改用 Windows 凭据管理器或至少收紧文件 ACL。

> **F-SEC-2（P2）`~/.dsh/.credentials.yaml` 等凭据为明文文件**（上游机制，壳层未加固）。同用户权限进程可读。投产建议：文档化该风险 + 评估 DPAPI/ACL 加固可行性。

> **F-SEC-3（信息/亮点）SSH 密码从不落盘**：`dsh-remote-workspace` save 分支显式不持久化密码（:503-505），且 `loadConnections`（:73-84）对历史遗留明文密码做读取即剔除+回写迁移；测试连接对密码认证直接拒绝（:355-357）。

### 2.4 供应链 ⚠️ 生产依赖 RC/dev + 未签名 + 更新链无完整性校验

**根 `package.json`（dsh-plugin-desktop 2.0.2）审计**：

> **F-SUP-1（P1）生产依赖锁定在上游 RC / dev 版。** `dependencies` 中约 100 个 `@deepseek-ai/*` 包全部 `0.1.1-rc.2`（Release Candidate），`dsh-community-market: 0.1.0-dev.0`（dev）。RC/dev 语义上保留破坏性变更权利、无安全维护承诺；"补丁自愈"历史（见下）正是 RC 漂移的直接后果。投产应推动上游出 GA 或签订版本冻结+自维护承诺。✔ 好的一面：版本全部**精确锁死**（无 ^/~ 漂移）。
>
> **F-SUP-2（P1）Windows 产物无代码签名 + 更新下载无完整性校验。** `package.json` build 配置：`win.signAndEditExecutable: false`（mac 侧却 `notarize:true`+hardenedRuntime，对比鲜明）；`electronFuses.runAsNode: true`（打包 exe 可被当作 node 解释器滥用，建议评估关闭）。更新链 `update-download.ts`：从 `https://www.dshdesktop.cn/api/downloads/windows` 下载安装器，有用户确认门与 PE/UDIF 魔数校验（:460-461），但 grep `sha256|checksum|integrity|signature` **零命中**——无校验和/签名验证。未签名 + 无完整性校验 + 提示式更新组合，使 dshdesktop.cn 被入侵或 CDN 被劫持（TLS 之外无第二道防线）时可直接投递恶意二进制；且未签名安装器会被 SmartScreen 拦截，用户被训练"点仍要运行"。投产前应完成代码签名证书接入 + 更新包强制校验。
>
> **F-SUP-3（P2）全局 node_modules 补丁自愈机制残留需持续治理。** 历史机制登记于 `patches\reference\patch-manifest.js`（1037 行：modlens/safe-delete/ui-workspace 等多处锚点补丁，含自动退役逻辑）；现行流程改为 `patches\bundles\`（6 个补丁 bundle + 3 个 `.orig-*` 原始副本）+ `scripts\verify-patches.ps1`（windowsHide 与 critical-guard 校验，`package-vendor.ps1:34` 在每次打包后强制运行）。机制本身有登记/校验/原子替换约束（✔），但补丁产物是**未经上游审查的运行时高危代码副本**，应：为每个补丁文件记录哈希与 diff、纳入代码评审、随上游升级逐项清退。
>
> **F-SUP-4（P2）其他依赖面**：`koffi 3.1.5`（原生 FFI）、`pnpm 11.21.0` 作为运行时依赖打包、`asarUnpack: node_modules/**`（整个依赖树解包可执行）——Electron 生态常规暴露，建议例行依赖漏洞扫描（`npm audit`/OSV）纳入 CI。

### 2.5 文件与操作安全 ✅ 有章法，1 处卫生问题

- **`_backups/`：227,882 个文件 / 4.56 GB**（`dist-archive` 三份完整构建归档：3.4 GB + 567 MB + 567 MB，另有零星补丁备份）。严格文件名规则（`settings.yaml|.credentials.yaml|.env|id_rsa|.pem|.key`）扫描**0 个真实机密文件**（宽规则命中的 1471 个全部是归档构建里 node_modules 的库代码，如 @anthropic-ai/sdk 的 credentials.js）。▶ **F-OPS-1（P2）**：无泄密，但 4.5 GB 陈旧可执行/代码副本既是磁盘负担也是"误启动旧版"风险面，建议只保留最近一份归档并给归档加清单文件。
- **`.dsh-trash`：不存在**（无垃圾堆残留）。✔
- **`patches/`**：见 F-SUP-3。
- **`scripts\guard-destructive.ps1`**：实现质量不错——破坏性原语识别（Remove-Item -Recurse/rm -r/rd /s/format/diskpart/回收站/`\\.\`设备路径）、保护根（用户目录/APPDATA/WINDIR/盘根）、未加引号通配符一律拦、仅放行工作区内目标，自带 7 条自测用例。▶ **F-OPS-2（P2）**：它是**咨询式**守卫（需调用方主动 `Test-DestructiveCommand`），且基于字符串正则：8.3 短文件名、动态拼接命令、相对路径等可绕过；作为纵深防御可接受，不应视为强制边界。
- **补丁工作流守则**（AGENTS.md）：bundle 改动先 `patches/bundles/` 临时副本 + `node --check` + 原子替换、禁在运行服务路径留中间态——流程本身是加分项。✔
- 子进程 `windowsHide:true` 铁律有 `verify-patches.ps1` 强制校验（防闪框，亦防控制台句柄泄漏）。✔

### 2.6 远程执行路径（plugins/dsh-remote-workspace）✅ 横切面健壮

只读代码审查（764 行全读）：
- **路由鉴权**：`/remote-ws` 前缀路由仅接受 POST，先过 `trusted()`（见 2.2 亮点），403/413/400 分支完整。✔
- **命令注入防护**：`assertSafeTarget`（:308-320）拦截以 `-` 开头或含空白/`;&<>`'"` 的 SSH host/user、非 `[A-Za-z0-9_.-]` 的容器名/发行版名——堵住 ssh/docker/wsl 选项注入与 shell 元字符注入（注释标注为 M2 修复）。远程路径参数经 `sq()` 单引号转义（:283-285）。
- **资源限制**：`run()` 输出每流 1 MB 上限超出即 kill（:240-261）、远程命令 20s/120s 超时、`windowsHide:true`。✔
- **密钥**：SSH 密码拒绝非交互执行且永不落盘（见 F-SEC-3）；`keyPath` 指向的私钥文件权限依赖文件系统，未额外校验（可接受）。
- ▶ **F-RWS-1（P2，设计提醒）**：`remote_bash` 工具在远程环境是**设计上无限制的 RCE**（工具自述"远程执行权限与本地同权"）。这意味着 F-AUTH-1 的劫持链可经由远程工作区横向延伸到用户的远程主机（SSH 目标）。修复 F-AUTH-1 即覆盖；另建议在远程会话注入破坏性命令提醒。
- `connections.json`/`workspaces.json` 含内网主机名（如 192.168.x.x）——非机密，但若共享诊断导出（`/desktop/diagnostics-export`）需注意脱敏。▶ **F-RWS-2（P2，信息）**。

### 2.7 仓库泄密检查 ✅ 干净

- `git status --porcelain`：**未跟踪文件 0 个**（全部纳入管理或正确忽略）。
- 最近 15 条提交信息无机密痕迹（含一次"收编 hy3-gateway 改动"的提交，但 `git ls-files hy3-gateway` 为空、`.gitignore:98` 整目录忽略，实际未入库）。
- `.gitignore` 明确分区 "local experiments / secrets / debug logs"：`locales/`、`cb-hy3-test/`、`hy3-gateway/`。✔
- 代码中硬编码的敏感常量仅 `hy3-gateway\server.js:7` 的云开发 **ENV_ID**（环境标识符，非凭据）；`CLOUDBASE_APIKEY` 全程走环境变量，`scripts/` 与提交历史中未见赋值。✔
- `~/.dsh/sessions/` 含跨多项目的历史会话目录（含远程锚目录）——属产品数据；若仓库随机器流转需整体清除。▶ **F-REPO-1（P2，信息）**。

---

## 3. 亮点（值得保持）

1. **loopback 硬约束**：`DesktopWebServer` 构造函数级拒绝非 127.0.0.1；实测无任何项目端口对外绑定。
2. **自研路由的统一同源校验范式**（`isSameOriginLoopbackRequest` / `trusted()`），且考虑了 Origin 缺失、`[::1]`、动态端口等新壳细节。
3. **日志全链路脱敏**（`mask-secrets` 接入两个日志入口）+ 实测日志零密钥残留。
4. **远程工作区插件安全工程到位**：注入防护、密码零落盘+历史迁移清洗、请求体/输出/超时三重限额。
5. **变更安全流程**：guard-destructive 预检、critical-busy 退出保护、bundle 原子替换、构建后强制 verify-patches、promote 拒绝运行中换 junction。
6. **仓库卫生**：零未跟踪文件、机密目录显式忽略、补丁有登记与退役机制。

## 4. 投产结论

**判定：有条件不通过 —— 存在 1 个 P0，闭环后方可投产。**

| 级别 | 编号 | 摘要 | 位置 |
|---|---|---|---|
| **P0** | F-AUTH-1 | 内核 /api+WS 无 Origin/Token，DNS rebinding → 劫持 Agent → RCE | 上游 dsh-host-webserver/connection 路由（经 webserver.ts 壳层强制仅余 loopback 一道防线） |
| **P1** | F-AUTH-3 | hy3-gateway 无鉴权 + CORS `*`，任意网页可盗用 LLM 额度 | `hy3-gateway\server.js` |
| **P1** | F-SUP-1 | 生产依赖锁定 0.1.1-rc.2 全家桶 + 0.1.0-dev.0 | 根 `package.json` |
| **P1** | F-SUP-2 | Windows 未签名 + 更新下载无校验和/签名验证 + runAsNode 开启 | `package.json` build 段、`update-download.ts` |
| P2 | F-AUTH-2 | critical-busy 缺 Origin 校验（影响小但破坏一致性） | `critical-busy-route.ts` |
| P2 | F-SEC-1/2 | apikey.local.txt 与 ~/.dsh 凭据明文落盘 | `hy3-gateway/`、`~/.dsh/` |
| P2 | F-SUP-3/4 | 补丁 bundle 高危副本需哈希登记与评审；依赖扫描入 CI | `patches/bundles/` |
| P2 | F-OPS-1 | _backups 4.56 GB 陈旧构建归档清理 | `_backups/` |
| P2 | F-RWS-1/2 | remote_bash 远程 RCE 随 F-AUTH-1 联动；诊断导出注意内网信息 | `plugins/dsh-remote-workspace` |

**建议放行条件**：F-AUTH-1 必须修复（上游 Origin 校验/token 补丁）或经正式风险接受+补偿控制（如仅限离线机部署）；三个 P1 应在投产窗口内闭环。壳层自研代码的安全质量明显高于上游内核默认姿态——本项目的风险重心在"把无鉴权的 dev-facing 内核直接暴露在日常办公机的浏览器可达环回面上"这一架构选择上。

---

*附：本审计未执行破坏性操作；未读取任何密钥文件内容；对 43120 的探测为 3 次只读 GET（含伪造 Host/Origin 的对抗性探测各 1 次）。*
