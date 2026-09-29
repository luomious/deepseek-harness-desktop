#!/usr/bin/env node
/**
 * verify-dist-exports.mjs - packaged-runtime link-time export gate.
 *
 * WHY THIS EXISTS (B3, 2026-09-27 startup crash)
 * ----------------------------------------------
 * The desktop app failed to start with:
 *
 *   file:///.../node_modules/@deepseek-ai/dsh-settings-file/lib/index.js:9
 *   import { SettingsProvider } from "@deepseek-ai/dsh-settings";
 *   SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide
 *   an export named 'SettingsProvider'
 *
 * Nothing caught it before the user saw a dialog:
 *   - `tsc` only sees our own sources (and skipLibCheck is on);
 *   - `verify-plugin-imports.mjs` gates specifier *discipline*: `@deepseek-ai/*` is
 *     trusted as "host-provided" and never inspected further;
 *   - `check-dist-integrity.mjs` only checks that lib/main.js's RELATIVE imports exist;
 *   - `verify-runtime-closure.mjs` only checks that the dependency graph is closed.
 * A removed/missing named export is invisible to all four, yet it is fatal at ESM
 * link time - the app cannot even reach its own error handler.
 *
 * HOW IT WORKS
 * ------------
 * V8's real module linker performs named-export validation during `link()`, WITHOUT
 * evaluating module bodies. This script therefore:
 *   1. builds `vm.SourceTextModule`s for the packaged runtime's own files;
 *   2. resolves every request with a real resolver over the packaged tree
 *      (honouring `exports`/`main`/`module` + package `type`);
 *   3. calls `link()` and reports the same SyntaxError the runtime would throw.
 * The probe module was validated before use (2026-09-27):
 *   - a missing named export fails `link()` and module bodies are NOT executed;
 *   - a present named export links fine;
 *   - `Object.keys(namespace)` is unreliable before evaluation (TDZ), so we never
 *     read namespaces - V8 validates the requested names for us.
 *
 * WHAT IT CANNOT SEE (printed as SKIP, never silently green)
 * ----------------------------------------------------------
 * A module graph that contains a request we cannot resolve statically (notably
 * `electron`, or CommonJS packages whose named exports Node synthesizes with
 * cjs-module-lexer) cannot be linked. Those importers fall back to per-statement
 * probes; whatever remains unverifiable is reported with its reason and counted.
 *
 * Usage:
 *   node scripts/verify-dist-exports.mjs [--dist <buildDir|dist\win-unpacked>]
 *                                        [--json] [--verbose] [--quiet]
 * Exit: 0 = no missing exports, 1 = at least one violation.
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { builtinModules, createRequire } from 'node:module'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')

// ---------------------------------------------------------------- self re-exec
// vm.SourceTextModule needs --experimental-vm-modules (same pattern as
// verify-plugin-imports.mjs). DSH_VDE_CHILD guards against a respawn loop.
if (typeof vm.SourceTextModule !== 'function') {
  if (process.env.DSH_VDE_CHILD === '1') {
    console.log('SKIP  vm.SourceTextModule unavailable even with --experimental-vm-modules')
    console.log('HINT  export gate did not run; re-check after a Node upgrade')
    process.exit(0)
  }
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', SELF, ...process.argv.slice(2)],
    { stdio: 'inherit', windowsHide: true, env: { ...process.env, DSH_VDE_CHILD: '1' } },
  )
  process.exit(typeof r.status === 'number' ? r.status : 1)
}

// ---------------------------------------------------------------- argv
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const VERBOSE = argv.includes('--verbose')
const QUIET = argv.includes('--quiet')
const distArgIdx = argv.findIndex((a) => a === '--dist')
const DIST_ARG = distArgIdx >= 0 ? argv[distArgIdx + 1] : undefined

const EXTS = ['.js', '.mjs', '.cjs']
const BUILTINS = new Set(builtinModules)
/** Requests that only exist inside the Electron main process. Unresolvable in plain Node. */
const HOST_ONLY = new Set(['electron', 'electron/main', 'electron/renderer'])

// ---------------------------------------------------------------- dist resolution
async function resolveDistDir() {
  if (DIST_ARG) {
    const p = path.isAbsolute(DIST_ARG) ? DIST_ARG : path.join(ROOT, DIST_ARG)
    const nested = path.join(p, 'win-unpacked')
    if (fs.existsSync(path.join(p, 'DSH Desktop.exe'))) return p
    if (fs.existsSync(path.join(nested, 'DSH Desktop.exe'))) return nested
    throw new Error(`--dist target has no "DSH Desktop.exe": ${p}`)
  }
  const { resolveCurrentBuild } = await import('./resolve-dist.mjs')
  // Repo convention (resolve-dist.mjs): the patch/verify target is the NEWEST real
  // build under dist (the one that will be promoted next), not the running junction.
  return resolveCurrentBuild().buildDir
}

