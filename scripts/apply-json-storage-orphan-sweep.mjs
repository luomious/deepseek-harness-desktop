#!/usr/bin/env node
// scripts/apply-json-storage-orphan-sweep.mjs - re-apply the "a hard kill must not
// strand atomic-staging files" dist patch to the JSON storage backend (idempotent;
// re-run after every rebuild).
//
// Evidence (2026-09-23/24, found while cleaning up after the OOM crashes):
//   ~/.dsh/storages held two 0-byte staging files
//     .01ae560d-9f86-4ee7-a6d3-664c700575be.tmp  mtime 2026-09-23 19:22:18
//     .a5003d55-d9c1-4b28-a028-f7a3053fac51.tmp  mtime 2026-09-23 14:45:27
//   Those two mtimes match that day's two Crashpad minidumps exactly (main-process V8
//   heap OOM; see apply-projcache-guard.mjs). dsh-storage-json publishes a unit with
//   open(dir + "/." + randomUUID() + ".tmp", "wx") -> write -> fsync -> rename, and ONLY
//   its own catch path removes the staging file, so a kill between open() and rename()
//   strands it forever - no kernel code ever revisits that directory.
//   Measured the same day: a live writer's staging file exists for <5 s (a 53 MB
//   projcache rewrite), so an untouched .<uuid>.tmp older than the window is provably dead.
//
// Fix: before the first write into a directory, list that directory once and remove
//   .<uuid>.tmp entries older than the stale window (default 600000 ms; override with
//   DSH_STORAGE_ORPHAN_TMP_MS). The exact-name regex plus the age gate means a concurrent
//   writer's in-flight staging file can never be targeted; one readdir per directory per
//   process, and every error is swallowed so the sweep can never break the write path.
//
// Registered in scripts/verify-patches.ps1 (json-storage-orphan-sweep item).
// Fault-injection test: node --test tests/dist/json-storage-orphan-tmp-sweep.test.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

/** Marker shared by the injected lines; also the verify-patches.ps1 probe. */
export const ORPHAN_SWEEP_MARKER = 'dsh patch json-storage-orphan-tmp-sweep v1'

// Anchor 1: the module import list has to grant readdir/stat.
const ANCHOR_IMPORT = 'import { mkdir, open, readFile, rename, rm } from "node:fs/promises";'
const REPLACEMENT_IMPORT = 'import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";'

// Anchor 2: the sweep helper is injected immediately before writeAtomic.
const ANCHOR_FN = 'async function writeAtomic(path, data) {'
const REPLACEMENT_FN = [
  '/* ' + ORPHAN_SWEEP_MARKER + ': a staging file is removed only by writeAtomic own catch,',
  '   so a hard kill (OOM / SIGKILL / power loss) between open() and rename() strands it',
  '   forever - measured: the 2026-09-23 OOM crashes left one 0-byte orphan per minidump in',
  '   ~/.dsh/storages, while a live writer staging file was seen to survive <5 s. Sweep once',
  '   per directory per process, and only touch the exact .<uuid>.tmp shape once it is older',
  '   than the stale window (DSH_STORAGE_ORPHAN_TMP_MS, default 10 min). */',
  'const ORPHAN_TMP_NAME = /^\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$/;',
  'const orphanTmpSweptDirs = new Set();',
  'async function sweepOrphanTmp(dir) {',
  '\tif (orphanTmpSweptDirs.has(dir)) return 0;',
  '\torphanTmpSweptDirs.add(dir);',
  '\tconst configured = Number(process.env.DSH_STORAGE_ORPHAN_TMP_MS);',
  '\tconst staleMs = Number.isFinite(configured) && configured >= 0 ? configured : 600000;',
  '\tlet removed = 0;',
  '\ttry {',
  '\t\tconst now = Date.now();',
  '\t\tfor (const name of await readdir(dir)) {',
  '\t\t\tif (!ORPHAN_TMP_NAME.test(name)) continue;',
  '\t\t\tconst candidate = join(dir, name);',
  '\t\t\tlet mtimeMs;',
  '\t\t\ttry {',
  '\t\t\t\tmtimeMs = (await stat(candidate)).mtimeMs;',
  '\t\t\t} catch {',
  '\t\t\t\tcontinue;',
  '\t\t\t}',
  '\t\t\tif (!(now - mtimeMs >= staleMs)) continue;',
  '\t\t\ttry {',
  '\t\t\t\tawait rm(candidate, { force: true });',
  '\t\t\t\tremoved++;',
  '\t\t\t} catch {',
  '\t\t\t\t/* an undeletable leftover must never break the write path */',
  '\t\t\t}',
  '\t\t}',
  '\t} catch {',
  '\t\t/* an unreadable directory is not a write-path error */',
  '\t}',
  '\tif (removed > 0) console.log(`[storage-json] reclaimed ${removed} stale atomic-staging file(s) in ${dir}`);',
  '\treturn removed;',
  '}',
  ANCHOR_FN,
].join('\n')

