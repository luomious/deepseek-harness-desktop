#!/usr/bin/env node
// 变异测试（故障注入）：故意拿掉 claimInspection 开关门控，验证测试会**失败**。
// 「测试通过」≠「测试有判别力」——必须看到它在被弄坏时变红。
// 用法: node mutation-test-inspection.mjs
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const LIB = 'D:/Deepseek-Harness/plugins/dsh-model-provider-failover/lib/index.js'
const TEST = 'D:/Deepseek-Harness/plugins/dsh-model-provider-failover/test/integration.test.mjs'
const BAK = LIB.replace(/\.js$/, '.mutbak.js')

const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

const FIND = '      const inspection = c.claimInspection === true && isInspectionFailure(failure)\n'
const MUTANT = '      const inspection = isInspectionFailure(failure)\n'

const original = readFileSync(LIB, 'utf8')
const h0 = hash(LIB)
if (original.split(FIND).length - 1 !== 1) {
  console.error('ABORT: mutation anchor not unique')
  process.exit(1)
}

function runTest() {
  try {
    execFileSync(process.execPath, [TEST], { stdio: 'pipe' })
    return { ok: true, out: 'PASS' }
  } catch (e) {
    const out = `${(e.stdout || '').toString()}\n${(e.stderr || '').toString()}`.trim()
    return { ok: false, out }
  }
}

let failed = false
try {
  console.log('1) 基线（未变异）：')
  const base = runTest()
  console.log(`   -> ${base.ok ? 'PASS ✓' : 'FAIL ✗'}`)
  if (!base.ok) { console.error(base.out); failed = true }

  console.log('2) 注入变异（拿掉 claimInspection 门控）：')
  copyFileSync(LIB, BAK)
  writeFileSync(LIB, original.replace(FIND, MUTANT), 'utf8')
  const mut = runTest()
  console.log(`   -> ${mut.ok ? 'PASS ✗（测试没判别力！）' : 'FAIL ✓（被捕获，符合预期）'}`)
  if (mut.ok) failed = true
  else console.log('   捕获到的断言：' + (mut.out.split('\n').filter((l) => /AssertionError|must|zero regression/.test(l)).slice(0, 2).join(' | ').slice(0, 300)))
} finally {
  // 无论成败都必须恢复，并校验哈希
  copyFileSync(BAK, LIB)
  try { unlinkSync(BAK) } catch { /* ignore */ }
  const h1 = hash(LIB)
  console.log(`3) 恢复：sha256 ${h1 === h0 ? 'MATCH ✓' : 'MISMATCH ✗'}`)
  if (h1 !== h0) failed = true
  const after = runTest()
  console.log(`4) 恢复后复测：${after.ok ? 'PASS ✓' : 'FAIL ✗'}`)
  if (!after.ok) failed = true
}

console.log(failed ? '\nMUTATION TEST: 有问题（见上）' : '\nMUTATION TEST: OK（测试有判别力 + 已完整恢复）')
process.exit(failed ? 1 : 0)
