#!/usr/bin/env node
/**
 * verify-client-services.mjs - client-side service provide/consume drift gate (read-only).
 *
 * WHY THIS EXISTS (the class the 2026-09-28 upgrade hit hardest)
 * -------------------------------------------------------------
 * On 0.1.7 the desktop booted into "17 client entries pending". Root cause:
 * `dsh-client-ui-settings` no longer PROVIDES `settingsScope`, while
 * `dsh-client-ui-settings-models` / `-conversation` still INJECT it. The fibers
 * never activate -- no error, no log, just missing UI. A shim had to be written
 * by hand to recover it.
 *
 * Every existing gate is blind to this: `verify-dist-exports.mjs` and
 * `verify-profile-exports.mjs` check ESM named exports; `startup-verify.mjs`
 * checks bundles/patches. A service that nobody provides is not an export and
 * not a file -- it only shows up as a fiber that never starts.
 *
 * WHAT IT DOES
 * ------------
 * For each kernel tree it scans every `@deepseek-ai/<pkg>/lib/client.js` and
 * collects (a) provided service names (`super(ctx,"x")`, `reflect.provide("x"`,
 * `.provide("x"`) and (b) consumed names (`inject: [...]`, `static inject = [...]`,
 * `ctx.inject([...])`). A name that is consumed but never provided inside the same
 * kernel is an ORPHAN -- except host-side services, excluded via a known list.
 * It then reports the orphans NEW in the target relative to a baseline, which is
 * precisely the regression signal: "this release dropped a provider others need".
 *
 * Usage:
 *   node scripts/verify-client-services.mjs                         # newest vs the other build
 *   node scripts/verify-client-services.mjs --target <dir> --baseline <dir>
 *   node scripts/verify-client-services.mjs --json
 * Exit: 1 = new orphan(s) in the target kernel (would leave fibers pending).
 *
 * HONEST LIMITS: lexical extraction, so a service provided via an indirection is
 * invisible; host-side names must be listed in HOST_SERVICES below, and anything
 * consumed but unknown is reported (never silently dropped).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ROOT = path.join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop', 'dist')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const JSON_OUT = has('--json')

/** Services provided by the HOST side; a client bundle may inject them legitimately. */
const HOST_SERVICES = new Set([
  'webServer', 'hostServices', 'tools', 'llm', 'settings', 'credentials', 'session', 'sessions',
  'agents', 'goals', 'jobs', 'schedule', 'subprocess', 'systemPrompt', 'timer', 'skills', 'fs',
  'shell', 'sandboxPolicy', 'approval', 'permission', 'compaction', 'loader', 'storage', 'web',
  'workspaceRegistry', 'attachments', 'commands', 'authorization', 'connection', 'apiRemotes',
])

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

function clientFiles(kernel) {
  const out = []
  for (const scope of ['@deepseek-ai', '@dsh-external']) {
    const dir = path.join(kernel, scope)
    if (!fs.existsSync(dir)) continue
    for (const pkg of fs.readdirSync(dir)) {
      for (const rel of ['lib/client.js', 'client.js', 'dist/client.js']) {
        const f = path.join(dir, pkg, rel)
        if (fs.existsSync(f)) out.push({ pkg: `${scope}/${pkg}`, file: f })
      }
    }
  }
  return out
}

/**
 * Packages the active profile ACTUALLY LOADS: `dsh.profile.bundles` members plus every
 * package named by a `cordis.patch.yml` row.
 *
 * Measured 2026-09-29: the shell's healthy-profile checkpoint restored the 2026-09-27
 * cordis.patch.yml over the live one, which dropped the `settings-scope-shim` insert row
 * and its dependency -- the shim stayed on disk (junction intact) but was no longer
 * wired, so `settingsScope`/`uiConversation` would have stayed pending. The previous
 * version of this gate globbed node_modules only and still printed COVERED -> PASS:
 * a false green over the exact regression it exists to catch.
 *
 * HONEST LIMIT: a package injected at RUNTIME (dsh-super-injector) is invisible to this
 * static check, so it is reported as unwired; treat an UNWIRED line as "verify the
 * wiring" rather than as proof of failure.
 */
