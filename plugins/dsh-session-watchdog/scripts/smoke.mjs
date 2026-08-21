// 离线冒烟测试：验证会话续跑看门狗的核心判定（shouldResumeGoal）+ 一轮扫描闭环。
// 不依赖 harness，直接 import 编译产物 lib/index.js 的 shouldResumeGoal。
import { shouldResumeGoal } from '../lib/index.js'

let pass = 0
let fail = 0
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name) }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected) }
}

const base = {
  intervalMs: 30000, resumeDisarmed: true, resumePaused: false, resumeBlocked: false,
  cooldownMs: 60000, logFile: '',
}
const g = (o) => ({ id: 'g1', revision: 1, phase: 'active', activation: 'disarmed', roundsStarted: 0, maxGoalRounds: 10, ...o })

console.log('== shouldResumeGoal 判定 ==')
t('active+disarmed → 恢复（默认）', shouldResumeGoal(g({}), base), true)
t('active+armed → 不动', shouldResumeGoal(g({ activation: 'armed' }), base), false)
t('paused → 默认不动', shouldResumeGoal(g({ phase: 'paused', activation: 'disarmed' }), base), false)
t('paused+开关 → 恢复', shouldResumeGoal(g({ phase: 'paused' }), { ...base, resumePaused: true }), true)
t('blocked → 默认不动', shouldResumeGoal(g({ phase: 'blocked' }), base), false)
t('blocked+开关 → 恢复', shouldResumeGoal(g({ phase: 'blocked' }), { ...base, resumeBlocked: true }), true)
t('blocked 已耗尽轮次 → 永不恢复', shouldResumeGoal(g({ phase: 'blocked', roundsStarted: 10, maxGoalRounds: 10 }), { ...base, resumeBlocked: true }), false)
t('blocked 未耗尽 → 恢复', shouldResumeGoal(g({ phase: 'blocked', roundsStarted: 3, maxGoalRounds: 10 }), { ...base, resumeBlocked: true }), true)
t('complete → 不动', shouldResumeGoal(g({ phase: 'complete', activation: 'disarmed' }), base), false)
t('disarmed 关闭开关 → 不动', shouldResumeGoal(g({}), { ...base, resumeDisarmed: false }), false)

console.log(`\nresult: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
