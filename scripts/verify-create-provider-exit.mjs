#!/usr/bin/env node
/**
 * verify-create-provider-exit.mjs — 「点『创建提供商』后应用是否静默退出」的验证器（只读）。
 *
 * 背景：profile 热重载会重建根 Include 的全部子行（含持有窗口的 `desktop-shell` 行），
 * 窗口销毁后 Electron 的**隐式 quit** 会被壳自己的 before-quit 守卫转成协调式 app.exit(0)
 * ——无异常、无转储、退出码 0，肉眼只看到「退出」。真实证据只有两处：
 *   1) 退出探针（`scripts/apply-exit-probe.mjs`）写下的 `exit-probe.log`：每次 run 的
 *      起点、心跳、window 事件，以及 `>>> process exit` / `app quit`；
 *   2) 应用日志里的 profile reload 行（`[root] patch: … not found`）。
 *
 * 判定（取最近一次「正常启动」的 run）：
 *   VERIFIED      reload 之后进程仍活（且若窗口真的全没了，应出现 suppression 行）
 *   DIED          reload 之后出现 process exit / app quit
 *   INCONCLUSIVE  还没有发生 reload（也就是还没点，或点击没走到重载）
 *
 * 用法：node scripts/verify-create-provider-exit.mjs [--wait-ms N]
 * 退出码：0=VERIFIED  1=DIED  2=INCONCLUSIVE  3=证据缺失（探针未装/日志不可读）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const optNum = (name, dflt) => {
  const i = argv.indexOf(name)
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const tail = (text, n) => text.split(/\r?\n/).slice(-n)

/** 运行时日志目录（不依赖 %APPDATA% 是否导出到 shell）。 */
function runtimeLogDir() {
  const roaming = process.env.APPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Roaming')
  return join(roaming, 'DSH Desktop', 'logs')
}

/** 探针日志按 UTC(ISO) 记时间，应用日志按本地时间记；统一成本地毫秒。 */
function parseProbeTs(line) {
  const m = line.match(/^\[([0-9T:.Z-]+)\]/)
  return m ? Date.parse(m[1]) : null
}
function parseAppTs(line) {
  const m = line.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime()
}
const stamp = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })

const dir = runtimeLogDir()
const probePath = join(dir, 'exit-probe.log')
if (!existsSync(probePath)) {
  console.error(`证据缺失：探针日志不存在 ${probePath}\n请先装探针：node scripts/apply-exit-probe.mjs（需重启应用生效）`)
  process.exit(3)
}
const probe = readFileSync(probePath, 'utf8').split(/\r?\n/).filter(Boolean)

// 最近一次「正常启动」的 run（argv=[]，排除 --export-diagnostics 自检）
const starts = probe
  .map((line, i) => ({ line, i, ts: parseProbeTs(line) }))
  .filter((e) => e.line.includes('=== probe v3 installed') && e.line.includes('argv=[]'))
