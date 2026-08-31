import { readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const NODE = process.execPath
const base = 'D:/Deepseek-Harness'
const dirs = []
for (const d of readdirSync(join(base, 'plugins'))) dirs.push(join(base, 'plugins', d, 'lib'))
for (const d of ['dsh-context-lifecycle', 'dsh-stuck-loop-guard', 'dsh-vision-rotator']) {
  dirs.push(join(base, d, 'lib'))
}

const tmp = 'C:/Users/机械革命/AppData/Local/Temp/dsh-syncheck'
mkdirSync(tmp, { recursive: true })

const bad = []
let n = 0
for (const dir of dirs) {
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  } catch {
    continue
  }
  for (const f of files) {
    const src = join(dir, f)
    const safe = dir.replace(/[^a-zA-Z0-9]/g, '_')
    const target = join(tmp, safe + '__' + f.replace(/\.js$/, '.mjs'))
    copyFileSync(src, target)
    n++
    try {
      execFileSync(NODE, ['--check', target], { stdio: 'pipe', windowsHide: true })
    } catch (e) {
      const msg = (e.stderr ? e.stderr.toString() : String(e.message || e))
        .split('\n')
        .slice(0, 5)
        .join(' | ')
      bad.push(src + '\n    -> ' + msg.trim())
    }
  }
}
console.log('scanned ' + n + ' files')
if (bad.length) {
  console.log('\n=== SYNTAX ERRORS (' + bad.length + ') ===')
  for (const b of bad) console.log(b)
} else {
  console.log('none')
}
