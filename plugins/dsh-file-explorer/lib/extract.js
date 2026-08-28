/**
 * @dsh-external/dsh-file-explorer — lib/extract.js
 *
 * 文档文本提取引擎（零依赖，纯 Node 内置 zlib；不派生子进程、不写盘）。
 *
 * 设计目标：
 *   1. 长期运行稳定：所有解析同步、有界（防 zip 炸弹/内存失控），每次提取独立
 *      try/catch，单文件损坏绝不拖垮面板或宿主进程。
 *   2. 可维护性：纯函数模块，不依赖 ctx/harness 服务；安全上限集中在 LIMITS 顶部。
 *   3. 可迭代性：EXTRACTORS 注册表——加新格式 = 加一个 `(buf) => string` 函数 +
 *      一个扩展名条目（后续如要升级 PDF 渲染，在注册表位置替换实现即可）。
 *
 * 安全说明：只按条目名读取 ZIP 内存条目、从不解压到磁盘 → 无路径穿越；
 * 只用正则抽文本、不用 XML 解析器 → 无 XXE；单条目解压有 maxOutputLength 上限。
 */
import { inflateSync, inflateRawSync } from 'node:zlib'

// ═══════════════ 安全上限（全部集中在此，改上限只动这里） ═══════════════
export const LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,   // 办公/PDF 文件读取上限（正文小，图片内嵌会让体积变大）
  maxImageBytes: 2 * 1024 * 1024,   // 图片 dataURL 上限（base64 会膨胀 1/3）
  maxEntryInflate: 8 * 1024 * 1024, // 单 ZIP 条目解压上限（防 zip 炸弹）
  maxEntries: 500,                  // ZIP 条目数上限
  maxTextBytes: 512 * 1024,         // 最终提取文本上限
}

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
}

// ═══════════════ 格式注册表（可迭代性：加格式 = 加一行 + 一个函数） ═══════════════
export const EXTRACTORS = {
  '.docx': extractDocx,
  '.xlsx': extractXlsx,
  '.pptx': extractPptx,
  '.pdf': extractPdf,
}

/** 旧版 OLE 二进制格式：零依赖无法解析，走"用系统程序打开"兜底。 */
const LEGACY_OFFICE = new Set(['doc', 'xls', 'ppt', 'rtf'])

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 文件分类：image / office（可提取文本）/ legacy（只能外部打开）/ other。 */
export function fileKind(name) {
  const ext = extOf(name)
  if (IMAGE_MIME[ext]) return { kind: 'image', mime: IMAGE_MIME[ext] }
  if (EXTRACTORS['.' + ext]) return { kind: 'office' }
  if (LEGACY_OFFICE.has(ext)) return { kind: 'legacy' }
  return { kind: 'other' }
}

/** 统一入口：按扩展名分派提取，失败返回空串（调用方据此走"打开"兜底）。 */
export function extractText(name, buf) {
  if (!buf || !buf.length) return ''
  try {
    const fn = EXTRACTORS['.' + extOf(name)]
    if (!fn) return ''
    let text = fn(buf)
    if (typeof text !== 'string' || !text.trim()) return ''
    // 统一换行/空白，压缩多余空行
    text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    const cap = Buffer.byteLength(text, 'utf8')
    if (cap > LIMITS.maxTextBytes) {
      // 超限按字节截断（尾部可能截断多字节字符，去掉替换符残留）
      text = Buffer.from(text, 'utf8').subarray(0, LIMITS.maxTextBytes).toString('utf8').replace(/\uFFFD+$/, '')
    }
    return text
  } catch {
    return ''
  }
}

// ═══════════════ ZIP 只读解析（内存 buffer，绝不写盘） ═══════════════
// 只读中央目录 + 按条目名取数据；不校验 CRC（预览场景省 CPU）。
const EOCD_SIG = 0x06054b50
const CDH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

