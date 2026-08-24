// List free vision models from Groq and OpenRouter (reads keys from spare-keys.json).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const keys = JSON.parse(readFileSync('C:/Users/机械革命/.modlens/spare-keys.json', 'utf8'))
const proxy = 'http://127.0.0.1:7897'

function list(provider) {
  const cfg = keys[provider]
  const out = execFileSync('curl.exe', ['-x', proxy, '-sS', '-m', '40', '-H', `Authorization: Bearer ${cfg.apiKey}`, cfg.baseUrl + '/models'], { encoding: 'utf8' })
  return JSON.parse(out).data || []
}

for (const provider of ['groq', 'openrouter']) {
  console.log(`\n=== ${provider} ===`)
  try {
    const models = list(provider)
    const vision = models.filter((m) => {
      const im = m.input_modalities || m.architecture?.input_modalities || []
      return im.includes('image')
    })
    for (const m of vision) {
      const free = provider === 'openrouter'
        ? (m.id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0))
        : (m.pricing && Number(m.pricing.prompt) === 0)
      const price = m.pricing ? `prompt=${m.pricing.prompt}` : 'n/a'
      console.log(`${free ? '[FREE]' : '[paid]'} ${m.id}  (${price})`)
    }
    if (!vision.length) console.log('(no vision models returned)')
  } catch (e) {
    console.log('ERR:', (e.message || String(e)).slice(0, 300))
  }
}
