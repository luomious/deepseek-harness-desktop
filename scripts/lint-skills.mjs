/**
 * lint-skills.mjs v2 — Skill 门禁（格式 + 质量 + 安全 + 跨根遮蔽）
 *
 * 官方规范依据：@deepseek-ai/dsh-skill-filesystem（内核实测 v0.1.1-rc.2）
 *   - 形态：单层 <name>/SKILL.md（发现只扫一层）
 *   - frontmatter open YAML：name + description 必填
 *   - 调用策略键必须是 kebab 扁平键：
 *       disable-model-invocation（bool，默认 false → modelInvocable=true）
 *       user-invocable（bool，默认 true）
 *     camelCase 遗留键（disableModelInvocation / modelInvocable / userInvocable）
 *     会被内核 rejectLegacyInvocationKey 直接 throw → 整个 skill 静默死亡（实测 :852-854）
 *   - 嵌套 invocation:{} 映射内核不解析（实测 parseInvocationPolicy 只读扁平键）：
 *     写嵌套形式的作者以为在控制调用策略，实际完全无效 → WARN
 *   - name 必须 kebab-case；与目录名不一致 → reject stale name
 *   - description 上限 500（catalogDescriptionMaxLength）
 *
 * v2 新增（2026-09-10 · P1 质量门禁 + P3 安全 lint + 跨根遮蔽）：
 *   1) 默认根扩展：~/.dsh/skills、~/.agents/skills、tools/dsh-skills-hub/skills、
 *      以及 agent-presets 下各 preset 的 skills 目录（存在才扫）
 *   2) 质量：body > 500 行 WARN（dsh-skill-authoring 契约）
 *   3) 安全内容扫描（正文 + description）：凭证外泄诱导 / 指令覆盖 / 删除确认绕过
 *      → FAIL；rm -rf 等危险但可能合法 → WARN（P3）
 *   4) 跨根遮蔽：同名 skill 同时存在于 ~/.agents/skills 与 ~/.dsh/skills
 *      → WARN（发现根顺序 agents 在 dsh 前，dsh 副本永久不生效）
 *
 * YAML 解析：复用内核同款 `yaml` 包（vendor/dsh-plugin-desktop/node_modules），
 * 正确处理 description 块标量（| / >）——正则法会漏检多行描述长度。
 *
 * 用法：node scripts/lint-skills.mjs [roots...]
 *       默认校验：~/.dsh/skills + ~/.agents/skills + tools/dsh-skills-hub/skills
 *                 + agent-presets 下各 preset 的 skills 目录（显式传根时仅扫显式根，用于 fixture 测试）
 * 退出码：0 = 无 FAIL；1 = 有 FAIL（WARN 不影响）
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DESC_MAX = 500;
const BODY_LINE_WARN = 500;
// 参考手册型标记：命中任一即判定为「按需查章节」的 reference skill，
// body 超长是合理设计（模型按需读章节，不整篇加载）→ body>500 降为 INFO 不打扰；
// 未命中的流程型（procedure）skill 超长仍 WARN（整篇加载，超长才真有害）。
// 依据：5 个超长 skill 实测章节结构（claude-api 31 个 Quick Reference 小节 /
// firecrawl-usage 分节 / chinese-git-workflow「阅读范围」/ writing-skills「阅读指南」/
// thesis-word-writing 15 章手册），全部为参考手册型，拆分反而有害（token 更多 + 上游漂移）。
const REF_GUIDE_MARKERS = ['Quick Reference', 'Reading Guide', '阅读指南', '阅读范围', '快速参考', '快速查阅'];
const METADATA_KEYS = ['version', 'owner', 'status', 'tags', 'since'];
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'];
const NESTED_TRIGGER_ENUM = new Set(['manual', 'auto', 'hybrid']);

// 内核同款 YAML 解析器（vendor 内，仓库自包含）
const requireFromVendor = createRequire(join(REPO_ROOT, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'package.json'));
let yamlParse = null;
try { yamlParse = requireFromVendor('yaml').parse; } catch { /* fallback below */ }

