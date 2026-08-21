// 回归测试：更新兼容性机制（src/lib/update-compat.js）
// 覆盖：版本解析 / semver 满足判断 / 纯评估函数（版本跨度·补丁健康·Node 引擎·磁盘）/
//       probeManifest 只读不写 / rollback 调用参数。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createUpdateCompat,
  assessUpdate,
  parseVersion,
  satisfiesNode,
} = require('../src/lib/update-compat.js');
const { probeManifest } = require('../src/lib/patch-manifest.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

console.log('== parseVersion ==');
t('0.1.1-rc.2 解析', JSON.stringify(parseVersion('0.1.1-rc.2')), JSON.stringify({ major: 0, minor: 1, patch: 1, pre: 'rc.2', raw: '0.1.1-rc.2' }));
t('纯数字解析', parseVersion('1.2.3').pre, null);
t('非法版本 → null', parseVersion('abc'), null);

console.log('== satisfiesNode ==');
t('>=18 满足 24.14.0', satisfiesNode('24.14.0', '>=18'), true);
t('>=18 不满足 16.0.0', satisfiesNode('16.0.0', '>=18'), false);
t('^18.0.0 满足 18.2.0', satisfiesNode('18.2.0', '^18.0.0'), true);
t('^18.0.0 不满足 19.0.0', satisfiesNode('19.0.0', '^18.0.0'), false);
t('~18.0.0 满足 18.0.5', satisfiesNode('18.0.5', '~18.0.0'), true);
t('~18.0.0 不满足 18.2.0', satisfiesNode('18.2.0', '~18.0.0'), false);
t('范围 AND >=18 <25', satisfiesNode('24.14.0', '>=18 <25'), true);
t('范围 AND 超上限', satisfiesNode('25.0.0', '>=18 <25'), false);
t('OR 分支 18 || >=20', satisfiesNode('21.0.0', '18 || >=20'), true);
t('无法解析段放行', satisfiesNode('24.0.0', 'weird-range'), true);

console.log('== assessUpdate ==');
// 1) 补丁级升级、补丁健康、Node、磁盘全好 → ok
{
  const r = assessUpdate({
    local: '0.1.1', remote: '0.1.2',
    nodeVersion: '24.14.0',
    freeBytes: 10 * 1024 * 1024 * 1024,
    remoteEngines: { node: '>=18' },
    patchProbe: [{ id: 'a', status: 'ok' }],
  });
  t('补丁级升级 → ok', r.verdict, 'ok');
  t('ok 含回滚保险说明', r.recommendations.some((x) => x.includes('回滚')), true);
}
// 2) 次版本升级 → warn
{
  const r = assessUpdate({ local: '0.1.0', remote: '0.2.0', nodeVersion: '24', freeBytes: 2e9, remoteEngines: { node: '>=18' }, patchProbe: [] });
  t('次版本升级 → warn', r.verdict, 'warn');
  t('风险含"次版本"', r.risks.some((x) => x.text.includes('次版本')), true);
}
// 3) 主版本升级 → block
{
  const r = assessUpdate({ local: '0.9.0', remote: '1.0.0', nodeVersion: '24', freeBytes: 2e9, remoteEngines: { node: '>=18' }, patchProbe: [] });
  t('主版本升级 → block', r.verdict, 'block');
}
// 4) rc → 正式版 → warn
{
  const r = assessUpdate({ local: '0.1.1-rc.2', remote: '0.1.1', nodeVersion: '24', freeBytes: 2e9, remoteEngines: { node: '>=18' }, patchProbe: [] });
  t('rc→正式版 → warn', r.verdict, 'warn');
}
// 5) 补丁失效 → warn 且列出 id
{
  const r = assessUpdate({ local: '0.1.0', remote: '0.1.1', nodeVersion: '24', freeBytes: 2e9, remoteEngines: { node: '>=18' }, patchProbe: [{ id: 'dsh-core-settings-models-search', status: 'failed', error: '锚点失配' }] });
  t('补丁失效 → warn', r.verdict, 'warn');
  t('风险提及失效补丁', r.risks.some((x) => x.text.includes('dsh-core-settings-models-search')), true);
}
// 6) Node 引擎不满足 → block
{
  const r = assessUpdate({ local: '0.1.0', remote: '0.2.0', nodeVersion: '16.0.0', freeBytes: 2e9, remoteEngines: { node: '>=18' }, patchProbe: [] });
  t('Node 不满足 → block', r.verdict, 'block');
}
// 7) 磁盘过小 → danger
{
  const r = assessUpdate({ local: '0.1.0', remote: '0.2.0', nodeVersion: '24', freeBytes: 100 * 1024 * 1024, remoteEngines: { node: '>=18' }, patchProbe: [] });
  t('磁盘 100MB → block', r.verdict, 'block');
}
// 8) 磁盘偏少 → warn
{
  const r = assessUpdate({ local: '0.1.0', remote: '0.2.0', nodeVersion: '24', freeBytes: 600 * 1024 * 1024, remoteEngines: { node: '>=18' }, patchProbe: [] });
  t('磁盘 600MB → warn', r.verdict, 'warn');
}
// 9) 无远程引擎信息 → skip 且不 block
{
  const r = assessUpdate({ local: '0.1.0', remote: '0.2.0', nodeVersion: '24', freeBytes: 2e9, remoteEngines: undefined, patchProbe: [] });
  t('引擎信息缺失不误伤', r.verdict, 'warn'); // 仅次版本 warn
  t('含 skip 检查项', r.checks.some((x) => x.name === 'Node 版本' && x.status === 'skip'), true);
}

console.log('== probeManifest 只读（临时目录，全部跳过，不写盘）==');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'));
  const before = fs.readdirSync(dir).length;
  const r = probeManifest({
    profileDir: dir,
    coreWorkspaceClient: path.join(dir, 'nope-ws.js'),
    coreConversationClient: path.join(dir, 'nope-cv.js'),
    coreSettingsModelsClient: path.join(dir, 'nope-sm.js'),
    dshCoreRoot: path.join(dir, 'no-core'),
  });
  t('全部 skipped（文件缺失）', r.every((x) => x.status === 'skipped'), true);
  t('清单条目数 >= 13', r.length >= 13, true);
  t('探测不写盘', fs.readdirSync(dir).length, before);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('== rollback 参数 ==');
{
  const calls = [];
  const compat = createUpdateCompat({
    profileDir: os.tmpdir(),
    execNode: async (cli, args) => { calls.push([cli, args]); return 'ok'; },
    findNpmCli: () => 'C:\\fake\\npm-cli.js',
    errorLog: { log: () => {} },
    logger: () => {},
  });
  (async () => {
    await compat.rollback('1.2.3');
    t('npm install -g @deepseek-ai/dsh@1.2.3', JSON.stringify(calls[0][1]), JSON.stringify(['install', '-g', '@deepseek-ai/dsh@1.2.3']));
  })().then(() => {
    console.log(`\nresult: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  }).catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
}
