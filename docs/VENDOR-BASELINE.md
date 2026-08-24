# Vendor 桌面壳基线记录（Vendor Baseline Pin）

> 目的：桌面壳（vendor/）不随根仓库入库（.gitignore 排除），此文件记录其**可复现基线**，
> 以便灾难恢复时重建完全一致的壳。投产审计项 P1-C2 / 方案书 D2。

## 壳源码
- **上游仓库**：`https://github.com/anywhere-labs/deepseek-harness-desktop.git`（只读，`luomious` 无写权限）
- **备份仓库**：`https://github.com/luomious/dsh-plugin-desktop.git`（私有，本账户可写）
- **基线分支**：`prod-baseline-20260823`
- **分支 HEAD commit**：`e247cc1e6304eca7c4c5708714cdecbe402cf169`
- **备份快照 commit**：`a43f861eaf4239767536f12aaaee044b6c842ff4`（已推送到备份仓库）

## 上游内核钉版
- **上游包**：`@deepseek-ai/dsh` 等 `0.1.1-rc.2`
- **submodule commit**：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（见 `vendor/.../upstream.json`）

## 已知限制（备份时记录）
1. **本地 vendor 为浅克隆**：快照备份代码状态完整，但**完整上游历史**尚未推送（受网络波动影响，`git fetch --unshallow` 失败）。网络稳定后可补推完整历史（届时 `git push -f` 覆盖快照分支即可）。
2. **快照剔除了 `.github/workflows/`**：gh OAuth token 无 `workflow` 权限，GitHub 拒绝创建/更新工作流文件。该目录为上游 CI 配置，**非本项目改动**，剔除不影响代码备份完整性。

## 灾难恢复步骤（壳）
1. `git clone https://github.com/luomious/dsh-plugin-desktop.git`（取 `prod-baseline-20260823` 快照）。
2. 按 `docs/BUILD.md` 初始化 submodule（`git submodule update --init --recursive`，对齐上游 `b150a551`）。
3. `corepack yarn install --immutable` → `yarn typecheck` → 打包。
4. 重建后跑 `scripts/verify-patches.ps1` 校验/重打补丁。

---
记录日期：2026-08-25　记录人：投产审计执行代理
