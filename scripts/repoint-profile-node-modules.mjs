#!/usr/bin/env node
/**
 * repoint-profile-node-modules.mjs - make the profile junction farm FOLLOW the promote.
 *
 * THE PROBLEM (measured 2026-09-28)
 * ---------------------------------
 * `~/.dsh/profiles/node_modules` is a farm of ~203 junctions that the profile's plugins
 * resolve `@deepseek-ai/*` through. On this machine 199 of them point at an ABSOLUTE
 * build directory:
 *
 *     ...\dist\win-unpacked-build202608272104\win-unpacked\resources\app.asar.unpacked\node_modules\...
 *     ^ i.e. the 0.1.1 build -- a PINNED build, not the `win-unpacked` entry junction
 *
 * Proved with a resolver probe: from a profile plugin, `@deepseek-ai/dsh-llm` resolves to
 * **v0.1.1-rc.2**. So `promote-build.ps1` (which only re-points `dist\win-unpacked`) does
 * NOT change what the profile's plugins see -- a promoted 0.1.7 app would still load 0.1.1
 * kernel packages, and every profile plugin bumped to the 0.1.7 API line would fail to link.
 *
 * WHAT IT DOES
 * ------------
 * Rewrites every farm junction whose target lives under our dist tree so that it points at
 * `<dist>\win-unpacked\resources\app.asar.unpacked\node_modules\<same sub-path>` -- the
 * ENTRY junction, which `promote-build.ps1` moves. After this, promoting a new build
 * automatically switches the whole farm with it.
 *
 * Usage:
 *   node scripts/repoint-profile-node-modules.mjs                 # DRY-RUN (default)
 *   node scripts/repoint-profile-node-modules.mjs --apply
 *   node scripts/repoint-profile-node-modules.mjs --apply --profile desktop
 *
 * Safety:
 *   - dry-run by default; nothing is written without --apply
 *   - writes a before-catalog (name -> old target) into _backups/profile-node-modules-repoint-<ts>/
 *   - only touches entries that are junctions AND whose target contains our dist marker
 *   - real directories, non-dist targets (e.g. a global npm dir) and missing sub-paths are
 *     reported and skipped, never deleted
 *   - after --apply it re-reads every changed junction and asserts the new target exists
 *
 * RUN THIS WITH THE APP CLOSED, in the same session as promote-build.ps1.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')
const ENTRY = path.join(DIST, 'win-unpacked')
const MARKER = path.join('resources', 'app.asar.unpacked', 'node_modules')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const i = argv.indexOf('--profile')
const farmFlag = argv.indexOf('--farm')
const PROFILE_ROOT = path.join(os.homedir(), '.dsh', 'profiles')
const profile = i >= 0 && argv[i + 1] ? argv[i + 1] : 'desktop'
const FARM = farmFlag >= 0 && argv[farmFlag + 1] ? path.resolve(argv[farmFlag + 1]) : path.join(PROFILE_ROOT, 'node_modules')

const ENTRY_NM = path.join(ENTRY, MARKER)

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Read one farm entry's link state WITHOUT spawning a process.
 *
 * Measured 2026-09-29: on this machine Node reports a Windows junction as
 * `lstatSync().isSymbolicLink() === true` and `readlinkSync()` returns the plain
 * absolute target (no `\\?\` prefix). The previous implementation probed every entry
 * with two `powershell` child processes; a pure-JS scan of all 549 entries takes
 * **147 ms** versus >120 s with the spawns, and the spawn cost grows with the farm.
 * A `\\?\` strip is kept as a cheap guard for other Node/OS combinations.
 */
function linkInfo(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return { junction: false, target: null } }
  if (!st.isSymbolicLink()) return { junction: false, target: null }
  let target = null
  try {
    target = fs.readlinkSync(p)
    if (target.startsWith('\\\\?\\')) target = target.slice(4)
    else if (target.startsWith('\\??\\')) target = target.slice(4)
  } catch { /* unreadable reparse point -> reported as 'target unreadable' */ }
  return { junction: true, target }
}

// ---------------------------------------------------------------- scan

if (!fs.existsSync(FARM)) { console.error(`repoint: farm not found at ${FARM}`); process.exit(2) }
if (!fs.existsSync(ENTRY_NM)) { console.error(`repoint: entry junction has no ${MARKER}; promote/build first`); process.exit(2) }

