// Shared export-surface extraction for the kernel compatibility gates.
//
// Used by:
//   scripts/verify-profile-exports.mjs  -- profile plugins vs a target kernel
//   scripts/kernel-surface.mjs          -- kernel API-surface snapshots + diffs
//
// Kept dependency-free and lexical on purpose: the kernel packages are tsdown
// builds that emit explicit `export { ... }` blocks, so a bounded scan recovers
// the surface without evaluating anything (no side effects, no code execution).

import fs from 'node:fs'
import path from 'node:path'

/** Resolve a relative specifier against a file, trying the usual extensions. */
export function resolveRel(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

/**
 * Collect exported names from a file, following `export * from` recursively.
 * `seen` guards against cycles; `acc` accumulates into a Set.
 */
export function collectExports(file, seen, acc) {
  if (seen.has(file) || !fs.existsSync(file)) return
  seen.add(file)
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return }

  // export { a, b as c }   (optionally re-exporting from another module)
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      // the FIRST token is the name that must exist in the source module
      acc.add(t.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    }
    if (m[2]) collectExports(resolveRel(file, m[2]), seen, acc)
  }
  // export * as ns from '...'
  for (const m of src.matchAll(/\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g)) acc.add(m[1])
  // export * from '...'
  for (const m of src.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) collectExports(resolveRel(file, m[1]), seen, acc)
  // export const|let|var|function|class NAME  (incl. async / generators)
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) acc.add(m[1])
  if (/\bexport\s+default\b/.test(src)) acc.add('default')
}

/** The concrete entry file of a package directory, honouring `exports`/`main`. */
export function entryFile(pkgDir) {
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

/** Resolve the `@deepseek-ai` scope directory inside a kernel tree. */
export function kernelScopeOf(kernelNodeModules) {
  return path.join(kernelNodeModules, '@deepseek-ai')
}

/** List `@deepseek-ai/*` package names present in a kernel tree, sorted. */
export function listKernelPackages(kernelScope) {
  if (!fs.existsSync(kernelScope)) return []
  return fs.readdirSync(kernelScope, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .sort()
}

/**
 * Export surface of one kernel package.
 * @returns {{status:'OK'|'ABSENT'|'SKIP', names:Set<string>, reason?:string, version?:string}}
 */
export function packageSurface(kernelScope, pkgName) {
  const rel = pkgName.startsWith('@deepseek-ai/') ? pkgName.slice('@deepseek-ai/'.length) : pkgName
  const dir = path.join(kernelScope, rel)
  if (!fs.existsSync(dir)) return { status: 'ABSENT', names: new Set() }
  let version
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version } catch { /* optional */ }
  const entry = entryFile(dir)
  if (!entry) return { status: 'SKIP', names: new Set(), reason: 'no resolvable entry file', version }
  const names = new Set()
  collectExports(entry, new Set(), names)
  if (names.size === 0) return { status: 'SKIP', names, reason: 'no ESM export statements found (CommonJS?)', version }
  return { status: 'OK', names, version }
}

/**
 * Extract named imports / re-exports from a source file.
 * Aliases are resolved to the ORIGINAL name (what the source module must export).
 * @returns {Array<{spec:string,names:string[],line:number,kind:string}>}
 */
export function scanNamedImports(file) {
  const out = []
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return out }
  const lineAt = (idx) => src.slice(0, idx).split('\n').length
  const push = (spec, rawNames, idx, kind) => {
    const names = rawNames.split(',').map((s) => s.trim()).filter(Boolean)
      .map((t) => t.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter((n) => n && n !== 'default' && n !== 'type')
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
    if (names.length) out.push({ spec, names, line: lineAt(idx), kind })
  }
  for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) push(m[2], m[1], m.index, 'import')
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) push(m[2], m[1], m.index, 're-export')
  return out
}

/** Strip the `@deepseek-ai/` prefix so a specifier maps onto a kernel scope dir. */
export function kernelPkgName(spec) {
  if (!spec.startsWith('@deepseek-ai/')) return null
  const parts = spec.split('/')
  return { pkgName: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') }
}

/** Bundle entry ids declared by a bundle package's cordis.patch.yml. */
export function bundleEntryIds(pkgDir) {
  const f = path.join(pkgDir, 'cordis.patch.yml')
  if (!fs.existsSync(f)) return []
  const src = fs.readFileSync(f, 'utf8')
  return [...src.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9_@/.-]+)\s*$/gm)].map((m) => m[1])
}

/** Service keys a kernel package provides (`super(ctx,"x")` / `provide('x'`). */
export function providedServices(pkgDir) {
  const out = new Set()
  const entry = entryFile(pkgDir)
  if (!entry) return out
  let src
  try { src = fs.readFileSync(entry, 'utf8') } catch { return out }
  for (const m of src.matchAll(/\bsuper\s*\(\s*ctx\s*,\s*['"]([A-Za-z0-9_$.]+)['"]/g)) out.add(m[1])
  for (const m of src.matchAll(/\bprovide\s*\(\s*['"]([A-Za-z0-9_$.]+)['"]/g)) out.add(m[1])
  return out
}
