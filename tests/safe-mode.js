// 回归测试：熔断/安全模式（src/lib/safe-mode.js）
// 覆盖：失败计数判定(阈值/窗口/错误码过滤) / 备份移出第三方 bundle / 恢复 / 幂等

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SafeMode } = require('../src/lib/safe-mode.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

const CORE = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-safemode-'));
const pkgPath = path.join(dir, 'package.json');
const ORIGINAL = {
  dependencies: { '@deepseek-ai/dsh': '1.0.0', 'modlens': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'modlens'] } },
};
fs.writeFileSync(pkgPath, JSON.stringify(ORIGINAL, null, 2) + '\n');

const sm = new SafeMode({ profileDir: dir, coreDeps: CORE });

// ── 判定逻辑 ─────────────────────────────────────────
console.log('== shouldEnter ==');
const now = Date.now();
const throttle3 = { 'BOOT-004|wait|restart': [now - 1000, now - 2000, now - 3000] };
t('3 次失败 → 进入安全模式', sm.shouldEnter(throttle3, ['BOOT-004|']), true);
const throttle2 = { 'BOOT-004|wait|restart': [now - 1000, now - 2000] };
t('2 次失败 → 不进入', sm.shouldEnter(throttle2, ['BOOT-004|']), false);
const throttleOld = { 'BOOT-004|wait|restart': [now - 61 * 60 * 1000, now - 62 * 60 * 1000, now - 63 * 60 * 1000] };
t('窗口外(>1h)失败 → 不进入', sm.shouldEnter(throttleOld, ['BOOT-004|']), false);
const throttleOther = { 'NPM-001|install|k0': [now - 1000, now - 2000, now - 3000] };
t('非 BOOT-004 错误不计入', sm.shouldEnter(throttleOther, ['BOOT-004|']), false);
const throttleMixed = { 'BOOT-004|wait|restart': [now - 1000, now - 2000], 'NPM-001|install|x': [now - 500] };
t('混合错误只统计目标错误码', sm.shouldEnter(throttleMixed, ['BOOT-004|']), false);
t('空 throttle → 不进入', sm.shouldEnter({}, ['BOOT-004|']), false);

// ── apply：备份 + 移出第三方 ─────────────────────────
console.log('== apply ==');
const applied = sm.apply();
t('移出的第三方 bundle 正确', JSON.stringify(applied.removed), JSON.stringify(['modlens']));
const after = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
t('安全模式后仅剩核心 bundle', JSON.stringify(after.dsh.profile.bundles), JSON.stringify(['@deepseek-ai/dsh-base']));
t('备份文件已创建', sm.hasBackup(), true);
t('再次 apply 幂等(无第三方可移 → null)', sm.apply(), null);

// ── restore ──────────────────────────────────────────
console.log('== restore ==');
t('恢复成功', sm.restore(), true);
t('恢复后配置与原始一致', JSON.stringify(JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))), JSON.stringify(ORIGINAL));
t('备份文件已删除', sm.hasBackup(), false);
t('重复 restore 幂等(无备份 → false)', sm.restore(), false);

// 异常退出场景：apply 后不 restore → hasBackup 仍在
sm.apply();
t('未恢复时备份仍在', sm.hasBackup(), true);

// 无 package.json 目录
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-safemode-empty-'));
const sm2 = new SafeMode({ profileDir: emptyDir, coreDeps: CORE });
t('无配置文件 apply → null', sm2.apply(), null);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);