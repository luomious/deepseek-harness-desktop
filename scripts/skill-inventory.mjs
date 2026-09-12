#!/usr/bin/env node
// skill-inventory.mjs - read-only audit of the user-level skill root (~/.dsh/skills)
//
// Why: skills accumulate through several paths (hub installer, market page,
// manual copy). The hub manifest only records what *it* installed, so most
// skills end up with no recorded provenance and no rollback path. This script
// makes that state visible and repeatable instead of a one-off manual list.
//
// Detects:
//   - skills with no SKILL.md (broken install)
//   - nested SKILL.md copies below the first level (installer runaway / pollution)
//   - skills absent from .hub-install-manifest.json (untracked provenance)
//   - duplicate descriptions (overlap candidates)
//   - missing metadata frontmatter, oversized bodies
//
// Usage:
//   node scripts/skill-inventory.mjs                 # human summary
//   node scripts/skill-inventory.mjs --json          # full JSON
//   node scripts/skill-inventory.mjs --strict        # exit 1 on pollution/untracked
//   node scripts/skill-inventory.mjs --root <dir>    # audit another root
//
// Writes <root>/.skill-inventory.json (audit ledger, safe to regenerate).

import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const rootArg = argv.indexOf('--root');
const root = rootArg !== -1 && argv[rootArg + 1] ? argv[rootArg + 1] : join(homedir(), '.dsh', 'skills');

const manifestPath = join(root, '.hub-install-manifest.json');
let tracked = new Set();
let manifestOk = false;
if (existsSync(manifestPath)) {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    tracked = new Set(Object.keys(m.skills || {}));
    manifestOk = true;
  } catch {
    manifestOk = false;
  }
}

function readFrontmatter(file) {
  const txt = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/);
  let name = null;
  let description = null;
  let hasMetadata = false;
  let bodyLines = lines.length;
  if (lines[0] && lines[0].trim() === '---') {
    let i = 1;
    while (i < lines.length && lines[i].trim() !== '---') {
      const l = lines[i];
      const nm = l.match(/^name:\s*(.+)$/);
      if (nm) name = nm[1].trim();
      const dm = l.match(/^description:\s*(.*)$/);
      if (dm) {
        const v = dm[1].trim();
        if (/^[|>][-+]?$/.test(v)) {
          // YAML block scalar: value lives on the following indented lines.
          const buf = [];
          let j = i + 1;
          while (j < lines.length && /^\s+\S/.test(lines[j])) {
            buf.push(lines[j].trim());
            j++;
          }
          description = buf.join(' ');
        } else {
          description = v;
        }
      }
      if (/^metadata\s*:/.test(l)) hasMetadata = true;
      i++;
    }
    bodyLines = Math.max(0, lines.length - i - 1);
  }
  return { name, description: description || '', hasMetadata, bodyLines, bytes: statSync(file).size };
}

// Long nested chains exceed what plain readdirSync handles reliably on Windows,
// so every directory read goes through the \\?\ prefix.
const long = (p) => (p.startsWith('\\\\?\\') ? p : `\\\\?\\${p}`);

function walk(dir, depth, acc) {
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
      walk(p, depth + 1, acc);
    } else if (e.isFile() && e.name === 'SKILL.md' && depth >= 2) {
      acc.push(p);
    }
  }
}

const top = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .sort();

const skills = top.map((name) => {
  const dir = join(root, name);
  const file = join(dir, 'SKILL.md');
  const rec = { name, hasSkill: existsSync(file), tracked: tracked.has(name) };
  if (rec.hasSkill) {
    try {
      const fm = readFrontmatter(file);
      rec.frontmatterName = fm.name;
      rec.nameMatchesDir = fm.name === name;
      rec.description = fm.description.slice(0, 160);
      rec.hasMetadata = fm.hasMetadata;
      rec.bodyLines = fm.bodyLines;
      rec.bytes = fm.bytes;
    } catch (err) {
      rec.parseError = String(err && err.message);
    }
  }
  return rec;
});

const nested = [];
walk(root, 0, nested);const byDesc = new Map();
for (const s of skills) {
  const key = (s.description || '').slice(0, 40).toLowerCase();
  if (!key) continue;
  if (!byDesc.has(key)) byDesc.set(key, []);
  byDesc.get(key).push(s.name);
}
const overlaps = [...byDesc.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ descriptionPrefix: k, skills: v }));

const summary = {
  generatedAt: new Date().toISOString(),
  root,
  totalTopLevel: top.length,
  withSkillFile: skills.filter((s) => s.hasSkill).length,
  withoutSkillFile: skills.filter((s) => !s.hasSkill).map((s) => s.name),
  nameMismatch: skills.filter((s) => s.hasSkill && s.nameMatchesDir === false).map((s) => `${s.name} (frontmatter: ${s.frontmatterName})`),
  manifestPresent: manifestOk,
  manifestTracked: tracked.size,
  untracked: skills.filter((s) => !s.tracked).map((s) => s.name),
  nestedSkillFiles: nested.map((p) => p.slice(root.length + 1)),
  missingMetadata: skills.filter((s) => s.hasSkill && !s.hasMetadata).map((s) => s.name),
  oversizedBodies: skills.filter((s) => s.hasSkill && s.bodyLines > 500).map((s) => `${s.name} (${s.bodyLines} lines)`),
  overlaps,
};

const outPath = join(root, '.skill-inventory.json');
const tmp = `${outPath}.tmp-${Date.now()}`;
writeFileSync(tmp, JSON.stringify({ summary, skills }, null, 2), 'utf8');
renameSync(tmp, outPath);

if (asJson) {
  console.log(JSON.stringify({ summary, skills }, null, 2));
} else {
  console.log('skill inventory audit');
  console.log('=====================');
  console.log(`root                 ${root}`);
  console.log(`top-level skills     ${summary.totalTopLevel}`);
  console.log(`with SKILL.md        ${summary.withSkillFile}`);
  console.log(`tracked by manifest  ${summary.manifestTracked}`);
  console.log(`untracked            ${summary.untracked.length}`);
  console.log(`nested SKILL.md      ${summary.nestedSkillFiles.length}`);
  console.log(`name != dir          ${summary.nameMismatch.length}`);
  console.log(`missing metadata     ${summary.missingMetadata.length}`);
  console.log(`body > 500 lines     ${summary.oversizedBodies.length}`);
  console.log(`overlap groups       ${summary.overlaps.length}`);
  if (summary.withoutSkillFile.length) console.log(`\nBROKEN (no SKILL.md): ${summary.withoutSkillFile.join(', ')}`);
  if (summary.nameMismatch.length) console.log(`\nNAME MISMATCH:\n  ${summary.nameMismatch.join('\n  ')}`);
  if (summary.nestedSkillFiles.length) {
    console.log(`\nNESTED COPIES (${summary.nestedSkillFiles.length}):`);
    summary.nestedSkillFiles.slice(0, 20).forEach((p) => console.log(`  ${p}`));
    if (summary.nestedSkillFiles.length > 20) console.log(`  ... and ${summary.nestedSkillFiles.length - 20} more`);
  }
  if (summary.overlaps.length) {
    console.log(`\nOVERLAP GROUPS:`);
    summary.overlaps.forEach((o) => console.log(`  ${o.skills.join(' | ')}  <- "${o.descriptionPrefix}"`));
  }
  console.log(`\nledger written: ${outPath}`);
}

const problems = summary.nestedSkillFiles.length + summary.withoutSkillFile.length + summary.nameMismatch.length;
if (strict) process.exit(problems > 0 ? 1 : 0);
process.exit(0);
