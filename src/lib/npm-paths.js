// src/lib/npm-paths.js
// npm / 全局包路径查找的唯一定义（src/main.js 与 src/patch-dsh-native-picker.js 共用）。
// 收敛历史重复实现：execSyncSafe、npm prefix/root 缓存、dsh/pnpm/npm-cli 兜底路径。
// 说明：QClaw（AppData\Roaming\QClaw\npm-global）兜底已移除——本机无 QClaw 环境，
//       该候选永不命中，属历史冗余（dsh 独立安装后优先使用用户级全局）。

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// npm prefix/root 结果缓存：桌面应用运行期间环境稳定，避免每次启动反复执行
// execSync('npm prefix -g')（findDshBin/findPnpmBin/findNpmCli 合计调用 6+ 次）
let prefixCache = null;
let rootCache = null;

/** 安全执行 execSync（带超时），失败返回 null，绝不阻塞调用方 */
function execSyncSafe(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', windowsHide: true, timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

/** npm prefix -g（缓存） */
function getNpmPrefix() {
  if (prefixCache === null) prefixCache = execSyncSafe('npm prefix -g');
  return prefixCache;
}

/** npm root -g（缓存） */
function getNpmRoot() {
  if (rootCache === null) rootCache = execSyncSafe('npm root -g');
  return rootCache;
}

/** 用户级全局 node_modules 根（npm install -g 默认落点） */
function userGlobalNodeModules() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules');
}

/** 全局包基目录列表（分平台，去重） */
function globalBases() {
  const isWin = process.platform === 'win32';
  const bases = [];
  if (isWin) {
    const prefix = getNpmPrefix();
    if (prefix) bases.push(prefix);
    const roaming = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
    if (!bases.includes(roaming)) bases.push(roaming);
    bases.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
    bases.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'));
  } else {
    bases.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules');
  }
  return bases.filter(Boolean);
}

/**
 * 定位 dsh 的 lib/bin.js。
 * 优先级：用户级全局 (Roaming\npm) > 动态 npm prefix/root（用户独立安装优先）。
 * @returns {string|null} 存在的 bin.js 绝对路径
 */
function findDshBinJs() {
  const candidates = [
    path.join(userGlobalNodeModules(), '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  const prefix = getNpmPrefix();
  if (prefix) candidates.push(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  const root = getNpmRoot();
  if (root) candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/** 定位 pnpm.cjs（node 可直接执行的 pnpm 入口，无需 cmd shim） */
function findPnpmCjs() {
  const prefix = getNpmPrefix();
  if (prefix) {
    for (const c of [
      path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      path.join(prefix, 'pnpm.cjs'),
    ]) {
      try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
  }
  for (const base of globalBases()) {
    const c = path.join(base, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/** 定位 npm-cli.js（node 可直接执行，替代 npm.cmd） */
function findNpmCliJs() {
  const prefix = getNpmPrefix();
  if (prefix) {
    const c = path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  for (const base of globalBases()) {
    const c = path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/**
 * 找出 DSH 所在的全局 node_modules 根目录（patch 类工具用）。
 * 候选：npm prefix/root > 用户级全局，返回第一个实际包含 @deepseek-ai/dsh 的。
 * @returns {string|null}
 */
function findDshNodeModulesRoot() {
  const candidates = [];
  const prefix = getNpmPrefix();
  if (prefix) candidates.push(path.join(prefix, 'node_modules'));
  const root = getNpmRoot();
  if (root) candidates.push(root);
  candidates.push(userGlobalNodeModules());
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(path.join(c, '@deepseek-ai', 'dsh'))) return c;
    } catch (e) {}
  }
  return null;
}

module.exports = {
  execSyncSafe,
  getNpmPrefix,
  getNpmRoot,
  userGlobalNodeModules,
  globalBases,
  findDshBinJs,
  findPnpmCjs,
  findNpmCliJs,
  findDshNodeModulesRoot,
};