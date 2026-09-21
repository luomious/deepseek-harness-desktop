#!/usr/bin/env node
// 查询上游 /models 真实清单（只读）。
// 用法: node list-upstream.mjs <providerId> [<providerId> ...]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSettings, parseCreds, PATHS } from './probe-models.mjs'

const provs = parseSettings(readFileSync(PATHS.SETTINGS, 'utf8'))
const creds = existsSync(PATHS.CREDS) ? parseCreds(readFileSync(PATHS.CREDS, 'utf8')) : {}

function modelsURL(baseURL) {
  let u = String(baseURL || '').trim().replace(/^"|"$/g, '')
  u = u.replace(/\/chat\/completions$/i, '')
  return u.replace(/\/+$/, '') + '/models'
}

const out = {}
for (const id of process.argv.slice(2)) {
  const p = provs[id]
  if (!p) { console.log(`## ${id}: NOT IN SETTINGS`); continue }
  const url = modelsURL(p.baseURL)
  const key = creds[p.apiKeyEnv] || ''
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } })
    const text = await res.text()
    let j = null; try { j = JSON.parse(text) } catch { /* ignore */ }
    const ids = Array.isArray(j?.data) ? j.data.map((m) => m.id) : []
    out[id] = { url, status: res.status, count: ids.length, ids, raw: ids.length ? null : text.slice(0, 400) }
    console.log(`## ${id} HTTP ${res.status} url=${url} count=${ids.length}`)
    if (ids.length) console.log(ids.join('\n'))
    else console.log(text.slice(0, 400))
  } catch (e) {
    out[id] = { url, error: String(e && e.message || e) }
    console.log(`## ${id} ERROR ${e && e.message || e}`)
  }
}
mkdirSync('r6', { recursive: true })
writeFileSync('r6/upstream-models.json', JSON.stringify(out, null, 2), 'utf8')
