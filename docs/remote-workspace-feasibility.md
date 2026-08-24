# DSH 工作区「远程连接」功能可行性分析与实现方法

> 目标：参考 ZCode 的「选择工作空间 → 远程连接（SSH / WSL / Docker）」交互，为 DSH 的
> 工作区选择增加远程连接能力，让 SSH 远程主机 / WSL 子系统 / Docker 容器成为一等公民的
> 独立工作区。
>
> 本文基于对当前 DSH 源码（`~/.dsh/profiles/node_modules/@deepseek-ai/*`）的架构勘察。
> 分析日期：2026-08-17。

---

## 一、结论速览（TL;DR）

| 远程方式 | 可行性 | 难度 | 主要工作 |
|---|---|---|---|
| **WSL**（Windows 子系统） | ✅ 高 | ★★★☆☆ | 中等 —— 复用现有 shell/fs 层，加一个 wsl 执行后端 + 目录浏览 |
| **SSH 远程主机** | ✅ 高 | ★★★★☆ | 较大 —— 需要远程执行 + 远程 fs（或挂载）+ 凭据管理 |
| **Docker 容器** | ✅ 中高 | ★★★★☆ | 较大 —— 类似 SSH，执行走 `docker exec`，fs 走挂载/`docker cp` |

核心判断：**DSH 的插件化架构（Cordis Service 接缝）完全支持以「自定义插件」方式注入远程
能力，无需 fork 上游、无需改写 dsh-workspace 核心**。但「远程工作区」不是纯 UI 工作，
它必须同时改造 **工作区模型**、**shell/fs 执行层**、**目录选择流程** 三个层面，其中执行层
是工作量的大头。

DSH 官方设计里有一个关键假设：**工作区 = 本地目录路径**。远程化是对这个假设的扩展，而非
推翻——路径字符串从 `C:\Users\...` 变成 `wsl://Ubuntu/home/user/proj` 或
`ssh://user@host:22/home/user/proj`，由新增的远程执行后端解析。

---

## 二、DSH 现状：工作区选择架构勘察

### 2.1 工作区数据模型（`@deepseek-ai/dsh-workspace`）

```typescript
// workspaceRecord（dsh-workspace/lib/index.js）
{
  path: string,        // fs.realpath 规范化后的【本地绝对路径】
  title: string,
  sessionIds: string[],
  createdAt: string,
  updatedAt: string
}
```

- 工作区**唯一性判据是本地规范路径**：`realpath(path)` 字符串相等（同目录只允许注册一次）。
- 会话与工作区的**归属校验**：`realpath(session.header.cwd) === record.path`，且对本地
  `stat()` 判定 `isDirectory()`。
- `WorkspaceEntity.status()` 用本地 `stat` 判定 `ok` / `missing-dir`。

**约束 1：** 路径必须是**本地存在、可 realpath、可 stat 的目录**。远程路径
（`wsl://…`、`ssh://…`）在现有逻辑下会直接 ENOENT 失败。

### 2.2 会话 cwd 是执行锚点（`@deepseek-ai/dsh-tool-bash`）

```typescript
// resolveWorkdir：bash 工具的 workdir 解析
const headerCwd = exec.agent?.session.header.cwd;   // 会话 cwd
const sessionCwd = policyWorkspaceRoot ?? canonicalPath(headerCwd);
```

bash 每次执行时，workdir 默认取**会话的 cwd**。所以：
- 本地工作区的会话 cwd = 本地路径 → 本地 bash 直接 `cd` 进去执行。
- **远程工作区的会话 cwd = 远程路径标识** → 需要远程 shell 后端把它翻译成
  `ssh user@host "cd /remote/path && bash -c …"` 或 `wsl -d distro -- bash -c …`。

**约束 2：** 执行层必须能理解远程 cwd 并把它映射为远端实际目录。

### 2.3 shell 执行接缝（`@deepseek-ai/dsh-shell`）

DSH 的 shell 是一等接缝，源码注释明确写了扩展方式：

```typescript
// dsh-shell/lib/index.js
/**
 * Abstract bash execution service. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as ctx.shell (one
 * implementation per context; loading a second throws).
 */
var ShellExecutor = class extends Service {
  constructor(ctx) { super(ctx, "shell"); }
  get sandboxMode() {}
};
```

