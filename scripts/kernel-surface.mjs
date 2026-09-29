#!/usr/bin/env node
/**
 * kernel-surface.mjs - kernel API-surface snapshot + drift diff (read-only).
 *
 * WHY THIS EXISTS
 * ---------------
 * The 0.1.1 -> 0.1.7 upgrade broke the desktop in several *different* ways, and
 * each one had to be discovered by a failed launch:
 *   - named exports removed  (SettingsProvider / settingsNamespace / CallId)
 *   - whole packages added or removed
 *   - bundle entry sets changed (dsh-base 78 -> 93, dsh-web-app 57 -> 85)
 *   - client services dropped (settingsScope)
 * `scripts/update-watch.mjs` watches the VERSION NUMBER; `patch-shape-gate.mjs`
 * pins upstream SHAPES for the patches we ship. Neither answers the question the
 * operator actually has on release day: "what about the kernel's API surface
 * changed, and what of mine does it touch?"
 *
 * This tool answers it in one command, before any restart:
 *   snapshot the surface of a kernel  ->  diff two snapshots  ->  impact list.
 *
 * Usage:
 *   node scripts/kernel-surface.mjs --snapshot                 # newest build -> _backups/kernel-surface/<label>.json
 *   node scripts/kernel-surface.mjs --snapshot --kernel <dir> --label 0.1.1-rc.2
 *   node scripts/kernel-surface.mjs --diff <a.json> <b.json> [--json]
 *   node scripts/kernel-surface.mjs --list                     # snapshots on disk
 *
 * Exit: 0 = ok, 1 = diff found breaking changes (removed packages / removed
 *       exports / removed bundle entries / removed services), 2 = usage error.
 *
 * HONEST LIMITS: export surfaces are read lexically (see scripts/lib/export-surface.mjs);
 * CommonJS packages report status SKIP and are excluded from export diffs but still
 * counted. Services are recovered from `super(ctx,"x")` / `provide('x')` call sites,
 * so a service registered through an indirection is invisible here.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  kernelScopeOf, listKernelPackages, packageSurface, bundleEntryIds, providedServices,
} from './lib/export-surface.mjs'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ROOT = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')
const STORE = path.join(REPO, '_backups', 'kernel-surface')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }

function findKernelTrees() {
  const out = []
  if (!fs.existsSync(DIST_ROOT)) return out
  for (const dir of fs.readdirSync(DIST_ROOT)) {
    const base = dir === 'win-unpacked' ? path.join(DIST_ROOT, dir) : path.join(DIST_ROOT, dir, 'win-unpacked')
    const k = path.join(base, 'resources', 'app.asar.unpacked', 'node_modules')
    if (fs.existsSync(path.join(k, '@deepseek-ai'))) {
      out.push({ dir, kernel: k, mtime: fs.statSync(path.join(k, '@deepseek-ai')).mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** The kernel version a tree carries, read from @deepseek-ai/dsh/package.json. */
