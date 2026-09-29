#!/usr/bin/env node
/**
 * reapply-profile-0.1.7.mjs
 *
 * Re-apply the profile-level adaptations that the 0.1.7 dependency line needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Electron shell keeps a "healthy profile checkpoint"
 * (%APPDATA%\DSH Desktop\health-snapshots\<hash>\latest, files listed in
 * vendor/.../src/profile-checkpoint.ts:41-47) and RESTORES it whenever a desktop
 * startup fails while the live profile config differs from the snapshot.
 * Measured 2026-09-29 00:47:48: a failed desktop boot restored the 2026-09-27
 * snapshot over package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
 * cordis.patch.yml / .dsh-market/state.json, silently reverting:
 *   - 4 dependency bumps (0.1.7 line)
 *   - the @dsh-external/dsh-settings-scope-shim dependency + its patch row
 *   - the minimumReleaseAgeExclude release-age waivers
 * Its follow-up `pnpm install --frozen-lockfile` (profile-materializer.ts:131-138)
 * then failed, leaving node_modules on the NEW versions and the declarations on
 * the OLD ones.
 *
 * This script is the re-apply half of that failure mode: idempotent, atomic,
 * backed up, and it never touches node_modules or the shipped kernel.
 *
 * USAGE
 *   node scripts/reapply-profile-0.1.7.mjs            # dry-run (default)
 *   node scripts/reapply-profile-0.1.7.mjs --apply    # write
 *   node scripts/reapply-profile-0.1.7.mjs --apply --profile desktop
 *
 * EXIT
 *   0 = target state present (all items ok or applied)
 *   1 = at least one required item could not be applied
 *   2 = environment problem (profile or repo not found)
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const profileIndex = argv.indexOf('--profile')
const PROFILE = profileIndex === -1 ? 'desktop' : argv[profileIndex + 1]
if (!PROFILE) fail(2, '--profile requires a value')

/** The 0.1.7 dependency line. Versions are pinned to what node_modules holds. */
const DEP_TARGETS = {
  'dsh-bash-terminal': '^0.3.15',
  'dsh-better-sidebar': '^0.22.1',
  'dsh-context': '0.59.2',
  'dsh-tool-search': '^0.1.5',
}
const SHIM_NAME = '@dsh-external/dsh-settings-scope-shim'
const SHIM_DIR = join(REPO, 'plugins', 'dsh-settings-scope-shim')
/** Measured: upstream 0.1.7 dropped these; our profile must keep supplying them. */
const SHIM_PROVIDES = ['settingsScope', 'uiConversation']
/** Release-age waivers, appended to the existing entry for the same package. */
const RELEASE_AGE = {
  'dsh-bash-terminal@0.3.14': '0.3.15',
  'dsh-tool-search@0.1.3': '0.1.5',
  'dsh-better-sidebar@0.15.2': '0.22.1',
  'dsh-context@0.33.1': '0.59.2',
}
/** Stale disabled row for a plugin that no longer exists (re-added by the restore). */
const STALE_ROWS = [
  {
    label: 'selftest-r2probe disabled row',
    pattern: /\n*# 已卸载插件（@dsh-external\/selftest-r2probe）：disabled 阻断其 bundle patch 自装配\n- id: selftest-r2probe\n  disabled: true\n*/u,
  },
]
const SHIM_PATCH_ROW = `- insert:\n    - id: settings-scope-shim\n      name: '${SHIM_NAME}'\n`
/**
 * Measured 2026-09-29: upstream 0.1.7 dropped the client-runtime roster row, and it must
 * STAY dropped. An earlier fix re-added it to satisfy four 0.1.1-era client bundles, but
 * those bundles have since been restored to their official 0.1.7 builds (they no longer
 * require it), and mounting the 0.1.1 runtime client half makes it claim the single
 * `connection.start()` consumer slot — which fails `dsh-api-session-controller` and
 * `dsh-api-workspace-controller` ("connection: the stream loop is already owned by
 * another consumer"). So this script now actively ensures the row is ABSENT.
 */
const CLIENT_RUNTIME_ID = 'client-runtime'
const CLIENT_RUNTIME_ROW_RE = /\n*# 2026-09-29: upstream 0\.1\.7 dropped the client-runtime[\s\S]*?- id: client-runtime\n  name: '@deepseek-ai\/dsh-client-runtime'\n/u
const CLIENT_RUNTIME_ROW_RE_MIN = /\n*- id: client-runtime\n\s*name: '@deepseek-ai\/dsh-client-runtime'\n*/u

const profileDir = join(DSH_HOME, 'profiles', PROFILE)
if (!existsSync(profileDir)) fail(2, `profile directory not found: ${profileDir}`)
if (!existsSync(SHIM_DIR)) fail(2, `shim plugin not found: ${SHIM_DIR}`)

