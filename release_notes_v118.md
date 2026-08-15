## v1.1.8 — 新建工作区路径末尾被截断的根本修复

### Bug 修复

**严重：DSH 原生目录选择器（Win32 IFileOpenDialog）返回路径末尾汉字被吞**

- **现象**：在 DSH 桌面版「新建工作区」选择 `C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发`，后端 `workspace.create` 报错：
  > `cannot create a workspace at "C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备": ENOENT ...`
  即末尾「开发」两个汉字被吞。

- **根因**：`@deepseek-ai/dsh-host-directory-picker-native` 子进程 `worker.cjs` 中，`readUtf16` 函数通过 koffi 读取 COM `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)` 返回的 LPWSTR 时，**只检查单字节是否为 0**（`bytes[end] !== 0`）就当作 UTF-16 null 终止符。
  但汉字「**开**」Unicode U+5F00，UTF-16LE 编码为 `0x00 0x5F`——**低位字节恰好是 0x00**。循环走到「开」字时误判为字符串结束，于是末尾的「开发」两个汉字被截掉。

- **通用性**：任何路径在某个字符的 UTF-16LE 低字节为 0 时都会被截断（不仅「开发」），覆盖范围广。

- **修复**：把 null 终止符检测改为「**连续 2 字节都为 0** 才认为结束」，这是 UTF-16 LE null 终止符（`\0\0`）的唯一正确判定。

```js
// 旧版（有 bug）
while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;

// 新版（已修复）
while (end + 1 < bytes.length) {
  if (bytes[end] === 0 && bytes[end + 1] === 0) break;
  end += 2;
}
```

### 持久化补丁

DSH 包重装后会覆盖 `worker.cjs`，因此加了一个幂等补丁脚本，**每次启动 DSH 服务前自动应用**：

- 新增 `src/patch-dsh-native-picker.js`：
  - `findDshNodeModulesRoot()` 按 `npm prefix -g` / `npm root -g` / QClaw 默认位置（`AppData/Roaming/QClaw/npm-global/node_modules`）等多源定位 DSH 全局 node_modules
  - `applyPatch()` 读取 `worker.cjs`，检测 `FIXED_MARK` 已存在则跳过，否则按精确正则替换旧版 while 条件
  - 可独立执行：`node src/patch-dsh-native-picker.js`
- `src/main.js`：顶部引入补丁模块，启动 DSH 服务之前调用 `applyNativePickerPatch()`，**失败时降级为 console.warn 不阻塞启动**

### 单元验证

- `readUtf16Old("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备"`（精确复现用户报错）
- `readUtf16New("...基于深度学习的缺陷检测边缘设备开发")` → `"...基于深度学习的缺陷检测边缘设备开发"`（完整）

### 用户操作

- **直接用原路径就行**：之前为绕过此 bug 在 `D:\` 创建的 junction `D:\edge-defect-dev` 可以保留作双保险，也可以随时删除（`rmdir D:\edge-defect-dev`）——junction 删除不会影响原文件夹内容。
- 重新启动 DeepSeek Harness 桌面版（让 worker.cjs 修复 + main.js 启动 hook 生效）后，`C:\Users\机械革命\Desktop\基于深度学习的缺陷检测边缘设备开发` 应能直接添加为工作区。

### 文件

- `src/main.js`：顶部新增 require；DSH 启动前新增补丁调用（~7 行）
- `src/patch-dsh-native-picker.js`：新增（约 100 行）
- `C:\Users\机械革命\AppData\Roaming\QClaw\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs`：readUtf16 已修复
  - 备份：`worker.cjs.bak.20260815134405`