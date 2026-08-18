// 回归测试：诊断决策引擎（src/lib/brain.js + loop-detect.js）核心逻辑
// 覆盖：最低破坏优先 / 回环检测升级 / 节流 / 全局预算 / 经验学习 / 安全模式终态 / 持久化

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LoopDetector } = require('../src/lib/loop-detect.js');
const { Brain } = require('../src/lib/brain.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

// 可控时钟
function makeClock() {
  let now = 1000000;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

// ── LoopDetector 单元 ─────────────────────────────────
console.log('== LoopDetector ==');
const ld = new LoopDetector(2);
t('初始不成环', ld.looped('fp1'), false);
ld.record('fp1', 'restart');
t('1 次失败不成环', ld.looped('fp1'), false);
ld.record('fp1', 'kill-port');
t('换动作累计失败判环', ld.looped('fp1'), true);
t('记录最近失败动作', ld.lastAction('fp1'), 'kill-port');
ld.reset('fp1');
t('成功重置后不成环', ld.looped('fp1'), false);
t('成功重置后计数清零', ld.count('fp1'), 0);

// ── Brain：基础决策 ───────────────────────────────────
console.log('== Brain 基础决策 ==');
const c1 = makeClock();
const b1 = new Brain({ clock: c1.now });

// T1 单次错误 → 最低破坏动作（RENDER-001 -> retry）
const d1 = b1.emit({ code: 'RENDER-001', stage: 'render', key: 'gone' });
t('单次错误选最低破坏动作 retry', d1 && d1.action, 'retry');
t('决策带影响评估(level)', d1 && d1.impact && d1.impact.level, 0);
t('决策带影响评估(expected)', d1 && d1.impact && typeof d1.impact.expected === 'string' && d1.impact.expected.length > 0, true);
t('决策带影响评估(scope)', d1 && d1.impact && d1.impact.scope, 'none');

// T3 节流：失败后同动作 10 分钟内不再自动执行
b1.report({ code: 'RENDER-001', stage: 'render', key: 'gone' }, 'retry', false);
const d2 = b1.emit({ code: 'RENDER-001', stage: 'render', key: 'gone' });
t('retry 失败后被节流 → 升级 restart', d2 && d2.action, 'restart');
b1.report({ code: 'RENDER-001', stage: 'render', key: 'gone' }, 'restart', true);
// T5 成功反馈：解除节流 + 重置回环计数 → 重新从最低等级开始
const d3 = b1.emit({ code: 'RENDER-001', stage: 'render', key: 'gone' });
t('成功后解除节流重新从 retry 开始', d3 && d3.action, 'retry');

// ── Brain：回环检测升级链 ─────────────────────────────
console.log('== Brain 回环检测升级链 ==');
const c2 = makeClock();
const b2 = new Brain({ clock: c2.now });
// BOOT-004 规则: [restart, kill-port, safe-mode]
// 链：restart 失败 → kill-port 失败(判环) → 升级 safe-mode → safe-mode 失败 → 终态 notify
let d = b2.emit({ code: 'BOOT-004', stage: 'wait' });
t('链1: restart', d && d.action, 'restart');
b2.report({ code: 'BOOT-004', stage: 'wait' }, 'restart', false);
d = b2.emit({ code: 'BOOT-004', stage: 'wait' });
t('链2: restart 节流 → kill-port', d && d.action, 'kill-port');
b2.report({ code: 'BOOT-004', stage: 'wait' }, 'kill-port', false);
d = b2.emit({ code: 'BOOT-004', stage: 'wait' });
t('链3: 判环(2次失败) → 升级 safe-mode', d && d.action, 'safe-mode');
t('链3: 决策标记 looped', d && d.looped, true);
b2.report({ code: 'BOOT-004', stage: 'wait' }, 'safe-mode', false);
d = b2.emit({ code: 'BOOT-004', stage: 'wait' });
t('链4: safe-mode 失败 → 终态 notify（不再自动动作）', d && d.action, 'notify');

// ── Brain：全局预算 ───────────────────────────────────
console.log('== Brain 全局预算 ==');
const c3 = makeClock();
const b3 = new Brain({ clock: c3.now });
for (let i = 0; i < 10; i++) {
  const e = { code: 'NPM-001', stage: 'install', key: 'k' + i };
  const dd = b3.emit(e);
  if (dd) b3.report(e, dd.action, false);
}
const d4 = b3.emit({ code: 'BOOT-003', stage: 'port' });
t('预算耗尽(10/小时) → 只允许 notify', d4 && d4.action, 'notify');
c3.advance(61 * 60 * 1000);
const d5 = b3.emit({ code: 'BOOT-003', stage: 'port' });
t('1 小时后预算恢复 → restart（等级升序优先）', d5 && d5.action, 'restart');

// ── Brain：经验学习（等级优先，经验同等级内生效） ────
console.log('== Brain 经验学习 ==');
const c4 = makeClock();
const b4 = new Brain({ clock: c4.now });
b4.registerRule('EXP-TEST|', ['restart', 'retry']); // 故意倒序注册，引擎应按等级重排
b4.report({ code: 'EXP-TEST', stage: 'x' }, 'restart', true);
b4.report({ code: 'EXP-TEST', stage: 'x' }, 'restart', true);
const d6 = b4.emit({ code: 'EXP-TEST', stage: 'x' });
t('等级优先于经验（retry 等级低仍先选）', d6 && d6.action, 'retry');

// ── Brain：未知指纹 ───────────────────────────────────
console.log('== Brain 未知指纹 ==');
const c5 = makeClock();
const b5 = new Brain({ clock: c5.now });
const d7 = b5.emit({ code: 'ZZZ-999', stage: 'unknown' });
t('未知错误 → notify（不盲目动作）', d7 && d7.action, 'notify');

// ── Brain：节流时间窗 ─────────────────────────────────
console.log('== Brain 节流时间窗 ==');
const c6 = makeClock();
const b6 = new Brain({ clock: c6.now });
b6.report({ code: 'BOOT-002', stage: 'start' }, 'restart', false);
let d8 = b6.emit({ code: 'BOOT-002', stage: 'start' });
t('10 分钟内 restart 被节流 → safe-mode', d8 && d8.action, 'safe-mode');
c6.advance(11 * 60 * 1000);
d8 = b6.emit({ code: 'BOOT-002', stage: 'start' });
t('11 分钟后节流解除 → restart 恢复', d8 && d8.action, 'restart');

// ── Brain：状态持久化 ─────────────────────────────────
console.log('== Brain 状态持久化 ==');
const tmpFile = path.join(os.tmpdir(), 'dsh-brain-test-' + Date.now() + '.json');
const c7 = makeClock();
const b7 = new Brain({ clock: c7.now, stateFile: tmpFile });
b7.report({ code: 'PLG-001', stage: 'load', key: 'modlens' }, 'skip-plugin', true);
b7.report({ code: 'PLG-001', stage: 'load', key: 'modlens' }, 'skip-plugin', false);
const b8 = new Brain({ clock: c7.now, stateFile: tmpFile });
const exp = b8.experience['PLG-001|load|modlens'] || {};
t('经验表持久化(ok)', exp['skip-plugin'] && exp['skip-plugin'].ok, 1);
t('经验表持久化(fail)', exp['skip-plugin'] && exp['skip-plugin'].fail, 1);
fs.writeFileSync(tmpFile, '{{{ 损坏数据');
const b9 = new Brain({ clock: c7.now, stateFile: tmpFile });
t('损坏状态文件不崩溃', b9.experience['PLG-001|load|modlens'] === undefined, true);
fs.unlinkSync(tmpFile);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);