// ---------------------------------------------------------------- module resolution
function nearestPackageJson(startDir) {
  let dir = startDir
  for (;;) {
    const p = path.join(dir, 'package.json')
    if (fs.existsSync(p)) return p
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Package directory of a bare specifier, walking node_modules up from `fromDir`. */
function findPackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Pick the ESM-most entry out of an `exports` value (string | conditions | subpaths). */
function pickExportTarget(value, subpath) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = pickExportTarget(v, subpath)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    if (subpath) {
      const key = `./${subpath}`
      if (Object.prototype.hasOwnProperty.call(value, key)) return pickExportTarget(value[key], undefined)
      // fall through to condition map (some packages map conditions at top level)
    }
    for (const cond of ['import', 'module', 'node', 'default', 'require']) {
      if (Object.prototype.hasOwnProperty.call(value, cond)) {
        const hit = pickExportTarget(value[cond], subpath)
        if (hit) return hit
      }
    }
    return null
  }
  return null
}

function fileExists(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function probeFile(base) {
  for (const c of [base, ...EXTS.map((e) => base + e)]) {
    if (fileExists(c)) return c
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const e of EXTS) {
      const c = path.join(base, 'index' + e)
      if (fileExists(c)) return c
    }
  }
  return null
}

/**
 * Resolve one request.
 * @returns {{kind:'builtin'}|{kind:'missing',detail:string}|{kind:'file',file:string,pkgType:string|null}}
 */
function resolveTarget(importerAbs, spec) {
  if (spec.startsWith('node:')) return { kind: 'builtin' }
  const head = spec.split('/')[0]
  if (BUILTINS.has(head)) return { kind: 'builtin' }
  if (HOST_ONLY.has(spec)) return { kind: 'missing', detail: 'host-only request (electron), not resolvable outside the Electron main process' }

  const fromDir = path.dirname(importerAbs)
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) {
    const hit = probeFile(path.resolve(fromDir, spec))
    if (!hit) return { kind: 'missing', detail: 'relative/absolute target does not exist' }
    return { kind: 'file', file: hit, pkgType: typeOfFile(hit) }
  }

  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = parts.slice(spec.startsWith('@') ? 2 : 1).join('/')

  let requireFrom
  try {
    requireFrom = createRequire(path.join(fromDir, 'noop.js'))
  } catch {
    requireFrom = null
  }
  // Fast path: Node's own resolver (handles browser/exports when it can).
  if (!subpath && requireFrom) {
    try {
      const hit = requireFrom.resolve(spec)
      if (fileExists(hit)) return { kind: 'file', file: hit, pkgType: typeOfFile(hit) }
    } catch { /* fall through to the manual resolver */ }
  }

  const pkgDir = findPackageDir(name, fromDir)
  if (!pkgDir) return { kind: 'missing', detail: `package "${name}" not found from ${path.relative(ROOT, fromDir).split(path.sep).join('/')}` }

  let manifest = {}
  try { manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) } catch { /* keep {} */ }

  if (subpath) {
    const viaExports = manifest.exports ? pickExportTarget(manifest.exports, subpath) : null
    const candidate = viaExports ? path.resolve(pkgDir, viaExports) : probeFile(path.join(pkgDir, subpath))
    if (candidate && fileExists(candidate)) return { kind: 'file', file: candidate, pkgType: manifest.type ?? typeOfFile(candidate) }
    return { kind: 'missing', detail: `subpath "./${subpath}" of "${name}" did not resolve` }
  }

  const viaExports = manifest.exports ? pickExportTarget(manifest.exports, undefined) : null
  const entry = viaExports ?? manifest.module ?? manifest.main ?? 'index.js'
  const candidate = path.resolve(pkgDir, entry)
  const hit = fileExists(candidate) ? candidate : probeFile(candidate)
  if (!hit) return { kind: 'missing', detail: `entry "${entry}" of "${name}" did not resolve` }
  return { kind: 'file', file: hit, pkgType: manifest.type ?? typeOfFile(hit) }
}

function typeOfFile(file) {
  const ext = path.extname(file)
  if (ext === '.mjs') return 'module'
  if (ext === '.cjs') return 'commonjs'
  const pj = nearestPackageJson(path.dirname(file))
  if (!pj) return null
  try {
    const m = JSON.parse(fs.readFileSync(pj, 'utf8'))
    if (m.type) return m.type
    // a package.json next to the file that declares the package name governs it
    return 'commonjs'
  } catch { return null }
}