/** 解析 ZIP 中央目录，返回 [{ name, method, csize, dataStart }]，条目数超限抛错。 */
function zipEntries(buf) {
  // 1) 定位 EOCD（签名固定，从文件尾向前找，最大 64KB+22 注释区）
  const tailLen = Math.min(buf.length, 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= buf.length - tailLen; i--) {
    if (i < 0) break
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录尾）')
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (total > LIMITS.maxEntries) throw new Error(`ZIP 条目过多（${total}，上限 ${LIMITS.maxEntries}）`)
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 目录越界')

  // 2) 遍历中央目录
  const out = []
  let pos = cdOffset
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CDH_SIG) throw new Error('ZIP 目录损坏')
    const method = buf.readUInt16LE(pos + 10)
    const csize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen).replace(/^\.\//, '')
    out.push({ name, method, csize, localOffset })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 取某条目的解压数据（stored=0 直读，deflate=8 inflateRaw，其他抛错）。 */
function readZipEntry(buf, entry) {
  if (entry.csize > LIMITS.maxEntryInflate) throw new Error(`条目过大（${entry.name}）`)
  const lfh = entry.localOffset
  if (lfh + 30 > buf.length || buf.readUInt32LE(lfh) !== LFH_SIG) throw new Error('ZIP 局部头损坏')
  const nameLen = buf.readUInt16LE(lfh + 26)
  const extraLen = buf.readUInt16LE(lfh + 28)
  const start = lfh + 30 + nameLen + extraLen
  if (start + entry.csize > buf.length) throw new Error('ZIP 数据越界')
  const data = buf.subarray(start, start + entry.csize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: LIMITS.maxEntryInflate })
    } catch (e) {
      throw new Error(`解压失败（${entry.name}）：${e.message || e}`)
    }
  }
  throw new Error(`不支持的压缩方式（${entry.name} method=${entry.method}）`)
}

// ═══════════════ 提取器：docx / xlsx / pptx ═══════════════

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)) } catch { return '' } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

/**
 * docx（Word 2007+）：抽 word/document.xml（+ 页眉页脚）。
 * 排版近似：段落→换行、制表符→\t、表格单元格/行→\t/\n、软换行→\n。
 */
function extractDocx(buf) {
  const entries = zipEntries(buf)
  const wanted = entries
    .filter((e) => /^word\/(document|header\d*|footer\d*)\.xml$/i.test(e.name))
    .sort((a, b) => (a.name === 'word/document.xml' ? -1 : b.name === 'word/document.xml' ? 1 : a.name < b.name ? -1 : 1))
  if (!wanted.length) throw new Error('docx 缺少 word/document.xml')
  let out = ''
  for (const entry of wanted) {
    const xml = readZipEntry(buf, entry).toString('utf8')
    // 字段代码（TOC/页码域）与删除文本不进入预览
    let t = xml.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    t = t.replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    // 段落/换行/制表/表格换行
    t = t.replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n').replace(/<w:tab\/>/g, '\t')
    t = t.replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')
    t = t.replace(/<[^>]+>/g, '') // 其余标签全剥
    out += decodeXmlEntities(t) + '\n'
  }
  return out
}

/**
 * xlsx（Excel 2007+）：sharedStrings + 各工作表。
 * 每行单元格以 \t 分隔、行以 \n 分隔；共享字符串/内联字符串/公式结果/数值全覆盖。
 */
