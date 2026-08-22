// 预下载 electron-builder toolsets（icons-bundle）到缓存，规避代理对 got 大文件传输的中断
import { createWriteStream, mkdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ProxyAgent } = require('D:/Deepseek-Harness/vendor/deepseek-harness-desktop/dsh-plugin-desktop/node_modules/undici')

const URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/icons@1.2.1/icons-bundle.tar.gz'
const OUT = 'D:/Deepseek-Harness/.electron-builder-cache/icons@1.2.1/icons-bundle.tar.gz'
const EXPECTED_SHA = '193241afc7c81ab165fa0af15ef0af88f796eb69e8e5bb4249a49310d8be242a'
mkdirSync('D:/Deepseek-Harness/.electron-builder-cache/icons@1.2.1', { recursive: true })

const dispatcher = new ProxyAgent({ uri: 'http://127.0.0.1:7897' })
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    console.log(`[icons] attempt ${attempt}`)
    const res = await fetch(URL, { dispatcher, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    await pipeline(res.body, createWriteStream(OUT))
    const { createHash } = await import('node:crypto')
    const { readFileSync } = await import('node:fs')
    const sha = createHash('sha256').update(readFileSync(OUT)).digest('hex')
    console.log(`[icons] OK size=${(statSync(OUT).size / 1024 / 1024).toFixed(1)}MB sha=${sha}`)
    if (sha !== EXPECTED_SHA) throw new Error(`sha mismatch: ${sha}`)
    process.exit(0)
  } catch (e) {
    console.log(`[icons] attempt ${attempt} failed: ${String(e)}`)
    try { require('node:fs').rmSync(OUT, { force: true }) } catch { /* */ }
  }
}
process.exit(1)
