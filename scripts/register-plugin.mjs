#!/usr/bin/env node
/**
 * scripts/register-plugin.mjs — 装配协议工具：把一个本地插件注册进 Profile 的全部 4 处。
 *
 * 背景（2026-09-11 G1 事故）：dsh-memory-files 上线时漏了「模板 profile」这一处，
 * startup-verify V2 直接报 runtime-only；且首次写运行态 package.json 时，Windows 路径的
 * 反斜杠被当成 JSON 转义，写出非法 JSON 把文件写坏（靠备份字节级还原救回）。
 * 本工具把「插件装配协议」（全局 AGENTS.md，4 处）做成半自动：默认只读预检，--yes 才执行。
 *
 * 4 处装配：
 *   1. 运行态 <profiles>/<p>/package.json  dependencies["@dsh-external/<n>"] = "link:<abs>"
 *   2. 运行态 <profiles>/<p>/package.json  dsh.profile.bundles 含 "@dsh-external/<n>"
 *   3. 运行态 <profiles>/<p>/node_modules/@dsh-external/<n> → junction → 插件目录
 *   4. 模板 <repo>/profile/<p>/package.json  dependencies + bundles
 *      （startup-verify V2 要求 template 与 runtime 的 bundles 集合完全一致）
 *      ⚠ 模板是源码工件，**不需要** junction（安装时由 npm i 生成）。
 *
 * 安全护栏（与 deregister-plugin.mjs 对称）：
 *   - 默认只读预检，--yes 才写
 *   - 全程持 task-scheduler 锁（写的是启动关键路径的共享文件）
 *   - 改前备份（sha256 记录）
 *   - ★ 先验后写：新内容必须 JSON.parse 通过才落盘（预检阶段验一次、写前再验一次）
 *   - 原子写（tmp + rename），不截断覆盖
 *   - 幂等：已存在的项跳过文本改写；但缺失的 junction 会补齐（局部注册可自愈）
 *   - 写后 5 项断言 + template/runtime bundles 集合相等断言（= V2 的定义）
 *   - 默认自动跑 startup-verify 验证（--no-verify 关闭）
 *   - ★ 所有写入文本一律用 JSON.stringify 生成 → 从根上消灭路径转义类 bug
 *
 * 锚点策略：@dsh-external/* 条目**未排序**，故采用「追加」语义 —— 在**最后一条**
 *   @dsh-external/* 元素行之后插入（无任何硬编码插件名依赖）；若该区块尚为空，则退回
 *   「区块起始行之后」插入，且不给起始行加逗号。新元素恒为「最后一条」→ 自身永不带尾逗号
 *   （JSON 不允许尾逗号）。
 *
 * 用法：
 *   node scripts/register-plugin.mjs --plugin dsh-foo                 # 预检（只读）
 *   node scripts/register-plugin.mjs --plugin dsh-foo --yes           # 预检后执行
 *   node scripts/register-plugin.mjs --plugin dsh-foo --yes --no-verify
 *   node scripts/register-plugin.mjs --plugin dsh-foo --profile desktop
 * 环境变量：DSH_PROFILES_ROOT（默认 ~/.dsh/profiles）、DSH_REPO（默认 cwd）、
 *          DSH_BACKUPS_DIR（备份目录覆盖，测试隔离用；默认 <repo>/_backups）
 * 退出码：0=完成/已注册；2=用法错误或锁失败；3=预检失败；4=执行中断。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/task-lock.mjs';

const PROFILE_ROOT = process.env.DSH_PROFILES_ROOT || path.join(os.homedir(), '.dsh', 'profiles');
const REPO = process.env.DSH_REPO || process.cwd();
const SCOPED = '@dsh-external/';

// ---------- 参数 ----------
const args = process.argv.slice(2);
let plugin = null;
let profileName = 'desktop';
let yes = false;
let noVerify = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--plugin') plugin = args[++i];
  else if (a === '--profile') profileName = args[++i];
  else if (a === '--yes') yes = true;
  else if (a === '--no-verify') noVerify = true;
  else if (a === '--help') {
    console.log('用法：node scripts/register-plugin.mjs --plugin <name> [--profile <p>] [--yes] [--no-verify]');
    console.log('把本地插件注册进 Profile 的全部 4 处（装配协议工具）。默认只读预检；--yes 才执行。');
    process.exit(0);
  } else if (!a.startsWith('--') && plugin === null) plugin = a;
}
if (!plugin) {
  console.error('[register-plugin] 缺少 --plugin <name>（如 @dsh-external/dsh-foo 或 dsh-foo）');
  process.exit(2);
}
if (!/^[\w.-]+$/.test(profileName)) {
  console.error(`[register-plugin] 非法 profile 名: ${profileName}`);
  process.exit(2);
}

// 归一化插件名
const unscoped = plugin.startsWith(SCOPED) ? plugin.slice(SCOPED.length) : plugin;
if (!/^dsh-/.test(unscoped)) {
  console.error(`[register-plugin] 拒绝非法包名（须以 dsh- 开头）: ${plugin}`);
  process.exit(2);
}
const scopedName = SCOPED + unscoped;

// ---------- 路径 ----------
const pluginDir = path.join(REPO, 'plugins', unscoped);
const profileDir = path.join(PROFILE_ROOT, profileName);
const runtimePkg = path.join(profileDir, 'package.json');
const extDir = path.join(profileDir, 'node_modules', '@dsh-external');
const junctionPath = path.join(extDir, unscoped);
const templatePkg = path.join(REPO, 'profile', profileName, 'package.json');
const LINK_VALUE = 'link:' + pluginDir; // 解析后的真实值（单反斜杠）

// ---------- 通用工具 ----------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function sha256(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// 备份目录名里的时间戳：**每次运行只取一次**（秒级精度）。
// 若在 backupFile() 内部各取一次，两次调用（runtime / template）跨过秒界时会把
// **同一次运行的备份拆成两个目录** —— 2026-09-12 门禁实测：`plugin-register-…-175740`
// 与 `…-175741` 并存，令 tests/plugins/register-plugin.test.mjs 的
// 「应恰好一个备份子目录」断言随机报红（与 O8g「恰好 1 个赢家」同族：时序脆弱）。
const RUN_TS = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

function backupFile(src, tag) {
  const dir = process.env.DSH_BACKUPS_DIR || path.join(REPO, '_backups');
  const sub = path.join(dir, `plugin-register-${unscoped}-${RUN_TS}`);
  fs.mkdirSync(sub, { recursive: true });
  const dst = path.join(sub, `${tag}.orig`);
  fs.copyFileSync(src, dst);
  return { dir: sub, file: dst, sha256: sha256(dst) };
}
function atomicWrite(p, data) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, p);
}
function getBundlesPath(pkg) {
  if (Array.isArray(pkg?.dsh?.profile?.bundles)) return { parent: pkg.dsh.profile, key: 'bundles' };
  if (Array.isArray(pkg?.['dsh.profile']?.bundles)) return { parent: pkg['dsh.profile'], key: 'bundles' };
  return null;
}
function lstatInfo(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { let t; try { t = fs.readlinkSync(p); } catch { t = null; } return { kind: 'junction', target: t }; }
    if (st.isDirectory()) return { kind: 'copy', target: null };
    return { kind: 'other', target: null };
  } catch { return { kind: 'missing', target: null }; }
}
function realpathOf(p) { try { return fs.realpathSync(p); } catch { return null; } }

const IS_DEP_LINE = (l) => /^\s*"@dsh-external\/[^"]+"\s*:/.test(l);
const IS_BND_LINE = (l) => /^\s*"@dsh-external\/[^"]+"\s*,?\s*$/.test(l);
const INDENT = '  ';
const indentOf = (s) => (s.match(/^\s*/) || [''])[0];

