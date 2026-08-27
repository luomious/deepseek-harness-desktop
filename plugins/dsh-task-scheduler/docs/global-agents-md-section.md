## 多对话协作铁律（task-scheduler，2026-08-27 新增）

> 适用**所有工作区与未来工作区**。用户经常同时开多个对话改同一项目；历史实证：
> 多实例/多 agent 并发写共享状态曾造成「重启后打不开 / Failed to load plugins / 文件只更新一半」。
> 本铁律与锁机制配合，把并发操作串行化、变更全程可见。
> 机制文档：`plugins/dsh-task-scheduler/README.md`（本机仓库内）；任意工作区用 HTTP 通道即可。

1. **动手前查**：任何非只读改动（含读后写）前，先看目标资源是否被占用：
   - CLI（本仓库内）：`node scripts/task-scheduler.mjs status [--resource <路径>]`
   - HTTP（任意工作区，loopback）：`GET http://127.0.0.1:43120/task-scheduler/status`
2. **关键操作必加锁**（拿不到锁就等待或让路，绝不静默并发改）：
   - 改共享文件/目录 → `acquire --resources "<路径1,路径2>" --who "<会话名>:<任务>" [--base-change <id>]`
   - install / rebuild / 补丁应用 → 固定全局互斥资源 `global:install` / `global:build` / `global:patch`
   - 高优先级申请冲突时自动向持有者写 preempt-requested 通知；被通知者 5 分钟内提交或释放（合作式，不硬中断）。
3. **改完必登记**：`release --resources "<路径>" --token <tk> --summary "<改了什么>"`——summary 写入全局时间线，
   其他对话 `status` 立即可见（解决"改完了没人知道/只更新一半"）。
4. **长任务续心跳**：`touch --resources "<路径>" --token <tk>`；崩溃残留锁由 pid 死亡/心跳超时自动回收；
   死锁手动 `clear`（仅过期/死锁可清，活锁禁止 force）。
5. **基线防覆盖**：读到 base-change id 后，acquire 必须带 `--base-change`；若期间被他人改过 → 返回
   `STALE_BASE`，先重读文件再决定，禁止用旧内容覆盖新改动。
6. **编码纪律**：写入文件前先 read 原文件（禁止基于记忆或假设改共享文件）；改完回读验证。
7. **优先级**：high=用户盯着的修复/构建/补丁；normal=日常修改；low=探索性。冲突时 low/normal 让 high；
   同优先级先到先得。
8. **顺序一致**：多资源一次 acquire 全拿（all-or-nothing），禁止分多次拿锁（防死锁）。
9. **新工作区自动继承**：本规则在全局文件，内核自动加载；锁状态在 `~/.dsh/.task-scheduler/` 跨工作区共享。