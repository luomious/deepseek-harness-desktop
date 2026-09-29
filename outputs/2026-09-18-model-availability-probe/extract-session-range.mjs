#!/usr/bin/env node
// 解出会话日志并打印指定 seq 区间的事件（只读）。
// 用法: node extract-session-range.mjs <file.zstd> <seqFrom> <seqTo> [--fields provider,model,type,reason]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, fromS, toS] = process.argv.slice(2)
const from = Number(fromS), to = Number(toS)

const buf = readFileSync(file)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
}
let text = ''
for (let k = 0; k < offsets.length; k++) {
  const s = offsets[k]
  const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try { text += zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { /* skip */ }
}

for (const line of text.split('\n')) {
  if (!line.trim()) continue
  let j = null
  try { j = JSON.parse(line) } catch { continue }
  const seq = j.seq
  if (typeof seq !== 'number' || seq < from || seq > to) continue
  const clone = JSON.parse(JSON.stringify(j))
  // 截断长文本，只留结构
  const trim = (o) => {
    if (Array.isArray(o)) return o.map(trim)
    if (o && typeof o === 'object') {
      const r = {}
      for (const [k, v] of Object.entries(o)) {
        if (k === 'text' && typeof v === 'string') r[k] = v.slice(0, 160) + (v.length > 160 ? '…' : '')
        else if (k === 'dt' || k === 'texts' || k === 'content' || k === 'messages' || k === 'tools') r[k] = '[omitted]'
        else r[k] = trim(v)
      }
      return r
    }
    return o
  }
  console.log(JSON.stringify(trim(clone)).slice(0, 1200))
}
