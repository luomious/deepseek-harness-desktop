# DeepSeek Harness 桌面端 v1.2.3 发布说明

## 修复内容（src/main.js / src/patch-dsh-native-picker.js）

| 改动 | 说明 |
|------|------|
| 窗口遮挡冻结 | 禁用 `CalculateNativeWinOcclusion`：窗口被其他窗口完全盖住（occluded）时 Chromium 会冻结渲染，切回窗口后 UI 长时间无响应（`backgroundThrottling: false` 不覆盖此行为）。现在窗口遮挡/最小化后再切回立即响应 |
| 启动加速 | npm prefix/root 结果缓存：`findDshBin`/`findPnpmBin`/`findNpmCli` 合计 6+ 次 `execSync` 只在启动时执行一次，且全部带 5s 超时（防 npm 挂起卡死启动）；`patch-dsh-native-picker.js` 同样缓存 |
| 版本比较重构 | `isNewer`（支持 semver pre-release）从 main.js 提取到 `src/lib/version.js`，桌面应用与 tests 共用同一实现（`tests/smoke-v119-logic.js` 已切换并补充用例） |
| asar 原子打包 | `build-app.ps1`：先打包到临时文件再 `Move-Item` 原子替换，打包失败/中断不会留下损坏的 app.asar |
| 版本号 | `src/package.json` → 1.2.3 |

## 故障排查记录：rc.7 升级后"页面空壳 / 点击无响应"

### 现象
升级 DSH rc.7 后，界面变成空壳（只剩活动栏系统项），点击任何菜单无响应，控制台大量插件加载失败。

### 根因
rc.7 的 `dsh-client-ui-slots` 引入严格检查：

- `keyed slot requires options.key` —— 缺 `options.key` 直接抛错
- `slot not declared` —— 注册未在父条目 children 表声明的 slot 直接抛错

第三方插件 `@liustack/modlens`（settings.plugin.item 缺 key）与 `dsh-safe-delete`（settings.plugin.item 缺 key）注册失败；`dsh-remote-workspace` 注册的 `remoteFlow` slot 在 rc.7 核心包未声明 children。任一 loader entry 失败 → 整个 DSH 客户端初始化崩溃 → 空壳页面。

### 修复（改动在 node_modules / 插件源码，dsh 升级会被覆盖）
1. `@liustack/modlens/dsh/client.js`：`settings.plugin.item` 注册补 `key: 'modlens'`
2. `dsh-safe-delete/lib/client.js`：`settings.plugin.item` 注册补 `key: 'safe-delete'`
3. rc.7 核心 `dsh-client-ui-workspace/lib/client.js`：`sidebar.workspaces` / `conversation.hero.workspace` children 表补 `remoteFlow` 声明，并重打全部远程工作区功能（ADD_REMOTE 入口、WorkspacePickFlow/WorkspaceBrowser 渲染、中英文 locale）
4. 备份：`C:\Temp\opencode\client.js.modified-rc7.bak`（核心改动）、`modlens-index-modified.js`（modlens host 改动）

## 故障排查记录：modlens 配置卡片在"设置 → 插件"页消失

rc.7 的插件卡片渲染改为按 host 端 `settings.describe` 返回的 namespaces 过滤（卡片 key 必须在服务名单中），而 modlens host 端按旧版假设不注册 namespace → 卡片静默消失。

修复：`@liustack/modlens/dsh/index.js` 增加 `ctx.inject(['settings'])` 注册值无关 namespace（可调用 schema，无需 schemastery 依赖），卡片恢复显示（引擎选择 / API 密钥 / 自动复用 / 保存全部可用）。

## 功能改进（dsh-remote-workspace 插件，改动在 plugins/ 源码）

| 改动 | 说明 |
|------|------|
| 面板居中 | 远程连接面板从右上角浮层改为居中模态（全屏遮罩 + fixed 居中，点击遮罩关闭），适配窄窗口 |
| 自动加载 | 修复面板打开时永远显示"加载中…"：挂载时自动调用 `list` 拉取已保存连接/远程工作区，不再需要手动点"刷新" |

## 稳定性验证（v1.2.3）

- 9 分钟长观察：0 挂起、0 console 错误、JS 堆稳定 112MB（无泄漏）
- 12 轮快速交互压力（设置/新会话/添加工作区）：0 挂起
- 全插件实证：16 个 bundle 加载、设置页 7 个 section + 4 张插件卡片全部渲染
- 事件日志/崩溃转储无 DeepSeek Harness 崩溃记录

## 环境清理（v1.2.3）

- 删除临时测试脚本 56 个、`tools/npm-cache2` 缓存 63MB
- 旧备份文件集中归档到 `C:\Temp\opencode\backups-web-20260818\`
- 待处理：`.dsh-trash` 回收区 48MB（含已删除的 dsh-skill-manager 插件，可恢复，确认后清空）

## 已知问题

- 偶发冻结（未复现）：一次关闭远程面板后短暂无响应（约 20s），reload 恢复；窗口最小化/遮挡嫌疑最大，occlusion 开关已预防，建议观察
- modlens / safe-delete / 核心包改动在 node_modules，**dsh 升级会被覆盖**，需按上文重新应用