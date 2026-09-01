#!/usr/bin/env node
/**
 * scripts/scan-dangling.mjs — 只读扫描 DSH profiles 的 @dsh-external 悬空/孤儿引用。
 *
 * 语义对齐（与 scripts/startup-verify.mjs V1/V4 及 apply-profile-guard.mjs 注入的
 * dshCheckProfileIntegrity 一致）：
 *   - node_modules 实体（junction / 真实副本）为加载依据，权威优先；
 *   - junction 存在但 target 缺失       -> DANGLING（启动风险，V1 会抓）
 *   - 声明 file:/link: 但 node_modules 实体缺失且 target 缺失 -> DANGLING
 *   - 真实副本存在但 file: 声明 target 缺失 -> STALE-DECL（低，无启动风险）
 *   - node_modules/@dsh-external 实体但未声明（deps 或 bundles 均无）-> ORPHAN（低）
 *   - 核心 bundle（@deepseek-ai/dsh-base / dsh-web-app）由构建产物
 *     .../app.asar.unpacked/node_modules 提供 -> INFO/covered（非问题）
 *   - 相对路径 file:（如 dsh-mcp-lens-0.1.0-rc.9.tgz）相对 profile 目录解析。
 *
 * 纯只读：不修改任何文件。退出码：默认 0（报告用）；--strict 时发现 DANGLING 返回 1。
 *
 * 用法：
 *   node scripts/scan-dangling.mjs                      # 扫描全部 profiles
 *   node scripts/scan-dangling.mjs --profile desktop    # 仅指定 profile（可重复）
 *   node scripts/scan-dangling.mjs --json               # JSON 输出（便于脚本消费）
 *   node scripts/scan-dangling.mjs --strict             # 有 DANGLING 时退出码 1
 *   node scripts/scan-dangling.mjs --plan               # 追加「修复预演」清单（只读，不执行）
 * 环境变量：DSH_PROFILES_ROOT（默认 ~/.dsh/profiles）、DSH_REPO（默认 cwd）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROFILE_ROOT = process.env.DSH_PROFILES_ROOT || path.join(os.homedir(), '.dsh', 'profiles');
const REPO = process.env.DSH_REPO || process.cwd();
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const SCOPED_PREFIX = '@dsh-external/';

// ---------- 参数 ----------
const args = process.argv.slice(2);
const profilesArg = [];
let jsonOut = false;
let strict = false;
let plan = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--profile') profilesArg.push(args[++i]);
  else if (a === '--json') jsonOut = true;
  else if (a === '--strict') strict = true;
  else if (a === '--plan') plan = true;
  else if (a === '--help') {
    console.log('用法：node scripts/scan-dangling.mjs [--profile <name>]... [--json] [--strict] [--plan]');
    console.log('只读扫描 profiles 的 @dsh-external 悬空/孤儿引用。DSH_PROFILES_ROOT / DSH_REPO 可覆盖默认路径。');
    console.log('--plan: 输出可操作修复预演（只列出清理/修复动作，不执行任何写入）。');
    process.exit(0);
  }
}

// ---------- 工具 ----------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function entryPath(profileDir, name) {
  if (name.startsWith('@')) {
    const [, scope, n] = name.match(/^(@[^/]+)\/(.+)$/) || [];
    return path.join(profileDir, 'node_modules', scope, n);
  }
  return path.join(profileDir, 'node_modules', name);
}
function lstatInfo(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      let t;
      try { t = fs.readlinkSync(p); } catch { t = null; }
      return { kind: 'junction', target: t };
    }
    if (st.isDirectory()) return { kind: 'copy', target: null };
    return { kind: 'other', target: null };
  } catch { return { kind: 'missing', target: null }; }
}
function profileBundles(pkg) {
  // 兼容嵌套 "dsh": { "profile": {...} } 与历史点号键 "dsh.profile" 两种形态
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) return pkg.dsh.profile.bundles;
  if (Array.isArray(pkg?.['dsh.profile']?.bundles)) return pkg['dsh.profile'].bundles;
  return [];
}
function listProfiles() {
  if (!fs.existsSync(PROFILE_ROOT)) return [];
  return fs.readdirSync(PROFILE_ROOT).filter((n) => {
    const d = path.join(PROFILE_ROOT, n);
    try { return fs.lstatSync(d).isDirectory() && fs.existsSync(path.join(d, 'package.json')); } catch { return false; }
  }).sort();
}
/** 核心 bundle 由构建产物提供：遍历 win-unpacked + 最新 win-unpacked-build*，
 *  兼容两种布局：<build>/resources/app.asar.unpacked 与 <build>/win-unpacked/resources/app.asar.unpacked（嵌套构建）。
 *  注意：base 本身已是 node_modules 目录，直接用 path.join 拼包名，勿复用 entryPath（会多拼一层 node_modules）。 */
