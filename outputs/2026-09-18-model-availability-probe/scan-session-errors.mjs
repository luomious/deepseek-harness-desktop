#!/usr/bin/env node
// 在会话日志里找「真正的上游报错事件」（排除模型自己 reasoning/文本里的复述）。
// 用法: node scan-session-errors.mjs <regex> [--sinceHours 48] [--limit 12]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const re = new RegExp(process.argv[2] || 'DataInspectionFailed')
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const sinceHours = Number(arg('sinceHours', 48))
const limit = Number(arg('limit', 12))

const ROOT = join(homedir(), '.dsh', 'sessions')
const cutoff = Date.now() - sinceHours * 3600 * 1000

function decode(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
  }
  let out = ''
  for (let k = 0; k < offsets.length; k++) {
    const s = offsets[k]
    const e = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { /* skip */ }
  }
  return out
}

const files = []
for (const ws of readdirSync(ROOT)) {
  const wsDir = join(ROOT, ws)
  let entries = []
  try { entries = readdirSync(wsDir) } catch { continue }
  for (const e of entries) {
    const f = join(wsDir, e, 'session.jsonl.zstd')
    try { const st = statSync(f); if (st.mtimeMs >= cutoff) files.push({ f, ws, id: e, mtime: st.mtimeMs, size: st.size }) } catch { /* skip */ }
  }
}
files.sort((a, b) => b.mtime - a.mtime)
console.log(`candidates: ${files.length} (since ${sinceHours}h)`)

let hits = 0
for (const it of files.slice(0, 40)) {
  const text = decode(readFileSync(it.f))
  const found = []
  for (const l of text.split('\n')) {
    if (!re.test(l)) continue
    if (l.includes('reasoning-chunks')) continue
    if (l.includes('text-chunks')) continue
    found.push(l)
  }
  if (!found.length) continue
  hits++
  console.log(`\n===== ${it.ws} / ${it.id}  mtime=${new Date(it.mtime).toISOString()}  size=${it.size}  hits=${found.length}`)
  for (const l of found.slice(0, limit)) console.log('  ' + l.slice(0, 700))
}
console.log(`\nsessions with real error hits: ${hits}`)
