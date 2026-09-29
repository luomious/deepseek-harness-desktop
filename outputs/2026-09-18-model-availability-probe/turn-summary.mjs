#!/usr/bin/env node
// 汇总一个会话里每个 turn 的结束原因 + 该 turn 实际用的 provider/model。
// 用法: node turn-summary.mjs <file.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buf = readFileSync(process.argv[2])
const offs = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i)
}
let t = ''
for (let k = 0; k < offs.length; k++) {
  const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : buf.length
  try { t += zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { /* skip */ }
}

const provByTurn = {}
const ends = []
for (const l of t.split('\n')) {
  if (!l.includes('"type":"assistant/message"') && !l.includes('"type":"turn/end"')) continue
  let j = null
  try { j = JSON.parse(l) } catch { continue }
  const turn = j.data?.turn
  if (typeof turn !== 'number') continue
  if (j.type === 'assistant/message') {
    const src = j.data?.message?.source || {}
    if (src.kind === 'model') provByTurn[turn] = `${src.provider}/${src.model}`
  } else {
    const r = j.data?.reason || {}
    const err = r.error || r.failure || {}
    ends.push({ turn, kind: r.kind, code: err.code || '', msg: String(err.message || '').replace(/\s+/g, ' ').slice(0, 90) })
  }
}
console.log(`turn/end events: ${ends.length}`)
for (const e of ends) {
  const p = provByTurn[e.turn] || '(unknown)'
  console.log(`  turn ${String(e.turn).padStart(3)}  ${String(e.kind).padEnd(6)} ${String(e.code).padEnd(16)} ${p}`)
  if (e.msg) console.log(`        msg: ${e.msg}`)
}
const byProv = {}
for (const e of ends) { const p = provByTurn[e.turn] || '(unknown)'; byProv[p] = byProv[p] || { ok: 0, err: 0 }; if (e.kind === 'error') byProv[p].err++; else byProv[p].ok++ }
console.log('\nper provider:', JSON.stringify(byProv, null, 1))
