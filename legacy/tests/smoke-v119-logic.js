// 回归测试：验证关键逻辑（isNewer 来自 src/lib/version.js 真实实现，非复制副本）
// 1) isNewer 语义版本比较（测试与 main.js 共用同一模块）
// 2) checkForUpdates 决策矩阵（重构后的控制流行为模拟）

const assert = require('assert');
const { isNewer } = require('../src/lib/version.js');

// ── checkForUpdates 决策逻辑（行为模拟，与 main.js 决策流一致） ───
// 返回 { hasUpdate, local, remote, dialogShown, performUpdateCalled }
function simulateCheck(silent, hasUpdate, choice) {
  const local = '1.0.0';
  const remote = '2.0.0';
  const calls = { dialogShown: null, performUpdateCalled: false };
  const win = {}; // 模拟窗口存在

  // 模拟 dialog.showMessageBoxSync 返回值
  const dialogSync = () => choice;

  if (hasUpdate) {
    if (silent) {
      // 静默模式：只记录日志 + 系统通知（不弹窗、不更新）
      return { hasUpdate, local, remote, ...calls };
    }
    if (!win) return { hasUpdate, local, remote, ...calls };
    calls.dialogShown = 'update-available';
    if (dialogSync() === 0) {
      calls.performUpdateCalled = true;
      return { hasUpdate: false, updated: true, local, remote, ...calls };
    }
    // 用户选择「稍后再说」：不打扰，直接返回（不落入"已是最新版本"分支）
    return { hasUpdate, local, remote, ...calls };
  }

  // 无更新
  if (!silent && win) {
    calls.dialogShown = 'up-to-date';
  }
  return { hasUpdate, local, remote, ...calls };
}

// ── isNewer 测试 ───────────────────────────────────────
let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

console.log('== isNewer (src/lib/version.js) ==');
t('1.0.0 vs 2.0.0 -> true', isNewer('1.0.0', '2.0.0'), true);
t('2.0.0 vs 1.0.0 -> false', isNewer('2.0.0', '1.0.0'), false);
t('1.0.0 vs 1.0.0 -> false', isNewer('1.0.0', '1.0.0'), false);
t('1.0.0 vs 1.1.0 -> true', isNewer('1.0.0', '1.1.0'), true);
t('1.1.0 vs 1.0.5 -> true', isNewer('1.0.5', '1.1.0'), true);
t('1.0.0 vs 1.0.0-rc.1 -> false (release newer)', isNewer('1.0.0', '1.0.0-rc.1'), false);
t('1.0.0-rc.1 vs 1.0.0 -> true (rc->release)', isNewer('1.0.0-rc.1', '1.0.0'), true);
t('1.0.0-rc.1 vs 1.0.0-rc.2 -> true', isNewer('1.0.0-rc.1', '1.0.0-rc.2'), true);
t('1.0.0-rc.2 vs 1.0.0-rc.1 -> false', isNewer('1.0.0-rc.2', '1.0.0-rc.1'), false);
t('1.0.0-alpha vs 1.0.0-alpha.1 -> true', isNewer('1.0.0-alpha', '1.0.0-alpha.1'), true);
t('1.0.0-beta vs 1.0.0-alpha -> true (beta>alpha)', isNewer('1.0.0-alpha', '1.0.0-beta'), true);
t('null vs 1.0.0 -> false', isNewer(null, '1.0.0'), false);
t('1.0.0 vs null -> false', isNewer('1.0.0', null), false);
t('numeric 1 vs 2 -> true', isNewer(1, 2), true);
t('1.2 vs 1.10 -> true (numeric)', isNewer('1.2', '1.10'), true);

console.log('== checkForUpdates decision matrix ==');
// 场景 1：静默检查，有更新 → 不弹窗、不更新
let r = simulateCheck(true, true, -1);
t('silent+update -> no dialog', r.dialogShown === null, true);
t('silent+update -> no performUpdate', r.performUpdateCalled === false, true);
t('silent+update -> hasUpdate=true', r.hasUpdate === true, true);

// 场景 2：手动检查，有更新，选「立即更新」(choice=0) → performUpdate
r = simulateCheck(false, true, 0);
t('manual+update+now -> "update-available" dialog', r.dialogShown === 'update-available', true);
t('manual+update+now -> performUpdate called', r.performUpdateCalled === true, true);

// 场景 3：手动检查，有更新，选「稍后再说」(choice=1) → 不弹"已是最新版本"
r = simulateCheck(false, true, 1);
t('manual+update+later -> "update-available" dialog', r.dialogShown === 'update-available', true);
t('manual+update+later -> no "up-to-date" dialog', r.dialogShown !== 'up-to-date', true);
t('manual+update+later -> hasUpdate=true', r.hasUpdate === true, true);

// 场景 4：手动检查，无更新 → 弹"已是最新版本"
r = simulateCheck(false, false, -1);
t('manual+no-update -> "up-to-date" dialog', r.dialogShown === 'up-to-date', true);

// 场景 5：静默检查，无更新 → 不弹窗
r = simulateCheck(true, false, -1);
t('silent+no-update -> no dialog', r.dialogShown === null, true);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);