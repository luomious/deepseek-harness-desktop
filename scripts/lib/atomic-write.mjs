/**
 * scripts/lib/atomic-write.mjs — 原子写助手（落实 AGENTS.md「原子写纪律」）
 *
 * 为什么要它：直接 `writeFileSync(file, text)` 是「截断 + 写入」，写入过程中磁盘上存在
 * **半写文件**。而本仓有多条并行读取路径会撞上这个中间态：
 *   - 桌面应用启动加载器（读壳 lib/ 与内核 bundle）；
 *   - 前端按请求读盘的 client bundle（`plugins/<name>/lib/client.js`，改完刷新即生效）；
 *   - 并行会话的巡检 / 门禁脚本。
 * 2026-08-29 事故（file-explorer 顶层 `return` 的写中间态被启动加载器读到 → 桌面启动失败）
 * 就是这一类；仓内已有 14 处脚本各自内联了「同目录 tmp + rename」写法，本模块把它们
 * 收敛成**单一实现**，避免以后再各写一份、写错一份。
 *
 * 语义：同卷 `renameSync` 在 NTFS 与 POSIX 上都是**原子替换**——读者要么看到旧文件，
 * 要么看到新文件，不存在中间态。失败时清理 tmp 并**上抛**（fail-loud，绝不静默吞掉）。
 *
 * 用法：
 *   import { atomicWriteFileSync } from './lib/atomic-write.mjs'
 *   atomicWriteFileSync(file, content)          // 默认 utf8
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 原子写文件（同目录 tmp + rename）。
 * @param {string} file 目标文件绝对路径
 * @param {string|Buffer} content 内容
 * @param {object|string} [options] fs.writeFileSync 的 options（默认 'utf8'）
 * @returns {true} 成功即返回 true；失败抛错（并清理 tmp）
 */
export function atomicWriteFileSync(file, content, options = 'utf8') {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`)
  writeFileSync(tmp, content, options)
  try {
    renameSync(tmp, file)
  } catch (cause) {
    try { unlinkSync(tmp) } catch { /* best effort: 清理失败不掩盖主错误 */ }
    throw cause
  }
  return true
}
