#!/usr/bin/env node
// cleanup-nested-skills.mjs - remove stray SKILL.md / _source.json copies nested below level 1
//
// Why: a recursive install (or a copy gone wrong) can leave whole skill trees
// nested inside another skill directory, e.g.
//   ~/.dsh/skills/test-generator/code-review/chinese-code-review/.../SKILL.md
// DSH only scans one level deep, so these are inert, but they bloat the root,
// confuse audits, and would double-register if discovery ever became recursive.
//
// Residue set = SKILL.md + _source.json:
//   _source.json is a per-skill provenance file that is legitimate at depth 1 only.
//   At depth >= 2 it is residue of the same bad recursive copy.
//   Blind spot being closed: an earlier pass removed the nested SKILL.md files but
//   left 11 levels of empty dirs plus 2 orphan _source.json behind, because the
//   empty-dir sweep cannot prune a dir that still holds a file (found 0 nested
//   SKILL.md, yet the chain survived). Both names are treated identically now.
//
// Safety:
//   - default is DRY RUN (report only); --apply is required to change anything
//   - every removed file is copied to a flat backup dir BEFORE removal
//   - long Windows paths are handled with the \\?\ prefix
//   - per-item try/catch; one failure never aborts or corrupts the rest
//
// Usage:
//   node scripts/cleanup-nested-skills.mjs
//   node scripts/cleanup-nested-skills.mjs --apply --backup <dir>
//   node scripts/cleanup-nested-skills.mjs --root <dir>

import { existsSync, copyFileSync, rmSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';

const RESIDUE = new Set(['SKILL.md', '_source.json']);

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const rootArg = argv.indexOf('--root');
const backupArg = argv.indexOf('--backup');
const root = resolve(rootArg !== -1 && argv[rootArg + 1] ? argv[rootArg + 1] : join(homedir(), '.dsh', 'skills'));
const backup = resolve(
  backupArg !== -1 && argv[backupArg + 1]
    ? argv[backupArg + 1]
    : join(root, '..', `_nested-skill-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`)
);

const long = (p) => (p.startsWith('\\\\?\\') ? p : `\\\\?\\${p}`);

function findNested(dir, depth, acc) {
  let entries = [];
  try {
    entries = readdirSync(long(dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      findNested(p, depth + 1, acc);
    } else if (e.isFile() && RESIDUE.has(e.name) && depth >= 2) {
      acc.push({ path: p, rel: p.slice(root.length + 1), depth });
    }
  }
}

// depth starts at 0 for the root itself: a SKILL.md directly inside
// <root>/<skill>/ is depth 1 and is legitimate; depth >= 2 is nested pollution.
const nested = [];
findNested(root, 0, nested);

console.log(`nested skill cleanup  (mode: ${apply ? 'APPLY' : 'DRY RUN'})`);
console.log(`root    ${root}`);
console.log(`backup  ${backup}`);
console.log(`found   ${nested.length} nested residue file(s)  [${[...RESIDUE].join(', ')}]`);
nested
  .slice()
  .sort((a, b) => b.depth - a.depth)
  .forEach((n) => console.log(`  d${n.depth}  ${n.rel}`));

if (!apply) {
  console.log('\nno changes made. re-run with --apply to remove (files are backed up first).');
  process.exit(nested.length > 0 ? 0 : 0);
}

if (nested.length === 0) {
  console.log('\nnothing to do.');
  process.exit(0);
}

mkdirSync(backup, { recursive: true });
const log = [];
let ok = 0;
let failed = 0;

for (const n of nested.slice().sort((a, b) => b.depth - a.depth)) {
  const flat = n.rel.replace(/[\\/]/g, '__');
  const dest = join(backup, flat);
  try {
    copyFileSync(long(n.path), dest);
    rmSync(long(n.path), { force: true });
    log.push(`OK    copied+removed  ${n.rel}  ->  ${flat}`);
    ok++;
  } catch (err) {
    log.push(`FAIL  ${n.rel}  ${err && err.message}`);
    failed++;
  }
}

// remove now-empty directories, deepest first
const dirs = [...new Set(nested.flatMap((n) => {
  const parts = n.rel.split(/[\\/]/).slice(0, -1);
  const out = [];
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    out.push(cur);
  }
  return out;
}))].sort((a, b) => b.split('/').length - a.split('/').length);

for (const d of dirs) {
  const abs = join(root, d);
  try {
    const left = readdirSync(long(abs));
    if (left.length === 0) {
      rmSync(long(abs), { recursive: true, force: true });
      log.push(`OK    removed empty dir  ${d}`);
    } else {
      log.push(`SKIP  dir not empty  ${d}  (${left.join(', ')})`);
    }
  } catch (err) {
    log.push(`SKIP  dir ${d}  ${err && err.message}`);
  }
}

writeFileSync(join(backup, '_cleanup.log'), log.join('\n'), 'utf8');
console.log(`\nremoved ${ok}, failed ${failed}`);
console.log(`backup dir: ${backup}`);
console.log(`log: ${join(backup, '_cleanup.log')}`);
process.exit(failed > 0 ? 1 : 0);
