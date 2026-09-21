#!/usr/bin/env node
// 读出指定会话文件里实际使用的 provider/model（用于确认默认模型是不是活的）。
// 用法: node session-model.mjs <session.jsonl.zstd>
// 注：DSH 的会话文件是多帧拼接 zstd，zstdDecompressSync 只解第一帧，必须走流式。
import { createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'

const p = process.argv[2]
const chunks = []
await new Promise((resolve, reject) => {
  createReadStream(p)
    .pipe(createZstdDecompress())
    .on('data', (c) => chunks.push(c))
    .on('end', resolve)
    .on('error', reject)
})
const txt = Buffer.concat(chunks).toString('utf8')
const lines = txt.split('\n')
console.log('lines=' + lines.length + ' bytes=' + txt.length)

const providerCounts = {}
const modelCounts = {}
for (const m of txt.matchAll(/"provider"\s*:\s*"([^"]+)"/g)) providerCounts[m[1]] = (providerCounts[m[1]] || 0) + 1
for (const m of txt.matchAll(/"model"\s*:\s*"([^"]+)"/g)) modelCounts[m[1]] = (modelCounts[m[1]] || 0) + 1
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
console.log('top providers:', JSON.stringify(top(providerCounts, 10)))
console.log('top models   :', JSON.stringify(top(modelCounts, 10)))

// 末尾几行的摘要（最后一条助手/元信息）
for (const l of lines.slice(-3)) {
  if (!l.trim()) continue
  try {
    const j = JSON.parse(l)
    const s = JSON.stringify(j)
    console.log('tail kind=' + (j.type || j.kind || '?') + ' :: ' + s.slice(0, 300))
  } catch { console.log('tail(raw) ' + l.slice(0, 200)) }
}
