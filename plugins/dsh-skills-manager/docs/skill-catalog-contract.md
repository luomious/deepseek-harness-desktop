# DSH Skill Catalog 契约（v1）

> 本文档定义 dsh-skills-manager「市场」功能的统一规范与接口契约，作为 host 端实现、client 端 UI 与外部索引发布方的对齐基准。
> 状态：**v1 implemented**（随 dsh-skills-manager 0.2.0 交付，含宿主侧 fetch/cache/validate/install 全链路与设置页 UI；0.2.1 修复 Windows PowerShell 兼容性：shell 命令改为 ctx.fs.writeText 原子落位 + node:fs 删除）。

## 1. 目标与原则

- 设置页 Skills 从"本地管理器"升级为"本地管理 + 在线市场"：浏览/搜索/分类，一键下载安装社区 skill 到 `~/.dsh/skills`。
- **内容统一规范**：skill 文件一律为 `SKILL.md`，YAML frontmatter 含 `name`（kebab-case）+ `description`（必填），对齐 Anthropic Agent Skills 标准；DSH 扩展字段 `whenToUse` / `disable-model-invocation` / `user-invocable` 保持兼容。
- **接口统一契约**：目录数据走静态 HTTPS JSON 索引（manifest + index），沿用 DSH Desktop community-market 已验证的信任模型——**无默认选中源、显式选择、来源可见、浏览 ≠ 授权、失败关闭、绝不自动回退**。
- **安全边界**：远程数据永远是"数据"不是"可执行输入"；下载经受限 HTTP 信道 + SHA-256 强校验 + frontmatter 解析 + 文件名白名单 + 路径规范化 + 原子安装。
- **长期稳定**：多源镜像 + 24h 本地缓存 + 离线可浏览 + 更新回滚。

## 2. 统一 Skill 文件规范（对齐 Anthropic Agent Skills）

每个 skill 是一个目录：`~/.dsh/skills/<name>/SKILL.md`。

```markdown
---
name: my-skill-name
description: A clear description of what this skill does and when to use it
whenToUse: optional extra guidance
---
# My Skill Name
...markdown instructions...
```

frontmatter 字段：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 小写字母/数字、连字符分隔（kebab-case），与目录名一致 |
| `description` | 是 | 非空单行文本 |
| `whenToUse` | 否 | DSH 扩展，单行文本 |
| `disable-model-invocation` / `user-invocable` | 否 | 仅本地管理写入时生成，市场条目不带 |

## 3. 目录源契约（manifest）

标准目录源发布一个静态 JSON manifest，host 对 manifest URL 校验后保存为本地源记录（recordId 由 host 生成）。**manifest 不得声明自分选中/官方/推荐/回退**。

```json
{
  "manifestVersion": "1.0.0",
  "providerId": "dsh-skills-index",
  "name": "DSH Skills Index",
  "description": "Community skill catalog",
  "attribution": { "name": "maintainer", "url": "https://github.com/..." },
  "transport": {
    "kind": "https-json",
    "endpoint": "https://cdn.example.com/skills-index.json"
  }
}
```

约束（v1）：

- `manifestVersion` 固定 `1.0.0`；未知 major 版本拒绝（fail closed）。
- 所有 URL 必须 HTTPS（凭证/自定义头拒绝），走受限 HTTP 信道（见 §6）。
- `endpoint` 必须与 manifest URL **同 origin**（简化安全模型，防跨源绕过；多镜像由用户添加多个源实现）。
- 无鉴权、无脚本、无自定义 header、无分页（v1 为单索引文件）。

## 4. 索引 JSON（provider page → 归一化快照）

`endpoint` 返回单文件索引，host 严格校验后归一化：

```json
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-08-27T00:00:00Z",
  "revision": "2026-08-27-1",
  "items": [
    {
      "id": "skill-id",
      "description": "one-line description",
      "categories": ["utility"],
      "version": "1.0.0",
      "author": { "name": "author", "url": "https://github.com/author" },
      "download": {
        "url": "https://cdn.example.com/skills/skill-id/SKILL.md",
        "sha256": "hex-64"
      }
    }
  ]
}
```

字段约束（v1）：

- `items[].id` 必须唯一、kebab-case、≤ 64 字符；重复 id 拒绝整个快照。
- `description` 非空 ≤ 500 字符；`version` 形如 `x.y.z`；`categories` 数组 ≤ 8 项，每项 `[a-z0-9-]` ≤ 32 字符。
- `download.url` 必须与索引 endpoint **同 origin**；`sha256` 必须为 64 位十六进制。
- 索引 JSON 大小 ≤ 900 KiB（受限信道硬上限 1 MiB 内留余量）；超限/截断 → 该源请求失败。
- 未知字段保留（向前兼容），但未知 major `schemaVersion` 拒绝。

## 5. 安装边界

浏览数据 ≠ 授权。只有用户显式点击「安装/更新」后才进入安装流程：

