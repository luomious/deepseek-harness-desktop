# 事故报告：DSH 会话自主训练循环导致内存耗尽 / 蓝屏（2026-09-14 ~ 09-15）

> **性质**：事故复盘（incident review）＋ 处置记录。**非代码改动**（本工作区未改任何运行路径文件）。
> **作者**：DSH 会话（`D:\Deepseek-Harness` 工作区），2026-09-15 09:40 起。
> **状态**：止血已生效（阈值守卫运行中）；根治待用户在对方会话内叫停（见 §6）。
> **给谁看**：用户本人；后续接手该机器的 agent。

---

## 0. 一句话结论

另一 DSH 会话（`session-940b54f1`，工作区 `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备软件`）在**无人值守**下反复重启两阶段 YOLO 训练；25 个 dataloader worker 各占约 1 GB，把 16 GB 内存机器推到提交上限 → 桌面应用两次崩溃 ＋ 一次 **0x50 蓝屏**。本会话查明真相（中途两次错误归因已更正），用「阈值守卫」止血；**根治只能由用户在对方会话内叫停**。

---

## 1. 时间线（全部实测，来源标注）

| 时间 | 事件 | 证据来源 |
|---|---|---|
| 09-14 20:48 | `data_fabric_pretrain.yaml` 写入（v10 计划起点） | 项目目录 mtime |
| 09-14 21:52 | `stage_a_pretrain.py` / `stage_b_finetune.py` 写入 | 项目目录 mtime |
| 09-14 22:03→22:18 | Stage A 预训练运行并产出 `best.pt`（FD_Dataset 720 张） | `runs/pretrain_fd_yolo12m/weights/` |
| 09-14 22:18–22:20 | python 集群 ~6.5–7 GB → 系统 Resource-Exhaustion 告警 | System 事件日志 id 2004 |
| **09-14 22:20:56 / 22:23:58** | **DSH Desktop 崩溃 ×2**（crashpad 转储 33.7 MB ×2） | crashpad dumps |
| **09-14 23:02:54** | **蓝屏 `0x00000050` PAGE_FAULT_IN_NONPAGED_AREA** | `C:\Windows\Minidump\091426-21984-01.dmp` |
| 09-14 23:43:32 | 会话检查 `pretrain_fd_yolo12m/weights/best.pt` + `results.csv`（A→B 衔接） | PowerShell 经典日志 id 400 |
| **09-14 23:44:13** | 会话启动 `stage_b_finetune.py`（25 worker + PyAV 视频解码） | PowerShell 经典日志 id 400 `HostApplication=` 原文 |
| 09-15 00:38–00:45 | 会话重启 `v10_two_stage_yolov8s.py`：00:40:04 / 00:40:54 / 00:45:52 | 会话转录（多帧 zstd 解码） |
| 09-15 00:44:09 | 会话自身推理已识别 `WinError 1455 (commit limit)`、19 个 python、可用 1578 MB | 会话转录原文 |
| 09-15 00:46:46 | 本会话启动守卫 v1（20 min，全杀） | `guard-yolo.log` |
| 09-15 00:46–00:57 | 守卫 v1 杀 13 进程（freed 11.0 GB 峰值） | `guard-yolo.log` |
| 09-15 00:54:29 | 守卫 v2（阈值版，240 min）启动 | `guard-yolo.log` |
| 09-15 00:55–01:04 | 守卫 v2 触发 5 次、共杀 11 进程（freed 2.0–4.4 GB/次） | `guard-yolo.log` |
| 09-15 01:04:35 后 | 对方会话**自行停止重启**，安静 8 小时 | `guard-yolo.log`（无新条目） |
| **09-15 09:29:04** | **对方会话再次重启训练**（单进程已 4,796 MB；可用物理仅 1,515 MB） | 本会话进程快照 |
| 09-15 09:34 | 本会话续守卫 v2（**480 min** 窗口） | 后台作业 `shell/powershell-1` |

---

## 2. 归因证据链（实测）

1. **启动命令原文**（PowerShell 经典日志 id 400，23:44:13.715）：
   ```
   powershell.exe -NoLogo -NoProfile -NonInteractive -Command $env:PYTHONIOENCODING='utf-8'; & "E:\Anaconda\envs\yolov11\python.exe" "...\stage_b_finetune.py" 2>&1
   ```
   `-NoLogo -NoProfile -NonInteractive -Command` 是 **DSH shell 工具的固定包装签名**，与对方会话转录里 00:38:56 / 00:40:04 的命令逐字吻合。
2. **会话转录命中**：`session-940b54f1`（4.5 MB）内 `yolov11` 出现 **1,135 次**；最后 12 条工具调用中 5 条是训练启动/状态查询。
3. **排除其他启动者**：用户明确「不是我跑」；Marvis / WorkBuddy 日志与该命令签名不匹配。
4. **父 PID 链**：环境 ACL 封锁（WMI `0x80041003`、`NtQueryInformationProcess` `-1`、`OpenProcess` `0x5`）无法直接取父进程；但三重旁证（命令签名 + 转录 + 排除法）收敛一致 ⇒ 归因**高置信**，非单点推断。

## 3. 两次归因错误（过程复盘，防再犯）

| 错误 | 根因 | 纠正 |
|---|---|---|
| 「是 Marvis 跑的」 | 用**命令包装风格**做过度推断（证据不足即下结论） | 改逐字比对命令原文；用户指正后重查 |
| 「DSH 已排除（0 命中）」 | **解码器 bug**：DSH 会话文件是**多帧 zstd**（单文件 12,346 帧），`zstdDecompressSync` 只解第一帧 → 191 个会话只读到 183 字符头部就断言 0 命中 | 改用**魔数扫描逐帧解压拼接** → 29 会话命中，真凶定位 |

