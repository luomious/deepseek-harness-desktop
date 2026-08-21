// 回归测试：安全模式对 cordis.patch.yml 中第三方 insert 挂载块的处理（阶段5）
// 覆盖：apply 同时备份/移除 insert 块 / restore 原样还原 / 旧格式备份（无 patchBlocks）兼容

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

function setupProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-safem-'));
  const pkg = {
    name: 'web',
    dependencies: {
      '@deepseek-ai/dsh-base': '1.0.0',
      '@deepseek-ai/dsh-web-app': '1.0.0',
      'third-party-bundle': '1.0.0',
      'pure-client-plugin': '1.0.0',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'third-party-bundle'] } },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  const patch = [
    '# profile patch',
    '- id: core-entry',
    '  disabled: false',
    '',
    '- insert:',
    "    - id: 'pure-client-plugin'",
    "      name: 'pure-client-plugin'",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
  return dir;
}

const CORE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

console.log('== safe-mode insert 块 ==');
const dir = setupProfile();
const sm = new SafeMode({ profileDir: dir, coreDeps: CORE, backupName: '.test-backup.json' });

const applied = sm.apply();
t('apply 返回移除的 bundle', applied && applied.removed.includes('third-party-bundle'), true);
t('apply 报告移除了 insert 块', applied && applied.removedClientBlocks === 1, true);

let pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
t('bundle 只剩核心', JSON.stringify(pkg.dsh.profile.bundles), JSON.stringify(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']));

let patchText = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
t('第三方 insert 块已移除', !patchText.includes('pure-client-plugin'), true);
t('非 insert 块保留', patchText.includes('- id: core-entry'), true);

const backup = JSON.parse(fs.readFileSync(sm.backupFile, 'utf8'));
t('备份含 patchBlocks', Array.isArray(backup.patchBlocks) && backup.patchBlocks.length === 1, true);

t('restore 返回 true', sm.restore(), true);
t('restore 后备份已删', !fs.existsSync(sm.backupFile), true);
pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
t('bundle 已还原', pkg.dsh.profile.bundles.includes('third-party-bundle'), true);
patchText = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
t('insert 块已还原', patchText.includes("name: 'pure-client-plugin'"), true);
t('原 header 注释保留', patchText.startsWith('# profile patch'), true);

// 旧格式备份兼容（仅 { pkg }，无 patchBlocks）
console.log('== 旧格式备份兼容 ==');
const dir2 = setupProfile();
const originalPkg2 = JSON.parse(fs.readFileSync(path.join(dir2, 'package.json'), 'utf8'));
const sm2 = new SafeMode({ profileDir: dir2, coreDeps: CORE, backupName: '.test-backup2.json' });
sm2.apply();
fs.writeFileSync(sm2.backupFile, JSON.stringify({ pkg: originalPkg2 }, null, 2));
// 覆盖 apply 产生的备份为旧格式，验证 restore 仍正常
t('旧格式 restore 返回 true', sm2.restore(), true);
t('旧格式 restore 后 bundle 还原', JSON.parse(fs.readFileSync(path.join(dir2, 'package.json'), 'utf8')).dsh.profile.bundles.includes('third-party-bundle'), true);

// restore 幂等（无备份）
t('无备份 restore 返回 false', sm2.restore(), false);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dir2, { recursive: true, force: true });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
