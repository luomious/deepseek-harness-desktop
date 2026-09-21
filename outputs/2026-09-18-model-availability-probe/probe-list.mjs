#!/usr/bin/env node
// 串行探测任意 provider/model 候选（只读）。
// 用法: node probe-list.mjs <gapMs> "<provider>/<model>" [...]
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { parseSettings, parseCreds, probe, PATHS } from './probe-models.mjs'

const gapMs = Number(process.argv[2] || 2000)
const pairs = process.argv.slice(3)
const provs = parseSettings(readFileSync(PATHS.SETTINGS, 'utf8'))
const creds = existsSync(PATHS.CREDS) ? parseCreds(readFileSync(PATHS.CREDS, 'utf8')) : {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const out = []
for (const pair of pairs) {
  const i = pair.indexOf('/')
  const pid = pair.slice(0, i), mid = pair.slice(i + 1)
  const p = provs[pid]
  if (!p) { console.log(`SKIP  ${pair} (provider not in settings)`); continue }
  const r = await probe(p, { id: mid }, creds[p.apiKeyEnv] || '')
  out.push(r)
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${pair} ${r.ok ? r.latencyMs + 'ms replied=' + r.replied : (r.kind || '') + ' ' + String(r.error || '').replace(/\s+/g, ' ').slice(0, 150)}`)
  await sleep(gapMs)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outFile = `r6/candidates-probe-${stamp}.json`
writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8')
console.log(`\n${out.filter((r) => r.ok).length}/${out.length} OK -> ${outFile}`)
