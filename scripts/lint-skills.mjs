/**
 * lint-skills.mjs — Skill 格式校验（C 层门禁 · 对齐官方规范）
 *
 * 官方规范依据：@deepseek-ai/dsh-skill-filesystem / dsh-tool-skill（v0.1.1-rc.2）
 *   - 形态：单层 <name>/SKILL.md 或 <name>.md（发现只扫一层）
 *   - frontmatter 为 open YAML：name + description 必填；
 *     whenToUse / metadata / disable-model-invocation / user-invocable 可选
 *   - name 必须 kebab-case；与目录名不一致 → reject stale name
 *   - fail-closed：invocation 字段 camelCase 拼写错误或值非布尔 → 整个 skill 被丢弃
 *   - catalog 只发 name + description；description 上限 500（catalogDescriptionMaxLength）
 *   - 热更新：body 每次加载重读；frontmatter 改名会 invalidate
 *
 * 本系统约定（超集，记 WARN 不记 FAIL）：
 *   - metadata 必填（version/owner/status/tags/since）——对上游 hub skill 不强求，
 *     对自研 skill 应补齐（SKILL-1）
 *
 * YAML 解析：复用内核同款 `yaml` 包（vendor/dsh-plugin-desktop/node_modules），
 * 正确处理 description 块标量（| / >）——正则法会漏检多行描述长度。
 *
 * 用法：node scripts/lint-skills.mjs [roots...]
 *       默认校验 ~/.dsh/skills + tools/dsh-skills-hub/skills
 * 退出码：0 = 无 FAIL；1 = 有 FAIL（WARN 不影响）
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DESC_MAX = 500;
const METADATA_KEYS = ['version', 'owner', 'status', 'tags', 'since'];

// 内核同款 YAML 解析器（vendor 内，仓库自包含）
const requireFromVendor = createRequire(join(process.cwd(), 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'package.json'));
let yamlParse = null;
try { yamlParse = requireFromVendor('yaml').parse; } catch { /* fallback below */ }

function parseFrontmatter(fmText) {
  if (yamlParse) {
    try { const doc = yamlParse(fmText); return { doc: doc && typeof doc === 'object' ? doc : null }; }
    catch (e) { return { error: `YAML parse error: ${e.message}` }; }
  }
  return { error: 'yaml parser unavailable' };
}

function lintOne(skillDir) {
  const dir = basename(skillDir);
  const file = join(skillDir, 'SKILL.md');
  const errors = [];
  const warns = [];
  if (!existsSync(file)) return { dir, errors: ['SKILL.md missing'], warns };

  const raw = readFileSync(file, 'utf-8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { dir, errors: ['frontmatter missing'], warns };
  const { doc, error } = parseFrontmatter(m[1]);
  if (error) return { dir, errors: [error], warns };
  if (!doc) return { dir, errors: ['frontmatter empty or not a mapping'], warns };

  // name：必填 + kebab-case + 与目录一致（reject stale name）
  const name = doc.name;
  if (typeof name !== 'string' || !name) errors.push('name missing');
  else {
    if (!KEBAB.test(name)) errors.push(`name not kebab-case: "${name}"`);
    if (name !== dir) errors.push(`name != dir: "${name}" vs "${dir}" (reject stale name)`);
  }

  // description：必填 + ≤500（支持块标量，最终值以 YAML 解析为准）
  const desc = doc.description;
  if (typeof desc !== 'string' || !desc.trim()) errors.push('description missing（catalog 唯一加载依据）');
  else if (desc.trim().length > DESC_MAX) errors.push(`description ${desc.trim().length} > ${DESC_MAX}`);

  // fail-closed invocation 字段：必须布尔字面量；snake_case 拼写直接 FAIL
  for (const field of ['disable-model-invocation', 'user-invocable']) {
    const v = doc[field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') errors.push(`${field} must be boolean, got: ${JSON.stringify(v)} (fail-closed: 整个 skill 被丢弃)`);
  }
  for (const snake of ['disable_model_invocation', 'user_invocable', 'when_to_use']) {
    if (doc[snake] !== undefined) errors.push(`snake_case field "${snake}" detected (fail-closed: skill 被丢弃)`);
  }

  // whenToUse：可选，若有须为字符串（不在 catalog，但类型错可能引发解析问题）
  if (doc.whenToUse !== undefined && typeof doc.whenToUse !== 'string') {
    errors.push(`whenToUse must be string, got: ${typeof doc.whenToUse}`);
  }

  // metadata：本系统约定必填（官方可选）→ WARN
  if (doc.metadata === undefined) {
    warns.push('metadata missing（本系统约定 version/owner/status/tags/since）');
  } else if (typeof doc.metadata !== 'object') {
    warns.push('metadata is not a mapping');
  } else {
    const missing = METADATA_KEYS.filter((k) => doc.metadata[k] === undefined);
    if (missing.length) warns.push(`metadata missing keys: ${missing.join('/')}`);
  }

  return { dir, errors, warns, name };
}

function lintRoot(root) {
  if (!existsSync(root)) { console.log(`[lint-skills] SKIP (not found): ${root}`); return { pass: 0, fail: 0, warn: 0 }; }
  const seen = new Map(); // 查重仅限同一根内（跨根 = hub 源与已装副本属正常复制关系）
  let pass = 0, fail = 0, warn = 0;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const r = lintOne(join(root, entry.name));
    // 查重仅限同一根内（跨根 = hub 源与已装副本属正常复制关系）
    if (r.errors.length === 0 && r.name) {
      if (seen.has(r.name)) { r.errors.push(`duplicate skill name "${r.name}" in same root (also at ${seen.get(r.name)})`); }
      else seen.set(r.name, root);
    }
    if (r.errors.length) { fail++; console.log(`  FAIL ${r.dir}: ${r.errors.join('; ')}`); }
    else { pass++; if (r.warns.length) { warn++; console.log(`  WARN ${r.dir}: ${r.warns.join('; ')}`); } }
  }
  console.log(`[lint-skills] ${root}: ${pass} PASS / ${fail} FAIL / ${warn} WARN`);
  return { pass, fail, warn };
}

const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [join(homedir(), '.dsh', 'skills'), 'tools/dsh-skills-hub/skills'];

const seen = null; void seen;
let tp = 0, tf = 0;
for (const root of roots) {
  const { pass, fail } = lintRoot(root);
  tp += pass; tf += fail;
}
console.log(`[lint-skills] TOTAL ${tp} PASS / ${tf} FAIL`);
process.exitCode = tf > 0 ? 1 : 0;