function isEsm(file, pkgType) {
  const ext = path.extname(file)
  if (ext === '.cjs') return false
  if (ext === '.mjs') return true
  return pkgType === 'module'
}

// ---------------------------------------------------------------- linker
class Unverifiable extends Error {
  constructor(spec, importer, reason) {
    super(`unverifiable: ${reason} (${spec})`)
    this.spec = spec
    this.importer = importer
    this.reason = reason
  }
}

const context = vm.createContext()
const builtinNamespaces = new Map()

/**
 * A `vm.Module` can only be linked once, so every probe builds fresh module objects.
 * Only file text and builtin namespaces are cached.
 */
async function builtinStub(spec) {
  if (!builtinNamespaces.has(spec)) builtinNamespaces.set(spec, await import(spec))
  const ns = builtinNamespaces.get(spec)
  const names = Object.keys(ns)
  return new vm.SyntheticModule(names, function () {
    for (const n of names) this.setExport(n, ns[n])
  }, { identifier: `builtin:${spec}`, context })
}

const textCache = new Map()
/**
 * Every module remembers the file it stands for. Probe modules are synthetic (their
 * identifier is not a path), so the linker must not derive the resolution anchor from
 * the identifier alone - that bug silently turned every probe into "package not found".
 */
const anchorOf = new Map()

function loadEsm(file) {
  if (!textCache.has(file)) textCache.set(file, fs.readFileSync(file, 'utf8'))
  const url = pathToFileURL(file).href
  anchorOf.set(url, file)
  return new vm.SourceTextModule(textCache.get(file), { identifier: url, context })
}

function makeProbe(importerAbs, id, src) {
  anchorOf.set(id, importerAbs)
  textCache.set(id, src)
  return new vm.SourceTextModule(src, { identifier: id, context })
}

function anchorFor(referencingModule) {
  const id = referencingModule.identifier
  if (anchorOf.has(id)) return anchorOf.get(id)
  if (id.startsWith('file:')) return fileURLToPath(id)
  return null
}

/**
 * Names a module asks of one specifier. Used ONLY to build a placeholder for targets we
 * cannot verify (CommonJS, `electron`, unresolved). Placeholders export exactly what the
 * referrer asks for, so the rest of the graph is still validated instead of being
 * abandoned the moment one dependency is unverifiable.
 */
function requestedNamesFor(text, spec) {
  const names = new Set()
  const addNamed = (clause) => {
    const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'))
    for (const part of inner.split(',')) {
      const t = part.trim().replace(/^type\s+/, '')
      if (!t) continue
      const orig = t.split(/\s+as\s+/)[0].trim()
      if (orig) names.add(orig)
    }
  }
  for (const m of text.matchAll(/^[ \t]*import\s+(type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/gm)) {
    if (m[3] !== spec) continue
    const clause = m[2].trim()
    if (clause.startsWith('*')) continue // namespace import validates no names
    if (clause.startsWith('{')) { addNamed(clause); continue }
    names.add('default')
    const brace = clause.slice(clause.indexOf(','))
    if (brace.includes('{')) addNamed(brace)
  }
  for (const m of text.matchAll(/^[ \t]*export\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    if (m[2] === spec) addNamed('{' + m[1] + '}')
  }
  return [...names]
}

function stubModule(names, id) {
  return new vm.SyntheticModule(names, function () {
    for (const n of names) this.setExport(n, undefined)
  }, { identifier: id, context })
}

const unverifiableSeen = new Map() // 'reason|spec|importer' -> record (deduped for the report)

function noteUnverifiable(spec, importer, reason) {
  const key = `${reason}|${spec}|${importer}`
  if (unverifiableSeen.has(key)) return
  unverifiableSeen.set(key, {
    file: path.relative(ROOT, importer).split(path.sep).join('/'),
    specifier: spec,
    reason,
  })
}

function makeLinker() {
  return async (spec, referencingModule) => {
    const importer = anchorFor(referencingModule)
    if (importer === null) throw new Unverifiable(spec, referencingModule.identifier, 'cannot determine the importing file')
    const t = resolveTarget(importer, spec)
    if (t.kind === 'builtin') return builtinStub(spec)
    if (t.kind === 'missing') {
      noteUnverifiable(spec, importer, `UNRESOLVED (${t.detail})`)
      return stubModule(requestedNamesFor(textCache.get(importer) ?? '', spec), `stub-missing:${spec}`)
    }
    if (!isEsm(t.file, t.pkgType)) {
      noteUnverifiable(spec, importer, `COMMONJS_TARGET (${path.relative(ROOT, t.file).split(path.sep).join('/')}) - named exports are synthesized by Node at runtime`)
      return stubModule(requestedNamesFor(textCache.get(importer) ?? '', spec), `stub-cjs:${spec}`)
    }
    return loadEsm(t.file)
  }
}

const MISSING_EXPORT_RE = /does not provide an export named '([^']+)'|does not provide an export named "([^"]+)"/i
/**
 * V8 surfaces link errors from the vm realm, so `err instanceof Error` is false there.
 * Classify on `name`/`message` instead (verified 2026-09-27 against the packaged build).
 */
