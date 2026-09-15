/**
 * tests/plugins/instance-janitor-orphan-reclaim.test.mjs
 *   —— plugins/dsh-instance-janitor 判据回归测试（2026-09-14 孤儿网关回收缺陷）
 *
 * 背景（真实事故）：主进程被外部强杀（疑安全软件 HIPS 拦截）→ `process.on('exit')` 钩子
 * 没跑到 → detached hy3 网关永久占着 127.0.0.1:8787，用户可见「关了 DSH 后台还有进程」。
 * 旧判据 `startedMs >= anchor - tol ⇒ continue` 要求「启动时间必须早于当前主进程」才回收，
 * 于是**当前代孤儿永远漏网**——它的启动时间恰恰晚于 anchor。本测试锁住新判据：
 *
 *   1. **孤儿优先**：父进程不存在 ⇒ 无论启动时间都回收（核心回归锁）；
 *   2. **归属闸门**：crashpad_handler.exe 是 Chromium 系通用子进程名，非 DSH 归属一律不碰
 *      （2026-09-14 实测误杀 GameViewer 的 crashpad_handler）；
 *   3. **旧代兜底**仍在（父存活 + 启动早于 anchor）；
 *   4. 其余 DSH Desktop.exe 进程只报告、绝不自动杀；
 *   5. 字段缺失 / 旧格式查询时 fail-safe（不判孤儿、不误杀）；
 *   6. probeTcp 对监听/关闭端口判定正确（补拉去重依赖它）。
 *
 * 运行：node --test tests/plugins/instance-janitor-orphan-reclaim.test.mjs
 * （纯函数 + 本地 loopback 端口；不 spawn 外部进程、不杀任何进程、不读写真实状态文件）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import {
  name,
  inject,
  resolveConfig,
  ownedByDsh,
  isOrphan,
  classifyCandidate,
  planSweep,
  candidateKey,
  probeTcp,
  apply,
} from '../../plugins/dsh-instance-janitor/lib/index.js';

const ANCHOR = Date.parse('2026-09-14T12:00:00.000Z');
const TOL = 2000;
const GW_CL = 'node.exe "D:\\Deepseek-Harness\\hy3-gateway\\server.js"';

/** 造一行查询记录（默认＝当前代的正常 DSH 子进程）。 */
function row(over = {}) {
  return {
    pp: 1000,
    pi: 900,
    pa: true,
    pn: 'DSH Desktop',
    nm: 'DSH Desktop.exe',
    st: new Date(ANCHOR + 10_000).toISOString(),
    cl: '"C:\\App\\DSH Desktop.exe" --type=utility',
    ep: 'C:\\App\\DSH Desktop.exe',
    ...over,
  };
}

/** 常见的 planSweep 调用参数 */
function planOf(procs, selfPid = 555) {
  return planSweep(procs, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid });
}

// ── 模块契约 ───────────────────────────────────────────────────────────

test('插件声明 name 与 inject', () => {
  assert.equal(name, '@dsh-external/dsh-instance-janitor');
  // 契约锁：cordis 服务必须出现在 inject 里，否则 apply 里读到 undefined 且逻辑静默跳过
  assert.deepEqual(inject, ['timer']);
});

test('resolveConfig 默认与校验', () => {
  const c = resolveConfig(undefined);
  assert.equal(c.intervalMs, 60 * 60 * 1000);
  assert.equal(c.sweepOnStart, true);
  assert.equal(c.generationToleranceMs, 2000);
  assert.equal(typeof c.gatewayPort, 'number');
  assert.ok(c.gatewayPort > 0 && c.gatewayPort < 65_536);
  assert.equal(resolveConfig({ gatewayPort: 9999, intervalMs: 120_000 }).gatewayPort, 9999);
  assert.throws(() => resolveConfig({ intervalMs: 1000 }), /intervalMs must be >= 60000/);
});

// ── 归属闸门（误杀回归锁） ─────────────────────────────────────────────

