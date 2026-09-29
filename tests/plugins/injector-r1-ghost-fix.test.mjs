// R1 ghost-entry fix — differential + fault-injection test.
//
// What it proves:
//   A. The SHIPPED bundle text really carries the new decision predicate (both sites).
//   B. FAULT INJECTION on the shipped predicate: evaluate the decision table for all six
//      fiber states, extracted from the bundle text and run via new Function.
//   C. REVERSE CONTROL: the previous bundle (backup) FAILS the same table for `loading`,
//      which is exactly the boot-time state that produced the ghost.
//   D. The ghost mechanism itself is reproduced from the loader's own source, showing that
//      omitting `id` yields a fresh Math.random() 8-hex id while supplying it is stable.
//   E. Regression guards for the round 3-5 fixes are still present.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const R = 'D:\\Deepseek-Harness'
const NEW = path.join(R, 'plugins', 'dsh-routing-suite', 'injector', 'lib', 'index.js')
const OLD = path.join(R, '_backups', 'injector-r1-fix-20260927', 'lib-index.js.orig')

let pass = 0, fail = 0
const results = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; results.push('PASS  ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; results.push('FAIL  ' + name + (extra ? '  ' + extra : '')) }
}
function table(src = NEW) {
  try {
    const text = readFileSync(src, 'utf8')
    // Extract the actual predicate lines emitted into the bundle, per site.
    const re = /if \(st === ([^)]*)\) (return true|continue);/g
    const found = []
    let m
    while ((m = re.exec(text)) !== null) found.push({ cond: m[1], action: m[2] })
    const STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']
    const out = []
    for (const f of found) {
      const fn = new Function('st', `return (st === ${f.cond});`)
      const row = {}
      for (const s of STATES) row[s] = fn(s)
      out.push({ action: f.action, row })
    }
    return { text, found: out }
  } catch (e) {
    console.log('ERROR ' + e.message)
    process.exit(2)
  }
}

const nw = table(NEW)
const sar = (src) => table(src)

console.log('=== A. shipped bundle carries the new predicate at BOTH sites ===')
const spares = nw.found.filter((f) => f.action === 'continue')
const lives = nw.found.filter((f) => f.action === 'return true')
ok('cleanupStaleEntries predicate present (action=continue)', spares.length === 1, 'found=' + spares.length)
ok('hasLiveEntry predicate present (action=return true)', lives.length === 1, 'found=' + lives.length)

console.log('=== B. FAULT INJECTION: decision table on the shipped predicate ===')
const WANT_SPARE = { pending: true, loading: true, active: true, failed: false, disposed: false, unloading: false }
const WANT_LIVE = { pending: true, loading: true, active: true, failed: false, disposed: false, unloading: false }
for (const f of nw.found) {
  const want = f.action === 'continue' ? WANT_SPARE : WANT_LIVE
  const bad = Object.keys(want).filter((s) => f.row[s] !== want[s])
  ok('table[' + f.action + '] matches spec for all 6 states', bad.length === 0, bad.length ? 'mismatch: ' + bad.join(',') : '')
  ok('table[' + f.action + '] spares LOADING (the boot-time ghost trigger)', f.row.loading === true)
}

console.log('=== C. REVERSE CONTROL: previous bundle must FAIL the loading row ===')
if (!existsSync(OLD)) {
  ok('old bundle backup available', false, OLD)
} else {
  const od = sar(OLD)
  const oldSpare = od.found.filter((f) => f.action === 'continue')
  ok('old bundle had exactly one such predicate', oldSpare.length === 1, 'found=' + oldSpare.length)
  if (oldSpare.length === 1) {
    ok('old predicate REJECTS the spec for loading (proves behavior changed)', oldSpare[0].row.loading === false, 'old.loading=' + oldSpare[0].row.loading)
  }
  ok('old bundle lacks hasLiveEntry', !od.text.includes('hasLiveEntry'))
  ok('old bundle lacks explicit id at create sites', !/id: pkgName,/.test(od.text))
}

console.log('=== D. ghost mechanism reproduced from the loader source semantics ===')
// loader lib/index.js: ensureId(options) { if (!options.id) do options.id =
//   Math.random().toString(16).slice(2, 10); while (this.store[options.id]); return options.id }
function ensureId(options, store) {
  if (!options.id) do options.id = Math.random().toString(16).slice(2, 10)
  while (store[options.id])
  return options.id
}
const s1 = {}, s2 = {}
const a = ensureId({ name: 'p' }, s1); s1[a] = 1
const b = ensureId({ name: 'p' }, s2); s2[b] = 1
ok('omitting id yields an 8-hex id', /^[0-9a-f]{8}$/.test(a), 'sample=' + a)
ok('omitting id yields a DIFFERENT id next boot (the observed ghost)', a !== b, a + ' vs ' + b)
const s3 = {}
const c = ensureId({ id: 'pkg', name: 'p' }, s3); s3[c] = 1
const d = ensureId({ id: 'pkg', name: 'p' }, s3)
ok('supplying id is STABLE across repeated creates', c === d && c === 'pkg', c + ' vs ' + d)
ok('shipped bundle supplies id at all 3 create sites', (nw.text.match(/id: pkgName,|id: name,/g) || []).length === 3, 'count=' + (nw.text.match(/id: pkgName,|id: name,/g) || []).length)

console.log('=== E. regression guards (round 3-5 fixes still present) ===')
for (const [label, needle] of [
  ['P0-2 recordOp reason on create failure', 'recordOp("inject", false, `loader.create 失败:'],
  ['P0-3 selfHeal ok-semantics', 'opStats.selfHeal.ok += 1'],
  // NOTE: rolldown normalizes string literals to double quotes, so quote-sensitive
  // source needles give FALSE NEGATIVES on the bundle. Use quote-free needles only.
  ['P0-4 dedupe safety gate (canonical keep)', '保留生成式条目会移除 loader 树里的正版条目'],
  ['P0-4 safety gate predicate', 'keep.includes('],
  ['dedupe 3-condition report', '发现 ${dups.length} 组**真重复** entry'],
  ['arbitrateOfficial still present', 'arbitrateOfficial'],
  ['idempotent inject guard still present', '跳过注入'],
]) ok('kept: ' + label, nw.text.includes(needle))

console.log('\n' + results.join('\n'))
console.log('\nR1_FIX_RESULT=' + (fail === 0 ? 'PASS' : 'FAIL') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
