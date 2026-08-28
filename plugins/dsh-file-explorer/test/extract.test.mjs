/**
 * @dsh-external/dsh-file-explorer — test/extract.test.mjs
 *
 * 提取引擎单测：内存生成合法 ZIP（含真实 CRC32）夹具，不依赖外部文件。
 * 覆盖：docx / xlsx / pptx / pdf 提取、ZIP 结构错误拒绝、条目数上限、格式分类。
 * 运行：node --test plugins/dsh-file-explorer/test/extract.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { extractText, fileKind, EXTRACTORS, LIMITS } from '../lib/extract.js'

// ═══════════════ 内存 ZIP 构建器（生成可被真实解压器打开的合法 zip） ═══════════════

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** entries: [{ name, data: string|Buffer, method?: 0|8|其他 }] —— method 缺省 8（deflate）；0=stored；其他值直接写入目录声明（用于负例）。 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data
    const method = e.method === undefined ? 8 : e.method
    const comp = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)      // version needed
    lfh.writeUInt16LE(0, 6)       // flags
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(0, 10)      // time
    lfh.writeUInt16LE(0, 12)      // date
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)      // extra len
    locals.push(Buffer.concat([lfh, nameBuf, comp]))
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)       // version made by
    cd.writeUInt16LE(20, 6)       // version needed
    cd.writeUInt16LE(0, 8)        // flags
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)       // time
    cd.writeUInt16LE(0, 14)       // date
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)       // extra len
    cd.writeUInt16LE(0, 32)       // comment len
    cd.writeUInt16LE(0, 34)       // disk start
    cd.writeUInt16LE(0, 36)       // internal attrs
    cd.writeUInt32LE(0, 38)       // external attrs
    cd.writeUInt32LE(offset, 42)  // local header offset
    centrals.push(Buffer.concat([cd, nameBuf]))
    offset += locals[locals.length - 1].length
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, eocd])
}

// ═══════════════ 夹具 ═══════════════

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>World</w:t></w:r></w:p>
<w:p><w:r><w:t>第二行 &amp; 测试</w:t></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CellA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>CellB</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>名称</t></si><si><r><t>富文本</t></r><r><t>拼接</t></r></si>
</sst>`

const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>内联</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`

const SLIDE1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:p><a:r><a:t>Slide One Title</a:t></a:r></a:p>
<a:p><a:r><a:t>Body 内容</a:t></a:r></a:p>
</p:sld>`

function makeDocx() {
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships/>' },
    { name: 'word/document.xml', data: DOCX_XML },
  ])
}

function makeXlsx() {
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/sharedStrings.xml', data: SHARED_STRINGS },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET1 },
    { name: 'xl/worksheets/sheet2.xml', data: SHEET1 },
  ])
}

function makePptx() {
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'ppt/slides/slide1.xml', data: SLIDE1 },
    { name: 'ppt/slides/slide2.xml', data: SLIDE1.replace('Slide One', 'Slide Two') },
  ])
}

/** 最小 PDF：单个 FlateDecode 流，含 Tj 与 T* 换行。 */
function makePdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello PDF) Tj T* (Second Line) Tj ET'
  const stream = deflateRawSync(Buffer.from(content, 'latin1'))
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1')
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1')
  return Buffer.concat([head, stream, tail])
}

// ═══════════════ 用例 ═══════════════

test('docx：段落/制表符/表格/实体/域代码', () => {
  const text = extractText('test.docx', makeDocx())
  assert.ok(text.includes('Hello'), '含 Hello')
  assert.ok(text.includes('World'), '含 World')
  assert.ok(text.includes('第二行 & 测试'), '中文 + 实体解码')
  assert.ok(text.includes('CellA') && text.includes('CellB'), '表格单元格')
  assert.ok(!text.includes('TOC'), '域代码不进入预览')
  assert.ok(text.includes('\t'), '制表符保留')
})

test('xlsx：共享字符串/内联字符串/数值/多工作表', () => {
  const text = extractText('book.xlsx', makeXlsx())
  assert.ok(text.includes('名称'), '共享字符串')
  assert.ok(text.includes('富文本拼接'), '富文本运行拼接')
  assert.ok(text.includes('42'), '数值单元格')
  assert.ok(text.includes('内联'), '内联字符串')
  assert.ok((text.match(/名称/g) || []).length === 2, '两个工作表都解析')
})

test('pptx：逐幻灯片文本与编号', () => {
  const text = extractText('deck.pptx', makePptx())
  assert.ok(text.includes('Slide One Title'), '第一张')
  assert.ok(text.includes('Slide Two Title'), '第二张')
  assert.ok(text.includes('--- 幻灯片 2 ---'), '幻灯片分隔')
  assert.ok(text.includes('Body 内容'), '中文正文')
})

test('pdf：FlateDecode 流 + Tj/T* 换行', () => {
  const text = extractText('paper.pdf', makePdf())
  assert.ok(text.includes('Hello PDF'), 'Tj 文本')
  assert.ok(text.includes('Second Line'), 'T* 分行文本')
})

test('格式分类 fileKind', () => {
  assert.equal(fileKind('a.docx').kind, 'office')
  assert.equal(fileKind('b.xlsx').kind, 'office')
  assert.equal(fileKind('c.pptx').kind, 'office')
  assert.equal(fileKind('d.pdf').kind, 'office')
  assert.equal(fileKind('e.png').kind, 'image')
  assert.equal(fileKind('f.svg').kind, 'image')
  assert.equal(fileKind('g.jpg').kind, 'image')
  assert.equal(fileKind('h.doc').kind, 'legacy')
  assert.equal(fileKind('i.xls').kind, 'legacy')
  assert.equal(fileKind('j.rtf').kind, 'legacy')
  assert.equal(fileKind('k.txt').kind, 'other')
  assert.equal(fileKind('README').kind, 'other')
})

test('容错：非 ZIP 内容 → 空串（调用方走兜底）', () => {
  assert.equal(extractText('bad.docx', Buffer.from('this is not a zip at all...')), '')
})

test('安全：条目数超限拒绝（zip 炸弹面）', () => {
  const many = []
  for (let i = 0; i < LIMITS.maxEntries + 1; i++) many.push({ name: `f${i}.txt`, data: 'x' })
  const buf = makeZip(many)
  // makeZip 本身合法，但解析器应拒绝超限
  assert.equal(extractText('bomb.zip', buf), '')
})

test('安全：不支持的压缩方式 → 空串', () => {
  const buf = makeZip([{ name: 'word/document.xml', data: 'x', method: 99 }])
  assert.equal(extractText('x.docx', buf), '')
})

test('EXTRACTORS 注册表完整性', () => {
  for (const ext of ['.docx', '.xlsx', '.pptx', '.pdf']) {
    assert.equal(typeof EXTRACTORS[ext], 'function', ext + ' 有提取器')
  }
})