test('ownedByDsh 认网关命令行 / DSH 父进程 / DSH 路径；不认第三方 crashpad', () => {
  const dshPids = new Set([900, 555]);
  assert.equal(ownedByDsh(row({ cl: GW_CL }), dshPids), true, '网关靠命令行自证');
  assert.equal(ownedByDsh(row({ pi: 900, cl: 'x', nm: 'crashpad_handler.exe' }), dshPids), true, '父 PID 在 DSH 集内');
  assert.equal(
    ownedByDsh(row({
      pi: 7001,
      pn: 'GameViewerService',
      nm: 'gv-crashpad.exe',
      cl: '"C:\\Program Files\\GameViewer\\gv-crashpad.exe" --type=crashpad-handler',
      ep: 'C:\\Program Files\\GameViewer\\gv-crashpad.exe',
    }), dshPids),
    false,
    '父是第三方、命令行/路径也不含 DSH ⇒ 非 DSH 归属',
  );
  assert.equal(
    ownedByDsh({
      pp: 5001,
      pi: 7001,
      pa: false,
      pn: null,
      nm: 'crashpad_handler.exe',
      cl: '"C:\\Program Files\\GameViewer\\crashpad_handler.exe" --type=crashpad-handler',
      ep: 'C:\\Program Files\\GameViewer\\crashpad_handler.exe',
    }, dshPids),
    false,
    'GameViewer 的 crashpad 必须判为「非 DSH」',
  );
  assert.equal(
    ownedByDsh({ pp: 5002, pi: 8001, pa: false, pn: null, nm: 'crashpad_handler.exe', cl: '"C:\\App\\DSH Desktop.exe" --type=crashpad-handler', ep: '' }, dshPids),
    true,
    '命令行含 DSH Desktop 才算自己的',
  );
});

// ── 孤儿判定 ───────────────────────────────────────────────────────────

test('isOrphan：父不存在 ⇒ 孤儿；父存活且是 DSH ⇒ 不是；父名不可得 ⇒ 不判（fail-safe）', () => {
  assert.equal(isOrphan(row({ pa: false, pn: null, pi: 999999 }), { dshPids: new Set() }), true);
  assert.equal(isOrphan(row({ pa: true, pn: 'DSH Desktop', pi: 900 }), { dshPids: new Set() }), false);
  assert.equal(isOrphan(row({ pa: true, pn: 'DSH Desktop', pi: 900 }), { dshPids: new Set([900]) }), false);
  // PID 复用：父 PID 被别的程序占了 ⇒ 真正的父其实已死
  assert.equal(isOrphan(row({ pa: true, pn: 'svchost', pi: 5000 }), { dshPids: new Set() }), true);
  // 旧格式查询（没有 pa 字段）不得凭空判孤儿
  assert.equal(isOrphan({ pp: 1, nm: 'DSH Desktop.exe' }, { dshPids: new Set() }), false);
  assert.equal(isOrphan({ pp: 1, pa: true, pn: '' }, { dshPids: new Set() }), false);
});

// ── classifyCandidate 单点判据 ─────────────────────────────────────────

test('classifyCandidate 跳过自身 / 系统进程 / 非目标进程', () => {
  assert.equal(classifyCandidate(row({ pp: 555 }), { selfPid: 555 }).reason, 'self');
  assert.equal(classifyCandidate(row({ pp: 4 }), {}).reason, 'system-or-invalid-pid');
  assert.equal(classifyCandidate(row({ pp: 0 }), {}).reason, 'system-or-invalid-pid');
  assert.equal(classifyCandidate({ pp: 100, nm: 'chrome.exe', cl: 'chrome.exe' }, {}).reason, 'not-a-target');
});

test('classifyCandidate：当前代**孤儿**网关必须回收（本轮核心修复）', () => {
  const p = row({ pp: 4242, pi: 999_999, pa: false, pn: null, cl: GW_CL, st: new Date(ANCHOR + 5_000).toISOString() });
  // 前提断言：它的启动时间晚于 anchor —— 旧判据正是因此放行，才让 8787 被长期占用
  assert.ok(Date.parse(p.st) >= ANCHOR - TOL, '构造前提：晚于当前代 anchor');
  const c = classifyCandidate(p, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set() });
  assert.equal(c.action, 'kill');
  assert.equal(c.kind, 'gateway');
  assert.equal(c.reason, 'orphan');
});

test('classifyCandidate：当前代存活网关不碰（不能误杀在服役的网关）', () => {
  const p = row({ pp: 4243, pi: 555, pa: true, pn: 'DSH Desktop', cl: GW_CL });
  assert.equal(classifyCandidate(p, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set([555]) }).action, 'ignore');
});

test('classifyCandidate：旧代兜底仍在（父存活 + 启动早于 anchor）', () => {
  const p = row({ pp: 4244, pi: 555, pa: true, pn: 'DSH Desktop', cl: GW_CL, st: new Date(ANCHOR - 3_600_000).toISOString() });
  const c = classifyCandidate(p, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set([555]) });
  assert.equal(c.action, 'kill');
  assert.equal(c.reason, 'stale-generation');
});

