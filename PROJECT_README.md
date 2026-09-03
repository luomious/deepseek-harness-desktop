# DeepSeek Harness 桌面版 Agent 项目（项目说明）

> 项目定位：DSH 桌面封装 + 自研插件生态 + 单机运维体系（Windows）。
> 上手请先读 [README.md](README.md)（架构与使用）与 [docs/BUILD.md](docs/BUILD.md)（构建）；
> 投产方案与状态见 [docs/PRODUCTION-EXECUTION-PLAN.md](docs/PRODUCTION-EXECUTION-PLAN.md)。

## 仓库组成

| 目录 | 内容 |
|---|---|
| `plugins/` | 28 个自研 bundle/插件（模型/视觉/路由/工具/守护；含 1 个未装配 no-op 的 model-provider-failover） |
| `scripts/` | 构建-发布-运维脚本（package-vendor / promote-build / smoke-test / verify-patches / install-desktop 等） |
| `profile/desktop/` | 装机模板（与运行时 desktop profile 同步：42 deps / 35 bundles，含 dsh-mcp-lens tgz） |
| `patches/bundles/` | 补丁 canon 权威副本（`port-user-patches.mjs` 重建后自动重打） |
| `patches/reference/` | 旧壳补丁清单参考（只读） |
| `legacy/` | 旧壳归档（含指向已删除 src/ 的死测试，`legacy/tests/`） |
| `vendor/` | 桌面壳独立仓（不入库；基线见 `docs/VENDOR-BASELINE.md`） |
| `docs/` | 审计/方案/构建/排障文档 |

## 常用命令

| 命令 | 说明 |
|---|---|
| `scripts\package-vendor.ps1` | 打包到 `dist\win-unpacked-build<N>` + 自动重打补丁 |
| `scripts\promote-build.ps1 -From dist\win-unpacked-build<N>` | 停应用后换 junction 入口（内置 smoke + 回滚） |
| `scripts\smoke-test.ps1` | 全量验收（静态 + 运行时） |
| `scripts\verify-patches.ps1` | 补丁在位校验（ALL PASS 才放行） |
| `scripts\close-stale-dsh.ps1` | 清僵尸实例（保留持端口实例） |
| `node --check plugins\<name>\lib\*.js` | 插件语法校验 |

## 协作守则（务必遵守）

1. **代码改动后不得自动重启桌面应用**——等用户明确指示（"重启/生效/测试"）。
2. **严禁对 `@liustack/modlens` 执行热重载**（丢 adapter 注册、会话卡死）；modlens 改动必须全量重启。
3. **PowerShell 脚本注释一律纯 ASCII**（PS 5.1 把 UTF-8 无 BOM 读成 GBK 会语法错）。
4. **删除/强制类命令先过 `scripts/guard-destructive.ps1` 预检**；目标必须在工作区内或经用户同意。
5. **重建后必跑** `verify-patches.ps1`（package-vendor 已自动串联）；失败即停，不裸奔。
6. 改全局 node_modules 的补丁必须登记进 `patches/` 与 port-user-patches，否则 `npm i -g` 升级即丢。

## 版本基线速查

- 壳：`vendor` 分支 `prod-baseline-20260823`（HEAD e247cc1，备份仓 `luomious/dsh-plugin-desktop`）
- 内核：`@deepseek-ai/dsh@0.1.1-rc.2`（全部精确锁版）；上游 submodule `b150a551`
- 端口：43120（`desktop-port.ts` 内嵌默认；`/desktop/*` 路由仅 loopback）