if (starts.length === 0) {
  console.error('证据缺失：探针日志里没有一次正常启动（argv=[]）记录')
  process.exit(3)
}
const start = starts[starts.length - 1]
const pid = Number((start.line.match(/pid=(\d+)/) ?? [])[1])
const runLines = probe.slice(start.i)
const runEnd = runLines.findIndex((l) => />>> process exit|app quit code|>>> exit\(/.test(l))
const exited = runEnd >= 0
const lastTs = parseProbeTs(runLines[runLines.length - 1]) ?? start.ts

// 存活探测：信号 0 只检查进程是否存在
let alive = null
try { process.kill(pid, 0); alive = true } catch { alive = false }

// 应用日志：本次启动之后的 profile reload 行
//
// ⚠ 关键区分：「[root] patch: … not found」这类行**每次启动都会出现一次**（boot 后
// 0.2~2s），发生热重载时会再出现一次。早先版本把 boot 那条也当 reload，导致「还没点
// 就 VERIFIED」的假绿。这里的口径：run 起点的前 BOOT_WINDOW_MS 内算 boot 行，之后的
// 才算 reload。
const BOOT_WINDOW_MS = 15_000
const logFiles = readdirSync(dir).filter((f) => /^dsh-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse()
const patchLines = []
const appErrors = []
if (logFiles.length > 0) {
  const appLog = readFileSync(join(dir, logFiles[0]), 'utf8').split(/\r?\n/)
  for (const line of appLog) {
    const ts = parseAppTs(line)
    if (ts === null || ts < start.ts) continue
    if (line.includes('[root] patch:') && line.includes('not found')) patchLines.push({ ts, line })
    if (/\[E\]|fatal|uncaught/.test(line) && !/mcp-client|hmr\]/.test(line)) appErrors.push({ ts, line })
  }
}
const bootLine = patchLines.find((r) => r.ts - start.ts <= BOOT_WINDOW_MS)
const reloads = patchLines.filter((r) => r !== bootLine)

const suppressed = runLines.filter((l) => l.includes('implicit Electron quit suppressed'))
const windowEvents = runLines.filter((l) => /window (created|close|closed)|destroying window/.test(l))
const heartbeats = runLines.filter((l) => l.includes('heartbeat')).length

console.log('=== 最近一次运行 ===')
console.log(`pid=${pid}  启动=${stamp(start.ts)}  最后探针行=${stamp(lastTs)}  (运行 ${Math.round((lastTs - start.ts) / 1000)}s)`)
console.log(`进程存活=${alive === null ? '未知' : alive ? '是' : '否'}  心跳=${heartbeats} 次`)
console.log(`窗口事件: ${windowEvents.length === 0 ? '(无)' : ''}`)
for (const e of windowEvents) console.log(`  ${stamp(parseProbeTs(e))}  ${e.replace(/^\[[^\]]+\]\s*/, '')}`)
console.log(`抑制隐式退出: ${suppressed.length} 次`)
for (const s of suppressed) console.log(`  ${stamp(parseProbeTs(s))}  ${s.replace(/^\[[^\]]+\]\s*/, '')}`)
console.log(`profile reload: ${reloads.length} 次 (${logFiles[0] ?? 'no app log'})`)
for (const r of reloads) console.log(`  ${stamp(r.ts)}  ${r.line.trim()}`)
if (bootLine) console.log(`  （另有 1 条 boot 期 patch 警告，按启动噪声排除：${stamp(bootLine.ts)}）`)
if (appErrors.length > 0) {
  console.log(`其他错误行: ${appErrors.length}（最近 3）`)
  for (const e of tail(appErrors.map((x) => `  ${stamp(x.ts)}  ${x.line.trim()}`), 3)) console.log(e)
}

console.log('\n=== 判定 ===')
if (exited) {
  console.log(`DIED — run 内出现退出事件：${runLines[runEnd].replace(/^\[[^\]]+\]\s*/, '')}`)
  process.exit(1)
}
if (reloads.length > 0 && alive !== true) {
  console.log('DIED — 发生了 profile reload，而该进程已不在（探针没记到退出事件 = 未走 JS 通道的硬退出）')
  process.exit(1)
}
if (reloads.length > 0) {
  console.log('VERIFIED — 发生了 profile reload，进程没有退出 ⇒ 静默退出已根治')
  console.log(suppressed.length > 0
    ? '   （探针抓到了 window-all-closed 抑制记录：与根因链完全一致）'
    : '   （本次窗口未被销毁，或抑制动作在探针覆盖之外；进程存活即为结论）')
  process.exit(0)
}
console.log('INCONCLUSIVE — 还没发生 profile reload（也就是还没点『创建提供商』，或点击没走到重载）')
console.log('  下一步：在设置→模型里点一次「创建提供商」，然后重跑本脚本（应用需保持运行）')
process.exit(2)
