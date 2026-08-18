// 回归测试：插件管理数据层（src/lib/plugin-manager.js）
// 覆盖：清单过滤核心依赖 / 行 id 解析（patch 与回退）/ bundle 与纯前端插件禁用启用 /
//       reconcile 对齐（bundles 层 + insert 挂载块 + 卸载清理）/ 安装错误路径 / 核心依赖保护。
// 全部在临时 profile 目录真实文件操作，注入 fake pnpm/node 环境。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPluginManager } = require('../src/lib/plugin-manager.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

function validateArgStub(input, type) {
  if (!input || typeof input !== 'string') return '参数为空';
  if (input.length > 512) return '参数过长';
  if (type === 'pkg' && !/^(@[a-z0-9](?:[a-z0-9-._~]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9-._~]*[a-z0-9])?$/i.test(input)) return '插件名不合法';
  if (type === 'path' && !path.isAbsolute(input)) return '必须是绝对路径';
  return null;
}

// ── 造临时 profile ────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plg-test-'));
function writePkg(dir, name, extra = {}) {
  const base = path.join(dir, 'node_modules', name);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }), 'utf8');
  return base;
}

// bundle 皮肤插件：声明 dsh.bundle.patch，patch 里行 id = ui-skin-maid-atelier
writePkg(tmp, 'ui-skin-x', { dsh: { bundle: { patch: 'patch.yml' } } });
fs.writeFileSync(path.join(tmp, 'node_modules', 'ui-skin-x', 'patch.yml'), '- insert:\n  - id: ui-skin-maid-atelier\n    name: ui-skin-maid-atelier\n', 'utf8');
// 纯前端插件：dsh.client + exports["./client"]
writePkg(tmp, 'pure-client-p', { dsh: { client: true }, exports: { './client': './client.js' } });
fs.writeFileSync(path.join(tmp, 'node_modules', 'pure-client-p', 'client.js'), 'export default {};\n', 'utf8');
// 无前端入口插件
writePkg(tmp, 'plain-plugin');
// 核心依赖
writePkg(tmp, '@deepseek-ai/dsh-base');

const pkgJson = {
  name: 'web',
  dependencies: {
    'ui-skin-x': '^1.0.0',
    'pure-client-p': '^1.0.0',
    'plain-plugin': '^1.0.0',
    '@deepseek-ai/dsh-base': '^0.1.0',
  },
  dsh: { profile: { bundles: [] } },
};
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'cordis.patch.yml'), '# dsh profile patch\n[]\n', 'utf8');

const CORE = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
const pm = createPluginManager({
  profileDir: tmp,
  coreDeps: CORE,
  validateArg: validateArgStub,
  findPnpmBin: () => null, // 安装路径不可达 → 触发错误路径
  getNodeExe: () => null,
  logger: () => {},
});

// ── 清单与行 id ───────────────────────────────────────
console.log('== 插件清单 ==');
const plugins = pm.getInstalledPlugins();
t('清单含 ui-skin-x', plugins.some((p) => p.name === 'ui-skin-x'), true);
t('清单过滤核心依赖', plugins.some((p) => p.name === '@deepseek-ai/dsh-base'), false);
t('清单共 3 个第三方', plugins.length, 3);
t('皮肤默认未禁用', plugins.find((p) => p.name === 'ui-skin-x').disabled, false);

console.log('== 行 id 解析 ==');
t('bundle 插件行 id 取 patch', pm.getPluginRowIds('ui-skin-x').join(','), 'ui-skin-maid-atelier');
t('普通插件行 id 回退包名', pm.getPluginRowIds('plain-plugin').join(','), 'plain-plugin');

console.log('== reconcile: bundle 进 bundles 层 + 纯前端自动挂载 ==');
pm.reconcilePlugins();
const pkgAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
t('ui-skin-x 进入 bundles 层', (pkgAfter.dsh.profile.bundles || []).includes('ui-skin-x'), true);
const patchText = fs.readFileSync(path.join(tmp, 'cordis.patch.yml'), 'utf8');
t('纯前端自动挂载块', patchText.includes("name: 'pure-client-p'"), true);
t('无前端入口不挂载', patchText.includes("name: 'plain-plugin'"), false);

console.log('== 禁用/启用 ==');
(async () => {
  // bundle 插件禁用
  let r = await pm.setPluginEnabled('ui-skin-x', false);
  t('bundle 禁用成功', r.success, true);
  t('bundle 已禁用', pm.isPluginDisabled('ui-skin-x'), true);
  r = await pm.setPluginEnabled('ui-skin-x', true);
  t('bundle 重新启用', r.success, true);
  t('bundle 已启用', pm.isPluginDisabled('ui-skin-x'), false);

  // 纯前端插件禁用
  r = await pm.setPluginEnabled('pure-client-p', false);
  t('纯前端禁用成功', r.success, true);
  t('纯前端已禁用', pm.isPluginDisabled('pure-client-p'), true);
  r = await pm.setPluginEnabled('pure-client-p', true);
  t('纯前端重新启用', r.success, true);
  t('纯前端已启用', pm.isPluginDisabled('pure-client-p'), false);

  // 核心依赖保护
  r = await pm.setPluginEnabled('@deepseek-ai/dsh-base', false);
  t('核心依赖禁用被拦截', r.success, false);
  t('核心依赖错误信息', r.error, '核心依赖不允许禁用');

  // 未安装插件
  r = await pm.setPluginEnabled('not-installed-p', false);
  t('未安装插件返回错误', r.success, false);

  // 无前端入口插件
  r = await pm.setPluginEnabled('plain-plugin', false);
  t('无前端入口插件返回错误', r.success, false);
  t('提示无需禁用', r.error, '该插件无前端入口，卸载即可移除，无需禁用');

  console.log('== reconcile: 卸载后清理 ==');
  const pkg2 = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  delete pkg2.dependencies['ui-skin-x'];
  pkg2.dsh.profile.bundles = ['ui-skin-x'];
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg2, null, 2) + '\n', 'utf8');
  pm.reconcilePlugins();
  const pkg3 = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  t('卸载后 bundles 层移除', (pkg3.dsh.profile.bundles || []).includes('ui-skin-x'), false);
  const patchText2 = fs.readFileSync(path.join(tmp, 'cordis.patch.yml'), 'utf8');
  t('纯前端挂载块保留', patchText2.includes("name: 'pure-client-p'"), true);

  console.log('== 安装错误路径（pnpm 不可用） ==');
  r = await pm.installPlugin('some-plugin');
  t('pnpm 缺失返回失败', r.success, false);
  t('错误含 pnpm 提示', r.error.includes('pnpm'), true);

  r = await pm.installLocalPlugin('D:\\no-such-dir');
  t('本地路径不存在', r.success, false);

  r = await pm.uninstallPlugin('@deepseek-ai/dsh-base');
  t('核心依赖卸载被拦截', r.success, false);

  // 清理
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });