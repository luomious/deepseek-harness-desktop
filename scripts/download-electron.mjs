// 下载 electron 43.4.0 zip 到 electron-builder 缓存（带重试 + 代理）
// 用法: node scripts/download-electron.mjs
import { createWriteStream, mkdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProxyAgent } = require('D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/undici')

const URL = 'https://github.com/electron/electron/releases/download/v43.4.0/electron-v43.4.0-win32-x64.zip'
const OUT = 'D:/Deepseek-Harness/.electron-cache/electron-v43.4.0-win32-x64.zip'
mkdirSync('D:/Deepseek-Harness/.electron-cache', { recursive: true })

const dispatcher = new ProxyAgent({ uri: 'http://127.0.0.1:7897' })
const EXPECTED = 115 * 1024 * 1024 // ~115MB，以实际为准

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    console.log(`[download] attempt ${attempt}: ${URL}`)
    const res = await fetch(URL, { dispatcher, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    await pipeline(res.body, createWriteStream(OUT))
    const size = statSync(OUT).size
    console.log(`[download] OK size=${(size / 1024 / 1024).toFixed(1)}MB`)
    if (size < EXPECTED * 0.9) throw new Error(`size too small: ${size}`)
    process.exit(0)
  } catch (e) {
    console.log(`[download] attempt ${attempt} failed: ${String(e)}`)
    try { require('node:fs').rmSync(OUT, { force: true }) } catch { /* */ }
  }
}
process.exit(1)
