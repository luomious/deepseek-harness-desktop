#!/usr/bin/env node
/**
 * upstream-sync.mjs - one-command upstream sync readiness check (read-only).
 *
 * WHAT THIS ANSWERS
 * -----------------
 * "官方发新版了，我能不能直接同步？会哪里不适配？"  — before any restart.
 *
 * It chains the four independent checks that each caught a *different* class of
 * failure during the 0.1.1 -> 0.1.7 upgrade, and prints one verdict + action list:
 *
 *   1. kernel-surface --diff      what changed in the kernel API surface
 *   2. verify-profile-exports     which of MY plugins lose a named export
 *   3. startup-verify             is the profile's assembly healthy (V1..V10)
 *   4. update-watch (optional)    is there a newer official release at all
 *
 * Usage:
 *   node scripts/upstream-sync.mjs                        # candidate = newest build
 *   node scripts/upstream-sync.mjs --baseline 0.1.1-rc.2  # snapshot label to diff against
 *   node scripts/upstream-sync.mjs --json
 *
 * Exit: 0 = READY (no blockers), 1 = BLOCKED (see action list), 2 = usage error.
 *
 * NOTHING IS WRITTEN except _backups/kernel-surface/<label>.json (a snapshot).
 * No config, no dist, no profile, no plugin registration, no restart.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const STORE = path.join(REPO, '_backups', 'kernel-surface')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ---- 1. snapshot the candidate kernel (newest build) -----------------------
const snap = run('kernel-surface.mjs', ['--snapshot'])
const candidateLabel = (/label=(\S+)/.exec(snap.out) || [])[1]
if (!candidateLabel) { console.error('upstream-sync: cannot snapshot candidate kernel\n' + snap.out); process.exit(2) }

// ---- 2. pick the baseline snapshot to diff against -------------------------
let baselineLabel = opt('--baseline', null)
if (!baselineLabel) {
  // default: the oldest snapshot on disk that is not the candidate
  const all = fs.existsSync(STORE)
    ? fs.readdirSync(STORE).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    : []
  baselineLabel = all.filter((l) => l !== candidateLabel)[0] ?? null
}
const report = { candidate: candidateLabel, baseline: baselineLabel, stages: {}, blockers: [], notes: [] }
if (!baselineLabel) {
  report.notes.push(`no baseline snapshot to diff against (took snapshot "${candidateLabel}" only)`)
} else {
  const d = run('kernel-surface.mjs', ['--diff', path.join(STORE, `${baselineLabel}.json`), path.join(STORE, `${candidateLabel}.json`)])
  report.stages.surfaceDiff = { code: d.code, summary: d.out.split('\n').filter(Boolean).slice(0, 12).join('\n'), full: d.out }
  if (d.code !== 0) {
    report.blockers.push({
      stage: 'kernel-surface --diff',
      detail: 'kernel API surface changed in a breaking way (removed packages / exports / services)',
      action: 'read the [BREAKING] list below; every removed named export is a plugin edit, every removed service is a service-name edit',
    })
  }
}

// ---- 3. did any Config-shape field change kind (plain -> Volatile)? --------
// The 2026-09-28 crash `config.pwshPath.get is not a function` came from exactly this:
// a Config field became Volatile<T> while a caller kept assigning a plain value.
const CS_STORE = path.join(REPO, '_backups', 'kernel-config-shapes')
run('verify-config-shapes.mjs', ['--snapshot'])
const csLabels = fs.existsSync(CS_STORE)
  ? fs.readdirSync(CS_STORE).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  : []
const csBaseline = csLabels.filter((l) => l !== candidateLabel)[0] ?? null
if (csBaseline) {
  const cs = run('verify-config-shapes.mjs', ['--diff', path.join(CS_STORE, `${csBaseline}.json`), path.join(CS_STORE, `${candidateLabel}.json`)])
  report.stages.configShapeDiff = { code: cs.code, summary: cs.out.split('\n').filter(Boolean).slice(0, 16).join('\n') }
  if (cs.code !== 0) {
    const flips = [...cs.out.matchAll(/^\s+- (@deepseek-ai\/\S+) :: (\S+)/gm)].map((m) => `${m[1].replace('@deepseek-ai/', '')}.${m[2]}`)
    report.blockers.push({
      stage: 'verify-config-shapes',
      detail: 'a Config field changed kind (plain -> Volatile) or vanished: callers that build their own config throw at construction',
      packages: flips.slice(0, 12),
      action: 'wrap the assigned value in a volatile reference (cosmokit.volatile.write protocol) or stop overriding that field',
    })
  }
} else {
  report.notes.push('verify-config-shapes: no baseline snapshot yet (took one for the candidate)')
}

// ---- 4. do MY plugins still link against the candidate? -------------------
const pe = run('verify-profile-exports.mjs')
report.stages.profileExports = { code: pe.code, summary: pe.out.split('\n').filter(Boolean).slice(0, 30).join('\n') }
if (pe.code !== 0) {
  const pkgs = [...pe.out.matchAll(/\[FAIL\] (\S+)/g)].map((m) => m[1])
  report.blockers.push({
    stage: 'verify-profile-exports',
    detail: `${pkgs.length} installed package(s) import a named export the candidate kernel does not provide`,
    packages: pkgs,
    action: 'bump each package to a release whose peerDependencies match the candidate kernel, or disable it — see the file:line list',
  })
}

// ---- 4. is the profile's assembly healthy right now? ----------------------
const sv = run('startup-verify.mjs')
report.stages.startupVerify = { code: sv.code, summary: sv.out.split('\n').filter(Boolean).slice(-24).join('\n') }
if (sv.code !== 0) {
  report.blockers.push({
    stage: 'startup-verify',
    detail: 'profile assembly problems (stale disabled ids / missing patch anchors / unresolvable bundles)',
    action: 'fix the FAIL lines; a stale `disabled:` id almost always means the profile patch was edited for a different kernel version',
  })
}

// ---- 5. is there a newer release at all? (best-effort, never blocks) ------
const uw = run('update-watch.mjs')
if (uw.code === 0) {
  const line = uw.out.split('\n').find((l) => /latest|UPDATE-ALERT/.test(l))
  if (line) report.notes.push(`update-watch: ${line.trim()}`)
} else {
  report.notes.push('update-watch: skipped (offline or registry unreachable)')
}

// ---- verdict ---------------------------------------------------------------
const ready = report.blockers.length === 0
if (has('--json')) {
  console.log(JSON.stringify({ ...report, ready }, null, 2))
} else {
  console.log(`[upstream-sync] candidate=${candidateLabel}  baseline=${baselineLabel ?? '(none)'}`)
  for (const [k, v] of Object.entries(report.stages)) {
    console.log(`\n--- ${k} : ${v.code === 0 ? 'PASS' : 'FAIL'}`)
    console.log(v.summary.split('\n').map((l) => '    ' + l).join('\n'))
  }
  if (report.notes.length) {
    console.log('\n--- notes')
    for (const n of report.notes) console.log(`    * ${n}`)
  }
  console.log(`\n=== VERDICT: ${ready ? 'READY — no适配 blocker found; safe to proceed with the upgrade runbook' : `BLOCKED — ${report.blockers.length} blocking stage(s)`}`)
  report.blockers.forEach((b, i) => {
    console.log(`\n  ${i + 1}. [${b.stage}] ${b.detail}`)
    if (b.packages) console.log(`     packages: ${b.packages.join(', ')}`)
    console.log(`     action  : ${b.action}`)
  })
}
process.exit(ready ? 0 : 1)