/** 元素行文本；key/value 全部经 JSON.stringify → 转义天然正确。缩进取自锚点行，保持文件风格。 */
function buildLine(kind, key, value, indent) {
  const ind = indent ?? INDENT;
  return kind === 'dep' ? `${ind}${JSON.stringify(key)}: ${JSON.stringify(value)}` : `${ind}${JSON.stringify(key)}`;
}

/**
 * 只读生成「追加后」的完整文本：{ ok, text } 或 { ok:false, reason }。绝不写盘。
 * 路径 A（常规）：已有同类元素 → 在最后一条之后追加；原最后一条补逗号，新条目为最后一条不带逗号。
 * 路径 B1：区块为「内联空」({} / []) → 展开为三行，唯一元素带尾逗号（其后是收尾符）。
 * 路径 B2：区块为「多行空」→ 在起始行后插入；仅当下一行不是收尾符时才带尾逗号。
 * （JSON 不允许尾逗号 —— 逗号归属由「其后是否还有元素」决定，与插入位置无关。）
 */
function planSplice(raw, kind, key, value) {
  const lines = raw.split(/\r?\n/);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const isElem = kind === 'dep' ? IS_DEP_LINE : IS_BND_LINE;
  const secName = kind === 'dep' ? 'dependencies' : 'bundles';
  const openCh = kind === 'dep' ? '{' : '[';
  const closeCh = kind === 'dep' ? '}' : ']';

  let lastElem = -1;
  for (let i = 0; i < lines.length; i++) if (isElem(lines[i])) lastElem = i;
  if (lastElem >= 0) {
    const ind = indentOf(lines[lastElem]);
    lines[lastElem] = lines[lastElem].replace(/,?\s*$/, ',');
    lines.splice(lastElem + 1, 0, buildLine(kind, key, value, ind));
    return { ok: true, text: lines.join(eol) };
  }

  const inlineRe = new RegExp('^(\\s*)"' + secName + '"\\s*:\\s*\\' + openCh + '\\s*\\' + closeCh + '\\s*(,?)\\s*$');
  const openRe = new RegExp('^(\\s*)"' + secName + '"\\s*:\\s*\\' + openCh + '\\s*$');
  for (let i = 0; i < lines.length; i++) {
    const mi = lines[i].match(inlineRe);
    if (mi) {
      // 展开内联空区块：新元素是唯一元素，其后紧跟收尾符 → 不带逗号（JSON 禁尾逗号）
      const el = buildLine(kind, key, value, mi[1] + INDENT);
      lines.splice(i, 1, `${mi[1]}"${secName}": ${openCh}`, el, `${mi[1]}${closeCh}${mi[2] || ''}`);
      return { ok: true, text: lines.join(eol) };
    }
    const mo = lines[i].match(openRe);
    if (mo) {
      const next = (lines[i + 1] ?? '').trim();
      const needComma = !(next === closeCh || next === closeCh + ',');
      lines.splice(i + 1, 0, buildLine(kind, key, value, mo[1] + INDENT) + (needComma ? ',' : ''));
      return { ok: true, text: lines.join(eol) };
    }
  }
  return { ok: false, reason: `未找到 "${secName}" 区块（既无同类元素行，也无区块起始行/内联空区块）` };
}

