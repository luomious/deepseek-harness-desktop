# @dsh-external/dsh-task-scheduler

跨对话任务调度与变更协调插件。解决用户实际痛点：**习惯同时开多个对话改同一项目时，互不知情互相覆盖、一个改完另一个不知道导致文件只更新一半、并发 install/build 把运行中的 dsh 打成白屏**。

## 机制概览（四通道，双入口互备）

| 通道 | 入口 | 适用 |
|---|---|---|
| 锁引擎 | `lib/core.js`（纯文件系统，零依赖） | 单一事实源，CLI 与插件共用 |
| HTTP | 插件注册 `/task-scheduler/*`（loopback only，端口 43120） | 任意工作区会话 `curl/Invoke-RestMethod` 调用，**不依赖项目文件**

（新工作区没有本项目 scripts 时用 HTTP 通道即可） |
| CLI | `scripts/task-scheduler.mjs`（项目内） | 本仓库各对话用 shell 直接调用，插件未加载也能用 |
| 规则 | 全局 `~/.dsh/AGENTS.md`「多对话协作铁律」 | 所有现有与未来工作区自动加载，约束对话行为 |

状态全部落盘在 `~/.dsh/.task-scheduler/`（可用 `DSH_TASK_SCHEDULER_STORE` 覆盖做测试）：
```
locks/                  # 每个资源一个锁文件 lock-<sha1>.json（原子 wx 创建）
changes.jsonl           # 变更时间线（追加写、崩溃安全）
changes.jsonl.old-<ts>  # 裁剪归档
```

## 核心能力

1. **资源互斥锁**：一次 `acquire` 声明全部资源（all-or-nothing，无死锁）；持锁期间 `touch` 续心跳；`release` 写变更摘要。
2. **丢锁自愈**：持有者 pid 已死或心跳超 TTL → 自动接管（现场保留 `.stale-*`）；手动 `clear` 仅允许死锁/过期锁，绝不删活锁。
3. **优先级避让**：`high > normal > low`。高优先级申请被低优先级占用时 → 向持锁者写入 `preempt-requested`（合作式让路，不硬中断）。
4. **变更可见性（防"只更新一半"）**：每个 release 记录 before/after hash + summary；acquire 带 `--base-change` 基线，期间有他人改动 → 返回 `STALE_BASE` 强制先重读。
5. **无锁修改检测**：插件周期对比"最近 release 的 hash"与当前文件 → 绕过锁直接改 → `unsupervised-change` 告警入时间线。
6. **长期运行安全**：时间线超 2000 行自动归档；锁目录超 512 自动回收死锁；JSONL 追加写；所有步骤 try/catch，插件故障不连坐 harness。

## 用法示例

```powershell
# 改文件前
node scripts/task-scheduler.mjs status
node scripts/task-scheduler.mjs acquire --resources "plugins/foo/lib/index.js,plugins/foo/src/index.ts" --who "会话A: 修 bug#42" --task "同步 src 与 lib" --base-change <上一次 status 里的 id>
# 长任务中途
node scripts/task-scheduler.mjs touch --resources "plugins/foo" --token tk-xxx
# 改完提交
node scripts/task-scheduler.mjs release --resources "plugins/foo" --token tk-xxx --summary "修复 X；src 与 lib 已同步（tsc 产物）"
# install/build/patch 一律用全局互斥资源（规则强制）
node scripts/task-scheduler.mjs acquire --resources "global:build" --who "会话B: 重建 dist" --priority high
```

HTTP 通道等价物：`GET http://127.0.0.1:43120/task-scheduler/status`、
`POST /task-scheduler/acquire`（body `{"resources":["..."],"who":"...","priority":"high"}`）。

> **资源路径约定（v1.1+）**：锁 key 只由资源字符串本身决定（不做调用方 cwd 拼接），
> CLI 与 HTTP 通道对同一字符串必然映射到同一把锁。**推荐传绝对路径**
> （如 `D:\Deepseek-Harness\CHANGELOG.md`）；相对路径按字面量使用（各通道一致，
> 但不会自动指向调用方 cwd 下的真实文件）。

## 与其他机制的关系（不重复造轮子）

- 锁协议语义继承旧壳 `legacy/scripts/dsh-build-lock.js`（pid 存活 + 超时 + clear），实现全新独立（旧 lib 已随 src 归档，不可 require）；
- 路由样板照抄 `critical-busy-route.ts` / `dsh-host-services registerLocalApi`（loopback + 方法/体积/JSON 校验）；
- 守护循环形态照抄 `dsh-session-watchdog`（零依赖 host、惰性 reflect、fail-safe）；
- 与壳级 `critical-busy` 分工：critical-busy 是"整个应用忙"标志，本插件是"按资源细粒度锁 + 变更时间线"。

## 配置（cordis.patch.yml insert config，可选）

```yaml
- insert:
    - id: task-scheduler
      name: '@dsh-external/dsh-task-scheduler'
      config:
        intervalMs: 600000    # 巡检周期（默认 10 分钟）
        maxBodyBytes: 65536
        logFile: ''           # 空 → ~/.dsh/super-injector/dsh-task-scheduler.log
```

## 验证

- `node --check lib/core.js && node --check lib/index.js`
- 隔离测试：`node tests/core.test.mjs`（28 项：并发互斥 / pid 接管 / stale 防覆盖 / 优先级抢占 / clear 安全 / 无锁检测）。
- HTTP：`GET /task-scheduler/status` 返回 200 JSON（2026-08-27 已实测上线）。
- CLI：`node scripts/task-scheduler.mjs status`（2026-08-27 已实测，写入真实 `~/.dsh/.task-scheduler`）。

## 可迭代方向（记录，不阻塞交付）

1. 硬中断低优先级对话（需先验证 host 侧是否存在等价 `interrupt` API——本轮**未做**，保持合作式）；
2. GUI 面板显示锁状态（client bundle）；
3. 会话 ID 自动绑定（holder 自动带 sessionId，当前靠 `--who` 自觉）；
4. 自动续心跳：对"持锁且对应 agent 仍 idle 但任务未完成"的锁由插件代 touch（当前靠 agent 自觉 touch + 大 TTL 兜底）。