#!/usr/bin/env node
// scripts/apply-community-market-no-lag.mjs - idempotent re-apply of the
// dsh-community-market "no-lag" host patch (isolated to lib/host/routes.js).
//
// PROBLEM (2026-09-02): the community-market upstream catalog source
// (deepseek1024.com / api.dshfind.com) is slow & flaky on this machine; the
// default in-memory catalog scan cache is only 5 minutes, and the installable &
// (unfiltered) discover views had NO fallback when a live scan failed, so the
// UI sat on the "正在检查可安装插件..." spinner / blank instead of responding.
//
// FIX (three localized edits, all guarded by marker 'DSH-OVERLAY: market-no-lag'):
//   1. DefaultCatalogService gets cacheTtlMs: 4h  -> cold rescans become rare.
//   2. /installable on scan failure serves the last-known 24h cached catalog
//      (stale-flagged) -> the "可安装" view never spins; its search filters
//      client-side so archify etc. remain searchable offline.
//   3. /catalog (unfiltered listing only) on scan failure serves the stale
//      24h cached catalog -> the discover grid responds instead of blanking.
//
// Every rebuild wipes these dist edits, so run after each rebuild (wired into
// package-vendor.ps1); verify-patches.ps1 has the matching check.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const build = resolveCurrentBuild()
assertLibUnpacked(build.asar)

const MARKER = 'DSH-OVERLAY: market-no-lag'
const file = join(build.nodeModules, 'dsh-community-market', 'lib', 'host', 'routes.js')

// --- Edit 1: extend in-memory scan cache TTL in the DefaultCatalogService constructor.
const TTL_ANCHOR = 'const service = new DefaultCatalogService(store, restrictedHttpClient, {'
const TTL_INSERT = `// ${MARKER}. Extend the in-memory catalog scan cache TTL so
    // the slow/flaky upstream source is re-scanned rarely and the market stays
    // snappy between refreshes (upstream cold scan takes seconds). Bumped from
    // the default 5 min to 4 h; the UI refresh button forces a live re-scan.
    const service = new DefaultCatalogService(store, restrictedHttpClient, {
        cacheTtlMs: 4 * 60 * 60 * 1000,`

// --- Edit 2: /catalog (unfiltered listing) failure fallback.
const CATALOG_OLD = `}
                    catch (cause) {
                        if (!signal.aborted && !res.destroyed)
                            sendCatalogFailure(res, cause);
                        return;
                    }
                    signal.throwIfAborted();`
const CATALOG_NEW = `}
                    catch (cause) {
                        // ${MARKER} fallback. On a failed/slow upstream scan of an unfiltered
                        // listing, serve the last-known 24h cached catalog (stale-flagged) so the
                        // discover grid never sits on an error/blank. Only done for the full-list
                        // request (no q/categories filter) so a search never gets an unfiltered stale
                        // list masquerading as its result; plugin searches on a stale cache work via
                        // the installable view, which filters client-side.
                        let staleHit = false;
                        if (!signal.aborted && !res.destroyed && previewSourceRecordId !== undefined && activeSource !== undefined) {
                            try {
                                const cached = cachedCatalogResponse(settingsScope.get().catalogCache, activeSource, localeKey);
                                if (cached !== undefined) {
                                    sendJson(res, 200, cached);
                                    staleHit = true;
                                }
                            }
                            catch { /* ignore fallback errors */ }
                        }
                        if (!staleHit) {
                            if (!signal.aborted && !res.destroyed)
                                sendCatalogFailure(res, cause);
                        }
                        return;
                    }
                    signal.throwIfAborted();`

// --- Edit 3: /installable failure fallback.
const INSTALLABLE_OLD = `void persistCatalogResponse(preview, index.source.sourceRecordId, localeKey);
                    }
                }
                catch (cause) {
                    if (!signal.aborted && !res.destroyed)
                        sendInstallError(res, cause);
                }`
const INSTALLABLE_NEW = `void persistCatalogResponse(preview, index.source.sourceRecordId, localeKey);
                    }
                }
                catch (cause) {
                    // ${MARKER} fallback. When a live upstream scan fails (slow/flaky source),
                    // serve the last-known 24h cached catalog so the "可安装" view never spins on
                    // an error; the data is flagged stale for the client.
                    if (!signal.aborted && !res.destroyed) {
                        let staleHit = false;
                        try {
                            const cache = settingsScope.get().catalogCache;
                            const sources = await service.listSources();
                            const activeSource = sources.find(source => source.enabled);
                            const cached = activeSource === undefined
                                ? undefined
                                : cachedCatalogResponse(cache, activeSource, localeKey);
                            if (cached !== undefined) {
                                sendJson(res, 200, cached);
                                staleHit = true;
                            }
                        }
                        catch { /* ignore fallback errors */ }
                        if (!staleHit)
                            sendInstallError(res, cause);
                    }
                }`

if (!existsSync(file)) {
  console.error('FAIL  ' + file + ' (missing, nothing to patch)')
  process.exitCode = 1
} else {
  let src = readFileSync(file, 'utf8')
  if (src.includes(MARKER)) {
    console.log('ok    ' + file + ' (market-no-lag already patched)')
    process.exit(0)
  }
  let changed = false

  if (src.includes('cacheTtlMs: 4 * 60 * 60 * 1000')) {
    console.log('ok    TTL already present')
  } else if (src.includes(TTL_ANCHOR)) {
    src = src.replace(TTL_ANCHOR, TTL_INSERT)
    changed = true
    console.log('patched TTL (4h scan cache)')
  } else {
    console.error('FAIL  TTL anchor not found'); process.exitCode = 1
  }

  if (src.includes('previewSourceRecordId !== undefined && activeSource !== undefined')) {
    console.log('ok    catalog fallback already present')
  } else if (src.includes(CATALOG_OLD)) {
    src = src.replace(CATALOG_OLD, CATALOG_NEW)
    changed = true
    console.log('patched catalog fallback')
  } else {
    console.error('FAIL  catalog fallback anchor not found'); process.exitCode = 1
  }

  if (src.includes('const sources = await service.listSources();')) {
    console.log('ok    installable fallback already present')
  } else if (src.includes(INSTALLABLE_OLD)) {
    src = src.replace(INSTALLABLE_OLD, INSTALLABLE_NEW)
    changed = true
    console.log('patched installable fallback')
  } else {
    console.error('FAIL  installable fallback anchor not found'); process.exitCode = 1
  }

  if (changed) {
    writeFileSync(file, src)
    console.log('MARKER added to ' + file)
  }
}