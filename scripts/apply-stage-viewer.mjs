// Patch dsh-diagram-renderer client.js: splice StageViewer + wire stages data.
// v6 staged diagrams: envelope carries stages, turnTail passes them down,
// DiagramViewer renders StageViewer when stages present (else existing view).
import fs from 'node:fs'
import path from 'node:path'

const CLIENT = path.join(import.meta.dirname, '..', 'plugins', 'dsh-diagram-renderer', 'lib', 'client.js')
const SNIP = path.join(import.meta.dirname, '..', 'plugins', 'dsh-diagram-renderer', 'stage-viewer.snippet.js')

let s = fs.readFileSync(CLIENT, 'utf8')
const snippet = fs.readFileSync(SNIP, 'utf8').replace(/\s+$/, '')
const changed = []

function mustReplace(src, find, repl, label) {
  const i = src.indexOf(find)
  if (i < 0) throw new Error('anchor not found: ' + label)
  if (src.indexOf(find, i + find.length) !== -1) throw new Error('anchor not unique: ' + label)
  changed.push(label)
  return src.slice(0, i) + repl + src.slice(i + find.length)
}

// 1. insert StageViewer component before DiagramViewer (idempotent)
if (s.indexOf('function StageViewer(props)') === -1) {
  const a1 = '    function DiagramViewer(props) {'
  s = mustReplace(s, a1, snippet + '\n\n' + a1, '1-insert StageViewer')
}

// 2. DiagramViewer: accept stages prop
const a2 = '      var fileBase = props.fileBase'
s = mustReplace(s, a2, a2 + '\n      var stages = props.stages', '2-stages prop')

// 3. staged early return before the existing (static) return
const a3 = '      // Wider than the message column: negative-margin bleed (graceful).'
const stagedBlock = [
  '      // v6 staged diagrams: multi-step diagrams get the interactive StageViewer.',
  '      if (Array.isArray(stages) && stages.length > 0) {',
  '        return React.createElement(StageViewer, {',
  '          boxedSvg: sizedSvg, stages: stages, title: title, fileBase: fileBase',
  '        })',
  '      }',
  '      // Wider than the message column: negative-margin bleed (graceful).'
].join('\n')
s = mustReplace(s, a3, stagedBlock, '3-staged early return')

// 4. envelope item carries stages (svg diagrams only)
const a4 = "item = { svg: parsed.svg, title: (parsed.meta && parsed.meta.title) || '', path: (parsed.meta && parsed.meta.path) || '' }"
const r4 = "item = { svg: parsed.svg, title: (parsed.meta && parsed.meta.title) || '', path: (parsed.meta && parsed.meta.path) || '', stages: (parsed.meta && parsed.meta.stages) || undefined }"
s = mustReplace(s, a4, r4, '4-item stages')

// 5. turnTail passes stages to DiagramViewer
const a5 = "React.createElement(DiagramViewer, { key: key, svg: d.svg, title: d.title, fileBase: basename(d.path) })"
const r5 = "React.createElement(DiagramViewer, { key: key, svg: d.svg, title: d.title, fileBase: basename(d.path), stages: d.stages })"
s = mustReplace(s, a5, r5, '5-turnTail stages')

fs.writeFileSync(CLIENT + '.new', s, 'utf8')
// 2026-09-06 审计修复：原只写 .new 从不 rename，脚本实际不生效。
// 原子替换：备份 -> 删旧 -> rename（Windows rename 不覆盖已存在文件）。
if (fs.existsSync(CLIENT)) {
  fs.mkdirSync(path.join(import.meta.dirname, '..', '_backups'), { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(import.meta.dirname, '..', '_backups', `diagram-renderer-client.js.bak-${ts}`)
  fs.copyFileSync(CLIENT, bak)
  fs.unlinkSync(CLIENT)
}
fs.renameSync(CLIENT + '.new', CLIENT)
console.log('OK: ' + changed.join(' | ') + ' | bytes ' + Buffer.byteLength(s))