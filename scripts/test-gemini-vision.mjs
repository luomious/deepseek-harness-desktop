// Smoke test: verify Gemini vision endpoint through the configured proxy.
// Reads key+proxy from config.json (never from argv), generates a 64x64 image.
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProxyAgent } = require('C:/Users/机械革命/.dsh/profiles/web/node_modules/@liustack/modlens/node_modules/undici/index.js')

const config = JSON.parse(readFileSync('C:/Users/机械革命/.modlens/config.json', 'utf8'))
const p = config.providers['gemini-api']

function makePng(width, height, [r, g, b]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3); raw[row] = 0
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b
    }
  }
  const idat = deflateSync(raw)
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const tb = Buffer.from(type, 'ascii')
    let crc = 0xffffffff
    for (const byte of Buffer.concat([tb, data])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
    crc = (crc ^ 0xffffffff) >>> 0
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc, 0)
    return Buffer.concat([len, tb, data, cb])
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const png = makePng(64, 64, [30, 120, 220]).toString('base64')
const dispatcher = p.proxy ? new ProxyAgent({ uri: p.proxy }) : undefined

async function tryModel(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/png', data: png } },
      { text: 'What color is this image? Reply in one word.' },
    ] }],
    generationConfig: { maxOutputTokens: 64 },
  }
  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey },
    body: JSON.stringify(body),
    ...(dispatcher ? { dispatcher } : {}),
  })
  const text = await res.text()
  console.log(`model=${model}  HTTP ${res.status} (${Date.now() - started}ms)`)
  if (res.ok) {
    const data = JSON.parse(text)
    const reply = data.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') ?? JSON.stringify(data)
    console.log('REPLY:', JSON.stringify(reply).slice(0, 200))
    return true
  }
  console.log('BODY:', text.slice(0, 400))
  return false
}

const ok = await tryModel(p.model || 'gemini-2.5-flash')
if (!ok) {
  for (const alt of ['gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-flash-latest', 'gemini-3.6-flash']) {
    console.log('--- trying fallback:', alt)
    if (await tryModel(alt)) { console.log('USE MODEL:', alt); break }
  }
}
console.log(ok ? 'RESULT: OK' : 'RESULT: FAIL')
if (!ok) process.exitCode = 1
