#!/usr/bin/env node
// scripts/apply-community-market-settings-section.mjs - re-apply the dist patches for the
// built-in community market client (idempotent):
//   1. settings.section: restore the top-level settings section (marker
//      'DSH-OVERLAY: community-market settings.section').
//   2. launcher removed: drop the sidebar footer entry above the settings button
//      per user request 2026-08-26 (marker 'DSH-OVERLAY: community-market launcher removed').
//
// Background (1): the built-in dsh-community-market client only registers
// 'settings.plugins.tab' (a sub-tab inside the Plugins section),
// 'sidebar.footer.action' and 'shell.overlay'. Users expect the market as a
// top-level settings section (as dsh-market provided), so patch 1 ADDITIVELY
// registers 'settings.section' -> MarketSettingsTab; original entries stay.
//
// Background (2): the sidebar footer launcher duplicates the entry point and
// sits above the settings button; the user asked to remove it. The overlay
// stays registered (invisible without the launcher), so no other surface moves.
//
// The patches live in build outputs that every rebuild wipes, so run this
// after each rebuild (wired into package-vendor.ps1); verify-patches.ps1 has
// the matching checks.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'

const build = resolveCurrentBuild()
const SECTION_MARKER = 'DSH-OVERLAY: community-market settings.section'
const SECTION_ANCHOR = 'ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({'
const LAUNCHER_MARKER = 'DSH-OVERLAY: community-market launcher removed'

const targets = [join(build.nodeModules, 'dsh-community-market', 'lib', 'client.js')]

for (const file of targets) {
  if (!existsSync(file)) { console.log('skip  ' + file + ' (missing)'); continue }
  let src = readFileSync(file, 'utf8')
  let changed = false
  const eol = src.includes('\r\n') ? '\r\n' : '\n'

  // Patch 1: additively register settings.section before the plugins sub-tab block.
  if (src.includes(SECTION_MARKER)) {
    console.log('ok    ' + file + ' (settings.section already patched)')
  } else {
    const idx = src.indexOf(SECTION_ANCHOR)
    if (idx === -1) { console.error('FAIL  ' + file + ': settings.section anchor not found'); process.exitCode = 1; continue }
    const insert = [
      '/* ' + SECTION_MARKER + '.',
      '   The built-in community market client only registers a plugins sub-tab,',
      '   a sidebar launcher and an overlay; users expect a top-level settings',
      '   section (as dsh-market provided). Additively register settings.section',
      '   rendering MarketSettingsTab; all original entries are kept. */',
      '\t\t\tctx.slots.inject("settings.section", () => ctx.slots.register({',
      '\t\t\t\tname: "settings.section",',
      '\t\t\t\tid: "community-market",',
      '\t\t\t\torder: 40,',
      '\t\t\t\tlabel: () => ctx.locale.bind(NS)("tab"),',
      '\t\t\t\tlocale: NS,',
      '\t\t\t\tinject: () => ({ readLocale })',
      '\t\t\t}, MarketSettingsTab));',
      '\t\t\t',
    ].join(eol)
    src = src.slice(0, idx) + insert + src.slice(idx)
    changed = true
    console.log('patched ' + file + ' (settings.section)')
  }

  // Patch 2: remove the sidebar footer launcher registration block.
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
      '   request (2026-08-26); the market lives in the top-level settings section. */',
    ].join(eol)
    src = src.slice(0, lidx) + replacement + src.slice(lidx + block.length)
    changed = true
    console.log('patched ' + file + ' (launcher removed)')
  }

  if (changed) writeFileSync(file, src)
}
