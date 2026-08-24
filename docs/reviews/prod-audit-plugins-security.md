# 投产前插件安全审计报告（7 个安全敏感插件）

- 审计对象：`plugins/` 下 7 个安全敏感插件
- 审计方式：只读静态分析（源码精读 + 语法校验），不运行插件、不修改代码
- 严重级定义：**P0**=阻塞投产；**P1**=投产前必修；**P2**=优化建议
- 报告状态：**✅ 已完成**（7/7 插件；全部 `lib/index.js` `node --check` 通过；**无 P0，4 条 P1，16 条 P2**）

## 发现总览

| # | 严重级 | 插件 | 位置 | 摘要 |
|---|--------|------|------|------|
| W1 | **P1** | dsh-web-fetch-local | lib/index.js:49,86 | DNS rebinding TOCTOU：校验解析与 fetch 解析是两次独立解析，可绕过私网过滤打内网/本机 43120 |
| B1 | **P1** | dsh-web-search-bing | lib/index.js:44,137 | bing-fetch 内联复制同款守卫，同样 rebinding TOCTOU |
| H1 | **P1** | dsh-hy3-gateway | hy3-gateway/server.js:35,90,120 | 网关无鉴权 + CORS `*`：任意网页可借用户 CloudBase 凭据消费配额/当开放代理 |
| F1 | **P1** | dsh-file-explorer | lib/index.js:209 | 默认可读任意盘符绝对路径（含其他用户/系统文件），与"仅主目录"文档矛盾、突破工作区沙箱 |
| W2 | P2 | dsh-web-fetch-local | lib/index.js:108,97 | 整下载后才截断，超大响应可耗尽宿主内存 |
| W3 | P2 | dsh-web-fetch-local | lib/index.js:87 | 无默认超时（慢速挂起） |
| W4 | P2 | dsh-web-fetch-local | lib/index.js:13 | IPv4-mapped IPv6 十六进制形式未覆盖（低风险） |
| RW1 | P2 | dsh-remote-workspace | lib/index.js:310 | ssh user 未拒绝前导 `-`（argv 形态，低风险） |
| RW2 | P2 | dsh-remote-workspace | lib/index.js:308 | ssh host 未禁 `@`/`:`（连接目标混淆，低风险） |
| RW3 | P2 | dsh-remote-workspace | lib/index.js:21-28 | 连接元数据明文落 `~/.dsh/remote-workspace/`（无密码） |
| H2 | P2 | dsh-hy3-gateway | hy3-gateway/apikey.local.txt | 密钥明文落盘（已核实被 .gitignore 忽略、不进日志） |
| H3 | P2 | dsh-hy3-gateway | plugins/dsh-hy3-gateway/lib/index.js:26-35 | 子进程 detached+unref，无生命周期清理 |
| H4 | P2 | dsh-hy3-gateway | hy3-gateway/server.js:8,150 | 固定端口 8787，本地可被抢 bind 仿冒 |
| F2 | P2 | dsh-file-explorer | lib/index.js:140 | resolve-home 未过 isPathAllowed（不一致） |
| F3 | P2 | dsh-file-explorer | lib/index.js:145 | session-cwd 信任 args.exec，成路径存在性探针 |
| S1 | P2 | dsh-skills-manager | lib/index.js:206 | `rm -rf` 越界检查为 startsWith(root) 前缀匹配，兄弟目录理论可越（当前不可达） |
| S2 | P2 | dsh-skills-manager | lib/index.js:167-194 | update/setEnabled 写 d.path 缺 delete 同款越界校验 |
| B2 | P2 | dsh-web-search-bing | lib/index.js:105,171 | 同"下载后截断"；搜索响应无大小上限 |
| B3 | P2 | dsh-web-search-bing | lib/index.js:96 | 无密钥爬取：UA 伪装、结构依赖、合规风险 |
| B4 | P2 | dsh-web-search-bing | lib/index.js:69 | 搜索结果注入 agent 上下文（通用注入面提示） |

---

## 1. dsh-web-fetch-local（SSRF 防护）

状态：✅ 已审计（`lib/index.js` 127 行，无 src/）

**亮点**：私网段覆盖全面（环回/私网/链路本地/CGNAT 100.64/7、组播、IPv6 ULA/site-local/NAT64/documentation、IPv4-mapped IPv6 剥离复检）；`lookup(all:true)` 解析全部 A/AAAA 记录、任一私网即拒；重定向 `redirect:'manual'` + 每跳重新校验 + 上限 5 跳；协议白名单仅 http/https；`node --check` 通过。

