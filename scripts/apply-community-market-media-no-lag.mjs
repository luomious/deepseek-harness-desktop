#!/usr/bin/env node
// scripts/apply-community-market-media-no-lag.mjs - idempotent re-apply of
// the dsh-community-market media (plugin icon) "no-lag" patch, isolated to
// lib/media/restricted-image.js and lib/media/service.js.
//
// PROBLEM (2026-09-02): plugin icons are fetched live from flaky upstream
// hosts (github.com / avatars.githubusercontent.com / deepseek1024.com images).
// With a 30 s total timeout and a concurrency cap of 2, stalled icons blocked
// the whole market grid for tens of seconds on every open, and failures were
// never remembered so the next open re-hung.
//
// FIX (marker 'DSH-OVERLAY: market-media-no-lag'):
//   1. restricted-image.js: tighten timeouts (connect 3s / first-byte 5s /
//      total 8s) so an unreachable icon fails fast and the client shows the
//      built-in placeholder.
//   2. service.js: raise media resolution concurrency 2 -> 8 so the grid
//      resolves in parallel.
//   3. service.js: failed-resolution backoff (10 min) - a failed icon is not
//      re-fetched on every open; the placeholder path serves instead.
//
// Every rebuild wipes these dist edits, so run after each rebuild (wired into
// package-vendor.ps1); verify-patches.ps1 has the matching checks.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const build = resolveCurrentBuild()
assertLibUnpacked(build.asar)

const MARKER = 'DSH-OVERLAY: market-media-no-lag'
const lib = join(build.nodeModules, 'dsh-community-market', 'lib')
const imageFile = join(lib, 'media', 'restricted-image.js')
const serviceFile = join(lib, 'media', 'service.js')
const adapterFile = join(lib, 'adapters', 'dsh-1024store.js')

// --- Edit 1: restricted-image.js timeouts. ---
const IMAGE_OLD = `const CONNECT_TIMEOUT_MS = 8_000;
const FIRST_BYTE_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 30_000;`
const IMAGE_NEW = `// ${MARKER}. The machine's direct HTTPS routes to github.com /
// avatars.githubusercontent.com are flaky, so plugin icons used to hang up to
// 30 s per asset and stall the whole market grid. Tighten the timeouts so a
// missing icon fails fast (placeholder) instead of blocking.
const CONNECT_TIMEOUT_MS = 3_000;
const FIRST_BYTE_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 8_000;`

// --- Edit 2a: service.js concurrency 2 -> 8. ---
const CONCURRENCY_OLD = 'const DEFAULT_MAX_CONCURRENT_RESOLUTIONS = 2;'
const CONCURRENCY_NEW = `// ${MARKER}. Package icons come from flaky upstream hosts; with only 2
// concurrent resolutions a stalled icon serialized the whole market grid.
// Raise the concurrency so the grid resolves in parallel.
const DEFAULT_MAX_CONCURRENT_RESOLUTIONS = 8;`

// --- Edit 2b: service.js failed-resolution backoff (10 min). ---
const FAILED_TTL_OLD = 'const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;\nconst DEFAULT_MAX_CACHED_ASSETS = 256;'
const FAILED_TTL_NEW = `const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// ${MARKER} failed-resolution backoff.
const DEFAULT_FAILED_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHED_ASSETS = 256;`

const FAILED_STORE_OLD = 'const assets = new Map();\n    const candidateRefs = new Map();\n    let disposed = false;'
const FAILED_STORE_NEW = `const assets = new Map();
    const candidateRefs = new Map();
    // ${MARKER} failed-resolution backoff store.
    const failedResolutions = new Map();
    let disposed = false;`

const FAILED_DELETE_OLD = 'assets.delete(assetRef);\n        candidateRefs.delete(candidateKey(entry.candidate));'
const FAILED_DELETE_NEW = `assets.delete(assetRef);
        candidateRefs.delete(candidateKey(entry.candidate));
        failedResolutions.delete(assetRef);`

const FAILED_OPTIONS_OLD = 'const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;\n    const maxCachedAssets = options.maxCachedAssets ?? DEFAULT_MAX_CACHED_ASSETS;'
const FAILED_OPTIONS_NEW = `const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    // ${MARKER} failed-resolution backoff.
    const failedCacheTtlMs = options.failedCacheTtlMs ?? DEFAULT_FAILED_CACHE_TTL_MS;
    const maxCachedAssets = options.maxCachedAssets ?? DEFAULT_MAX_CACHED_ASSETS;`

