# DSH Desktop 功能全面体检（2026-09-29）

> 目标：回答「还有多少问题要修」。按用户可见功能分档，不是流水账。

## 一句话结论

| 档 | 含义 | 数量 |
|---|---|---|
| **P0 能开能用** | 启动 / 窗口 / 主界面 / 历史数据 | 已基本打通，仍有体验问题 |
| **P1 功能会坏** | 点了会退出、写失败、服务缺失 | **约 5 项** |
| **P2 体验/噪声** | 慢、卡、告警刷屏 | **约 6 项** |
| **P3 非阻塞** | 已知残留、可延后 | **约 5 项** |

架构真相不变：内核 0.1.7 官方最新 + 插件已适配；壳 v2.0.2 靠 **9 处可重放补丁**桥接。

---

## P0 — 已打通（今日验证）

| 功能 | 状态 | 证据 |
|---|---|---|
| 双击启动出窗口 | ✅ | 约 10–15s（曾 85–130s） |
| 启动到 healthy | ✅ | `startup.run.completed rendererStatus:healthy` |
| 主界面渲染 | ✅ | 用户确认「能看到」 |
| 硬件 GPU | ✅ | `gpu-mode` hardware（曾 software 导致很卡） |
| 历史数据在盘 | ✅ | 289 条 session.jsonl，未删除 |
| 插件导出面 | ✅ | `verify-profile-exports` PASS |
| 客户端服务接线 | ✅ | `verify-client-services` PASS |
| 补丁可重放 | ✅ | `apply-shell-0.1.7-gaps.mjs` 9 项 + 门禁 |

---

## P1 — 会坏的功能（优先修）

### 1. 「创建提供商」可能把应用点没  ← 今日新修
- **现象**：设置 → 模型 → 创建提供商 → DSH 自动退出  
- **根因**：写设置 / profile reload 路径上 `EPIPE: broken pipe` 进入 `uncaughtException` → `exit(1)`  
- **修复**：EPIPE/ECONNRESET 类改为记日志、不退出（已打进补丁 #9）  
- **待你验证**：再点一次创建提供商

### 2. 「创建提供商」profile reload 曾报错
- `profile reload requires the root Include entry`（壳不调 `mountRootInclude`）  
- **已有补丁**：从 loader 树回退查找（补丁 #4）  
- 若仍红字 → 说明 reload 链路还有第二处缺口

### 3. 工具终端不可用
- `bash-terminal: settingsScope.get is not a function`（**host 侧** settingsScope 不完整）  
- 影响：DSH 内 bash 工具  
- 风险：不可贸然用垫片补 provide（重名会让现有提供者也挂）

### 4. 历史会话列表可能仍不全
- 数据在，但 0.1.7 对旧会话格式更严：150× `unsupported descriptor version 2`、67× `header missing`  
- 约 32 条会话被目录跳过；其余应能列出（依赖 workspace 服务，已随启动修复）

### 5. workspace / connection 激活偏慢（5–8s）
- 曾导致「required plugin did not activate」（竞速 3s 时误伤）  
- 现 10s 窗口内可就绪；根因是 credentials/storage 依赖链慢

---

## P2 — 体验 / 噪声

| # | 问题 | 说明 |
|---|---|---|
| 1 | 启动仍有 ~10s 黑盒 | 比 85s 好很多；若还要快需拆依赖链 |
| 2 | openviking MCP 仍重试 | 配置里 `openviking-memory` 未完全禁用干净，每次启动刷警告 |
| 3 | `context-lifecycle: evaluate failed` | 约 30s 一次，`undefined.length`，耗 CPU |
| 4 | 会话目录告警刷屏 | 290 会话 + 旧格式，启动时 150+ 条 warning |
| 5 | 内存偏高 | 主进程 ~850MB / 会话 412MB，self-maintenance 已告警 |
| 6 | 界面「有点卡」 | GPU 已开硬件；若仍卡需查渲染热路径 |

---

## P3 — 非阻塞残留

| # | 问题 | 说明 |
|---|---|---|
| 1 | `hmr: --expose-internals` | 桌面不需要 HMR，历史噪声 |
| 2 | typert codec 18 处 | 6 个 remote 方法契约校验失败，影响面待查 |
| 3 | `selftest-r2probe` not found | profile patch 行引用了已删条目 |
| 4 | `chatOnly` 门禁 FAIL | 0.1.7 恢复官方 bundle 后旧补丁标记消失（待 RETIRED） |
| 5 | `dsh-safe-delete` latent | 未进加载行，引用 0.1.7 已删 API |
| 6 | 壳仍是 dist 补丁 | 未源码级适配；rebuild 后靠 apply 脚本重放 |

---

## 今日补丁总账（`apply-shell-0.1.7-gaps.mjs`）

1. web-frontend readiness 回退  
2. 启动健康超时关闭  
3. settingsScope 注入  
4. root Include 回退  
5. HealthGate.stop 软结束  
6. 插件失败不杀窗  
7. 跳过内测声明弹窗  
8. loader.await 10s 竞速  
9. EPIPE 类 uncaught 非致命  

---

## 建议验证顺序（用户点选）

1. **重启 DSH** → 确认能进主界面（~15s）  
2. **设置 → 模型 → 创建提供商** → 是否还退出？  
3. **侧边栏工作区切换** → 历史是否列出？  
4. **新建会话 / 发消息** → 基本对话是否正常？  

1–4 都过 → 再回头清 P2（速度、噪声、内存）。
