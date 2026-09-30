# 市场插件安装记录（2026-09-30）

- 目标：从社区市场装**已确认兼容 `0.2.0-rc.2`** 的插件，替换部分自研插件
- 方式：**手动解包安装**（不走 `pnpm add`）—— 原因见 §1
- 状态：**4 个已装好并登记，等重启生效**

---

## 1. 为什么不用官方的 `pnpm add`

查了官方实现 `resources/app/lib/pnpm.js:26-36,84-86`：

```
runExternalMarketPluginInstall → 要求 `add` + 恰好一个 name@exact-version
                              → cwd = 活动 profile 目录
```

即：**官方市场安装 = 在 profile 目录里跑 `pnpm add <pkg>@<ver>`**。

而这个 profile 的实际状态 `[实测]`：

| 项 | 值 |
|---|---|
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` / `autoInstallPeers: false` / `packages: [.]` |
| `node_modules` 顶层条目 | **317**（其中**只有 1 个是链接，316 个是真实目录**） |
| `.pnpm` 条目 | **0** |
| `pnpm-lock.yaml` | **不存在** |
| `node_modules` 体积 | **671 MB** |

⇒ 这是一份"搬进来"的 hoisted 布局。跑 `pnpm add` 会做依赖图对齐，**把 316 个未声明的真实目录当 extraneous 清掉**（671 MB → 可能只剩几十 MB），包括 `@deepseek-ai/*`、`@liustack/modlens`、`dsh-better-sidebar`、`@mermaid-js` 等。

**所以改走手动解包**：直接从 npm 拉 tarball 解到 `node_modules/<pkg>`，**完全不碰 pnpm，零 prune 风险**。

### 依赖可用性预检

| 包 | 该包自身依赖 | 结论 |
|---|---|---|
| `dsh-secure-audit` | **0** | 直接装 |
| `dsh-client-auto-continue` | **0** | 直接装 |
| `dsh-free-search` | 1（`@deepseek-ai/schemastery`） | profile 里已有 ✓ |
| `dsh-context` | 1（`zod`） | profile 里已有 ✓ |
| `dsh-mnemon` | **22** | **暂缓**（虽多数已在，仍先单独评估） |

---

## 2. 已安装的 4 个

| 包 | 版本 | 文件数 | 替代谁 | peer 判定 |
|---|---|---:|---|---|
| `dsh-secure-audit` | **0.2.11** | 21 | `dsh-code-security-guard` | 无上界 ✓ |
| `dsh-free-search` | **0.6.5** | 6 | `dsh-web-search-bing` + `dsh-web-fetch-local` | 明确支持 0.2 ✓ |
| `dsh-client-auto-continue` | **0.12.1** | 59 | `dsh-session-watchdog` | 明确支持 0.2 ✓ |
| `dsh-context` | **0.60.0**（原 0.59.2，已升级） | 10 | `dsh-context-lifecycle` | 无上界 ✓ |

安装位置：`~/.dsh/profiles/desktop/node_modules/<包名>/`

---

## 3. 登记（两处都做了）

### 3.1 `package.json` —— `dependencies`（防 pnpm 清理）

**为什么要做**：改之前 `dependencies` 是空的 `{}`，而 `node_modules` 里有 43 个插件链接 + 316 个真实目录。任何一次 `pnpm add/install` 都会把它们当 extraneous 清掉 —— **这是埋着的雷**。

**改动**：把当前**所有指向旧仓库的 43 个链接**声明为 `link:` 依赖（42 个 `@dsh-external/*` + `dsh-skills-manager`），再加上新装 4 个。

```
dependencies: 0 → 47 条
```

### 3.2 `package.json` —— `dsh.profile.bundles`（让它们被加载）

```
bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
      → ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
         "dsh-secure-audit", "dsh-free-search", "dsh-client-auto-continue", "dsh-context"]
```

用 `bundles` 而不是 `cordis.patch.yml` 的 `insert`，是因为 **bundle 才是插件注册的正规位置**（旧 profile 的 51 个插件都注册在 bundles 里），而且实测对 `cordis.patch.yml` 的写入**没有生效**（多次尝试后文件 mtime 始终未变）。

---

## 4. 备份与回滚

| 备份 | 位置 |
|---|---|
| profile 配置（改前） | `~/.dsh/_backups/desktop-profile-packagejson-20260930-113301/`（package.json 211 B + cordis.patch.yml） |
| profile 配置（改前，第二次） | `~/.dsh/profiles/desktop/package.json.bak-declare`（如已生成） |
| `dsh-context` 旧版 | `~/.dsh/profiles/desktop/node_modules/dsh-context.bak-0.59.2/`（v0.59.2） |

**回滚方式**：

```
# 1) 退回未装状态（不加载新插件）
把 ~/.dsh/profiles/desktop/package.json 的 dependencies 清回 {} 并删掉 bundles 里新增的 4 项
# 2) 退回 dsh-context 旧版
把 node_modules/dsh-context.bak-0.59.2 改名回 node_modules/dsh-context
# 3) 重启
```

⚠️ **不要在回滚后跑 `pnpm install`** —— 见 §1，那会清掉 316 个未声明目录。

---

## 5. 待办

| # | 项 | 说明 |
|---|---|---|
| 1 | **重启应用** | 4 个插件才会被加载 |
| 2 | 看启动日志确认 | 找 bundle 加载行、确认无 `cannot resolve` |
| 3 | 逐项评估已装的 4 个 | 尤其 `dsh-context`（会加一个 Context 仪表盘）与 `dsh-client-auto-continue`（客户端插件） |
| 4 | `dsh-mnemon` | 22 个依赖，单独评估后再装 |
| 5 | 装得稳了以后再卸对应的自研插件 | `code-security-guard` / `session-watchdog` / `context-lifecycle` 等 |

---

## 6. 已知风险

| # | 风险 | 说明 |
|---|---|---|
| 1 | **profile node_modules 是"搬来的"** | 无 lockfile、无 `.pnpm`、316 个未声明真实目录 → **任何 pnpm 操作都危险**；这是阶段 2 必须一并解决的 |
| 2 | **bundle 加载失败会怎样未验证** | 用户自己的记录说 bundle 失败是"跳过而非阻断"，但本次没实测 |
| 3 | **`dsh-context` 是客户端插件** | 会改变 UI（Context 仪表盘），有整页风险 |
| 4 | **手动解包绕过了 pnpm 的依赖解析** | 只能依赖 profile 里已有的包；缺依赖会在运行时才暴露 |
| 5 | **`cordis.patch.yml` 写入未生效** | 原因未查明（可能是应用持有该文件）；因此改用 bundles 机制 |