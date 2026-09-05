#!/usr/bin/env node
// scripts/apply-exit-cleanup.mjs - re-apply the exit-cleanup dist patches (idempotent).
//
// Why: two exit-path defects left "a dsh process" running after the user quit:
//   1. The hy3 gateway is spawned detached (plugins/dsh-hy3-gateway) and nothing
//      killed it when the app quit -> orphan "DSH Desktop.exe" kept running and
//      holding port 8787. Plugin-side fix adds a process.on('exit') hook; this
//      script's B2 patch tells that hook whether this exit is a RESTART.
//   2. The before-quit guard (lib/main.js) re-asked for confirmation even after
//      the user already chose 立即退出/仍然退出, and Esc/Enter silently cancelled
//      the quit -> the app never exited. B1 lets an explicit force-quit bypass
//      the activeAgentCount check so the app really quits.
//
// This script patches lib/main.js (app.asar.unpacked):
//   B1. guard bypass: if (globalThis.__dsh_critical_guard_state__
//       .forceQuitRequested === true) the quit proceeds without a second dialog.
//   B2. relaunch flag: globalThis.__dsh_relaunch_in_progress__ is set right
//       before native.exit so the gateway exit hook keeps the gateway alive
//       across RESTARTS and kills it only on the FINAL quit.
//
// Re-run after every rebuild:
//   node scripts/apply-exit-cleanup.mjs
// Registered in scripts/verify-patches.ps1 (exit-cleanup items).
// Full design/rollback notes: docs/EXIT-PROCESS-CLEANUP.md.
//
// NOTE: importing this module is side-effect free (safe for tests). The
// dist-patching logic only runs when this file is the main entry point.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

/** Marker shared by every injected line; also the verify-patches.ps1 probe. */
export const EXIT_CLEANUP_MARKER = 'dsh patch exit-cleanup v1'

// ---------------------------------------------------------------------------
// Patch table. Every anchor is byte-exact against the current build output
// (tabs as emitted by tsdown; verified 2026-09-04). Anchors must appear
// exactly once in their file; the applier fails loudly.
// ---------------------------------------------------------------------------
export const MAIN_PATCHES = [
  {
    name: 'guard-bypass',
    anchor: '\t\tif (shouldAllowQuit() && activeAgentCount() === 0) return true;',
    replacement: '\t\tif (shouldAllowQuit() && (activeAgentCount() === 0 || (globalThis.__dsh_critical_guard_state__ !== void 0 && globalThis.__dsh_critical_guard_state__.forceQuitRequested === true))) return true; /* ' + EXIT_CLEANUP_MARKER + ' (2026-09-04): explicit force-quit must not be re-asked */',
  },
  {
    name: 'relaunch-flag',
    anchor: '\t\t\tif (relaunchRequested && code === 0) native.relaunch();\n\t\t\tnative.exit(code);',
    replacement: '\t\t\tif (relaunchRequested && code === 0) native.relaunch();\n\t\t\t/* ' + EXIT_CLEANUP_MARKER + ' (2026-09-04): mark relaunch so the hy3-gateway exit hook keeps the gateway across restarts; final quit kills it. */\n\t\t\tglobalThis.__dsh_relaunch_in_progress__ = relaunchRequested && code === 0;\n\t\t\tnative.exit(code);',
  },
]

function backup(backupRoot, file, label) {
  mkdirSync(backupRoot, { recursive: true })
  const dest = join(backupRoot, `${basename(file)}.${label}`)
  copyFileSync(file, dest)
  return dest
}

function applyPatches(backupRoot, file, label, patches) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (cause) {
    console.log(`ERR read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  }
  if (text.includes(EXIT_CLEANUP_MARKER)) {
    console.log(`SKIP ${label}: marker already present (${file})`)
    return
  }
  const backupPath = backup(backupRoot, file, label)
  for (const p of patches) {
    const occurrences = text.split(p.anchor).length - 1
    if (occurrences !== 1) {
      console.log(`ERR anchor "${p.anchor.slice(0, 60)}..." in ${label} occurs ${occurrences} times (expected 1)`)
      process.exit(1)
    }
  }
  for (const p of patches) {
    text = text.replace(p.anchor, p.replacement)
  }
  // Syntax sanity: every injected replacement must parse as plain statements.
  for (const p of patches) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(p.replacement)
    } catch (cause) {
      console.log(`ERR injected text does not parse (${p.name}): ${cause instanceof Error ? cause.message : String(cause)}`)
      process.exit(1)
    }
  }
  // Atomic write: temp file + rename (parallel sessions must never read a
  // half-written lib file).
  const tmp = file + '.exit-cleanup.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
  console.log(`PATCHED ${label} (${patches.length} patches) -> ${file}`)
  console.log(`  backup: ${backupPath}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  const build = resolveCurrentBuild()
  // Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
  // target app.asar.unpacked and would otherwise become silently ineffective).
  assertLibUnpacked(build.asar)

  const BACKUP_ROOT = join(VENDOR_ROOT, '..', '..', '..', '_backups', `dist-exit-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const mainFile = join(build.lib, 'main.js')

  applyPatches(BACKUP_ROOT, mainFile, 'main.js', MAIN_PATCHES)

  console.log('current build: ' + build.buildDir)
  console.log('done. exit-cleanup patches effective on next boot (guard bypass + relaunch flag).')
}
