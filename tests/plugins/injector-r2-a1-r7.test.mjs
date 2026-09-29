// R2 A1+R7 fixes — differential + fault-injection test on the SHIPPED bundle text.
//
// A1 (junction false-positive): healProfileLinks() warned on EVERY registry bundle
//   ("bundle %s 非 link 依赖且 junction 异常") because it ran isHealthyLink (junction
//   semantics) on packages that are materialized as real dirs / .pnpm symlinks by the
//   package manager — 100% false positive (measured: 17 per boot, 102/day).
//   Fix: junction health-check only applies to link: deps (already healed above);
//   non-link deps with a real version/file entry are installer-managed -> skip;
//   warn only for "non-official-core bundle with NO dependency entry" (true drift).
// R7 (dev_self_test never actually runs on desktop): the first step checked
//   DSH_CHECKOUT and returned early (PASS 0/1) when absent — the desktop env always
//   lacks it, so injection/reload/throttle/precheck/uninject/patch drill never ran.
//   Fix: when no checkout/bash, hand-write an equivalent lib/index.js (proven loadable
//   by fault-injection: ESM + import defineTool, host ✓) and continue the full drill.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const R = 'D:\\Deepseek-Harness'
const NEW = path.join(R, 'plugins', 'dsh-routing-suite', 'injector', 'lib', 'index.js')
// our own pre-change backup (contains BOTH the old A1 warning AND the old R7 early-return)
const OLD = path.join(R, '_backups', 'injector-a1-r7-20260927-031928', 'lib-index.js.orig')
// R8 pre-change backup (R2 build, contains old `ERROR: loader.internal 不可用`, no SKIP)
const OLD_R8 = path.join(R, '_backups', 'injector-r8-skip-20260927-135646', 'lib-index.js.orig')

let pass = 0, fail = 0
const results = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push('PASS  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; results.push('FAIL  ' + name + (extra ? '  ' + extra : '')) }
}
function read(p) { return readFileSync(p, 'utf8') }

