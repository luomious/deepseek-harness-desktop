#!/usr/bin/env node
// 模型可用性探针（只读）
// 读取 ~/.dsh/settings.yaml (llm-pi-ai.providers) + ~/.dsh/.credentials.yaml (refs)，
// 对每个 provider×model 发一次最小 OpenAI 兼容 chat 请求，记录 可用性/HTTP/延迟/错误。
//
// 用法:
//   node probe-models.mjs [--concurrency 6] [--timeout 60000] [--only <provider>] [--out <dir>]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS = join(DSH_HOME, 'settings.yaml')
const CREDS = join(DSH_HOME, '.credentials.yaml')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CONCURRENCY = Number(arg('concurrency', 6))
const TIMEOUT_MS = Number(arg('timeout', 60000))
const ONLY = arg('only', '')
const OUT_DIR = arg('out', process.cwd())
// 失败项串行复测（默认开）：并发探测会把服务端的 rpm/tpm 限流打成假失败，
// 必须串行重测一次才算数。--retry-serial 0 关闭。
const RETRY_SERIAL = arg('retry-serial', '1') !== '0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- settings.yaml 解析（llm-pi-ai.providers 子集） ----------
function unq(s) { return String(s || '').trim().replace(/^"|"$/g, '') }

function parseSettings(raw) {
  const providers = {}
  let section = null, inProviders = false, cur = null, curModel = null, inModels = false
  const flushModel = () => { if (cur && curModel && curModel.id) cur.models.push(curModel); curModel = null }
  const flushProv = () => { flushModel(); if (cur && cur.id) providers[cur.id] = cur; cur = null; inModels = false }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const t = line.trim()
    const indent = line.length - line.trimStart().length

    if (indent === 0 && t.endsWith(':')) { flushProv(); section = t.slice(0, -1); inProviders = false; continue }
    if (section !== 'llm-pi-ai') continue
    if (indent === 2 && t === 'providers:') { inProviders = true; continue }
    if (!inProviders) continue

    if (indent === 4 && t.endsWith(':')) {
      flushProv()
      cur = { id: t.slice(0, -1), displayName: '', baseURL: '', apiKeyEnv: '', models: [] }
      continue
    }
    if (!cur) continue

    if (indent === 6) {
      const m = /^([\w.-]+):\s*(.*)$/.exec(t)
      if (!m) continue
      const k = m[1], v = unq(m[2])
      if (k === 'baseURL') cur.baseURL = v
      else if (k === 'apiKeyEnv') cur.apiKeyEnv = v
      else if (k === 'displayName') cur.displayName = v
      else if (k === 'models') inModels = true
      continue
    }
    if (inModels && indent === 8 && t.startsWith('- ')) {
      flushModel()
      const body = t.slice(2)
      const m = /^([\w.-]+):\s*(.*)$/.exec(body)
      curModel = { id: m && m[1] === 'id' ? unq(m[2]) : '', name: '', contextWindow: null, input: null, _inInput: false }
      continue
    }
    if (inModels && curModel && indent >= 10) {
      if (t.startsWith('- ')) {
        if (curModel._inInput) (curModel.input ||= []).push(unq(t.slice(2)))
        continue
      }
      const m = /^([\w.-]+):\s*(.*)$/.exec(t)
      if (!m) continue
      const k = m[1], v = unq(m[2])
      curModel._inInput = false
      if (k === 'input') { curModel._inInput = true; curModel.input ||= [] }
      else if (k === 'name') curModel.name = v
      else if (k === 'contextWindow') curModel.contextWindow = Number(v) || null
      continue
    }
  }
  flushProv()
  return providers
}

function parseCreds(raw) {
  const out = {}
  let inRefs = false
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (!line.startsWith(' ') && t === 'refs:') { inRefs = true; continue }
    if (inRefs && line.startsWith(' ')) {
      const m = /^\s+([A-Z0-9_]+):\s*(.*)$/.exec(line)
      if (m) out[m[1]] = unq(m[2])
    }
  }
  return out
}

function chatURL(baseURL) {
  let u = unq(baseURL)
  if (!u) return ''
  if (/\/chat\/completions$/i.test(u)) return u
  return u.replace(/\/+$/, '') + '/chat/completions'
}

function classify(status, body, err) {
  const msg = String(body || err || '').slice(0, 400)
  const low = msg.toLowerCase()
  if (!status) {
    if (/abort|timeout|timed out/i.test(msg)) return 'TIMEOUT'
    return 'NETWORK'
  }
  if (status === 401) return 'AUTH_401'
  if (status === 402) return 'QUOTA_402'
  if (status === 403) return 'FORBIDDEN_403'
  if (status === 404) return 'NOTFOUND_404'
  if (status === 429) return 'RATE_429'
  if (status >= 500) return 'SERVER_5XX'
  if (status === 400) {
    if (/max_tokens|max_completion_tokens/i.test(low)) return 'PARAM_400_MAXTOKENS'
    if (/model|不存在|not exist|invalid/i.test(low)) return 'BADMODEL_400'
    return 'BADREQ_400'
  }
  return 'HTTP_' + status
}

