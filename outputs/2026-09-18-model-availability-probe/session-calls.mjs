#!/usr/bin/env node
// 从会话文件里抽出每次 LLM 调用记录（时间 + provider + model），用于判断某 provider 现在还能不能用。
// 用法: node session-calls.mjs <file.zstd> [--tail 30]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const TAIL = Number(arg('tail', 30))

const buf = readFileSync(file)
const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}
let text = ''
for (let k = 0; k < offsets.length; k++) {
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  try { text += zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8') } catch { /* skip */ }
}

const recs = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  // 只关心带 provider+model 的结构
  const pm = /"provider"\s*:\s*"([^"]+)"/.exec(line)
  const mm = /"model"\s*:\s*"([^"]+)"/.exec(line)
  if (!pm || !mm) continue
  const tm = /"time"\s*:\s*(\d{13})/.exec(line) || /"time0"\s*:\s*(\d{13})/.exec(line)
  const tm2 = /"time"\s*:\s*(\d{13})/.exec(line)
  const t = tm2 ? Number(tm2[1]) : (tm ? Number(tm[1]) : 0)
  recs.push({ t, provider: pm[1], model: mm[1], type: (/"type"\s*:\s*"([^"]+)"/.exec(line) || [])[1] || '?' })
}

recs.sort((a, b) => a.t - b.t)
console.log('total provider+model records =', recs.length)
const fmt = (t) => (t ? new Date(t).toLocaleString('sv-SE') : '?')
console.log(`\n--- last ${TAIL} ---`)
for (const r of recs.slice(-TAIL)) console.log(`${fmt(r.t)}  ${r.provider}/${r.model}  [${r.type}]`)

// 每个 provider 的最后一次出现时间
const lastBy = {}
for (const r of recs) lastBy[r.provider + '/' + r.model] = r.t
console.log('\n--- last seen per provider/model ---')
for (const [k, v] of Object.entries(lastBy).sort((a, b) => a[1] - b[1])) console.log(`${fmt(v)}  ${k}`)
