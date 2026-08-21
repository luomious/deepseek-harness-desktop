# dsh-remote-workspace

DSH 远程连接工作区插件：让 **SSH 远程主机 / WSL 子系统 / Docker 容器** 成为一等公民的
独立工作区（参考 ZCode「远程连接」交互设计）。

## 功能

- **连接管理**：SSH / WSL / Docker 三种连接方式的保存、测试、删除
  （入口：工作区选择流程的「添加工作区…」菜单 → 「远程连接」，弹出面板即连接管理）
- **连接配置 UI**（复刻 ZCode 交互）：
  - 连接方式选择（SSH 远程主机 / WSL Windows Linux 子系统 / Docker 本地容器）
  - SSH 配置表单：配置别名（可选）/ 主机 / 端口 / 用户名 / 认证方式（密码或私钥）/
    密码 / 资源下载方式（本地下载后上传 / 远端服务器下载）
  - WSL 配置：发行版（可选，留空用默认）/ Linux 用户（可选）
  - Docker 配置：容器名 / ID（可下拉选择运行中容器）
- **远程目录浏览**：列出远端目录（WSL 走 `\\wsl$` UNC 直读；SSH/Docker 走远端 `ls`），
  点击目录进入、勾选目录作为工作区根
- **远程工作区**：创建后写入旁路注册表
  （`~/.dsh/remote-workspace/workspaces.json`），并同步注册到 DSH 原生工作区
  （`workspaceRegistry.create`，幂等）——注册成功后**直接出现在「添加工作区」上方的
  本地工作区列表里**，点击即可像普通工作区一样开始新对话；远程面板里也有「新对话」按钮
- **remote_bash 工具**：模型在远程工作区的会话里执行命令时，`remote_bash` 自动识别
  会话 cwd（WSL UNC 或锚目录）并翻译成 `wsl.exe` / `ssh` / `docker exec` 命令执行

## 架构

```
client（remoteFlow 洞：conversation.hero.workspace.remoteFlow / sidebar.workspaces.remoteFlow）
  │  fetch POST /remote-ws/api {method, args}
  ▼
host（ctx.webServer 注册 /remote-ws 前缀路由）
  │  本机 trusted 校验 → handle(method, args)
  ▼
连接持久化 ~/.dsh/remote-workspace/connections.json
远程执行 spawn(wsl.exe / ssh / docker)
远程工作区 ~/.dsh/remote-workspace/workspaces.json + 原生 workspaceRegistry.create(cwd, title)
remote_bash 工具：会话 cwd 反查远程 URI → remoteArgv 翻译执行
```

### 会话 cwd 约定

| 连接类型 | 会话 cwd | 说明 |
|---|---|---|
| WSL | `\\wsl$\<distro>\<path>` | UNC 绝对路径，可被 DSH realpath / fs 工具直接访问 |
| SSH / Docker | `~/.dsh/remote-workspace/anchors/<...>` | 本地锚目录（目录名由 URI 消毒生成，仅保留 `[A-Za-z0-9_.-]`），remote_bash 反查连接 |

### 原生注册与迁移

- `workspaceRegistry.create(cwd, title)` 幂等：同一 canonical 路径返回既有实体；
  WSL 需发行版可访问（`\\wsl$` realpath 通过），SSH/Docker 需锚目录已建成（自动 mkdir）。
- 旧版锚目录名含 Windows 非法字符（`:` `/` 等）导致从未建成——新版本在 `list` / `open` /
  `create-workspace` 时自动用新规则重建 cwd 并回填 `nativeId`（`~/.dsh/remote-workspace/workspaces.json`）。

## 开发

```bash
# host：编译 src/index.ts → lib/index.js（仅 host，不含 client 类型错误）
npx tsc -p tsconfig.host.json

# client：打包 src/client/index.ts → lib/client.js
npm run build:client

# 核心逻辑验证
node scripts/verify-core.mjs
```

## 已知限制（P0 验证结论）

- 本机若无 WSL 发行版 / SSH 服务器 / Docker，连接测试会如实报错（API 链路正常）
- SSH 密码认证在非交互环境需要私钥或 sshpass（当前实现直接调 ssh，密码仅存储未注入）
- 远程 fs 读取（read 工具直接读远端文件）尚未实现——P1 用 sftp 翻译或 WSL UNC 直读
