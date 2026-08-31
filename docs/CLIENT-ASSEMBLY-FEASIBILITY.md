# Client 装配可行性报告（CLIENT-ASSEMBLY-FEASIBILITY）

> 日期：2026-08-31 ｜ 性质：B 专项第一阶段 · 纯只读逆向结论
> 结论先行：**client 装配路径已打通**（内核标准机制 + 本地 10 个插件实证）；
> 方案书 v3 剩余展示层功能（工具流式展示 / 技能状态卡 / 集成面板 / 渲染器）**全部可通过
> client 插件 + slot 注入实现，无需改 apps/web shell**。「client 装配路径未打通」系旧认知，已过时。

---

## 1. Client 装配机制（完整链路，源码依据）

| 环节 | 机制 | 证据位置 |
|------|------|----------|
| 声明 | 插件 `package.json` 声明 `dsh.client: { platform: "web", inject?, external?, immediately? }` + `exports["./client"]` 指向 bundle | `@deepseek-ai/dsh-client-modules/lib/index.js`（`parseDshClient` / `clientExportOf`） |
| 入口 | 插件必须在 host loader 有 entry：profile bundles 清单 + `cordis.patch.yml` 的 `- insert:`（fiber 装配入口，2026-08-31 实证） | 见 UPGRADE-EXECUTION-LOG「阶段 3a 收尾修正」 |
| 扫描 | host 侧 `dsh-client-modules` 服务增量扫描 cordis `internal/plugin` 发射（fiber 构建/销毁标记 dirty → microtask 刷新），缓存包元数据 | `dsh-client-modules/lib/index.js` |
| 组合 | 解析 `exports["./client"]` → 生成模块图行（`/plugins/<id>/client.js?rev=<hash>`），按 external 依赖拓扑排序（有环检测），注入 boot manifest | 同上（`orderByModuleGraph` / `graphRow`） |
| 传输 | 组合为 `window.__DSH_BOOT__` wire + HTML 解析器预载 `@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-runtime` 两个 client bundle，随后 Vite shell 启动 | 同上（`PARSER_PRELOAD_IDS`） |
| 物化 | 浏览器 `window.__ModuleLoader__.load({id, factory})` 注册；lazy CJS：factory(require) → exports，CSS 注入在 factory 闭包内，首次 import 时物化并 memoize | `dsh-client-modules/lib/client.js` |

**已生效实例**：本地 10 个插件（file-explorer、frontend-reload、model-picker-group、model-whitelist、remote-workspace、session-history、skills-manager、system-notify、ui-performance、vision-engine）+ 第三方 dsh-community-market、dshmarket。

**构建工具链**：tsdown client build（`format: 'cjs'`、`platform: 'browser'`、banner/footer 包裹 `window.__ModuleLoader__.load({id, factory})`）——见 `dsh-bundle-plugin-dev` skill。

## 2. UI 注入点（slot 系统，官方扩展面）

| 插槽 | 用途 | 证据 |
|------|------|------|
| `settings.section` | 设置页区块（导航 + 内容），`slots.inject` + `ctx.slots.register({...}, Component)` | dsh-client-ui-settings-general 声明，多插件注册（models/plugins/agent-presets…） |
| `sidebar.settings` 等 sidebar.* | 侧边栏条目 | dsh-client-ui-settings-general |
| **`tool.call.toolview`** | **工具调用卡片**（chain 条件渲染，按 toolName/条件选择渲染器）——方案书「工具专用渲染器 ×20」的官方注入点 | `dsh-client-ui-tool/lib/client.js`：`ctx.slots.inject("tool.call.toolview", …)` + `renderSlot("tool.call.toolview", owner, …)` |

Slot 规则要点（dsh-slot-system skill）：component 必须是 `register()` 第二参数；服务经 `inject` 传入；`useSessions` 由 root scope 提供；API 命名空间复数（`connection.api.sessions.list`）。

## 3. 剩余功能可行性映射（更新方案书 v3 评估）

| 功能 | 旧评估 | 新评估（本报告） | 落地方式 | 风险 |
|------|--------|------------------|----------|------|
| 工具流式 client 展示（P2-A-0 展示层） | 卡 client 路径 | ✅ **可行** | client 插件注册 `tool.call.toolview`，消费 tool-visibility 数据层（`/tool-visibility/recent` 或事件） | 低 |
| 技能状态卡 / 导入文件夹（3b） | 卡 client 路径 | ✅ 可行 | skills-manager 已有 dsh.client；slots 注入状态卡；导入文件夹为 host API | 中低 |
| 集成面板（阶段 4） | 需 client 路径 | ✅ 可行 | `settings.section` / sidebar slots 注入 | 中低 |
| 工具专用渲染器 ×20（阶段 5） | P3 高风险 shell 重建 | ✅ **可行且无需改 shell** | `tool.call.toolview` chain 按工具条件注册专用卡 | 中 |
| Mention 体系（阶段 5） | P3 | ❓ 待验证 | ui-input-trigger 是否存在输入框 slot（下一阶段确认） | - |
| 连接器市场 / MCP roots（3c） | 卡装配 | 维持让位（官方原生实现，不重复造轮子） | - | - |

## 4. 门槛与风险

1. **构建门槛**：每个 client 插件需 tsdown 构建 `lib/client.js`（声明 dsh.client 但产物缺失 → `MissingClientBundleError` 启动报错：`client bundle not found; run pnpm run build before launch`）。
2. **重启生效**：`plugin-set changes take effect on restart`——新增 client 插件装配验证仍需干净重启 + `dev_plugin_status`（loader entries 有 fiber）。
3. **装配纪律不变**：cordis.patch.yml insert + bundles 清单 + 模板同步 + junction；验证以 dev_plugin_status 为准。
4. **UI 细节坑**（dsh-slot-system skill）：register 第二参数必须传组件；inject 必须显式传入；重复 section id 会 crash。
5. **不碰运行路径**：本阶段纯只读；落地阶段每个插件走独立 plan + 备份 + 重启验证。

## 5. 建议落地顺序

1. **工具流式 client 卡片**（数据层已就绪，价值最高，风险最低）——注册 `tool.call.toolview`，展示 toolName/status/durationMs/参数摘要。
2. **技能状态卡 + 导入文件夹**（3b）——skills-manager 增量。
3. **集成面板**（阶段 4）——settings.section 注入。
4. 渲染器 ×20 按需逐个注册（tool.call.toolview chain）——不再需要 shell 重建排期。

## 6. 验证命令

```bash
node scripts/startup-verify.mjs          # 装配预检（V2 模板=运行态）
# 重启后：
curl http://127.0.0.1:43120/tool-visibility/status   # 数据层健康
# client 插件验证：dev_plugin_status（fiber）+ UI 实际渲染
```

---

*本报告由 B 专项第一阶段（只读逆向）产出；逆向范围：`dsh-client-modules`、`dsh-client-runtime`、`dsh-cordis-client-runner`、`dsh-client-ui-tool`、`dsh-client-ui-conversation`、打包壳 `desktop-plugins.ts`。*
