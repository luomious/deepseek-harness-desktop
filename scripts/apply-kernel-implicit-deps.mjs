/**
 * apply-kernel-implicit-deps.mjs
 *
 * 补齐 0.1.7-rc.2 内核升级后 electron-builder 打包丢失的「隐式依赖」内核包。
 *
 * 背景（2026-09-28 排障）：内核从 0.1.1-rc.2 升到 0.1.7-rc.2 后，打包产物
 * app.asar.unpacked/node_modules/@deepseek-ai 少了 8 个「被真实 import、但未写进
 * 任何 package.json dependencies」的传递依赖（构建机上靠 root node_modules 提升侥幸能跑，
 * 进打包环境即断）。缺 dsh-client-store（被 ~38 个 client-ui 包 import）直接导致渲染进程
 * 加载 client 模块全部 ERR_MODULE_NOT_FOUND → renderer 起不来 → 启动守卫 30s 内主动退出
 * → 双击「没反应」。
 *
 * 权威差集来源：干净安装 @deepseek-ai/dsh@0.1.7-rc.2 的 node_modules 闭包，减去 build
 * unpacked 实际提供的 @deepseek-ai 包 —— 恰好这 8 个。这 8 包除 dsh-llm-deepseek 依赖
 * eventsource-parser（build 已有）外无第三方依赖，自包含。
 *
 * 载荷：patches/vendor/kernel-implicit-deps-0.1.7-rc.2.tgz（成员路径 ./@deepseek-ai/<pkg>/…）。
 * 本脚本把它解压进当前 build 的 unpacked node_modules（tar 会合并进已存在的 @deepseek-ai）。
 * 幂等：8 包都在且版本匹配则跳过解压。
 *
 * ⚠ 与补丁体系三件套同规：改 vendor node_modules 必须能被重放。重建 / 升级到新 build 后
 *   若打包再次丢包，重跑本脚本即可恢复；verify-patches.ps1 的 8 个存在性检查负责守门。
 *   若内核再升级，缺失闭包可能变化 —— 届时需重算差集、重打 tgz、更新下方 PKGS 与版本。
 *
 * 用法：node scripts/apply-kernel-implicit-deps.mjs [--force]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCurrentBuild } from './resolve-dist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FORCE = process.argv.includes('--force');

const VERSION = '0.1.7-rc.2';
const PAYLOAD = join(root, 'patches', 'vendor', `kernel-implicit-deps-${VERSION}.tgz`);
const PKGS = [
  'dsh-client-store',
  'dsh-deepseek-account',
  'dsh-hook-protocol',
  'dsh-llm-deepseek',
  'dsh-ptc-runtime',
  'dsh-sdk-protocol',
  'dsh-util-time',
  'dsh-util-workspace-path',
];

function log(m) { console.log(`[apply-kernel-implicit-deps] ${m}`); }
function fail(m) { console.error(`[apply-kernel-implicit-deps] ERR: ${m}`); process.exit(1); }

let build;
try {
  build = resolveCurrentBuild();
} catch (e) {
  fail(`无法解析当前 build：${e.message}`);
}
const scopeDir = join(build.nodeModules, '@deepseek-ai');
log(`target node_modules: ${build.nodeModules}`);

if (!existsSync(PAYLOAD)) fail(`载荷缺失: ${PAYLOAD}`);

/** 该包是否已就位且版本正确（幂等判定）。 */
function pkgGood(name) {
  const pj = join(scopeDir, name, 'package.json');
  if (!existsSync(pj)) return false;
  try {
    const o = JSON.parse(readFileSync(pj, 'utf8'));
    return o.name === `@deepseek-ai/${name}` && o.version === VERSION;
  } catch {
    return false;
  }
}

const missing = PKGS.filter((p) => !pkgGood(p));

if (missing.length === 0 && !FORCE) {
  log(`8 个隐式依赖包均已就位（v${VERSION}），无需操作（--force 可强制重放）。`);
  process.exit(0);
}

log(missing.length === 0
  ? `--force：重新解压载荷以覆盖校验。`
  : `缺失 ${missing.length} 个：${missing.join(', ')} —— 从载荷解压补齐。`);

// Windows 自带 tar.exe（bsdtar）；-C 到 node_modules，成员 @ 前缀不影响解包。
const r = spawnSync('tar', ['-xzf', PAYLOAD, '-C', build.nodeModules], {
  windowsHide: true,
  encoding: 'utf8',
});
if (r.error) fail(`调用 tar 失败：${r.error.message}`);
if (r.status !== 0) fail(`tar 解压退出码 ${r.status}：${(r.stderr || '').trim()}`);

// 解压后逐包复核入口存在。
let bad = 0;
for (const name of PKGS) {
  if (!pkgGood(name)) { log(`  ✗ ${name} 仍缺失/版本不符`); bad++; continue; }
  const main = (() => {
    try {
      const o = JSON.parse(readFileSync(join(scopeDir, name, 'package.json'), 'utf8'));
      if (typeof o.main === 'string') return o.main;
      if (typeof o.exports === 'string') return o.exports;
      if (o.exports && typeof o.exports['.'] === 'string') return o.exports['.'];
    } catch { /* ignore */ }
    return 'lib/index.js';
  })();
  if (!existsSync(join(scopeDir, name, ...main.split('/')))) { log(`  ✗ ${name} 入口缺失: ${main}`); bad++; continue; }
  log(`  ✓ ${name}@${VERSION}`);
}

if (bad > 0) fail(`${bad} 个包补齐后仍不合格。`);
log('完成：8 个隐式依赖内核包已就位。');
