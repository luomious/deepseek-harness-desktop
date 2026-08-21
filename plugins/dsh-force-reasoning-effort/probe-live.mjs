// 端到端探针：调用运行中 DSH 的 /api/llm.models，检查模型目录里 reasoning 元数据。
// 运行：node probe-live.mjs
const BASE = 'http://127.0.0.1:3080'

async function main() {
  const res = await fetch(BASE + '/api/llm.models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'probe-' + Date.now(),
      method: 'llm.models',
      payload: {},
    }),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { console.log('非 JSON 响应: status=' + res.status + '\n' + text.slice(0, 2000)); return }
  const value = data?.result?.ok ? data.result.value : undefined
  if (!value) { console.log('RPC 失败: ' + JSON.stringify(data).slice(0, 2000)); return }

  const groups = value.groups ?? []
  const failures = value.failures ?? []
  console.log('groups:', groups.length, ' failures:', failures.length)

  let total = 0, withReasoning = 0, withoutReasoning = 0
  const missing = []
  const targets = ['gpt-5.6-terra', 'gpt-4o', 'deepseek-v4-pro']
  const found = {}

  for (const g of groups) {
    for (const m of g.models ?? []) {
      total++
      const has = !!m.reasoning && Array.isArray(m.reasoning.efforts) && m.reasoning.efforts.length > 0
      if (has) withReasoning++
      else { withoutReasoning++; missing.push(`${g.id}/${m.id}`) }
      if (targets.includes(m.id)) {
        found[m.id] = {
          provider: g.id,
          reasoning: has
            ? { efforts: m.reasoning.efforts.map((e) => e.id), defaultEffort: m.reasoning.defaultEffort ?? null }
            : null,
        }
      }
    }
  }

  console.log(`模型总数 ${total} | 有思考强度 ${withReasoning} | 无思考强度 ${withoutReasoning}`)
  if (missing.length) console.log('无思考强度的模型:', missing.join(', '))
  for (const t of targets) {
    const f = found[t]
    console.log(f ? `${t} (${f.provider}): ${JSON.stringify(f.reasoning)}` : `${t}: 未在目录中`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
