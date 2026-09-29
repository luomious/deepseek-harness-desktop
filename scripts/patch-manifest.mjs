/**
 * patch-manifest.mjs —— 补丁集登记与完整性校验（P0-6）
 *
 * 为什么需要它（现状缺口）：
 *   `scripts/verify-patches.ps1` 已经很强（~90 项标记检查 + `node --check` 语法完整性 +
 *   覆盖度守卫 + 退役候选清单），但它检查的是「**标记是否存在**」。
 *   它无法发现：① 某个 `apply-*.mjs` 被**静默删除**（少了一个补丁器，标记可能仍由其它路径满足）
 *             ② 某个补丁器或 canon bundle 被**改动/截断**（标记字符串可能仍存活 —— T13/O14 同类洞）
 *             ③ 「补丁集」本身没有版本身份，无法回答"这一套补丁是不是我以为的那一套"
 *
 * 本脚本补上这一层，对齐 QuWork `runtime.json` 的 `patchSet` + `patchDigest`
 * 与官方 `desktop-runtime.json` 的「文件清单 + 摘要」做法：
 *   - 为每个 `scripts/apply-*.mjs` 与 `patches/bundles/**` 登记 sha256
 *   - 由**全部条目的 (path, sha256) 规范化排序**派生一个 `patchDigest`
 *   - `--verify` 重算并比对；同时做**覆盖率**交叉断言（磁盘上的 apply-*.mjs 集合 ≡ 登记集合）
 *
 * 用法：
 *   node scripts/patch-manifest.mjs --write     # 生成/更新 patches/MANIFEST.json
 *   node scripts/patch-manifest.mjs --verify    # 校验（CI/门禁用；不一致退出码 1）
 *   node scripts/patch-manifest.mjs             # 默认 --verify
 *
 * ⚠️ 与既有工具的分工（2026-09-26 查清，避免重复造轮子 / 避免两个事实源）：
 *   仓库里**已存在** `scripts/verify-bundle-manifest.mjs`（155 行），它已按 SHA-256 + size
 *   校验 `patches/bundles/*`（含 `original/` 回滚基线）对照 `patches/bundles/MANIFEST.md`，
 *   由 `check-all.ps1` 的 Step 1.10 执行 —— **那部分权威属于它，本脚本不重新裁决**。
 *   本脚本的**真正增量**是两件既有工具完全没覆盖的事：
 *     ① **28 个 `scripts/apply-*.mjs` 补丁器的集合身份** —— 现有任何门禁都不对它做摘要；
 *        补丁器被删除或改动时，verify-patches.ps1 的标记检查可能仍全绿（标记可由别的路径满足）
 *     ② **聚合 `patchSet` + `patchDigest`** —— 回答"这一套补丁是不是我以为的那一套"
 *   bundle 的哈希在本脚本里仅作为 **patchDigest 的输入**参与聚合，不作为独立裁决。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PATCH_SET = 'dsh-desktop-dist-patches';
const MANIFEST_PATH = path.join(ROOT, 'patches', 'MANIFEST.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 递归收集文件（相对 ROOT 的 POSIX 路径）。 */
function walk(dir, filter) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, filter));
    else if (filter(abs)) out.push(abs);
  }
  return out;
}

