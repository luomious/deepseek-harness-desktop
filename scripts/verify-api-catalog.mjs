#!/usr/bin/env node
/**
 * verify-api-catalog.mjs - kernel service/event CONTRACT snapshot + drift diff.
 *
 * WHY THIS EXISTS (the fifth drift class)
 * ---------------------------------------
 * Two of the 2026-09-28 boot failures were not about exports at all:
 *   - `tools/post-execute` / `agent/pre-step` DECISION shapes gained new kinds, and one
 *     plugin's context injection silently never took effect because the decision field it
 *     wrote (`input.additionalContexts`) is not the one the loop consumes (`decision.messages`);
 *   - a client service (`settingsScope`) lost its provider while consumers still injected it.
 * Both are "the contract changed underneath me" failures, invisible to every export/file gate.
 *
 * The kernel ships the contract in machine-readable form:
 * `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` -- generated upstream and
 * freshness-gated by their own `verify-cordis-api` -- exposing SERVICE_API (key + method
 * signatures), EVENT_API (name + mode + full listener signature), TYPE_API and
 * INHERITED_CTX_API. Snapshotting that and diffing two kernels answers "which contracts
 * changed", with the exact before/after signature.
 *
 * Usage:
 *   node scripts/verify-api-catalog.mjs --snapshot --kernel <node_modules> --label X
 *   node scripts/verify-api-catalog.mjs --diff <a.json> <b.json> [--json]
 *   node scripts/verify-api-catalog.mjs                      # snapshot newest + diff vs baseline
 * Exit: 1 = a service method or event listener signature changed/vanished.
 *
 * HONEST LIMITS: the catalog is upstream data -- if a package stops shipping it, this tool
 * reports SKIP for that kernel rather than pretending nothing changed.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ROOT = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')
const STORE = path.join(REPO, '_backups', 'kernel-api-catalog')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const JSON_OUT = has('--json')

const CATALOG_REL = '@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js'

async function loadCatalog(kernel) {
  const f = path.join(kernel, CATALOG_REL)
  if (!fs.existsSync(f)) return null
  const m = await import(pathToFileURL(f).href)
  return {
    services: m.SERVICE_API ?? [],
    events: m.EVENT_API ?? [],
    types: m.TYPE_API ?? [],
    inherited: m.INHERITED_CTX_API ?? [],
  }
}

async function buildSnapshot(kernel, label) {
  const cat = await loadCatalog(kernel)
  if (!cat) return { schemaVersion: 1, label, kernel, status: 'SKIP', reason: `no ${CATALOG_REL} in this kernel`, services: {}, events: {} }
  const services = {}
  for (const s of cat.services) {
    services[s.key] = (s.methods ?? []).map((mm) => mm.signature).filter(Boolean).sort()
  }
  const events = {}
  for (const e of cat.events) events[e.name] = { mode: e.mode ?? null, signature: e.signature ?? null }
  const types = (cat.types ?? []).map((t) => t.name ?? t.key ?? String(t)).sort()
  return {
    schemaVersion: 1, label, kernel, status: 'OK',
    counts: { services: cat.services.length, events: cat.events.length, types: types.length, inherited: (cat.inherited ?? []).length },
    services, events, types,
  }
}

function diff(a, b) {
  if (a.status !== 'OK' || b.status !== 'OK') return { skipped: true, reason: `${a.status}/${b.status}` }
  const serviceMethodsAdded = [], serviceMethodsRemoved = [], serviceMethodsChanged = [], servicesAdded = [], servicesRemoved = []
  for (const key of Object.keys(b.services)) {
    if (!a.services[key]) { servicesAdded.push(key); continue }
    const A = new Set(a.services[key]), B = new Set(b.services[key])
    for (const s of B) if (!A.has(s)) serviceMethodsAdded.push({ key, signature: s })
    for (const s of A) if (!B.has(s)) serviceMethodsRemoved.push({ key, signature: s })
  }
  for (const key of Object.keys(a.services)) if (!b.services[key]) servicesRemoved.push(key)

  const eventsAdded = [], eventsRemoved = [], eventsChanged = []
  for (const name of Object.keys(b.events)) {
    const A = a.events[name]
    if (!A) { eventsAdded.push(name); continue }
    if (A.signature !== b.events[name].signature) eventsChanged.push({ name, from: A.signature, to: b.events[name].signature })
    else if (A.mode !== b.events[name].mode) eventsChanged.push({ name, from: `${A.mode} (mode)`, to: `${b.events[name].mode} (mode)` })
  }
  for (const name of Object.keys(a.events)) if (!b.events[name]) eventsRemoved.push(name)

  const typesAdded = b.types.filter((t) => !a.types.includes(t))
  const typesRemoved = a.types.filter((t) => !b.types.includes(t))
  return {
    skipped: false,
    from: { label: a.label }, to: { label: b.label },
    servicesAdded, servicesRemoved, serviceMethodsAdded, serviceMethodsRemoved, serviceMethodsChanged,
    eventsAdded, eventsRemoved, eventsChanged, typesAdded, typesRemoved,
    breaking: servicesRemoved.length + serviceMethodsRemoved.length + eventsRemoved.length + eventsChanged.length,
  }
}

function findKernels() {
  const out = []
  if (!fs.existsSync(DIST_ROOT)) return out
  for (const dir of fs.readdirSync(DIST_ROOT)) {
    const base = dir === 'win-unpacked' ? path.join(DIST_ROOT, dir) : path.join(DIST_ROOT, dir, 'win-unpacked')
    const k = path.join(base, 'resources', 'app.asar.unpacked', 'node_modules')
    if (fs.existsSync(path.join(k, '@deepseek-ai'))) out.push({ dir, kernel: k, mtime: fs.statSync(path.join(k, '@deepseek-ai')).mtimeMs })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
const labelOf = (kernel) => path.basename(path.dirname(path.dirname(kernel)))

if (has('--snapshot')) {
  const kernel = opt('--kernel', null) || findKernels()[0]?.kernel
  if (!kernel) { console.error('verify-api-catalog: no kernel tree'); process.exit(2) }
  const label = opt('--label', null) || labelOf(kernel)
  const snap = await buildSnapshot(kernel, label)
  fs.mkdirSync(STORE, { recursive: true })
  const out = opt('--out', path.join(STORE, `${label}.json`))
  fs.writeFileSync(out + '.tmp', JSON.stringify(snap, null, 2) + '\n', 'utf8')
  fs.renameSync(out + '.tmp', out)
  if (snap.status === 'SKIP') { console.log(`[verify-api-catalog] snapshot ${label}: SKIP (${snap.reason})`) }
  else {
    console.log(`[verify-api-catalog] snapshot: ${path.relative(REPO, out)}`)
    console.log(`  label=${label}  services=${snap.counts.services}  events=${snap.counts.events}  types=${snap.counts.types}  inheritedCtx=${snap.counts.inherited}`)
  }
  process.exit(0)
}

if (has('--diff')) {
  const i = argv.indexOf('--diff')
  const [ap, bp] = [argv[i + 1], argv[i + 2]]
  if (!ap || !bp) { console.error('verify-api-catalog --diff <a.json> <b.json>'); process.exit(2) }
  const d = diff(JSON.parse(fs.readFileSync(ap, 'utf8')), JSON.parse(fs.readFileSync(bp, 'utf8')))
  if (d.skipped) { console.log(`[verify-api-catalog] SKIP (${d.reason}) -- no catalog on one side`); process.exit(0) }
  if (JSON_OUT) { console.log(JSON.stringify(d, null, 2)); process.exit(d.breaking ? 1 : 0) }
  console.log(`[verify-api-catalog] ${d.from.label} -> ${d.to.label}`)
  console.log(`  services +${d.servicesAdded.length}/-${d.servicesRemoved.length}   methods +${d.serviceMethodsAdded.length}/-${d.serviceMethodsRemoved.length}`)
  console.log(`  events   +${d.eventsAdded.length}/-${d.eventsRemoved.length}   signatures changed: ${d.eventsChanged.length}`)
  console.log(`  types    +${d.typesAdded.length}/-${d.typesRemoved.length}`)
  if (d.eventsChanged.length) {
    console.log('\n  [BREAKING] event listener signatures changed (payload/decision shapes live here):')
    for (const e of d.eventsChanged.slice(0, 10)) {
      console.log(`    - ${e.name}`)
      console.log(`        was: ${String(e.from).slice(0, 150)}`)
      console.log(`        now: ${String(e.to).slice(0, 150)}`)
    }
  }
  if (d.serviceMethodsRemoved.length) {
    console.log(`\n  [BREAKING] service methods removed (${d.serviceMethodsRemoved.length}, first 10):`)
    for (const m of d.serviceMethodsRemoved.slice(0, 10)) console.log(`    - ${m.key}.${m.signature}`)
  }
  if (d.servicesRemoved.length) console.log(`\n  [BREAKING] whole services removed: ${d.servicesRemoved.join(', ')}`)
  if (d.eventsRemoved.length) console.log(`\n  [BREAKING] events removed: ${d.eventsRemoved.join(', ')}`)
  console.log(`\n  RESULT: ${d.breaking ? `FAIL (${d.breaking} breaking contract change(s))` : 'PASS'}`)
  process.exit(d.breaking ? 1 : 0)
}

// ---- --check-hooks: do the events MY plugins listen to still exist? ----
// The catalog only appeared in 0.1.7, so the 0.1.1 -> 0.1.7 delta cannot be diffed
// (reported as SKIP above). But the catalog IS usable as a current-state oracle: every
// harness event name our profile plugins subscribe to must appear in EVENT_API. A rename
// or removal would otherwise leave a listener that silently never fires.
if (has('--check-hooks')) {
  const profile = opt('--profile', 'desktop')
  const nm = path.join(os.homedir(), '.dsh', 'profiles', profile, 'node_modules')
  const kernel = opt('--kernel', null) || findKernels()[0]?.kernel
  const cat = await loadCatalog(kernel)
  if (!cat) { console.error('verify-api-catalog: no catalog in the target kernel'); process.exit(2) }
  const known = new Set(cat.events.map((e) => e.name))
  const EVENTISH = /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/ // harness convention: 'agent/pre-step'
  const seen = new Map() // event -> [where]
  const walk = (dir, depth = 0) => {
    if (depth > 5 || !fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'test', 'tests', '.git', 'data'].includes(e.name)) continue
        walk(p, depth + 1)
      } else if (/\.(js|mjs|cjs)$/.test(e.name)) {
        let src
        try { src = fs.readFileSync(p, 'utf8') } catch { continue }
        for (const m of src.matchAll(/\b(?:ctx|scope|it|app)?\s*\.\s*on\s*\(\s*['"]([^'"]+)['"]/g)) {
          if (!EVENTISH.test(m[1])) continue
          if (!seen.has(m[1])) seen.set(m[1], [])
          seen.get(m[1]).push(path.relative(REPO, p).replace(/\\/g, '/'))
        }
      }
    }
  }
  for (const dep of fs.existsSync(nm) ? fs.readdirSync(nm) : []) {
    if (!dep.startsWith('@dsh-external/') && !dep.startsWith('dsh-')) continue
    walk(path.join(nm, dep))
  }
  for (const d of ['dsh-context-lifecycle', 'dsh-stuck-loop-guard', 'dsh-vision-rotator']) walk(path.join(REPO, d))
  const unknownAll = [...seen.entries()].filter(([name]) => !known.has(name)).sort()

  // Second oracle: the catalog covers HARNESS events only. A name absent from it may still
  // be a real event emitted elsewhere in the kernel (e.g. cordis-internal `internal/get`,
  // which lives in cordis/lib/index.js and is deliberately not catalogued). Only a name that
  // appears NOWHERE in the kernel is a genuine failure -- otherwise this would cry wolf.
  function kernelHasLiteral(literal) {
    const scope = path.join(kernel, '@deepseek-ai')
    const stack = [scope]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(p); continue }
        if (!/\.(js|mjs|cjs)$/.test(e.name)) continue
        try { if (fs.readFileSync(p, 'utf8').includes(literal)) return p } catch { /* unreadable */ }
      }
    }
    return null
  }
  const again = [], uncatalogued = []
  for (const entry of unknownAll) {
    const found = kernelHasLiteral(`'${entry[0]}'`) || kernelHasLiteral(`"${entry[0]}"`)
    if (found) uncatalogued.push({ name: entry[0], where: path.relative(REPO, found).replace(/\\/g, '/') })
    else again.push(entry)
  }

  console.log(`[verify-api-catalog] --check-hooks  profile=${profile}  kernel=${labelOf(kernel)}`)
  console.log(`  events my plugins subscribe to: ${seen.size}   in EVENT_API: ${seen.size - unknownAll.length}   uncatalogued but present in kernel: ${uncatalogued.length}   NOT FOUND anywhere: ${again.length}`)
  for (const u of uncatalogued) console.log(`    ~ ${u.name}   (catalogued? no; found in ${u.where} -- internal event, not a harness event)`)
  for (const [name, where] of again) console.log(`    ! ${name}   <- ${[...new Set(where)].slice(0, 3).join(', ')}`)
  console.log(`\n  RESULT: ${again.length === 0 ? 'PASS (every subscribed event exists in the kernel)' : `FAIL (${again.length} event name(s) found nowhere)`}`)
  process.exit(again.length === 0 ? 0 : 1)
}

// default: snapshot newest, then diff against a baseline snapshot if one exists
const kernels = findKernels()
if (kernels.length === 0) { console.error('verify-api-catalog: no kernel trees'); process.exit(2) }
const label = labelOf(kernels[0].kernel)
if (!fs.existsSync(STORE)) { console.error('verify-api-catalog: no snapshots yet; run --snapshot first'); process.exit(2) }
const others = fs.readdirSync(STORE).filter((f) => f.endsWith('.json') && f !== `${label}.json`).sort()
if (!others.length) { console.error(`verify-api-catalog: need a baseline besides ${label}; run --snapshot`); process.exit(2) }
console.error(`verify-api-catalog: run --snapshot --label <v> for ${label}, or --diff <a> <b> (baseline: ${others[0]})`)
process.exit(2)
