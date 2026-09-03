# 设置「模型 + 模型管理」合并为单页 —— 变更记录与回退手册

> 日期：2026-09-02
> 状态：✅ 已落地（客户端 bundle 按请求读盘 + no-cache，刷新浏览器即生效；无需重启桌面应用）
> 备份：`_backups\models-whitelist-merge-20260902163629\`（三个改动文件的**原始副本**）

---

## 1. 目标

设置栏原有的两个入口：

| 侧边栏项 | 来源 | 功能 |
|---|---|---|
| **模型**（`settings.section` id=`models`） | 核心包 `dsh-client-ui-settings-models`（仓库以补丁 canon 接管） | 厂商模型目录管理：添加/导入/配置/删除厂商、Key、路由 |
| **模型管理**（id=`model-whitelist`） | 插件 `dsh-model-whitelist` | 白名单勾选面板：主开关 + 分组复选框 + 每组「测试连接」+ 选择器过滤 |

合并为**一个「模型」入口**，同一页面上下两段展示，两套功能全部保留；并优化操作流——上方增删厂商后，下方白名单**自动刷新**，无需翻页/重进设置页。

## 2. 涉及文件与改动点

### 2.1 核心「模型」包补丁 canon：`patches/bundles/dsh-client-ui-settings-models-client.js`

1. 注册处（`ctx.slots.inject("settings.section", ...)`，`id:"models"`）：新增
   `children: { "settings.models.whitelist": { kind: "list", scope: "root" } }`
   —— 照抄 `dsh-client-ui-settings-general` 的 `GeneralSection` 子槽位范式。
2. `ModelsSection`：props 解构增加 `renderSlot` 并透传给 `Loaded`。
3. `Loaded` 的 section JSX 末尾（删除 Modal 之后）：追加
   `renderSlot("settings.models.whitelist")`（外包一层顶部边距/分隔线 div；
   `renderSlot` 缺失或无条目时渲染为空，不影响原页面）。

> 该文件为 `scripts/port-user-patches.mjs` 的 `SETTINGS_MODELS` 权威源（canon），
> 运行时副本（dev + 打包 app.asar.unpacked）由 port 脚本自动同步。

### 2.2 白名单插件客户端：`plugins/dsh-model-whitelist/lib/client.js`

1. 注册目标 `settings.section` → `settings.models.whitelist`（`name` 同步改为子槽名，
   `id` 仍为 `model-whitelist`）；`connection` 注入、`guarded(ModelManager)` 全保留。
2. **自动刷新优化**：
   - `var inject = ['locale']` → `var inject = ['locale', 'remote']`（与核心 models bundle 同源，
     使 `ctx.remote` 可用）。
   - `apply(ctx)` 新增 `ctx.effect`：订阅 `settings/document-updated`、
     `credentials/reference-updated`、`llm/adapters-updated` 三个目录变更事件，
     触发 `window.dispatchEvent(new CustomEvent('dsh-model-whitelist:refresh'))`。
   - `ModelManager` 的加载 `useEffect` 重构为 `loadCatalog()`，初始加载 +
     监听 `dsh-model-whitelist:refresh` 原地重载（不闪 loading，静默更新）。
3. 文案微调：`flowHint` / `empty` 改为同页描述（不再提示「先去『模型』页」）。

### 2.3 补丁登记：`scripts/port-user-patches.mjs`

- `SETTINGS_MODELS.markers` 追加标记 `'settings.models.whitelist'`，保证重打/重建后
  合并补丁仍被识别（否则 canon 失去该标记，port 脚本会误判补丁丢失）。

## 3. 保留的功能（回归清单）

> ✅ = 代码层已验证保留；GUI 侧待用户刷新浏览器后 spot-check。

- [x] 白名单主开关「只显示我选择的模型」+ 持久化 `dsh.model-whitelist.v1`（✅ 未改动）
- [x] 分组复选框 / 全选 / 清空 / 已选计数（✅ 未改动）
- [x] 每组「测试连接」（✅ host 端 `/model-whitelist/test` 未改动）
- [x] `api.sessions.models` 选择器过滤（✅ 未改动，与 UI 位置无关）
- [x] 当前会话在用模型始终保留显示（✅ 未改动）
- [x] 隐藏 `(modlens vision)` 双胞胎逻辑（✅ 未改动）
- [x] 目录变更后白名单自动刷新（✅ 已实现：remote 三事件 → window 事件 → loadCatalog）

## 4. 验证方式

> 已执行证据（2026-09-02）：
> 1. `node --check` 三个改动文件 → 全部通过（exit 0）。
> 2. `node scripts/port-user-patches.mjs` → 7 项全部 OK（含 settings-models，新标记校验通过）。
> 3. dev 副本 `vendor/.../dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
>    L2177 / L2867 含新代码。
> 4. 打包运行时副本 `dist/win-unpacked-build202608272104/.../app.asar.unpacked/.../dsh-client-ui-settings-models/lib/client.js`
>    L2177 / L2867 含新代码（GUI 实际读取处，已同步）。
> 5. 回读确认：ModelsSection/Loaded 透传 `renderSlot`、子槽渲染块、`children` 声明、
>    白名单 `inject=['locale','remote']`、注册改子槽、自动刷新三块全部就位。
> 6. 任务调度：acquire 报 EPERM（锁目录对子进程无写权限，环境问题），
>    时间线 watcher 已自动记录变更，不阻塞。

待用户操作：刷新 http://127.0.0.1:43120（客户端 bundle 按请求读盘 + no-cache；
dsh-frontend-reload 提供 Ctrl+R）→ 检查「模型」单页上目录下白名单、增删厂商自动刷新、
勾选过滤、测试连接。

## 5. 回退方式（重要）

> 回退 = 恢复 3 个文件原始内容 + 重跑 port 脚本。客户端 bundle 按请求读盘，
> 回退后刷新浏览器即恢复。**无需重启。**

1. 从 `_backups\models-whitelist-merge-20260902163629\` 恢复：
   - `dsh-client-ui-settings-models-client.js` → `patches/bundles/`
   - `client.js` → `plugins/dsh-model-whitelist/lib/client.js`
   - `port-user-patches.mjs` → `scripts/`
2. 重跑 `node scripts/port-user-patches.mjs`（恢复运行时副本）。
3. 刷新浏览器验证：设置栏恢复「模型」「模型管理」两个入口，白名单面板回到独立页面。
4. 若只想回退某一部分：
   - 只回退合并 → 恢复 1+2 两项中对应文件；
   - 只撤销自动刷新 → 仅回退 `plugins/dsh-model-whitelist/lib/client.js` 并保留合并。

## 6. 风险与收益

- 收益：设置栏少一个冗余入口；配置厂商→勾选白名单同页完成且自动刷新，操作流顺畅。
- 风险：**低**。仅前端 bundle 注册/渲染逻辑；不动 host 端、不动持久化、不动内核；
  父槽无注入时渲染为空天然向后兼容；全程可逆、无需重启。

## 7. 备注

- 相似问题扫描：`settings.section` 全部注册仅 models / model-whitelist / skills-manager /
  vision-engine 四处，仅「模型 + 模型管理」是重复入口，无其他待合并项。
- `verify-patches.ps1` 无 settings-models 校验项（由 port 脚本 markers 管辖），无需新增。
