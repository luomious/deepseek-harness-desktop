/**
 * 回归测试：进程结局账本（scripts/exit-ledger.mjs）的分类器。
 *
 * 为什么测这个：2026-09-29 修掉的「点创建提供商 → 应用静默退出」之所以难查，是因为它
 * **不留任何异常痕迹**（无异常、无转储、退出码 0）——粗看日志只知道"进程没了"。
 * 账本把这些结局变成可判定的类别，其中 `SILENT_WINDOW_LOSS` 就是那个死法的签名：
 * 窗口在没有退出请求的情况下消失，且**没有**兜底 relaunch。
 *
 * 本测试锁住三件事：
 *   1. 六类结局的判定规则（含"退出请求发生在窗口销毁之前才算主动退出"的时序要求）；
 *   2. 探针行解析：只有 `[ts] pid=N +Nms event` 形态才算事件，堆栈行必须被忽略；
 *   3. 真实日志形态的端到端分类：直接喂 2026-09-29 的两次"重载→兜底重启"事件序列，
 *      必须判为 RELOAD_RELAUNCH 而不是 SILENT_WINDOW_LOSS。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOne, classifyRuns, countGuardLines, parseProbeLine } from '../../scripts/exit-ledger.mjs'

const base = {
  durationMs: 60_000,
  windowCreated: 1,
  windowLostMs: null,
  beforeQuitMs: null,
  requestQuitMs: null,
  finalExitMs: null,
  relaunchMs: null,
  exitCode: null,
}

test('结局判定：六类规则', () => {
  assert.equal(
    classifyOne({ ...base, pid: 1 }, new Set([1])),
    'RUNNING',
    '仍存活的进程必须是 RUNNING',
  )
  assert.equal(
    classifyOne({ ...base, pid: 2, windowLostMs: 5000, beforeQuitMs: 4900, requestQuitMs: 4900, finalExitMs: 5600, exitCode: 0 }),
    'INTENTIONAL_QUIT',
    '先请求退出、后销毁窗口 = 正常关闭',
  )
  assert.equal(
    classifyOne({ ...base, pid: 3, windowLostMs: 378_474, finalExitMs: 394_297, relaunchMs: 394_299, exitCode: 0 }),
    'RELOAD_RELAUNCH',
    '无退出请求丢窗口 + 兜底 relaunch = 守卫按设计工作',
  )
  assert.equal(
    classifyOne({ ...base, pid: 4, windowLostMs: 30_000, exitCode: 0 }),
    'SILENT_WINDOW_LOSS',
    '无退出请求丢窗口且不重启 = 回归信号',
  )
  assert.equal(
    classifyOne({ ...base, pid: 5, durationMs: 2105, windowCreated: 0, exitCode: 0 }),
    'HELPER_EXIT',
    '短命辅助进程（launcher/relaunch 中转）不算运行',
  )
  assert.equal(
    classifyOne({ ...base, pid: 6, durationMs: 40_000, windowCreated: 0, exitCode: 1 }),
    'PLAIN_EXIT',
    '无窗口的长命进程按普通退出处理',
  )
})

test('时序要求：退出请求晚于窗口销毁，不得算作主动退出', () => {
  // 真实场景：窗口先被 reload 拆掉，之后进程才走 finalExit —— 若把 after 当成主动退出，
  // 就会把"回归"误判成"正常关闭"，账本就失去意义。
  assert.equal(
    classifyOne({ ...base, pid: 7, windowLostMs: 10_000, beforeQuitMs: 12_000, finalExitMs: 13_000, exitCode: 0 }),
    'SILENT_WINDOW_LOSS',
  )
})

test('探针行解析：只认事件行，堆栈行必须忽略', () => {
  const ev = parseProbeLine('[2026-09-29T11:44:47.166Z] pid=10888 +378474ms generation.release(): destroying window+tray (windows-left-after=?)')
  assert.deepEqual(ev, {
    ts: '2026-09-29T11:44:47.166Z',
    pid: 10888,
    elapsedMs: 378474,
    event: 'generation.release(): destroying window+tray (windows-left-after=?)',
  })
  assert.equal(parseProbeLine('    at Fiber.execute (file:///D:/x/lib/index.js:1:1)'), null)
  assert.equal(parseProbeLine(''), null)
})

test('端到端：2026-09-29 真实事件序列判为 RELOAD_RELAUNCH', () => {
  // 取自 exit-probe.log：19:44:47 热重载销毁窗口 → 存活 → 19:45:02 兜底 relaunch → exit 0
  const lines = [
    '[2026-09-29T11:38:28.692Z] pid=10888 +1ms === probe v3 installed; argv=[]',
    '[2026-09-29T11:38:41.000Z] pid=10888 +12308ms window created id=1',
    '[2026-09-29T11:44:47.166Z] pid=10888 +378474ms generation.release(): destroying window+tray (windows-left-after=?)',
    '[2026-09-29T11:44:47.179Z] pid=10888 +378487ms window closed id=1 -> remaining windows=0',
    '[2026-09-29T11:44:49.032Z] pid=10888 +380340ms heartbeat',
    '[2026-09-29T11:45:02.989Z] pid=10888 +394297ms finalExit(0) -> nativeExit.finish',
    '[2026-09-29T11:45:02.991Z] pid=10888 +394299ms >>> relaunch()',
    '    at Object.finish (file:///D:/x/lib/main.js:2365:48)',
    '[2026-09-29T11:45:03.064Z] pid=10888 +394372ms >>> exit(0)',
    '[2026-09-29T11:45:03.065Z] pid=10888 +394373ms >>> process exit code=0 (no JS wrapper caught this)',
    // 同时段的辅助进程与主动退出实例
    '[2026-09-29T11:44:52.734Z] pid=42484 +2157ms >>> process exit code=0 (no JS wrapper caught this)',
    '[2026-09-29T11:53:36.803Z] pid=55912 +1ms === probe v3 installed; argv=[]',
    '[2026-09-29T11:53:49.266Z] pid=55912 +12464ms window created id=1',
    '[2026-09-29T11:57:32.459Z] pid=55912 +235657ms app before-quit',
    '[2026-09-29T11:57:32.459Z] pid=55912 +235657ms requestQuit(0)',
    '[2026-09-29T11:57:32.513Z] pid=55912 +235711ms window closed id=1 -> remaining windows=0',
    '[2026-09-29T11:57:33.176Z] pid=55912 +236374ms app quit code=0',
  ]
  const runs = classifyRuns(lines)
  const byPid = new Map(runs.map((run) => [run.pid, run.classification]))
  assert.equal(byPid.get(10888), 'RELOAD_RELAUNCH')
  assert.equal(byPid.get(55912), 'INTENTIONAL_QUIT')
  assert.equal(byPid.get(42484), 'HELPER_EXIT')
  assert.equal(runs.filter((r) => r.classification === 'SILENT_WINDOW_LOSS').length, 0)
})

test('守卫行计数：抑制与兜底各算一次', () => {
  const text = [
    'dsh-plugin-desktop: window-all-closed without a quit request — implicit Electron quit suppressed (a profile reload tears down the desktop-shell row that owns this window)',
    'dsh-plugin-desktop: no window came back 15s after suppressing the implicit quit — relaunching the shell',
    'dsh-plugin-desktop: window-all-closed without a quit request — implicit Electron quit suppressed (a profile reload tears down the desktop-shell row that owns this window)',
  ].join('\n')
  assert.deepEqual(countGuardLines(text), { suppressed: 2, relaunched: 1 })
})