| 严重级 | 位置 | 问题 | 修复建议 |
|--------|------|------|----------|
| **P1** | `lib/index.js:49,86-94` | **DNS rebinding TOCTOU**：`assertPublicUrl` 用 `lookup()` 独立解析一次，随后 `fetch()` 会再次自行解析——两次解析之间存在窗口。攻击者用短 TTL DNS 可令第一次解析返回公网、第二次返回 `127.0.0.1`（本机 43120 即 DSH 内核）或其他内网地址，绕过全部防护。注释声称"防 rebinding"，但"解析全部记录"只防同一次解析内的混合记录，防不住两次解析。 | 消除二次解析：用首次解析结果直接连 IP（https 时设 `servername`=原 host），或在 undici `connect` 钩子于建连瞬间对真实 socket 地址再跑一次 `isPrivateAddress` 并拒绝。 |
| **P2** | `lib/index.js:108`（及 97） | **体积上限在下载完成后才生效**：`response.arrayBuffer()` 先把整个 body 读进内存再截断到 1MB，恶意源站可发超大/无 content-length 流耗尽宿主进程内存。重定向分支同样全量读 body。 | 改为流式读取 `response.body` 并累计字节数，超过 `MAX_BYTES` 立即 abort；预检 `content-length`。 |
| **P2** | `lib/index.js:87` | **无默认超时**：调用方未传 `signal` 时，慢速源站（slowloris）可无限挂起请求。 | `AbortSignal.any([signal, AbortSignal.timeout(30_000)])`。 |
| **P2** | `lib/index.js:13` | IPv4-mapped IPv6 仅匹配点分十进制 `::ffff:a.b.c.d`；十六进制形式（如 `::ffff:7f00:1`）会落入 IPv6 分支并视为公网。OS resolver 通常返回点分形式，风险低。 | 统一规范化地址后再判定，或对 `::ffff:` 前缀单独按 IPv4 复检。 |

## 2. dsh-remote-workspace（远程命令执行）

状态：✅ 已审计（`lib/index.js` 826 行；`src/index.ts` 与 lib 一致；`node --check` 通过）

**结论**：本插件不自行 listen，路由 `/remote-ws` 挂在 DSH web server 上，靠 `trusted()` 校验。远程执行走 **argv 数组 `spawn`（无 `shell:true`）**，命令注入面已收敛；连接目标有 `assertSafeTarget` 白名单校验；SSH 密码明确不落盘。整体防护到位，无 P0/P1。

**亮点**：
- `trusted()`（`lib/index.js:628-675`）：回环 remoteAddress + Host 必须本地名 + Origin 必须存在且本地 + 端口一致 + `Sec-Fetch-Site` same-origin 纵深防御，能挡 CSRF 与 DNS rebinding（Host=attacker.com 被拒）。
- 子进程全部 `spawn(argv)` 数组形式、`windowsHide:true`、stdout/stderr 各 1MB 上限（`lib/index.js:221-275`），防内存撑爆。
- `assertSafeTarget`（`:306-322`）拒绝以 `-` 开头/含 shell 元字符的 host、限定 container/distro 字符集，防 ssh/docker 选项注入。
- `cdTo`/`sq`（`:277-294`）对 workdir 做单引号转义 + `cd --`，防 workdir 注入。
- SSH 密码认证直接拒绝且不落盘（`:360,518-525`），仅密钥；历史明文密码读取时剔除回写（`:51-66`）。

| 严重级 | 位置 | 问题 | 修复建议 |
|--------|------|------|----------|
| **P2** | `lib/index.js:310` | ssh `user` 未校验"以 `-` 开头"（仅 host 校验了）。`userHost=user@host` 为单条 argv，若 user=`-foo` 则 `-foo@host` 可能被 ssh getopt 误当选项。参数仅本机可信 UI 可写，风险低。 | `assertSafeTarget` 对 user 增加 `startsWith('-')` 拒绝。 |
| **P2** | `lib/index.js:308` | ssh host 未禁止 `@` 与 `:`，`user@host` 组合可造成连接目标混淆（如 host=`a@b`）。同为用户自配参数，风险低。 | host 字符集收紧为 `[A-Za-z0-9_.-]` 或显式拒 `@:`。 |
| **P2** | `lib/index.js:21-28,49` | 连接/工作区元数据（host、user、keyPath、container）以明文写入 `~/.dsh/remote-workspace/*.json`（工作区外）。无密码但有 SSH 目标与密钥路径信息。 | 若涉敏可将该目录权限收紧到当前用户；或在文档中声明存储位置。 |