test('classifyCandidate：非 DSH 归属的 crashpad 即便失父也不杀（误杀回归锁）', () => {
  const p = row({
    pp: 5001,
    pi: 7001,
    pa: false,
    pn: null,
    nm: 'crashpad_handler.exe',
    cl: '"C:\\Program Files\\GameViewer\\crashpad_handler.exe" --type=crashpad-handler --database="C:\\Users\\x\\AppData\\Local\\GameViewer\\Crashpad"',
    ep: 'C:\\Program Files\\GameViewer\\crashpad_handler.exe',
  });
  const c = classifyCandidate(p, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set() });
  assert.equal(c.action, 'ignore');
  assert.equal(c.reason, 'crashpad-not-owned');
});

test('classifyCandidate：DSH 自己的 crashpad 孤儿/旧代才回收', () => {
  const orphan = row({ pp: 5002, pi: 8001, pa: false, pn: null, nm: 'crashpad_handler.exe', cl: '"C:\\App\\DSH Desktop.exe" --type=crashpad-handler', ep: '' });
  const c1 = classifyCandidate(orphan, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set() });
  assert.equal(c1.action, 'kill');
  assert.equal(c1.kind, 'crashpad');
  assert.equal(c1.reason, 'orphan');

  const stale = row({ pp: 5003, pi: 555, pa: true, pn: 'DSH Desktop', nm: 'crashpad_handler.exe', cl: '"C:\\App\\DSH Desktop.exe" --type=crashpad-handler', st: new Date(ANCHOR - 60_000).toISOString() });
  const c2 = classifyCandidate(stale, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set([555]) });
  assert.equal(c2.action, 'kill');
  assert.equal(c2.reason, 'stale-generation');
});

test('classifyCandidate：旧代 DSH Desktop 进程只报告、绝不自动杀', () => {
  const orphan = row({ pp: 6001, pi: 9001, pa: false, pn: null, cl: '"C:\\App\\DSH Desktop.exe" --type=utility' });
  const c1 = classifyCandidate(orphan, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set() });
  assert.equal(c1.action, 'report');
  assert.equal(c1.reason, 'orphan-desktop');

  const stale = row({ pp: 6002, cl: '"C:\\App\\DSH Desktop.exe" --type=renderer', st: new Date(ANCHOR - 60_000).toISOString() });
  const c2 = classifyCandidate(stale, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set() });
  assert.equal(c2.action, 'report');
  assert.equal(c2.reason, 'stale-windowless-electron-child');

  const unknown = row({ pp: 6003, st: null, cl: '"C:\\App\\DSH Desktop.exe" --type=renderer' });
  const c3 = classifyCandidate(unknown, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: 555, dshPids: new Set() });
  assert.equal(c3.action, 'report');
  assert.equal(c3.reason, 'unknown-start');
});

// ── planSweep 编排（覆盖整轮动作划分） ─────────────────────────────────

test('planSweep：真实事故快照 —— 当前代孤儿网关被回收，第三方 crashpad 与自身进程不碰', () => {
  const procs = [
    row({ pp: 555, nm: 'DSH Desktop.exe', cl: '"C:\\App\\DSH Desktop.exe"' }), // 自身主进程
    row({ pp: 556, nm: 'DSH Desktop.exe', cl: '"C:\\App\\DSH Desktop.exe" --type=gpu-process' }), // 当前代子进程
    row({ pp: 600, nm: 'DSH Desktop.exe', cl: GW_CL, pi: 555, pa: true, pn: 'DSH Desktop' }), // 当前代服役网关
    row({ pp: 4242, nm: 'DSH Desktop.exe', cl: GW_CL, pi: 999_999, pa: false, pn: null }), // 孤儿网关（事故本体）
    row({ pp: 4243, nm: 'DSH Desktop.exe', cl: GW_CL, pi: 555, pa: true, pn: 'DSH Desktop', st: new Date(ANCHOR - 7_200_000).toISOString() }), // 旧代 gateway
    row({ pp: 5001, nm: 'crashpad_handler.exe', cl: '"C:\\Program Files\\GameViewer\\crashpad_handler.exe" --type=crashpad-handler', ep: 'C:\\Program Files\\GameViewer\\crashpad_handler.exe', pi: 7001, pa: false, pn: null }), // 第三方
    row({ pp: 5002, nm: 'crashpad_handler.exe', cl: '"C:\\App\\DSH Desktop.exe" --type=crashpad-handler', pi: 8001, pa: false, pn: null }), // 自己的孤儿 crashpad
    row({ pp: 6001, nm: 'DSH Desktop.exe', cl: '"C:\\App\\DSH Desktop.exe" --type=utility', pi: 9001, pa: false, pn: null }), // 孤儿桌面进程
  ];
  const plan = planOf(procs);

  const killedPids = plan.kills.map((k) => k.pid).sort((a, b) => a - b);
  assert.deepEqual(killedPids, [4242, 4243, 5002], '只回收孤儿网关/旧代网关/自己的孤儿 crashpad');
  assert.equal(plan.kills.find((k) => k.pid === 4242).reason, 'orphan');
  assert.equal(plan.kills.find((k) => k.pid === 4243).reason, 'stale-generation');
  assert.equal(plan.kills.find((k) => k.pid === 5002).kind, 'crashpad');
  assert.ok(!killedPids.includes(5001), '第三方 crashpad 绝不能被杀');
  assert.ok(!killedPids.includes(556), '当前代子进程绝不能被杀');
  assert.ok(!killedPids.includes(600), '在服役的网关绝不能被杀');

  // 报告项：孤儿/旧代桌面进程，且不含已回收项
  assert.equal(plan.reports.length, 1);
  assert.equal(plan.reports[0].pid, 6001);
  assert.equal(plan.reports[0].why, 'orphan-desktop');

  // 存活网关计数：只有 600（556 是 utility，4242/4243 已被回收）→ 补拉时应跳过（去重）
  assert.equal(plan.liveGateways, 1);
});

test('planSweep：无存活网关时 liveGateways=0（补拉才有意义）', () => {
  const plan = planOf([row({ pp: 4242, cl: GW_CL, pi: 999_999, pa: false, pn: null })]);
  assert.equal(plan.kills.length, 1);
  assert.equal(plan.liveGateways, 0, '孤儿网关被回收后不应把它算成活网关');
});

test('planSweep：字段缺失（旧格式查询）时不误杀', () => {
  const legacyRows = [
    { pp: 7001, nm: 'DSH Desktop.exe', st: new Date(ANCHOR + 1_000).toISOString(), cl: GW_CL },
    { pp: 7002, nm: 'crashpad_handler.exe', st: new Date(ANCHOR + 1_000).toISOString(), cl: 'crashpad_handler.exe --type=crashpad-handler' },
  ];
  const plan = planOf(legacyRows);
  assert.equal(plan.kills.length, 0, '没有父进程信息 ⇒ 不得判孤儿、不得杀');
  assert.equal(plan.reports.length, 0);
  assert.equal(plan.liveGateways, 1, '旧格式下网关按存活计（保守）');
});

test('planSweep：空输入 / 非数组输入安全', () => {
  assert.deepEqual(planOf([]).kills, []);
  assert.deepEqual(planSweep(undefined, { anchorMs: ANCHOR }).kills, []);
  assert.deepEqual(planSweep(null, { anchorMs: ANCHOR }).kills, []);
});

// ── 补拉去重依赖的端口探测 ─────────────────────────────────────────────

test('probeTcp：监听端口 ⇒ true，关闭端口 ⇒ false', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probeTcp('127.0.0.1', port, 800), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeTcp('127.0.0.1', port, 300), false, '关闭后同端口应探测失败');
  // 非法端口不得抛错，只能返回 false
  assert.equal(await probeTcp('127.0.0.1', 0, 200), false);
});

// ── 装配（mock ctx） ───────────────────────────────────────────────────

function makeCtx() {
  const routes = [];
  const intervals = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    reflect: { get: (n) => (n === 'webServer' ? { register: (r) => routes.push(r) } : null) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  };
  return { ctx, routes, intervals };
}

test('apply 装配状态路由 + 周期任务，且绝不抛错（sweepOnStart:false 避免真跑查询）', () => {
  const { ctx, routes, intervals } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, { sweepOnStart: false }));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/instance-janitor/status');
  assert.equal(typeof routes[0].handler, 'function');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 60 * 60 * 1000);
});

test('apply 在 ctx 极简（无 reflect/logger）时仍不抛错', () => {
  assert.doesNotThrow(() => apply({ setInterval: () => {}, setTimeout: () => {} }, { sweepOnStart: false }));
});

