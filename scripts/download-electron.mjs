// download-electron.mjs - download the electron 43.4.0 zip into the
// electron-builder cache (with retries + SHA256 verification + proxy override).
// Usage: node scripts/download-electron.mjs
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProxyAgent } = require('D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/undici')

const VERSION = '43.4.0'
const URL = `https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-win32-x64.zip`
const SHASUMS_URL = `https://github.com/electron/electron/releases/download/v${VERSION}/SHASUMS256.txt`
const BASENAME = `electron-v${VERSION}-win32-x64.zip`
const CACHE = 'D:/Deepseek-Harness/.electron-cache'
const OUT = `${CACHE}/${BASENAME}`
mkdirSync(CACHE, { recursive: true })

// P1-B7: proxy comes from env first (DSH_PROXY > HTTP_PROXY), falling back to
// the machine's local default. An unset local proxy no longer hard-breaks builds.
const PROXY = process.env.DSH_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897'
const dispatcher = new ProxyAgent({ uri: PROXY })
const EXPECTED = 115 * 1024 * 1024 // ~115MB, sanity floor only; SHA256 is authoritative (D7).

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toLowerCase()
}

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    console.log(`[download] attempt ${attempt}: ${URL} (proxy=${PROXY})`)
    const res = await fetch(URL, { dispatcher, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    await pipeline(res.body, createWriteStream(OUT))
    const size = statSync(OUT).size
    console.log(`[download] OK size=${(size / 1024 / 1024).toFixed(1)}MB`)
    if (size < EXPECTED * 0.9) throw new Error(`size too small: ${size}`)
    // D7: verify against the official SHASUMS256.txt (supply-chain integrity).
    const sumsRes = await fetch(SHASUMS_URL, { dispatcher, redirect: 'follow' })
    if (!sumsRes.ok) throw new Error(`SHASUMS256 HTTP ${sumsRes.status}`)
    const sums = await sumsRes.text()
    const line = sums.split(/\r?\n/).find((l) => l.includes(BASENAME))
    if (!line) throw new Error(`SHASUMS256.txt has no entry for ${BASENAME}`)
    const expected = line.split(/\s+/)[0].toLowerCase()
    const actual = sha256File(OUT)
    if (expected !== actual) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`)
    console.log(`[download] SHA256 verified: ${actual}`)
    process.exit(0)
  } catch (e) {
    console.log(`[download] attempt ${attempt} failed: ${String(e)}`)
    try { rmSync(OUT, { force: true }) } catch { /* */ }
  }
}
process.exit(1)