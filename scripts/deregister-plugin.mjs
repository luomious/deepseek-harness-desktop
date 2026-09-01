#!/usr/bin/env node
/**
 * scripts/deregister-plugin.mjs — 删除协议工具：注销一个插件在运行态 Profile 的全部引用。
 *
 * 背景：2026-08-31 dsh-tool-visibility 事故——归档 plugins/<name>/ 只改源码模板，漏了运行态
 * Profile 引用，重启报 cannot resolve package。本工具把「插件删除协议」（全局 AGENTS.md）的
 * 3 处引用清理做成半自动：默认只读预检，--yes 才执行，每步备份 + 回收站 + 自动验证。
 *
 * 清理范围（对每个匹配 profile）：
 *   1. package.json dependencies / devDependencies 中 link:/file: 行
 *   2. 同一文件 dsh.profile.bundles 数组项（兼容嵌套与点号键两种形态）
 *   3. node_modules/@dsh-external/<name> 的 junction（仅删链接，target 保留）
 *
 * 安全护栏：
 *   - 默认只读预检（列出将清理项，不执行任何写入）
 *   - --yes 才执行；执行前先备份 package.json 到 _backups/
 *   - junction 删除走回收站（.NET FileSystem SendToRecycleBin，不动 target）
 *   - 真实副本（非 junction）拒绝自动删除，提示人工处理
 *   - 核心 bundle（@deepseek-ai/*）永不触碰
 *   - 清理后自动跑 scan-dangling --strict 验证（可用 --no-verify 关闭）
 *   - 原子写（临时文件 + rename），不截断覆盖
 *
 * 用法：
 *   node scripts/deregister-plugin.mjs --plugin @dsh-external/dsh-foo        # 预检（只读）
 *   node scripts/deregister-plugin.mjs --plugin dsh-foo --profile desktop    # 仅桌面 profile
 *   node scripts/deregister-plugin.mjs --plugin dsh-foo --yes                # 预检后执行
 *   node scripts/deregister-plugin.mjs --plugin dsh-foo --yes --no-verify    # 跳过自动验证
 * 环境变量：DSH_PROFILES_ROOT（默认 ~/.dsh/profiles）、DSH_REPO（验证用，默认 cwd）、
 *          DSH_BACKUPS_DIR（备份目录覆盖，测试隔离用；默认 ~/.dsh/_backups）
 * 退出码：0=完成/无引用；2=用法错误或校验失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const PROFILE_ROOT = process.env.DSH_PROFILES_ROOT || path.join(os.homedir(), '.dsh', 'profiles');
const REPO = process.env.DSH_REPO || process.cwd();
const CORE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const SCOPED = '@dsh-external/';

// ---------- 参数 ----------
const args = process.argv.slice(2);
let plugin = null;
const profilesArg = [];
let yes = false;
let noVerify = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--plugin') plugin = args[++i];
  else if (a === '--profile') profilesArg.push(args[++i]);
  else if (a === '--yes') yes = true;
  else if (a === '--no-verify') noVerify = true;
  else if (a === '--help') {
    console.log('用法：node scripts/deregister-plugin.mjs --plugin <name> [--profile <p>]... [--yes] [--no-verify]');
    console.log('注销插件在运行态 Profile 的全部引用（删除协议工具）。默认只读预检；--yes 才执行。');
    process.exit(0);
  }
}
if (!plugin) {
  console.error('[deregister-plugin] 缺少 --plugin <name>（如 @dsh-external/dsh-foo 或 dsh-foo）');
  process.exit(2);
}

// 归一化插件名
const unscoped = plugin.startsWith(SCOPED) ? plugin.slice(SCOPED.length) : plugin;
if (!/^dsh-/.test(unscoped) || CORE.has(plugin)) {
  console.error(`[deregister-plugin] 拒绝操作核心/非法包名: ${plugin}`);
  process.exit(2);
}
const scopedName = SCOPED + unscoped;

// ---------- 工具 ----------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function backup(pkgPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = process.env.DSH_BACKUPS_DIR || path.join(os.homedir(), '.dsh', '_backups');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `profile-${path.basename(path.dirname(pkgPath))}-package-dereg-${ts}.json`);
  fs.copyFileSync(pkgPath, dst);
  return dst;
}
function atomicWrite(pkgPath, data) {
  const tmp = pkgPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, pkgPath);
}
function getBundlesPath(pkg) {
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) return { pkg, parent: pkg.dsh.profile, key: 'bundles' };
  if (Array.isArray(pkg?.['dsh.profile']?.bundles)) return { pkg, parent: pkg['dsh.profile'], key: 'bundles' };
  return null;
}
function recycleDir(p) {
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${p.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}
function lstatInfo(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { let t; try { t = fs.readlinkSync(p); } catch { t = null; } return { kind: 'junction', target: t }; }
    if (st.isDirectory()) return { kind: 'copy', target: null };
    return { kind: 'other', target: null };
  } catch { return { kind: 'missing', target: null }; }
}
function listProfiles() {
  if (!fs.existsSync(PROFILE_ROOT)) return [];
  return fs.readdirSync(PROFILE_ROOT).filter((n) => {
    const d = path.join(PROFILE_ROOT, n);
    try { return fs.lstatSync(d).isDirectory() && fs.existsSync(path.join(d, 'package.json')); } catch { return false; }
  }).sort();
}

// ---------- 分析单个 profile 的引用 ----------
function analyzeProfile(profileName) {
  const profileDir = path.join(PROFILE_ROOT, profileName);
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  const refs = { deps: false, bundles: false, junction: null, copy: null, pkgPath, profileName };
  if (!pkg) return refs;

  const depSpec = pkg.dependencies?.[scopedName] || pkg.devDependencies?.[scopedName] || pkg.dependencies?.[unscoped] || pkg.devDependencies?.[unscoped];
  if (depSpec !== undefined) refs.deps = depSpec;

  const bp = getBundlesPath(pkg);
  if (bp && bp.parent[bp.key].includes(scopedName)) refs.bundles = true;

  const entry = path.join(profileDir, 'node_modules', '@dsh-external', unscoped);
  const info = lstatInfo(entry);
  if (info.kind === 'junction') refs.junction = { path: entry, target: info.target };
  else if (info.kind === 'copy') refs.copy = entry;
  return refs;
}

// ---------- 主流程：分析全部目标 profile ----------
const profiles = profilesArg.length ? profilesArg : listProfiles();
const analysis = profiles.map(analyzeProfile).filter((r) => r.deps || r.bundles || r.junction || r.copy);

if (!analysis.length) {
  console.log(`[deregister-plugin] ${scopedName} 在所有 profile 均无引用（已注销或从未装配）`);
  process.exit(0);
}

console.log(`[deregister-plugin] 目标: ${scopedName}  模式: ${yes ? '执行(--yes)' : '预检(只读)'}`);
for (const r of analysis) {
  console.log(`--- profile: ${r.profileName}`);
  if (r.deps) console.log(`  [deps]     ${scopedName} = ${r.deps}`);
  if (r.bundles) console.log(`  [bundles]  是（dsh.profile.bundles 含 ${scopedName}）`);
  if (r.junction) console.log(`  [junction] ${r.junction.path} -> ${r.junction.target}`);
  if (r.copy) console.log(`  [copy]     ${r.copy}（真实副本，非 junction，需人工处理）`);
}

if (!yes) {
  console.log('\n[预检完成] 以上为将清理项。加 --yes 执行（每步先备份，junction 走回收站，仅删链接）。');
  console.log('真实副本(copy)不会自动删除，需人工确认。');
  process.exit(0);
}

// ---------- 执行清理 ----------
let fail = false;
for (const r of analysis) {
  const pkg = readJson(r.pkgPath);
  if (!pkg) { console.error(`[deregister-plugin] 无法读取 ${r.pkgPath}，跳过`); fail = true; continue; }

  // 1) 备份
  const bk = backup(r.pkgPath);
  console.log(`[执行] ${r.profileName}: 已备份 -> ${bk}`);

  // 2) 移除 deps
  let changed = false;
  for (const sec of ['dependencies', 'devDependencies']) {
    if (pkg[sec] && pkg[sec][scopedName] !== undefined) { delete pkg[sec][scopedName]; changed = true; }
    if (pkg[sec] && pkg[sec][unscoped] !== undefined) { delete pkg[sec][unscoped]; changed = true; }
  }

  // 3) 移除 bundles 项
  const bp = getBundlesPath(pkg);
  if (bp) {
    const idx = bp.parent[bp.key].indexOf(scopedName);
    if (idx !== -1) { bp.parent[bp.key].splice(idx, 1); changed = true; }
  }

  if (changed) {
    atomicWrite(r.pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`[执行] ${r.profileName}: package.json 已更新（deps/bundles 引用已移除）`);
  } else {
    console.log(`[执行] ${r.profileName}: package.json 无引用改动（仅备份）`);
  }

  // 4) 移除 junction（仅删链接，target 保留，走回收站）
  if (r.junction) {
    if (recycleDir(r.junction.path)) {
      console.log(`[执行] ${r.profileName}: junction 已回收站删除（target 保留: ${r.junction.target}）`);
    } else {
      console.error(`[执行] ${r.profileName}: junction 回收站删除失败: ${r.junction.path}`);
      fail = true;
    }
  }
  // 真实副本：不自动删
  if (r.copy) {
    console.log(`[跳过] ${r.profileName}: 真实副本 ${r.copy} 未删除（非 junction，需人工确认）`);
  }
}

// ---------- 自动验证 ----------
if (!noVerify) {
  console.log('\n[验证] scan-dangling --strict ...');
  const v = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'scan-dangling.mjs'), '--strict'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, DSH_REPO: REPO, DSH_PROFILES_ROOT: PROFILE_ROOT },
  });
  console.log(v.stdout || v.stderr);
  if (v.status !== 0) { console.error('[验证] scan-dangling 检出问题，请人工核查'); fail = true; }
  else console.log('[验证] scan-dangling 通过（0 发现）');
} else {
  console.log('\n[跳过验证] --no-verify 已指定');
}

if (fail) { console.error('\n[deregister-plugin] 有步骤失败，请核查后重试'); process.exit(2); }
console.log('\n[deregister-plugin] 完成。建议再跑: node scripts/startup-verify.mjs 与 node scripts/check-all.ps1');
process.exit(0);