const changed = []
const skipped = []
let scanned = 0

function consider(dir, name, full) {
  scanned++
  const label = name
  const info = linkInfo(full)
  if (!info.junction) { skipped.push({ name: label, reason: 'not a junction' }); return }
  const target = info.target
  if (!target) { skipped.push({ name: label, reason: 'target unreadable' }); return }
  const idx = target.indexOf(MARKER)
  if (idx < 0) { skipped.push({ name: label, reason: `target outside dist (${path.dirname(target)})` }); return }
  const sub = target.slice(idx + MARKER.length).replace(/^[\\/]+/, '')
  const next = sub.length ? path.join(ENTRY_NM, sub) : ENTRY_NM
  if (path.resolve(target) === path.resolve(next)) return // already follows the entry
  if (!fs.existsSync(next)) { skipped.push({ name: label, reason: `sub-path missing in entry junction: ${sub}` }); return }
  changed.push({ name: label, full, from: target, to: next })
}

for (const e of fs.readdirSync(FARM, { withFileTypes: true })) {
  if (e.name === '.bin' || e.name === '.pnpm') continue
  const full = path.join(FARM, e.name)
  if (e.name.startsWith('@')) {
    for (const s of fs.readdirSync(full, { withFileTypes: true })) {
      consider(full, `${e.name}/${s.name}`, path.join(full, s.name))
    }
  } else {
    const st = fs.lstatSync(full)
    if (st.isDirectory() || st.isSymbolicLink()) consider(FARM, e.name, full)
  }
}

// ---------------------------------------------------------------- report

console.log(`[repoint-profile-node-modules] profile=${profile}  ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
console.log(`  farm    : ${FARM}`)
console.log(`  entry   : ${ENTRY}`)
console.log(`  scanned : ${scanned}   to repoint: ${changed.length}   skipped: ${skipped.length}`)
const byReason = {}
for (const s of skipped) byReason[s.reason.split('(')[0].trim()] = (byReason[s.reason.split('(')[0].trim()] || 0) + 1
for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`    skip: ${r} x${n}`)
for (const c of changed.slice(0, 8)) console.log(`    -> ${c.name}`)
if (changed.length > 8) console.log(`    ... and ${changed.length - 8} more`)

if (changed.length === 0) { console.log('\n  nothing to do (farm already follows the entry junction)'); process.exit(0) }
if (!APPLY) { console.log('\n  DRY-RUN: nothing written. Re-run with --apply (with the app CLOSED).'); process.exit(0) }

// ---------------------------------------------------------------- apply

const backupRoot = path.join(REPO, '_backups', `profile-node-modules-repoint-${stamp()}`)
fs.mkdirSync(backupRoot, { recursive: true })
fs.writeFileSync(path.join(backupRoot, 'catalog-before.json'), JSON.stringify({ farm: FARM, entry: ENTRY, changed }, null, 2) + '\n', 'utf8')
console.log(`\n  before-catalog: ${path.relative(REPO, path.join(backupRoot, 'catalog-before.json'))}`)

let ok = 0
const failed = []
for (const c of changed) {
  // Native junction primitives (no `cmd` spawn): symlinkSync(type:'junction') creates a
  // real junction, and rmdirSync removes the LINK -- it throws ENOTEMPTY on a real
  // non-empty directory, so a mis-detected entry can never be deleted by accident.
  try {
    fs.rmdirSync(c.full)
  } catch (cause) {
    failed.push({ ...c, why: `rmdir failed: ${cause.code ?? cause.message}` })
    continue
  }
  try {
    fs.symlinkSync(c.to, c.full, 'junction')
  } catch (cause) {
    failed.push({ ...c, why: `symlink failed: ${cause.code ?? cause.message}` })
    continue
  }
  if (!fs.existsSync(path.join(c.full, 'package.json'))) {
    failed.push({ ...c, why: 'recreated junction has no package.json' })
    continue
  }
  ok++
}

console.log(`\n  repointed: ${ok}/${changed.length}   failed: ${failed.length}`)
for (const f of failed.slice(0, 6)) console.log(`    ! ${f.name}: ${f.why}`)
console.log(`  rollback: restore each entry from catalog-before.json (rmdir + mklink /J <old target>)`)
process.exit(failed.length === 0 ? 0 : 1)
