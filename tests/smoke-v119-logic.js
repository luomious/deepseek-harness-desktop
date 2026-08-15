// 临时回归测试：验证 v1.1.9 审计修复的关键逻辑（不污染仓库，跑完即删）
// 1) isNewer 语义版本比较（复制自 main.js，防止回归）
// 2) checkForUpdates 决策矩阵（重构后的控制流行为）

const assert = require('assert');

// ── isNewer 实现（与 main.js 一致） ──────────────────────
function isNewer(local, remote) {
  if (!local || !remote) return false;
  const parseSemver = (v) => {
    if (typeof v !== 'string') {
      try { v = String(v); } catch (e) { return { parts: [0, 0, 0], pre: '' }; }
    }
    const main = v.replace(/-.*$/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pre = v.includes('-') ? v.split('-')[1] : '';
    return { parts: main, pre };
  };
  const lp = parseSemver(local);
  const rp = parseSemver(remote);
  for (let i = 0; i < 3; i++) {
    const l = lp.parts[i] || 0;
    const r = rp.parts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  if (!lp.pre && !rp.pre) return false;
  if (!lp.pre && rp.pre) return false;
  if (lp.pre && !rp.pre) return true;
  const lpParts = lp.pre.split('.');
  const rpParts = rp.pre.split('.');
  const maxLen = Math.max(lpParts.length, rpParts.length);
  for (let i = 0; i < maxLen; i++) {
    const l = lpParts[i];
    const r = rpParts[i];
    if (l === undefined) return true;
    if (r === undefined) return false;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? parseInt(l, 10) : NaN;
    const rn = /^\d+$/.test(r) ? parseInt(r, 10) : NaN;
    if (!isNaN(ln) && !isNaN(rn)) return rn > ln;
    return r > l;
  }
  return false;
}

// ── checkForUpdates 决策逻辑（重构后，与 main.js 一致） ───
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
      // 静默模式：只记录日志
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
  if (actual === expected) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '→ got', actual, 'expected', expected); }
}

console.log('== isNewer ==');
t('1.0.0 vs 2.0.0 → true', isNewer('1.0.0', '2.0.0'), true);
t('2.0.0 vs 1.0.0 → false', isNewer('2.0.0', '1.0.0'), false);
t('1.0.0 vs 1.0.0 → false', isNewer('1.0.0', '1.0.0'), false);
t('1.0.0 vs 1.1.0 → true', isNewer('1.0.0', '1.1.0'), true);
t('1.1.0 vs 1.0.5 → true', isNewer('1.0.5', '1.1.0'), true);
t('1.0.0 vs 1.0.0-rc.1 → false (正式版更新)', isNewer('1.0.0', '1.0.0-rc.1'), false);
t('1.0.0-rc.1 vs 1.0.0 → true (rc→正式版)', isNewer('1.0.0-rc.1', '1.0.0'), true);
t('1.0.0-rc.1 vs 1.0.0-rc.2 → true', isNewer('1.0.0-rc.1', '1.0.0-rc.2'), true);
t('1.0.0-rc.2 vs 1.0.0-rc.1 → false', isNewer('1.0.0-rc.2', '1.0.0-rc.1'), false);
t('1.0.0-alpha vs 1.0.0-alpha.1 → true', isNewer('1.0.0-alpha', '1.0.0-alpha.1'), true);
t('1.0.0-beta vs 1.0.0-alpha → true (beta>alpha)', isNewer('1.0.0-alpha', '1.0.0-beta'), true);
t('null vs 1.0.0 → false', isNewer(null, '1.0.0'), false);
t('1.0.0 vs null → false', isNewer('1.0.0', null), false);
t('数字版本 1 vs 2 → true', isNewer(1, 2), true);
t('1.2 vs 1.10 → true (数值比较)', isNewer('1.2', '1.10'), true);

console.log('== checkForUpdates 决策矩阵 ==');
// 场景 1：静默检查，有更新 → 不弹窗、不更新
let r = simulateCheck(true, true, -1);
t('silent+有更新 → 不弹窗', r.dialogShown === null, true);
t('silent+有更新 → 不更新', r.performUpdateCalled === false, true);
t('silent+有更新 → hasUpdate=true', r.hasUpdate === true, true);

// 场景 2：手动检查，有更新，选「立即更新」(choice=0) → performUpdate
r = simulateCheck(false, true, 0);
t('手动+有更新+立即更新 → 弹"发现新版本"', r.dialogShown === 'update-available', true);
t('手动+有更新+立即更新 → performUpdate 被调用', r.performUpdateCalled === true, true);

// 场景 3：手动检查，有更新，选「稍后再说」(choice=1) → 不弹"已是最新版本"
r = simulateCheck(false, true, 1);
t('手动+有更新+稍后再说 → 弹"发现新版本"', r.dialogShown === 'update-available', true);
t('手动+有更新+稍后再说 → 不弹"已是最新版本"', r.dialogShown !== 'up-to-date', true);
t('手动+有更新+稍后再说 → hasUpdate=true', r.hasUpdate === true, true);

// 场景 4：手动检查，无更新 → 弹"已是最新版本"
r = simulateCheck(false, false, -1);
t('手动+无更新 → 弹"已是最新版本"', r.dialogShown === 'up-to-date', true);

// 场景 5：静默检查，无更新 → 不弹窗
r = simulateCheck(true, false, -1);
t('silent+无更新 → 不弹窗', r.dialogShown === null, true);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
