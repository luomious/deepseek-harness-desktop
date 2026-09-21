#!/usr/bin/env node
// 把实测通过的模型修复写入 ~/.dsh/settings.yaml（先备份、锚点唯一才改、原子写、回读校验）。
// 默认 dry-run；--apply 才写入。
// 用法: node apply-model-fixes.mjs [--apply]
import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS = join(HOME, 'settings.yaml')
const BACKUP_DIR = join('D:', '\\', 'Deepseek-Harness', '_backups')

const raw = readFileSync(SETTINGS, 'utf8')
const EOL = raw.includes('\r\n') ? '\r\n' : '\n'
const L = (...lines) => lines.join(EOL)

// ---- 只改这三处，逐条有实测背书 ----
const EDITS = [
  {
    name: 'openrouter: stealth/union-alpha 已下线 → 换成实测可用 820ms 的 free 模型',
    from: L('        - id: stealth/union-alpha', '          name: union-alpha'),
    to: L('        - id: deepseek/deepseek-v4-flash-0731:free', '          name: DeepSeek V4 Flash 0731 (free)'),
  },
  {
    name: 'amd: 新增实测可用 9.4s 的 DeepSeek-V4.1-Flash（原 DeepSeek-V4-Flash 上游 503 不动）',
    from: L('        - id: Qwen3.8-Flash-Next', '          name: Qwen3.8-Flash-Next'),
    to: L('        - id: DeepSeek-V4.1-Flash', '          name: DeepSeek-V4.1-Flash', '          contextWindow: 1048576', '        - id: Qwen3.8-Flash-Next', '          name: Qwen3.8-Flash-Next'),
  },
  {
    name: 'tokenrouter: z-ai/glm-5.3-free 站内已无此 slug → 改为站内存在且调用通过路由（仅卡余额）的 z-ai/glm-5.3',
    from: L('        - id: z-ai/glm-5.3-free'),
    to: L('        - id: z-ai/glm-5.3'),
  },
]

// ---- 预检：每个 from 必须恰好命中 1 次 ----
let ok = true
for (const e of EDITS) {
  const n = raw.split(e.from).length - 1
  console.log(`${n === 1 ? 'OK  ' : 'FAIL'} x${n}  ${e.name}`)
  if (n !== 1) ok = false
}
if (!ok) { console.error('\n预检失败：锚点未唯一命中，拒绝写入（配置可能已被改动）'); process.exit(1) }

let out = raw
for (const e of EDITS) out = out.replace(e.from, e.to)

// ---- 回读校验：YAML 子集解析 + 厂商/模型计数 ----
function parseSettings(text) {
  const providers = {}
  let section = null, inProviders = false, cur = null, curModel = null, inModels = false
  const fm = () => { if (cur && curModel && curModel.id) cur.models.push(curModel); curModel = null }
  const fp = () => { fm(); if (cur && cur.id) providers[cur.id] = cur; cur = null; inModels = false }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const t = line.trim(); const indent = line.length - line.trimStart().length
    if (indent === 0 && t.endsWith(':')) { fp(); section = t.slice(0, -1); inProviders = false; continue }
    if (section !== 'llm-pi-ai') continue
    if (indent === 2 && t === 'providers:') { inProviders = true; continue }
    if (!inProviders) continue
    if (indent === 4 && t.endsWith(':')) { fp(); cur = { id: t.slice(0, -1), models: [] }; continue }
    if (!cur) continue
    if (indent === 6) { const m = /^([\w.-]+):\s*(.*)$/.exec(t); if (m && m[1] === 'models') inModels = true; continue }
    if (inModels && indent === 8 && t.startsWith('- ')) {
      fm(); const m = /^([\w.-]+):\s*(.*)$/.exec(t.slice(2))
      curModel = { id: m && m[1] === 'id' ? m[2].trim().replace(/^"|"$/g, '') : '' }; continue
    }
  }
  fp(); return providers
}
const before = parseSettings(raw)
const after = parseSettings(out)
const cnt = (p) => Object.values(p).reduce((a, b) => a + b.models.length, 0)
console.log(`\nparse before: ${Object.keys(before).length} providers / ${cnt(before)} models`)
console.log(`parse after : ${Object.keys(after).length} providers / ${cnt(after)} models`)
const diff = []
for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const b = (before[id]?.models || []).map((m) => m.id)
  const a = (after[id]?.models || []).map((m) => m.id)
  const removed = b.filter((x) => !a.includes(x))
  const added = a.filter((x) => !b.includes(x))
  if (removed.length || added.length) diff.push(`${id}: -[${removed}] +[${added}]`)
}
console.log('model diff:')
for (const d of diff) console.log('  ' + d)

// ---- 行尾/其它字段零改动校验 ----
const others = ['agent-default-model:', 'llm-deepseek:'].map((k) => {
  const seg = (txt) => { const i = txt.indexOf(k); return i < 0 ? '(missing)' : txt.slice(i, i + 120) }
  return `${k} unchanged=${seg(raw) === seg(out)}`
})
console.log('untouched check:', others.join(' | '))

if (!APPLY) { console.log('\n[dry-run] 未写入。加 --apply 执行。'); process.exit(0) }

// ---- 备份 + 原子写 ----
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const bak1 = `${SETTINGS}.bak-modelfix-${ts}`
copyFileSync(SETTINGS, bak1)
const dir = join(BACKUP_DIR, `modelfix-${ts.replace(/[-T]/g, '').slice(0, 14)}`)
mkdirSync(dir, { recursive: true })
copyFileSync(SETTINGS, join(dir, 'settings.yaml.before'))
writeFileSync(join(dir, 'settings.yaml.after'), out, 'utf8')
writeFileSync(join(dir, 'edits.md'), EDITS.map((e, i) => `## ${i + 1}. ${e.name}\n\n\`\`\`diff\n- ${e.from.split(EOL).join('\n- ')}\n+ ${e.to.split(EOL).join('\n+ ')}\n\`\`\`\n`).join('\n'), 'utf8')
console.log('\nbackup ->', bak1)
console.log('backup ->', dir)

const tmp = `${SETTINGS}.tmp-${process.pid}`
writeFileSync(tmp, out, 'utf8')
renameSync(tmp, SETTINGS)

const verify = readFileSync(SETTINGS, 'utf8')
const vp = parseSettings(verify)
console.log(`\nWROTE. re-read: ${Object.keys(vp).length} providers / ${cnt(vp)} models, bytes=${Buffer.byteLength(verify)}`)
console.log('CRLF preserved:', verify.includes('\r\n'))
console.log('changed lines:', EDITS.length)
