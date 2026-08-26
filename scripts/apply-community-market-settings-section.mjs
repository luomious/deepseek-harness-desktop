#!/usr/bin/env node
// scripts/apply-community-market-settings-section.mjs - re-apply the dist patch that restores
// the community market's top-level settings section (idempotent).
//
// Background: the built-in dsh-community-market client only registers
// 'settings.plugins.tab' (a sub-tab inside the Plugins section),
// 'sidebar.footer.action' and 'shell.overlay'. Users expect the market as a
// top-level settings section (as dsh-market provided). This patch ADDITIVELY
// registers 'settings.section' -> MarketSettingsTab; original entries stay.
//
// The patch lives in a build output that every rebuild wipes, so run this
// after each rebuild (wired into package-vendor.ps1); verify-patches.ps1 has
// the matching check ('community-market settings.section').
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCurrentBuild } from './resolve-dist.mjs'

const build = resolveCurrentBuild()
const MARKER = 'DSH-OVERLAY: community-market settings.section'
const ANCHOR = 'ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({'

const targets = [join(build.nodeModules, 'dsh-community-market', 'lib', 'client.js')]

for (const file of targets) {
  if (!existsSync(file)) { console.log('skip  ' + file + ' (missing)'); continue }
  let src = readFileSync(file, 'utf8')
  if (src.includes(MARKER)) { console.log('ok    ' + file + ' (already patched)'); continue }
  const idx = src.indexOf(ANCHOR)
  if (idx === -1) { console.error('FAIL  ' + file + ': anchor not found'); process.exitCode = 1; continue }
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const insert = [
    '/* ' + MARKER + '.',
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
  writeFileSync(file, src)
  console.log('patched ' + file)
}