/** 生成当前补丁集条目（稳定排序，保证 digest 可复现）。 */
function collectEntries() {
  const entries = [];

  // ① 补丁器脚本
  const scriptsDir = path.join(ROOT, 'scripts');
  const appliers = readdirSync(scriptsDir)
    .filter((n) => /^apply-.*\.mjs$/.test(n))
    .sort();
  for (const name of appliers) {
    const abs = path.join(scriptsDir, name);
    entries.push({ kind: 'applier', path: `scripts/${name}`, sha256: sha256(readFileSync(abs)) });
  }

  // ② canon bundle（patches/bundles 下的补丁产物；排除 original/ 备份与 .md）
  const bundlesDir = path.join(ROOT, 'patches', 'bundles');
  const bundles = walk(bundlesDir, (abs) => {
    const rel = path.relative(bundlesDir, abs).replace(/\\/g, '/');
    if (rel.startsWith('original/')) return false;
    return /\.(js|cjs|mjs)$/.test(rel);
  })
    .map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/'))
    .sort();
  for (const rel of bundles) {
    entries.push({ kind: 'bundle', path: rel, sha256: sha256(readFileSync(path.join(ROOT, rel))) });
  }

  // ③ patches/reference 下的参考件（dsh-service / patch-manifest / plugin-manager）
  const refDir = path.join(ROOT, 'patches', 'reference');
  const refs = walk(refDir, (abs) => /\.(js|cjs|mjs)$/.test(abs))
    .map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/'))
    .sort();
  for (const rel of refs) {
    entries.push({ kind: 'reference', path: rel, sha256: sha256(readFileSync(path.join(ROOT, rel))) });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** patchDigest = 对 (kind, path, sha256) 三元组规范序列化后的 sha256。 */
function digestOf(entries) {
  const canon = entries.map((e) => `${e.kind}\u0000${e.path}\u0000${e.sha256}`).join('\n');
  return sha256(Buffer.from(canon, 'utf8'));
}

function buildManifest() {
  const entries = collectEntries();
  return {
    schemaVersion: 1,
    patchSet: PATCH_SET,
    patchDigest: digestOf(entries),
    entryCount: entries.length,
    counts: {
      applier: entries.filter((e) => e.kind === 'applier').length,
      bundle: entries.filter((e) => e.kind === 'bundle').length,
      reference: entries.filter((e) => e.kind === 'reference').length,
    },
    note: 'P0-6 补丁集身份登记。任何条目增删或内容变化 → patchDigest 变化 → verify 报红，必须显式重新 --write（防静默漂移，非防空改）。',
    entries,
  };
}

function write() {
  const m = buildManifest();
  const payload = { ...m, generatedAt: new Date().toISOString() };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`WROTE ${path.relative(ROOT, MANIFEST_PATH)}`);
  console.log(`  patchSet    = ${payload.patchSet}`);
  console.log(`  patchDigest = ${payload.patchDigest}`);
  console.log(`  entries     = ${payload.entryCount} (${JSON.stringify(payload.counts)})`);
  return 0;
}

function verify() {
  let fail = 0;
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`FAIL  manifest missing: ${path.relative(ROOT, MANIFEST_PATH)}`);
    console.log('HINT  node scripts/patch-manifest.mjs --write');
    return 1;
  }
  const recorded = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const live = buildManifest();

  // ① patchSet 身份
  if (recorded.patchSet !== live.patchSet) {
    console.log(`FAIL  patchSet mismatch: manifest=${recorded.patchSet} live=${live.patchSet}`);
    fail += 1;
  } else {
    console.log(`PASS  patchSet identity (${live.patchSet})`);
  }

  // ② 覆盖率交叉断言：磁盘集合 ≡ 登记集合
  const rec = new Map((recorded.entries ?? []).map((e) => [e.path, e.sha256]));
  const cur = new Map(live.entries.map((e) => [e.path, e.sha256]));
  const added = [...cur.keys()].filter((k) => !rec.has(k)).sort();
  const removed = [...rec.keys()].filter((k) => !cur.has(k)).sort();
  const changed = [...cur.keys()].filter((k) => rec.has(k) && rec.get(k) !== cur.get(k)).sort();
  if (added.length) {
    console.log(`FAIL  unregistered entries (${added.length}) - 新增补丁器/bundle 未登记:`);
    for (const a of added.slice(0, 10)) console.log(`        + ${a}`);
    fail += 1;
  }
  if (removed.length) {
    console.log(`FAIL  missing entries (${removed.length}) - 已登记条目在磁盘上消失:`);
    for (const r of removed.slice(0, 10)) console.log(`        - ${r}`);
    fail += 1;
  }
  if (changed.length) {
    console.log(`FAIL  content drift (${changed.length}) - 内容变化需显式重新 --write:`);
    for (const c of changed.slice(0, 10)) console.log(`        ~ ${c}`);
    fail += 1;
  }
  if (!added.length && !removed.length && !changed.length) {
    console.log(`PASS  entry set matches disk (${cur.size} entries: ${JSON.stringify(live.counts)})`);
  }

  // ③ patchDigest
  if (recorded.patchDigest !== live.patchDigest) {
    console.log(`FAIL  patchDigest mismatch`);
    console.log(`        manifest = ${recorded.patchDigest}`);
    console.log(`        live     = ${live.patchDigest}`);
    fail += 1;
  } else {
    console.log(`PASS  patchDigest (${live.patchDigest.slice(0, 16)}…)`);
  }

  // ④ 覆盖度下限守卫（同 verify-patches.ps1 的纪律：覆盖塌陷不得通过）
  if (live.counts.applier < 20) {
    console.log(`FAIL  applier coverage collapsed (found ${live.counts.applier}, expected >= 20)`);
    fail += 1;
  } else {
    console.log(`PASS  applier coverage (${live.counts.applier} scripts)`);
  }

  console.log('');
  if (fail === 0) {
    console.log('PATCH-MANIFEST: ALL PASS');
    return 0;
  }
  console.log(`PATCH-MANIFEST: ${fail} FAILED`);
  console.log('HINT  node scripts/patch-manifest.mjs --write   # 确认改动无误后重新登记');
  return 1;
}

const mode = process.argv.includes('--write') ? 'write' : 'verify';
process.exit(mode === 'write' ? write() : verify());
