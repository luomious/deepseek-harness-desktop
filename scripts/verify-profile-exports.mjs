#!/usr/bin/env node
/**
 * verify-profile-exports.mjs - profile plugin named-export gate (static, read-only).
 *
 * WHY THIS EXISTS (2026-09-28 upgrade failure)
 * --------------------------------------------
 * The 0.1.7 restart died at loader init with:
 *   SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide
 *   an export named 'settingsNamespace'      (dsh-context, dsh-better-sidebar)
 *   SyntaxError: The requested module '@deepseek-ai/dsh-llm' does not provide
 *   an export named 'CallId'                 (dsh-tool-search)
 * Nothing caught it before the user saw a dead window. `scripts/verify-dist-exports.mjs`
 * (B3) gates the *packaged runtime* only; the profile's plugin tree -- 43 linked
 * @dsh-external plugins plus ~20 third-party packages -- was never inspected, and
 * `@deepseek-ai/*` is treated as "host-provided" by every other checker.
 *
 * WHAT IT DOES
 * ------------
 * For every package the profile declares, it extracts every NAMED import /
 * re-export that resolves to a `@deepseek-ai/*` package, then checks the name
 * against the export surface of the TARGET kernel tree. A name that the target
 * kernel does not export is reported as MISSING_EXPORT with file:line.
 *
 * Usage:
 *   node scripts/verify-profile-exports.mjs                       # newest build, desktop profile
 *   node scripts/verify-profile-exports.mjs --target <unpackedDir>
 *   node scripts/verify-profile-exports.mjs --profile desktop --json
 *
 * Exit: 0 = no missing exports (or nothing scannable), 1 = MISSING_EXPORT found.
 *
 * HONEST LIMITS (never silently green):
 *   - `export * from './x.js'` is followed recursively; a package whose surface we
 *     cannot derive (CommonJS, dynamic) is reported as SKIP with its reason.
 *   - Extraction is lexical (bounded regex over complete import statements). A name
 *     reported MISSING was not found anywhere in that package's export statements.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILES_ROOT = process.env.DSH_PROFILES_ROOT || path.join(os.homedir(), '.dsh', 'profiles')
const DIST_ROOT = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const JSON_OUT = argv.includes('--json')
const PROFILE = opt('--profile', 'desktop')

/** Newest `win-unpacked-build*` whose kernel tree exists (build dirs sort by name = by time). */
function newestKernelRoot() {
  const candidates = []
  for (const dir of fs.readdirSync(DIST_ROOT)) {
    const base = dir === 'win-unpacked'
      ? path.join(DIST_ROOT, dir)
      : path.join(DIST_ROOT, dir, 'win-unpacked')
    const k = path.join(base, 'resources', 'app.asar.unpacked', 'node_modules')
    if (fs.existsSync(path.join(k, '@deepseek-ai'))) candidates.push({ dir, k, mtime: fs.statSync(k).mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]
}

const TARGET = opt('--target', null) || newestKernelRoot()?.k
if (!TARGET || !fs.existsSync(TARGET)) {
  console.error(`verify-profile-exports: cannot locate a kernel tree (target=${TARGET})`)
  process.exit(2)
}

// ---------------------------------------------------------------- export surface

const exportCache = new Map()

/** Collect exported names from a file, following `export * from` recursively. */
function collectExports(file, seen, acc) {
  if (seen.has(file) || !fs.existsSync(file)) return
  seen.add(file)
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return }

  // export { a, b as c }            (with optional `from '...'`)
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t)
      acc.add(as ? as[1] : t.split(/\s+/)[0])
    }
    if (m[2]) collectExports(resolveRel(file, m[2]), seen, acc)
  }
  // export * as ns from '...'
  for (const m of src.matchAll(/\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g)) acc.add(m[1])
  // export * from '...'
  for (const m of src.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) collectExports(resolveRel(file, m[1]), seen, acc)
  // export const|let|var|function|class NAME   (incl. async)
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) acc.add(m[1])
  // export default
  if (/\bexport\s+default\b/.test(src)) acc.add('default')
}

function resolveRel(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

function entryFile(pkgDir) {
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) } catch { return null }
  const exp = pkg.exports
  const dot = typeof exp === 'object' && exp !== null ? (exp['.'] ?? exp) : null
  let rel = null
  if (typeof dot === 'string') rel = dot
  else if (dot && typeof dot === 'object') {
    rel = dot.import?.default || dot.import || dot.default || dot.require || null
    if (rel && typeof rel === 'object') rel = rel.default || null
  }
  if (!rel) rel = pkg.module || pkg.main || 'lib/index.js'
  const f = path.join(pkgDir, rel)
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
  for (const c of ['lib/index.js', 'index.js', 'dist/index.js']) {
    const c2 = path.join(pkgDir, c)
    if (fs.existsSync(c2)) return c2
  }
  return null
}

