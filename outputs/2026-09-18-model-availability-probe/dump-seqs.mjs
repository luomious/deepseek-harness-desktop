#!/usr/bin/env node
// 打印指定 seq 事件的完整内容（不 omit），用于查看工具结果原文。
// 用法: node dump-seqs.mjs <file.zstd> <seq,seq,...> [--maxChars 900]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const want = new Set(String(process.argv[3] || '').split(',').map((s) => Number(s.trim())).filter(Boolean))
const i = process.argv.indexOf('--maxChars')
const maxChars = i >= 0 ? Number(process.argv[i + 1]) : 900

const buf = readFileSync(file)
const offs = []
for (let k = 0; k + 4 <= buf.length; k++) {
  if (buf[k] === 0x28 && buf[k + 1] === 0xb5 && buf[k + 2] === 0x2f && buf[k + 3] === 0xfd) offs.push(k)
}
let t = ''
for (let k = 0; k < offs.length; k++) {
  const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : buf.length
  try { t += zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { /* skip */ }
}
for (const line of t.split('\n')) {
  if (!line.trim()) continue
  let j = null
  try { j = JSON.parse(line) } catch { continue }
  if (!want.has(j.seq)) continue
  const raw = JSON.stringify(j.data)
  console.log(`\n=== seq ${j.seq}  type=${j.type}  len=${raw.length}`)
  console.log(raw.slice(0, maxChars))
}