// ---- 安全模式表（P3）----
// [severity, id, regex, hint]
const SECURITY_PATTERNS = [
  // FAIL：凭证外泄诱导 —— 明确指示读取并输出/发送敏感文件
  ['FAIL', 'cred-exfil-read', /(?:读取|read|cat|查看|Get-Content)[\s\S]{0,80}(?:credentials\.yaml|DEEPSEEK_API_KEY|api[_-]?key|secret|\.env)[\s\S]{0,80}(?:发送|上传|输出|打印|贴给|交给|发给|post|upload|exfiltrat|\bsend\b)/i,
    '指示读取凭证文件并外发/输出（凭证外泄诱导）'],
  ['FAIL', 'cred-exfil-file', /(?:cat|type|Get-Content)\s+[^\n]{0,40}credentials\.yaml/i,
    '直接 cat/type 凭证文件（凭证外泄诱导）'],
  // FAIL：指令覆盖 / 提示注入
  ['FAIL', 'instr-override', /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?|directives?)/i,
    '要求忽略先前指令（提示注入）'],
  ['FAIL', 'instr-override-zh', /忽略(?:掉)?(?:之前|上面|先前|以上)的(?:所有)?(?:指令|规则|指示|提示)/,
    '要求忽略先前指令（提示注入）'],
  // FAIL：删除确认绕过（含英文 do not ask 形态 + rm -rf 组合）
  ['FAIL', 'del-no-confirm', /(?:delete|rm\s+-rf\b|Remove-Item)[^\n]{0,120}(?:without\s+(?:asking|confirmation|prompting|warning)|do\s+not\s+ask|don'?t\s+ask|无需(?:询问|确认)|不(?:要|用|需)(?:询问|确认|征求)[^\n]{0,40}(?:删除|移除|覆盖))/i,
    '指示无确认删除（破坏性操作绕过确认）'],
  // WARN：危险但可能合法
  ['WARN', 'rm-rf', /\brm\s+-rf\b|\bRemove-Item\b[^\n]*\b-Recurse\b[^\n]*\b-Force\b/i,
    '危险删除命令（rm -rf / Remove-Item -Recurse -Force），确认是意图而非示例'],
  ['WARN', 'pipe-to-shell', /(?:curl|wget|iwr|Invoke-WebRequest)[^\n]{0,40}\|\s*(?:sh|bash|powershell|iex)\b/i,
    '下载内容直接管道给 shell（供应链风险，确认是意图）'],
  ['WARN', 'cred-mention', /credentials\.yaml|DEEPSEEK_API_KEY/i,
    '提及凭证文件/密钥（确认上下文是否必要）'],
];

function parseFrontmatter(fmText) {
  if (yamlParse) {
    try { const doc = yamlParse(fmText); return { doc: doc && typeof doc === 'object' ? doc : null }; }
    catch (e) { return { error: `YAML parse error: ${e.message}` }; }
  }
  return { error: 'yaml parser unavailable' };
}

function bodyLineCount(raw, bodyStart) {
  let n = 0;
  for (let i = bodyStart; i < raw.length; i++) if (raw[i] === '\n') n++;
  return n + 1;
}

function scanSecurity(text) {
  const hits = [];
  for (const [severity, id, re, hint] of SECURITY_PATTERNS) {
    const rx = new RegExp(re, 'gim');
    let m;
    while ((m = rx.exec(text)) !== null) {
      // 定位行号
      const upto = text.slice(0, m.index);
      const line = (upto.match(/\n/g) || []).length + 1;
      hits.push({ severity, id, hint, line, snippet: m[0].slice(0, 80).replace(/\s+/g, ' ') });
      if (hits.length >= 50) return hits; // 防爆
    }
  }
  return hits;
}