- 现有实现：`LocalBashExecutor`（`dsh-bash-local`）→ `bash -c` 经 `ctx.subprocess` 本地执行。
- 沙箱链：`dsh-bash-sandbox` 包裹执行器（当前标记 `[disabled]`，未挂）。
- **关键点：一台 DSH 里只有 ONE 个 `ctx.shell` 实现，且是全局的，不区分工作区。**

**约束 3：** 要做到「A 工作区跑本地、B 工作区跑 SSH」，不能简单注册第二个 shell 执行器
（会 duplicate service 冲突）。**需要把「按 cwd 路由」打进执行器内部**：
  - 方案 A：写一个 `RoutingShellExecutor` 替换 `ctx.shell`，按 cwd 前缀（`wsl://`、`ssh://`、
    `docker://`、无前缀=本地）分派给本地或远程执行器。
  - 方案 B（更轻）：不替换 ctx.shell，而是**加工具层** —— 用 `ctx.tools` 注册 `remote_bash`、
    `remote_fs` 等专用工具，模型在远程工作区里被系统提示引导优先用远程工具。

### 2.4 文件系统接缝（`@deepseek-ai/dsh-fs` / `dsh-fs-local`）

- `FileSystem` 是另一个抽象 Service（`ctx.fs`），`dsh-fs-local` 用 Node stdlib 实现本地后端，
  target key 是 realpath。
- fs 工具（`dsh-tool-fs`、`dsh-tool-fs-search`）都消费 `ctx.fs`，路径全按本地处理。

**约束 4：** 远程工作区的文件读写也需要远程后端。三种实现路线：
  1. **协议翻译**：实现一个 `RemoteFileSystem extends FileSystem`，把 read/write/search
     翻译成 `ssh cat / sftp get/put`（最通用，但慢，且 search 不好做）。
  2. **FUSE/挂载**（仅限本机 WSL/Docker 场景）：WSL 路径天然可以通过 `\\wsl$\` 或
     `\\wsl.localhost\` UNC 访问；Docker 容器镜像卷/绑定目录也能落到本地路径。SSH 没有。
  3. **混合**：WSL/Docker 走「本地可访问路径前缀映射」（性能好），SSH 走 sftp 翻译。

### 2.5 目录选择流程（`dsh-host-directory-picker-*` + `dsh-client-ui-workspace`）

- 现有目录选择器是 **host 端浏览/原生对话框**两条后端（`browse` 用 Node opendir 列目录，
  `native` 走 Windows COM 对话框，当前 auto 选用了哪条由探测决定）。
- client 端组件：`dsh-client-ui-workspace` 的 `WorkspacePickFlow`，空态 hero（
  `dsh-client-ui-conversation` 的 `EmptyHero` + `WorkspaceChip` + `onRequestWorkspace`）就是
  「选择工作区」入口，与 ZCode 首页的「选择项目」位置相同。
- `createWorkspace({ path })` → host `WorkspaceRegistry.create(path, title)`。

**约束 5：** 远程目录浏览需要新增一个「远程 browse」后端（ssh 列目录 / wsl 列目录 /
docker exec ls），并新增「远程连接配置」UI（连接类型 → 表单 → 测试连接），再走
`createWorkspace` 写入**远程路径字符串**。

---

## 三、ZCode 的做法（参考基准）

ZCode 的「远程开发」把三种连接方式各配置为一个独立工作区（社区评价其为微创新点，见
[Libukai 的推文](https://x.com/libukai/status/2068258895253159961)）：

| 方式 | 目标 | 配置项 | 要点 |
|---|---|---|---|
| **SSH** | 远程主机 | 别名（可选，自动填充）/ 主机 / 端口 / 用户名 / 密码或私钥 / 资源下载方式 | 密码或私钥二选一；资源下载「本地下载后上传」vs「远端服务器下载」（省上传等待，但远端需能访问 CDN） |
| **WSL** | 本机 Linux 子系统 | 发行版（可空=默认）、Linux 用户（可空=默认） | 仅 Windows 桌面端可用；慎用 root |
| **Docker** | 本机运行容器 | 从运行中容器列表选择，或手动填容器名/ID | — |

ZCode 的做法本质是：**「连接配置」先行，工作区 = 连接 + 远端目录**。连接保存后可复用，
切换工作区即切换远程目标。参考：[ZCode 远程能力解析](https://www.cnblogs.com/youring2/p/22381155)、
[Zed 远程开发做法（ssh_connections 配置 + 远端 server）](https://zed.dev/docs/remote-development)、
[VS Code Remote 三件套](https://learn.microsoft.com/zh-cn/shows/tabs-vs-spaces/vs-code-remote-development-with-ssh-vms-and-wsl)。

对 DSH 的启示：**连接配置与工作区分离** —— 先建「连接」（ssh/wsl/docker 描述体），
工作区引用「连接 + 远端路径」。DSH 已有 `dsh-credentials-local`（凭据存储），
可存 SSH 密码/私钥路径。

---

## 四、可行性逐层分析

### 4.1 WSL —— 最可行（推荐先做）

- **执行**：WSL 是本地进程，`wsl.exe -d <distro> --user <user> -- bash -c <cmd>`
  就是本地「另一种 shell」，可直接在 `ctx.subprocess` 上实现一个
  `WslBashExecutor extends ShellExecutor`，甚至比 LocalBashExecutor 还简单。
- **cwd**：`wsl.exe -d <distro> --cd <remote-path> -- bash -c …`（`--cd` 支持远端路径），
  或执行 `cd <path> && …`。
- **fs**：WSL 目录可用 `\\wsl$\<distro>\<path>`（UNC）从 Windows 侧直接访问，
  现有 `dsh-fs-local` **几乎可以直接用**，只需把 `wsl://<distro>/<path>` 翻译成 UNC。