// Anchor 3: call the sweep before publishing a new staging file into that directory.
const ANCHOR_CALL = '\tconst tmp = join(dirname(path), `.${randomUUID()}.tmp`);'
const REPLACEMENT_CALL = [ANCHOR_CALL, '\tawait sweepOrphanTmp(dirname(path));'].join('\n')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function fail(message) {
  console.log(message)
  process.exit(1)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const dryRun = process.argv.includes('--dry-run')
  const build = resolveCurrentBuild()
  assertLibUnpacked(build.asar)

  const target = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js')
  if (!existsSync(target)) fail(`ERR dsh-storage-json lib/index.js not found: ${target}`)

  const text = readFileSync(target, 'utf8')
  if (text.includes(ORPHAN_SWEEP_MARKER)) {
    console.log(`SKIP json-storage-orphan-sweep: marker already present (${target})`)
    process.exit(0)
  }

  const anchors = [
    { name: 'import list', anchor: ANCHOR_IMPORT, replacement: REPLACEMENT_IMPORT },
    { name: 'writeAtomic declaration', anchor: ANCHOR_FN, replacement: REPLACEMENT_FN },
    { name: 'staging-file call site', anchor: ANCHOR_CALL, replacement: REPLACEMENT_CALL },
  ]
  for (const { name, anchor } of anchors) {
    const occurrences = text.split(anchor).length - 1
    if (occurrences !== 1) fail(`ERR anchor "${name}" occurs ${occurrences} times (expected 1): ${JSON.stringify(anchor)}`)
  }
  try {
    // Parse-check only the injected helper: REPLACEMENT_FN intentionally ends with the
    // unclosed `async function writeAtomic(...) {` anchor, which cannot stand alone.
    const helperOnly = REPLACEMENT_FN.slice(0, REPLACEMENT_FN.length - ANCHOR_FN.length)
    // eslint-disable-next-line no-new-func
    new Function('return (async () => {\n' + helperOnly + '\n})')
  } catch (cause) {
    fail(`ERR injected helper does not parse: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (dryRun) {
    console.log(`DRY-RUN json-storage-orphan-sweep: 3 anchors each matched once, nothing written (${target})`)
    process.exit(0)
  }

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const backupRoot = join(REPO_ROOT, '_backups', `dist-json-storage-orphan-sweep-${stamp()}`)
  mkdirSync(backupRoot, { recursive: true })
  const backupPath = join(backupRoot, `storage-json-${stamp()}.bak`)
  copyFileSync(target, backupPath)

  let out = text
  for (const { anchor, replacement } of anchors) out = out.replace(anchor, replacement)
  if (!out.includes(ORPHAN_SWEEP_MARKER)) fail('ERR marker missing after replace')
  const tmp = target + '.json-storage-orphan-sweep.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, target)
  } catch (cause) {
    fail(`ERR atomic write: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!readFileSync(target, 'utf8').includes(ORPHAN_SWEEP_MARKER)) fail('ERR readback marker missing')

  console.log(`PATCHED json-storage-orphan-sweep -> ${target}`)
  console.log(`  backup: ${backupPath}`)
  console.log('done. effective on next boot (stale .<uuid>.tmp reclaimed on first write per directory).')
  console.log('run the fault-injection test: node --test tests/dist/json-storage-orphan-tmp-sweep.test.mjs')
}