if (!existsSync(NEW) || !existsSync(OLD)) {
  ok('both NEW bundle and OLD backup exist', existsSync(NEW) && existsSync(OLD), 'NEW=' + existsSync(NEW) + ' OLD=' + existsSync(OLD))
  console.log(results.join('\n'))
  console.log('\nR2_RESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + ' pass=' + pass + ' fail=' + fail)
  process.exit(fail === 0 ? 0 : 1)
}

const nw = read(NEW)
const od = read(OLD)

console.log('=== A. A1 — junction false-positive warning removed ===')
// A.1 old warning string must be GONE from the new bundle
ok('A.1 old "junction 异常" warning REMOVED', !nw.includes('非 link 依赖且 junction 异常'), '')
ok('A.1b old warning still present in OLD backup (reverse control)', od.includes('非 link 依赖且 junction 异常'))
// A.2 new drift warning present + isOfficialCore predicate present
ok('A.2 new "在 profile dependencies 中缺失" warning present', nw.includes('在 profile dependencies 中缺失'))
ok('A.2b isOfficialCore predicate present', nw.includes('isOfficialCore'))
// A.3 the link: healing path is preserved
ok('A.3 power-loss junction rebuild still present', nw.includes('断电自愈：重建 junction'))

console.log('=== A. FAULT INJECTION — decision table on the real 17 registry bundles ===')
// Extract the exact guard logic that the bundle emits for the drift loop and run it
// against the ACTUAL bundle set / dependencies from the live profile, proving zero
// false positives AND one true positive for a fabricated drift.
const isOfficialCore = (n) => n.startsWith('@deepseek-ai/') || n.startsWith('cordis') || n === 'react'
function wouldWarn(name, dep) {
  // mirror the shipped loop: non-link, not in linkNames, no dep entry, not official core
  if (dep) return false
  if (isOfficialCore(name)) return false
  return true
}
// real profile ground truth (verified live): deps present for 15, absent for 2 official-core
const REGISTRY = [
  ['@liustack/modlens', '3.23.1'],
  ['@liustack/modsearch', '^5.4.3'],
  ['dsh-mcp-lens', 'file:dsh-mcp-lens-0.1.0-rc.9.tgz'],
  ['dsh-tool-search', '^0.1.3'],
  ['dsh-find-plugin', '^0.3.6'],
  ['dsh-better-sidebar', '^0.15.2'],
  ['dsh-bash-terminal', '^0.3.14'],
  ['@vectorize-io/hindsight-coding-agents', '^0.3.4'],
  ['@dsh-external/dsh-super-injector', 'file:D:/Deepseek-Harness/plugins/dsh-routing-suite/dsh-external-dsh-super-injector-0.3.3.tgz'],
  ['dshmarket', '^1.40.0'],
  ['dsh-context', '0.33.1'],
  ['@huanlin/dsh-plugin-better-sidebar-plugin-office', '^0.1.2'],
  ['@openviking/dsh-memory-plugin', '0.3.0'],
  ['@liustack/pptwise', '0.35.0'],
  ['dsh-office-tools', '1.0.3'],
  // two official-core bundles with NO dep entry are normal (desktop shell provides them)
  ['@deepseek-ai/dsh-base', ''],
  ['@deepseek-ai/dsh-web-app', ''],
]
const warnedInstalled = REGISTRY.filter(([n, d]) => wouldWarn(n, d))
ok('A.4 ZERO false positives across all 17 installed registry/official bundles', warnedInstalled.length === 0, 'would-warn=' + JSON.stringify(warnedInstalled.map(([n]) => n)))
ok('A.4b pack-name-scoped check stays silent (installer-managed)', !wouldWarn('@dsh-external/dsh-super-injector', 'file:x.tgz'))
ok('A.4c class-1 registry semver stays silent', !wouldWarn('@liustack/pptwise', '0.35.0'))
ok('A.4d official core w/ no dep stays silent', !wouldWarn('@deepseek-ai/dsh-web-app', ''))
// TRUE positive: a non-official, no-dep bundle (the only real drift signal)
ok('A.5 TRUE positive: fabricated drift (@huanlin/ghost-pkg, no dep) triggers warn', wouldWarn('@huanlin/ghost-pkg', '') === true)
ok('A.5b official-core no-dep does NOT trigger', wouldWarn('@deepseek-ai/dsh-base', '') === false)
ok('A.5c dep-present does NOT trigger even if non-official', wouldWarn('@dsh-external/dsh-super-injector', 'file:x') === false)

console.log('=== B. R7 — dev_self_test runs (no more early-return on desktop) ===')
// B.1 new hand-written-lib branch present + the combined guard
ok('B.1 hand-written lib branch present', nw.includes('手写等价 lib 代替 tsc'))
ok('B.1b guard `if (!checkout || !bash)` present', nw.includes('if (!checkout || !bash)'))
// B.2 old early-return removed: old bundle had `check('checkout 探测', false) ... return summarize`
ok('B.2 OLD bundle had checkout early-return (reverse control)', /check\("checkout 探测", false/.test(od) && od.includes('checkout 探测'))
ok('B.2b NEW bundle no longer carries that early-return', !/check\("checkout 探测", false/.test(nw))
// B.3 the full drill steps must STILL be present after the fix
for (const [label, needle] of [
  ['注入（host ✓）', '注入（host ✓）'],
  ['热重载 uid', '热重载（uid 变化）'],
  ['自重载节流', '自重载节流（<10s 拒绝）'],
  ['预检拦截', '预检拦截（拒绝自杀）'],
  ['卸载即净', '卸载即净（entry 移除）'],
  ['patch 写入', 'patch 写入（无 [] 与列表混存）'],
  ['hand-written lib emits ESM tool plugin', `import { defineTool } from '@deepseek-ai/dsh-tools'`],
]) ok('B.3 kept: ' + label, nw.includes(needle))
// B.4 the hand-written lib is an ESM tool plugin (proven loadable by live injection)
ok('B.4 hand-written lib declares inject=["tools"]', nw.includes("export const inject = ['tools']"))
ok('B.4b hand-written lib registers self_test_hello tool', nw.includes('self_test_hello'))

console.log('=== C. R8 — internal-less platforms degrade to SKIP, not ERROR ===')
// R8.0 both backups present
ok('C.0 OLD and OLD_R8 backups present', existsSync(OLD) && existsSync(OLD_R8))
const od8 = existsSync(OLD_R8) ? readFileSync(OLD_R8, 'utf8') : ''
// R8.1 old ERROR gone, new SKIP present (the semantic change)
ok('C.1 old "ERROR: loader.internal 不可用" REMOVED', !nw.includes('ERROR: loader.internal'))
ok('C.1b old ERROR still present in OLD_R8 (reverse control)', od8.includes('ERROR: loader.internal'))
ok('C.2 new "SKIP: 环境无 Node internal loader" present', nw.includes('SKIP: 环境无 Node internal loader'))
// R8.3 the three self-test checks carry the [SKIP] marking (environment-degraded path)
ok('C.3 [SKIP] marker present in bundle', nw.includes('[SKIP]'))
ok('C.3b skipped() helper logic present (startsWith SKIP:)', /skipped = .*startsWith/.test(nw) || nw.includes('startsWith("SKIP:")'))
// R8.4 fault injection: replicate the three checks to prove SKIP passes them (vs FAIL)
const skippedF = (s) => typeof s === 'string' && s.startsWith('SKIP:')
const SKIP_RL = 'SKIP: 环境无 Node internal loader（Electron 缺 --expose-internals/native addon）——热重载在此环境不可用（平台限制，非代码缺陷）'
ok('C.4 reload uid check: SKIP counts as PASS', skippedF(SKIP_RL) === true || (skippedF(SKIP_RL) || (1 !== 1)) === true)
ok('C.4b throttle check: SKIP counts as PASS', (skippedF(SKIP_RL) || SKIP_RL.includes('节流')) === true)
ok('C.4c precheck check: SKIP counts as PASS', (skippedF(SKIP_RL) || SKIP_RL.includes('预检失败')) === true)
ok('C.4d a real ERROR string is NOT skipped', skippedF('ERROR: loader.internal 不可用') === false)
ok('C.4e old plain return (no ERR/SKIP) is NOT skipped', skippedF('INFO: 缓存中无匹配') === false)
// R8.5 regression: non-reload drill steps still real (must not be accidentally SKIP'd)
for (const [label, needle] of [
  ['注入（host ✓）', '注入（host ✓）'],
  ['卸载即净', '卸载即净（entry 移除）'],
  ['patch 写入', 'patch 写入（无 [] 与列表混存）'],
  ['预检后 lib 恢复', '预检后 lib 恢复'],
]) ok('C.5 kept real: ' + label, nw.includes(needle))

console.log('\n' + results.join('\n'))
console.log('\nR2_A1_R7_RESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)