function kernelVersion(kernelNodeModules) {
  try {
    return JSON.parse(fs.readFileSync(path.join(kernelNodeModules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
  } catch { return 'unknown' }
}

function buildSnapshot(kernelNodeModules, label) {
  const scope = kernelScopeOf(kernelNodeModules)
  const pkgs = listKernelPackages(scope)
  const packages = {}
  let okCount = 0, skipCount = 0
  for (const name of pkgs) {
    const s = packageSurface(scope, name)
    if (s.status === 'OK') okCount++
    if (s.status === 'SKIP') skipCount++
    packages[`@deepseek-ai/${name}`] = {
      version: s.version ?? null,
      status: s.status,
      ...(s.reason ? { reason: s.reason } : {}),
      exports: [...s.names].sort(),
    }
  }
  const bundleEntries = {}
  const services = {}
  for (const b of ['dsh-base', 'dsh-web-app', 'dsh-community-market']) {
    const d = path.join(scope, b)
    if (!fs.existsSync(d)) continue
    bundleEntries[b] = bundleEntryIds(d)
  }
  for (const name of pkgs) {
    const svc = providedServices(path.join(scope, name))
    if (svc.size) services[`@deepseek-ai/${name}`] = [...svc].sort()
  }
  return {
    schemaVersion: 1,
    label,
    capturedAt: new Date().toISOString(),
    kernelRoot: kernelNodeModules,
    kernelVersion: kernelVersion(kernelNodeModules),
    counts: { packages: pkgs.length, surfacesOk: okCount, surfacesSkipped: skipCount },
    packages,
    bundleEntries,
    services,
  }
}

function loadSnapshot(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function diffSnapshots(a, b) {
  const out = {
    from: { label: a.label, kernelVersion: a.kernelVersion, capturedAt: a.capturedAt },
    to: { label: b.label, kernelVersion: b.kernelVersion, capturedAt: b.capturedAt },
    packagesAdded: [], packagesRemoved: [], versionChanges: [],
    exportsRemoved: [], exportsAdded: [],
    bundleEntriesAdded: {}, bundleEntriesRemoved: {},
    servicesRemoved: [], servicesAdded: [],
  }
  const pa = a.packages || {}, pb = b.packages || {}
  for (const k of Object.keys(pb)) if (!pa[k]) out.packagesAdded.push(k)
  for (const k of Object.keys(pa)) if (!pb[k]) out.packagesRemoved.push(k)
  for (const k of Object.keys(pb)) {
    if (!pa[k]) continue
    if (pa[k].version !== pb[k].version) out.versionChanges.push({ pkg: k, from: pa[k].version, to: pb[k].version })
    const ea = new Set(pa[k].exports || []), eb = new Set(pb[k].exports || [])
    const removed = [...ea].filter((n) => !eb.has(n))
    const added = [...eb].filter((n) => !ea.has(n))
    if (removed.length) out.exportsRemoved.push({ pkg: k, names: removed })
    if (added.length) out.exportsAdded.push({ pkg: k, names: added })
  }
  const ba = a.bundleEntries || {}, bb = b.bundleEntries || {}
  for (const k of new Set([...Object.keys(ba), ...Object.keys(bb)])) {
    const sa = new Set(ba[k] || []), sb = new Set(bb[k] || [])
    const added = [...sb].filter((x) => !sa.has(x))
    const removed = [...sa].filter((x) => !sb.has(x))
    if (added.length) out.bundleEntriesAdded[k] = added
    if (removed.length) out.bundleEntriesRemoved[k] = removed
  }
  const sa = a.services || {}, sb = b.services || {}
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    const x = new Set(sa[k] || []), y = new Set(sb[k] || [])
    for (const s of x) if (!y.has(s)) out.servicesRemoved.push({ pkg: k, service: s })
    for (const s of y) if (!x.has(s)) out.servicesAdded.push({ pkg: k, service: s })
  }
  out.breaking =
    out.packagesRemoved.length + out.exportsRemoved.length +
    Object.keys(out.bundleEntriesRemoved).length + out.servicesRemoved.length
  return out
}

// ------------------------------------------------------------------ commands

if (has('--help') || argv.length === 0) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
  process.exit(argv.length === 0 ? 2 : 0)
}

if (has('--list')) {
  if (!fs.existsSync(STORE)) { console.log('no snapshots in ' + path.relative(REPO, STORE)); process.exit(0) }
  for (const f of fs.readdirSync(STORE).filter((n) => n.endsWith('.json')).sort()) {
    const s = loadSnapshot(path.join(STORE, f))
    console.log(`${f}  kernel=${s.kernelVersion}  packages=${s.counts?.packages}  captured=${s.capturedAt}  label=${s.label}`)
  }
  process.exit(0)
}

if (has('--snapshot')) {
  const trees = findKernelTrees()
  const kernel = opt('--kernel', null) || trees[0]?.kernel
  if (!kernel || !fs.existsSync(kernel)) { console.error('kernel-surface: no kernel tree found (use --kernel <node_modules dir>)'); process.exit(2) }
  const label = opt('--label', null) || kernelVersion(kernel)
  const snap = buildSnapshot(kernel, label)
  fs.mkdirSync(STORE, { recursive: true })
  const outFile = opt('--out', path.join(STORE, `${label}.json`))
  const tmp = `${outFile}.tmp-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, outFile)
  console.log(`[kernel-surface] snapshot written: ${path.relative(REPO, outFile)}`)
  console.log(`  label=${label}  kernelVersion=${snap.kernelVersion}`)
  console.log(`  packages=${snap.counts.packages}  surfacesOk=${snap.counts.surfacesOk}  surfacesSkipped=${snap.counts.surfacesSkipped}`)
  for (const [b, ids] of Object.entries(snap.bundleEntries)) console.log(`  bundle ${b}: ${ids.length} entries`)
  console.log(`  packages providing services: ${Object.keys(snap.services).length}`)
  console.log(`  kernel tree: ${path.relative(REPO, kernel)}`)
  process.exit(0)
}

if (has('--diff')) {
  const i = argv.indexOf('--diff')
  const [aPath, bPath] = [argv[i + 1], argv[i + 2]]
  if (!aPath || !bPath) { console.error('kernel-surface --diff <a.json> <b.json>'); process.exit(2) }
  const d = diffSnapshots(loadSnapshot(aPath), loadSnapshot(bPath))
  if (has('--json')) { console.log(JSON.stringify(d, null, 2)); process.exit(d.breaking ? 1 : 0) }
  console.log(`[kernel-surface] ${d.from.label} (${d.from.kernelVersion})  ->  ${d.to.label} (${d.to.kernelVersion})`)
  console.log(`  packages: +${d.packagesAdded.length}  -${d.packagesRemoved.length}  version-changed ${d.versionChanges.length}`)
  console.log(`  exports : -${d.exportsRemoved.reduce((n, x) => n + x.names.length, 0)}  +${d.exportsAdded.reduce((n, x) => n + x.names.length, 0)}`)
  for (const [b, add] of Object.entries(d.bundleEntriesAdded)) console.log(`  bundle ${b}: +${add.length} entries (was ${(loadSnapshot(aPath).bundleEntries[b] || []).length} -> ${(loadSnapshot(bPath).bundleEntries[b] || []).length})`)
  for (const [b, rm] of Object.entries(d.bundleEntriesRemoved)) console.log(`  bundle ${b}: -${rm.length} entries  ${rm.join(', ')}`)
  console.log(`  services: -${d.servicesRemoved.length}  +${d.servicesAdded.length}`)

  if (d.packagesRemoved.length) {
    console.log('\n  [BREAKING] packages removed:')
    for (const p of d.packagesRemoved) console.log(`    - ${p}`)
  }
  if (d.exportsRemoved.length) {
    console.log('\n  [BREAKING] named exports removed:')
    for (const r of d.exportsRemoved.sort((a, b) => b.names.length - a.names.length)) {
      console.log(`    - ${r.pkg} :: ${r.names.join(', ')}`)
    }
  }
  if (d.servicesRemoved.length) {
    console.log('\n  [BREAKING] services no longer provided:')
    for (const s of d.servicesRemoved) console.log(`    - ${s.service}  (was in ${s.pkg})`)
  }
  if (d.packagesAdded.length) {
    console.log(`\n  [NEW] packages added (${d.packagesAdded.length}) — these are new native capabilities:`)
    const shown = d.packagesAdded.slice(0, 40)
    for (const p of shown) console.log(`    + ${p}`)
    if (d.packagesAdded.length > shown.length) console.log(`    ... and ${d.packagesAdded.length - shown.length} more`)
  }
  console.log(`\n  RESULT: ${d.breaking ? `FAIL (${d.breaking} breaking change group(s))` : 'PASS (no breaking surface change)'}`)
  process.exit(d.breaking ? 1 : 0)
}

console.error('kernel-surface: nothing to do (try --help)')
process.exit(2)
