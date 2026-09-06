#!/usr/bin/env node
/**
 * fix-modlens-spawn-trace.mjs — 移除 modlens spawnHidden.js 中的调试 trace（2026-09-06 审计 P1-2）
 *
 * 问题：~/.dsh/profiles/desktop/node_modules/@liustack/modlens/dsh/spawnHidden.js
 *       第 17、20 行残留手动注入的 spawn-trace 写入（硬编码 D:/Deepseek-Harness/spawn-trace.log），
 *       每次 modlens 拉子进程都追加写入仓库根目录，无轮转；docs/PRODUCTION-READINESS-REVIEW.md
 *       P1-E1 已登记插件侧 4 处已删，此为第 5 处漏网（spawnHidden.js 未被补丁体系管理）。
 *
 * 用法（在普通终端运行，勿在 DSH 沙箱内）：
 *   node scripts/fix-modlens-spawn-trace.mjs [--profile desktop]
 *
 * 行为：备份 -> 原子替换（临时文件+rename）-> 回读验证 -> node --check。
 * 幂等：目标已无 trace 时直接报告 no-op。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const PROFILE = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : 'desktop'
// DSH_HOME 语义：已含 .dsh（如 C:\Users\xxx\.dsh）；homedir() 才需再拼 .dsh。
// 2026-09-06 修复：先前写 path.join(HOME, '.dsh', ...) 在 DSH_HOME 已设时重复拼 .dsh → target not found。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const TARGET = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@liustack', 'modlens', 'dsh', 'spawnHidden.js')
const BACKUP_ROOT = path.join(process.cwd(), '_backups')

function fail(msg) { console.error('[fix-modlens-spawn-trace] ' + msg); process.exit(1) }
function log(msg) { console.log('[fix-modlens-spawn-trace] ' + msg) }

if (!fs.existsSync(TARGET)) fail(`target not found: ${TARGET} (profile ${PROFILE} 未安装 modlens？)`)

const orig = fs.readFileSync(TARGET, 'utf8')
// 校验 trace 行确实存在（防止误改未来版本：找不到 trace 就 no-op）
const hasTrace = orig.includes('spawn-trace.log') || orig.includes("appendFileSync('D:/Deepseek-Harness")
if (!hasTrace) { log('no trace found — already clean (no-op)'); process.exit(0) }

// 去掉 import appendFileSync 行 + try { appendFileSync(...) } catch {} 块
let next = orig
  .replace(/import \{ appendFileSync \} from 'node:fs'\r?\n/, '')
  .replace(/^[\t ]*try \{ appendFileSync\([^\n]*\n/, '\n')

if (next === orig) fail('trace lines present but replacement produced no change — manual inspection required')

// 备份（可回滚）
fs.mkdirSync(BACKUP_ROOT, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const backup = path.join(BACKUP_ROOT, `spawnHidden.js.bak-${ts}`)
fs.copyFileSync(TARGET, backup)
log(`backup -> ${backup}`)

// 原子替换：临时文件 + rename
const tmp = TARGET + '.fix-tmp'
fs.writeFileSync(tmp, next, 'utf8')
fs.renameSync(tmp, TARGET)
log(`patched ${path.relative(process.cwd(), TARGET)}`)

// 回读验证
const after = fs.readFileSync(TARGET, 'utf8')
if (after.includes('spawn-trace.log')) fail('VERIFY FAILED: trace still present after patch')
if (after.includes("appendFileSync")) fail('VERIFY FAILED: appendFileSync still present after patch')
log('verify: trace removed')

// 语法校验
const r = spawnSync(process.execPath, ['--check', TARGET], { encoding: 'utf8', windowsHide: true })
if (r.status !== 0) fail(`node --check FAILED: ${(r.stderr || '').trim().slice(0, 300)}`)
log('node --check: OK')
log('done. 重启桌面应用后 spawn-trace.log 不再增长；如需恢复，用备份文件还原。')