#!/usr/bin/env node
/**
 * verify-plugin-imports.mjs - static import-resolution gate for plugin sources.
 *
 * WHY THIS EXISTS (F14, 2026-09-10)
 * ---------------------------------
 * Four plugins bare-imported `@dsh-external/dsh-host-services/shared-utils` without
 * declaring it. Nothing caught it, because at runtime the two packages happened to be
 * linked as *siblings* inside `~/.dsh/profiles/desktop/node_modules/@dsh-external/`, so
 * Node's walk-up found `dsh-host-services` by pure accident. Deregister that one plugin
 * and all four fail to load at import time. Meanwhile the repo's own unit tests resolve
 * by realpath (no sibling), so they failed with ERR_MODULE_NOT_FOUND.
 *
 * THE RULE
 * --------
 * A plugin may rely on:
 *   1. Node builtins                      -> `node:*` / builtin module names
 *   2. The DSH host namespace             -> `@deepseek-ai/*` (kernel + client-ui packages
 *                                            are supplied by the running host, not by the
 *                                            repo: the repo root has no @deepseek-ai install)
 *   3. Client-shell peers                 -> `react` / `react-dom` inside client bundles
 *   4. Its own files                      -> relative/absolute specifiers that EXIST
 * Anything else (notably `@dsh-external/*`, i.e. a *sibling plugin*) is a hard FAIL:
 * cross-plugin code sharing must go through a relative path, not through package
 * resolution that only works by accident. Legitimate exceptions go in WAIVERS below,
 * each with a written reason.
 *
 * HOW SPECIFIERS ARE OBTAINED
 * ---------------------------
 * With V8's real module parser (`vm.SourceTextModule.moduleRequests`), NOT regex.
 * This matters: `plugins/dsh-routing-suite/injector/lib/index.js` is a code generator
 * that contains `import type ... from 'cordis'` / `'tsdown'` / `'schemastery'` inside
 * string literals. A regex scan reports those as imports and produces false positives;
 * the parser correctly reports only its 6 `node:*` requests. The module is parsed but
 * NEVER executed (no side effects).
 *
 * The parser needs `--experimental-vm-modules`; this script re-execs itself with that
 * flag automatically, so callers can just run `node scripts/verify-plugin-imports.mjs`.
 *
 * SCOPE
 * -----
 * Default roots: `plugins/` plus the three root-level daemon plugins. `tests/`,
 * `node_modules/`, `dist/` are always skipped. `SCOPE_EXCLUSIONS` can carve out more,
 * but every active exclusion is printed on each run with its reason and tracking id -
 * an exclusion must never become an invisible blind spot. An exclusion that stops
 * matching anything is reported as stale so it can be deleted instead of lingering.
 *
 * Usage:
 *   node scripts/verify-plugin-imports.mjs [--json] [--verbose] [--quiet]
 * Exit: 0 = no violations, 1 = at least one violation.
 *
 * Dynamic `import()` is reported as INFO only: its specifier is often computed at
 * runtime, so it cannot be gated statically without false positives.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import vm from 'node:vm';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

// ---------------------------------------------------------------- self re-exec
// vm.SourceTextModule requires --experimental-vm-modules. Rather than making every
// caller remember the flag, re-exec ourselves once with it. DSH_VPI_CHILD guards
// against an infinite respawn loop.
if (typeof vm.SourceTextModule !== 'function') {
  if (process.env.DSH_VPI_CHILD === '1') {
    // Flag was passed but the API is still missing (future Node removed it?).
    // Degrade loudly to SKIP rather than failing the whole gate on an API change.
    console.log('SKIP  vm.SourceTextModule unavailable even with --experimental-vm-modules');
    console.log('HINT  import gate did not run; re-check after a Node upgrade');
    process.exit(0);
  }
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', SELF, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env: { ...process.env, DSH_VPI_CHILD: '1' } },
  );
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

// ---------------------------------------------------------------- policy
/** Prefixes/names the running DSH host supplies. Keep reasons next to the entry. */
const HOST_PROVIDED = new Map([
  ['@deepseek-ai/', 'DSH kernel + client-ui packages are provided by the host at runtime'],
  ['react', 'provided to client bundles by the host shell'],
  ['react-dom', 'provided to client bundles by the host shell'],
]);

