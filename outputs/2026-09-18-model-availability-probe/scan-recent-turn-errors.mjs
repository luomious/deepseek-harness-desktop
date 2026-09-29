#!/usr/bin/env node
// 列出「指定时间之后被修改的会话」里所有的 turn/end 结果 + 实际 provider。
// 用法: node scan-recent-turn-errors.mjs <sinceIso> [--limit 15]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sinceIso = process.argv[2] || '1970-01-01T00:00:00Z'
const sinceMs = Date.parse(sinceIso)
const i = process.argv.indexOf('--limit')
const limit = i >= 0 ? Number(process.argv[i + 1]) : 15

const ROOT = join(homedir(), '.dsh', 'sessions')
function decode(buf) {
  const offs = []
  for (let k = 0; k + 4 <= buf.length; k++) {
    if (buf[k] === 0x28 && buf[k + 1] === 0xb5 && buf[k + 2] === 0x2f && buf[k + 3] === 0xfd) offs.push(k)
  }
  let out = ''
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { /* skip */ }
  }
  return out
}

const files = []
for (const ws of readdirSync(ROOT)) {
  let entries = []
  try { entries = readdirSync(join(ROOT, ws)) } catch { continue }
  for (const e of entries) {
    const f = join(ROOT, ws, e, 'session.jsonl.zstd')
    try { const st = statSync(f); if (st.mtimeMs >= sinceMs) files.push({ f, ws, id: e, mtime: st.mtimeMs }) } catch { /* skip */ }
  }
}
files.sort((a, b) => b.mtime - a.mtime)
console.log(`sessions modified since ${sinceIso}: ${files.length}`)

for (const it of files) {
  const text = decode(readFileSync(it.f))
  const provByTurn = {}
  const ends = []
  for (const l of text.split('\n')) {
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
      ends.push({ turn, t: j.time, kind: r.kind, code: err.code || '', msg: String(err.message || '').replace(/\s+/g, ' ').slice(0, 110), prov: provByTurn[turn] || '(unknown)' })
    }
  }
  const recent = ends.filter((e) => e.t >= sinceMs)
  if (!recent.length) continue
  console.log(`\n===== ${it.ws.slice(0, 40)} / ${it.id.slice(0, 20)}  mtime=${new Date(it.mtime).toISOString()}`)
  for (const e of recent.slice(-limit)) {
    console.log(`  ${new Date(e.t).toISOString()}  turn ${String(e.turn).padStart(3)}  ${String(e.kind).padEnd(12)} ${String(e.code).padEnd(16)} ${e.prov}`)
    if (e.msg && e.kind === 'error') console.log(`        msg: ${e.msg}`)
  }
}
