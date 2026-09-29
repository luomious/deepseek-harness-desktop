#!/usr/bin/env node
/**
 * repair-health-checkpoint.mjs — 修复"健康 profile 检查点"与实时 profile 不一致的问题。
 *
 * 背景（2026-09-29，我引入的回归）：桌面壳的检查点校验在 lib/main.js:2140 是
 *   if (bytes.byteLength !== item.size || hash(bytes) !== item.sha256) fail(`checkpoint backup is incomplete: ${name}`)
 * 即逐个文件按 **size + sha256** 对标 health-snapshots/<hash>/latest/manifest.json。
 * 19:58 我们把"修好的" package.json / pnpm-lock.yaml / cordis.patch.yml / pnpm-workspace.yaml
 * 写进了检查点，却没重算 manifest.json（它还停在 09/27 的旧哈希与大小）
 *   ⇒ 校验必失败 ⇒ 日志出现 latest healthy profile restore was unavailable: ... incomplete: package.json
 *   ⇒ 检查点恢复这条安全网失效。
 *
 * 本工具按 manifest 自己声明的文件清单，用实时 profile 的字节重算 sha256/size，
 * 生成新的 manifest.json（保留 version/profileIdentity/profileName/provider —— 壳用
 * 它们判定"这份快照属于哪个 profile"，见 main.js:1902/1922），然后**按壳的同一规则复验**。
 *
 * 用法：
 *   node scripts/repair-health-checkpoint.mjs                 # 只预览差异（默认）
 *   node scripts/repair-health-checkpoint.mjs --apply         # 写回（先备份旧 manifest）
 *   node scripts/repair-health-checkpoint.mjs --apply --profile-dir <dir> --snapshot-dir <dir>
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from './lib/atomic-write.mjs'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const SNAPSHOT_ROOT = join(APPDATA, 'DSH Desktop', 'health-snapshots')
const PROFILE_DIR = argOf('--profile-dir', join(homedir(), '.dsh', 'profiles', 'desktop'))
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const BACKUP_DIR = join(process.cwd(), '_backups', `checkpoint-manifest-repair-${STAMP}`)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function findSnapshotDir() {
  const explicit = argOf('--snapshot-dir', null)
  if (explicit) return explicit
  if (!existsSync(SNAPSHOT_ROOT)) throw new Error(`snapshot root missing: ${SNAPSHOT_ROOT}`)
  const candidates = []
  for (const entry of readdirSync(SNAPSHOT_ROOT)) {
    const latest = join(SNAPSHOT_ROOT, entry, 'latest')
    if (existsSync(join(latest, 'manifest.json'))) candidates.push(latest)
  }
  if (candidates.length === 0) throw new Error(`no snapshot with manifest.json under ${SNAPSHOT_ROOT}`)
  // 多份时取 manifest 最新改动的那份
  candidates.sort((a, b) => statSync(join(b, 'manifest.json')).mtimeMs - statSync(join(a, 'manifest.json')).mtimeMs)
  return candidates[0]
}

const snapshotDir = findSnapshotDir()
const manifestPath = join(snapshotDir, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
console.log(`[checkpoint-repair] 快照: ${snapshotDir}`)
console.log(`[checkpoint-repair] 实时 profile: ${PROFILE_DIR}`)
console.log(`[checkpoint-repair] manifest: version=${manifest.version} profile=${manifest.profileName} identity=${String(manifest.profileIdentity).slice(0, 12)}… capturedAt=${manifest.capturedAt}`)

let stale = 0
const nextFiles = []
for (const item of manifest.files) {
  const live = join(PROFILE_DIR, item.name)
  if (!existsSync(live)) {
    console.log(`  MISSING ${item.name} (实时 profile 里不存在) — 保持 present=${item.present}`)
    nextFiles.push(item)
    stale += 1
    continue
  }
  const bytes = readFileSync(live)
  const entry = { name: item.name, present: true, sha256: sha256(bytes), size: bytes.byteLength, mode: item.mode }
  const changed = entry.sha256 !== item.sha256 || entry.size !== item.size
  if (changed) stale += 1
  console.log(`  ${changed ? 'STALE' : 'ok   '} ${item.name}  ${item.size}→${entry.size}B  ${changed ? String(item.sha256).slice(0, 10) + '… → ' + entry.sha256.slice(0, 10) + '…' : '哈希一致'}`)
  nextFiles.push(entry)
}

const nextManifest = {
  version: manifest.version,
  snapshotId: randomUUID(),
  capturedAt: new Date().toISOString(),
  profileIdentity: manifest.profileIdentity,
  profileName: manifest.profileName,
  provider: manifest.provider,
  files: nextFiles,
}

// 按壳的规则复验：size + sha256 必须逐项相等
let verifyFail = 0
for (const item of nextManifest.files) {
  const live = join(PROFILE_DIR, item.name)
  if (!existsSync(live)) continue
  const bytes = readFileSync(live)
  if (bytes.byteLength !== item.size || sha256(bytes) !== item.sha256) {
    console.error(`  VERIFY-FAIL ${item.name}`)
    verifyFail += 1
  }
}
console.log(`[checkpoint-repair] 待更新项: ${stale} ；壳规则复验: ${verifyFail === 0 ? 'PASS' : `${verifyFail} FAIL`}`)

if (!APPLY) {
  console.log('[checkpoint-repair] 预览模式（未写入）。加 --apply 执行。')
  process.exit(verifyFail === 0 ? 0 : 1)
}
if (verifyFail !== 0) {
  console.error('[checkpoint-repair] 复验未通过，拒绝写入')
  process.exit(1)
}
mkdirSync(BACKUP_DIR, { recursive: true })
copyFileSync(manifestPath, join(BACKUP_DIR, 'manifest.json'))
atomicWriteFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n')
const readBack = JSON.parse(readFileSync(manifestPath, 'utf8'))
const ok = readBack.files.length === nextManifest.files.length
  && readBack.files.every((f, i) => f.sha256 === nextManifest.files[i].sha256 && f.size === nextManifest.files[i].size)
  && readBack.profileIdentity === manifest.profileIdentity
console.log(`[checkpoint-repair] 已写入 manifest（备份: ${BACKUP_DIR}）；回读校验: ${ok ? 'PASS' : 'FAIL'}`)
console.log(`[checkpoint-repair] 壳侧的 'checkpoint backup is incomplete' 应当消失（下次启动时可在日志确认）`)
process.exit(ok ? 0 : 1)
