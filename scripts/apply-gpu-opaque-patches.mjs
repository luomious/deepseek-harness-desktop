#!/usr/bin/env node
// scripts/apply-gpu-opaque-patches.mjs - re-apply GPU/opaque-window patches (idempotent).
//
// Background (2026-08-25, thorough fix for transparent window + Not Responding):
// This machine has a virtual display adapter (GameViewer) that breaks Chromium
// GPU composition. The advanced desktop shell creates its main window with
// backgroundColor "#00000000" + backgroundMaterial "mica": Mica is a DWM effect
// that REQUIRES working GPU composition, so with GPU disabled (or broken by the
// virtual display) the window becomes fully transparent and the renderer hangs
// ("DSH Desktop not responding", cannot type).
//
// These patches:
//   1. lib/main.js          : force-disable GPU acceleration inside the app
//                             (works for EVERY launch path: shortcut, tray,
//                             auto-update restart - not only shortcut args).
//   2. lib/electron-runtime-*.js : make the advanced win32 window OPAQUE with
//                             a dark base color whenever GPU is force-disabled
//                             (Mica is skipped; the client surfaces already
//                             paint --dsw-alias-bg-base on top).
//   3. same chunk           : skip refreshThemeMaterial -> setBackgroundMaterial
//                             ("mica") under the same condition.
//
// Escape hatch: set DSH_DESKTOP_FORCE_GPU=1 to restore GPU acceleration + Mica
// (e.g. after the virtual display adapter is disabled device-wise).
//
// The compiled runtime chunk carries a content hash in its file name, so it is
// located dynamically. Run after each rebuild:
//   node scripts/apply-gpu-opaque-patches.mjs
// (package-vendor.ps1 calls this automatically right after apply-winhide-patches.)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'

const build = resolveCurrentBuild()
const GPU_ENV_MARKER = 'DSH_DESKTOP_FORCE_GPU'

function findRuntimeChunk(libDir) {
  const names = readdirSync(libDir).filter(name =>
    name.startsWith('electron-runtime-') && name.endsWith('.js') && !name.endsWith('.js.map'))
  if (names.length !== 1) {
    throw new Error(`expected exactly one electron-runtime-*.js chunk in ${libDir}, found: ${names.join(', ') || '(none)'}`)
  }
  return join(libDir, names[0])
}

const patches = [
  {
    name: 'gpu force-disable (lib/main.js)',
    file: join(build.lib, 'main.js'),
    marker: GPU_ENV_MARKER,
    anchor: '//#region src/crash-evidence.ts',
    replacement: [
      '// dsh patch (apply-gpu-opaque-patches): force-disable GPU acceleration.',
      '// The virtual display adapter on this machine breaks Chromium GPU',
      '// composition (transparent window, renderer hang, cannot type).',
      '// Set DSH_DESKTOP_FORCE_GPU=1 to restore GPU acceleration and Mica.',
      'if (!process.env.DSH_DESKTOP_FORCE_GPU) {',
      '\tapp.disableHardwareAcceleration();',
      '\tif (!app.commandLine.hasSwitch("disable-gpu")) app.commandLine.appendSwitch("disable-gpu");',
      '}',
      '//#region src/crash-evidence.ts',
    ].join('\n'),
  },
  {
    name: 'opaque win32 window (electron-runtime)',
    file: findRuntimeChunk(build.lib),
    marker: `${GPU_ENV_MARKER} ? "#00000000"`,
    anchor: '\t\tbackgroundColor: "#00000000",\n\t\tbackgroundMaterial: "mica",',
    replacement: [
      '\t\tbackgroundColor: process.env.DSH_DESKTOP_FORCE_GPU ? "#00000000" : "#202124",',
      `\t\t...(process.env.DSH_DESKTOP_FORCE_GPU ? { backgroundMaterial: "mica" } : {}),`,
    ].join('\n'),
  },
  {
    name: 'skip mica refresh (electron-runtime)',
    file: findRuntimeChunk(build.lib),
    marker: `if (process.env.${GPU_ENV_MARKER}) window.setBackgroundMaterial`,
    anchor: [
      '\trefreshThemeMaterial(window) {',
      '\t\twindow.setBackgroundMaterial("mica");',
      '\t}',
    ].join('\n'),
    replacement: [
      '\trefreshThemeMaterial(window) {',
      '\t\tif (process.env.DSH_DESKTOP_FORCE_GPU) window.setBackgroundMaterial("mica");',
      '\t}',
    ].join('\n'),
  },
  {
    // 2026-08-25 round 2: the opaque window STILL went transparent after a
    // hang. Remaining culprit: Chromium's native window occlusion detection,
    // which virtual display adapters (GameViewer ROOT\DISPLAY\0000) corrupt.
    // The window is falsely reported as occluded, Chromium stops presenting
    // frames (freeze -> "not responding") and the DWM surface goes blank.
    name: 'occlusion switches (lib/main.js)',
    file: join(build.lib, 'main.js'),
    marker: 'CalculateNativeWinOcclusion',
    anchor: '\tif (!app.commandLine.hasSwitch("disable-gpu")) app.commandLine.appendSwitch("disable-gpu");',
    replacement: [
      '\tif (!app.commandLine.hasSwitch("disable-gpu")) app.commandLine.appendSwitch("disable-gpu");',
      '\tif (!app.commandLine.hasSwitch("disable-features")) app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");',
      '\tapp.commandLine.appendSwitch("disable-backgrounding-occluded-windows");',
      '\tapp.commandLine.appendSwitch("disable-renderer-backgrounding");',
    ].join('\n'),
  },
]

let patched = 0
let skipped = 0
let failed = 0
for (const p of patches) {
  if (!existsSync(p.file)) {
    console.log('ERR missing target: ' + p.file + ' (' + p.name + ')')
    failed++
    continue
  }
  let text = ''
  try { text = readFileSync(p.file, 'utf8') } catch (cause) {
    console.log('ERR read ' + p.file + ': ' + (cause instanceof Error ? cause.message : String(cause)))
    failed++
    continue
  }
  if (text.includes(p.marker)) { skipped++; continue }
  if (!text.includes(p.anchor)) {
    console.log('ERR anchor missing in ' + p.file + ' (' + p.name + ')')
    failed++
    continue
  }
  const next = text.replace(p.anchor, p.replacement)
  try { writeFileSync(p.file, next, 'utf8') } catch (cause) {
    console.log('ERR write ' + p.file + ': ' + (cause instanceof Error ? cause.message : String(cause)))
    failed++
    continue
  }
  patched++
  console.log('PATCHED ' + p.name + ' -> ' + p.file)
}
console.log('current build: ' + build.buildDir)
console.log('done: ' + patched + ' patched, ' + skipped + ' already-ok, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
