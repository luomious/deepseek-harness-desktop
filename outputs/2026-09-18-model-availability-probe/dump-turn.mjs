#!/usr/bin/env node
// 打印某会话指定 turn 的全部事件（类型 + 关键字段），用于看失败到底走哪条路径。
// 用法: node dump-turn.mjs <file.zstd> <turn>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const buf = readFileSync(process.argv[2])
const wantTurn = Number(process.argv[3])
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
  const turn = j.data?.turn ?? j.data?.message?.turn
  if (turn !== wantTurn) continue
  const ch = j.data?.chunk
  let extra = ''
  if (ch) {
    extra = `chunkType=${ch.type}`
    if (ch.reason) extra += ` reasonKind=${ch.reason.kind} code=${ch.reason.failure?.code ?? ch.reason.error?.code ?? ''} msg=${String(ch.reason.failure?.message ?? ch.reason.error?.message ?? '').slice(0, 70)}`
    if (ch.block) extra += ` blockType=${ch.block.type}`
  }
  if (j.type === 'turn/end') extra = `reasonKind=${j.data.reason?.kind} code=${j.data.reason?.error?.code ?? ''} msg=${String(j.data.reason?.error?.message ?? '').slice(0, 90)}`
  if (j.type === 'step/start' || j.type === 'step/end') extra = ''
  console.log(`${String(j.seq).padStart(7)}  ${new Date(j.time).toISOString()}  ${String(j.type).padEnd(26)} ${extra}`)
}