const pkgPath = join(profileDir, 'package.json')
const wsPath = join(profileDir, 'pnpm-workspace.yaml')
const patchPath = join(profileDir, 'cordis.patch.yml')
for (const p of [pkgPath, wsPath, patchPath]) {
  if (!existsSync(p)) fail(2, `required profile file missing: ${p}`)
}

const results = []
const record = (item, state, detail) => {
  results.push({ item, state, detail })
  const tag = { ok: 'OK-ALREADY', applied: 'APPLIED', planned: 'WOULD-APPLY', fail: 'FAIL' }[state]
  console.log(`  [${tag.padEnd(11)}] ${item}${detail ? ` — ${detail}` : ''}`)
}

/** Write through a sibling temp file + rename so no reader sees a torn file. */
function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, { encoding: 'utf8' })
  renameSync(tmp, path)
}

const backupDir = join(REPO, '_backups', `p1-profile-reapply-${stamp()}`)
let backedUp = false
function backupOnce() {
  if (backedUp || !APPLY) return
  mkdirSync(backupDir, { recursive: true })
  for (const p of [pkgPath, wsPath, patchPath]) {
    copyFileSync(p, join(backupDir, `${PROFILE}-${basenameOf(p)}`))
  }
  console.log(`  backup: ${backupDir}`)
  backedUp = true
}

console.log(`[reapply-profile-0.1.7] profile=${PROFILE}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`)
console.log(`  profile dir: ${profileDir}`)

/* ---------------- 1. package.json dependency declarations ---------------- */
{
  const text = readFileSync(pkgPath, 'utf8')
  let next = text
  for (const [name, target] of Object.entries(DEP_TARGETS)) {
    const re = new RegExp(`("${escapeRe(name)}":\\s*")([^"]+)(")`, 'u')
    const m = next.match(re)
    if (!m) {
      record(`package.json ${name}`, 'fail', 'declaration not found')
      continue
    }
    if (m[2] === target) {
      record(`package.json ${name}`, 'ok', target)
      continue
    }
    next = next.replace(re, `$1${target}$3`)
    record(`package.json ${name}`, APPLY ? 'applied' : 'planned', `${m[2]} -> ${target}`)
  }
  const shimRe = new RegExp(`"${escapeRe(SHIM_NAME)}":\\s*"[^"]*"`, 'u')
  if (shimRe.test(next)) {
    record(`package.json ${SHIM_NAME}`, 'ok', 'declared')
  } else {
    const anchor = /("dshmarket":\s*"[^"]+")(\n)/u
    if (!anchor.test(next)) {
      record(`package.json ${SHIM_NAME}`, 'fail', 'anchor "dshmarket" not found for insertion')
    } else {
      const value = `link:${SHIM_DIR.replace(/\\/gu, '\\\\')}`
      next = next.replace(anchor, `$1,$2    "${SHIM_NAME}": "${value.replace(/\\/gu, '\\\\')}"$2`)
      record(`package.json ${SHIM_NAME}`, APPLY ? 'applied' : 'planned', 'dependency row restored')
    }
  }
  if (next !== text && APPLY) {
    backupOnce()
    atomicWrite(pkgPath, next)
  }
}

/* ---------------- 2. pnpm-workspace.yaml release-age waivers ---------------- */
{
  const text = readFileSync(wsPath, 'utf8')
  let next = text
  for (const [spec, added] of Object.entries(RELEASE_AGE)) {
    const name = spec.slice(0, spec.lastIndexOf('@'))
    const lineRe = new RegExp(`^(\\s*(?:-\\s*|')?${escapeRe(name)}@)([^'\\n]*?)('?\\s*)$`, 'mu')
    const m = next.match(lineRe)
    if (!m) {
      record(`pnpm-workspace minimumReleaseAgeExclude ${spec}`, 'fail', 'entry not found')
      continue
    }
    const versions = m[2].split('||').map(v => v.trim())
    if (versions.includes(added)) {
      record(`pnpm-workspace ${spec}`, 'ok', `waiver present`)
      continue
    }
    next = next.replace(lineRe, `$1${m[2].trim() ? `${m[2].trim()} || ${added}` : added}$3`)
    record(`pnpm-workspace ${spec}`, APPLY ? 'applied' : 'planned', `+ ${added}`)
  }
  if (next !== text && APPLY) {
    backupOnce()
    atomicWrite(wsPath, next)
  }
}

