#!/usr/bin/env node
// DSH 会话文件是多帧拼接 zstd（Node 的流式解码只输出第一帧），这里按帧魔数切开逐帧解。
// 用法: node zstd-frames.mjs <file.zstd> [--grep <regex>] [--max <n>]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const grepRe = arg('grep', '')
const maxLines = Number(arg('max', 40))

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}

let out = ''
let okFrames = 0, badFrames = 0
for (let k = 0; k < offsets.length; k++) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try {
    out += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    okFrames++
  } catch { badFrames++ }
}

const text = out
console.log(`file=${file}`)
console.log(`bytes=${buf.length} magicHits=${offsets.length} okFrames=${okFrames} badFrames=${badFrames} textBytes=${text.length}`)

const providerCounts = {}
const modelCounts = {}
for (const m of text.matchAll(/"provider"\s*:\s*"([^"]+)"/g)) providerCounts[m[1]] = (providerCounts[m[1]] || 0) + 1
for (const m of text.matchAll(/"model"\s*:\s*"([^"]+)"/g)) modelCounts[m[1]] = (modelCounts[m[1]] || 0) + 1
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
console.log('providers:', JSON.stringify(top(providerCounts, 12)))
console.log('models   :', JSON.stringify(top(modelCounts, 12)))

if (grepRe) {
  const re = new RegExp(grepRe)
  const lines = text.split('\n').filter((l) => re.test(l))
  console.log(`grep /${grepRe}/ -> ${lines.length} lines (showing ${Math.min(maxLines, lines.length)})`)
  for (const l of lines.slice(0, maxLines)) console.log('  ' + l.slice(0, 400))
}