- **目录浏览**：`wsl.exe -d <distro> -- ls -la <path>` 即可，做一个 browse 后端很容易。
- **列表**：`wsl -l -q` 列出发行版（Docker 列表类似 `docker ps --format`）。
- 额外红利：**不需要新增任何 npm 依赖**，全走子进程。

> 备注：D:\Deepseek-Harness 会话里出现过 `shell` 工具在 WSL 后端下执行（系统说明里
> Shell/Pwsh/WSL 三后端），说明本机已具备 wsl 环境基础。

### 4.2 SSH —— 可行（工作量最大）

- **执行**：`ssh -p <port> <user>@<host> "bash -c '<cmd>'"` 或维持一条 `ssh` 长连接
  （ControlMaster）复用。需要把 `LocalBashExecutor` 的 spawn 参数改造成 ssh argv，
  其余（timeout、输出收集、后台进程）机制可完全复用。
- **交互密码**：非交互环境下密码需要 `sshpass`（Linux）或 Windows 上 `plink -pw`；
  更稳妥的是**私钥认证**，凭据存 `dsh-credentials-local`；或引 ssh-agent。
- **fs**：SSH 无挂载捷径，需 sftp 翻译（`sftp get/put` 或 `ssh cat >`）。一个 read/write
  往返一次连接，性能一般但可用（ZCode 的「资源下载方式」也是这个思路）。文件搜索
  （`tool-fs-search`）可退化为 `ssh grep/rg`，或接受远程工作区里搜索能力降级。
- **目录浏览**：ssh `ls` 列目录，做一个远程 browse 后端即可。
- **会话保持**：DSH 的 session 是本地持久化的（会话记录不随远程工作区迁移），远程工作区
  只是「换一个执行后端 + cwd」，会话逻辑天然兼容 —— 这是 DSH 优于 IDE 的点。

### 4.3 Docker —— 可行（依赖本地 docker CLI）

- **执行**：`docker exec -i <container> bash -c <cmd>`；`docker exec` 支持 `-w <workdir>`。
- **fs**：与 SSH 同思路——`docker exec` 内 `cat`/`cp`；如果工作区目录已在容器启动时
  bind-mount 到本地，则可直读本地路径（更快）。
- **列表**：`docker ps --format '{{.ID}} {{.Names}} {{.Image}}'`。
- **依赖**：需要本机有 docker CLI 且 daemon 在跑。

### 4.4 跨层影响清单（无论哪种远程方式）

