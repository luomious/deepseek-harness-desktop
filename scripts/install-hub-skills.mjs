/**
 * install-hub-skills.mjs — CAP-1：hub skill 本地直装（幂等 / 可回滚 / 可扩展）
 *
 * 设计要点：
 *   - 选单外置：scripts/hub-skills.selection.json（增删只改 JSON，不动脚本）
 *   - 单向复制：tools/dsh-skills-hub/skills/<name> → ~/.dsh/skills/<name>
 *     （rank400 用户目录，官方 watcher 热更新：新增 SKILL.md 无需重启）
 *   - 幂等：内容一致跳过；不一致按选单覆盖（hub 是唯一事实源）
 *   - 只装不删：卸载/回滚必须显式 --remove <name>，且只删 manifest 登记过的文件
 *   - 审计：~/.dsh/skills/.hub-install-manifest.json 记录每次安装的 hash/时间/文件清单
 *   - 校验：安装前跑 frontmatter 合规检查（name/dir 一致、desc ≤500、fail-closed 字段）
 *
 * 用法：
 *   node scripts/install-hub-skills.mjs            # 安装选单内全部
 *   node scripts/install-hub-skills.mjs --dry-run  # 只看计划不落盘
 *   node scripts/install-hub-skills.mjs --remove <name>  # 回滚单个（仅限 manifest 登记的）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const HUB = join(ROOT, 'tools', 'dsh-skills-hub', 'skills');
const TARGET = join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'skills');
const SELECTION = join(ROOT, 'scripts', 'hub-skills.selection.json');
const MANIFEST = join(TARGET, '.hub-install-manifest.json');

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DESC_MAX = 500;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const removeIdx = args.indexOf('--remove');

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(p);
  }
  return out;
}

function validateSkill(src) {
  const name = src.name;
  const errors = [];
  const file = join(HUB, name, 'SKILL.md');
  if (!existsSync(file)) { errors.push('SKILL.md missing'); return errors; }
  const fm = (readFileSync(file, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
  const nm = fm.match(/^name:\s*(\S+)/m)?.[1];
  if (!nm) errors.push('name missing');
  else if (nm !== name || !KEBAB.test(nm)) errors.push(`bad name "${nm}"`);
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!desc) errors.push('description missing');
  else if (desc.length > DESC_MAX) errors.push(`description ${desc.length} > ${DESC_MAX}`);
  for (const f of ['disable-model-invocation', 'user-invocable']) {
    const v = fm.match(new RegExp(`^${f}:\\s*(.*)$`, 'm'))?.[1]?.trim();
    if (v !== undefined && v !== 'true' && v !== 'false') errors.push(`${f} non-boolean (fail-closed)`);
  }
  if (/^disable_model_invocation:/m.test(fm) || /^user_invocable:/m.test(fm)) errors.push('snake_case invocation field (fail-closed)');
  return errors;
}

function copyDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = join(srcDir, e.name), d = join(dstDir, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else { mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, readFileSync(s)); }
  }
}

function main() {
  if (!existsSync(SELECTION)) { console.error(`selection not found: ${SELECTION}`); process.exit(1); }
  const sel = JSON.parse(readFileSync(SELECTION, 'utf-8'));
  const skills = sel.skills || [];
  console.log(`[install-hub-skills] selection v${sel.version || '?'} — ${skills.length} skills`);

  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf-8')) : { installedAt: new Date().toISOString(), skills: {} };

  // 回滚模式：只删 manifest 登记过、且当前仍在选单外（或显式指定）的 skill
  if (removeIdx >= 0) {
    const name = args[removeIdx + 1];
    if (!name || !manifest.skills[name]) { console.error(`--remove: "${name}" 不在 manifest 中，拒绝删除未登记内容`); process.exit(1); }
    const dst = join(TARGET, name);
    if (dryRun) { console.log(`[dry-run] would remove ${dst} (files: ${manifest.skills[name].files.join(', ')})`); return; }
    rmSync(dst, { recursive: true, force: true });
    delete manifest.skills[name];
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(`[install-hub-skills] removed ${name}（仅 manifest 登记内容）`);
    return;
  }

  let ok = 0, skip = 0;
  for (const name of skills) {
    const src = join(HUB, name);
    const dst = join(TARGET, name);
    if (!existsSync(src)) { console.error(`  FAIL ${name}: hub 源不存在`); continue; }
    const errs = validateSkill({ name });
    if (errs.length) { console.error(`  FAIL ${name}: ${errs.join('; ')}`); continue; }

    const files = listFiles(src).map((f) => f.slice(src.length + 1));
    const hash = sha256(readFileSync(join(src, 'SKILL.md')));
    const prev = manifest.skills[name];
    if (prev && prev.hash === hash && existsSync(dst)) { skip++; console.log(`  SKIP ${name} (unchanged)`); continue; }

    if (dryRun) { console.log(`  [dry-run] would install ${name} (${files.length} files)`); ok++; continue; }
    copyDir(src, dst);
    manifest.skills[name] = {
      source: 'tools/dsh-skills-hub/skills/' + name,
      hash,
      files,
      installedAt: new Date().toISOString(),
      selectionVersion: sel.version || null,
    };
    ok++;
    console.log(`  INSTALL ${name} (${files.length} files)`);
  }

  if (!dryRun) {
    manifest.updatedAt = new Date().toISOString();
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  }
  console.log(`[install-hub-skills] done: ${ok} installed/skip-planned, ${skills.length - ok - skip} failed, ${skip} unchanged`);
}

main();
