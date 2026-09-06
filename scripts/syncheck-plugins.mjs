import { readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const NODE = process.execPath
// 2026-09-06 审计修复：原硬编码 'D:/Deepseek-Harness' 与 'C:/Users/机械革命/AppData/Local/Temp'，
// 改为从本脚本位置推导工作区根 + os.tmpdir() 推导临时目录。
const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const dirs = []
for (const d of readdirSync(join(base, 'plugins'))) dirs.push(join(base, 'plugins', d, 'lib'))
for (const d of ['dsh-context-lifecycle', 'dsh-stuck-loop-guard', 'dsh-vision-rotator']) {
  dirs.push(join(base, d, 'lib'))
}

const tmp = join(tmpdir(), 'dsh-syncheck')
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
