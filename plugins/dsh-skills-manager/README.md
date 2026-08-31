# dsh-skills-manager

DSH 设置页 **Skills 管理器**（宿主级 bundle 插件）：系统/用户技能分类展示，用户技能支持启用开关、编辑、删除、新建；并集成**在线技能市场**（目录源浏览/搜索/校验安装/更新/卸载）。随 DSH 启动自动加载，不依赖会话，重启不失效。

## 功能

- 设置页左侧导航新增 **Skills** 入口（自定义火花星图标）
- **系统 Skills**：只读展示（bundled/runtime/custom 来源），无开关/删除
- **用户 Skills**（`~/.dsh/skills`）：启用开关、编辑、新建、删除
- **市场**：添加目录源（manifest URL）→ 选择 → 浏览/搜索/分类过滤 → 一键安装/更新/卸载；安装时 SHA-256 强校验 + frontmatter 校验 + 同源下载 + 路径白名单 + ctx.fs.writeText 原子落位（临时文件+rename，自动建父目录）；索引 24h 本地缓存，断网可浏览缓存
- 底部诊断行显示扫描层范围

## 市场使用

```
设置页 → Skills → 「市场」Tab
1. 在「添加目录源」粘贴 manifest 的 HTTPS URL
2. 选中该源 → 条目列表自动加载（首次拉取索引并缓存 24h）
3. 点「安装」「更新」「卸载」管理已装 skill
```

目录源契约见 [docs/skill-catalog-contract.md](docs/skill-catalog-contract.md)（v1：manifest + 索引 JSON + 同源下载 + SHA-256）。

## 安装

```bash
# 安装 v0.2.0
dsh plugin --profile web add github:xiaoxianyu-office/dsh-skills-manager#v0.2.0
```

安装后**重启 DSH** 生效。

## 升级

重复 `add` 并指定新 tag，**不要使用 update 选择 Git 引用**：

```bash
dsh plugin --profile web add github:xiaoxianyu-office/dsh-skills-manager#v0.2.0
```

## 卸载

```bash
dsh plugin --profile web remove dsh-skills-manager
```

卸载后重启 DSH：设置页入口、client bundle 路由全部移除，无残留。

## 结构

```
dsh-skills-manager/
├── package.json      # dsh.bundle（组合补丁）+ dsh.client（浏览器双面）声明
├── cordis.patch.yml  # 组合补丁：insert skills-manager 插件行
├── docs/
│   └── skill-catalog-contract.md  # 技能市场契约（v1：manifest/索引/安全/安装边界）
└── lib/
    ├── index.js      # host 端：Skills 管理 API + 市场路由，注册 /skmg
    ├── client.js     # client 端：设置页 UI（成品 bundle，无需构建）
    └── market/
        ├── api.js        # 市场业务 API（sources/list/install/update/uninstall）
        ├── state.js      # 市场状态与缓存读写（随 userRoot 动态定位）
        ├── fetch.js      # 复用宿主 ctx.web 受限 HTTP（SSRF/大小/超时由 provider 负责）
        ├── validate.js   # manifest/索引/frontmatter/SHA-256 严格校验（fail-closed）
        └── install.js    # ctx.fs.writeText 原子落位 + node:fs 删除（跨平台，不依赖 shell 语法）
```

## 说明

- host 端依赖宿主服务：`skills` / `fs` / `shell` / `sandboxPolicy` / `webServer`（市场额外按需使用 `web` 受限 HTTP，缺席时市场功能禁用、本地管理不受影响）
- 写操作使用 `danger-full-access` 策略以管理 `~/.dsh/skills`，写后等待 300ms 让文件 watcher 完成注册表更新
- 安装/更新落位走 `ctx.fs.writeText`（dsh-atomic-write：临时文件+rename，自动建父目录），卸载/删除走 `node:fs.rmSync`——不依赖 shell 语法，跨平台兼容（Windows PowerShell / Git Bash / WSL）
- 市场状态/缓存存于 `<userRoot 上一级>/.skills-market/`（不影响技能扫描）；安装目标为 `<userRoot>/<name>/SKILL.md`
- `/skmg` API 仅接受本机回环请求（源地址 + Host 头双重校验），不要将该端口暴露到局域网/公网
- client bundle 为手写 `__ModuleLoader__` 成品，无 prepare 脚本，不受 pnpm `allowBuilds` 限制
