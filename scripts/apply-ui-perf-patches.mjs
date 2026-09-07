#!/usr/bin/env node
// scripts/apply-ui-perf-patches.mjs - idempotent (re)apply of the 2026-09-06
// renderer performance patches (desktop window "typing lag / not responding").
//
// PROBLEM (2026-09-06): the DSH Desktop window froze/lagged while typing. Root
// causes, proven by A/B measurements (renderer idle CPU 85-90% -> 0%):
//   1. dsh-better-sidebar v0.15.2 kept its center-column locator + Mutation
//      Observers + 1.5 s interval running while the side AND bottom panels
//      were BOTH collapsed -> constant full-DOM scanning on large sessions.
//   2. dsh-vision-engine's global `input` capture listener re-ran render()
//      on every keystroke and fell back to document.querySelectorAll('textarea,
//      input') full-DOM scan when no image path matched.
//
// FIX (marker comments 'DSH-PERF: better-sidebar-collapse-gate' and
// 'DSH-PERF: vision-engine-input-light' are added when THIS script applies the
// change; hand-applied files are recognized by their fix FEATURES, so both
// states are idempotent - running twice never double-injects):
//   - better-sidebar: skip locate()/observers/1.5s interval while both panels
//     are collapsed; re-arm on expand. Also gate the settings-nav icon
//     observer on [role=dialog] presence.
//   - vision-engine: render(allowFullScan) - keystroke path only checks the
//     focused input; the 3s fallback timer keeps the full scan.
//
// Targets live OUTSIDE the dist (profile node_modules plugin + repo plugin):
// rebuilds do not wipe them, but `dsh plugin update` / a checkout restore do.
// Run this after such events; verify-patches.ps1 asserts the fix features.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const BS_MARKER = 'DSH-PERF: better-sidebar-collapse-gate'
const VE_MARKER = 'DSH-PERF: vision-engine-input-light'

const bsDir = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-better-sidebar', 'lib')
const veAbs = join(process.cwd(), 'plugins', 'dsh-vision-engine', 'lib')

function fail(msg) {
  console.error('FAIL  ' + msg)
  process.exitCode = 1
}

function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return true
  } catch (e) {
    fail('node --check ' + file + ' failed: ' + String(e && e.message || e))
    return false
  }
}

// ---------- better-sidebar ----------
const bsFile = join(bsDir, 'client.js')
if (!existsSync(bsFile)) {
  fail('better-sidebar client.js not found at ' + bsFile)
} else {
  let src = readFileSync(bsFile, 'utf8')
  // Fix FEATURES (hand-applied state has these without the marker comment).
  const bsHasGate = src.includes('if (!(state && (state.panelOpen || state.bottomOpen))) return;')
  const bsHasNav = src.includes('document.querySelector("[role=\\"dialog\\"]") === null') || src.includes('document.querySelector("[role=&quot;dialog&quot;]") === null')
  if (bsHasGate && bsHasNav) {
    console.log('ok    better-sidebar already patched (fix features present)')
  } else {
    const edits = []
    if (!bsHasGate) {
      edits.push([
        'const locate = () => {\n\t\t\t\t\tif (disposed) return;',
        'const locate = () => {\n\t\t\t\t\tif (disposed) return;\n\t\t\t\t\t// ' + BS_MARKER + '. Skip all DOM scanning while side AND bottom panels are collapsed.\n\t\t\t\t\tif (!(state && (state.panelOpen || state.bottomOpen))) return;'
      ])
      edits.push([
        '\t\t\t\tlocate();\n\t\t\t\tlet locateFrame = null;',
        '\t\t\t\t// ' + BS_MARKER + '. While both panels are collapsed nothing needs alignment;\n\t\t\t\t// skip observers + 1.5s interval (re-arms on expand via deps).\n\t\t\t\tif (!(state && (state.panelOpen || state.bottomOpen))) return;\n\t\t\t\tlocate();\n\t\t\t\tlet locateFrame = null;'
      ])
      edits.push([
        '[measureCenter, state?.bottomOpen]);',
        '[measureCenter, state?.bottomOpen, state?.panelOpen]);'
      ])
    }
    if (!bsHasNav) {
      edits.push([
        'const sync = () => {\n\t\t\t\tif (disposed) return;\n\t\t\t\tconst currentLabel = label().trim();',
        'const sync = () => {\n\t\t\t\tif (disposed) return;\n\t\t\t\t// ' + BS_MARKER + '. No settings dialog mounted -> nothing to mark; skip the full query.\n\t\t\t\tif (document.querySelector("[role=\\"dialog\\"]") === null) return;\n\t\t\t\tconst currentLabel = label().trim();'
      ])
    }
    let changed = false
    let allOk = true
    for (const [old, next] of edits) {
      if (src.includes(old)) { src = src.replace(old, next); changed = true; console.log('patched  better-sidebar: ' + (old.split('\n')[0].slice(0, 60))) }
      else { fail('better-sidebar: anchor not found -> ' + (old.split('\n')[0].slice(0, 60))); allOk = false }
    }
    if (changed && allOk) {
      copyFileSync(bsFile, bsFile + '.bak-' + new Date().toISOString().slice(0, 10))
      writeFileSync(bsFile, src)
      checkSyntax(bsFile)
      console.log('patched better-sidebar (' + BS_MARKER + ')')
    }
  }
}

// ---------- vision-engine ----------
const veFile = join(veAbs, 'client.js')
if (!existsSync(veFile)) {
  fail('vision-engine client.js not found at ' + veFile)
} else {
  let src = readFileSync(veFile, 'utf8')
  const veHasFix = src.includes('function render(allowFullScan)') && src.includes('render(false);') && src.includes('render(true);')
  if (veHasFix) {
    console.log('ok    vision-engine already patched (fix features present)')
  } else {
    const edits = [
      ['function render() {',
       '// ' + VE_MARKER + '. Keystroke path must not full-scan the DOM; only the 3s fallback timer does.\n      function render(allowFullScan) {'],
      ["          if (paths.length === 0) {\n            var boxes = document.querySelectorAll('textarea,input');",
       "          if (paths.length === 0 && allowFullScan) {\n            var boxes = document.querySelectorAll('textarea,input');"],
      ['__veRaf = window.requestAnimationFrame(function () {\n          __veRaf = null;\n          render();\n        });',
       '__veRaf = window.requestAnimationFrame(function () {\n          __veRaf = null;\n          render(false);\n        });'],
      ['timer: window.setInterval(function () { render(); }, 3000)',
       'timer: window.setInterval(function () { render(true); }, 3000)']
    ]
    let changed = false
    let allOk = true
    for (const [old, next] of edits) {
      if (src.includes(old)) { src = src.replace(old, next); changed = true }
      else { fail('vision-engine: anchor not found -> ' + old.split('\n')[0]); allOk = false }
    }
    if (changed && allOk) {
      copyFileSync(veFile, veFile + '.bak-' + new Date().toISOString().slice(0, 10))
      writeFileSync(veFile, src)
      checkSyntax(veFile)
      console.log('patched vision-engine (' + VE_MARKER + ')')
    }
  }
}

if (process.exitCode === undefined || process.exitCode === 0) {
  console.log('done    ui-perf patches verified (or already applied)')
}
