/**
 * 回归测试：「点创建提供商 → 应用静默退出」的根因守卫。
 *
 * 机制（取证见 CHANGELOG 2026-09-29 与 scripts/apply-window-all-closed-guard.mjs）：
 * profile reload 会重建根 Include 的全部子行（含持有窗口的 `desktop-shell` 行），
 * 该行 disposer 销毁 window+tray 后，壳若没有 `window-all-closed` 监听，Electron
 * 会执行隐式 app.quit() → 被壳自己的 before-quit 守卫转成协调式 shutdown →
 * app.exit(0)：无异常、无崩溃转储、不 relaunch、不留日志，用户只看到「退出」。
 *
 * 本测试既做静态断言（dist 里守卫存在且唯一），也把守卫代码抽出来在 vm 里跑，
 * 断言三条语义：未请求退出即抑制 + 兜底 relaunch；已请求退出则放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { resolveCurrentBuild } from '../../scripts/resolve-dist.mjs'

const MARK = 'dsh-desktop patch (2026-09-29): window-all-closed guard.'
const END_MARK = 'app.on("window-all-closed", onWindowAllClosed);'

function readMain() {
  const build = resolveCurrentBuild()
  const file = join(build.lib, 'main.js')
  if (!existsSync(file)) throw new Error(`dist lib/main.js not found: ${file}`)
  return readFileSync(file, 'utf8')
}

/** 从构建产物里抽出守卫代码块（含外层花括号），在 vm 里以桩件运行。 */
function extractGuard(source) {
  const mark = source.indexOf(MARK)
  assert.notEqual(mark, -1, 'window-all-closed guard marker missing from dist lib/main.js')
  const open = source.indexOf('\n\t{\n', mark)
  assert.notEqual(open, -1, 'guard block opening brace not found')
  const end = source.indexOf(END_MARK, open)
  assert.notEqual(end, -1, 'guard listener registration not found')
  const close = source.indexOf('\n\t}', end)
  assert.notEqual(close, -1, 'guard block closing brace not found')
  return source.slice(open + 1, close + 3)
}

/** 记录一次守卫运行的桩件沙箱。 */
function runGuard(block, { windows = 0, quitting = false } = {}) {
  const logs = []
  const calls = { relaunch: 0, shutdown: [] }
  const listeners = []
  const timers = []
  let windowCount = windows
  const sandbox = {
    quitRequested: quitting,
    BIN_NAME: 'dsh-plugin-desktop',
    electronLogger: { error: (message) => { logs.push(String(message)) } },
    BrowserWindow: { getAllWindows: () => new Array(windowCount).fill(null) },
    nativeExit: { requestRelaunch: () => { calls.relaunch += 1 } },
    shutdown: { request: (code) => { calls.shutdown.push(code) } },
    app: {
      on: (event, listener) => { listeners.push([event, listener]) },
      off: () => {},
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(block, sandbox)
  return {
    logs,
    calls,
    timers,
    setWindows: (n) => { windowCount = n },
    setQuitting: (v) => { sandbox.quitRequested = v },
    fire: () => {
      const hits = listeners.filter(([event]) => event === 'window-all-closed')
      for (const [, listener] of hits) listener()
      return hits.length
    },
  }
}

test('dist: 守卫与退出标志都已注入且只有一份监听', () => {
  const source = readMain()
  assert.ok(source.includes(MARK), 'guard marker missing')
  const registrations = source.split(END_MARK).length - 1
  assert.equal(registrations, 1, `expected exactly one window-all-closed listener, found ${registrations}`)
  assert.ok(source.includes('let quitRequested = false;'), 'quit flag declaration missing')
  assert.ok(
    /const requestQuit = \(code\) => \{\s*\n\s*quitRequested = true;/.test(source),
    'requestQuit must set the quit flag before requesting shutdown',
  )
  // 次序不变量（否则修复会变成「应用关不掉」）：X 按钮 / 托盘 / 信号等**有意退出**都先经
  // app.quit() → before-quit → requestQuit（置位 quitRequested），之后才销毁窗口并触发
  // window-all-closed。若这条注册缺失，有意退出就不会置位，守卫会把它当成「窗口丢失」而
  // 抑制退出、15s 后还会 relaunch 拉起应用。
  assert.ok(
    source.includes('nativeApp.on("before-quit", beforeQuit)'),
    'the coordinated-quit before-quit handler must stay registered (intended quits set the flag)',
  )
  assert.ok(
    source.includes('setTimeout(') && source.includes('15e3'),
    'bounded recovery probe (15s) missing',
  )
})

test('未请求退出且窗口被销毁：抑制隐式退出并安排兜底恢复', () => {
  const source = readMain()
  const guard = runGuard(extractGuard(source), { windows: 0, quitting: false })
  assert.equal(guard.fire(), 1, 'guard must register exactly one window-all-closed listener')
  assert.equal(guard.logs.length, 1, 'suppression must be logged once')
  assert.match(guard.logs[0], /implicit Electron quit suppressed/)
  assert.equal(guard.timers.length, 1, 'recovery probe must be scheduled')
  assert.equal(guard.timers[0].ms, 15_000, 'recovery probe must be bounded')
  assert.deepEqual(guard.calls.shutdown, [], 'suppression alone must not shut the shell down')
  assert.equal(guard.calls.relaunch, 0, 'suppression alone must not relaunch')
})

test('兜底恢复：15s 后仍无窗口才 relaunch，有窗口则不动', () => {
  const source = readMain()
  const block = extractGuard(source)

  const lost = runGuard(block, { windows: 0 })
  lost.fire()
  lost.timers[0].fn()
  assert.equal(lost.calls.relaunch, 1, 'no window after the grace period must relaunch the shell')
  assert.deepEqual(lost.calls.shutdown, [0], 'recovery must request exit code 0 so relaunch is honoured')
  assert.ok(lost.logs.some((line) => line.includes('relaunching the shell')), 'recovery must be logged')

  const returned = runGuard(block, { windows: 0 })
  returned.fire()
  returned.setWindows(1) // reload 重建了 desktop-shell 行，窗口回来了
  returned.timers[0].fn()
  assert.equal(returned.calls.relaunch, 0, 'a re-mounted window must not trigger a relaunch')
  assert.deepEqual(returned.calls.shutdown, [], 'a re-mounted window must keep the shell running')
})

test('已请求退出：守卫放行，不记日志、不排兜底', () => {
  const source = readMain()
  const guard = runGuard(extractGuard(source), { windows: 0, quitting: true })
  guard.fire()
  assert.deepEqual(guard.logs, [], 'an intentional quit must not be reported as a lost window')
  assert.deepEqual(guard.timers, [], 'an intentional quit must not schedule a recovery probe')

  const raced = runGuard(extractGuard(source), { windows: 0 })
  raced.fire()
  raced.setQuitting(true) // 宽限期内用户/信号发起了正常退出
  raced.timers[0].fn()
  assert.equal(raced.calls.relaunch, 0, 'a quit requested during the grace period must win')
  assert.deepEqual(raced.calls.shutdown, [], 'a quit requested during the grace period must not be overridden')
})
