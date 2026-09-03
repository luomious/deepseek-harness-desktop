#!/usr/bin/env node
// scripts/apply-community-market-settings-section.mjs - re-apply the dist patch for the
// built-in community market client (idempotent):
//   launcher removed: drop the sidebar footer entry above the settings button
//   per user request 2026-08-26 (marker 'DSH-OVERLAY: community-market launcher removed').
//
// History: this script used to ALSO ADD a top-level 'settings.section' entry for
// the market ("插件市场" in the settings sidebar, as dsh-market provided). Per user
// request 2026-09-02 the market is integrated into the Plugins settings section
// only (its settings.plugins.tab), so that overlay is intentionally NOT registered.
// After a rebuild the upstream client.js has no top-level section either, so the
// desired state is the upstream default — nothing to re-apply for it here.
//
// The launcher patch lives in build outputs that every rebuild wipes, so run this
// after each rebuild (wired into package-vendor.ps1); verify-patches.ps1 has the
// matching check.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'
import { assertLibUnpacked } from './check-dist-integrity.mjs'

const build = resolveCurrentBuild()
// Fail loudly if the rebuild packed lib/ back into app.asar (dist patches
// target app.asar.unpacked and would otherwise become silently ineffective).
assertLibUnpacked(build.asar)
const LAUNCHER_MARKER = 'DSH-OVERLAY: community-market launcher removed'

const targets = [join(build.nodeModules, 'dsh-community-market', 'lib', 'client.js')]

for (const file of targets) {
  if (!existsSync(file)) { console.log('skip  ' + file + ' (missing)'); continue }
  let src = readFileSync(file, 'utf8')
  let changed = false
  const eol = src.includes('\r\n') ? '\r\n' : '\n'

  // Patch 1: remove the sidebar footer launcher registration block.
  if (src.includes(LAUNCHER_MARKER)) {
    console.log('ok    ' + file + ' (launcher already removed)')
  } else {
    const block = [
      '\t\t\tctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({',
      '\t\t\t\tname: "sidebar.footer.action",',
      '\t\t\t\tid: "community-market",',
      '\t\t\t\torder: 10,',
      '\t\t\t\tlabel: () => ctx.locale.bind(NS)("tab"),',
      '\t\t\t\tlocale: NS,',
      '\t\t\t\tstore: marketView',
      '\t\t\t}, MarketLauncher));',
    ].join(eol)
    const lidx = src.indexOf(block)
    if (lidx === -1) { console.error('FAIL  ' + file + ': launcher block not found'); process.exitCode = 1; continue }
    const replacement = [
      '\t\t\t/* ' + LAUNCHER_MARKER + '.',
      '   The sidebar footer entry above the settings button was removed per user',
      '   request (2026-08-26); the market lives in the Plugins settings section',
      '   (settings.plugins.tab) since 2026-09-02. */',
    ].join(eol)
    src = src.slice(0, lidx) + replacement + src.slice(lidx + block.length)
    changed = true
    console.log('patched ' + file + ' (launcher removed)')
  }

  if (changed) writeFileSync(file, src)
}
