#!/usr/bin/env node
// scripts/apply-scroll-anchor-fixes.mjs
//
// 2026-09-17 · conversation scroll-anchor cost fix (S2')
//
// WHY: `onScroll` runs on every scroll frame while the reader is away from the bottom, and
// `pagingAnchor()` used to (a) re-run `querySelector("[data-composer-seat]")` on a whole
// subtree, (b) do up to FOUR `document.elementsFromPoint()` hit tests, and (c) when those
// missed, read `getBoundingClientRect()` for EVERY anchor row (O(n) forced layout per frame).
// Measured long-session DOMs make (c) the dominant per-frame cost.
//
// WHAT (three edits, behaviour-preserving, mirroring upstream @deepseek-ai/dsh-client-ui-chat
// 0.1.3 `pagingAnchor` which fixed the same hot path):
//   1. binary anchor  : O(n) per-row rect scan  -> O(log n) binary search
//   2. single hit point: 4 elementsFromPoint()  -> 1  (viewport.top + 1)
//   3. seat cache     : per-frame subtree query -> WeakMap cache + isConnected revalidation
//
// WHERE: `patches/bundles/dsh-client-ui-conversation-client.js` is the CANON source that
// scripts/port-user-patches.mjs restores into the dev tree and the packaged app. The patch is
// therefore applied to CANON first and then propagated to both live targets, so a later
// `port-user-patches.mjs` run cannot silently revert it. Gate: scripts/verify-patches.ps1
// (`scroll-anchor: *`). Backup: _backups/scroll-anchor-fixes-<stamp>/.
//
// Usage:  node scripts/apply-scroll-anchor-fixes.mjs [--check]
//   --check : report drift only, never write (exit 1 when any target lacks the fix)
//
// Idempotent / atomic / fail-loud on anchor drift (same discipline as the other apply-*.mjs).

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFileSync } from './lib/atomic-write.mjs'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SCRIPTS)
const checkOnly = process.argv.includes('--check')

const M1 = 'dsh-scroll-fix-2026-09-17 (binary anchor)'
const M2 = 'dsh-scroll-fix-2026-09-17 (single hit point)'
const M3 = 'dsh-scroll-fix-2026-09-17 (seat cache)'
const MARKERS = [M1, M2, M3]