const FAILED_VALIDATE_OLD = '|| cacheTtlMs < 0) {'
const FAILED_VALIDATE_NEW = '|| cacheTtlMs < 0\n        || failedCacheTtlMs < 0) {'

const FAILED_RESOLVE_OLD = `if (!MARKET_MEDIA_ASSET_REF_PATTERN.test(assetRef))
                return undefined;
            const entry = assets.get(assetRef);`
const FAILED_RESOLVE_NEW = `if (!MARKET_MEDIA_ASSET_REF_PATTERN.test(assetRef))
                return undefined;
            // ${MARKER} failed-resolution backoff.
            const failedAt = failedResolutions.get(assetRef);
            if (failedAt !== undefined && now() - failedAt < failedCacheTtlMs)
                return undefined;
            const entry = assets.get(assetRef);`

const FAILED_SUCCESS_OLD = `entry.cached = asset;
                    entry.cachedAt = now();
                    evictExcessCache();
                }, () => { }).then(() => {`
const FAILED_SUCCESS_NEW = `failedResolutions.delete(assetRef);
                    entry.cached = asset;
                    entry.cachedAt = now();
                    evictExcessCache();
                }, () => {
                    if (!disposed && assets.get(assetRef) === entry)
                        failedResolutions.set(assetRef, now());
                }).then(() => {`

const FAILED_DISPOSE_OLD = 'candidateRefs.clear();'
const FAILED_DISPOSE_NEW = `candidateRefs.clear();
            // ${MARKER} failed-resolution backoff store.
            failedResolutions.clear();`

// --- Edit 3: dsh-1024store.js fallback icon host github.com -> avatars (reachable). ---
const ADAPTER_OLD = `...(owner === undefined ? [] : [{
                remoteUrl: \`https://github.com/\${owner}.png?size=96\`,`
const ADAPTER_NEW = `// ${MARKER}. github.com is unreachable on this host while
        // avatars.githubusercontent.com is reachable; GitHub owner avatars are
        // the same asset, so fetch them from the reachable domain.
        ...(owner === undefined ? [] : [{
                remoteUrl: \`https://avatars.githubusercontent.com/\${owner}?size=96\`,`

function apply(file, edits) {
  if (!existsSync(file)) {
    console.error('FAIL  ' + file + ' (missing, nothing to patch)')
    process.exitCode = 1
    return
  }
  let src = readFileSync(file, 'utf8')
  if (src.includes(MARKER)) {
    console.log('ok    ' + file + ' (market-media-no-lag already patched)')
    return
  }
  let changed = false
  for (const [name, oldText, newText] of edits) {
    if (src.includes(oldText)) {
      src = src.replace(oldText, newText)
      changed = true
      console.log('patched ' + name)
    } else {
      console.error('FAIL  ' + name + ' anchor not found in ' + file)
      process.exitCode = 1
    }
  }
  if (changed) writeFileSync(file, src)
  else console.log('nothing to patch in ' + file)
}

apply(imageFile, [
  ['restricted-image timeouts', IMAGE_OLD, IMAGE_NEW],
])

apply(serviceFile, [
  ['media concurrency', CONCURRENCY_OLD, CONCURRENCY_NEW],
  ['failed-resolution TTL const', FAILED_TTL_OLD, FAILED_TTL_NEW],
  ['failed-resolution store', FAILED_STORE_OLD, FAILED_STORE_NEW],
  ['failed-resolution delete cleanup', FAILED_DELETE_OLD, FAILED_DELETE_NEW],
  ['failed-resolution option', FAILED_OPTIONS_OLD, FAILED_OPTIONS_NEW],
  ['failed-resolution validation', FAILED_VALIDATE_OLD, FAILED_VALIDATE_NEW],
  ['failed-resolution resolve guard', FAILED_RESOLVE_OLD, FAILED_RESOLVE_NEW],
  ['failed-resolution success/error hooks', FAILED_SUCCESS_OLD, FAILED_SUCCESS_NEW],
  ['failed-resolution dispose cleanup', FAILED_DISPOSE_OLD, FAILED_DISPOSE_NEW],
])

apply(adapterFile, [
  ['adapter fallback icon host', ADAPTER_OLD, ADAPTER_NEW],
])

console.log('MARKER ' + MARKER + ' ensured on media + adapter files')