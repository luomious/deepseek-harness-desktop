#!/usr/bin/env node
// scripts/apply-winhide-patches.mjs - re-apply windowsHide patches (idempotent).
//
// The desktop shell has no console: any child process spawned without
// windowsHide flashes a black console window on Windows. These manual patches
// live in build outputs and get wiped by every rebuild, so run this after
// each rebuild:
//   node scripts/apply-winhide-patches.mjs
// It re-applies the dist-level patches (subprocess-local / open /
// default-browser / materializer) to BOTH the vendor dev node_modules and the
// CURRENT build, which is resolved dynamically via scripts/resolve-dist.mjs
// (same rule as update-shortcuts.ps1). Plugins (vision-engine, autoread,
// project-brief) are tracked in git and need no re-application.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'

const VENDOR = VENDOR_ROOT
const build = resolveCurrentBuild()

const patches = [
  {
    name: 'dsh-subprocess-local',
    targets: [
      join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'),
      join(build.nodeModules, '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'),
    ],
    marker: 'windowsHide: true',
    anchor: 'detached: platform !== "win32"',
    replacement: 'detached: platform !== "win32",\n\t\twindowsHide: true',
  },
  {
    name: 'open',
    targets: [
      join(VENDOR, 'node_modules', 'open', 'index.js'),
      join(build.nodeModules, 'open', 'index.js'),
    ],
    marker: 'windowsHide = true',
    anchor: 'childProcessOptions.windowsVerbatimArguments = true;',
    replacement: 'childProcessOptions.windowsVerbatimArguments = true;\n\t\tchildProcessOptions.windowsHide = true; // dsh patch: hide console',
  },
  {
    name: 'default-browser',
    targets: [
      join(VENDOR, 'node_modules', 'default-browser', 'windows.js'),
      join(build.nodeModules, 'default-browser', 'windows.js'),
    ],
    marker: 'windowsHide: true',
    anchor: "'/v',\n\t\t'ProgId',\n\t]);",
    replacement: "'/v',\n\t\t'ProgId',\n\t], {windowsHide: true});",
  },
  {
    name: 'materializer (lib/main.js)',
    targets: [
      join(build.lib, 'main.js'),
    ],
    marker: 'windowsHide: true,',
    anchor: 'detached: process.platform !== "win32",\n\t\tstdio: [',
    replacement: 'detached: process.platform !== "win32",\n\t\twindowsHide: true,\n\t\tstdio: [',
  },
]

let patched = 0
let skipped = 0
let failed = 0
for (const p of patches) {
  for (const file of p.targets) {
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch (cause) {
      console.log('ERR read ' + file + ': ' + (cause instanceof Error ? cause.message : String(cause)))
      failed++
      continue
    }
    if (text.includes(p.marker)) { skipped++; continue }
    if (!text.includes(p.anchor)) {
      console.log('ERR anchor missing in ' + file + ' (' + p.name + ')')
      failed++
      continue
    }
    const next = text.replace(p.anchor, p.replacement)
    try { writeFileSync(file, next, 'utf8') } catch (cause) {
      console.log('ERR write ' + file + ': ' + (cause instanceof Error ? cause.message : String(cause)))
      failed++
      continue
    }
    patched++
    console.log('PATCHED ' + p.name + ' -> ' + file)
  }
}
console.log('current build: ' + build.buildDir)
console.log('done: ' + patched + ' patched, ' + skipped + ' already-ok, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