| 层 | 改动 | 是否必须 |
|---|---|---|
| 工作区模型 `dsh-workspace` | 允许非本地 path（`wsl://`/`ssh://`/`docker://`），跳过 realpath/stat 校验 | ✅ 必须（或注入旁路） |
| shell 执行 `dsh-shell` | 新增路由执行器或远程工具 | ✅ 必须 |
| fs 后端 `dsh-fs` | 新增远程 fs 后端 | ✅ 必须（否则只能 bash，不能读文件/搜索） |
| 目录选择 | 远程 browse 后端 + 远程连接配置 UI | ✅ 必须（否则无法选远程目录） |
| 会话 cwd 校验 | 远程 cwd 的归属校验旁路 | ✅ 必须 |
| 凭据 | SSH 密码/私钥存 `dsh-credentials-local` | :white_check_mark: SSH 必须 |
| sandbox/fs-observation-policy | 远程路径的沙箱规则（权限模型） | ⚠️ 涉及安全，需设计 |
| 终端（`dsh-terminal`） | 远程交互终端（可选增强） | 🟡 非必须（先做工具层） |

---

## 五、实现方法（两种路线）

### 路线 A：插件方案（推荐，符合 DSH「一切皆插件」）

不 fork、不 patch 核心包，做一个 **bundle 插件** `dsh-remote-workspace`
（用 dsh-super-injector 热注入，宿主环境已装好，无需重启）：

```
dsh-remote-workspace/
├── src/
│   ├── index.ts                  # host 侧：注册远程shell/fs/目录浏览/连接管理
│   ├── remote/
│   │   ├── executor-wsl.ts       # WslBashExecutor extends ShellExecutor
│   │   ├── executor-ssh.ts       # SshBashExecutor extends ShellExecutor
│   │   ├── executor-docker.ts    # DockerBashExecutor extends ShellExecutor
│   │   ├── routing.ts            # RoutingShellExecutor：按 cwd 前缀路由
│   │   ├── fs-remote.ts          # RemoteFileSystem extends FileSystem（sftp/exec 翻译）
│   │   └── connections.ts        # 连接配置（存 dsh-credentials-local / settings）
│   └── client/
│       └── index.ts              # client 侧：远程连接配置表单 + 远程浏览 UI
├── package.json                  # dsh.bundle + dsh.client 声明
└── cordis.patch.yml              # insert 装载
```

关键实现点：

1. **连接配置模型**（client 表单 → host 存储）：
   ```ts
   type RemoteConnection =
     | { kind: 'wsl';    distro?: string; user?: string }
     | { kind: 'ssh';    host: string; port: number; user: string; auth: 'password'|'key'; secretRef: string }
     | { kind: 'docker'; container: string }
   ```
2. **路由执行器**（替换 ctx.shell，或在工具层新增远程工具）：
   ```ts
   class RoutingShellExecutor extends ShellExecutor {
     async run(spec) {
       const target = parseRemote(cwdOf(spec));   // 解析 wsl:// ssh:// docker://
       if (!target) return this.local.run(spec);  // 本地照旧
       return this.for(target).run(translateToRemote(spec, target));
     }
   }
   ```
   > 若不愿动 ctx.shell（避免与 bash-sandbox 链冲突），可退化为**新增 `remote_bash`
   > 工具** + 系统提示（远程工作区的会话注入「当前为远程环境，请使用 remote_bash /
   > remote_fs」），代价是模型要切换工具名，体验稍差但零侵入。
3. **远程 fs**：`RemoteFileSystem` 把 target key 映射为 `ssh user@host "cat <path>"` /
   `wsl -d distro -- cat <path>` / `docker exec <c> cat <path>`。
4. **远程目录浏览**：注册到 `ctx.directoryPicker` 上新增一个 `remote-browse` capability，
   client 复用 `BrowseDirectoryFlow` 的对话框骨架，列表数据源换成远程 `ls`。
5. **工作区创建旁路**：`createWorkspace({ path: 'wsl://Ubuntu/home/x/proj' })` —— 但
   `WorkspaceRegistry.create` 会 realpath 失败。做法：
   - 不动核心，改在 **host 侧为远程路径预先解析为一个虚拟本地锚**？不行，remote 路径没有本地等价物。
   - **更干净**：工作区注册走一个旁路 —— 插件注册**同名 service 之前拦截**？重。
   - **实际最简**：远程工作区不进 `dsh-workspace` 注册表（会话记账仅存 session.cwd），
     远程工作区=「一组 session + 共享 cwd 前缀」，由插件自己持久化清单；或者复制一份
     workspace 域表（`remote-workspaces`）由插件管理。**推荐后者**：不动核心注册表，
     在侧边栏/选择器通过 sl等机制把远程工作区并进去显示。

   > 权衡：改核心 `dsh-workspace`（加一个 `remote?: RemoteRef` 字段，path 校验分支跳过）
   > 只差十几行，但会与上游升级冲突。插件路线用「旁路注册表」最平稳。