**依赖假设**：本路由安全性不依赖 DSH server 的 listen 地址（即便 0.0.0.0，`trusted()` 仍按回环 remoteAddress 拒绝外网）。该假设成立的前提是 `req.socket.remoteAddress` 可信（无反向代理改写）——单机内核场景成立。

## 3. dsh-hy3-gateway（网关）

状态：✅ 已审计（插件 `lib/index.js` 40 行 + 被拉起的 `hy3-gateway/server.js` 152 行；两者 `node --check` 通过）

**亮点**：
- 监听地址正确：`server.listen(PORT, '127.0.0.1')`（`server.js:150`），**非 0.0.0.0**。
- 输入校验到位：model 白名单（`server.js:10,51`）、messages 必须为非空数组、temperature/top_p/max_tokens 类型检查、请求体 4MB 上限（`:21-31`）。
- 密钥不进日志：`server.js` 与插件 `plugin-spawn.log` 均只记 env/provider/pid，不打印 accessKey。
- 密钥经 env 传给子进程（`lib/index.js:28`），不再二次落盘。

| 严重级 | 位置 | 问题 | 修复建议 |
|--------|------|------|----------|
| **P1** | `hy3-gateway/server.js:35,90,120` | **无鉴权 + CORS 全开**：所有响应（含 OPTIONS 预检，`allow-origin/headers/methods` 全 `*`）允许任意跨源请求。网关无任何 token/Origin 校验——用户浏览的**任意网页**可跨源 POST `http://127.0.0.1:8787/v1/chat/completions`（JSON 触发预检、预检放行），无成本地消耗该用户 CloudBase env 配额、把网关当开放 AI 代理，并可借用户身份发送任意 prompt。DSH 内核以非浏览器方式调用，本不需要 CORS。 | 删除 `Access-Control-Allow-Origin: *`；如需浏览器直连则校验 Origin 为本机；最佳：启动时生成随机 token 注入 DSH 模型配置，网关校验 `Authorization: Bearer <token>`。 |
| **P2** | `hy3-gateway/apikey.local.txt`（795B，明文） | 密钥明文存于工作区目录。已核实根 `.gitignore:98` 忽略整个 `hy3-gateway/`（`git check-ignore` 确认不被跟踪），泄漏面有限，但同机同用户进程/备份同步仍可读。 | 收紧文件 ACL 至仅当前用户；或改用系统凭据管理器。 |
| **P2** | `plugins/dsh-hy3-gateway/lib/index.js:26-35` | 子进程 `detached:true`+`unref()`，未挂 ctx 生命周期清理：桌面应用退出后网关常驻成孤儿进程（靠二次启动 EADDRINUSE 自退，`server.js:142-144`）。 | `ctx.on('dispose')` 记录 pid 并 kill，或文档化常驻设计。 |
| **P2** | `hy3-gateway/server.js:8,150` | 固定端口 8787：合法进程启动前若被本地其他进程抢先 bind，正版会 EADDRINUSE 退出、流量被冒名进程接收（多用户机器上的服务仿冒）。单用户桌面风险低。 | 随机可用端口并把实际端口写入 DSH 模型配置。 |

## 4. dsh-file-explorer（路径穿越）

状态：✅ 已审计（`lib/index.js` 263 行；`node --check` 通过）。**本插件只读**（仅 `list-dir`/`read-file`，无写/删/执行），故"越权写"不适用。

**亮点**：`trusted()`（`:178-200`）回环+Origin+Sec-Fetch-Site 校验，能挡浏览器 CSRF；请求体 64KB 上限；读文件 2MB 上限 + 二进制拒绝 + BOM 剥离；列目录 500 项上限；主目录内路径用 `realpathSync` 前缀校验防 symlink/junction 逃逸（`:206-215`）。

