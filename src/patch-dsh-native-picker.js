// src/patch-dsh-native-picker.js
//
// 修复 DSH 原生目录选择器 (dsh-host-directory-picker-native) 中
// worker.cjs 的 readUtf16 函数 UTF-16 null 终止符检测 bug。
//
// 根因：worker.cjs 通过 COM IShellItem::GetDisplayName 拿到 LPWSTR 后，
//       readUtf16 用 `bytes[end] !== 0` 检测 null 终止符——但 UTF-16 字符
//       的低位字节可以合法为 0（如「开」U+5F00 → 0x00 0x5F），于是路径
//       末尾包含此类字符时会被误截断。
//
// 表现：用户在「新建工作区」选择 `...基于深度学习的缺陷检测边缘设备开发`
//       后，报错路径只剩 `...基于深度学习的缺陷检测边缘设备`（丢「开发」）。
//
// 修复：把 null 终止符检测改为「连续 2 字节都为 0」才认为结束。
//
// 幂等：每次启动时应用，已修复会跳过；DSH 包重装后会被重新打补丁。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PKG_NATIVE = '@deepseek-ai/dsh-host-directory-picker-native';
const TARGET_REL = path.join('lib', 'worker.cjs');
const FIXED_MARK = 'bytes[end] === 0 && bytes[end + 1] === 0';
// 旧版 while 条件（用作 bug 存在标记 + 精确替换源）
const BUGGY_PATTERN = /while \(end \+ 1 < bytes\.length && bytes\[end\] !== 0\) end \+= 2;/;
const FIXED_REPLACEMENT =
  'while (end + 1 < bytes.length) {\n' +
  '\t\tif (bytes[end] === 0 && bytes[end + 1] === 0) break;\n' +
  '\t\tend += 2;\n' +
  '\t}';

// npm prefix/root 只查一次（启动路径每次都会调用），带超时防 npm 挂起卡死启动
let prefixCache = null;
let rootCache = null;

function execSyncSafe(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', windowsHide: true, timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * 找出 DSH 所在的全局 node_modules 根目录。
 * 思路与 src/main.js 的 findDshBin 一致：npm prefix -g / npm root -g / 兜底路径。
 */
function findDshNodeModulesRoot() {
  const candidates = [];
  if (prefixCache === null) prefixCache = execSyncSafe('npm prefix -g');
  if (rootCache === null) rootCache = execSyncSafe('npm root -g');
  if (prefixCache) candidates.push(path.join(prefixCache, 'node_modules'));
  if (rootCache) candidates.push(rootCache);
  // 用户级全局安装（npm install -g 默认落点，独立于 QClaw）
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'));
  // 系统全局安装（npm prefix -g 指向）
  if (prefixCache && !candidates.includes(path.join(prefixCache, 'node_modules'))) {
    candidates.push(path.join(prefixCache, 'node_modules'));
  }
  // DSH 官方默认安装位置（QClaw 发行版，最后兜底）
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'QClaw', 'npm-global', 'node_modules'));

  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(path.join(c, '@deepseek-ai', 'dsh'))) return c;
    } catch (e) { /* 跳过不可读路径 */ }
  }
  return null;
}

/**
 * 定位 worker.cjs 的实际路径。
 * DSH 全局安装时通常位于：
 *   <root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs
 */
function findWorkerFile(root) {
  const candidates = [
    path.join(root, '@deepseek-ai', 'dsh', 'node_modules', PKG_NATIVE, TARGET_REL),
    path.join(root, PKG_NATIVE, TARGET_REL),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* skip */ }
  }
  return null;
}

/**
 * 应用补丁。失败抛出错误，由调用方决定是否降级。
 * @returns {{status: 'applied'|'already-fixed', path: string}}
 */
function applyPatch() {
  const root = findDshNodeModulesRoot();
  if (!root) throw new Error('未找到 DSH 全局 node_modules（请确认 @deepseek-ai/dsh 已安装）');
  const target = findWorkerFile(root);
  if (!target) throw new Error('未找到 ' + PKG_NATIVE + '/lib/worker.cjs');

  const original = fs.readFileSync(target, 'utf8');

  if (original.includes(FIXED_MARK)) {
    return { status: 'already-fixed', path: target };
  }

  if (!BUGGY_PATTERN.test(original)) {
    throw new Error('worker.cjs 中未找到预期旧版 readUtf16（可能 DSH 包结构已变更，需更新补丁）');
  }

  const patched = original.replace(BUGGY_PATTERN, FIXED_REPLACEMENT);

  // 写回前再加一层保险：确保打了补丁的文件确实包含 FIXED_MARK
  if (!patched.includes(FIXED_MARK)) {
    throw new Error('补丁替换后验证失败，拒绝写入');
  }

  // 写回前备份原文件（幂等场景仅首次写入；重装 DSH 后再次打补丁同样留档）
  const backup = target + '.bak.' + Date.now();
  try { fs.copyFileSync(target, backup); } catch (e) { /* 备份失败不阻断（低磁盘权限场景） */ }

  fs.writeFileSync(target, patched, 'utf8');
  return { status: 'applied', path: target };
}

module.exports = { applyPatch, findDshNodeModulesRoot, findWorkerFile };

// 允许直接执行：node patch-dsh-native-picker.js
if (require.main === module) {
  try {
    const r = applyPatch();
    console.log('[patch-dsh-native-picker]', r.status, '-', r.path);
    process.exit(0);
  } catch (e) {
    console.error('[patch-dsh-native-picker] 失败:', e.message);
    process.exit(1);
  }
}
