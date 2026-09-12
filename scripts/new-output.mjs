#!/usr/bin/env node
/**
 * new-output.mjs - scaffold a new archived output directory (G2 convention).
 *
 * Creates outputs/<YYYY-MM-DD>-<type>-<topic>/ with a README.md placeholder and
 * registers the entry at the top of outputs/INDEX.md, so "what was produced and where"
 * stays answerable. See outputs/README.md for the convention.
 *
 * Usage:
 *   node scripts/new-output.mjs --type report --topic capability-audit
 *   node scripts/new-output.mjs --type diagram --topic plugin-lifecycle --dry-run
 *   node scripts/new-output.mjs --type table --topic skill-ledger --root <dir>   (testing)
 *
 * Exit: 0 = created (or dry-run ok), 1 = validation/IO failure.
 * Output is ASCII-only: this runs through PowerShell, whose console codepage mangles
 * non-ASCII (see the F14 gate for the same rule).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = ['report', 'diagram', 'table', 'slide', 'doc', 'data', 'export'];
const TYPE_DESC = {
  report: 'report / audit / findings',
  diagram: 'architecture / flow / illustration',
  table: 'data table / csv / ledger',
  slide: 'presentation',
  doc: 'other document (spec, proposal, guide)',
  data: 'machine-readable artifact (json / export)',
  export: 'content exported from an external system',
};

// ---- arg parsing -------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const flags = new Set(argv.filter((a) => a.startsWith('--') && !argv[argv.indexOf(a) + 1]?.startsWith('--')));
const has = (n) => argv.includes('--' + n);

const type = arg('type');
const topic = arg('topic');
const title = arg('title');
const rootOverride = arg('root');
const dryRun = has('dry-run');
const dateArg = arg('date');

const base = rootOverride ? path.resolve(rootOverride) : ROOT;
const OUT = path.join(base, 'outputs');
const INDEX = path.join(OUT, 'INDEX.md');

function fail(msg) { console.log('FAIL ' + msg); process.exit(1); }

if (!type) fail(`missing --type (one of: ${TYPES.join(', ')})`);
if (!TYPES.includes(type)) fail(`unknown --type '${type}' (allowed: ${TYPES.join(', ')})`);
if (!topic) fail('missing --topic (kebab-case, e.g. capability-audit)');
if (!/^[a-z0-9][a-z0-9-]*$/.test(topic)) fail(`invalid --topic '${topic}': use kebab-case [a-z0-9-]`);

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const date = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : stamp();
if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) fail(`invalid --date '${dateArg}' (YYYY-MM-DD)`);

const dirName = `${date}-${type}-${topic}`;
const dirPath = path.join(OUT, dirName);
const readmeName = type === 'diagram' ? 'README.md' : 'README.md';

console.log(`new-output: type=${type} (${TYPE_DESC[type]}) topic=${topic} date=${date}`);
console.log(`  dir:   ${path.relative(base, dirPath).split(path.sep).join('/')}/`);
console.log(`  index: ${path.relative(base, INDEX).split(path.sep).join('/')}`);

if (!fs.existsSync(OUT)) fail(`outputs/ not found: ${OUT} (create it first)`);
if (!fs.existsSync(INDEX)) fail(`index not found: ${INDEX}`);
if (fs.existsSync(dirPath)) fail(`target already exists: ${dirName}/ (pick a new --topic or --date)`);

const readme = [
  `# ${title || topic}`,
  '',
  `- 日期: ${date}`,
  `- 类型: ${type} (${TYPE_DESC[type]})`,
  `- 主题: ${topic}`,
  `- 状态: 草稿`,
  '',
  '## 概述',
  '',
  '(TODO: 这份产出是什么、结论是什么、给谁看)',
  '',
  '## 产物',
  '',
  '| 文件 | 说明 |',
  '|---|---|',
  '| - | (TODO) |',
  '',
];

if (dryRun) {
  console.log('  DRY RUN - nothing written');
  console.log(`  would create: ${dirName}/README.md (${readme.length} lines)`);
  console.log(`  would prepend 1 row to INDEX.md`);
  process.exit(0);
}

// ---- write -------------------------------------------------------------------
fs.mkdirSync(dirPath, { recursive: true });
fs.writeFileSync(path.join(dirPath, readmeName), readme.join('\n'), 'utf8');

// insert the new row as the first data row of the registry table
const idxText = fs.readFileSync(INDEX, 'utf8');
const lines = idxText.split('\n');
// Locate the registry table separator, e.g. "|---|---|---|---|---|---|".
// NOTE: the character class must include '|' itself, otherwise a multi-column
// separator never matches (regression found by the temp-root test).
const sepIdx = lines.findIndex((l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes('---'));
if (sepIdx === -1) { console.log('FAIL could not locate the table separator in INDEX.md'); process.exit(1); }
const row = `| ${date} | ${type} | ${title || topic} | \`outputs/${dirName}/\` | [\`${readmeName}\`](./${dirName}/${readmeName}) | 草稿 |`;
lines.splice(sepIdx + 1, 0, row);

const tmp = path.join(OUT, `.tmp-index-${process.pid}-${Date.now()}`);
fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
fs.renameSync(tmp, INDEX);

// ---- verify ------------------------------------------------------------------
const okDir = fs.existsSync(dirPath);
const okReadme = okDir && fs.readFileSync(path.join(dirPath, readmeName), 'utf8') === readme.join('\n');
const okIndex = fs.readFileSync(INDEX, 'utf8').includes(row);
console.log(`  created dir: ${okDir}`);
console.log(`  readme round-trip: ${okReadme}`);
console.log(`  index row present: ${okIndex}`);
if (okDir && okReadme && okIndex) {
  console.log(`PASS created outputs/${dirName}/ and registered it in INDEX.md`);
  console.log(`HINT next: put the artifact inside, then present it to the user (产出即可查看)`);
  process.exit(0);
}
console.log('FAIL post-write verification failed');
process.exit(1);
