#!/usr/bin/env node
// scripts/apply-projcache-guard.mjs - re-apply the "session projection cache must stay
// bounded, per-session resilient, and cheap to write" dist patches
// (idempotent; re-run after every rebuild).
//
// Incident (2026-09-23): DSH Desktop auto-closed repeatedly. Crashpad minidumps carried
//   ExceptionCode 0xE0000008 plus the embedded string
//   "OOM error in V8: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory"
//   (two dumps, 14:45 and 19:22 local, identical). Failure chain:
//   1. ~/.dsh/storages/session_projcache.json had grown to 105 MB (449 session records).
//   2. dsh-storage-json serializes the WHOLE document on every write
//      (JSON.stringify(document, null, 2) + atomic rename), so every projcache flush
//      allocated a ~105 MB transient string. With a 5 s interval write per dirty session
//      that is continuous ~100 MB-class garbage while live transcripts are also resident.
//   3. One session (session-8d2fcb37) held a unit state that violates the plain-JSON
//      contract, so `put()` threw for that session on EVERY write (313 warnings on 09-23,
//      first at 14:20:43, cadence 5 s) - its checkpoint stayed stale forever, and the
//      whole-file rewrite kept happening for every other session.
// Fix (two files, three anchors):
//   P1  node_modules/@deepseek-ai/dsh-session-projection-cache/lib/index.js
//       put(): snapshot per key. One poisoned unit no longer stalls the whole session's
//       cache - the healthy rows are still persisted, and the offending unit keys are
//       logged by name (that log line is the diagnostic for "which unit violates the
//       plain-JSON contract", previously unknowable without a heap snapshot).
//   P2  same file
//       put(): bounded cache. Records above a hard cap are evicted oldest-first
//       (identity.createdAt) down to the soft cap. Eviction is cache-safe by the
//       service's own contract: a missing row costs a longer tail replay on the next
//       cold read, never a wrong value. Caps are overridable via
//       DSH_PROJCACHE_SOFT_CAP / DSH_PROJCACHE_HARD_CAP.
//   P3  node_modules/@deepseek-ai/dsh-storage-json/lib/index.js
//       serialize(): compact JSON instead of `null, 2` pretty printing. Identical
//       document (JSON.parse-equal), ~45% smaller write-time transient
//       (105 MB -> 59 MB for session_projcache.json) and less GC churn per flush.
//       Applies to every json-backed storage unit; revert = restore the backup and drop
//       the two 'json-storage-compact' entries from scripts/verify-patches.ps1.
//
// Registered in scripts/verify-patches.ps1 (projcache-guard items).
// Fault-injection test: node --test tests/dist/projcache-guard.test.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

/** Marker shared by every injected line; also the verify-patches.ps1 probe. */
export const PROJCACHE_GUARD_MARKER = 'dsh patch projcache-guard v1'
/** Separate marker for the storage-json compact patch (independently revertable). */
export const JSON_COMPACT_MARKER = 'dsh patch json-storage-compact v1'

// ---------------------------------------------------------------------------
// Patch table. Anchors are byte-exact against the current build output (tabs as
// emitted by tsdown). Every anchor must appear exactly once; the applier fails
// loudly on drift (upstream rebuild -> fail, never silently mis-patch).
// ---------------------------------------------------------------------------

// P1+P2 ------------------------------------------------- projection cache put()
const CACHE_PUT_ANCHOR = [
  '\t\tconst detached = snapshotJsonValue(rows);',
  '\t\tif (detached === void 0) throw new TypeError("projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)");',
  '\t\tawait this.requireTable().put(id, {',
  '\t\t\tidentity,',
  '\t\t\trows: detached',
  '\t\t});',
].join('\n')

const CACHE_PUT_REPL = [
  '\t\tlet detached = snapshotJsonValue(rows);',
  '\t\tif (detached === void 0) {',
  '\t\t\t/* ' + PROJCACHE_GUARD_MARKER + ': isolate per key - one non-plain unit state must not stall the whole session checkpoint, and its key must be named for diagnosis. */',
  '\t\t\tconst good = {};',
  '\t\t\tconst bad = [];',
  '\t\t\tfor (const key of Object.keys(rows)) {',
  '\t\t\t\tconst row = snapshotJsonValue(rows[key]);',
  '\t\t\t\tif (row === void 0) bad.push(key);',
  '\t\t\t\telse good[key] = row;',
  '\t\t\t}',
  '\t\t\tif (bad.length > 0) {',
  '\t\t\t\tconst signature = id + "\\u0000" + bad.join(",");',
  '\t\t\t\tif (this.nonPlainSignature !== signature) {',
  '\t\t\t\t\tthis.nonPlainSignature = signature;',
  '\t\t\t\t\tthis.ctx.logger.warn(`session projection cache: session "${id}" has ${bad.length} non-plain-JSON unit state(s) [${bad.join(", ")}]; the remaining rows are cached normally`);',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t\tif (bad.length === Object.keys(rows).length) throw new TypeError("projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)");',
  '\t\t\tdetached = good;',
  '\t\t}',
  '\t\tconst table = this.requireTable();',
  '\t\tawait table.put(id, {',
  '\t\t\tidentity,',
  '\t\t\trows: detached',
  '\t\t});',
  '\t\t/* ' + PROJCACHE_GUARD_MARKER + ': bounded cache - evict oldest records above the hard cap. Eviction is a longer cold-read replay, never a wrong value. */',
  '\t\tconst softCap = Number(process.env.DSH_PROJCACHE_SOFT_CAP ?? 400);',
  '\t\tconst hardCap = Number(process.env.DSH_PROJCACHE_HARD_CAP ?? 500);',
  '\t\tconst cacheKeys = [...table.keys()];',
  '\t\tif (cacheKeys.length > hardCap) {',
  '\t\t\tconst doomed = cacheKeys',
  '\t\t\t\t.filter((key) => key !== id)',
  '\t\t\t\t.map((key) => [key, table.get(key)?.identity?.createdAt ?? 0])',
  '\t\t\t\t.sort((a, b) => a[1] - b[1])',
  '\t\t\t\t.slice(0, Math.max(0, cacheKeys.length - softCap));',
  '\t\t\tfor (const [key] of doomed) {',
  '\t\t\t\ttry { await table.delete(key); } catch { /* best-effort eviction; a surviving record is harmless */ }',
  '\t\t\t}',
  '\t\t\tif (doomed.length > 0) this.ctx.logger.warn(`session projection cache: evicted ${doomed.length} oldest record(s) above the hard cap ${hardCap} (kept ${softCap})`);',
  '\t\t}',
].join('\n')

