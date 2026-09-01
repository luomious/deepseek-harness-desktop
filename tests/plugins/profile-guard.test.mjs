// tests/plugins/profile-guard.test.mjs — profile-guard close-time check regression tests
//
// Locks the semantics of the close/quit "配置自检" (scripts/apply-profile-guard.mjs):
//   A. injected detection logic (dangling link:/file:, node_modules-copy tolerance,
//      clean profiles, multi-profile scan, template drift)
//   B. startup-verify --repair safety (must NOT remove resolvable kernel bundles —
//      the 2026-09-02 near-miss regression — and must remove truly dangling refs
//      with backups)
//   C. patch registration (current build markers + built-injected text identical
//      to the canonical PROFILE_GUARD_SOURCE + verify-patches.ps1 items)
//
// Run: node --test tests/plugins/profile-guard.test.mjs
// All fixtures live under os.tmpdir() — the real profile is never touched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PROFILE_GUARD_SOURCE } from '../../scripts/apply-profile-guard.mjs'
import { resolveCurrentBuild } from '../../scripts/resolve-dist.mjs'

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtures = []

/** Create a disposable home dir hosting .dsh/profiles/<name>. */
function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'profile-guard-'))
  fixtures.push(root)
  return root
}

/** Write one profile manifest under <home>/.dsh/profiles/<name>. */
function writeProfile(home, name, { bundles = [], deps = {} } = {}) {
  const dir = join(home, '.dsh', 'profiles', name)
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const pkg = { name: `dsh-profile-${name}`, dependencies: deps, dsh: { profile: { bundles } } }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return dir
}

/** Run the injected dshCheckProfileIntegrity() against a fixture home dir. */
function runInjected(home) {
  const prev = process.env.USERPROFILE
  try {
    process.env.USERPROFILE = home
    // eslint-disable-next-line no-new-func
    return new Function(PROFILE_GUARD_SOURCE + '; return dshCheckProfileIntegrity();')()
  } finally {
    if (prev === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prev
  }
}

/** Run scripts/startup-verify.mjs --repair against a fixture (env-isolated). */
function runRepair(fixtureRoot) {
  const script = join(workspaceRoot, 'scripts', 'startup-verify.mjs')
  try {
    execFileSync(process.execPath, [script, '--repair'], {
      env: {
        ...process.env,
        DSH_PROFILES_ROOT: join(fixtureRoot, 'profiles'),
        DSH_REPO: fixtureRoot,
        DSH_PROFILE: 'desktop',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return { stdout: '', code: 0 }
  } catch (cause) {
    // V-checks legitimately fail on fixtures (dist junction etc.) — the exit
    // code is not the assertion target; the [repair] output is.
    return { stdout: String(cause.stdout || ''), stderr: String(cause.stderr || ''), code: cause.status }
  }
}

function readProfileJson(home, name) {
  return JSON.parse(readFileSync(join(home, '.dsh', 'profiles', name, 'package.json'), 'utf8'))
}

after(() => {
  for (const root of fixtures) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* temp cleanup best-effort */ }
  }
})

// ---------------------------------------------------------------------------
// A. injected detection semantics
// ---------------------------------------------------------------------------

test('A1 dangling link: is reported', () => {
  const home = makeHome()
  const target = join(home, 'missing-a')
  writeProfile(home, 'desktop', { bundles: ['@dsh-external/a'], deps: { '@dsh-external/a': 'link:' + target } })
  const r = runInjected(home)
  assert.equal(r.ok, false)
  assert.equal(r.skipped, false)
  assert.ok(r.missing.some((m) => m.includes('@dsh-external/a') && m.includes('missing-a')))
})

test('A2 dangling file: (absolute) is reported', () => {
  const home = makeHome()
  const target = join(home, 'missing-b')
  writeProfile(home, 'desktop', { bundles: ['@dsh-external/b'], deps: { '@dsh-external/b': 'file:' + target } })
  const r = runInjected(home)
  assert.equal(r.ok, false)
  assert.ok(r.missing.some((m) => m.includes('@dsh-external/b')))
})

test('A3 node_modules copy tolerates stale declared path (maid-atelier form)', () => {
  const home = makeHome()
  const profileDir = join(home, '.dsh', 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules', '@dsh-external', 'skin'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', '@dsh-external', 'skin', 'package.json'), '{"name":"@dsh-external/skin"}')
  writeProfile(home, 'desktop', {
    bundles: ['@dsh-external/skin'],
    deps: { '@dsh-external/skin': 'file:' + join(home, 'gone-source', 'maid-atelier') },
  })
  const r = runInjected(home)
  assert.equal(r.ok, true, `must not false-positive: ${JSON.stringify(r.missing)}`)
  assert.equal(r.missing.length, 0)
})

test('A4 clean profile (existing link target) passes', () => {
  const home = makeHome()
  const target = join(home, 'real-plugin')
  mkdirSync(target, { recursive: true })
  writeProfile(home, 'desktop', { bundles: ['@dsh-external/c'], deps: { '@dsh-external/c': 'link:' + target } })
  const r = runInjected(home)
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
})

test('A5 every profile with bundles is scanned (checked counts)', () => {
  const home = makeHome()
  writeProfile(home, 'desktop', { bundles: ['@dsh-external/ok'], deps: { '@dsh-external/ok': 'link:' + join(home, 'p1') } })
  mkdirSync(join(home, 'p1'), { recursive: true })
  writeProfile(home, 'web', { bundles: ['@dsh-external/web-bad'], deps: { '@dsh-external/web-bad': 'link:' + join(home, 'nope') } })
  const r = runInjected(home)
  assert.equal(r.checked, 2)
  assert.equal(r.ok, false)
  assert.ok(r.missing.some((m) => m.includes('web-bad')))
})

test('A6 template drift reported (informational), ok driven by missing only', () => {
  const home = makeHome()
  const pluginDir = join(home, 'plugins', 'dsh-x')
  mkdirSync(pluginDir, { recursive: true })
  writeProfile(home, 'desktop', {
    bundles: ['@dsh-external/x', '@dsh-external/y'],
    deps: {
      '@dsh-external/x': 'link:' + pluginDir, // derives repoRoot = home
      '@dsh-external/y': 'link:' + join(home, 'real-y'),
    },
  })
  mkdirSync(join(home, 'real-y'), { recursive: true })
  mkdirSync(join(home, 'profile', 'desktop'), { recursive: true })
  writeFileSync(join(home, 'profile', 'desktop', 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@dsh-external/z'] } } }))
  const r = runInjected(home)
  assert.equal(r.ok, true, `drift alone must not fail the check: ${JSON.stringify(r.missing)}`)
  assert.equal(r.templateDrift.length, 3) // z template-only, x runtime-only, y runtime-only
})

// ---------------------------------------------------------------------------
// B. startup-verify --repair safety
// ---------------------------------------------------------------------------

test('B1 repair keeps resolvable kernel bundle, removes truly dangling ref (with backup)', () => {
  const root = makeHome()
  // Ancestor node_modules -> require.resolve resolves @deepseek-ai/dsh-base.
  // NOTE: require.resolve needs a resolvable entry (index.js), a bare
  // package.json without main/index.js would FAIL resolution — exactly the
  // near-miss class this test guards against.
  mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), '{"name":"@deepseek-ai/dsh-base"}')
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-base', 'index.js'), 'export {}')
  const profilesDir = join(root, 'profiles', 'desktop')
  mkdirSync(join(profilesDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profilesDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { '@dsh-external/zz-dangling': 'link:' + join(root, 'no-such-dir') },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-external/zz-dangling'] } },
  }, null, 2))

  const { stdout } = runRepair(root)

  assert.ok(stdout.includes('[repair] R1 removed dangling bundle refs: @dsh-external/zz-dangling'), `stdout: ${stdout}`)
  const repaired = JSON.parse(readFileSync(join(profilesDir, 'package.json'), 'utf8'))
  assert.deepEqual(repaired.dsh.profile.bundles, ['@deepseek-ai/dsh-base'], 'resolvable kernel bundle must survive repair')
  assert.equal('@dsh-external/zz-dangling' in repaired.dependencies, false)
  // Backup created next to the manifest (and under fixture _backups).
  const backups = readdirSync(profilesDir).filter((f) => f.startsWith('package.json.bak-repair-'))
  assert.ok(backups.length >= 1, 'repair backup missing')
  assert.ok(existsSync(join(root, '_backups')), 'repo backup copy missing')
})

