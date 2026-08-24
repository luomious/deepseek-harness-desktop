// Remove the stray `disabled: true` entry for dsh-model-tier-router that
// dev_uninject_plugin appended to the profile cordis.patch.yml. Byte-exact:
// only the UTF-8 bytes of the appended block are spliced out; the rest of the
// (mixed-encoding) file is preserved untouched.
const fs = require('fs')
const path = require('path')

const p = process.env.DSH_PATCH_PATH || path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.dsh', 'profiles', 'desktop', 'cordis.patch.yml',
)

const buf = fs.readFileSync(p)
const entry = Buffer.from(
  '# 已卸载插件（@dsh-external/dsh-model-tier-router）：disabled 阻断其 bundle patch 自装配\n'
  + '- id: dsh-model-tier-router\n'
  + '  disabled: true\n',
  'utf8',
)

let idx = buf.indexOf(entry)
if (idx === -1) {
  // Fallback: anchor on the ASCII entry only, then remove the preceding comment line.
  const ascii = Buffer.from('- id: dsh-model-tier-router\n  disabled: true\n', 'utf8')
  const aIdx = buf.indexOf(ascii)
  if (aIdx === -1) {
    console.error('ANCHOR NOT FOUND; file left unchanged')
    process.exit(2)
  }
  // Find the start of the comment line preceding this entry (walk back to the '#').
  let lineStart = aIdx
  while (lineStart > 0 && buf[lineStart - 1] !== 0x0a) lineStart -= 1
  idx = lineStart
  // remove through end of ascii entry + its trailing newline
  const end = aIdx + ascii.length
  const before = buf.subarray(0, idx)
  const after = buf.subarray(end)
  fs.writeFileSync(p, Buffer.concat([before, after]))
  console.log('REMOVED (fallback) bytes=', end - idx, 'new length=', before.length + after.length)
  process.exit(0)
}

// entry may be preceded by a newline separator; drop one leading '\n' to avoid
// leaving a stray blank line.
let start = idx
if (start > 0 && buf[start - 1] === 0x0a) start -= 1
const end = idx + entry.length
const before = buf.subarray(0, start)
const after = buf.subarray(end)
fs.writeFileSync(p, Buffer.concat([before, after]))
console.log('REMOVED bytes=', end - start, 'new length=', before.length + after.length)