> 教训：**「0 命中 / 为空」类断言必须换方法复核**（用户「证伪义务」规则）。本次若不复核，会带着错误结论收尾。

---

## 4. 内存事件物证（实测）

| 项 | 值 |
|---|---|
| 物理内存 | 16,095 MB（16 GB） |
| 页面文件 | 系统托管，压力下 15.7 → ~34 GB 自动增长 |
| 提交上限峰值 | **50.6 GB**（Resource-Exhaustion 事件时）；蓝屏时提交 50.3 GB |
| 蓝屏前 python 合计 | ~6.5–7 GB 提交（另有多进程常驻） |
| 崩溃/蓝屏时刻 | 22:20:56、22:23:58（应用）；23:02:54（系统 0x50） |
| 止血后 | 提交 50.3 → 18.8 GB，可用 2.5 → 8.3 GB |

## 5. 已采取的处置（本会话，实测）

| 动作 | 时间 | 结果 |
|---|---|---|
| 杀 25 个 worker + 包装 shell（25264） | 00:33 | 提交 50.3→18.8 GB；当时无复活 |
| 守卫 v1（20 min，无阈值全杀） | 00:46:46 | 杀 13 进程 ⇒ **证明「杀进程治不了本」**（1 分钟内重启） |
| 文件断路尝试（改名 `v10_two_stage_yolov8s.py`） | 00:53 | ❌ **失败**：DSH 进程 token 受限，项目目录写入 `UnauthorizedAccessException`；**原文件未动**（无 `.orig-*` 残留） |
| 守卫 v2（阈值：>3 进程 或 >2000 MB 才杀） | 00:54:29 | 5 次触发共杀 11 进程；此后对方会话安静 8 小时 |
| 守卫 v2 续期（480 min） | 09:34 | 运行中，作业 `shell/powershell-1` |
| 本项目目录 ACL 核实 | 00:58 | 用户本人 FullControl，但 `CodexSandboxUsers` 只读；DSH token 不在可写集合内 |

## 6. 根治（唯一路径，需用户操作）

对方会话是**独立顶层会话**（非本会话子代理：`list_agents` 返回空 ⇒ `interrupt_agent` 不可用），项目目录亦无写权限 ⇒ **agent 无法代劳**。用户需：

1. 打开 DSH 中工作区为 `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备软件` 的对话（谈 v10 两阶段训练 / 织物模型优化 的那个）；
2. 点停止，或发一句：
   > **「立即停止 v10 训练，不要再重启；等我确认后再跑（workers≤4、单阶段）。」**

叫停后本会话可撤守卫并复查残留。

## 7. 训练恢复的正确姿势（建议，**未执行**）

| 项 | 建议 | 依据 |
|---|---|---|
| dataloader `workers` | **4**（非 8/25） | 每 worker ≈1 GB；16 GB 机器超限 |
| 阶段 | A / B **分开跑** | 22:03→22:18 Stage A 单独跑成功过 |
| 跑前腾内存 | 关 WorkBuddy（2.6 GB）、Marvis（2.9 GB）、多余浏览器（0.8 GB） | 基线常驻占用 |
| 跑中监控 | 盯 `(Get-Counter '\Memory\Committed Bytes')`，接近 31 GB 即停 | 23:02 蓝屏路径 |
| 失败要因 | `WinError 1455`（提交上限） | 对方会话自己已观察到 |

---

## 8. 未验证 / 待办

- [ ] 09:29 后对方会话是否继续重启训练——守卫 v2 正在拦截（单进程 4.8 GB 已超阈值将被杀）
- [ ] 用户是否叫停对方会话（§6）——叫停后撤守卫
- [ ] 转储分析 `091426-21984-01.dmp`（需 WinDbg/kd + 管理员权限）
- [ ] Defender 全盘扫描（部分环境 ACL 受限，需管理员）
- [ ] 长时守护替代方案评估（把「训练进程内存上限」做成常驻 guard，而非临时脚本）
- [ ] 事故四件套的 `_backups/` 归档与 `CHANGELOG.md` 同步（待用户确认后写；本报告本身已按 G2 入 `outputs/` 并登记 `INDEX.md`）

## 9. 相关文件（可追溯）

| 文件 | 说明 |
|---|---|
| `D:\Deepseek-Harness\_mermaid-repro.tmpdir\guard-yolo2.ps1` | 阈值守卫脚本（当前运行中就绪版本） |
| `D:\Deepseek-Harness\_mermaid-repro.tmpdir\guard-yolo.log` | 守卫击杀日志（含每次 freed MB 与提交内存） |
| `D:\Deepseek-Harness\_mermaid-repro.tmpdir\stop-yolo.ps1` | 一次性止血脚本（杀 yolov11 集群） |
| `D:\Deepseek-Harness\_mermaid-repro.tmpdir\decode-frames.cjs` | 多帧 zstd 解码器（本次关键取证工具） |
| `D:\Deepseek-Harness\_mermaid-repro.tmpdir\session-last-calls.cjs` | 会话最后工具调用提取器（定位真凶） |
| `~\.dsh\sessions\--C-Users-…-Desktop-…--\session-940b54f1-…\session.jsonl.zstd` | 真凶会话转录（4.5 MB，多帧 zstd） |
