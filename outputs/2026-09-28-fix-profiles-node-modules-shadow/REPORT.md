# 调查与处置：`profiles/node_modules` 把 0.1.1 包树影射进 0.1.7 运行时

> 日期：2026-09-28 ｜ 类型：root-cause + junction repoint
> 关联：`outputs/2026-09-27-incident-0.1.7-startup-crash/`、U6 settings 迁移、`Failed to load plugins` / `reading 'start'`

---

## 1. 现象

- promote `win-unpacked-build202609272329`（内核 0.1.7-rc.2）后，HARNESS 一直停在：
  `Failed to load plugins` + `Cannot read properties of undefined (reading 'start')`
- 任务栏一度出现 5 个 DSH Desktop 残影（多实例/失败窗口）
- 在 desktop profile 补回 `client-runtime` 后 **12:02 启动仍失败**（证明只补图行不够）

---

## 2. 调查结论（逐条实测）

### 2.1 Bundle 解析（installAnchor 路径）本来是对的

`desktopInstallAnchor()` = `…/dsh-plugin-desktop/package.json`（**文件**锚点）。
`resolveBundleDir` 先 installAnchor，后 profile。

| 锚点形态 | `@deepseek-ai/dsh-web-app` 解析结果 |
|---|---|
| `package.json` 文件（运行时真实形态） | **0.1.7-rc.2**（vendor / packaged） |
| 目录路径（误测形态） | 0.1.1-rc.2（`profiles/node_modules`） |

> 教训：`createRequire(目录)` 把目录当文件名，会**跳过该目录自己的 node_modules**。第一次 dump 误判由此产生。

### 2.2 真正的影射：社区插件的 `require`

`~/.dsh/profiles/node_modules` 是一座 **junction 农场**，全部指向旧 build：

```
C:\Users\机械革命\.dsh\profiles\node_modules\@deepseek-ai\<pkg>
  → D:\...\dist\win-unpacked-build202608272104\win-unpacked\resources\app.asar.unpacked\node_modules\@deepseek-ai\<pkg>
```

- `@deepseek-ai` 下 **203** 个包，**203 个全是 Junction**，目标均为 **build 2104（0.1.1）**
- 第三方包（react / express / sharp / dshmarket …）同样链到 2104
- 对比：`@deepseek-ai` 在 2329 中存在 **193/203**；10 个 0.1.7 已移除/更名

**后果（实测）**：`profiles/desktop/node_modules` 里的社区插件（better-sidebar / dsh-context / bash-terminal / dshmarket）对 `@deepseek-ai/*` 的 `require` 会命中 **0.1.1 API**：

| 探针 | 改指前 | 改指后 |
|---|---|---|
| `@deepseek-ai/dsh-settings` | 0.1.1-rc.2 | **0.1.7-rc.2** |
| `@deepseek-ai/cordis` | 4.0.1 | **4.0.4** |
| `@deepseek-ai/dsh-client-connection` | 0.1.1-rc.2 | **0.1.7-rc.2** |
| `@deepseek-ai/dsh-web-frontend` | （随 2104） | **0.1.7-rc.2** |

这与 host 日志里的 `sctx.settings.register is not a function`、`config.pwshPath.get is not a function` 同类：**0.1.1 插件面 × 0.1.7 宿主**。

### 2.3 为何「只补 client-runtime」不够

- `@deepseek-ai/dsh-web-app` **0.1.7 的 cordis.patch.yml 确实漏挂** `client-runtime`（0.1.1 同段有）；已按 0.1.1 原位在 desktop profile 补回（compose 验证 = 1 条）。
- 但客户端模块（client-modules / client-runtime / connection）仍可能被社区插件以 0.1.1 副本 require，或与 0.1.7 web-frontend 混跑 → `reading 'start'`。

### 2.4 版本号陷阱（诚实标注）

`app.asar.unpacked` 里 `@deepseek-ai/dsh-client-runtime/package.json` 的 `version` 仍是 `0.1.1-rc.2`（与 2104 **同哈希**）。这是上游打包未抬版本号，**不是** junction 没改对。路径已落在 `win-unpacked`（→2329）。

---

## 3. 处置（已执行）

**策略修正**：不是「整树改名删除」（会弄断社区插件对 `@deepseek-ai` 的解析），而是 **junction 改指**到**当前活动** `dist/win-unpacked/…`（跟随 promote，今后换 build 自动跟）。

| 项 | 内容 |
|---|---|
| 锁 | `task-scheduler acquire` resource=`profiles/node_modules`，token `tk-mukrli63-623692bc`，已 `release` |
| 备份 | `_backups/profiles-node-modules-junctions-20260928/junction-catalog-before.json`（256 条原目标） |
| 改指日志 | 同目录 `junction-repoint-log.json`（顶层）+ `junction-repoint-scoped-log.json`（含 `@**`） |
| 结果 | **repointed=258**，failed=0；缺 2329 对应物的 173 个（多为第三方小包）**保留指向 2104** 作依赖兜底 |
| 方式 | `[System.IO.Directory]::Delete($junction,$false)` + `New-Item -ItemType Junction`（只拆重解析点，不动目标树） |

**同步已做**：desktop profile `cordis.patch.yml` 增加

```yaml
- insert:
    - id: client-runtime
      name: '@deepseek-ai/dsh-client-runtime'
```

---

## 4. 验证

| 断言 | 级别 | 结果 |
|---|---|---|
| 社区插件 require `dsh-settings` | 【实测】 | 0.1.7-rc.2 |
| 社区插件 require `cordis` | 【实测】 | 4.0.4 |
| 社区插件 require `dsh-web-frontend` | 【实测】 | 0.1.7-rc.2 |
| profile compose 含 `client-runtime` | 【实测】 | 1 条（`test-real-anchor.mjs`） |
| installAnchor=`package.json` 时 web-app | 【实测】 | 0.1.7 + 5 个 preset patch |
| 失败数 | 【实测】 | repoint failed=0 |

**未验证（需用户重启）**：`Failed to load plugins` 是否消失、`/health` 是否全绿。

---

## 5. 遗留（不在本次范围）

1. **host 侧 0.1.7 API 缺口**：`settings.register`、`pwshPath.get`、typert codec `create()`、HMR `--expose-internals`
2. **0.1.7 web-app 漏挂 client-runtime**（上游）——profile 已补；若今后重建 profile 需再补或改上游 patch
3. **client-runtime 包版本号仍为 0.1.1-rc.2**（上游打包）
4. 原生 recovery 窗 `ERR_FAILED`（recovery.html 存在，原因未查）
5. 10 个包在 2329 无对应（`cordis-plugin-hmr`、`dsh-client-web*`、`dsh-llm-deepseek` 等）——junction 仍指 2104

---

## 6. 回滚

1. 读 `junction-catalog-before.json`，按 `name` + `target` 用同样的 Delete+Junction 逐个改回 2104
2. 或：把 desktop profile 里 `client-runtime` insert 删掉
3. 锁已释放，无残留

---

## 7. 证据分级

- 【实测】版本解析对照、junction 目标、compose 行数、repoint 计数 —— 本机 Node/PowerShell 输出
- 【推断】`reading 'start'` 主要由「社区插件 0.1.1 require × 0.1.7 宿主/web-frontend」引起 —— 与 API 报错同源；**未在重启后的 renderer console 复测**
