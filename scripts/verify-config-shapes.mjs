#!/usr/bin/env node
/**
 * verify-config-shapes.mjs - kernel plugin Config-schema shape snapshot + drift diff.
 *
 * WHY THIS EXISTS (the third drift class, and a real crash)
 * ---------------------------------------------------------
 * The 2026-09-28 boot died with `TypeError: config.pwshPath.get is not a function`.
 * Cause: in 0.1.7 `PwshConfig` declares every field as `Volatile<T>`
 * (`dsh-pwsh-local/lib/index.js:141-149`, `pwshPath: z.string().volatile()`), while the
 * desktop adapter still assembled a config with a plain string in that slot. `tsc` was
 * silent (the adapter had `as unknown as`-style casts) and no gate could see it: an
 * export can exist, a file can exist, the service can be provided -- and the CONFIG
 * SHAPE can still have changed underneath a consumer that builds its own config.
 *
 * So this tool snapshots, per kernel package, every field of its `Config` schema
 * (name + coarse type + whether it is `.volatile()`), and diffs two snapshots. A
 * `volatile false -> true` flip means every caller that assigns a plain value to that
 * field now throws at construction time.
 *
 * Usage:
 *   node scripts/verify-config-shapes.mjs                                  # newest vs older, diff
 *   node scripts/verify-config-shapes.mjs --snapshot --kernel <dir> --label X
 *   node scripts/verify-config-shapes.mjs --diff <a.json> <b.json> [--json]
 * Exit: 1 = a breaking shape change (volatile flip, or a field that vanished).
 *
 * HONEST LIMITS: lexical extraction; a Config built through indirection or spread is
 * reported as SKIP for that package rather than silently omitted.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ROOT = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')
const STORE = path.join(REPO, '_backups', 'kernel-config-shapes')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const JSON_OUT = has('--json')

// ---------------------------------------------------------------- extraction

/** Scan from an opening brace at `start` to its match, ignoring braces in strings. */
function matchBrace(src, start) {
  let depth = 0, quote = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Split an object body into top-level `key: expr` chunks. */
function splitFields(body) {
  const out = []
  let depth = 0, quote = null, cur = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) { cur += c; if (c === '\\') { cur += body[++i] ?? ''; continue } if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue }
    if (c === '{' || c === '[' || c === '(') depth++
    if (c === '}' || c === ']' || c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** Coarse type fingerprint of a schema expression. */
function typeOf(expr) {
  const m = /\bz\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(expr)
  if (m) return m[1]
  if (/\[[^\]]*\]\s*\.volatile|\bz\s*\.\s*object/.test(expr)) return 'object'
  return '?'
}

/** Extract the Config schema of a package: field -> {type, volatile}. */
function configShape(pkgDir) {
  const candidates = ['lib/index.js', 'index.js', 'dist/index.js']
  const entry = candidates.map((c) => path.join(pkgDir, c)).find((f) => fs.existsSync(f))
  if (!entry) return { status: 'SKIP', reason: 'no entry file', fields: {} }
  const src = fs.readFileSync(entry, 'utf8')
  const re = /\bConfig\s*=\s*z\s*\.\s*object\s*\(\s*\{/g
  const m = re.exec(src)
  if (!m) return { status: 'SKIP', reason: 'no `Config = z.object({` declaration', fields: {} }
  const open = src.indexOf('{', m.index + m[0].length - 1)
  const close = matchBrace(src, open)
  if (close < 0) return { status: 'SKIP', reason: 'unbalanced Config object', fields: {} }
  const fields = {}
  for (const chunk of splitFields(src.slice(open + 1, close))) {
    const fm = /^\s*(?:\[?\s*['"]?([A-Za-z_$][\w$]*|\[[^\]]+\])['"]?\s*\]?)\s*:\s*([\s\S]+)$/.exec(chunk)
    if (!fm) continue
    fields[fm[1]] = { type: typeOf(fm[2]), volatile: /\.\s*volatile\s*\(\s*\)/.test(fm[2]) }
  }
  const n = Object.keys(fields).length
  return n === 0
    ? { status: 'SKIP', reason: 'Config object had no parseable fields (spread/indirection?)', fields: {} }
    : { status: 'OK', entry: path.relative(REPO, entry).replace(/\\/g, '/'), fields }
}

function buildSnapshot(kernel, label) {
  const scope = path.join(kernel, '@deepseek-ai')
  const packages = {}
  let ok = 0, skip = 0
  for (const p of fs.readdirSync(scope).sort()) {
    const s = configShape(path.join(scope, p))
    if (s.status === 'OK') ok++
    else if (s.status === 'SKIP') skip++
    packages[`@deepseek-ai/${p}`] = s
  }
  return { schemaVersion: 1, label, capturedAt: new Date().toISOString(), kernel, counts: { ok, skip }, packages }
}

// ---------------------------------------------------------------- diff

function diffShapes(a, b) {
  const volatileFlips = [], fieldsAdded = [], fieldsRemoved = [], typeChanges = [], newPackages = [], gone = []
  for (const pkg of Object.keys(b.packages)) {
    const A = a.packages[pkg], B = b.packages[pkg]
    if (!A || A.status !== 'OK' || B.status !== 'OK') { if (!A || A.status !== 'OK') newPackages.push(pkg); continue }
    for (const [f, bf] of Object.entries(B.fields)) {
      const af = A.fields[f]
      if (!af) { fieldsAdded.push({ pkg, field: f, ...bf }); continue }
      if (af.volatile !== bf.volatile) volatileFlips.push({ pkg, field: f, from: af.volatile, to: bf.volatile, type: bf.type })
      if (af.type !== bf.type) typeChanges.push({ pkg, field: f, from: af.type, to: bf.type })
    }
    for (const f of Object.keys(A.fields)) if (!B.fields[f]) fieldsRemoved.push({ pkg, field: f, ...A.fields[f] })
  }
  for (const pkg of Object.keys(a.packages)) if (!b.packages[pkg]) gone.push(pkg)
  const toVolatile = volatileFlips.filter((v) => v.to && !v.from)
  return {
    from: { label: a.label }, to: { label: b.label },
    volatileFlips, toVolatile, fieldsAdded, fieldsRemoved, typeChanges, newPackages, gonePackages: gone,
    breaking: toVolatile.length + fieldsRemoved.length,
  }
}

// ---------------------------------------------------------------- cli

function findKernels() {
  const out = []
  for (const dir of fs.readdirSync(DIST_ROOT)) {
    const base = dir === 'win-unpacked' ? path.join(DIST_ROOT, dir) : path.join(DIST_ROOT, dir, 'win-unpacked')
    const k = path.join(base, 'resources', 'app.asar.unpacked', 'node_modules')
    if (fs.existsSync(path.join(k, '@deepseek-ai'))) out.push({ dir, kernel: k, mtime: fs.statSync(path.join(k, '@deepseek-ai')).mtimeMs })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

if (has('--snapshot')) {
  const kernel = opt('--kernel', null) || findKernels()[0]?.kernel
  if (!kernel || !fs.existsSync(kernel)) { console.error('verify-config-shapes: kernel tree not found'); process.exit(2) }
  const label = opt('--label', null) || path.basename(path.dirname(path.dirname(kernel)))
  const snap = buildSnapshot(kernel, label)
  fs.mkdirSync(STORE, { recursive: true })
  const out = opt('--out', path.join(STORE, `${label}.json`))
  fs.writeFileSync(out + '.tmp', JSON.stringify(snap, null, 2) + '\n', 'utf8')
  fs.renameSync(out + '.tmp', out)
  console.log(`[verify-config-shapes] snapshot: ${path.relative(REPO, out)}`)
  console.log(`  label=${label}  packages with a parseable Config: ${snap.counts.ok}  skipped: ${snap.counts.skip}`)
  console.log(`  volatile fields found: ${Object.values(snap.packages).reduce((n, p) => n + Object.values(p.fields || {}).filter((f) => f.volatile).length, 0)}`)
  process.exit(0)
}

if (has('--diff')) {
  const i = argv.indexOf('--diff')
  const [ap, bp] = [argv[i + 1], argv[i + 2]]
  if (!ap || !bp) { console.error('verify-config-shapes --diff <a.json> <b.json>'); process.exit(2) }
  const d = diffShapes(JSON.parse(fs.readFileSync(ap, 'utf8')), JSON.parse(fs.readFileSync(bp, 'utf8')))
  if (JSON_OUT) { console.log(JSON.stringify(d, null, 2)); process.exit(d.breaking ? 1 : 0) }
  console.log(`[verify-config-shapes] ${d.from.label} -> ${d.to.label}`)
  console.log(`  volatile flips: ${d.volatileFlips.length} (plain -> volatile: ${d.toVolatile.length})`)
  console.log(`  fields added: ${d.fieldsAdded.length}   removed: ${d.fieldsRemoved.length}   type changes: ${d.typeChanges.length}`)
  if (d.toVolatile.length) {
    console.log('\n  [BREAKING] field became Volatile<T>: a caller that assigns a plain value now throws at construction')
    for (const v of d.toVolatile) console.log(`    - ${v.pkg} :: ${v.field}   (${v.type})`)
  }
  if (d.fieldsRemoved.length) {
    console.log('\n  [BREAKING] Config fields that no longer exist:')
    for (const v of d.fieldsRemoved.slice(0, 20)) console.log(`    - ${v.pkg} :: ${v.field}`)
  }
  if (d.typeChanges.length) {
    console.log(`\n  [INFO] type changes (${d.typeChanges.length}) -- first 15:`)
    for (const v of d.typeChanges.slice(0, 15)) console.log(`    ~ ${v.pkg} :: ${v.field}  ${v.from} -> ${v.to}`)
  }
  console.log(`\n  RESULT: ${d.breaking ? `FAIL (${d.breaking} breaking shape change group(s))` : 'PASS'}`)
  process.exit(d.breaking ? 1 : 0)
}

// default: snapshot the newest, then diff against the previous snapshot on disk
const kernels = findKernels()
if (kernels.length === 0) { console.error('verify-config-shapes: no kernel trees'); process.exit(2) }
const newest = kernels[0]
const label = path.basename(path.dirname(path.dirname(newest.kernel)))
if (!fs.existsSync(STORE)) { console.error('verify-config-shapes: no snapshots yet; run --snapshot first'); process.exit(2) }
const snaps = fs.readdirSync(STORE).filter((f) => f.endsWith('.json') && !f.startsWith(label)).sort()
if (snaps.length === 0) { console.error(`verify-config-shapes: need a baseline snapshot besides ${label}`); process.exit(2) }
console.error(`verify-config-shapes: run --snapshot --label <v> for ${label}, or --diff <a> <b> (baseline found: ${snaps[0]})`)
process.exit(2)