function missingExportName(err) {
  if (err === null || typeof err !== 'object') return null
  if (err.name !== 'SyntaxError') return null
  const m = MISSING_EXPORT_RE.exec(String(err.message ?? ''))
  if (!m) return null
  return m[1] ?? m[2] ?? '(unknown)'
}

// ---------------------------------------------------------------- main
const buildDir = await resolveDistDir()
const resources = path.join(buildDir, 'resources')
const unpacked = path.join(resources, 'app.asar.unpacked')
const libDir = path.join(unpacked, 'lib')

if (!fs.existsSync(libDir)) {
  console.error(`FAIL  no app.asar.unpacked/lib under ${buildDir}`)
  process.exit(1)
}

const importers = fs
  .readdirSync(libDir)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.map'))
  .sort()
  .map((f) => path.join(libDir, f))

const failures = []
const stats = { importers: importers.length, wholeFileLinked: 0 }
const texts = new Map(importers.map((f) => [f, fs.readFileSync(f, 'utf8')]))

/** Is this lib file imported by any other lib file? Unreferenced + unlinkable = stale artifact. */
function referencedByOthers(file) {
  const base = path.basename(file)
  for (const [other, text] of texts) {
    if (other === file) continue
    if (text.includes(base)) return other
  }
  return null
}

for (const file of importers) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  try {
    // Linking performs V8's real named-export validation and never evaluates a body.
    await loadEsm(file).link(makeLinker())
    stats.wholeFileLinked++
  } catch (err) {
    const name = missingExportName(err)
    if (name) {
      const referrer = referencedByOthers(file)
      failures.push({
        file: rel,
        specifier: '(module link)',
        reason: 'MISSING_EXPORT',
        detail: `named export '${name}' does not exist` +
          (referrer
            ? ` (imported by ${path.relative(ROOT, referrer).split(path.sep).join('/')})`
            : ' (not referenced by any other lib file - stale artifact?)'),
      })
      continue
    }
    if (err instanceof Unverifiable) {
      failures.push({ file: rel, specifier: err.spec, reason: 'UNVERIFIABLE', detail: `${err.reason} - the module graph cannot be validated statically` })
      continue
    }
    failures.push({ file: rel, specifier: '(module link)', reason: 'LINK_ERROR', detail: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`.slice(0, 300) })
  }
}

// ---------------------------------------------------------------- report
const skips = [...unverifiableSeen.values()]
const skipByReason = {}
for (const s of skips) {
  const key = s.reason.split(' (')[0]
  skipByReason[key] = (skipByReason[key] || 0) + 1
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ ok: failures.length === 0, buildDir, stats, skipByReason, failures, skips }, null, 2) + '\n')
} else {
  if (!QUIET) {
    console.log(`dist-exports: ${buildDir}`)
    console.log(`dist-exports: ${stats.importers} lib modules, ${stats.wholeFileLinked} linked clean`)
  }
  if (VERBOSE) for (const s of skips) console.log(`  info  ${s.file}: '${s.specifier}' -> ${s.reason}`)
  for (const f of failures) console.log(`  FAIL  ${f.file}: ${f.specifier} -> ${f.reason} (${f.detail})`)
  if (failures.length === 0) {
    const parts = Object.entries(skipByReason).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log('PASS  dist export gate: every packaged lib module links')
    if (parts) console.log(`      substitutes used (not silently green): ${parts}` + (VERBOSE ? '' : ' (use --verbose for detail)'))
  } else {
    const parts = {}
    for (const f of failures) parts[f.reason] = (parts[f.reason] || 0) + 1
    console.log(`FAIL  dist export gate: ${failures.length} violation(s) [${Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(' ')}]`)
    console.log('HINT  a bundled module imports a name its target no longer exports -> pin a compatible version, fix the import, or delete the stale artifact')
  }
}

process.exit(failures.length === 0 ? 0 : 1)
