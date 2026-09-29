#!/usr/bin/env node
/**
 * select-desktop-profile.mjs - queue a profile for the NEXT DSH Desktop startup.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Electron shell owns "%APPDATA%\DSH Desktop\profile-selection\state.json"
 * ({version, active, pending?, lastKnownGood}) and decides at each boot which
 * profile to mount:
 *
 *   profile-manager.ts:511-534  beginDesktopProfileStartup()
 *     - pending set & selectable      -> mount pending
 *     - active !== lastKnownGood      -> fall back to lastKnownGood
 *     - neither                       -> mount active
 *   profile-manager.ts:558-571  markDesktopProfileHealthy() promotes active -> lastKnownGood
 *   profile-manager.ts:579-592  markDesktopProfileFailed()  rolls active back to lastKnownGood
 *
 * After the 2026-09-29 00:47 desktop failure the file reads
 * `active = lastKnownGood = "recover-web"` -- so once the desktop profile is
 * repaired, a plain restart STILL boots recover-web. Queueing `pending: "desktop"`
 * is what makes the next restart try desktop again while keeping recover-web as the
 * automatic fallback if it fails.
 *
 * USAGE
 *   node scripts/select-desktop-profile.mjs                      # report only
 *   node scripts/select-desktop-profile.mjs --profile desktop --apply
 *   node scripts/select-desktop-profile.mjs --state <path> ...    # test override
 *
 * GUARD
 *   Refuses to write while DSH Desktop is running (the shell rewrites this file at
 *   boot/selection, so an out-of-band write would be racy and lost). --force overrides.
 *
 * EXIT  0 = ok   1 = refused/failed   2 = environment problem
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const FORCE = argv.includes('--force')
const valueOf = flag => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const TARGET = valueOf('--profile') ?? 'desktop'
const stateFlag = valueOf('--state')
const STATE_PATH = stateFlag !== undefined
  ? resolve(stateFlag)
  : join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming'),
      'DSH Desktop', 'profile-selection', 'state.json')

/** @returns {boolean|null} true/false when the shell answered, null when undeterminable. */
function appRunning() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count",
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const n = Number.parseInt(out.trim(), 10)
    return Number.isFinite(n) ? n > 0 : null
  } catch {
    return null
  }
}

if (!existsSync(STATE_PATH)) {
  console.error(`[select-desktop-profile] state file not found: ${STATE_PATH}`)
  console.error('  (it is created by the shell on its first successful startup)')
  process.exit(2)
}

let current
try {
  current = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
} catch (cause) {
  console.error(`[select-desktop-profile] state file is not valid JSON: ${cause.message}`)
  process.exit(2)
}

console.log(`[select-desktop-profile] ${STATE_PATH}`)
console.log(`  current : active=${current.active} pending=${current.pending ?? '(none)'} lastKnownGood=${current.lastKnownGood}`)

if (!APPLY) {
  console.log(`\n  report only. To queue ${JSON.stringify(TARGET)} for the next startup:`)
  console.log(`    node scripts/select-desktop-profile.mjs --profile ${TARGET} --apply`)
  process.exit(0)
}

if (current.version !== 1) {
  console.error(`  refuse: unexpected state version ${JSON.stringify(current.version)} (expected 1)`)
  process.exit(1)
}
if (typeof current.active !== 'string' || typeof current.lastKnownGood !== 'string') {
  console.error('  refuse: state is missing active/lastKnownGood strings (shape changed upstream?)')
  process.exit(1)
}
if (current.pending === TARGET && current.active === TARGET && current.lastKnownGood === TARGET) {
  console.log(`  nothing to do: ${TARGET} is already active AND last-known-good`)
  process.exit(0)
}

const running = appRunning()
if (running !== false && !FORCE) {
  console.error(running === true
    ? '  refuse: DSH Desktop is running. Close it first (the shell rewrites this file).'
    : '  refuse: could not determine whether DSH Desktop is running. Pass --force once the app is closed.')
  process.exit(1)
}

// Queue the target as `pending`, keep active/lastKnownGood untouched so a failed
// startup still rolls back to the currently working profile.
const next = {
  version: 1,
  active: current.active,
  pending: TARGET,
  lastKnownGood: current.lastKnownGood,
}

const backupRoot = join(REPO, '_backups', `profile-selection-${stamp()}`)
mkdirSync(backupRoot, { recursive: true })
writeFileSync(join(backupRoot, 'state-before.json'), `${JSON.stringify(current, null, 2)}\n`, 'utf8')

const tmp = `${STATE_PATH}.tmp-${process.pid}`
writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
renameSync(tmp, STATE_PATH)

const readBack = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const okShape = readBack.version === 1 && readBack.active === next.active
  && readBack.pending === TARGET && readBack.lastKnownGood === next.lastKnownGood
console.log(`  backup  : ${backupRoot}`)
console.log(`  written : active=${readBack.active} pending=${readBack.pending} lastKnownGood=${readBack.lastKnownGood}`)
if (!okShape) {
  console.error('  FAIL: read-back does not match the intended state')
  process.exit(1)
}
console.log(`\n  RESULT: PASS — the next DSH Desktop startup will try ${TARGET};`)
console.log(`          if it fails, the shell rolls back to ${next.lastKnownGood} automatically.`)
process.exit(0)

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}