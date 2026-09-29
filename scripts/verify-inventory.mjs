#!/usr/bin/env node
/**
 * verify-inventory.mjs - CAPABILITY-MATRIX <-> disk <-> runtime gate + retirement queue.
 *
 * DIVISION OF LABOUR (deliberately NOT a duplicate)
 * -------------------------------------------------
 *   scripts/audit-plugin-inventory.mjs   (check-all Step 1.14, ADVISORY)
 *       checks plugins/INVENTORY.md's own numbers: table rows vs title count vs
 *       the 统计 line vs the measured directory list.
 *   scripts/verify-inventory.mjs         (this file, HARD gate)
 *       checks plugins/CAPABILITY-MATRIX.md -- the 2026-09-28 addition that carries
 *       per-plugin upstream-native/decision data -- against disk AND against the
 *       ACTIVE PROFILE's assembly (bundles + patch rows), and derives the
 *       retirement queue.
 *   Check [E] asserts the two registries list the same plugin set, so they cannot
 *   drift apart now that there are two of them.
 *
 * WHY THIS EXISTS
 * ---------------
 * `plugins/INVENTORY.md` calls itself the "single source of truth" for plugin state,
 * but nothing enforced that. By 2026-09-28 the drift was measurable:
 *   - the title said 38 plugin dirs, the disk had 40
 *   - `dsh-vision-rotator` was documented as "not in the runtime" while it was still
 *     in `dsh.profile.bundles` (so it WOULD apply() on the next desktop start)
 *   - `dsh-settings-scope-shim` was assembled but had no row at all
 *   - `@dsh-external/dsh-super-injector` (routing-suite's tgz component) was
 *     assembled under its own name and had never been registered anywhere
 *
 * Checks (read-only):
 *   A. matrix == disk      : every `plugins/<dir>/package.json` has a matrix row (FAIL)
 *   B. matrix == runtime   : every `@dsh-external/*` the profile assembles has a row (FAIL)
 *   C. retirement queue    : rows whose 决定 is 退役 but which are still assembled (REPORT)
 *   D. pending assessment  : rows whose 决定 is 评估 (not yet decided) (REPORT)
 *   E. the two registries  : INVENTORY.md's table set == CAPABILITY-MATRIX's set (FAIL)
 *
 * Usage: node scripts/verify-inventory.mjs [--profile desktop] [--json]
 * Exit: 0 = A/B/E hold, 1 = drift found.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = process.env.DSH_REPO || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const PROFILE = (() => { const i = argv.indexOf('--profile'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'desktop' })()

const MATRIX = path.join(REPO, 'plugins', 'CAPABILITY-MATRIX.md')
const PLUGINS_DIR = path.join(REPO, 'plugins')
const profileDir = path.join(os.homedir(), '.dsh', 'profiles', PROFILE)

if (!fs.existsSync(MATRIX)) {
  console.error(`verify-inventory: missing ${path.relative(REPO, MATRIX)}`)
  process.exit(2)
}

// ---------------------------------------------------------------- parse matrix

/** The decision cell is a leading verb plus optional qualifiers ("保留+必修",
 *  "保留（底座不可退役）", "重写或退役"). Only the LEADING token decides the
 *  category -- substring matching would misfile "保留…不可退役" as a retirement. */
const leadingDecision = (cell) => (/^[\u4e00-\u9fa5]+/.exec(cell.replace(/[*\s]/g, '')) || [''])[0]

