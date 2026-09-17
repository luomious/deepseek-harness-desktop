#!/usr/bin/env node
// scripts/gpu-mode.mjs - switch DSH Desktop between hardware acceleration and the
// old software-rendering path WITHOUT rebuilding anything.
//
// Background: `scripts/apply-gpu-opaque-patches.mjs` (patch #7, 2026-09-16) makes
// hardware acceleration the default while keeping the window OPAQUE, so a GPU
// failure can no longer produce the 2026-09-07 ghost (see-through) window -
// Chromium just falls back to software rendering. This script flips that decision
// by creating/removing the sentinel file the patched bootstrap checks:
//
//   <exe dir>/dsh-gpu-off.flag   present -> software raster (pre-2026-09-16)
//                                absent  -> hardware acceleration (default)
//
// Usage:
//   node scripts/gpu-mode.mjs --status     # report mode + paths
//   node scripts/gpu-mode.mjs --software   # create the sentinel (rollback)
//   node scripts/gpu-mode.mjs --hardware   # remove the sentinel
//
// A restart of DSH Desktop is required for either change to take effect.

import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'

const build = resolveCurrentBuild()
// build.lib = <win-unpacked>/resources/app.asar.unpacked/lib
const exeDir = resolve(build.lib, '..', '..', '..')
const flag = join(exeDir, 'dsh-gpu-off.flag')

const arg = process.argv[2] || '--status'
const modes = new Set(['--status', '--software', '--hardware'])
if (!modes.has(arg)) {
  console.error(`usage: node scripts/gpu-mode.mjs [--status|--software|--hardware]\nunknown argument: ${arg}`)
  process.exit(2)
}

const current = existsSync(flag) ? 'software' : 'hardware'
if (arg === '--status') {
  console.log(JSON.stringify({ mode: current, sentinel: flag, exists: existsSync(flag), exeDir, build: build.buildDir }, null, 2))
  process.exit(0)
}

if (arg === '--software') {
  if (!existsSync(flag)) {
    writeFileSync(flag, `software rendering requested by scripts/gpu-mode.mjs at ${new Date().toISOString()}\n`, 'utf8')
  }
  console.log(`mode -> software (sentinel created: ${flag})`)
} else {
  if (existsSync(flag)) rmSync(flag)
  console.log(`mode -> hardware (sentinel removed: ${flag})`)
}
console.log('restart DSH Desktop for the change to take effect.')
