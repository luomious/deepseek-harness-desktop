// scripts/resolve-dist.mjs
// Single source of truth for "which build the patch scripts should target".
// The patch target is the NEWEST DSH Desktop.exe under vendor/.../dist (by
// mtime), skipping archive/junk dirs (names starting with '_' or '.'). This is
// deliberately DIFFERENT from the app entry mechanism: the desktop shortcut
// always points at dist\win-unpacked (a junction re-pointed by
// promote-build.ps1), while this resolver follows the newest real build so
// patches land on the build that will be promoted next. Every patch/verify
// script must resolve the build through here instead of hardcoding a dist path,
// so a rebuild into a new directory (DSH_OUT_DIR) never desyncs patches from
// the running build again.
//
// Usage as CLI:  node scripts/resolve-dist.mjs   -> prints JSON on stdout
import { readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VENDOR_ROOT = 'D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop'
const DIST = join(VENDOR_ROOT, 'dist')

function collectExes(dir, out) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    // Skip archive/junk dirs (moved-out builds keep these markers) and hidden dirs.
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) collectExes(full, out)
    else if (e.name === 'DSH Desktop.exe') out.push(full)
  }
}

export function resolveCurrentExe() {
  const exes = []
  collectExes(DIST, exes)
  if (exes.length === 0) throw new Error('resolve-dist: no DSH Desktop.exe found under ' + DIST)
  exes.sort((a, b) => {
    const byTime = statSync(b).mtimeMs - statSync(a).mtimeMs
    if (byTime !== 0) return byTime
    // mtime tie: prefer the canonical flat dist/win-unpacked (shorter path),
    // then lexical order — keeps the pick deterministic instead of arbitrary.
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
  })
  return exes[0]
}

export function resolveCurrentBuild() {
  const exe = resolveCurrentExe()
  const buildDir = dirname(exe)
  const unpackedRoot = join(buildDir, 'resources', 'app.asar.unpacked')
  return {
    exe,
    buildDir,
    unpackedRoot,
    asar: join(buildDir, 'resources', 'app.asar'),
    nodeModules: join(unpackedRoot, 'node_modules'),
    lib: join(unpackedRoot, 'lib'),
  }
}

const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  console.log(JSON.stringify(resolveCurrentBuild()))
}
