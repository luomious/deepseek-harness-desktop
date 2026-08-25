// Host half of the dsh-model-whitelist plugin.
//
// 模型管理(设置面板):勾选要在会话模型选择器里显示的模型(纯前端)。
// 本文件新增「测试连接」端点:读 ~/.dsh/settings.yaml + ~/.dsh/.credentials.yaml,
// 对指定 provider/model 发一次最小 OpenAI 兼容 chat 请求,返回 可用性/延迟/HTTP 状态/错误,
// 让用户在模型管理里直接知道该厂商模型当前是否可用(403/超时/缺 Key 等一目了然)。
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@dsh-external/dsh-model-whitelist'
export const inject = ['webServer', 'hostServices']

const SETTINGS = join(homedir(), '.dsh', 'settings.yaml')
const CREDS = join(homedir(), '.dsh', '.credentials.yaml')
const TEST_TIMEOUT_MS = 15000

function log(...parts) { try { console.log(`[model-whitelist] ${parts.join(' ')}`) } catch { /* ignore */ } }

// 读取 provider 配置(settings.yaml):{ providerId: { displayName, baseURL, apiKeyEnv } }
function readProviderConfigs() {
  const out = {}
  try {
    if (!existsSync(SETTINGS)) return out
    const raw = readFileSync(SETTINGS, 'utf8')
    let section = null      // llm-pi-ai | llm-deepseek
    let inProviders = false
    let curProvider = null
    let curBase = null
    let curEnv = null
    let curName = null
    function flush() {
      if (curProvider && (curBase || curEnv)) {
        out[curProvider] = { displayName: curName || curProvider, baseURL: curBase || '', apiKeyEnv: curEnv || '' }
      }
      curProvider = null; curBase = null; curEnv = null; curName = null
    }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (!line.startsWith(' ') && t.endsWith(':')) {
        flush()
        section = t.slice(0, -1)
        inProviders = false
        continue
      }
      const m = /^(\s+)([\w-]+):\s*(.*)$/.exec(line)
      if (!m) continue
      const indent = m[1].length
      const key = m[2]
      const val = m[3].trim()
      if (section === 'llm-pi-ai' && indent === 2 && key === 'providers') { inProviders = true; continue }
      if (section === 'llm-pi-ai' && inProviders) {
        if (indent === 4 && t.endsWith(':')) { flush(); curProvider = key; continue }
        if (indent === 6 && curProvider) {
          if (key === 'baseURL') curBase = val.replace(/^"|"$/g, '')
          else if (key === 'apiKeyEnv') curEnv = val
          else if (key === 'displayName') curName = val
        }
        continue
      }
      if (section === 'llm-deepseek') {
        if (indent === 2 && key === 'baseURL') { flush(); curProvider = 'deepseek-official'; curBase = val.replace(/^"|"$/g, ''); curEnv = 'DEEPSEEK_API_KEY'; curName = 'DeepSeek' }
        continue
      }
    }
    flush()
  } catch (e) { log('readProviderConfigs error:', String(e)) }
  return out
}

// 读取凭据(.credentials.yaml refs):{ ENV: key }
function readCredentials() {
  const out = {}
  try {
    if (!existsSync(CREDS)) return out
    const raw = readFileSync(CREDS, 'utf8')
    let inRefs = false
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (!line.startsWith(' ') && t === 'refs:') { inRefs = true; continue }
      if (inRefs && line.startsWith(' ')) {
        const m = /^\s+([A-Z0-9_]+):\s*(.*)$/.exec(line)
        if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, '')
      }
    }
  } catch (e) { log('readCredentials error:', String(e)) }
  return out
}

// 对 provider/model 发一次最小 chat 请求,测可用性
async function testConnection(providerId, modelId, providers, creds) {
  const cfg = providers[providerId]
  if (!cfg) return { ok: false, kind: 'config', error: `未找到厂商配置「${providerId}」` }
  if (!cfg.baseURL) return { ok: false, kind: 'config', error: '该厂商未配置接口地址(baseURL)' }
  if (!cfg.apiKeyEnv || !creds[cfg.apiKeyEnv]) return { ok: false, kind: 'auth', error: cfg.apiKeyEnv ? `未配置 API Key(${cfg.apiKeyEnv})` : '未配置 API Key' }
  let url = cfg.baseURL
  if (!/\/chat\/completions$/i.test(url)) url = url.replace(/\/+$/, '') + '/chat/completions'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${creds[cfg.apiKeyEnv]}`,
      },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: ac.signal,
    })
    const latencyMs = Date.now() - t0
    const status = res.status
    if (res.ok) return { ok: true, status, latencyMs, model: modelId }
    let detail = ''
    try { const j = await res.json(); detail = (j && (j.error && (j.error.message || j.error.code))) || '' } catch { /* ignore */ }
    const reason = status === 401 ? '未授权(401)' : status === 403 ? '禁止访问(403)' : status === 404 ? '接口或模型不存在(404)' : status === 429 ? '限流(429)' : status >= 500 ? `服务端错误(${status})` : `HTTP ${status}`
    return { ok: false, status, latencyMs, error: detail ? `${reason}: ${detail}` : reason }
  } catch (e) {
    const latencyMs = Date.now() - t0
    const msg = String((e && e.message) || e)
    if (e && e.name === 'AbortError') return { ok: false, kind: 'timeout', latencyMs, error: `超时(>${TEST_TIMEOUT_MS / 1000}s)` }
    return { ok: false, kind: 'network', latencyMs, error: `无法连接: ${msg.slice(0, 120)}` }
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  const hs = ctx.hostServices
  if (!hs || typeof hs.registerLocalApi !== 'function') {
    try { ctx.logger?.warn?.('[model-whitelist] host-services 未加载，跳过本地 API 注册') } catch { /* ignore */ }
    return
  }
  hs.registerLocalApi(ctx, {
    path: '/model-whitelist/test',
    handler: async (_req, _res, body) => {
      const providerId = String(body && body.provider ? body.provider : '')
      const modelId = String(body && body.model ? body.model : '')
      if (!providerId) return { ok: false, error: '缺少 provider' }
      const providers = readProviderConfigs()
      const creds = readCredentials()
      return await testConnection(providerId, modelId, providers, creds)
    },
  })
  log('route /model-whitelist/test registered')
}
