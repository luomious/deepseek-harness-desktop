// tests/plugins/safe-delete-shim.test.mjs — SELF-2 / SELF-2b 回归测试
//
// 覆盖：
//   1. 瞬态旁路（SELF-2b）：*.lock / *.tmp 不进回收站/隔离，走原始删除
//   2. 回收站失败 → 隔离（SELF-2，用 DSH_SAFE_DELETE_FAIL_RECYCLE=1 旋钮）
//   3. 竞态委托（SELF-2b）：目标已消失 → 原始 fs 语义（ENOENT / force 静默）
//   4. 受保护路径（~/.dsh、tmpdir）→ 原始硬删
//
// 运行：node --test tests/plugins/safe-delete-shim.test.mjs
// 注意：测试工作目录必须在 os.tmpdir() 之外（tmpdir 属受保护前缀，不会被拦截）。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')

// 独立 DSH_HOME（隔离根）与工作目录，均在 repo 内、tmpdir 之外
const TS = Date.now().toString(36)
const FAKE_DSH_HOME = join(ROOT, '_backups', `shim-test-dshhome-${TS}`)
const WORK = join(ROOT, '_backups', `shim-test-work-${TS}`)
mkdirSync(FAKE_DSH_HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })

// 必须在加载 shim 前设置（模块加载时读取）
process.env.DSH_HOME = FAKE_DSH_HOME
process.env.DSH_SAFE_DELETE_FAIL_RECYCLE = '1' // 强制回收站失败，走隔离分支

const shim = (await import('../../patches/bundles/safe-delete-shim.cjs')).default
const { isProtected, isTransient, getQuarantineRoot } = shim

const QUARANTINE = getQuarantineRoot()

function quarantineHas(namePart) {
  try {
    return readdirSync(QUARANTINE).some((n) => n.includes(namePart))
  } catch {
    return false
  }
}

let cleanupDirs = [FAKE_DSH_HOME, WORK]

after(() => {
  // 只清理本测试自建的目录
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

test('isTransient: .lock / .tmp / .tmp-123 识别，普通文件不识别', () => {
  assert.equal(isTransient('C:\\some\\dir\\state.json.lock'), true)
  assert.equal(isTransient('C:\\some\\dir\\foo.tmp'), true)
  assert.equal(isTransient('C:\\some\\dir\\cfg.tmp-1a2b'), true)
  assert.equal(isTransient('C:\\some\\dir\\state.json'), false)
  assert.equal(isTransient('C:\\some\\dir\\notes.txt'), false)
  assert.equal(isTransient(null), false)
})

test('SELF-2b: unlinkSync 对 .lock 文件旁路（回收站强制失败仍直接删除，不进隔离）', () => {
  const fs = require_fs()
  const p = join(WORK, 'state.json.lock')
  writeFileSync(p, 'lock')
  fs.unlinkSync(p) // 若未旁路：FORCE_FAIL_RECYCLE → 隔离或抛错
  assert.equal(existsSync(p), false)
  assert.equal(quarantineHas('state.json.lock'), false)
})

test('SELF-2b: promises.unlink 对 .lock 文件旁路', async () => {
  const fsp = (await import('node:fs')).promises
  const p = join(WORK, 'other.lock')
  writeFileSync(p, 'x')
  await fsp.unlink(p)
  assert.equal(existsSync(p), false)
  assert.equal(quarantineHas('other.lock'), false)
})

test('SELF-2b: rimraf 目录（含 .lock 成员）整体成功', () => {
  const fs = require_fs()
  const dir = join(WORK, 'plugin-install-recovery')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json.lock'), 'x')
  writeFileSync(join(dir, 'state.json'), 'y')
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(existsSync(dir), false)
})

test('SELF-2: 非瞬态文件回收站失败 → 落入隔离（内容可恢复）', () => {
  const fs = require_fs()
  const p = join(WORK, 'user-data.json')
  writeFileSync(p, '{"important": true}')
  fs.unlinkSync(p)
  assert.equal(existsSync(p), false)
  assert.ok(quarantineHas('user-data.json'), '文件必须出现在隔离区')
})

test('SELF-2b: 已消失目标 unlinkSync 不再抛 EQ_DELETE（委托原始 ENOENT）', () => {
  const fs = require_fs()
  const p = join(WORK, 'raced-away.json')
  // 不创建文件 → recycle 内部 stat 失败抛错 → 隔离发现 missing → 委托原始 unlink
  assert.throws(() => fs.unlinkSync(p), (e) => e.code === 'ENOENT')
})

test('SELF-2b: rmSync force + 目标消失 → 静默成功（stock 语义）', () => {
  const fs = require_fs()
  const p = join(WORK, 'never-existed.bin')
  fs.rmSync(p, { force: true }) // 不应抛 EQ_DELETE / EQ_QUARANTINE
})

test('受保护路径（DSH_HOME 内）→ 原始硬删（junction heal 依赖）', () => {
  const fs = require_fs()
  const p = join(FAKE_DSH_HOME, 'protected-cache.bin')
  writeFileSync(p, 'x')
  fs.unlinkSync(p) // 即使 FORCE_FAIL_RECYCLE，受保护路径也不进隔离
  assert.equal(existsSync(p), false)
  assert.equal(quarantineHas('protected-cache.bin'), false)
})

test('isProtected: DSH_HOME / tmpdir / node_modules 判定', () => {
  assert.equal(isProtected(join(FAKE_DSH_HOME, 'x.txt')), true)
  assert.equal(isProtected(join(tmpdir(), 'x.txt')), true)
  assert.equal(isProtected('C:\\proj\\node_modules\\pkg\\x.js'), true)
  assert.equal(isProtected(join(WORK, 'x.txt')), false)
})

// —— helpers（CJS require 加载 .cjs，避免 ESM interop 问题）——
import { createRequire } from 'node:module'
function require_fs() {
  const req = createRequire(import.meta.url)
  return req('node:fs')
}