function wiredProfilePackages() {
  const profile = process.env.DSH_PROFILE || 'desktop'
  const dir = path.join(os.homedir(), '.dsh', 'profiles', profile)
  const wired = new Set()
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    for (const name of pkg?.dsh?.profile?.bundles ?? []) wired.add(name)
  } catch { /* no package.json -> nothing wired from bundles */ }
  try {
    const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
    for (const m of patch.matchAll(/\bname\s*:\s*['"]([^'"]+)['"]/g)) wired.add(m[1])
    for (const m of patch.matchAll(/^\s*-?\s*id\s*:\s*([A-Za-z0-9@/._-]+)\s*$/gm)) wired.add(m[1])
  } catch { /* no patch file -> only bundles count */ }
  return wired
}

/** The active profile's own plugin tree (junctions followed) -- its providers count too. */
function profileClientFiles(wired) {
  const profile = process.env.DSH_PROFILE || 'desktop'
  const root = path.join(os.homedir(), '.dsh', 'profiles', profile, 'node_modules')
  if (!fs.existsSync(root)) return []
  try {
    return clientFiles(root).map(entry => ({ ...entry, wired: wired.has(entry.pkg) }))
  } catch { return [] }
}

/** Provided / consumed service names inside one client bundle. */
function servicesOf(file) {
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return { provided: [], consumed: [] } }
  const provided = new Set(), consumed = new Set()
  for (const m of src.matchAll(/\bsuper\s*\(\s*ctx\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g)) provided.add(m[1])
  for (const m of src.matchAll(/\bprovide\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g)) provided.add(m[1])
  for (const m of src.matchAll(/\binject\s*[:=]\s*\[([^\]]*)\]/g)) {
    for (const n of m[1].split(',')) {
      const t = n.trim().replace(/['"]/g, '')
      if (/^[A-Za-z_$][\w$]*$/.test(t)) consumed.add(t)
    }
  }
  for (const m of src.matchAll(/\bctx\s*\.\s*inject\s*\(\s*\[([^\]]*)\]/g)) {
    for (const n of m[1].split(',')) {
      const t = n.trim().replace(/['"]/g, '')
      if (/^[A-Za-z_$][\w$]*$/.test(t)) consumed.add(t)
    }
  }
  return { provided: [...provided], consumed: [...consumed] }
}

function analyse(kernel) {
  const provided = new Map(), consumed = new Map()
  let files = 0, unwiredFiles = 0
  const collect = (list) => {
    for (const { pkg, file } of list) {
      files++
      const s = servicesOf(file)
      for (const n of s.provided) {
        if (!provided.has(n)) provided.set(n, [])
        provided.get(n).push(`${pkg}/lib/client.js`)
      }
      for (const n of s.consumed) {
        if (!consumed.has(n)) consumed.set(n, [])
        consumed.get(n).push(`${pkg}/lib/client.js`)
      }
    }
  }
  collect(clientFiles(kernel))

  // Providers supplied by OUR profile (shims etc.) close a gap the kernel left open --
  // but only when the profile actually WIRES them (bundles or a patch row).
  const kernelProvided = new Set(provided.keys())
  const wired = wiredProfilePackages()
  const unwiredProvided = new Map()
  for (const { pkg, file, wired: isWired } of profileClientFiles(wired)) {
    files++
    const s = servicesOf(file)
    // Consumers count whether or not the package is wired (a profile plugin that injects
    // a dead service is a real pending fiber), but PROVIDERS only count when wired.
    for (const n of s.consumed) {
      if (!consumed.has(n)) consumed.set(n, [])
      consumed.get(n).push(`${pkg}/lib/client.js`)
    }
    if (isWired) {
      for (const n of s.provided) {
        if (!provided.has(n)) provided.set(n, [])
        provided.get(n).push(`${pkg}/lib/client.js`)
      }
    } else if (s.provided.length > 0) {
      unwiredFiles++
      for (const n of s.provided) {
        if (!unwiredProvided.has(n)) unwiredProvided.set(n, [])
        unwiredProvided.get(n).push(`${pkg}/lib/client.js`)
      }
    }
  }
  const profileOnly = [...provided.keys()].filter((n) => !kernelProvided.has(n))

  const orphans = []
  const covered = []
  const unwired = []
  for (const [name, where] of consumed) {
    if (provided.has(name) || HOST_SERVICES.has(name)) continue
    orphans.push({ service: name, consumers: where })
  }
  for (const name of profileOnly) {
    if (consumed.has(name)) covered.push({ service: name, provider: provided.get(name).join(', ') })
  }
  // Consumed, not provided by the kernel or by any WIRED profile package, yet a provider
  // exists on disk without wiring -> the fiber would still stay pending at boot.
  for (const orphan of orphans) {
    const candidate = unwiredProvided.get(orphan.service)
    if (candidate) unwired.push({ service: orphan.service, provider: candidate.join(', '), consumers: orphan.consumers })
  }
  return {
    kernel, files, unwiredFiles,
    providedCount: kernelProvided.size,
    profileAddedCount: profileOnly.length,
    consumedCount: consumed.size,
    orphans: orphans.sort((a, b) => a.service.localeCompare(b.service)),
    coveredByProfile: covered.sort((a, b) => a.service.localeCompare(b.service)),
    unwiredProviders: unwired.sort((a, b) => a.service.localeCompare(b.service)),
  }
}

// ------------------------------------------------------------------ run

let targetKernel = opt('--target', null)
let baselineKernel = opt('--baseline', null)
if (!targetKernel || !baselineKernel) {
  const ks = findKernels()
  if (ks.length < 2) { console.error('verify-client-services: need two kernel trees (or pass --target/--baseline)'); process.exit(2) }
  targetKernel = targetKernel || ks[0].kernel
  baselineKernel = baselineKernel || ks[1].kernel
}

const target = analyse(targetKernel)
const baseline = analyse(baselineKernel)
const baseNames = new Set(baseline.orphans.map((o) => o.service))
const newOrphans = target.orphans.filter((o) => !baseNames.has(o.service))
const fixedOrphans = baseline.orphans.filter((o) => !new Set(target.orphans.map((x) => x.service)).has(o.service))

if (JSON_OUT) {
  console.log(JSON.stringify({ baseline: { kernel: baseline.kernel, orphans: baseline.orphans }, target: { kernel: target.kernel, orphans: target.orphans }, newOrphans, fixedOrphans }, null, 2))
} else {
  const rel = (p) => path.relative(REPO, p).replace(/\\/g, '/')
  console.log('[verify-client-services]')
  console.log(`  baseline: ${rel(baselineKernel)}  (${baseline.files} client bundles, ${baseline.providedCount} services provided)`)
  console.log(`  target  : ${rel(targetKernel)}  (${target.files} client bundles, ${target.providedCount} services provided)`)
  console.log(`  orphans : baseline=${baseline.orphans.length}  target=${target.orphans.length}  NEW in target=${newOrphans.length}`)
  if (newOrphans.length) {
    console.log('\n  [FAIL] services consumed in the target but provided nowhere (will leave fibers pending):')
    for (const o of newOrphans) console.log(`    - ${o.service}   consumed by: ${o.consumers.join(', ')}`)
  }
  if (fixedOrphans.length) {
    console.log(`\n  [FIXED] orphan(s) present in baseline but resolved in target: ${fixedOrphans.map((o) => o.service).join(', ')}`)
  }
  if (target.coveredByProfile.length) {
    console.log(`\n  [COVERED] upstream dropped these, OUR profile supplies them (${target.coveredByProfile.length}):`)
    for (const c of target.coveredByProfile) console.log(`    + ${c.service}  <- ${c.provider}`)
  }
  if (target.unwiredProviders.length) {
    console.log(`\n  [UNWIRED] a provider exists on disk but the profile does not load it (${target.unwiredProviders.length}):`)
    for (const u of target.unwiredProviders) console.log(`    ! ${u.service}  <- ${u.provider}  (NOT in bundles and no patch row)`)
    console.log('      ^ the fiber stays pending exactly as if nothing provided it. Wire it, or delete the package.')
    console.log('      (runtime-injected via dsh-super-injector is invisible here -- confirm before deleting.)')
  }
  if (target.orphans.length) {
    console.log(`\n  [INFO] all target orphans (${target.orphans.length}) -- pre-existing ones may be host-provided under another name:`)
    for (const o of target.orphans) console.log(`    ~ ${o.service}  (${o.consumers.length} consumer file(s))`)
  }
  const fail = newOrphans.length > 0 || target.unwiredProviders.length > 0
  console.log(`\n  RESULT: ${fail
    ? `FAIL (${newOrphans.length} new provider gap(s), ${target.unwiredProviders.length} unwired provider(s))`
    : 'PASS (no NEW provider gap, every profile provider is wired)'}`)
}
const wiringFail = target.unwiredProviders.length > 0
process.exit(newOrphans.length === 0 && !wiringFail ? 0 : 1)
