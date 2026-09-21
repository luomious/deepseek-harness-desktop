#!/usr/bin/env node
// 把 models-list.json 里关心的清单导出成可读文本。
import { readFileSync, writeFileSync } from 'node:fs'
const src = process.argv[2]
const dst = process.argv[3]
const j = JSON.parse(readFileSync(src, 'utf8'))
const p = j.providers
const out = []
for (const id of ['zhipu-ai', 'amd', 'justdowork', 'duoyuanx']) {
  out.push(`=== ${id} (${p[id].count}) ===`)
  out.push((p[id].ids || []).join('\n'))
  out.push('')
}
out.push('=== tokenrouter: z-ai/* ===')
out.push((p.tokenrouter.ids || []).filter((x) => x.startsWith('z-ai/')).join('\n'))
out.push('')
out.push('=== tokenrouter: deepseek/* ===')
out.push((p.tokenrouter.ids || []).filter((x) => x.startsWith('deepseek/')).join('\n'))
out.push('')
out.push('=== modelscope (35) ===')
out.push((p.modelscope.ids || []).join('\n'))
out.push('')
out.push('=== openrouter :free (all) ===')
out.push((p.openrouter.ids || []).filter((x) => x.endsWith(':free')).join('\n'))
out.push('')
out.push('=== openrouter without :free, sample 40 ===')
out.push((p.openrouter.ids || []).filter((x) => !x.endsWith(':free')).slice(0, 40).join('\n'))
writeFileSync(dst, out.join('\n'), 'utf8')
console.log('wrote', dst)
