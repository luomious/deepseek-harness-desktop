#!/usr/bin/env node
// scripts/apply-settings-resilience.mjs - re-apply the 2026-09-03 settings-resilience
// dist patches after a rebuild (idempotent, marker-gated):
//
//   Patch A (startup resilience): dsh-plugin-desktop lib readDesktopStartupSettings no
//   longer THROWS on a corrupt/unparsable settings.yaml; it logs to stderr and falls
//   back to the default compatibility mode/port. Root evidence: a malformed
//   dsh-community-market catalogCache (corrupt 1024-store catalog text) produced YAML
//   with 102 parse errors and bricked every subsequent startup ("invalid settings
//   document", session 2026-09-03).
//   Marker: 'DSH-2026-09-03 settings-resilience guard'
//
//   Patch B (root prevention): dsh-community-market lib host routes no longer persist
//   the raw catalog snapshot into the shared settings.yaml (scope.update({catalogCache})
//   is skipped). The catalog still loads in-memory and re-fetches on demand.
//   Marker: 'DSH-2026-09-03 root-guard'
//
// The compiled desktop lib file name is content-hashed (profile-<hash>.js) and changes
// on every rebuild, so Patch A locates its target by CONTENT (the upstream throw
// string), never by file name. Both patches also exist in the TS sources
// (dsh-plugin-desktop/src/profile.ts, dsh-community-market/src/host/routes.ts) so a
// normal rebuild re-emits them; this script is the belt-and-suspenders for dist trees
// that were built before the source fix or from an upstream sync. verify-patches.ps1
// has the matching checks (section: settings-resilience).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const build = resolveCurrentBuild()
// Fail loudly if the rebuild packed lib/ back into app.asar (dist patches target
// app.asar.unpacked and would otherwise become silently ineffective).
assertLibUnpacked(build.asar)

const MARKER_A = 'DSH-2026-09-03 settings-resilience guard'
const MARKER_B = 'DSH-2026-09-03 root-guard'
let failed = false

// ---------------------------------------------------------------- Patch A: desktop lib
// Upstream compiled form (tsdown, tab-indented, single line):
//   if (parsed.errors.length > 0) throw new Error(`${BIN_NAME}: invalid settings
//   document at ${spec.filename}: ${parsed.errors.map((error) => error.message).join("; ")}`);
const THROW_RE = /if \(parsed\.errors\.length > 0\) throw new Error\(`\$\{BIN_NAME\}: invalid settings document at \$\{spec\.filename\}: \$\{parsed\.errors\.map\(\(error\) => error\.message\)\.join\("; "\)\}`\);/u
const GUARD_BLOCK = [
  'if (parsed.errors.length > 0) {',
  '\t\t\t/* ' + MARKER_A + ': a corrupt or unparsable settings.yaml',
  '\t\t\t   (e.g. an earlier malformed dsh-community-market catalogCache persist) must',
  '\t\t\t   never brick Desktop startup. Fall back to default shell mode/port. */',
  '\t\t\ttry { console.error(`${BIN_NAME}: ignoring invalid settings document at ${spec.filename}; using default startup settings: ${parsed.errors.map((error) => error.message).join("; ")}`); } catch (_ignored) { /* logging must never throw here */ }',
  '\t\t\treturn { mode: DEFAULT_DESKTOP_SHELL_MODE, port: DEFAULT_DESKTOP_PORT };',
  '\t\t}',
].join('\n')

let libCandidates = []
try {
  libCandidates = readdirSync(build.lib).filter(name => /^profile-.*\.js$/u.test(name))
} catch (cause) {
  console.error('FAIL  desktop lib dir unreadable: ' + build.lib + ' (' + cause.message + ')')
  failed = true
}
let libTargets = libCandidates
  .map(name => join(build.lib, name))
  .filter(file => existsSync(file) && readFileSync(file, 'utf8').includes('invalid settings document at'))
if (libTargets.length === 0) {
  console.error('FAIL  no profile-*.js containing the settings read path found in ' + build.lib)
  failed = true
}
for (const file of libTargets) {
  const src = readFileSync(file, 'utf8')
  if (src.includes(MARKER_A)) {
    console.log('ok    ' + file + ' (Patch A already applied)')
    continue
  }
  if (!THROW_RE.test(src)) {
    console.error('FAIL  ' + file + ': upstream throw not found and marker absent (upstream format changed?)')
    failed = true
    continue
  }
  writeFileSync(file, src.replace(THROW_RE, GUARD_BLOCK))
  console.log('patched ' + file + ' (Patch A: startup resilience guard)')
}

// ---------------------------------------------------- Patch B: market catalog persist
const ROUTES_RE = /if \(cache !== undefined\)\r?\n\s+await scope\.update\(\{ catalogCache: cache \}\);/u
const ROUTES_REPLACEMENT = [
  'if (cache !== undefined) {',
  '            /* ' + MARKER_B + ': never persist the raw community-market catalog',
  '               snapshot into the shared settings.yaml. The upstream 1024-store catalog has',
  '               shipped corrupt/mixed-encoding text (U+FFFD, embedded "description:"/"categories:"',
  '               fragments) that intermittently broke YAML serialization and formerly bricked',
  '               startup via the settings document. The catalog still loads in-memory and simply',
  '               re-fetches on demand; only the persisted-disk-cache copy is dropped. */',
  '            try { console.error(`[dsh-community-market] skipping catalogCache disk persistence (sourceRecordId=${sourceRecordId}) to protect settings.yaml`); } catch (_ignored) {}',
  '        }',
].join('\n')

const marketRoutes = join(build.nodeModules, 'dsh-community-market', 'lib', 'host', 'routes.js')
if (!existsSync(marketRoutes)) {
  console.error('FAIL  missing ' + marketRoutes)
  failed = true
} else {
  const src = readFileSync(marketRoutes, 'utf8')
  if (src.includes(MARKER_B)) {
    console.log('ok    ' + marketRoutes + ' (Patch B already applied)')
  } else if (!ROUTES_RE.test(src)) {
    console.error('FAIL  ' + marketRoutes + ': upstream scope.update({catalogCache}) not found and marker absent (upstream format changed?)')
    failed = true
  } else {
    writeFileSync(marketRoutes, src.replace(ROUTES_RE, ROUTES_REPLACEMENT))
    console.log('patched ' + marketRoutes + ' (Patch B: catalogCache persist skipped)')
  }
}

if (failed) {
  console.error('apply-settings-resilience: at least one target FAILED; see lines above.')
  process.exitCode = 1
} else {
  console.log('apply-settings-resilience: all targets verified/patched for ' + build.buildDir)
}