1. **下载**：经受限 HTTP 信道（§6）拉取 `download.url`；非 2xx / 截断 / 超时 → 失败，不写任何文件。
2. **SHA-256 校验**：与索引声明不匹配 → 失败（fail closed）。
3. **frontmatter 解析**：必须是 §2 规范（`name` 存在且等于目标名、`description` 非空）；name 不匹配或解析失败 → 失败。
4. **路径白名单**：目标目录名 = `name`（kebab-case 正则 `^[a-z0-9]+(-[a-z0-9]+)*$`），最终路径 `<userRoot>/<name>/SKILL.md`，必须落在 `<userRoot>` 内且不含 `..` 段，防止目录穿越。
5. **原子安装**：下载内容经 `ctx.fs.writeText` 原子落位（dsh-atomic-write：临时文件 + rename，自动创建父目录）；更新时直接覆盖（原子替换，失败旧文件原样保留）；成功后等 300ms 让文件 watcher 完成注册表更新。
6. **卸载**：仅删除 `<userRoot>/<skillName>` 目录（复用 safeSkillDir 越界防护 + `node:fs.rmSync`，不依赖 shell 语法）。

## 6. 受限 HTTP 信道（复用宿主 `ctx.web`）

host 端**不自行实现** HTTP 客户端的解析/重定向/限流，复用内核 `ctx.web.fetch(request, signal)` 能力，其底层传输（`dsh-web-fetch-local` 提供方）已实现：

- 仅 http/https，DNS 解析后 IP 直连（防 DNS rebinding TOCTOU）；
- 拒绝回环/私网/链路本地/CGNAT/组播/保留地址（SSRF 防护）；
- 1 MiB 响应体上限（流式截断）、重定向 ≤ 5 且逐跳复查、30s 超时、AbortSignal 取消；
- 不携带凭证/自定义 header/cookie。

market 模块在调用后检查 `truncated` / `statusCode` / body 有效性；任何受限信道错误原样失败并附安全错误信息（不泄露内部路径/凭证）。

## 7. 本地状态与缓存

- 状态文件：`<dshHome>/.skills-market/state.json`（dshHome = userRoot 的上一级，即 `~/.dsh`）：
  - `sources[]`：`{ recordId, manifestUrl, manifest(注册时副本), selected }`；
  - `installed[]`：`{ skillId, name, version, sourceRecordId, sha256, installedAt }`。
- 索引缓存：`<dshHome>/.skills-market/cache/<recordId>.json`（归一化快照 + `fetchedAt` + `expiresAt`），TTL 24h；缓存可用时**离线可浏览**，远程失败降级到缓存并标记 `stale:true`。
- 源选择为本地状态：最多一个选中源；切换取消在途请求并重置会话；远程 manifest 不得修改本地源设置。

## 8. Host API（/skmg 扩展，复用现路由）

| method | 参数 | 说明 |
| --- | --- | --- |
| `market.sources` | — | 列出已保存源与选中状态 |
| `market.addSource` | `{ manifestUrl }` | 下载并校验 manifest，保存源记录 |
| `market.removeSource` | `{ recordId }` | 移除源记录（不卸载已装 skill） |
| `market.selectSource` | `{ recordId }` | 选择当前浏览源（取消旧在途请求） |
| `market.list` | `{ q?, category?, forceRefresh? }` | 拉取/读缓存选中源索引；q/category 本地过滤 |
| `market.install` | `{ skillId }` | 按 §5 安装 |
| `market.update` | `{ skillId }` | 按 §5 更新（备份 + 原子替换 + 回滚） |
| `market.uninstall` | `{ skillId }` | 卸载本地目录 + 移除 installed 记录 |

所有请求仍走 `/skmg/api` 本地回环（源地址 + Host 头双重校验）。

## 9. 失败与降级语义

- 源 manifest/index 校验失败 → 该源请求失败，**不自动回退**到其他已保存源；
- 选中源网络失败且无缓存 → UI 显示安全错误 + 重试；有缓存 → 展示缓存条目 + `stale` 标注；
- 安装任何步骤失败 → 不留下半成品：已建暂存/备份在失败路径清理或回滚；
- `ctx.web` 不可用（无 provider）→ market 功能整体禁用并提示，不影响既有本地管理功能。

## 10. 版本与演进

- `manifestVersion` / `schemaVersion` 版本化本契约，不版本化插件或 skill。
- v1 → v2 演进允许：分页/多 endpoint/图标/评分等；**不得削弱**：无默认源、显式选择、严格校验、non-executable-data、同源下载、失败关闭。
- 兼容性：未知 major 拒绝；additive 字段保留。

## 11. 发布方指南（如何做一个目录源）

1. 建一个公开仓库，托管 `manifest.json`（§3）与 `skills-index.json`（§4），全部放在同一 origin（如 GitHub Pages）。
2. SKILL.md 文件与索引同 origin 存放（v1 约束），发布时填入正确的 `sha256`（`sha256sum SKILL.md`）。
3. 在 DSH 设置页 Skills → 市场 → 添加源，粘贴 manifest URL。任何域名/凭据/自定义头的源会被拒绝。
4. 官方示例索引计划：GitHub Pages 主源 + 用户自行添加 jsDelivr 镜像源（同 providerId 不同 recordId，互不干扰）。