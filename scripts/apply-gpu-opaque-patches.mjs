#!/usr/bin/env node
// scripts/apply-gpu-opaque-patches.mjs - re-apply GPU/opaque-window/zombie patches (idempotent).
//
// Patches (all survive rebuilds via package-vendor.ps1 -> verify-patches.ps1):
//   1. lib/main.js          : force-disable GPU acceleration inside the app
//   2. lib/main.js          : zombie orphan cleanup on startup (pre-port-probe)
//   3. lib/electron-runtime-*.js : opaque win32 window + conditional mica
//   4. lib/electron-runtime-*.js : guarded refreshThemeMaterial
//   5. lib/main.js          : occlusion + backgrounding switches
//
// Run after each rebuild:  node scripts/apply-gpu-opaque-patches.mjs
// (package-vendor.ps1 calls this automatically right after apply-winhide-patches.)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const build = resolveCurrentBuild()
// Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
// target app.asar.unpacked and would otherwise become silently ineffective).
assertLibUnpacked(build.asar)
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
    // 2026-08-25: when the app freezes and the user force-kills it, Electron
    // child processes (renderer/GPU/utility) often survive as orphans and hold
    // port 43120. A fresh launch then sees the port occupied, assumes another
    // live instance is serving, and silently quits.
    //
    // This patch inserts a zombie-cleanup function and calls it BEFORE the
    // existing duplicate-instance port probe.
    name: 'zombie-orphan cleanup (lib/main.js)',
    file: join(build.lib, 'main.js'),
    marker: 'ZombieCleanup(',
    anchor: '/** Start one Electron process and leave lifetime to the mounted desktop plugin. */\nasync function start() {',
    replacement: [
      'function ZombieCleanup() {',
      '\tconst _exe = process.execPath || process.argv[0]; if (!_exe) return;',
      "\tconst _cmd = \"Get-Process | Where-Object { $_.Path -eq '\" + _exe.replace(/'/g, \"''\") + \"' -and $_.Id -ne \" + process.pid + \" } | Stop-Process -Force -ErrorAction SilentlyContinue\";",
      "\ttry { require('child_process').execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', _cmd], { encoding: 'utf8', timeout: 8000, windowsHide: true }); } catch {}",
      '\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // let Windows release handles',
      '}',
      '/** Start one Electron process and leave lifetime to the mounted desktop plugin. */',
      'async function start() {',
      '\tZombieCleanup(); // Clean orphaned child processes from previous crash BEFORE port probe',
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