6. **安全**：远程执行 = 高权限操作，建议远程命令同样过 `ctx.permission` / 审批流，
   并将远程会话的系统提示标记「远程环境」。

### 路线 B：上游 PR（长期方案）

向 `deepseek-ai/deepseek-harness` 提扩展：给 `WorkspaceRecord` 增加 `kind` / `RemoteRef`，
把 shell/fs 抽象下沉为「按 kind 路由」，官方实现 WSL（门槛低、跨平台价值高）。可行但周期长，
适合作为路线 A 跑通后的上游贡献。

---

## 六、分阶段实施计划（建议）

| 阶段 | 内容 | 交付物 | 预估 |
|---|---|---|---|
| **P0 原型** | WSL 工作区端到端：路由执行器（wsl）+ UNC fs 复用 + 远程浏览 + 旁路注册表 | WSL 工作区可选、可建会话、bash/fs 工作在远端 | 1~2 天 |
| **P1 完善** | 连接配置 UI（表单/测试连接/凭据）、远程工作区在侧边栏与 hero 中展示、系统提示标记 | 完整 WSL 体验 + SSH 基础执行 | 2~3 天 |
| **P2 扩展** | SSH fs/sftp 翻译、Docker 支持、远程搜索降级策略、终端增强 | SSH/Docker 工作区 | 3~5 天 |
| **P3 加固** | 审批流、凭据加密、沙箱策略、断线重连、上游 PR | 生产可用 | 按需 |

> P0 每一步都在本仓库 `plugins/dsh-remote-workspace/` 下做，用
> `dev_scaffold_plugin`（hybrid 形态）→ `dev_build_plugin` → `dev_inject_plugin` 即可热装，
> 与现有 super-injector 工作流完全一致（问题中「dsh-super-injector」上下文就是推荐这条线）。

---

## 七、风险与注意点

1. **duplicate service 冲突**：`ctx.shell` / `ctx.fs` 只能注册一个实现 —— 路由执行器是
   唯一入口，「按 cwd 前缀分派」必须在单实现内完成，不要在插件里再注册第二个 shell。
2. **bash-sandbox 链**：如果未来启用 `dsh-bash-sandbox`，路由执行器要与沙箱链兼容
   （沙箱包裹执行器，远程命令同样走审批）。
3. **远程 cwd 的 realpath 校验**：`WorkspaceRegistry.attachSession` 会 realpath 会话 cwd，
   远程 cwd 会判定失败 → 走旁路注册表时不调用核心 attach，或对核心做最小 patch（
   判断 `wsl://` 等前缀就跳过）。升级 DSH 后需重新打补丁（与 `patch-dsh-native-picker.js`
   同样的维护模式）。
4. **非交互密码**：SSH 密码认证在无 TTY 环境需要 sshpass/plink，建议首推私钥 + ssh-agent，
   密码仅存凭据库并在连接时注入（host 侧可控，不落日志）。
5. **性能**：sftp 单文件往返慢，文件多时建议先 `tar` 批量；搜索可降级为远端 `rg`。
6. **Windows 专属**：WSL 功能仅 Windows 桌面端（与 ZCode 一致）；服务器场景以 SSH 为主。

---

## 八、参考来源

- [ZCode 远程能力全解析（博客园）](https://www.cnblogs.com/youring2/p/22381155)
- [ZCode 把 SSH/Docker 配置为独立工作区（X/Libukai）](https://x.com/libukai/status/2068258895253159961)
- [Zed Remote Development（SSH 连接配置模式）](https://zed.dev/docs/remote-development)
- [VS Code Remote 开发（SSH/WSL/容器）](https://learn.microsoft.com/zh-cn/shows/tabs-vs-spaces/vs-code-remote-development-with-ssh-vms-and-wsl)
- DSH 源码（本机 `~/.dsh/profiles/node_modules/@deepseek-ai/`）：
  - `dsh-workspace`（工作区记录模型 / realpath 校验）
  - `dsh-shell`（ShellExecutor 扩展接缝）
  - `dsh-bash-local`（本地执行器参考实现）
  - `dsh-tool-bash`（cwd→workdir 解析链）
  - `dsh-host-directory-picker-browse`（浏览目录后端参考）
  - `dsh-client-ui-workspace` / `dsh-client-ui-conversation`（选择工作区 UI）