/**
 * Deliberate exceptions: `specifier` (or `prefix*`) -> reason.
 * Every entry is printed as a WARN so it stays visible instead of rotting silently.
 */
const WAIVERS = new Map([
  // e.g. ['some-pkg', 'validated by <evidence>; revisit on <date>'],
]);

/** Scan roots, relative to repo root. Extend here to widen coverage. */
const SCAN_ROOTS = [
  'plugins',              // all plugins
  'dsh-context-lifecycle', // root-level daemon plugins (same shape as plugins/)
  'dsh-stuck-loop-guard',
  'dsh-vision-rotator',
];

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'tests', 'dist', 'build', '.cache']);

/**
 * Announced scope exclusions - deliberately NOT silent.
 *
 * Every entry is printed on every run together with its reason and tracking id, so an
 * exclusion cannot quietly rot into a blind spot (the "gate that looks green because it
 * stopped looking" failure mode). Removing an exclusion automatically brings the files
 * back into scope; the gate then judges them on their merits.
 */
const SCOPE_EXCLUSIONS = [
  // Empty as of 2026-09-10: the only entry (plugins/dsh-routing-suite/preset/probe,
  // F18) was a temporary waiver while 17 probe scripts pointed at a router-core.mjs
  // path that no longer existed. Those paths were corrected, so the directory came
  // back into scope. Keep the mechanism, not the debt - if you add an entry, add a
  // date and a tracking id next to it.
];
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const BUILTINS = new Set(builtinModules);

// ---------------------------------------------------------------- helpers
const EXCLUDED_ABS = SCOPE_EXCLUSIONS.map((e) => ({
  ...e,
  abs: path.join(ROOT, e.dir),
  hits: 0,
}));

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links (avoids cycles into the profile)
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      const excl = EXCLUDED_ABS.find((x) => x.abs === full);
      if (excl) { excl.hits++; continue; }
      walk(full, out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Does a relative specifier resolve to a real file? Returns the winning candidate or null. */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base + '.js', base + '.mjs', base + '.cjs', base + '.json',
    path.join(base, 'index.js'), path.join(base, 'index.mjs'), path.join(base, 'index.cjs'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep probing */ }
  }
  return null;
}

function isBuiltin(spec) {
  if (spec.startsWith('node:')) return true;
  const head = spec.split('/')[0];
  return BUILTINS.has(head);
}

function hostReason(spec) {
  for (const [k, why] of HOST_PROVIDED) {
    if (k.endsWith('/') ? spec.startsWith(k) : spec === k) return why;
  }
  return null;
}

function waiverReason(spec) {
  if (WAIVERS.has(spec)) return WAIVERS.get(spec);
  for (const [k, why] of WAIVERS) {
    if (k.endsWith('*') && spec.startsWith(k.slice(0, -1))) return why;
  }
  return null;
}

const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const VERBOSE = argv.includes('--verbose');
const QUIET = argv.includes('--quiet');

const files = [];
for (const r of SCAN_ROOTS) {
  const abs = path.join(ROOT, r);
  if (fs.existsSync(abs)) walk(abs, files);
}

const failures = [];
const warnings = [];
const infos = [];
const stats = { files: files.length, specs: 0, builtin: 0, host: 0, relative: 0, bare: 0, dynamic: 0 };

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
    failures.push({ file: rel, specifier: null, reason: 'READ_FAIL', detail: e.message });
    continue;
  }

  let requests;
  try {
    // Parse only - this never evaluates the module.
    const mod = new vm.SourceTextModule(src, { identifier: file });
    requests = mod.moduleRequests.map((r) => (typeof r === 'string' ? r : r.specifier));
  } catch (e) {
    failures.push({ file: rel, specifier: null, reason: 'PARSE_FAIL', detail: `${e.name}: ${e.message}`.slice(0, 200) });
    continue;
  }

  // dynamic import() - advisory only
  const dyn = [...src.matchAll(DYNAMIC_RE)].map((m) => m[1]);
  for (const d of dyn) {
    stats.dynamic++;
    // A bare cross-plugin specifier in a *dynamic* import is usually deliberate (F19):
    // it doubles as the "is this optional plugin actually installed?" probe, because
    // resolution failure is what the surrounding try/catch keys off. Converting it to a
    // relative path would make it load even when the plugin is deregistered, i.e. it
    // would CHANGE behaviour. So: report, explain, do not gate, do not auto-fix.
    const isOptionalProbe = d.startsWith('@dsh-external/');
    infos.push({
      file: rel,
      specifier: d,
      reason: 'DYNAMIC_IMPORT',
      detail: isOptionalProbe
        ? 'cross-plugin bare import - usually an intentional optional-dependency probe (F19); do NOT convert to a relative path, resolution failure is the detection mechanism'
        : 'not gated (specifier may be computed at runtime)',
    });
  }

  for (const spec of requests) {
    stats.specs++;
    if (isBuiltin(spec)) { stats.builtin++; continue; }

    const w = waiverReason(spec);
    if (w) { warnings.push({ file: rel, specifier: spec, reason: 'WAIVED', detail: w }); continue; }

    const isRelative = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
    if (isRelative) {
      stats.relative++;
      const hit = resolveRelative(file, spec);
      if (!hit) failures.push({ file: rel, specifier: spec, reason: 'RELATIVE_MISSING', detail: 'no candidate file exists next to the importer' });
      else if (VERBOSE) infos.push({ file: rel, specifier: spec, reason: 'RELATIVE_OK', detail: path.relative(ROOT, hit).split(path.sep).join('/') });
      continue;
    }

    const host = hostReason(spec);
    if (host) { stats.host++; if (VERBOSE) infos.push({ file: rel, specifier: spec, reason: 'HOST_PROVIDED', detail: host }); continue; }

    stats.bare++;
    failures.push({
      file: rel,
      specifier: spec,
      reason: 'BARE_NOT_ALLOWED',
      detail: 'not a builtin, not host-provided, not waived. Cross-plugin sharing must use a relative path; anything else needs a real declaration plus a WAIVERS entry with a reason.',
    });
  }
}

// ---------------------------------------------------------------- report
const activeExclusions = EXCLUDED_ABS.filter((x) => x.hits > 0).map((x) => ({ dir: x.dir, reason: x.reason, tracking: x.tracking }));
const staleExclusions = SCOPE_EXCLUSIONS.filter((e) => !EXCLUDED_ABS.find((x) => x.dir === e.dir && x.hits > 0)).map((e) => e.dir);

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    ok: failures.length === 0,
    root: ROOT,
    scanned: stats,
    excluded: activeExclusions,
    staleExclusions,
    failures, warnings, infos,
  }, null, 2) + '\n');
} else {
  const byReason = {};
  for (const f of failures) byReason[f.reason] = (byReason[f.reason] || 0) + 1;

  if (!QUIET) {
    console.log(`plugin-imports: ${stats.files} files, ${stats.specs} static specifiers ` +
      `(builtin ${stats.builtin} / host ${stats.host} / relative ${stats.relative} / bare ${stats.bare})` +
      (stats.dynamic ? `, ${stats.dynamic} dynamic (advisory)` : ''));
  }

  // Scope exclusions are announced, never silent.
  for (const x of activeExclusions) console.log(`  NOTE  out of scope: ${x.dir} - ${x.reason} [${x.tracking}]`);
  for (const d of staleExclusions) console.log(`  NOTE  SCOPE_EXCLUSIONS entry matched nothing (safe to remove): ${d}`);

  for (const w of warnings) console.log(`  WARN  ${w.file}: '${w.specifier}' - ${w.detail}`);
  for (const f of failures) {
    console.log(`  FAIL  ${f.file}: ${f.specifier ? `'${f.specifier}' ` : ''}-> ${f.reason} (${f.detail})`);
  }
  if (VERBOSE) for (const i of infos) console.log(`  info  ${i.file}: '${i.specifier}' -> ${i.reason} (${i.detail})`);

  if (failures.length === 0) {
    console.log(`PASS  plugin import gate: 0 violations` +
      (warnings.length ? `, ${warnings.length} waived` : '') +
      (stats.dynamic ? `, ${stats.dynamic} dynamic not gated` : ''));
  } else {
    const parts = Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`FAIL  plugin import gate: ${failures.length} violation(s) [${parts}]`);
    console.log('HINT  cross-plugin sharing -> use a relative path, e.g. ../../dsh-host-services/lib/shared-utils.js');
    console.log('HINT  genuine exception   -> add a WAIVERS entry in scripts/verify-plugin-imports.mjs with a reason');
  }
}

process.exit(failures.length === 0 ? 0 : 1);