// P3 ------------------------------------------------------------ json serialize()
const JSON_SER_ANCHOR = '\treturn `' + '${JSON.stringify(document, null, 2)}' + '\\n' + '`;'
const JSON_SER_REPL = [
  '\t/* ' + JSON_COMPACT_MARKER + ': compact output - identical document, ~45% smaller write-time transient (whole-file backend). */',
  '\treturn `' + '${JSON.stringify(document)}' + '\\n' + '`;',
].join('\n')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backup(backupRoot, file, label) {
  mkdirSync(backupRoot, { recursive: true })
  const dest = join(backupRoot, `${label}-${stamp()}.bak`)
  copyFileSync(file, dest)
  return dest
}

function fail(msg) {
  console.log(msg)
  process.exit(1)
}

function applyPatches(backupRoot, file, label, patches, marker, dryRun) {
  if (!existsSync(file)) fail(`ERR ${label}: target not found: ${file}`)
  let text
  try { text = readFileSync(file, 'utf8') } catch (cause) {
    fail(`ERR read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (text.includes(marker)) {
    console.log(`SKIP ${label}: marker already present (${file})`)
    return
  }
  // 1) anchor uniqueness / drift gate (refuse to patch a drifted build)
  for (const p of patches) {
    const occurrences = text.split(p.anchor).length - 1
    if (occurrences !== 1) {
      fail(`ERR anchor ${label}/${p.name} occurs ${occurrences} times (expected 1): ${JSON.stringify(p.anchor.slice(0, 70))}`)
    }
  }
  // 2) injected text must parse as plain statements (async wrapper: P1/P2 inject `await`)
  for (const p of patches) {
    try {
      // eslint-disable-next-line no-new-func
      new Function('return (async () => {\n' + p.replacement + '\n})')
    } catch (cause) {
      fail(`ERR injected text does not parse (${label}/${p.name}): ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (dryRun) {
    console.log(`DRY-RUN ${label}: ${patches.length} anchor(s) matched, nothing written (${file})`)
    return
  }
  const backupPath = backup(backupRoot, file, label)
  // 3) replace
  let out = text
  for (const p of patches) {
    if (!out.includes(p.anchor)) fail(`ERR internal: anchor disappeared for ${p.name}`)
    out = out.replace(p.anchor, p.replacement)
  }
  if (!out.includes(marker)) fail(`ERR marker missing after replace (${label})`)
  // 4) atomic write: temp file + rename (parallel sessions must never read a half-written file)
  const tmp = file + '.projcache-guard.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, file)
  } catch (cause) {
    fail(`ERR atomic write ${label}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  // 5) readback verification
  const rb = readFileSync(file, 'utf8')
  if (!rb.includes(marker)) fail(`ERR readback marker missing (${label})`)
  console.log(`PATCHED ${label} (${patches.length} patch(es)) -> ${file}`)
  console.log(`  backup: ${backupPath}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const dryRun = process.argv.includes('--dry-run')
  const build = resolveCurrentBuild()
  // Fail loudly if the rebuild packed lib/ back into app.asar (dist patches target
  // app.asar.unpacked and would otherwise become silently ineffective).
  assertLibUnpacked(build.asar)

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const BACKUP_ROOT = join(REPO_ROOT, '_backups', `dist-projcache-guard-${stamp()}`)

  const cacheIndex = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-session-projection-cache', 'lib', 'index.js')
  applyPatches(BACKUP_ROOT, cacheIndex, 'session-projection-cache', [
    { name: 'p1-per-key-isolation', anchor: CACHE_PUT_ANCHOR, replacement: CACHE_PUT_REPL },
  ], PROJCACHE_GUARD_MARKER, dryRun)

  const storageJson = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js')
  applyPatches(BACKUP_ROOT, storageJson, 'storage-json', [
    { name: 'p3-compact-serialize', anchor: JSON_SER_ANCHOR, replacement: JSON_SER_REPL },
  ], JSON_COMPACT_MARKER, dryRun)

  console.log('current build: ' + build.buildDir)
  if (dryRun) console.log('dry run only. re-run without --dry-run to write.')
  else console.log('done. projcache-guard patches effective on next boot (bounded cache + per-session resilience + cheaper writes).')
  if (!dryRun) console.log('run the fault-injection test: node --test tests/dist/projcache-guard.test.mjs')
}