test('B2 repair on a clean fixture touches nothing', () => {
  const root = makeHome()
  const profilesDir = join(root, 'profiles', 'desktop')
  mkdirSync(join(profilesDir, 'node_modules'), { recursive: true })
  const realDir = join(root, 'real')
  mkdirSync(realDir, { recursive: true })
  const original = JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { '@dsh-external/ok': 'link:' + realDir },
    dsh: { profile: { bundles: ['@dsh-external/ok'] } },
  }, null, 2)
  writeFileSync(join(profilesDir, 'package.json'), original)

  const { stdout } = runRepair(root)
  assert.ok(stdout.includes('[repair] nothing to repair'), `stdout: ${stdout}`)
  assert.equal(readFileSync(join(profilesDir, 'package.json'), 'utf8'), original)
})

// ---------------------------------------------------------------------------
// C. patch registration against the current build
// ---------------------------------------------------------------------------

test('C1 current build carries the guard markers', () => {
  const build = resolveCurrentBuild()
  const libDir = build.lib
  const main = readFileSync(join(libDir, 'main.js'), 'utf8')
  assert.ok(main.includes('dshCheckProfileIntegrity'), 'main.js quit-guard marker missing')
  const chunkName = readdirSync(libDir).find((n) => n.startsWith('electron-runtime-') && n.endsWith('.js'))
  assert.ok(chunkName, 'electron-runtime chunk not found')
  const chunk = readFileSync(join(libDir, chunkName), 'utf8')
  assert.ok(chunk.includes('dshCheckProfileIntegrity'), 'close-dialog marker missing')
  assert.ok(chunk.includes('dshProfileLabel(profileIntegrity)'), 'summary wiring missing')
})

test('C2 built-injected text is identical to canonical PROFILE_GUARD_SOURCE', () => {
  const build = resolveCurrentBuild()
  const libDir = build.lib
  const chunkName = readdirSync(libDir).find((n) => n.startsWith('electron-runtime-') && n.endsWith('.js'))
  const chunk = readFileSync(join(libDir, chunkName), 'utf8')
  const start = chunk.indexOf('/* dsh patch profile-guard v1')
  assert.ok(start >= 0, 'marker comment not found in chunk')
  const end = chunk.indexOf('\n\t\tconst close = (event) => {', start)
  assert.ok(end > start, 'injected text terminator not found')
  const injected = chunk.slice(start, end)
  assert.equal(injected, PROFILE_GUARD_SOURCE)
})

test('C3 verify-patches.ps1 registers both profile-guard checks', () => {
  const ps1 = readFileSync(join(workspaceRoot, 'scripts', 'verify-patches.ps1'), 'utf8')
  assert.ok(ps1.includes("profile-guard quit guard (lib/main)"), 'quit-guard check item missing')
  assert.ok(ps1.includes('profile-guard close dialog (electron-runtime)'), 'close-dialog check item missing')
})

test('C4 canonical injected source parses', () => {
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(PROFILE_GUARD_SOURCE))
})
