// 回归测试：补丁自愈清单（src/lib/patch-manifest.js）
// 覆盖：未补丁→应用 / 已补丁→跳过(幂等) / 文件缺失→skipped / 格式意外→failed 不损坏

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  reconcilePatches,
  patchModlensIndex,
  patchModlensKey,
  patchSafeDeleteKey,
} = require('../src/lib/patch-manifest.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

// ── 补丁函数单元 ─────────────────────────────────────
console.log('== 补丁函数 ==');
// modlens index.js：无参调用 → 加 scope.settings
let r = patchModlensIndex('function x() { registerSettingsNamespace() }');
t('index.js 未补 → applied', r.status, 'applied');
t('index.js 补丁内容正确', r.fixed.includes('registerSettingsNamespace(scope.settings)'), true);
r = patchModlensIndex(r.fixed);
t('index.js 已补 → ok(幂等)', r.status, 'ok');
r = patchModlensIndex('function x() { registerSettingsNamespace(scope.settings) }');
t('index.js 带参形式 → ok', r.status, 'ok');
r = patchModlensIndex('function x() { nothing() }');
t('index.js 格式意外 → failed', r.status, 'failed');

// modlens client.js：id 后补 key
r = patchModlensKey("slots.register({ id: 'modlens', order: 30 })");
t('client.js 未补 → applied', r.status, 'applied');
t('client.js 补丁内容正确', r.fixed.includes("id: 'modlens', key: 'modlens'"), true);
r = patchModlensKey(r.fixed);
t('client.js 已补 → ok', r.status, 'ok');

// safe-delete client.js
r = patchSafeDeleteKey("slots.register({ id: 'safe-delete', order: 30 })");
t('safe-delete 未补 → applied', r.status, 'applied');
t('safe-delete 补丁内容正确', r.fixed.includes("key: 'safe-delete'"), true);
r = patchSafeDeleteKey(r.fixed);
t('safe-delete 已补 → ok', r.status, 'ok');

// ── 清单集成 ─────────────────────────────────────────
console.log('== 清单集成 ==');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patchm-'));
const modlensDir = path.join(dir, 'node_modules', '@liustack', 'modlens', 'dsh');
const safeDir = path.join(dir, 'node_modules', 'dsh-safe-delete', 'lib');
fs.mkdirSync(modlensDir, { recursive: true });
fs.mkdirSync(safeDir, { recursive: true });
fs.writeFileSync(path.join(modlensDir, 'index.js'), 'function x() { registerSettingsNamespace() }');
fs.writeFileSync(path.join(modlensDir, 'client.js'), "slots.register({ id: 'modlens', order: 30 })");
fs.writeFileSync(path.join(safeDir, 'client.js'), "slots.register({ id: 'safe-delete', order: 30 })");

let results = reconcilePatches({ profileDir: dir });
t('3 项补丁全部 applied', results.filter((x) => x.status === 'applied').length, 3);

// 幂等：再跑一次 → 全部 ok
results = reconcilePatches({ profileDir: dir });
t('再跑幂等 → 全部 ok', results.filter((x) => x.status === 'ok').length, 3);

// 文件真实被修改
t('index.js 文件已写入补丁', fs.readFileSync(path.join(modlensDir, 'index.js'), 'utf8').includes('scope.settings'), true);
t('client.js 文件已写入补丁', fs.readFileSync(path.join(modlensDir, 'client.js'), 'utf8').includes("key: 'modlens'"), true);

// 缺失文件 → skipped
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patchm-empty-'));
results = reconcilePatches({ profileDir: emptyDir });
t('缺失文件 → skipped', results.every((x) => x.status === 'skipped'), true);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);