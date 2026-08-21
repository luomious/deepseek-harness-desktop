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

const { createDshService, findDshBin, DSH_PORT, waitForReady, isDSHListening, isPortListening, findPidOnPort } = require('../src/lib/dsh-service.js');

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

  // ── start 防重入（阶段4）────────────────────────────
  console.log('== start re-entrancy ==');
  const svcR = createDshService({ errorLog: makeErrorLog(), logger: () => {}, findDshBin: () => ({ node: process.execPath, bin: sleepJs }) });
  const p1 = svcR.start();
  const p2 = svcR.start();
  t('并发 start 复用同一 promise', p1 === p2, true);
  await p1;
  t('并发 start 后 isRunning=true', svcR.isRunning(), true);
  const p3 = svcR.start();
  t('结算后新 start 是新 promise（可重启）', p3 !== p1, true);
  svcR.stop();
  await new Promise((r) => setTimeout(r, 500));

  // ── isDSHListening / waitForReady 验证（阶段4）───────
  console.log('== isDSHListening ==');
  const httpSrv = require('http').createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>__DSH_BOOT__ boot manifest</html>');
  });
  const nonDsh = require('http').createServer((req, res) => { res.writeHead(200); res.end('hello'); });
  const portA = 49881, portB = 49882;
  await new Promise((r) => httpSrv.listen(portA, '127.0.0.1', r));
  await new Promise((r) => nonDsh.listen(portB, '127.0.0.1', r));
  t('含 __DSH_BOOT__ 判定为 DSH', await isDSHListening(portA), true);
  t('不含 __DSH_BOOT__ 判定非 DSH', await isDSHListening(portB), false);
  t('未监听端口判定非 DSH', await isDSHListening(49890), false);
  // 模块级 waitForReady 支持端口注入（service 包装器固定用 DSH_PORT）
  const readyNonDsh = await waitForReady(portB, 2, 50);
  t('waitForReady 对陌生服务返回 false', readyNonDsh, false);
  const readyDsh = await waitForReady(portA, 2, 50);
  t('waitForReady 对 DSH 服务返回 true', readyDsh, true);
  httpSrv.close();
  nonDsh.close();

  // ── stop 幂等（阶段3 防误杀改造后不抛错）─────────────
  console.log('== stop ==');
  const svcStop = createDshService({ errorLog: makeErrorLog(), logger: () => {}, findDshBin: () => ({ node: process.execPath, bin: sleepJs }) });
  await svcStop.start();
  t('stop 前 isRunning', svcStop.isRunning(), true);
  svcStop.stop();
  svcStop.stop(); // 幂等
  t('stop 幂等不抛错', true, true);

  // 清理
  try { fs.unlinkSync(sleepJs); fs.unlinkSync(exitJs); } catch (e) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
