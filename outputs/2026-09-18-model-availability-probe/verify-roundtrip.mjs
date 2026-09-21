#!/usr/bin/env node
// 决定性校验：把当前 settings.yaml 的 3 处改动“反向还原”，应与改动前备份逐字节相同。
// 用法: node verify-roundtrip.mjs <before.yaml> <current.yaml>
import { readFileSync } from 'node:fs'
const [b, c] = process.argv.slice(2)
const B = readFileSync(b, 'utf8')
let A = readFileSync(c, 'utf8')
const EOL = A.includes('\r\n') ? '\r\n' : '\n'
const L = (...x) => x.join(EOL)
const REVERSE = [
  [L('        - id: deepseek/deepseek-v4-flash-0731:free', '          name: DeepSeek V4 Flash 0731 (free)'),
   L('        - id: stealth/union-alpha', '          name: union-alpha')],
  [L('        - id: DeepSeek-V4.1-Flash', '          name: DeepSeek-V4.1-Flash', '          contextWindow: 1048576', '        - id: Qwen3.8-Flash-Next', '          name: Qwen3.8-Flash-Next'),
   L('        - id: Qwen3.8-Flash-Next', '          name: Qwen3.8-Flash-Next')],
  [L('        - id: z-ai/glm-5.3', '          compat:'), L('        - id: z-ai/glm-5.3-free', '          compat:')],
]
let restored = A
for (const [from, to] of REVERSE) {
  const n = restored.split(from).length - 1
  console.log(`reverse anchor hit x${n}`)
  if (n !== 1) { console.log(' !! 锚点不唯一，校验无法进行'); process.exit(1) }
  restored = restored.replace(from, to)
}
console.log('byte-identical to before:', restored === B, `(before=${Buffer.byteLength(B)}B restored=${Buffer.byteLength(restored)}B current=${Buffer.byteLength(A)}B)`)
if (restored !== B) {
  const rb = restored.split(/\r?\n/), bb = B.split(/\r?\n/)
  console.log(`lines restored=${rb.length} before=${bb.length}`)
  for (let i = 0; i < Math.max(rb.length, bb.length); i++) {
    if (rb[i] !== bb[i]) { console.log(`first mismatch @${i + 1}\n  before  : ${JSON.stringify(bb[i])}\n  restored: ${JSON.stringify(rb[i])}`); break }
  }
}