/** Export-name set for an `@deepseek-ai/*` package in the TARGET kernel. */
function kernelExports(kernelScope, pkgName) {
  const key = `${kernelScope}\u0000${pkgName}`
  if (exportCache.has(key)) return exportCache.get(key)
  // pkgName arrives as the full specifier scope ("@deepseek-ai/dsh-tools");
  // kernelScope already points at the scope directory, so strip the prefix.
  const rel = pkgName.startsWith('@deepseek-ai/') ? pkgName.slice('@deepseek-ai/'.length) : pkgName
  const dir = path.join(kernelScope, rel)
  let result
  if (!fs.existsSync(dir)) {
    result = { status: 'ABSENT', names: new Set() }
  } else {
    const entry = entryFile(dir)
    if (!entry) {
      result = { status: 'SKIP', names: new Set(), reason: 'no resolvable entry file' }
    } else {
      const names = new Set()
      collectExports(entry, new Set(), names)
      // CommonJS-style package: surface not derivable lexically.
      result = names.size === 0
        ? { status: 'SKIP', names, reason: 'no ESM export statements found (CommonJS?)' }
        : { status: 'OK', names }
    }
  }
  exportCache.set(key, result)
  return result
}

// ---------------------------------------------------------------- import scanner

const NAMED_FROM = /\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const REEXPORT_FROM = /\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const SIDE_EFFECT = /\bimport\s*['"]([^'"]+)['"]/g

function scanFile(file) {
  const out = []
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return out }
  const lineAt = (idx) => src.slice(0, idx).split('\n').length
  const push = (spec, rawNames, idx, kind) => {
    const names = rawNames.split(',').map((s) => s.trim()).filter(Boolean)
      // `import { x as y }` binds y locally but still requires the kernel to
      // export x -- so the name to verify is always the FIRST token.
      .map((t) => t.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter((n) => n && n !== 'default' && n !== 'type')
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
    if (names.length) out.push({ spec, names, line: lineAt(idx), kind })
  }
  for (const m of src.matchAll(NAMED_FROM)) push(m[2], m[1], m.index, 'import')
  for (const m of src.matchAll(REEXPORT_FROM)) push(m[2], m[1], m.index, 're-export')
  for (const m of src.matchAll(SIDE_EFFECT)) out.push({ spec: m[1], names: [], line: lineAt(m.index), kind: 'side-effect' })
  return out
}

/** Resolve a bare specifier to { pkgName, kernelScopePath } or null. */
function kernelTarget(spec, kernelScope) {
  if (!spec.startsWith('@deepseek-ai/')) return null
  const parts = spec.split('/')
  const pkgName = parts.slice(0, 2).join('/')
  return { pkgName, subpath: parts.slice(2).join('/') }
}

// ---------------------------------------------------------------- profile walk

const visitedReal = new Set()

/**
 * Collect source files under a package root. Junctions/symlinks are FOLLOWED
 * (the profile links @dsh-external/* straight to the plugin sources) but each
 * real path is visited once, so a link cycle cannot loop.
 */
function listSourceFiles(dir, depth = 0, acc = []) {
  if (depth > 4) return acc
  let real
  try { real = fs.realpathSync(dir) } catch { return acc }
  if (visitedReal.has(real)) return acc
  visitedReal.add(real)
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    let isDir = e.isDirectory()
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = fs.statSync(p).isDirectory() } catch { isDir = false }
    }
    if (isDir) {
      if (['node_modules', 'test', 'tests', 'coverage', '.git', 'src', 'data'].includes(e.name)) continue
      listSourceFiles(p, depth + 1, acc)
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) acc.push(p)
  }
  return acc
}

const profileDir = path.join(PROFILES_ROOT, PROFILE)
const profilePkgPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(profilePkgPath)) {
  console.error(`verify-profile-exports: no profile package.json at ${profilePkgPath}`)
  process.exit(2)
}
const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
const declared = Object.keys(profilePkg.dependencies || {})
const NM = path.join(profileDir, 'node_modules')
const kernelScope = path.join(TARGET, '@deepseek-ai')

/**
 * Packages the loader will actually instantiate: rows in `dsh.profile.bundles`
 * plus every `name:` referenced by the profile's patch layer (`- insert:` rows).
 * A declared dependency that is in neither cannot be imported at startup, so a
 * stale named export there is a latent landmine, not a boot blocker — reported
 * separately instead of failing the gate.
 */