function lintOne(skillDir) {
  const dir = basename(skillDir);
  const file = join(skillDir, 'SKILL.md');
  const errors = [];
  const warns = [];
  const security = [];
  if (!existsSync(file)) return { dir, errors: ['SKILL.md missing'], warns, security };

  const raw = readFileSync(file, 'utf-8');
  if (raw.charCodeAt(0) === 0xfeff) {
    return { dir, errors: ['UTF-8 BOM detected (内核 parseFrontmatter 首行 !== "---" 直接忽略整个 skill → 静默不加载; 用无 BOM UTF-8 保存)'], warns, security };
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { dir, errors: ['frontmatter missing'], warns, security };

  const bodyStart = m[0].length;
  const body = raw.slice(bodyStart);
  const { doc, error } = parseFrontmatter(m[1]);
  if (error) return { dir, errors: [error], warns, security };
  if (!doc) return { dir, errors: ['frontmatter empty or not a mapping'], warns, security };

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

  // fail-closed invocation 扁平键：必须布尔字面量；camelCase 遗留键直接 FAIL（内核 throw）
  for (const field of ['disable-model-invocation', 'user-invocable']) {
    const v = doc[field];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') errors.push(`${field} must be boolean, got: ${JSON.stringify(v)} (fail-closed: 整个 skill 被丢弃)`);
  }
  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (doc[legacy] !== undefined) errors.push(`camelCase legacy key "${legacy}" detected (内核 rejectLegacyInvocationKey 直接 throw → skill 静默死亡; 改用 "${legacy === 'userInvocable' ? 'user-invocable' : 'disable-model-invocation'}")`);
  }
  for (const snake of ['disable_model_invocation', 'user_invocable', 'when_to_use']) {
    if (doc[snake] !== undefined) errors.push(`snake_case field "${snake}" detected (fail-closed: skill 被丢弃)`);
  }

  // 嵌套 invocation:{} —— 内核不解析 → WARN（作者意图可能落空）
  if (doc.invocation !== undefined) {
    if (typeof doc.invocation !== 'object' || doc.invocation === null || Array.isArray(doc.invocation)) {
      errors.push('invocation must be a mapping (fail-closed: 整个 skill 被丢弃)');
    } else {
      const nested = doc.invocation;
      const keys = Object.keys(nested);
      if (keys.length) {
        const badTrigger = nested.trigger !== undefined && !NESTED_TRIGGER_ENUM.has(String(nested.trigger).trim());
        warns.push(`nested invocation:{} 存在（键: ${keys.join('/')}）——内核只解析扁平 kebab 键，嵌套形式不生效；请改用 disable-model-invocation / user-invocable${badTrigger ? `；trigger 值 "${nested.trigger}" 不在枚举 {manual,auto,hybrid} 内` : ''}`);
      }
    }
  }

  // whenToUse：可选，若有须为字符串
  if (doc.whenToUse !== undefined && typeof doc.whenToUse !== 'string') {
    errors.push(`whenToUse must be string, got: ${typeof doc.whenToUse}`);
  }

  // metadata：本系统约定必填（官方可选）→ WARN
  if (doc.metadata === undefined) {
    warns.push('metadata missing（本系统约定 version/owner/status/tags/since）');
  } else if (typeof doc.metadata !== 'object' || doc.metadata === null || Array.isArray(doc.metadata)) {
    warns.push('metadata is not a mapping');
  } else {
    const missing = METADATA_KEYS.filter((k) => doc.metadata[k] === undefined);
    if (missing.length) warns.push(`metadata missing keys: ${missing.join('/')}`);
  }

  // P1 质量：body 行数 > 500 → WARN（参考手册型豁免降 INFO）
  const lines = bodyLineCount(raw, bodyStart);
  if (lines > BODY_LINE_WARN) {
    const isRefGuide = REF_GUIDE_MARKERS.some((m) => body.includes(m));
    if (isRefGuide) {
      console.log(`  INFO ${dir}: body ${lines} lines > ${BODY_LINE_WARN}（参考手册型：含按需查章节标记，豁免 WARN）`);
    } else {
      warns.push(`body ${lines} lines > ${BODY_LINE_WARN}（dsh-skill-authoring 建议 <500 行，过长降低生效）`);
    }
  }

  // P3 安全扫描：正文 + description
  security.push(...scanSecurity(body));
  if (typeof desc === 'string') security.push(...scanSecurity(desc));

  return { dir, errors, warns, security, name };
}

