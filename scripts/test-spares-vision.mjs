// Vision round-trip test for Groq + OpenRouter spares (keys from spare-keys.json).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const keys = JSON.parse(readFileSync('C:/Users/机械革命/.modlens/spare-keys.json', 'utf8'))
const proxy = 'http://127.0.0.1:7897'

function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) { const row = y * (1 + w * 3); for (let x = 0; x < w; x++) { const o = row + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b } }
  const idat = deflateSync(raw)
  function chunk(t, d) {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length, 0)
    const tb = Buffer.from(t, 'ascii')
    let c = 0xffffffff; for (const b of Buffer.concat([tb, d])) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    c = (c ^ 0xffffffff) >>> 0; const cb = Buffer.alloc(4); cb.writeUInt32BE(c, 0)
    return Buffer.concat([len, tb, d, cb])
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const png = makePng(64, 64, [20, 160, 90]).toString('base64')

for (const provider of ['groq', 'openrouter']) {
  const cfg = keys[provider]
  console.log(`\n=== ${provider} / ${cfg.model} ===`)
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      { type: 'text', text: 'What color is this image? Reply one word.' },
    ] }],
    max_tokens: 64,
  })
  const file = join(tmpdir(), `vision-${provider}.json`)
  writeFileSync(file, body, 'utf8')
  try {
    const out = execFileSync('curl.exe', ['-x', proxy, '-sS', '-m', '60', '-H', 'content-type: application/json', '-H', `Authorization: Bearer ${cfg.apiKey}`, '--data-binary', `@${file}`, cfg.baseUrl + '/chat/completions'], { encoding: 'utf8' })
    const data = JSON.parse(out)
    if (data.error) {
      console.log('ERROR:', JSON.stringify(data.error).slice(0, 300))
    } else {
      console.log('REPLY:', JSON.stringify(data.choices?.[0]?.message?.content).slice(0, 150))
      console.log('USAGE:', JSON.stringify(data.usage ?? null))
    }
  } catch (e) {
    console.log('FAIL:', (e.message || String(e)).slice(0, 300))
  }
}