function extractXlsx(buf) {
  const entries = zipEntries(buf)
  const readXml = (name) => {
    const e = entries.find((x) => x.name === name)
    return e ? readZipEntry(buf, e).toString('utf8') : null
  }
  // 共享字符串表
  const shared = []
  const ssXml = readXml('xl/sharedStrings.xml')
  if (ssXml) {
    const siRe = /<si>([\s\S]*?)<\/si>/g
    let m
    while ((m = siRe.exec(ssXml)) !== null) {
      const runs = []
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
      let tm
      while ((tm = tRe.exec(m[1])) !== null) runs.push(decodeXmlEntities(tm[1]))
      shared.push(runs.join(''))
    }
  }
  // 工作表按编号排序
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  if (!sheets.length) throw new Error('xlsx 缺少工作表')
  const out = []
  for (const sheet of sheets) {
    const xml = readZipEntry(buf, sheet).toString('utf8')
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rowRe.exec(xml)) !== null) {
      const cells = []
      const cellRe = /<c[^>]*>([\s\S]*?)<\/c>/g
      let cm
      while ((cm = cellRe.exec(rm[1])) !== null) {
        const cell = cm[0]
        const tMatch = /<c[^>]*\bt="([^"]+)"/.exec(cell)
        const t = tMatch ? tMatch[1] : ''
        let val = ''
        if (t === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(cm[1])
          if (v) { const idx = parseInt(v[1], 10); val = shared[idx] != null ? shared[idx] : '' }
        } else if (t === 'inlineStr') {
          const it = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[1])
          if (it) val = decodeXmlEntities(it[1])
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(cm[1])
          if (v) val = decodeXmlEntities(v[1])
        }
        cells.push(val)
      }
      // 去掉行尾空单元格，保留中间空位
      while (cells.length && cells[cells.length - 1] === '') cells.pop()
      if (cells.length) out.push(cells.join('\t'))
    }
  }
  return out.join('\n')
}

/**
 * pptx（PowerPoint 2007+）：抽各幻灯片 <a:p> 段落文本，幻灯片间加分隔线。
 */
function extractPptx(buf) {
  const entries = zipEntries(buf)
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  if (!slides.length) throw new Error('pptx 缺少幻灯片')
  const out = []
  slides.forEach((slide, i) => {
    const xml = readZipEntry(buf, slide).toString('utf8')
    const lines = []
    const pRe = /<a:p[^>]*>([\s\S]*?)<\/a:p>/g
    let pm
    while ((pm = pRe.exec(xml)) !== null) {
      const runs = []
      const tRe = /<a:t>([\s\S]*?)<\/a:t>/g
      let tm
      while ((tm = tRe.exec(pm[1])) !== null) runs.push(decodeXmlEntities(tm[1]))
      const line = runs.join('').trim()
      if (line) lines.push(line)
    }
    if (lines.length) {
      out.push(`--- 幻灯片 ${i + 1} ---`)
      out.push(lines.join('\n'))
    }
  })
  return out.join('\n')
}

// ═══════════════ 提取器：pdf（尽力而为） ═══════════════

/** 解码 PDF 文本串字节：合法 UTF-8 用 UTF-8，否则按 Latin-1（西文 PDF 常见）。 */
function decodePdfBytes(buf) {
  const asUtf8 = buf.toString('utf8')
  if (!asUtf8.includes('\uFFFD')) return asUtf8
  return buf.toString('latin1')
}

