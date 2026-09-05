#!/usr/bin/env node
/**
 * apply-picker-utf16-patch.mjs
 * ---------------------------------------------------------------------------
 * Windows 目录选择器 UTF-16 NUL 误判修复（upstream 0.1.2 已修，本地 0.1.1-rc.2
 * 需要补丁；升级后本脚本自动退役）。
 *
 * 根因（2026-09-04 phase1.2 定位，见 docs/UPSTREAM-UPDATE-PREP.md）：
 *   dsh-host-directory-picker-native/lib/worker.cjs 的 readUtf16() 逐码元扫描
 *   时只检查 UTF-16LE 码元的【低字节】是否为 0：
 *     while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;
 *   汉字「开」= U+5F00 -> LE 字节 [0x00,0x5F]，低字节恰为 0x00，被误判为
 *   NUL 终止符 -> 路径在「开」前被截断。所有 U+xx00 区块汉字（一/开/方...）
 *   均触发。正确判定 = 低、高两字节同时为 0。
 *
 * 补丁策略（对齐补丁体系规范）：
 *   - marker: DSH-2026-09-04 picker-utf16-nul fix
 *   - 原子替换（tmp + rename），不改写其他内容
 *   - 版本锚定自动退役：目标文件若已不含 buggy 模式（升级到 0.1.2+）则跳过
 *   - verify-patches.ps1 含对应校验项；重建后重跑本脚本即可
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = 'DSH-2026-09-04 picker-utf16-nul fix'
const BUGGY = 'while (end + 1 < bytes.length && bytes[end] !== 0) end += 2;'
const FIXED = `while (end + 1 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0)) end += 2; /* ${MARKER} */`

function resolveUnpackedRoot() {
  const out = execFileSync(process.execPath, [join(HERE, 'resolve-dist.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const build = JSON.parse(out.slice(out.indexOf('{')))
  if (!build?.unpackedRoot) throw new Error('resolve-dist.mjs returned no unpackedRoot')
  return build.unpackedRoot
}

/** 逻辑复现自检（无需 GUI）：老逻辑在 U+5F00 处截断，新逻辑完整返回。 */
function readUtf16Sim(bytes, fixed) {
  let end = 0
  while (end + 1 < bytes.length && (fixed ? !(bytes[end] === 0 && bytes[end + 1] === 0) : bytes[end] !== 0)) end += 2
  return Buffer.from(bytes).toString('utf16le', 0, end)
}

function selftest() {
  const path = 'D:\\开文件夹\\sub'
  const bytes = Buffer.from(path, 'utf16le')
  const oldOut = readUtf16Sim(bytes, false)
  const newOut = readUtf16Sim(bytes, true)
  console.log(`[picker-utf16] selftest path: ${path}`)
  console.log(`[picker-utf16] old logic -> ${JSON.stringify(oldOut)} ${oldOut === 'D:\\' ? '(TRUNCATED = bug reproduced)' : '(unexpected)'}`)
  console.log(`[picker-utf16] new logic -> ${JSON.stringify(newOut)} ${newOut === path ? '(OK)' : '(FAIL)'}`)
  return oldOut === 'D:\\' && newOut === path
}

function main() {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1)
  }
  if (!selftest()) {
    console.log('[picker-utf16] selftest FAILED, aborting')
    process.exit(1)
  }
  const target = join(resolveUnpackedRoot(), 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs')
  let text
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    console.log(`[picker-utf16] target missing: ${target} -> nothing to do`)
    process.exit(0)
  }
  if (text.includes(MARKER)) {
    console.log('[picker-utf16] already applied (marker present)')
    process.exit(0)
  }
  if (!text.includes(BUGGY)) {
    console.log('[picker-utf16] buggy pattern not found (upstream fixed?) -> AUTO-RETIRE, nothing to do')
    process.exit(0)
  }
  const patched = text.replace(BUGGY, FIXED)
  if (patched === text) {
    console.log('[picker-utf16] replace produced no change, aborting')
    process.exit(1)
  }
  const tmp = `${target}.patch-tmp-${process.pid}`
  writeFileSync(tmp, patched, 'utf8')
  renameSync(tmp, target)
  const after = readFileSync(target, 'utf8')
  if (!after.includes(MARKER) || after.includes(BUGGY)) {
    console.log('[picker-utf16] post-write verify FAILED (rollback not attempted; check file)')
    process.exit(1)
  }
  console.log(`[picker-utf16] applied + verified: ${target}`)
  console.log('[picker-utf16] note: worker.cjs is spawned per dialog; takes effect without restart')
}

main()