| 严重级 | 位置 | 问题 | 修复建议 |
|--------|------|------|----------|
| **P1** | `lib/index.js:209`（对照 `:10`） | **默认读取范围远超文档与沙箱**：`isPathAllowed` 对任意盘符绝对路径（`C:\`/`D:\`…）直接 `return true`，即默认可读**本机任意盘、任意可读文件**（含其他用户 profile、系统文件），突破了 DSH 其余工具的工作区沙箱，且与文件头注释"所有路径必须落在用户主目录内，越权直接拒绝"（`:10`）自相矛盾。目前仅靠 `trusted()` 兜底（任意网页无法直接触发），但对合法 UI/agent 而言读取面无边界。 | 确认产品意图：若确为"个人机全盘浏览"，应显式声明并改为默认仅主目录/工作区、全盘须 `DSH_FILE_EXPLORER_UNRESTRICTED=1`；同时修正误导性头注释。 |
| **P2** | `lib/index.js:140-144` | `resolve-home` 分支未调用 `isPathAllowed`（不一致）。因不读文件、仅回显拼接路径，实际泄露极小。 | 统一走 `isPathAllowed`。 |
| **P2** | `lib/index.js:145-156` | `session-cwd` 中 `this` 未绑定（`handle` 以普通函数调用），回退取 `args.exec`——调用方可伪造 `exec.agent.session.header.cwd`，使其成为**任意路径存在性探针**（`existsPath` 回显存在与否）。仅泄露存在性、无内容，风险低。 | 移除对 `args.exec` 的信任，或改为绑定真实执行上下文。 |

## 5. dsh-skills-manager（任意写/注入）

状态：✅ 已审计（`lib/index.js` 303 行；`node --check` 通过）。本插件有**写/删**操作，且统一以 `danger-full-access` 沙箱策略执行（`lib/index.js:8`，为写出工作区到 `~/.dsh/skills` 所必需），故路径正确性即安全边界。

**亮点**：
- `create` 强制 skill 名 kebab-case（`/^[a-z0-9]+(-[a-z0-9]+)*$/`，`:149`），从根上杜绝经名称注入 `../`。
- shell 命令对路径参数做单引号 + `'` 转义（`q()`，`:111`），`mkdir/rm` 用 `--` 分隔，防 shell 注入。
- 仅允许 `source === "user-dsh"` 的 skill 被改/删（`:171,188,199`），系统/内置技能只读。
- `delete` 有显式越界防护：目标须以 userRoot 开头且禁 `..` 段（`:202-211`）。
- `buildFile` 对 frontmatter 字段走 `yamlScalar` 转义（`:66-71`），body 置于闭合 `---` 之后，防 frontmatter 注入。
- `trusted()` + 64KB 请求体上限。

| 严重级 | 位置 | 问题 | 修复建议 |
|--------|------|------|----------|
| **P2** | `lib/index.js:206` | `delete` 越界检查用 `startsWith(root)` **字符串前缀**匹配，会同时匹配兄弟目录（如 root=`~/.dsh/skills` 时 `~/.dsh/skills-backup` 也通过），配合 `rm -rf` + full-access 属潜在任意删除。当前因 user-dsh skill 只会落在 root 之下、实际不可达，定 P2。 | 改为 `startsWith(root + '/')`（或 path 包含关系判断）。 |
| **P2** | `lib/index.js:167-194` | `update`/`setEnabled` 直接写 `d.path`（full-access），**缺少** `delete` 那套 root 前缀 + `..` 越界校验，防御不一致。`d.path` 来自 skills 注册表、正常可信，但应纵深设防。 | 对 `d.path` 复用同一 root 包含校验。 |

**说明**：`content` 作为 SKILL.md 正文原样写入、最终注入模型上下文——这是 skill 的固有语义（用户自撰指令），且写入被 `trusted()` 限定为本机同源，非远程可利用向量，不计为缺陷。

## 6. dsh-session-history（隐私落盘）

状态：✅ 已审计（host `lib/index.js` 13 行；client `lib/client.js` 314 行；`node --check` 通过）

**结论：通过，无发现。**
- Host 侧为空壳：`inject=[]`、`apply()` 无操作（`lib/index.js:8-13`），不注册任何路由/工具/文件访问。
- Client 侧为纯 DOM 渲染（消息 mini-map + busy 提示）：从**页面既有 DOM**（`[data-chat-flow-kind="user"]`）读取用户消息文本（截断 200 字符，`client.js:100-102`），仅在同页 hover 气泡展示。
- 已验证：无 `localStorage`/`indexedDB`/`fetch`/`XMLHttpRequest`/`WebSocket`/`eval`/`Function`（grep 全树无匹配）——**本插件不产生任何新的隐私数据落盘，也无任何外发通道**。
- 会话数据本身的落盘位置与文件权限由 DSH 内核管理（`~/.dsh` 等），不属本插件职责范围。