function resolveBuildBundle(name) {
  const distDir = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist');
  const candidates = [];
  try {
    const builds = fs.readdirSync(distDir)
      .filter((n) => /^win-unpacked(?:-build\d+)?$/.test(n))
      .sort((a, b) => {
        const ma = a.match(/-build(\d+)$/); const mb = b.match(/-build(\d+)$/);
        const ra = ma ? +ma[1] : -1; const rb = mb ? +mb[1] : -1;
        return rb - ra; // buildN 优先；纯 win-unpacked（别名，-1）垫底
      });
    for (const b of builds) {
      candidates.push(
        path.join(distDir, b, 'resources', 'app.asar.unpacked', 'node_modules'),
        path.join(distDir, b, 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules'),
      );
    }
  } catch { /* dist 不存在则无候选 */ }
  for (const base of candidates) {
    const p = path.join(base, ...name.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- 单 profile 扫描 ----------
function scanProfile(profileName) {
  const profileDir = path.join(PROFILE_ROOT, profileName);
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  const findings = [];
  const declaredNames = new Set();
  const bundles = [];

  if (!pkg) {
    return { profile: profileName, error: `package.json 缺失或非法: ${pkgPath}`, findings: [] };
  }

  bundles.push(...profileBundles(pkg));
  const allDeclared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...bundles,
  ]);
  allDeclared.forEach((n) => declaredNames.add(n));

  // 1) 声明的 file:/link: 依赖
  for (const [name, spec] of Object.entries({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
    if (typeof spec !== 'string' || !/^(file|link):/i.test(spec)) continue;
    let target = spec.replace(/^(file|link):/i, '');
    if (!path.isAbsolute(target)) target = path.resolve(profileDir, target);

    const entry = entryPath(profileDir, name);
    const info = lstatInfo(entry);

    // 核心 bundle：由构建产物提供
    if (CORE_BUNDLES.has(name)) {
      const bp = resolveBuildBundle(name);
      findings.push({
        severity: bp ? 'INFO' : 'DANGLING',
        name, scope: profileName, kind: 'core-bundle',
        declaredTarget: target, nodeModulesEntry: entry,
        message: bp
          ? `核心 bundle 由构建产物解析（${path.relative(REPO, bp)}）`
          : '核心 bundle 在构建产物 app.asar.unpacked/node_modules 未找到（需重建或检查 dist）',
      });
      continue;
    }

    if (info.kind === 'junction') {
      const tAbs = info.target && path.isAbsolute(info.target) ? info.target : (info.target ? path.resolve(path.dirname(entry), info.target) : null);
      if (!tAbs || !fs.existsSync(tAbs)) {
        findings.push({
          severity: 'DANGLING', name, scope: profileName, kind: 'junction-target-missing',
          declaredTarget: target, nodeModulesEntry: entry, junctionTarget: info.target,
          message: `junction 存在但 target 缺失（${info.target}），启动可能报 cannot resolve package`,
        });
      }
    } else if (info.kind === 'copy') {
      if (!fs.existsSync(target)) {
        findings.push({
          severity: 'STALE-DECL', name, scope: profileName, kind: 'stale-file-decl',
          declaredTarget: target, nodeModulesEntry: entry,
          message: `真实副本在 node_modules，加载安全；但声明的 file: 目标缺失（${target}），属陈旧声明`,
        });
      }
    } else { // missing
      if (!fs.existsSync(target)) {
        findings.push({
          severity: 'DANGLING', name, scope: profileName, kind: 'decl-missing',
          declaredTarget: target, nodeModulesEntry: entry,
          message: `声明了 ${spec} 但 node_modules 实体与声明目标均缺失`,
        });
      } else {
        findings.push({
          severity: 'NOT-INSTALLED', name, scope: profileName, kind: 'decl-not-installed',
          declaredTarget: target, nodeModulesEntry: entry,
          message: '声明目标存在但未安装到 node_modules（惰性/未装配，不阻塞）',
        });
      }
    }
  }

  // 2) node_modules/@dsh-external 未声明实体（孤儿）
  const extDir = path.join(profileDir, 'node_modules', '@dsh-external');
  if (fs.existsSync(extDir)) {
    for (const name of fs.readdirSync(extDir)) {
      const key = SCOPED_PREFIX + name;
      if (declaredNames.has(key)) continue;
      const full = path.join(extDir, name);
      const info = lstatInfo(full);
      findings.push({
        severity: 'ORPHAN', name: key, scope: profileName,
        kind: info.kind === 'junction' ? 'orphan-junction' : 'orphan-entry',
        nodeModulesEntry: full, junctionTarget: info.target,
        message: info.kind === 'junction'
          ? `未声明孤儿 junction（target=${info.target}），注销残留，可安全清理`
          : '未声明孤儿条目（真实副本），非 junction，清理前需确认',
      });
    }
  }

  return { profile: profileName, pkgPath, bundles: bundles.length, findings };
}

// ---------- 修复预演（只读，列出动作不执行） ----------
/** 把一条发现映射为可执行动作。返回 { action, target, cmd } 或 null（无可操作项）。 */
function buildPlan(f) {
  switch (f.kind) {
    case 'orphan-junction':
      return {
        action: '回收站删除未声明孤儿 junction（target 存在，仅删链接）',
        target: f.nodeModulesEntry,
        cmd: `Remove-Item "${f.nodeModulesEntry}" -Force  # 已重定向回收站`,
      };
    case 'orphan-entry':
      return {
        action: '未声明真实副本（非 junction），需人工确认后删除',
        target: f.nodeModulesEntry,
        cmd: null,
      };
    case 'junction-target-missing':
    case 'decl-missing':
      return {
        action: '移除悬空引用：运行 startup-verify --repair（先备份两份）',
        target: f.nodeModulesEntry || f.declaredTarget,
        cmd: 'node scripts/startup-verify.mjs --repair',
      };
    case 'stale-file-decl':
      return {
        action: '移除失效 file: 声明（保留 node_modules 真实副本）',
        target: f.declaredTarget,
        cmd: null, // 手工编辑 package.json；副本仍在加载不受影响
      };
    case 'core-bundle':
      return f.severity === 'DANGLING'
        ? { action: '核心 bundle 缺失：重建 dist 或检查构建产物', target: f.nodeModulesEntry, cmd: '见 docs/BUILD.md' }
        : null;
    default:
      return null;
  }
}

// ---------- 主流程 ----------
const profiles = profilesArg.length ? profilesArg : listProfiles();
if (!profiles.length) {
  console.error(`[scan-dangling] 未找到 profile（DSH_PROFILES_ROOT=${PROFILE_ROOT}）`);
  process.exit(2);
}

const results = profiles.map(scanProfile);
const allFindings = results.flatMap((r) => r.findings);
const count = (sev) => allFindings.filter((f) => f.severity === sev).length;
const dangles = allFindings.filter((f) => f.severity === 'DANGLING');

const SEVERITY_ORDER = ['DANGLING', 'STALE-DECL', 'ORPHAN', 'NOT_INSTALLED', 'INFO'];
const summary = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, count(s)]));
const planItems = plan ? allFindings.map(buildPlan).filter(Boolean) : [];

if (jsonOut) {
  console.log(JSON.stringify({ profiles: results, summary, plan: planItems }, null, 2));
} else {
  console.log(`[scan-dangling] DSH_PROFILES_ROOT=${PROFILE_ROOT}`);
  console.log(`[scan-dangling] 扫描 profiles: ${profiles.join(', ')}`);
  console.log('--- 发现 ---');
  if (!allFindings.length) console.log('（无任何发现）');
  for (const f of allFindings) {
    const tag = f.severity.padEnd(12);
    console.log(`[${tag}] ${f.scope}  ${f.name}  (${f.kind})  ${f.message}`);
  }
  console.log('--- 汇总 ---');
  console.log(SEVERITY_ORDER.map((s) => `${s}=${summary[s]}`).join('  '));
  if (plan) {
    console.log('--- 修复预演（只读，--plan 不执行任何写入） ---');
    if (!planItems.length) console.log('（无待处理项）');
    for (const p of planItems) {
      console.log(`  * [${p.action}]`);
      console.log(`      target: ${p.target}`);
      if (p.cmd) console.log(`      cmd:    ${p.cmd}`);
    }
  }
}

process.exit(strict && dangles.length ? 1 : 0);