async function probe(provider, model, apiKey) {
  const url = chatURL(provider.baseURL)
  const base = { provider: provider.id, model: model.id, url }
  if (!url) return { ...base, ok: false, kind: 'config', error: 'missing baseURL', attempts: 0 }
  if (!apiKey) return { ...base, ok: false, kind: 'nokey', error: `missing credential ${provider.apiKeyEnv || '(none)'}`, attempts: 0 }

  const payloads = [
    { model: model.id, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 32, stream: false },
    { model: model.id, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_completion_tokens: 32, stream: false },
  ]

  let last = null
  for (let i = 0; i < payloads.length; i++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    const t0 = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payloads[i]),
        signal: ac.signal,
      })
      const latencyMs = Date.now() - t0
      const text = await res.text()
      let j = null; try { j = JSON.parse(text) } catch { /* ignore */ }
      if (res.ok) {
        const hasChoices = Array.isArray(j?.choices) && j.choices.length > 0
        // 「HTTP 200 但 body 不是 chat.completion」是已知假阳性（百度旧版接口就这样），
        // 一律算失败，不能只看状态码。
        if (!hasChoices) {
          last = { ...base, ok: false, status: res.status, latencyMs, attempts: i + 1,
            kind: 'BADBODY_200', error: text.slice(0, 400) }
          break
        }
        const content = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? ''
        const reasoning = j?.choices?.[0]?.message?.reasoning_content ?? ''
        return {
          ...base, ok: true, status: res.status, latencyMs, attempts: i + 1,
          variant: i === 0 ? 'max_tokens' : 'max_completion_tokens',
          replied: String(content).trim().length > 0 || String(reasoning).trim().length > 0,
          snippet: String(content).trim().slice(0, 60),
          usage: j?.usage || null,
        }
      }
      last = { ...base, ok: false, status: res.status, latencyMs, attempts: i + 1,
        kind: classify(res.status, text, ''), error: text.slice(0, 400) }
      // 400 且不是 max_tokens 参数问题 → 不必换参数重试
      if (!(res.status === 400 && /max_tokens/i.test(text))) break
      if (i === payloads.length - 1) break
      await new Promise((r) => setTimeout(r, 300))
    } catch (e) {
      const latencyMs = Date.now() - t0
      const msg = String((e && e.message) || e)
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(msg))
      last = { ...base, ok: false, status: 0, latencyMs, attempts: i + 1,
        kind: aborted ? 'TIMEOUT' : 'NETWORK', error: aborted ? `timeout >${TIMEOUT_MS}ms` : msg.slice(0, 200) }
      break
    } finally { clearTimeout(timer) }
  }
  return last
}

async function main() {
  if (!existsSync(SETTINGS)) throw new Error('settings.yaml not found: ' + SETTINGS)
  const providers = parseSettings(readFileSync(SETTINGS, 'utf8'))
  const creds = existsSync(CREDS) ? parseCreds(readFileSync(CREDS, 'utf8')) : {}

  const jobs = []
  for (const p of Object.values(providers)) {
    if (ONLY && p.id !== ONLY) continue
    for (const m of p.models) jobs.push({ provider: p, model: m, apiKey: creds[p.apiKeyEnv] || '' })
  }

  console.log(`providers=${Object.keys(providers).length} jobs=${jobs.length} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms`)
  const results = []
  let idx = 0
  async function worker() {
    while (idx < jobs.length) {
      const j = jobs[idx++]
      const r = await probe(j.provider, j.model, j.apiKey)
      results.push(r)
      const flag = r.ok ? 'OK  ' : 'FAIL'
      console.log(`[${results.length}/${jobs.length}] ${flag} ${r.provider}/${r.model} ${r.ok ? r.latencyMs + 'ms' : (r.kind || '') + ' ' + String(r.error || '').replace(/\s+/g, ' ').slice(0, 140)}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))

  results.sort((a, b) => (a.provider + '/' + a.model).localeCompare(b.provider + '/' + b.model))
  mkdirSync(OUT_DIR, { recursive: true })
  const jsonPath = join(OUT_DIR, 'probe-results.json')
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), settings: SETTINGS, phase: 'concurrent', results }, null, 2), 'utf8')

  // ---- 阶段 2：失败项串行复测（去掉并发自造的假限流） ----
  if (RETRY_SERIAL) {
    const failed = results.filter((r) => !r.ok)
    console.log(`\n--- serial retry of ${failed.length} failures (rate-limit kinds spaced 12s) ---`)
    for (let i = 0; i < failed.length; i++) {
      const r = failed[i]
      const j = jobs.find((x) => x.provider.id === r.provider && x.model.id === r.model)
      if (!j) continue
      const gap = (r.kind === 'RATE_429' || r.kind === 'QUOTA_402' || r.kind === 'SERVER_5XX') ? 12000 : 1800
      await sleep(gap)
      const r2 = await probe(j.provider, j.model, j.apiKey)
      r.retry = { ok: r2.ok, status: r2.status, latencyMs: r2.latencyMs, kind: r2.kind, error: r2.error, snippet: r2.snippet, replied: r2.replied, variant: r2.variant, usage: r2.usage || null }
      console.log(`[retry ${i + 1}/${failed.length}] ${r2.ok ? 'OK  ' : 'FAIL'} ${r.provider}/${r.model} ${r2.ok ? r2.latencyMs + 'ms' : (r2.kind || '') + ' ' + String(r2.error || '').replace(/\s+/g, ' ').slice(0, 140)}`)
    }
    writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), settings: SETTINGS, phase: 'concurrent+serial-retry', results }, null, 2), 'utf8')
  }

  const usable = results.filter((r) => r.ok || r.retry?.ok)
  const bad = results.filter((r) => !(r.ok || r.retry?.ok))
  console.log(`\n=== ${usable.length} USABLE / ${bad.length} FAIL / ${results.length} total ===`)
  const byKind = {}
  for (const r of bad) { const k = (r.retry && !r.retry.ok ? r.retry.kind : r.kind) || 'unknown'; byKind[k] = (byKind[k] || 0) + 1 }
  console.log('failures by kind:', JSON.stringify(byKind))
  console.log('json ->', jsonPath)
}

export { probe, parseSettings, parseCreds, chatURL, classify }
export const PATHS = { SETTINGS, CREDS }

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main().catch((e) => { console.error('FATAL', e); process.exit(1) })