// --- targets -----------------------------------------------------------------------------
const CANON = join(REPO_ROOT, 'patches', 'bundles', 'dsh-client-ui-conversation-client.js')
const DEV = join(
  REPO_ROOT, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'node_modules',
  '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js',
)
const build = JSON.parse(execFileSync('node', [join(SCRIPTS, 'resolve-dist.mjs')], { encoding: 'utf8' }))
const PKG = join(build.unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js')
const TARGETS = [DEV, PKG]

// --- the three edits: [marker, oldText, newText] ------------------------------------------
const EDITS = [
  {
    marker: M1,
    old: '\t\t\tconst rows = [...list.querySelectorAll("[data-chat-anchor-key]")];\n' +
      '\t\t\treturn rows.filter((row) => {\n' +
      '\t\t\t\tconst rect = row.getBoundingClientRect();\n' +
      '\t\t\t\treturn rect.bottom > viewport.top && rect.top < visibleBottom;\n' +
      '\t\t\t})[0] ?? rows[0] ?? null;',
    new: `\t\t\t/* ${M1}: the old fallback read a rect for EVERY anchor row (O(n) forced layout\n` +
      '\t\t\t   on each scroll frame). Binary-search the first row whose bottom sits below the\n' +
      '\t\t\t   viewport top instead (O(log n)) - the same strategy upstream ui-chat 0.1.3 uses. */\n' +
      '\t\t\tconst rows = list.querySelectorAll("[data-chat-anchor-key]");\n' +
      '\t\t\tlet low = 0;\n' +
      '\t\t\tlet high = rows.length;\n' +
      '\t\t\twhile (low < high) {\n' +
      '\t\t\t\tconst middle = low + high >>> 1;\n' +
      '\t\t\t\tif (rows.item(middle).getBoundingClientRect().bottom > viewport.top) high = middle;\n' +
      '\t\t\t\telse low = middle + 1;\n' +
      '\t\t\t}\n' +
      '\t\t\tconst binaryRow = rows[low];\n' +
      '\t\t\treturn binaryRow !== void 0 && binaryRow.getBoundingClientRect().top < visibleBottom ? binaryRow : rows[0] ?? null;',
  },
  {
    marker: M2,
    old: '\t\t\t\tconst points = [\n' +
      '\t\t\t\t\t1,\n' +
      '\t\t\t\t\tMath.min(32, height / 3),\n' +
      '\t\t\t\t\theight / 2,\n' +
      '\t\t\t\t\tMath.max(1, height - 1)\n' +
      '\t\t\t\t];\n' +
      '\t\t\t\tfor (const offset of points) for (const element of document.elementsFromPoint(x, viewport.top + offset)) {',
    new: `\t\t\t\t/* ${M2}: four hit tests per scroll frame -> one (viewport.top + 1), as upstream\n` +
      '\t\t\t\t   ui-chat 0.1.3 does. A miss is now cheap because the fallback is O(log n). */\n' +
      '\t\t\t\tfor (const element of document.elementsFromPoint(x, viewport.top + 1)) {',
  },
  {
    marker: M3,
    old: '\t\tfunction pagingAnchor(list, scrollport) {\n' +
      '\t\t\tconst viewport = scrollport.getBoundingClientRect();\n' +
      '\t\t\tconst visibleBottom = scrollport.querySelector("[data-composer-seat]")?.getBoundingClientRect().top ?? viewport.bottom;',
    new: `\t\t/* ${M3}: the composer-seat lookup ran a subtree querySelector on every scroll frame;\n` +
      '\t\t   cache the node and re-resolve only when it leaves the DOM. */\n' +
      '\t\tconst __dshComposerSeatCache = /* @__PURE__ */ new WeakMap();\n' +
      '\t\tfunction __dshComposerSeat(scrollport) {\n' +
      '\t\t\tconst cached = __dshComposerSeatCache.get(scrollport);\n' +
      '\t\t\tif (cached !== void 0 && cached.isConnected) return cached;\n' +
      '\t\t\tconst found = scrollport.querySelector("[data-composer-seat]");\n' +
      '\t\t\tif (found !== null) __dshComposerSeatCache.set(scrollport, found);\n' +
      '\t\t\treturn found;\n' +
      '\t\t}\n' +
      '\t\tfunction pagingAnchor(list, scrollport) {\n' +
      '\t\t\tconst viewport = scrollport.getBoundingClientRect();\n' +
      '\t\t\tconst visibleBottom = __dshComposerSeat(scrollport)?.getBoundingClientRect().top ?? viewport.bottom;',
  },
]

const markerCount = (text) => MARKERS.map((m) => text.split(m).length - 1)

// --- drift report -----------------------------------------------------------------------
let drift = 0
for (const file of [CANON, ...TARGETS]) {
  if (!existsSync(file)) { console.error(`FAIL  missing target: ${file}`); drift++; continue }
  const counts = markerCount(readFileSync(file, 'utf8'))
  const ok = counts.every((c) => c === 1)
  console.log(`${ok ? 'OK  ' : 'DRIFT'} ${counts.join('/')}  ${file.replace(REPO_ROOT, '.')}`)
  if (!ok) drift++
}
if (checkOnly) {
  console.log(drift === 0 ? 'CHECK: all targets carry the fix' : `CHECK: ${drift} target(s) drifted -> run without --check`)
  process.exit(drift === 0 ? 0 : 1)
}

// --- patch the canon -------------------------------------------------------------------
let canon = readFileSync(CANON, 'utf8')
if (markerCount(canon).every((c) => c === 1)) {
  console.log('canon already patched (all 3 markers present)')
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(REPO_ROOT, '_backups', `scroll-anchor-fixes-${stamp}`)
  mkdirSync(backupDir, { recursive: true })
  for (const file of [CANON, ...TARGETS]) {
    if (existsSync(file)) copyFileSync(file, join(backupDir, `${file.split(/[\\/]/).slice(-1)[0]}.${file === CANON ? 'canon' : file === DEV ? 'dev' : 'pkg'}.before`))
  }
  console.log(`backup -> ${backupDir.replace(REPO_ROOT, '.')}`)

  let applied = 0
  for (const { marker, old, new: next } of EDITS) {
    if (canon.includes(marker)) { console.log(`skip (already applied): ${marker}`); applied++; continue }
    const hits = canon.split(old).length - 1
    if (hits !== 1) {
      console.error(`ANCHOR DRIFT (${hits} matches, expected 1) for ${marker} -> NOT WRITING`)
      process.exit(1)
    }
    canon = canon.replace(old, next)
    applied++
  }
  if (applied !== EDITS.length) { console.error(`only ${applied}/${EDITS.length} edits applied -> NOT WRITING`); process.exit(1) }
  atomicWriteFileSync(CANON, canon)
  console.log(`canon patched (${applied}/${EDITS.length} edits)`)
}

// --- propagate canon -> live targets ---------------------------------------------------
for (const file of TARGETS) {
  const current = readFileSync(file, 'utf8')
  if (current === canon) { console.log(`up-to-date: ${file.replace(REPO_ROOT, '.')}`); continue }
  atomicWriteFileSync(file, canon)
  console.log(`propagated -> ${file.replace(REPO_ROOT, '.')}`)
}

// --- verify ----------------------------------------------------------------------------
let failed = 0
for (const file of TARGETS) {
  const text = readFileSync(file, 'utf8')
  const counts = markerCount(text)
  if (!counts.every((c) => c === 1)) { console.error(`FAIL  markers ${counts.join('/')} in ${file}`); failed++ }
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' })
  } catch (cause) {
    console.error(`FAIL  node --check ${file}\n${cause.stderr?.toString().slice(0, 400) ?? cause.message}`)
    failed++
  }
}
if (readFileSync(CANON, 'utf8') !== readFileSync(TARGETS[1], 'utf8')) { console.error('FAIL  canon != packaged target'); failed++ }
console.log(failed === 0 ? 'ALL OK (3 edits, 2 targets, syntax clean, canon == packaged)' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