const matrixSrc = fs.readFileSync(MATRIX, 'utf8')
const entries = new Map() // plugin -> { native, decision, precondition }
for (const line of matrixSrc.split('\n')) {
  if (!line.startsWith('|')) continue
  const cells = line.split('|').map((c) => c.trim())
  // cells[0] is '' (leading pipe); table shape: name | native | decision | pre | evidence
  if (cells.length < 6) continue
  const name = cells[1].replace(/`/g, '').trim()
  if (!name || name === '插件' || name.startsWith('---')) continue
  if (!/^[A-Za-z@][\w@/.-]*$/.test(name)) continue
  const native = cells[2].replace(/\*/g, '').trim()
  const decision = leadingDecision(cells[3])
  if (!native || !decision) continue
  if (!entries.has(name)) entries.set(name, { native, decision, decisionRaw: cells[3].replace(/\*/g, '').trim(), precondition: cells[4] || '' })
}

// ---------------------------------------------------------------- disk

const onDisk = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, e.name, 'package.json')))
  .map((e) => e.name)
  .sort()

// ---------------------------------------------------------------- runtime

function assembled() {
  const set = new Set()
  const pkgPath = path.join(profileDir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      for (const b of pkg.dsh?.profile?.bundles ?? []) set.add(b)
    } catch { /* unreadable profile: report as empty */ }
  }
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (fs.existsSync(patchPath)) {
    for (const m of fs.readFileSync(patchPath, 'utf8').matchAll(/^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) set.add(m[1].trim())
  }
  return set
}
const runtime = assembled()

/** Matrix rows name the package either bare (dsh-xxx) or scoped (@scope/dsh-xxx). */
const hasRow = (pkgName) => entries.has(pkgName) || entries.has(pkgName.replace(/^@dsh-external\//, ''))

// ---------------------------------------------------------------- checks

const missingOnDisk = onDisk.filter((d) => !hasRow(d))
const missingForRuntime = [...runtime].filter((n) => n.startsWith('@dsh-external/') && !hasRow(n)).sort()

const retirementQueue = []
const pendingAssessment = []
for (const [name, e] of entries) {
  const stillAssembled = runtime.has(name) || runtime.has(`@dsh-external/${name}`)
  if (!stillAssembled) continue
  if (e.decision === '退役') retirementQueue.push(name)
  else if (e.decision === '评估') pendingAssessment.push(name)
}

const byDecision = {}
for (const [, e] of entries) byDecision[e.decision] = (byDecision[e.decision] || 0) + 1

const failA = missingOnDisk.length > 0
const failB = missingForRuntime.length > 0

// E. the two registries must list the same plugin set.
const inventoryPath = path.join(REPO, 'plugins', 'INVENTORY.md')
const invRows = new Set()
if (fs.existsSync(inventoryPath)) {
  for (const line of fs.readFileSync(inventoryPath, 'utf8').split('\n')) {
    const m = /^\|\s*`?(dsh-[a-z0-9-]+|@[a-z0-9-]+\/[a-z0-9-]+)`?\s*\|/.exec(line)
    if (m) invRows.add(m[1])
  }
}
// E. the two registries must agree on the plugins/ scope. Market/npm entries are
// deliberately out of scope here: INVENTORY.md's market table lists only 3, while
// CAPABILITY-MATRIX also carries third-party packages -- different questions.
const matrixLocal = new Set([...entries.keys()].filter((n) => !n.startsWith('@')))
const onlyInMatrix = [...matrixLocal].filter((n) => onDisk.includes(n) && !invRows.has(n)).sort()
const onlyInInventory = [...invRows].filter((n) => onDisk.includes(n) && !matrixLocal.has(n)).sort()
const failE = (onlyInMatrix.length > 0 || onlyInInventory.length > 0)

const ok = !failA && !failB && !failE

if (JSON_OUT) {
  console.log(JSON.stringify({
    profile: PROFILE, matrixEntries: entries.size, diskPlugins: onDisk.length,
    runtimeAssembled: runtime.size, byDecision,
    missingOnDisk, missingForRuntime, retirementQueue, pendingAssessment, ok,
  }, null, 2))
} else {
  console.log(`[verify-inventory] profile=${PROFILE}`)
  console.log(`  matrix rows: ${entries.size}   plugins/ on disk: ${onDisk.length}   profile assembled names: ${runtime.size}`)
  console.log(`  decisions  : ${Object.entries(byDecision).map(([k, v]) => `${k}=${v}`).join('  ')}`)

  console.log(`\n  [A] registry == disk : ${failA ? `FAIL (${missingOnDisk.length} missing rows)` : 'PASS'}`)
  for (const d of missingOnDisk) console.log(`      ! plugins/${d} has package.json but no CAPABILITY-MATRIX row`)

  console.log(`  [B] registry == runtime : ${failB ? `FAIL (${missingForRuntime.length} assembled without a row)` : 'PASS'}`)
  for (const d of missingForRuntime) console.log(`      ! ${d} is assembled by the profile but has no CAPABILITY-MATRIX row`)

  console.log(`  [C] retirement queue (因 leading 决定=退役 且仍在装配) : ${retirementQueue.length}`)
  for (const d of retirementQueue) console.log(`      - ${d}   (still in bundles/patch rows -- execute the retirement step)`)
  if (pendingAssessment.length) {
    console.log(`  [D] pending assessment (决定=评估，未拍板) : ${pendingAssessment.length}`)
    for (const d of pendingAssessment) console.log(`      ? ${d}`)
  }

  console.log(`  [E] two registries agree : ${failE ? 'FAIL' : 'PASS'}  (INVENTORY.md rows=${invRows.size}, CAPABILITY-MATRIX local rows=${matrixLocal.size})`)
  for (const n of onlyInMatrix) console.log(`      ! ${n} is in CAPABILITY-MATRIX but has no INVENTORY.md row`)
  for (const n of onlyInInventory) console.log(`      ! ${n} is in INVENTORY.md but has no CAPABILITY-MATRIX row`)
  console.log(`\n  RESULT: ${ok ? 'PASS' : 'FAIL (registry drift)'}`)
}
process.exit(ok ? 0 : 1)