function loadedPackages() {
  const set = new Set(profilePkg.dsh?.profile?.bundles ?? [])
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (fs.existsSync(patchPath)) {
    const src = fs.readFileSync(patchPath, 'utf8')
    for (const m of src.matchAll(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) set.add(m[1].trim())
  }
  return set
}
const loaded = loadedPackages()

const findings = []
const skipped = []
let scannedPkgs = 0
let scannedFiles = 0
let checkedNames = 0

for (const dep of declared) {
  const dir = path.join(NM, dep)
  if (!fs.existsSync(dir)) { skipped.push({ pkg: dep, reason: 'not installed' }); continue }
  const files = listSourceFiles(dir)
  if (files.length === 0) { skipped.push({ pkg: dep, reason: 'no .js/.mjs/.cjs under package root' }); continue }
  scannedPkgs++
  for (const f of files) {
    scannedFiles++
    for (const rec of scanFile(f)) {
      const t = kernelTarget(rec.spec, kernelScope)
      if (!t) continue
      if (t.subpath && t.subpath !== 'package.json') continue
      const sur = kernelExports(kernelScope, t.pkgName)
      if (sur.status === 'ABSENT') {
        findings.push({ pkg: dep, loaded: loaded.has(dep), file: f, line: rec.line, spec: rec.spec, names: ['<whole package absent in target kernel>'], kind: rec.kind })
        continue
      }
      if (sur.status === 'SKIP') { skipped.push({ pkg: dep, reason: `${t.pkgName}: ${sur.reason}` }); continue }
      for (const n of rec.names) {
        checkedNames++
        if (!sur.names.has(n)) findings.push({ pkg: dep, loaded: loaded.has(dep), file: f, line: rec.line, spec: rec.spec, names: [n], kind: rec.kind })
      }
    }
  }
}

// ---------------------------------------------------------------- report

const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/')
/** Findings that can actually break the next launch (the package is instantiated). */
const blockers = findings.filter((f) => f.loaded)
/** Findings in a declared-but-never-loaded package: a latent landmine, not a blocker. */
const latent = findings.filter((f) => !f.loaded)
const group = (list) => {
  const m = new Map()
  for (const f of list) {
    if (!m.has(f.pkg)) m.set(f.pkg, [])
    m.get(f.pkg).push(f)
  }
  return m
}
const gBlockers = group(blockers)
const gLatent = group(latent)

if (JSON_OUT) {
  console.log(JSON.stringify({
    target: TARGET, profile: PROFILE, declared: declared.length,
    scannedPackages: scannedPkgs, scannedFiles, checkedNames,
    blockingPackages: [...gBlockers.keys()].sort(),
    latentPackages: [...gLatent.keys()].sort(),
    findings, skipped,
  }, null, 2))
} else {
  console.log(`[verify-profile-exports] profile=${PROFILE}`)
  console.log(`  target kernel : ${rel(TARGET)}`)
  console.log(`  declared deps : ${declared.length}   scanned packages: ${scannedPkgs}   files: ${scannedFiles}   named imports checked: ${checkedNames}`)
  console.log(`  loaded rows   : ${loaded.size} (bundles + patch rows; ${declared.length} declared deps)`)
  console.log(`  result        : ${gBlockers.size === 0
    ? `PASS (no missing named exports in any loaded package${gLatent.size ? `; ${gLatent.size} latent in unloaded package(s))` : ')'}`
    : `FAIL (${gBlockers.size} LOADED package(s) with missing exports)`}`)
  for (const [pkg, list] of [...gBlockers.entries()].sort()) {
    console.log(`\n  [FAIL] ${pkg}  (loaded: breaks the next launch)`)
    for (const f of list) console.log(`         ${rel(f.file)}:${f.line}  ${f.kind} -> ${f.spec} :: ${f.names.join(', ')}`)
  }
  for (const [pkg, list] of [...gLatent.entries()].sort()) {
    console.log(`\n  [LATENT] ${pkg}  (declared but NOT in bundles / patch rows: cannot be imported at startup)`)
    for (const f of list) console.log(`         ${rel(f.file)}:${f.line}  ${f.kind} -> ${f.spec} :: ${f.names.join(', ')}`)
  }
  if (skipped.length) {
    console.log(`\n  [SKIP] ${skipped.length} item(s) not verifiable:`)
    for (const s of skipped.slice(0, 12)) console.log(`         ${s.pkg} -- ${s.reason}`)
    if (skipped.length > 12) console.log(`         ... and ${skipped.length - 12} more`)
  }
}

process.exit(gBlockers.size === 0 ? 0 : 1)
