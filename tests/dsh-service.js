// 回归测试：DSH 服务生命周期（src/lib/dsh-service.js）
// 覆盖：导出完整性 / findDshBin 真实定位 / 端口检测 / BOOT-001 缺失 dsh /
//       spawn 成功与失败路径 / killProcess / 运行中退出回调 / stop 幂等
// 注意：electron 依赖通过 Module._load mock（主进程运行时才真实存在）

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => os.homedir() } };
  }
  return origLoad.apply(this, arguments);
};

const { createDshService, findDshBin, DSH_PORT } = require('../src/lib/dsh-service.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', actual, 'expected', expected); }
}

function makeErrorLog() {
  const entries = [];
  return {
    log: (code, ev) => entries.push({ code, ev }),
    entries,
  };
}

function tmpJs(content, name) {
  const f = path.join(os.tmpdir(), `dsh-test-${name}-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

const sleepJs = tmpJs('setTimeout(() => {}, 60000);', 'sleep');
const exitJs = tmpJs('process.exit(0);', 'exit');

// ── 导出完整性 ─────────────────────────────────────────
console.log('== exports ==');
t('DSH_PORT=3080', DSH_PORT, 3080);
t('createDshService 导出', typeof createDshService, 'function');
t('findDshBin 导出', typeof findDshBin, 'function');

// ── findDshBin 真实环境 ────────────────────────────────
console.log('== findDshBin ==');
const dsh = findDshBin();
t('定位到 node 解释器', !!(dsh && dsh.node && fs.existsSync(dsh.node)), true);
t('定位到 dsh bin.js', !!(dsh && dsh.bin && fs.existsSync(dsh.bin)), true);

// ── 端口检测（未监听端口） ─────────────────────────────
console.log('== 端口检测 ==');
const svc = createDshService({ errorLog: makeErrorLog(), logger: () => {} });

(async () => {
  const listening = await svc.isPortListening(49876);
  t('未监听端口 isPortListening=false', listening, false);

  const released = await svc.waitPortReleased(49876, 3, 100);
  t('未监听端口 waitPortReleased=true', released, true);

  const killed = await svc.killProcessOnPort(49876);
  t('未监听端口 killProcessOnPort=true', killed, true);

  // ── API 完整性 ─────────────────────────────────────
  console.log('== API ==');
  for (const m of ['start', 'stop', 'killProcess', 'isRunning', 'isPortListening', 'waitForReady', 'killProcessOnPort', 'waitPortReleased', 'setOnUnexpectedExit', 'findDshBin']) {
    t(`方法存在 ${m}`, typeof svc[m], 'function');
  }
  t('初始未运行', svc.isRunning(), false);

  // ── BOOT-001：找不到 dsh ─────────────────────────────
  console.log('== BOOT-001 ==');
  const el1 = makeErrorLog();
  const svc1 = createDshService({ errorLog: el1, logger: () => {}, findDshBin: () => null });
  let rejected = null;
  await svc1.start().catch((e) => { rejected = e; });
  t('findDshBin null 时 reject', rejected instanceof Error, true);
  t('BOOT-001 错误码记录', el1.entries.some((e) => e.code === 'BOOT-001'), true);

  // ── spawn 成功路径 ──────────────────────────────────
  console.log('== spawn ==');
  const el2 = makeErrorLog();
  const log2 = [];
  const svc2 = createDshService({ errorLog: el2, logger: (m) => log2.push(m), findDshBin: () => ({ node: process.execPath, bin: sleepJs }) });
  await svc2.start();
  t('spawn 成功 resolve 且 isRunning', svc2.isRunning(), true);

  // ── killProcess 后运行中退出回调 ─────────────────────
  let exitInfo = null;
  svc2.setOnUnexpectedExit((code, signal) => { exitInfo = { code, signal }; });
  svc2.killProcess();
  await new Promise((r) => setTimeout(r, 800));
  t('运行中退出回调被触发', exitInfo !== null, true);
  t('kill 后 isRunning=false', svc2.isRunning(), false);

  // ── stop 幂等 ───────────────────────────────────────
  svc2.stop();
  t('stop 幂等不抛错', true, true);

  // ── 再次 start（重启能力） ───────────────────────────
  await svc2.start();
  t('重启后再次运行', svc2.isRunning(), true);
  svc2.stop();
  await new Promise((r) => setTimeout(r, 500));
  t('stop 后 isRunning=false', svc2.isRunning(), false);

  // 清理
  try { fs.unlinkSync(sleepJs); fs.unlinkSync(exitJs); } catch (e) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
