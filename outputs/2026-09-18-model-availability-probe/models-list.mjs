#!/usr/bin/env node
// 拉取每个 provider 的权威 /models 清单（串行，一个厂一个请求）。
// 用法: node models-list.mjs [--out <dir>]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS = join(DSH_HOME, 'settings.yaml')
const CREDS = join(DSH_HOME, '.credentials.yaml')
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const OUT_DIR = arg('out', process.cwd())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function unq(s) { return String(s || '').trim().replace(/^"|"$/g, '') }

function parseSettings(raw) {
  const providers = {}
  let section = null, inProviders = false, cur = null, curModel = null, inModels = false
  const flushModel = () => { if (cur && curModel && curModel.id) cur.models.push(curModel); curModel = null }
  const flushProv = () => { flushModel(); if (cur && cur.id) providers[cur.id] = cur; cur = null; inModels = false }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const t = line.trim(); const indent = line.length - line.trimStart().length
    if (indent === 0 && t.endsWith(':')) { flushProv(); section = t.slice(0, -1); inProviders = false; continue }
    if (section !== 'llm-pi-ai') continue
    if (indent === 2 && t === 'providers:') { inProviders = true; continue }
    if (!inProviders) continue
    if (indent === 4 && t.endsWith(':')) { flushProv(); cur = { id: t.slice(0, -1), baseURL: '', apiKeyEnv: '', models: [] }; continue }
    if (!cur) continue
    if (indent === 6) {
      const m = /^([\w.-]+):\s*(.*)$/.exec(t); if (!m) continue
      if (m[1] === 'baseURL') cur.baseURL = unq(m[2])
      else if (m[1] === 'apiKeyEnv') cur.apiKeyEnv = unq(m[2])
      else if (m[1] === 'models') inModels = true
      continue
    }
    if (inModels && indent === 8 && t.startsWith('- ')) {
      flushModel(); const m = /^([\w.-]+):\s*(.*)$/.exec(t.slice(2))
      curModel = { id: m && m[1] === 'id' ? unq(m[2]) : '' }; continue
    }
  }
  flushProv(); return providers
}
function parseCreds(raw) {
  const out = {}; let inRefs = false
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue
    if (!line.startsWith(' ') && t === 'refs:') { inRefs = true; continue }
    if (inRefs && line.startsWith(' ')) { const m = /^\s+([A-Z0-9_]+):\s*(.*)$/.exec(line); if (m) out[m[1]] = unq(m[2]) }
  }
  return out
}
function rootURL(baseURL) {
  let u = unq(baseURL)
  if (!u) return ''
  u = u.replace(/\/chat\/completions$/i, '')
  return u.replace(/\/+$/, '')
}

const providers = parseSettings(readFileSync(SETTINGS, 'utf8'))
const creds = parseCreds(readFileSync(CREDS, 'utf8'))
const out = { generatedAt: new Date().toISOString(), providers: {} }
for (const p of Object.values(providers)) {
  const url = rootURL(p.baseURL) + '/models'
  const key = creds[p.apiKeyEnv] || ''
  const rec = { url, apiKeyEnv: p.apiKeyEnv, configured: p.models.map((m) => m.id) }
  try {
    const res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(25000) })
    const text = await res.text()
    let j = null; try { j = JSON.parse(text) } catch { /* ignore */ }
    rec.status = res.status
    const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null
    if (arr) {
      rec.ids = arr.map((x) => x.id || x.name || x.model).filter(Boolean)
      rec.count = rec.ids.length
      rec.missing = rec.configured.filter((c) => !rec.ids.includes(c))
    } else {
      rec.body = text.slice(0, 500)
    }
  } catch (e) {
    rec.error = String((e && e.message) || e).slice(0, 200)
  }
  out.providers[p.id] = rec
  console.log(`${p.id.padEnd(18)} status=${rec.status ?? '-'} count=${rec.count ?? '-'} missing=${(rec.missing || []).join(',') || '-'}${rec.error ? ' ERR=' + rec.error : ''}${rec.body ? ' BODY=' + rec.body.replace(/\s+/g, ' ').slice(0, 120) : ''}`)
  await sleep(1200)
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'models-list.json'), JSON.stringify(out, null, 2), 'utf8')
console.log('json ->', join(OUT_DIR, 'models-list.json'))
