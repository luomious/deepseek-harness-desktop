# Patch Bundles Manifest

> 自动生成于 2026-08-28，用于补丁可追溯性与评审。
> 每次修改补丁 bundle 后必须更新本文件的哈希值。
> 验证命令：`powershell -ExecutionPolicy Bypass -File scripts/verify-patches.ps1`

## 当前补丁 Bundle

| 文件 | 大小 | SHA-256 | 最后修改 | 用途 |
|------|------|---------|----------|------|
| `dsh-client-ui-conversation-client.js` | 448,117 B | `199a31e56f9ff78f0786347f41fced82119eba8a4cc114fbeb7045dde27d3265` | 2026-08-22 02:06:47 | 会话 UI 客户端修复 |
| `dsh-client-ui-directory-picker-browse-client.js` | 55,429 B | `8f0c2944cb87d0efba4c90f625d2078708a3d7af27a1a23090299d805a3a94c3` | 2026-08-24 20:50:39 | 目录选择器浏览客户端修复 |
| `dsh-client-ui-settings-models-client.js` | 135,041 B | `e0a1eb5a7c3e237c2c9bbdc2fdf2a9bafa5bdadf4313b797cf3e4b28850bae0a` | 2026-08-24 11:15:15 | 设置模型客户端修复 |
| `dsh-client-ui-workspace-client.js` | 116,446 B | `0497d48dbcd7ba2eca93af9de9615e7b716165dfcc2818da9be7237fe5720ee4` | 2026-08-25 22:35:48 | 工作区客户端修复 |
| `dsh-host-frontend-static-index.js` | 4,187 B | `b188830f03528635dc1850ab83cd6a87aab6d394bb2b245f63c1bab1e14bc935` | 2026-08-25 10:43:15 | 前端静态索引修复 |
| `modlens-dsh-index.js` | 87,470 B | `558a9a5dc14ea66093383c04c18de859158dfac838743fac4ed8deefd628b251` | 2026-08-22 17:06:14 | ModLens DSH 索引修复 |
| `safe-delete-shim.cjs` | 5,314 B | `952489ba094f0dd45f70754f570ca503aeec80ba3d8c4dea4070184579dcab94` | 2026-08-27 11:52:23 | fs 删除操作重定向到回收站 |

## 原始文件（用于对比/回滚）

| 文件 | 大小 | SHA-256 | 来源 |
|------|------|---------|------|
| `dsh-client-ui-conversation-client.js.orig-npm` | 447,932 B | `fe448ef7e0b1f3e7713dadfc7eff56b9f80d103a2111dfe69c1735ffd0196d61` | npm 安装原始版本 |
| `dsh-client-ui-workspace-client.js.orig-npm` | 114,011 B | `75d8a09a43a820e0ff8470e7b9c87b6dced523764ee650a8382317f6ef7a314b` | npm 安装原始版本 |
| `dsh-client-ui-workspace-client.js.orig-packaged` | 114,053 B | `d77717d7a421bf40d5ec6f8aa91ef20093f4ba51f6bdd85b0b087e44d324724a` | 打包构建原始版本 |

## 维护指南

### 修改补丁流程
1. 在 `patches/bundles/` 中修改对应文件
2. 运行 `Get-FileHash -Path <file> -Algorithm SHA256` 获取新哈希
3. 更新本 MANIFEST.md 中对应的哈希值
4. 运行 `scripts/verify-patches.ps1` 确认校验通过
5. 重建后再次运行 verify-patches 确认补丁存活

### 新增补丁
1. 将新补丁文件放入 `patches/bundles/`
2. 如需保留原始文件，放入 `patches/bundles/original/` 并添加 `.orig-npm` 或 `.orig-packaged` 后缀
3. 在本 MANIFEST.md 中添加对应条目
4. 在 `scripts/verify-patches.ps1` 中添加对应校验项
5. 在 `scripts/port-user-patches.mjs` 或对应 apply 脚本中添加重打逻辑

### 回滚补丁
1. 从 `patches/bundles/original/` 复制原始文件
2. 覆盖对应的补丁文件
3. 更新本 MANIFEST.md
4. 重建并验证

## 校验命令

```powershell
# 完整校验（含 dist 产物）
powershell -ExecutionPolicy Bypass -File scripts/verify-patches.ps1

# 仅校验 bundle 哈希
Get-ChildItem patches/bundles -File | Where-Object { $_.Name -notmatch '\.orig-' } | ForEach-Object {
  $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  Write-Host "$($_.Name): $hash"
}
```

---

*本文件由补丁维护流程自动更新。最后更新：2026-08-28*
