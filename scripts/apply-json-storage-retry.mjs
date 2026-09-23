#!/usr/bin/env node
// scripts/apply-json-storage-retry.mjs - re-apply the "atomic replace must survive a
// transient handle lock" dist patch to the JSON storage backend (idempotent; re-run after
// every rebuild).
//
// Incident (2026-09-23, found while verifying the projcache-guard patches):
//   The session projection cache is rewritten as ONE whole file (dsh-storage-json: temp file
//   + rename over the target) roughly every 5 s per dirty session, and that file is 60 MB.
//   The app log carried:
//     [W] [session-projection-cache] interval write for "session-b14f2d2b-…" failed
//         (cache stays stale): Error: EPERM: operation not permitted,
//         rename '…\.dsh\storages\.88fa1e37-….tmp' -> '…\session_projcache.json'
//   On Windows a rename over an existing target fails with EPERM while ANY other handle holds
//   the target without FILE_SHARE_DELETE - the classic case being a real-time AV scanner
//   (this machine runs 火绒) inspecting the file that was just written, or a concurrent reader.
//   The failure is fail-soft (the cache row stays stale and the next write self-heals), but
//   nothing retried, so a transient lock silently cost that session its checkpoint.
//
// Fix (one anchor):
//   wrap `rename(tmp, path)` in a bounded retry (default 5 attempts, 40 ms * attempt backoff)
//   for the transient codes EPERM / EBUSY / EACCES only; any other error still fails at once.
//   The final error message carries the attempt count so a real failure is distinguishable
//   from a one-shot lock. Override the budget with DSH_STORAGE_RENAME_RETRIES.
//
// Registered in scripts/verify-patches.ps1 (json-storage-retry item).
// Fault-injection test: node --test tests/dist/json-storage-retry.test.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

/** Marker shared by the injected lines; also the verify-patches.ps1 probe. */
export const JSON_STORAGE_RETRY_MARKER = 'dsh patch json-storage-retry v1'

const ANCHOR = '\t\tawait rename(tmp, path);'
const REPLACEMENT = [
  '\t\t/* ' + JSON_STORAGE_RETRY_MARKER + ': a transient handle lock (AV scanner / concurrent reader)',
  '\t\t   makes rename-over-target fail with EPERM/EBUSY on Windows - retry those codes briefly. */',
  '\t\tconst renameRetries = Number(process.env.DSH_STORAGE_RENAME_RETRIES ?? 5);',
  '\t\tfor (let renameAttempt = 1; ; renameAttempt++) {',
  '\t\t\ttry {',
  '\t\t\t\tawait rename(tmp, path);',
  '\t\t\t\tbreak;',
  '\t\t\t} catch (renameError) {',
  '\t\t\t\tconst renameCode = renameError?.code;',
  '\t\t\t\tconst transient = renameCode === "EPERM" || renameCode === "EBUSY" || renameCode === "EACCES";',
  '\t\t\t\tif (!transient || renameAttempt >= renameRetries) {',
  '\t\t\t\t\tif (renameError && typeof renameError.message === "string") renameError.message = `${renameError.message} (after ${renameAttempt} rename attempt(s))`;',
  '\t\t\t\t\tthrow renameError;',
  '\t\t\t\t}',
  '\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, 40 * renameAttempt));',
  '\t\t\t}',
  '\t\t}',
].join('\n')

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
  if (text.includes(JSON_STORAGE_RETRY_MARKER)) {
    console.log(`SKIP json-storage-retry: marker already present (${target})`)
    process.exit(0)
  }
  const occurrences = text.split(ANCHOR).length - 1
  if (occurrences !== 1) fail(`ERR anchor occurs ${occurrences} times (expected 1): ${JSON.stringify(ANCHOR)}`)
  try {
    // eslint-disable-next-line no-new-func
    new Function('return (async () => {\n' + REPLACEMENT + '\n})')
  } catch (cause) {
    fail(`ERR injected text does not parse: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (dryRun) {
    console.log(`DRY-RUN json-storage-retry: anchor matched once, nothing written (${target})`)
    process.exit(0)
  }

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const backupRoot = join(REPO_ROOT, '_backups', `dist-json-storage-retry-${stamp()}`)
  mkdirSync(backupRoot, { recursive: true })
  const backupPath = join(backupRoot, `storage-json-${stamp()}.bak`)
  copyFileSync(target, backupPath)

  const out = text.replace(ANCHOR, REPLACEMENT)
  if (!out.includes(JSON_STORAGE_RETRY_MARKER)) fail('ERR marker missing after replace')
  const tmp = target + '.json-storage-retry.tmp'
  try {
    writeFileSync(tmp, out, 'utf8')
    renameSync(tmp, target)
  } catch (cause) {
    fail(`ERR atomic write: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!readFileSync(target, 'utf8').includes(JSON_STORAGE_RETRY_MARKER)) fail('ERR readback marker missing')

  console.log(`PATCHED json-storage-retry -> ${target}`)
  console.log(`  backup: ${backupPath}`)
  console.log('done. effective on next boot (rename retries absorb transient handle locks).')
  console.log('run the fault-injection test: node --test tests/dist/json-storage-retry.test.mjs')
}