function lintRoot(root) {
  if (!existsSync(root)) { console.log(`[lint-skills] SKIP (not found): ${root}`); return { pass: 0, fail: 0, warn: 0, secFail: 0, names: new Map() }; }
  const seen = new Map(); // 同根查重
  const names = new Map(); // 本根 name → dir（供跨根遮蔽检测）
  let pass = 0, fail = 0, warn = 0, secFail = 0;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const r = lintOne(join(root, entry.name));
    if (r.errors.length === 0 && r.name) {
      if (seen.has(r.name)) { r.errors.push(`duplicate skill name "${r.name}" in same root (also at ${seen.get(r.name)})`); }
      else seen.set(r.name, entry.name);
      names.set(r.name, entry.name);
    }
    const secFailIn = r.security.filter((s) => s.severity === 'FAIL').length;
    if (r.errors.length) { fail++; console.log(`  FAIL ${r.dir}: ${r.errors.join('; ')}`); }
    else { pass++; if (r.warns.length) { warn++; console.log(`  WARN ${r.dir}: ${r.warns.join('; ')}`); } }
    for (const s of r.security) {
      if (s.severity === 'FAIL') secFail++;
      console.log(`  ${s.severity === 'FAIL' ? 'SEC-FAIL' : 'SEC-WARN'} ${r.dir}:${s.line} [${s.id}] ${s.hint} (${s.snippet})`);
    }
    if (secFailIn && !r.errors.length) { fail += secFailIn; pass--; }
  }
  console.log(`[lint-skills] ${root}: ${pass} PASS / ${fail} FAIL / ${warn} WARN / ${secFail} SEC`);
  return { pass, fail, warn, secFail, names };
}

// ---- 默认根 ----
function defaultRoots() {
  const roots = [
    join(homedir(), '.dsh', 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(REPO_ROOT, 'tools', 'dsh-skills-hub', 'skills'),
  ];
  // agent-presets 下各 preset 的 skills 目录
  const presetsDir = join(REPO_ROOT, 'agent-presets');
  if (existsSync(presetsDir)) {
    for (const preset of readdirSync(presetsDir, { withFileTypes: true })) {
      if (preset.isDirectory()) {
        const sdir = join(presetsDir, preset.name, 'skills');
        if (existsSync(sdir)) roots.push(sdir);
      }
    }
  }
  return roots;
}

const explicitRoots = process.argv.slice(2);
const roots = explicitRoots.length ? explicitRoots : defaultRoots();

let tp = 0, tf = 0, tw = 0, tsec = 0;
const rootNames = []; // [{root, names: Map}]

for (const root of roots) {
  const { pass, fail, warn, secFail, names } = lintRoot(root);
  tp += pass; tf += fail; tw += warn; tsec += secFail;
  rootNames.push({ root, names });
}

// ---- 跨根遮蔽检测：~/.agents/skills 与 ~/.dsh/skills 同名 → dsh 副本不生效 ----
const agentsRoot = roots.find((r) => /\.agents[/\\]skills$/.test(r.replace(/[\\/]+$/, '')));
const dshRoot = roots.find((r) => /\.dsh[/\\]skills$/.test(r.replace(/[\\/]+$/, '')));
if (agentsRoot && dshRoot) {
  const agentsNames = (rootNames.find((r) => r.root === agentsRoot) || { names: new Map() }).names;
  const dshNames = (rootNames.find((r) => r.root === dshRoot) || { names: new Map() }).names;
  for (const [name, dir] of dshNames) {
    if (agentsNames.has(name)) {
      tw++;
      console.log(`  SHADOW ${name}: 同时存在于 ~/.agents/skills/${agentsNames.get(name)}（生效）与 ~/.dsh/skills/${dir}（被遮蔽，永不加载——发现根顺序 agents 在 dsh 前）`);
    }
  }
}

console.log(`[lint-skills] TOTAL ${tp} PASS / ${tf} FAIL / ${tw} WARN / ${tsec} SEC-FAIL`);
process.exitCode = tf > 0 ? 1 : 0;
