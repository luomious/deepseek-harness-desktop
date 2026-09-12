/**
 * tests/fixtures/zstd-golden/generate.mjs — 再生成 zstd golden fixture。
 *
 * 用法：node tests/fixtures/zstd-golden/generate.mjs
 *   （可选 env DSH_SESSION_LIB=<dsh-session lib 绝对路径>，默认用 vendor dev 树）
 *
 * 产物（与本脚本同目录，提交进仓库）：
 *   - session-golden.jsonl          明文期望（头行 + 6 事件行，含中文/长行）
 *   - session-golden.jsonl.zstd     3 个独立 zstd 帧（checksum 开，模拟真实 append 分批写盘）
 *   - session-golden-torn.jsonl.zstd 同上但最后一帧截断 40%（torn 写恢复 fixture）
 *   - manifest.json                 id/cwd/帧布局/各文件 sha256
 *
 * 只在「有意变更 golden」时运行；平时测试只读 fixture 并校验 sha。
 * 帧布局（test 依赖此定义；内核 assertZstdHeaderFrame 要求**首帧恰好一行头**）：
 *   frame1 = header 行（仅头）
 *   frame2 = batch1（3 事件）
 *   frame3 = batch2（1 条 60KB 长事件）
 *   frame4 = batch3（2 事件）；torn fixture 截断此帧
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync, constants } from 'node:zlib'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const DEFAULT_SESSION_LIB = join(REPO, 'vendor', 'deepseek-harness-desktop', 'dsh-plugin-desktop',
  'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')

// 头行 version 必须等于内核当前 SESSION_FORMAT_VERSION，否则 refuseForeignFormatVersion 拒读
const { SESSION_FORMAT_VERSION } = await import(pathToFileURL(process.env.DSH_SESSION_LIB || DEFAULT_SESSION_LIB).href)

const ID = 'golden-session-0001'
const CWD = 'D:/golden-project'
const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: ID, createdAt: 1757587200000, cwd: CWD, delegationDepth: 0 }
const headerLine = JSON.stringify(header)

const batch1 = [
  { type: 'user-message', text: '你好，世界 — zstd golden ✅（含中文与 emoji）', seq: 0 },
  { type: 'assistant-message', text: '回复正文', usage: { inputTokens: 11, outputTokens: 31 }, seq: 1 },
  { type: 'tool-call', name: 'read_file', args: { path: 'src/index.ts' }, seq: 2 },
]
const batch2 = [{ type: 'assistant-message', text: 'L'.repeat(60_000), seq: 3 }]
const batch3 = [
  { type: 'user-message', text: 'second turn', seq: 4 },
  { type: 'tool-result', content: 'ok', seq: 5 },
]
const lines = (batch) => batch.map((r) => JSON.stringify(r) + '\n').join('')

// 明文 = 头 + 全部事件（每行 \n 结尾，与真实写盘一致）
const plaintext = headerLine + '\n' + lines(batch1) + lines(batch2) + lines(batch3)

// 帧与写盘同构：checksum flag 开（同补丁 CHECKSUM_OPTIONS）；首帧恰好一行头（assertZstdHeaderFrame）
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const frame1 = zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), CHECKSUM)
const frame2 = zstdCompressSync(Buffer.from(lines(batch1), 'utf8'), CHECKSUM)
const frame3 = zstdCompressSync(Buffer.from(lines(batch2), 'utf8'), CHECKSUM)
const frame4 = zstdCompressSync(Buffer.from(lines(batch3), 'utf8'), CHECKSUM)
const full = Buffer.concat([frame1, frame2, frame3, frame4])
const torn = Buffer.concat([frame1, frame2, frame3, frame4.subarray(0, Math.floor(frame4.length * 0.4))])

const sha = (b) => createHash('sha256').update(b).digest('hex')
// torn 期望：完整帧（frame1-3 = 头 + batch1 + batch2）解码出的明文 —— readRaw 对 torn 尾帧的省略语义
const completeFramesPlaintext = headerLine + '\n' + lines(batch1) + lines(batch2)
const manifest = {
  note: '由 generate.mjs 生成；重生成需有意为之并复核 sha 变化',
  id: ID,
  cwd: CWD,
  sessionFormatVersion: SESSION_FORMAT_VERSION,
  headerLine,
  frameLayout: ['header(仅头)', 'batch1(3)', 'batch2(1 long)', 'batch3(2)'],
  tornCutRatio: 0.4,
  eventCount: batch1.length + batch2.length + batch3.length,
  completeFrameEventCount: batch1.length + batch2.length,
  sha256: {
    'session-golden.jsonl': sha(Buffer.from(plaintext, 'utf8')),
    'session-golden.jsonl.zstd': sha(full),
    'session-golden-torn.jsonl.zstd': sha(torn),
    completeFramesPlaintext: sha(Buffer.from(completeFramesPlaintext, 'utf8')),
  },
}

mkdirSync(HERE, { recursive: true })
writeFileSync(join(HERE, 'session-golden.jsonl'), plaintext, 'utf8')
writeFileSync(join(HERE, 'session-golden.jsonl.zstd'), full)
writeFileSync(join(HERE, 'session-golden-torn.jsonl.zstd'), torn)
writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`generated: version=${SESSION_FORMAT_VERSION} frames=${frame1.length}/${frame2.length}/${frame3.length} plaintext=${plaintext.length}B full=${full.length}B torn=${torn.length}B`)