/** 从 PDF 内容流中抽取文本（Tj/TJ/引号操作符 + 移动操作符换行）。 */
function pdfContentText(raw) {
  const chunks = []
  let pending = ''
  let i = 0
  const push = () => {
    if (pending.trim()) chunks.push(pending.replace(/\s+/g, ' ').trim())
    pending = ''
  }
  while (i < raw.length) {
    const c = raw[i]
    if (c === '(') {
      // 字面量字符串（含转义）
      let j = i + 1
      let s = ''
      let depth = 1
      while (j < raw.length && depth > 0) {
        const ch = raw[j]
        if (ch === '\\') {
          const nx = raw[j + 1]
          if (nx === 'n') s += '\n'
          else if (nx === 'r') s += '\r'
          else if (nx === 't') s += '\t'
          else if (nx === 'b' || nx === 'f') s += ' '
          else if (nx === '(' || nx === ')' || nx === '\\') s += nx
          else if (nx >= '0' && nx <= '7') {
            const oct = raw.slice(j + 1, j + 4)
            if (/^[0-7]{3}$/.test(oct)) { s += String.fromCharCode(parseInt(oct, 8)); j += 2 } // 外层再 +2 共消费 4 字符
          } else if (nx !== undefined) s += nx
          j += 2
          continue
        }
        if (ch === '(') depth++
        else if (ch === ')') { depth--; if (depth === 0) break }
        else s += ch
        j++
      }
      pending += s
      i = j + 1
    } else if (c === '<' && raw[i + 1] !== '<') {
      // 十六进制字符串 <...>
      const end = raw.indexOf('>', i)
      if (end > i + 1) {
        const hex = raw.slice(i + 1, end).replace(/\s+/g, '')
        if (hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex)) {
          const bytes = Buffer.from(hex, 'hex')
          pending += decodePdfBytes(bytes)
        }
        i = end + 1
      } else i++
    } else if (c === 'T' && raw[i + 1] === '*') {
      // 下一行（无位移）
      push()
      i += 2
    } else if (c === 'T' && (raw[i + 1] === 'D' || raw[i + 1] === 'd')) {
      // 位移到下一行（TD/Td 也常用来分行）
      push()
      i += 2
    } else if (c === 'E' && raw[i + 1] === 'T') {
      // 文本块结束
      push()
      i += 2
    } else {
      i++
    }
  }
  push()
  return chunks.join('\n')
}

/**
 * 提取文本质量启发式：CID 字体 PDF 常把字形码当文本解出（大量控制符/高字节乱码），
 * 这类结果直接放弃——宁可提示"用系统程序打开"，也不展示乱码（实测 CNKI/部分学位论文 PDF）。
 */
function isGarbageText(text) {
  if (!text) return true
  let total = 0, ctrl = 0, latin1 = 0, cjk = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    total++
    if ((code >= 0x00 && code <= 0x1f && code !== 0x0a && code !== 0x0d && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) ctrl++
    else if (code >= 0x80 && code <= 0xff) latin1++
    else if (code >= 0x4e00 && code <= 0x9fff) cjk++
  }
  if (!total) return true
  const ctrlR = ctrl / total
  const latin1R = latin1 / total
  const cjkR = cjk / total
  if (ctrlR > 0.15) return true
  if (latin1R > 0.25 && cjkR < 0.1) return true
  return false
}

/** 从 PDF 字节中找出 FlateDecode 流并解压为内容流文本（best-effort）。 */
function extractPdf(buf) {
  let found = false
  let out = ''
  const maxStreams = 200
  let scanned = 0
  // 逐流扫描：`stream<EOL>...endstream`
  for (let idx = buf.indexOf(Buffer.from('stream')); idx !== -1 && scanned < maxStreams; idx = buf.indexOf(Buffer.from('stream'), idx + 1)) {
    scanned++
    // 向前找字典，确认 FlateDecode /Fl
    const dictStart = Math.max(0, idx - 2048)
    const dict = buf.toString('latin1', dictStart, idx)
    if (!/\/FlateDecode|\/Fl\b/.test(dict)) continue
    // 跳过 stream 后的换行符（\r\n 或 \n 或 \r）
    let dataStart = idx + 6
    if (buf[dataStart] === 0x0d) dataStart++
    if (buf[dataStart] === 0x0a) dataStart++
    const endMark = buf.indexOf(Buffer.from('endstream'), dataStart)
    if (endMark < 0) continue
    const data = buf.subarray(dataStart, endMark)
    if (!data.length) continue
    let infl
    try {
      infl = inflateSync(data, { maxOutputLength: LIMITS.maxEntryInflate })
    } catch {
      try { infl = inflateRawSync(data, { maxOutputLength: LIMITS.maxEntryInflate }) } catch { continue }
    }
    const text = pdfContentText(infl.toString('latin1'))
    if (text.trim()) { found = true; out += (out ? '\n' : '') + text }
  }
  if (!found) throw new Error('PDF 未提取到文本（可能是扫描件/复杂排版）')
  if (isGarbageText(out)) throw new Error('PDF 未提取到可读文本（扫描件或字体映射复杂）')
  return out
}
