#!/usr/bin/env node
// 走应用自己的 HTTP 端点做交叉验证（localhost，带同源 Origin 头）。
// 用法: node http-check.mjs
const BASE = 'http://127.0.0.1:43120'
const H = { origin: BASE, 'sec-fetch-site': 'same-origin' }

async function get(p) {
  try {
    const r = await fetch(BASE + p, { headers: H, signal: AbortSignal.timeout(30000) })
    return { status: r.status, body: await r.text() }
  } catch (e) { return { status: 0, body: 'ERR ' + String(e.message || e) } }
}
async function post(p, body) {
  try {
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(40000),
    })
    return { status: r.status, body: await r.text() }
  } catch (e) { return { status: 0, body: 'ERR ' + String(e.message || e) } }
}

const h = await get('/health')
console.log('=== GET /health ->', h.status, '===')
console.log(h.body.slice(0, 2500))

// 用应用自己的配置读取器测「改动后」的模型（它每次请求都读磁盘上的 settings.yaml）
for (const [p, m] of [['openrouter', 'deepseek/deepseek-v4-flash-0731:free'], ['amd', 'DeepSeek-V4.1-Flash'], ['tokenrouter', 'z-ai/glm-5.3']]) {
  const r = await post('/model-whitelist/test', { provider: p, model: m })
  console.log(`=== POST /model-whitelist/test ${p}/${m} ->`, r.status, '===')
  console.log(r.body.slice(0, 400))
}