## 7. dsh-web-search-bing（密钥/日志/伪造）

状态：✅ 已审计（`lib/index.js` 191 行；`node --check` 通过）

**密钥/日志结论**：本插件为**无密钥**实现（爬取 Bing HTML 搜索页），因此"API key 存放/进日志"两项不适用——全文件无任何密钥常量、无 `console.log`、无密钥外发。

**亮点**：搜索固定请求 `https://www.bing.com/search`（host 写死，查询参数 `encodeURIComponent`，无注入/伪造面）；内联了与 web-fetch-local 同源的 SSRF 守卫；`bing-fetch` 重定向每跳复查 + 协议白名单 + 5 跳上限。

| 严重级 | 位置 | 问题 | 修复建议 |
|--------|------|------|----------|
| **P1** | `lib/index.js:44,137-138` | **与 W1 同款 DNS rebinding TOCTOU**：`assertPublicUrl` 独立解析后 `fetch()` 二次解析，`bing-fetch` 可被 rebinding 绕过打内网。该守卫是 web-fetch-local 的内联复制，两处须同修且已出现重复代码。 | 同 W1（按解析 IP 直连/建连钩子复检）；并将守卫抽成共享模块防两份副本漂移。 |
| **P2** | `lib/index.js:105,171,174,180` | **"下载完成后才截断"**：搜索响应（`:105`）与 `bing-fetch` 的 html/text 响应均先整读再截到 1MB；`MAX_BYTES` 对搜索页完全不生效。可被大响应耗尽内存。 | 流式读取计字节并提前 abort；预检 content-length。 |
| **P2** | `lib/index.js:5-6,96-103` | 无密钥爬取 = 浏览器 UA 伪装 + 依赖 Bing 页面结构（`parseBing` 正则），脆弱且涉嫌违反服务条款；投产应评估合规与可持续性。 | 评估改用官方 Search API（届时密钥走环境变量/凭据管理器、勿入日志）。 |
| **P2** | `lib/index.js:69-84` | 搜索结果（url/title/snippet）原样注入 agent 上下文——搜索源内容属不可信输入，是所有搜索提供者的通用 prompt-injection 面。 | 在调用侧/系统提示中将搜索结果标注为不可信数据（通用建议）。 |

---

## 投产判定

**判定：有条件通过 —— 修复 4 条 P1 后可投产；无 P0 阻塞项。**

- **必修（P1）**：
  1. W1 + B1（同一根因）：两个 fetch 提供者的 DNS rebinding TOCTOU——改为按首次解析 IP 直连（https 配 `servername`）或在 undici 建连钩子复检真实地址；建议把守卫抽成共享模块。
  2. H1：hy3 网关去掉 CORS `*`、加本机随机 token 鉴权（或至少 Origin 校验）。
  3. F1：file-explorer 默认收敛为主目录/工作区可读，全盘浏览改为 `DSH_FILE_EXPLORER_UNRESTRICTED=1` 显式开启，并修正误导性注释。
- **可放行现状**：
  - **dsh-remote-workspace**：无 P1——argv 化 spawn、目标白名单、密码不落盘、路由有完整本机可信校验，仅 3 条 P2。
  - **dsh-skills-manager**：无 P1——kebab-case 命名 + 引号转义 + 只动 user-dsh 技能，2 条 P2 属纵深防御。
  - **dsh-session-history**：零发现——不落盘、不外发、纯渲染。
- **亮点**：四个带 HTTP 路由的插件统一实现了高质量 `trusted()` 本机校验（回环 + Host + Origin + 端口一致 + Sec-Fetch-Site），可挡浏览器 CSRF/DNS rebinding；多处有请求体/输出流/文件大小上限与超时；hy3 密钥已确认不入 git、不入日志；全部入口 `node --check` 通过。
- **遗留说明**：所有路由安全性假设 `req.socket.remoteAddress` 可信（本机无反向代理改写），桌面单机场景成立；若未来把内核暴露到非回环地址，需重新评估。