// ---------- 预检 ----------
const problems = [];
if (!fs.existsSync(path.join(pluginDir, 'package.json'))) problems.push(`插件目录缺少 package.json: ${pluginDir}`);
const pluginPkg = readJson(path.join(pluginDir, 'package.json'));
if (pluginPkg && pluginPkg.name !== scopedName) problems.push(`包名不匹配：插件 name=${pluginPkg.name}，期望 ${scopedName}`);
if (!fs.existsSync(runtimePkg)) problems.push(`运行态 profile package.json 不存在: ${runtimePkg}`);
if (!fs.existsSync(templatePkg)) problems.push(`模板 profile package.json 不存在: ${templatePkg}`);

if (problems.length) {
  console.error(`[register-plugin] 预检失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(3);
}

const runtimeRaw = fs.readFileSync(runtimePkg, 'utf8');
const templateRaw = fs.readFileSync(templatePkg, 'utf8');
const runtimeJson = readJson(runtimePkg);
const templateJson = readJson(templatePkg);
if (!runtimeJson || !templateJson) {
  console.error('[register-plugin] 预检失败：package.json 不是合法 JSON');
  process.exit(3);
}

function analyze(raw, json, label) {
  const bp = getBundlesPath(json);
  const cur = json.dependencies?.[scopedName];
  const depOk = cur === LINK_VALUE;
  const depOther = cur !== undefined && !depOk ? cur : null;
  const bndOk = bp ? bp.parent[bp.key].includes(scopedName) : false;
  const depSplice = depOk ? null : planSplice(raw, 'dep', scopedName, LINK_VALUE);
  const bndSplice = bndOk ? null : planSplice(raw, 'bnd', scopedName, LINK_VALUE);
  return { label, depOk, depOther, bndOk, hasBundles: !!bp, depSplice, bndSplice };
}
const rt = analyze(runtimeRaw, runtimeJson, 'runtime');
const tp = analyze(templateRaw, templateJson, 'template');
const jInfo = lstatInfo(junctionPath);
const junctionOk = jInfo.kind === 'junction' && realpathOf(junctionPath) === pluginDir;

// fail-closed：锚点定位失败 / 改写后 JSON 非法 → 预检即拒，绝不带病执行
for (const a of [rt, tp]) {
  for (const [k, s] of [['deps', a.depSplice], ['bundles', a.bndSplice]]) {
    if (!s) continue;
    if (!s.ok) { problems.push(`${a.label}: ${k} 无法定位插入锚点（${s.reason}）`); continue; }
    try { JSON.parse(s.text); } catch (e) { problems.push(`${a.label}: ${k} 改写后 JSON 非法（${String((e && e.message) || e)}）`); }
  }
  if (!a.hasBundles) problems.push(`${a.label}: 未找到 dsh.profile.bundles 数组`);
  if (a.depOther) problems.push(`${a.label}: ${scopedName} 已存在但值不同: ${a.depOther}`);
}
if (jInfo.kind === 'copy') problems.push(`junction 位置被真实副本占用（非链接，需人工处理）: ${junctionPath}`);
if (jInfo.kind === 'junction' && !junctionOk) problems.push(`junction 已存在但指向别处: ${junctionPath} → ${jInfo.target}（期望 ${pluginDir}）`);

if (problems.length) {
  console.error(`[register-plugin] 预检失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(3);
}

// ---------- 预检报告 ----------
const allOk = rt.depOk && rt.bndOk && tp.depOk && tp.bndOk && junctionOk;
console.log(`[register-plugin] 目标: ${scopedName}  profile: ${profileName}  模式: ${yes ? '执行(--yes)' : '预检(只读)'}`);
console.log(`  插件目录: ${pluginDir}`);
console.log('--- 4 处装配现状 ---');
console.log(`  1. runtime deps      ${rt.depOk ? '✔ 已装配' : '✘ 待写入  ' + LINK_VALUE}`);
console.log(`  2. runtime bundles   ${rt.bndOk ? '✔ 已装配' : '✘ 待写入'}`);
console.log(`  3. runtime junction  ${junctionOk ? '✔ 已装配' : (jInfo.kind === 'missing' ? '✘ 待创建  → ' + pluginDir : '✘ ' + jInfo.kind)}`);
console.log(`  4. template deps     ${tp.depOk ? '✔ 已装配' : '✘ 待写入  ' + LINK_VALUE}`);
console.log(`     template bundles  ${tp.bndOk ? '✔ 已装配' : '✘ 待写入'}`);

if (allOk) {
  console.log('\n[register-plugin] 4 处均已装配（幂等，无需改动）。');
  process.exit(0);
}
if (!yes) {
  console.log('\n[预检完成] 加 --yes 执行（持锁 → 备份 → 先验后写 → 原子写 → 建 junction → 断言 → 验证）。');
  process.exit(0);
}

// ---------- 执行 ----------
const lockResources = [runtimePkg, junctionPath, templatePkg];
const lock = await acquireLock({
  resources: lockResources,
  who: 'register-plugin:' + unscoped,
  task: 'register ' + scopedName + '（4 处装配：runtime deps/bundles/junction + template deps/bundles）',
  waitMs: 3000,
  ttlMs: 600000,
});
if (!lock.ok && process.env.DSH_ALLOW_UNLOCKED === '1') {
  console.error('[register-plugin] DSH_ALLOW_UNLOCKED=1：锁获取失败仍继续（' + (lock.holder ? JSON.stringify(lock.holder) : lock.error) + '）');
} else if (!lock.ok) {
  console.error('[register-plugin] 无法获取写锁，拒绝执行（fail-closed，DATA-4）。');
  console.error('  资源: ' + lockResources.join(' ; '));
  if (lock.holder) console.error('  持有者: ' + JSON.stringify(lock.holder));
  if (lock.error) console.error('  通道错误: ' + lock.error);
  console.error('  排查: node scripts/task-scheduler.mjs status ；紧急逃生: DSH_ALLOW_UNLOCKED=1 重跑');
  process.exit(2);
}

let fail = false;
const written = [];
try {
  const needRuntime = !rt.depOk || !rt.bndOk;
  const needTemplate = !tp.depOk || !tp.bndOk;

  // 1) 备份（仅对确定要改写的文件）
  if (needRuntime) console.log(`[执行] 已备份 runtime -> ${backupFile(runtimePkg, 'runtime.package.json').file}`);
  if (needTemplate) console.log(`[执行] 已备份 template -> ${backupFile(templatePkg, 'template.package.json').file}`);

  // 2) 写 runtime（先验后写 + 原子写）
  if (needRuntime) {
    let text = runtimeRaw;
    if (!rt.depOk) { const s = planSplice(text, 'dep', scopedName, LINK_VALUE); if (!s.ok) throw new Error('runtime deps: ' + s.reason); text = s.text; }
    if (!rt.bndOk) { const s = planSplice(text, 'bnd', scopedName, LINK_VALUE); if (!s.ok) throw new Error('runtime bundles: ' + s.reason); text = s.text; }
    try { JSON.parse(text); } catch (e) { throw new Error(`拒绝写入非法 JSON（runtime）: ${String((e && e.message) || e)}`); }
    atomicWrite(runtimePkg, text);
    written.push(runtimePkg);
    console.log('[执行] runtime package.json 已更新（deps + bundles）');
  } else {
    console.log('[执行] runtime package.json 无需改写（已装配）');
  }

  // 3) 写 template
  if (needTemplate) {
    let text = templateRaw;
    if (!tp.depOk) { const s = planSplice(text, 'dep', scopedName, LINK_VALUE); if (!s.ok) throw new Error('template deps: ' + s.reason); text = s.text; }
    if (!tp.bndOk) { const s = planSplice(text, 'bnd', scopedName, LINK_VALUE); if (!s.ok) throw new Error('template bundles: ' + s.reason); text = s.text; }
    try { JSON.parse(text); } catch (e) { throw new Error(`拒绝写入非法 JSON（template）: ${String((e && e.message) || e)}`); }
    atomicWrite(templatePkg, text);
    written.push(templatePkg);
    console.log('[执行] template package.json 已更新（deps + bundles）');
  } else {
    console.log('[执行] template package.json 无需改写（已装配）');
  }

  // 4) junction（缺失则自愈）
  if (!junctionOk) {
    if (jInfo.kind === 'missing') {
      fs.mkdirSync(extDir, { recursive: true });
      fs.symlinkSync(pluginDir, junctionPath, 'junction');
      console.log(`[执行] junction 已创建 → ${pluginDir}`);
    } else if (jInfo.kind === 'junction') {
      throw new Error(`junction 指向别处，拒绝覆盖: ${junctionPath} → ${jInfo.target}`);
    } else {
      throw new Error(`junction 位置被 ${jInfo.kind} 占用，需人工处理: ${junctionPath}`);
    }
  } else {
    console.log('[执行] junction 已存在，无需创建');
  }

  // 5) 写后断言（全部基于 JSON.parse 后的真实值）
  const r2 = readJson(runtimePkg);
  const t2 = readJson(templatePkg);
  if (!r2 || !t2) throw new Error('写后 JSON 解析失败');
  const checks = [
    ['runtime dep', r2.dependencies?.[scopedName] === LINK_VALUE],
    ['runtime bundle', getBundlesPath(r2)?.parent?.bundles?.includes(scopedName) === true],
    ['template dep', t2.dependencies?.[scopedName] === LINK_VALUE],
    ['template bundle', getBundlesPath(t2)?.parent?.bundles?.includes(scopedName) === true],
    ['junction', realpathOf(junctionPath) === pluginDir],
  ];
  for (const [name, ok] of checks) {
    console.log(`[断言] ${name}: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) fail = true;
  }

  // 6) 关键一致性断言：template 与 runtime 的 bundles 集合相等（= startup-verify V2 的定义）
  const tb = new Set(getBundlesPath(t2)?.parent?.bundles || []);
  const rb = new Set(getBundlesPath(r2)?.parent?.bundles || []);
  const onlyT = [...tb].filter((b) => !rb.has(b));
  const onlyR = [...rb].filter((b) => !tb.has(b));
  const same = onlyT.length === 0 && onlyR.length === 0;
  console.log(`[断言] template==runtime bundles: ${same ? 'PASS' : 'FAIL'}（template ${tb.size} / runtime ${rb.size}）`);
  if (!same) {
    console.error(`  template-only: ${JSON.stringify(onlyT)}`);
    console.error(`  runtime-only:  ${JSON.stringify(onlyR)}`);
    fail = true;
  }
} catch (e) {
  console.error(`[register-plugin] 执行中断: ${String((e && e.message) || e)}`);
  if (written.length) console.error(`  已写入文件（可从 _backups/plugin-register-* 还原）: ${written.join(', ')}`);
  fail = true;
} finally {
  // 7) 自动验证
  if (!noVerify) {
    console.log('\n[验证] startup-verify ...');
    const v = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'startup-verify.mjs')], {
      cwd: REPO, encoding: 'utf8', env: { ...process.env, DSH_REPO: REPO, DSH_PROFILES_ROOT: PROFILE_ROOT },
    });
    console.log(((v.stdout || '') + (v.stderr || '')).trim());
    if (v.status !== 0) { console.error('[验证] startup-verify 未通过，请人工核查'); fail = true; }
    else console.log('[验证] startup-verify 通过');
  } else {
    console.log('\n[跳过验证] --no-verify 已指定');
  }

  if (lock.ok) {
    const rel = await releaseLock({
      resources: lockResources, token: lock.token, who: 'register-plugin:' + unscoped,
      summary: `register ${scopedName}` + (fail ? '（有失败步骤）' : ' 完成'),
    });
    console.log('[锁] 已释放（' + rel.channel + (rel.ok ? '' : '；释放失败: ' + (rel.error || 'unknown')) + '）');
  }
}

if (fail) { console.error('\n[register-plugin] 有步骤失败，请核查后重试（备份见 _backups/plugin-register-*）'); process.exit(4); }
console.log('\n[register-plugin] 完成。重启 DSH 后生效；建议再跑 node scripts/check-all.ps1');
process.exit(0);