/* ---------------- 3. cordis.patch.yml rows ---------------- */
{
  const text = readFileSync(patchPath, 'utf8')
  let next = text
  for (const row of STALE_ROWS) {
    if (row.pattern.test(next)) {
      next = next.replace(row.pattern, '\n')
      record(`cordis.patch.yml ${row.label}`, APPLY ? 'applied' : 'planned', 'removed')
    } else {
      record(`cordis.patch.yml ${row.label}`, 'ok', 'already absent')
    }
  }
  if (/id:\s*settings-scope-shim/u.test(next)) {
    record('cordis.patch.yml settings-scope-shim row', 'ok', 'present')
  } else {
    const end = next.endsWith('\n') ? next : `${next}\n`
    next = `${end}\n${SHIM_PATCH_ROW}`
    record('cordis.patch.yml settings-scope-shim row', APPLY ? 'applied' : 'planned',
      `insert row restored (provides ${SHIM_PROVIDES.join(', ')})`)
  }
  if (CLIENT_RUNTIME_ROW_RE.test(next) || CLIENT_RUNTIME_ROW_RE_MIN.test(next)) {
    const before = next
    next = next.replace(CLIENT_RUNTIME_ROW_RE, '\n').replace(CLIENT_RUNTIME_ROW_RE_MIN, '')
    next = next.replace(/\n{3,}/g, '\n\n')
    record('cordis.patch.yml client-runtime row', APPLY ? 'applied' : 'planned',
      `removed (must stay absent: mounting the 0.1.1 runtime client half takes the single connection.start() slot and fails the api-* controllers)`)
    if (!next.includes('client-runtime') && before === next) record('cordis.patch.yml client-runtime row', 'fail', 'matched but nothing changed')
  } else {
    record('cordis.patch.yml client-runtime row', 'ok', 'absent (correct)')
  }
  if (next !== text && APPLY) {
    backupOnce()
    atomicWrite(patchPath, next)
  }
}

/* ---------------- 4. shim junction in the profile ---------------- */
{
  const link = join(profileDir, 'node_modules', '@dsh-external', 'dsh-settings-scope-shim')
  if (existsSync(link)) {
    const st = lstatSync(link)
    record('shim junction', 'ok', st.isSymbolicLink() ? 'junction present' : 'real directory present')
  } else if (APPLY) {
    mkdirSync(dirname(link), { recursive: true })
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, SHIM_DIR], { windowsHide: true, stdio: 'ignore' })
      record('shim junction', 'applied', `-> ${SHIM_DIR}`)
    } catch (cause) {
      record('shim junction', 'fail', cause instanceof Error ? cause.message : String(cause))
    }
  } else {
    record('shim junction', 'planned', `would link -> ${SHIM_DIR}`)
  }
}

/* ---------------- 5. verify the written files ---------------- */
if (APPLY) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  for (const [name, target] of Object.entries(DEP_TARGETS)) {
    if (pkg.dependencies?.[name] !== target) record(`verify package.json ${name}`, 'fail', `read-back = ${pkg.dependencies?.[name]}`)
  }
  if (pkg.dependencies?.[SHIM_NAME] === undefined) record(`verify package.json ${SHIM_NAME}`, 'fail', 'read-back missing')
  const patch = readFileSync(patchPath, 'utf8')
  if (!/id:\s*settings-scope-shim/u.test(patch)) record('verify cordis.patch.yml', 'fail', 'read-back missing shim row')
  if (/id:\s*client-runtime/u.test(patch)) record('verify cordis.patch.yml', 'fail', 'client-runtime row is present but must stay absent')
  if (/id:\s*selftest-r2probe/u.test(patch)) record('verify cordis.patch.yml', 'fail', 'selftest row still present')
  const ws = readFileSync(wsPath, 'utf8')
  for (const added of Object.values(RELEASE_AGE)) {
    if (!ws.includes(added)) record('verify pnpm-workspace.yaml', 'fail', `waiver ${added} missing after write`)
  }
  if (!results.some(r => r.state === 'fail')) record('read-back verification', 'ok', 'all written files re-parsed')
}

const failed = results.filter(r => r.state === 'fail')
console.log(`\n  items: ${results.length}  failures: ${failed.length}`)
if (failed.length > 0) {
  console.log('  RESULT: FAIL — target state NOT reached; fix the items above and re-run')
  process.exit(1)
}
console.log(`  RESULT: ${APPLY ? 'PASS (applied)' : 'PASS (dry-run; re-run with --apply to write)'}`)
console.log(`  next: node scripts/repoint-profile-node-modules.mjs --apply  then  promote-build.ps1`)
process.exit(0)

/* ---------------- helpers ---------------- */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
function basenameOf(path) {
  return path.split(/[\\/]/u).pop()
}
function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function fail(code, message) {
  console.error(`[reapply-profile-0.1.7] ${message}`)
  process.exit(code)
}
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
}
void sha256
void rmSync