test('apply 的 status 路由 GET 返回 lastSweep=null 契约', () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, { sweepOnStart: false, gatewayPort: 12345 });
  let code = 0;
  let body = '';
  routes[0].handler({ method: 'GET' }, {
    writeHead(c) { code = c; },
    end(payload) { body = payload; },
  });
  assert.equal(code, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plugin, name);
  assert.equal(parsed.lastSweep, null);
  assert.equal(parsed.gatewayPort, 12345);
  assert.ok(typeof parsed.logFile === 'string' && parsed.logFile.length > 0);
  // 抑制表也随 status 暴露（初始为空）
  assert.deepEqual(parsed.suppressed, []);
});

// ── 抑制表：杀不掉的目标不重复重试（2026-09-14 实测无限重试缺陷） ──────────────

test('candidateKey：有可执行路径 ⇒ 用路径（PID 复用也不会误抑制）', () => {
  const a = candidateKey({ pp: 17980, nm: 'crashpad_handler.exe', ep: 'D:\\UU远程\\GameViewer\\bin\\crashpad_handler.exe' });
  const b = candidateKey({ pp: 99999, nm: 'crashpad_handler.exe', ep: 'D:\\UU远程\\GameViewer\\bin\\crashpad_handler.exe' });
  assert.equal(a, b, '同一路径不同 PID 必须得到同一 key（路径优先）');
  assert.ok(a.startsWith('ep:'));
});

test('candidateKey：路径缺失 ⇒ 退回 进程名+PID，且大小写不敏感', () => {
  const a = candidateKey({ pp: 1234, nm: 'Crashpad_Handler.EXE', ep: null });
  const b = candidateKey({ pp: 1234, nm: 'crashpad_handler.exe', ep: '' });
  assert.equal(a, b);
  assert.ok(a.startsWith('np:'));
});

test('planSweep：抑制表命中的目标被跳过，且计入 suppressedSkipped', () => {
  const orphanCrash = row({ pp: 4242, pi: 3, pa: false, nm: 'crashpad_handler.exe', cl: '', ep: 'C:\\X\\crashpad_handler.exe' });
  const procs = [orphanCrash];
  // 未抑制 ⇒ 应产生 1 个 kill
  const p1 = planSweep(procs, { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: -1 });
  assert.equal(p1.kills.length, 1, '孤儿 crashpad 应被回收');
  assert.equal(p1.suppressedSkipped, 0);
  // 已抑制 ⇒ 不再产生 kill，改为计入 suppressedSkipped
  const p2 = planSweep(procs, {
    anchorMs: ANCHOR, toleranceMs: TOL, selfPid: -1,
    suppressed: new Set([candidateKey(orphanCrash)]),
  });
  assert.equal(p2.kills.length, 0, '抑制表命中后不得再次尝试');
  assert.equal(p2.suppressedSkipped, 1);
});

test('planSweep：抑制表只影响命中项，不误伤其它孤儿（核心安全性质）', () => {
  const victim = row({ pp: 5001, pi: 3, pa: false, nm: 'crashpad_handler.exe', cl: '', ep: 'C:\\A\\crashpad_handler.exe' });
  const other = row({ pp: 5002, pi: 3, pa: false, nm: 'crashpad_handler.exe', cl: '', ep: 'C:\\B\\crashpad_handler.exe' });
  const p = planSweep([victim, other], {
    anchorMs: ANCHOR, toleranceMs: TOL, selfPid: -1,
    suppressed: new Set([candidateKey(victim)]),
  });
  assert.equal(p.kills.length, 1);
  assert.equal(p.kills[0].pid, 5002, '未抑制的孤儿仍必须被回收');
  assert.equal(p.suppressedSkipped, 1);
});

test('planSweep：suppressed 传非 Set（undefined/数组）时退化为空表，不抛错', () => {
  const orphanCrash = row({ pp: 6001, pi: 3, pa: false, nm: 'crashpad_handler.exe', cl: '', ep: 'C:\\C\\crashpad_handler.exe' });
  for (const bad of [undefined, null, [], 'x', 42]) {
    assert.doesNotThrow(() => planSweep([orphanCrash], { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: -1, suppressed: bad }));
    const p = planSweep([orphanCrash], { anchorMs: ANCHOR, toleranceMs: TOL, selfPid: -1, suppressed: bad });
    assert.equal(p.kills.length, 1, '非 Set 必须退化为空表（fail-open 到正常回收）');
  }
});

