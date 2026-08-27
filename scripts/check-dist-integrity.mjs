#!/usr/bin/env node
// check-dist-integrity.mjs - verify the two invariants that keep dist-level
// patches effective and the packaged runtime bootable:
//
//   1. "unpack everything" contract: lib/ entry files must be UNPACKED (stub)
//      inside app.asar. If a rebuild wrongly packs lib/ back into app.asar,
//      every dist patch that targets app.asar.unpacked becomes silently
//      ineffective (Electron loads the packed copy). Fail loudly instead.
//
//   2. module-graph integrity: every relative static import referenced by
//      lib/main.js must exist beside it. A stale/partial lib (old main.js
//      referencing a missing hashed chunk) is exactly what produces the fatal
//      ERR_MODULE_NOT_FOUND at link time.
//
// Usage (CLI):
//   node scripts/check-dist-integrity.mjs            # auto-resolve current build
//   node scripts/check-dist-integrity.mjs <app.asar> <libDir>
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { VENDOR_ROOT, resolveCurrentBuild } from './resolve-dist.mjs'

const requireFromVendor = createRequire(join(VENDOR_ROOT, 'package.json'))
const { statFile } = requireFromVendor('@electron/asar')

// Entries whose UNPACKED disposition gates the effectiveness of every dist
// patch. lib/main.js is the Electron entry; lib/client.js is the renderer
// bundle. Both must be stubs inside app.asar (real bytes live in
// app.asar.unpacked/lib) per package.json "asarUnpack": ["lib/**", ...].
export const GATED_ASAR_ENTRIES = ['lib/main.js', 'lib/client.js']

export function assertLibUnpacked(asarPath, entries = GATED_ASAR_ENTRIES) {
  const bad = []
  for (const entry of entries) {
    let st
    try {
      st = statFile(asarPath, entry)
    } catch (cause) {
      bad.push(`${entry} (stat failed: ${cause instanceof Error ? cause.message : String(cause)})`)
      continue
    }
    if (st.unpacked !== true) {
      bad.push(`${entry} (packed in asar; unpacked=${String(st.unpacked)})`)
    }
  }
  if (bad.length > 0) {
    throw new Error(
      'app.asar violates the "unpack everything" contract: ' + bad.join(', ') +
      ' — repackage with `package:dir` (electron-builder honoring asarUnpack) before applying dist patches',
    )
  }
  return true
}

export function checkMainImports(libDir, mainFile = 'main.js') {
  const mainPath = join(libDir, mainFile)
  const src = readFileSync(mainPath, 'utf8')
  const specs = new Set()
  const re = /from\s+["']\.\/([^"']+)["']/g
  let m
  while ((m = re.exec(src)) !== null) specs.add(m[1])
  const missing = []
  for (const spec of specs) {
    // Only sibling .js/.cjs chunks gate static ESM linking. Other specifiers
    // (native-ui html, hashed maps) are loaded lazily and are non-fatal.
    if (/\.(?:js|cjs)$/.test(spec) && !existsSync(join(libDir, spec))) missing.push(spec)
  }
  return { total: specs.size, missing }
}

export function checkCurrentDist() {
  const build = resolveCurrentBuild()
  assertLibUnpacked(build.asar)
  const imports = checkMainImports(build.lib)
  if (imports.missing.length > 0) {
    throw new Error('lib/main.js references missing chunks: ' + imports.missing.join(', '))
  }
  return { build, imports }
}

const invoked = process.argv[1] && /check-dist-integrity\.mjs$/.test(process.argv[1])
if (invoked) {
  try {
    const asarPath = process.argv[2]
    const libDir = process.argv[3]
    if (asarPath && libDir) {
      assertLibUnpacked(asarPath)
      const imports = checkMainImports(libDir)
      if (imports.missing.length > 0) {
        throw new Error('lib/main.js references missing chunks: ' + imports.missing.join(', '))
      }
      console.log(`OK: unpacked contract holds; ${imports.total} relative imports resolved`)
    } else {
      const { build, imports } = checkCurrentDist()
      console.log(`OK: ${build.buildDir}`)
      console.log(`OK: lib entries unpacked; ${imports.total} relative imports resolved`)
    }
  } catch (cause) {
    console.error('FAIL: ' + (cause instanceof Error ? cause.message : String(cause)))
    process.exit(1)
  }
}
