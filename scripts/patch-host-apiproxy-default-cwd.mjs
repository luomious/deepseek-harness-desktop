#!/usr/bin/env node
// scripts/patch-host-apiproxy-default-cwd.mjs
// Host-side backstop for the "Chat without a workspace" (不在项目中工作) flow.
//
// Problem: dsh-host-apiproxy's ApiProxyService hardcodes the default session cwd
// as `process.cwd()` (the desktop app's launch dir = the current project dir).
// `session.create` with an empty payload (no workspaceId, no cwd) then falls back
// to that default, so the new session's cwd lands inside the current project
// workspace and the workspace registry claims it there.
//
// Fix (idempotent): make the default cwd `os.homedir()` instead, so an
// empty-payload create produces a session whose cwd is OUTSIDE every registered
// workspace. The client bundle fix (startChatSession -> { cwd: home }) already
// covers the patched bundle; this backstop also covers stale cached bundles that
// still send the empty payload.
//
// Targets: dev node_modules + the current packaged build (resolve-dist.mjs).
// Rebuilds overwrite the packaged file -> re-run this script (registered in
// verify-patches.ps1; package-vendor.ps1 should call it after each build).
//
// NOTE: this is a HOST module, so it only takes effect after the desktop app is
// restarted (Node module cache). Browser refresh is NOT enough for this one.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const MARK = 'cwd: homedir(), /* dsh-desktop patch'
const ANCHOR = '\t\t\tcwd: process.cwd(),'
const REPLACEMENT = '\t\t\tcwd: homedir(), /* dsh-desktop patch: empty session.create lands in home (outside any workspace) */'

const DEV_ROOT = 'D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/@deepseek-ai'
const build = resolveCurrentBuild()
// Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
// target app.asar.unpacked and would otherwise become silently ineffective).
assertLibUnpacked(build.asar)
const PKG_ROOT = build.unpackedRoot.replace(/\\/g, '/') + '/node_modules/@deepseek-ai'

const targets = [
  { name: 'dev dsh-host-apiproxy', file: join(DEV_ROOT, 'dsh-host-apiproxy', 'lib', 'index.js') },
  { name: 'pkg dsh-host-apiproxy', file: join(PKG_ROOT, 'dsh-host-apiproxy', 'lib', 'index.js') },
]

let patched = 0
let skipped = 0
let failed = 0
for (const t of targets) {
  if (!existsSync(t.file)) {
    console.log(`ERR missing target: ${t.file} (${t.name})`)
    failed++
    continue
  }
  let text = ''
  try { text = readFileSync(t.file, 'utf8') } catch (cause) {
    console.log(`ERR read ${t.file}: ${cause instanceof Error ? cause.message : String(cause)}`)
    failed++
    continue
  }
  if (text.includes(MARK)) {
    skipped++
    console.log(`SKIP  ${t.name} (already patched)`)
    continue
  }
  if (!text.includes(ANCHOR)) {
    console.log(`ERR anchor missing in ${t.file} (${t.name})`)
    failed++
    continue
  }
  const next = text.replace(ANCHOR, REPLACEMENT)
  try { writeFileSync(t.file, next, 'utf8') } catch (cause) {
    console.log(`ERR write ${t.file}: ${cause instanceof Error ? cause.message : String(cause)}`)
    failed++
    continue
  }
  patched++
  console.log(`PATCHED ${t.name} -> ${t.file}`)
}

console.log('current build: ' + build.buildDir)
console.log(`done: ${patched} patched, ${skipped} already-ok, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
