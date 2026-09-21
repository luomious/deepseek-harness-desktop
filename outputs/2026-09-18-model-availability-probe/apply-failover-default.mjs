#!/usr/bin/env node
// 给默认模型加一条 failover 兜底（默认 dry-run；--apply 写入）。
// 只加 2 行，缩进与现有兄弟条目逐字相同；原子写 + 回读校验。
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'node:fs'

const F = 'D:\\Deepseek-Harness\\plugins\\dsh-model-provider-failover\\cordis.patch.yml'
const APPLY = process.argv.includes('--apply')
const raw = readFileSync(F, 'utf8')
const EOL = raw.includes('\r\n') ? '\r\n' : '\n'

const EDITS = [
  {
    name: 'fallback: 默认模型 modlens-yidong -> modlens-tokenrhythm01',
    from: '        fallback:' + EOL + '          modlens-apinex: modlens-tokenrhythm01',
    to: '        fallback:' + EOL + '          modlens-yidong: modlens-tokenrhythm01' + EOL + '          modlens-apinex: modlens-tokenrhythm01',
  },
  {
    name: 'fallbackModel: modlens-yidong -> deepseek-v4-flash-0731',
    from: '        fallbackModel:' + EOL + '          modlens-apinex: deepseek-v4-flash-0731',
    to: '        fallbackModel:' + EOL + '          modlens-yidong: deepseek-v4-flash-0731' + EOL + '          modlens-apinex: deepseek-v4-flash-0731',
  },
]

let ok = true
for (const e of EDITS) {
  const n = raw.split(e.from).length - 1
  console.log(`${n === 1 ? 'OK  ' : 'FAIL'} x${n}  ${e.name}`)
  if (n !== 1) ok = false
}
if (!ok) { console.error('预检失败，拒写'); process.exit(1) }

let out = raw
for (const e of EDITS) out = out.replace(e.from, e.to)

// 结构校验：新增行缩进必须与兄弟行一致；无 tab；行数 +2
const indentOf = (line) => line.length - line.trimStart().length
const oldLines = raw.split(/\r?\n/), newLines = out.split(/\r?\n/)
console.log(`lines ${oldLines.length} -> ${newLines.length} (expect +2)`)
console.log('has tab:', /\t/.test(out))
const bad = newLines.filter((l) => l.trim().startsWith('modlens-yidong:') && indentOf(l) !== 10)
console.log('new-line indent check (expect 0 bad):', bad.length)
console.log('--- inserted context ---')
for (const l of newLines) if (l.includes('modlens-yidong:')) console.log('  ' + JSON.stringify(l))

if (!APPLY) { console.log('\n[dry-run]'); process.exit(0) }

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dir = `D:\\Deepseek-Harness\\_backups\\failover-default-${ts.replace(/[-T]/g, '').slice(0, 14)}`
mkdirSync(dir, { recursive: true })
copyFileSync(F, `${dir}/cordis.patch.yml.before`)
writeFileSync(`${dir}/cordis.patch.yml.after`, out, 'utf8')
const tmp = `${F}.tmp-${process.pid}`
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, F)
const back = readFileSync(F, 'utf8')
console.log('\nWROTE. identical to intended:', back === out, '| bytes', Buffer.byteLength(back))
console.log('backup ->', dir)
