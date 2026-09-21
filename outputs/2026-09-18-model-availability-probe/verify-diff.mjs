#!/usr/bin/env node
// 逐行严格比对 before/after，证明只改了预期的行（并报告行尾风格）。
// 用法: node verify-diff.mjs <before> <after>
import { readFileSync } from 'node:fs'
const [b, a] = process.argv.slice(2)
const B = readFileSync(b, 'utf8')
const A = readFileSync(a, 'utf8')
const eolOf = (s) => ({ crlf: (s.match(/\r\n/g) || []).length, lfOnly: (s.match(/(?<!\r)\n/g) || []).length })
console.log('before bytes=' + Buffer.byteLength(B) + ' eol=' + JSON.stringify(eolOf(B)))
console.log('after  bytes=' + Buffer.byteLength(A) + ' eol=' + JSON.stringify(eolOf(A)))
const bl = B.split(/\r?\n/)
const al = A.split(/\r?\n/)
// 简单 LCS 太贵，用索引对齐：两者长度差 3，逐段找到第一处不同与最后一处不同
let pre = 0
while (pre < bl.length && pre < al.length && bl[pre] === al[pre]) pre++
let suf = 0
while (suf < bl.length - pre && suf < al.length - pre && bl[bl.length - 1 - suf] === al[al.length - 1 - suf]) suf++
console.log(`lines before=${bl.length} after=${al.length}`)
console.log(`common prefix=${pre} lines, common suffix=${suf} lines`)
console.log('--- removed (before[pre .. len-suf]) ---')
for (const l of bl.slice(pre, bl.length - suf)) console.log('  - ' + JSON.stringify(l))
console.log('--- added (after[pre .. len-suf]) ---')
for (const l of al.slice(pre, al.length - suf)) console.log('  + ' + JSON.stringify(l))
