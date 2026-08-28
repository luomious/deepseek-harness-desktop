/**
 * @dsh-external/dsh-file-explorer — test/window.test.mjs
 *
 * 文本分段预览单测：UTF-8 边界对齐（纯函数）+ 窗口翻页无损拼接（夹具文件）。
 * 运行：node plugins/dsh-file-explorer/test/window.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { alignUtf8Offset, readTextWindow, TEXT_WINDOW_BYTES } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'window-bytes.txt')

test('TEXT_WINDOW_BYTES 为 128KB（小于高亮上限 200KB，窗口内高亮可用）', () => {
  assert.equal(TEXT_WINDOW_BYTES, 128 * 1024)
})

test('alignUtf8Offset：字符边界与字符内部', () => {
  const b = Buffer.from('你abc', 'utf8') // E4 BD A0 61 62 63
  assert.equal(alignUtf8Offset(b, 0), 0)
  assert.equal(alignUtf8Offset(b, 1), 0, 'BD 延续字节 → 回退到领头字节')
  assert.equal(alignUtf8Offset(b, 2), 0, 'A0 延续字节 → 回退到领头字节')
  assert.equal(alignUtf8Offset(b, 3), 3, 'ASCII 处即边界')
  assert.equal(alignUtf8Offset(b, 4), 4)
  assert.equal(alignUtf8Offset(b, b.length), b.length, '越界不动')
})

test('alignUtf8Offset：回退不越过字符', () => {
  const b = Buffer.from('a你b', 'utf8') // 61 E4 BD A0 62
  assert.equal(alignUtf8Offset(b, 2), 1, 'BD → 回退到 E4')
  assert.equal(alignUtf8Offset(b, 3), 1, 'A0 → 回退到 E4')
  assert.equal(alignUtf8Offset(b, 4), 4, 'ASCII b 边界')
})

test('readTextWindow：奇数窗口翻页拼接无损、无半个字符', () => {
  const raw = readFileSync(FIXTURE)
  const total = raw.length
  let offset = 0
  const parts = []
  let pages = 0
  while (true) {
    const w = readTextWindow(FIXTURE, offset, 17) // 17 字节窗口必然切在多字节字符中间
    assert.ok(!w.content.includes('\uFFFD'), '窗口内不出现替换符')
    assert.ok(w.offset > offset || !w.hasMore, 'offset 单调推进')
    parts.push(w.content)
    pages++
    if (!w.hasMore) break
    offset = w.offset
  }
  assert.ok(pages > 5, '确实分了多页')
  const joined = parts.join('')
  assert.equal(Buffer.byteLength(joined, 'utf8'), total, '拼接字节数一致（无丢失/重复）')
  assert.equal(joined, raw.toString('utf8'), '拼接内容逐字节一致')
})

test('readTextWindow：越界 offset 返回空且 hasMore=false', () => {
  const total = readFileSync(FIXTURE).length
  const w = readTextWindow(FIXTURE, total + 100, 17)
  assert.equal(w.content, '')
  assert.equal(w.hasMore, false)
  assert.equal(w.offset, total)
})
