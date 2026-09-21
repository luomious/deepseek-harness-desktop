#!/usr/bin/env node
// 应用 r6 轮的模型配置修复（原子写 + 逐条校验 + 前后 diff）。
// 用法: node apply-model-fixes-r6.mjs [--dry]
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PATHS } from './probe-models.mjs'

const DRY = process.argv.includes('--dry')
const SRC = PATHS.SETTINGS
const raw = readFileSync(SRC, 'utf8')
const before = createHash('sha256').update(raw).digest('hex').toUpperCase()

// 每条修复：{ desc, find, replace, expectOnce }
const fixes = [
  {
    desc: 'amd: 删除已下线模型 DeepSeek-V4-Flash（400 Unsupported model）',
    find: '        - id: DeepSeek-V4-Flash\n          name: DeepSeek-V4-Flash\n          contextWindow: 1048576\n',
    replace: '',
  },
  {
    desc: 'openrouter: deepseek/deepseek-v4-flash-0731:free（404 已转付费）→ nex-agi/nex-n2.5-pro:free',
    find: '        - id: deepseek/deepseek-v4-flash-0731:free\n          name: DeepSeek V4 Flash 0731 (free)\n',
    replace: '        - id: nex-agi/nex-n2.5-pro:free\n          name: "Nex AGI: Nex N2.5 Pro (free)"\n          contextWindow: 262144\n          maxTokens: 32768\n',
  },
]

let out = raw
const applied = []
for (const f of fixes) {
  const n = out.split(f.find).length - 1
  if (n !== 1) {
    console.error(`ABORT: 匹配次数=${n}（期望 1）-> ${f.desc}`)
    process.exit(1)
  }
  out = out.replace(f.find, f.replace)
  applied.push(f.desc)
}

const after = createHash('sha256').update(out).digest('hex').toUpperCase()
console.log(`before sha256=${before} (${raw.length}B)`)
console.log(`after  sha256=${after} (${out.length}B)`)
console.log('delta bytes =', out.length - raw.length)
for (const d of applied) console.log('  -', d)

if (DRY) { console.log('\n[dry-run] 未写入'); process.exit(0) }

// 备份（带时间戳，落在 DSH_HOME 与工作区 _backups 两处）
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bak = `${SRC}.bak-r6-${ts}`
copyFileSync(SRC, bak)
console.log('backup ->', bak)
const wsBak = join(process.cwd(), '..', '..', '_backups', `modelfix-r6-${ts.replace(/[-T:]/g, '').slice(0, 14)}`)
if (!existsSync(wsBak)) mkdirSync(wsBak, { recursive: true })
copyFileSync(SRC, join(wsBak, 'settings.yaml.before'))
console.log('backup ->', join(wsBak, 'settings.yaml.before'))

// 原子写：同目录 tmp + rename
const tmp = `${SRC}.tmp-r6`
writeFileSync(tmp, out, 'utf8')
const { renameSync } = await import('node:fs')
renameSync(tmp, SRC)

// 回读校验
const back = readFileSync(SRC, 'utf8')
const backHash = createHash('sha256').update(back).digest('hex').toUpperCase()
console.log('reread sha256=', backHash, backHash === after ? 'MATCH' : 'MISMATCH')
if (backHash !== after) process.exit(1)
