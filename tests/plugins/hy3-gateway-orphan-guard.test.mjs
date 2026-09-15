/**
 * tests/plugins/hy3-gateway-orphan-guard.test.mjs
 *   —— hy3-gateway/orphan-guard.js 回归测试（2026-09-14 孤儿网关**源头**自愈）
 *
 * 背景（真实事故）：DSH 主进程被外部强杀（疑安全软件 HIPS 拦截）→ 插件注册的
 * `process.on('exit')` 钩子不会执行 → detached 的 hy3 网关永久占着 127.0.0.1:8787，
 * 用户看到「关了 DSH 后台还有进程」。结论：任何「由父进程负责回收子进程」的设计在这种
 * 场景下必然失效，**网关必须能自己判断该不该活着**——本文件锁住这个判据。
 *
 * 三条硬性质（宁可漏杀，不可误杀）：
 *   1. 未注入 parentPid 且未注入 heartbeatFile ⇒ **完全不启用**（手工 `node server.js` 行为不变）；
 *   2. 父进程消失 ⇒ 立即退场（'parent-gone'），与心跳状态无关；
 *   3. 心跳文件缺失/不可读 ⇒ 视为新鲜，**不得**据此退场（fail-safe）。
 *   另：启动后 guardGraceMs 内不判心跳；PID 存在但 EPERM ⇒ 视为存活。
 *
 * 运行：node --test tests/plugins/hy3-gateway-orphan-guard.test.mjs
 * （纯逻辑 + 注入时钟/探针 + 一个真实临时文件；不 spawn 子进程、不真退出进程）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// hy3-gateway 是 CommonJS（与 server.js 同目录、同模块系统）
const {
  isPidAlive,
  isHeartbeatFresh,
  orphanReason,
  installOrphanGuard,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STALE_MS,
  DEFAULT_GRACE_MS,
} = require('../../hy3-gateway/orphan-guard.js');

function throwCode(code) {
  return () => { const e = new Error(code); e.code = code; throw e; };
}

// ── 探针 ───────────────────────────────────────────────────────────────

test('isPidAlive：不存在 ⇒ false；EPERM ⇒ true（保守）；PID 不可解析 ⇒ true', () => {
  assert.equal(isPidAlive(1234, throwCode('ESRCH')), false);
  assert.equal(isPidAlive(1234, throwCode('ENOENT')), false);
  assert.equal(isPidAlive(1234, throwCode('EPERM')), true, '存在但无权限 ⇒ 视为存活');
  assert.equal(isPidAlive(1234, () => {}), true);
  let called = false;
  assert.equal(isPidAlive(undefined, () => { called = true; }), true, 'PID 缺失 ⇒ 视为存活');
  assert.equal(isPidAlive('abc', () => { called = true; }), true);
  assert.equal(called, false, 'PID 不可解析时不得去探进程');
});

test('isHeartbeatFresh：超期 ⇒ false；新鲜 ⇒ true；缺失/不可读 ⇒ true（fail-safe）', () => {
  const now = 1_000_000;
  assert.equal(isHeartbeatFresh('f', 45_000, now, () => ({ mtimeMs: now - 60_000 })), false);
  assert.equal(isHeartbeatFresh('f', 45_000, now, () => ({ mtimeMs: now - 1_000 })), true);
  assert.equal(isHeartbeatFresh('f', 45_000, now, throwCode('ENOENT')), true, '文件缺失不得判孤儿');
  assert.equal(isHeartbeatFresh('f', 45_000, now, () => ({ mtimeMs: NaN })), true, 'mtime 不可读不得判孤儿');
  assert.equal(isHeartbeatFresh('', 45_000, now, () => ({ mtimeMs: 0 })), true, '未注入路径 ⇒ 视为新鲜');
  // 未传 staleMs 时回落默认值
  assert.equal(isHeartbeatFresh('f', undefined, now, () => ({ mtimeMs: now - DEFAULT_STALE_MS - 1 })), false);
});

// ── 判定（纯函数） ─────────────────────────────────────────────────────

test('orphanReason：无任何信号 ⇒ null（完全不启用）', () => {
  assert.equal(orphanReason(), null);
  assert.equal(orphanReason(null), null);
  assert.equal(orphanReason({}), null);
  assert.equal(orphanReason({ parentPid: 'abc', heartbeatFile: '' }), null);
  assert.equal(orphanReason({ parentPid: 0 }), null, 'PID 0 不是有效父进程信号');
});

test('orphanReason：父进程消失 ⇒ parent-gone，且心跳新鲜也救不回', () => {
  const now = 10 * 60_000;
  assert.equal(orphanReason({ parentPid: 999, isAlive: () => false }), 'parent-gone');
  assert.equal(
    orphanReason({
      parentPid: 999,
      isAlive: () => false,
      heartbeatFile: 'f',
      startedAtMs: 0,
      nowMs: now,
      statImpl: () => ({ mtimeMs: now }),
    }),
    'parent-gone',
    '父没了就是没了，心跳再新鲜也必须退场',
  );
});

test('orphanReason：父存活 + 心跳新鲜 ⇒ null（在服役）', () => {
  const now = 10 * 60_000;
  assert.equal(orphanReason({ parentPid: 999, isAlive: () => true }), null, '无心跳信号 ⇒ 只要父在就不退场');
  assert.equal(
    orphanReason({
      parentPid: 999,
      isAlive: () => true,
      heartbeatFile: 'f',
      startedAtMs: 0,
      nowMs: now,
      statImpl: () => ({ mtimeMs: now - 1_000 }),
    }),
    null,
  );
});

test('orphanReason：宽限期内不判心跳（等主进程写第一拍）', () => {
  const now = 10_000;
  assert.equal(
    orphanReason({
      heartbeatFile: 'f',
      guardGraceMs: 90_000,
      startedAtMs: now - 5_000,
      nowMs: now,
      statImpl: () => ({ mtimeMs: 0 }), // 极旧，但仍在宽限期内
    }),
    null,
  );
});

test('orphanReason：超宽限 + 心跳超期 ⇒ heartbeat-stale（PID 复用防线）', () => {
  const now = 200_000;
  assert.equal(
    orphanReason({
      parentPid: 999,
      isAlive: () => true, // PID 存活，但极可能是被复用
      heartbeatFile: 'f',
      guardGraceMs: 90_000,
      heartbeatStaleMs: 45_000,
      startedAtMs: 0,
      nowMs: now,
      statImpl: () => ({ mtimeMs: now - 60_000 }),
    }),
    'heartbeat-stale',
  );
});

// ── 安装器 ─────────────────────────────────────────────────────────────

test('installOrphanGuard：两路信号都缺 ⇒ 返回 null（手工 node server.js 行为不变）', () => {
  assert.equal(installOrphanGuard(), null);
  assert.equal(installOrphanGuard({}), null);
  assert.equal(installOrphanGuard({ parentPid: '' }), null);
  assert.equal(installOrphanGuard({ parentPid: 0 }), null);
  assert.equal(installOrphanGuard({ parentPid: null, heartbeatFile: '' }), null);
});

test('installOrphanGuard：默认参数与句柄形状', () => {
  const g = installOrphanGuard({ parentPid: 1234, isAlive: () => true, intervalMs: 1_000_000 });
  assert.ok(g);
  try {
    assert.equal(g.intervalMs, 1_000_000);
    assert.equal(g.heartbeatStaleMs, DEFAULT_STALE_MS);
    assert.equal(g.guardGraceMs, DEFAULT_GRACE_MS);
    assert.equal(g.heartbeatStaleMs, 45_000);
    assert.equal(g.guardGraceMs, 90_000);
    assert.equal(DEFAULT_INTERVAL_MS, 15_000);
    assert.equal(typeof g.stop, 'function');
  } finally {
    g.stop();
  }
});

test('installOrphanGuard：父进程消失 ⇒ 自退场且只退一次（真实定时器）', async () => {
  const seen = [];
  const g = installOrphanGuard({
    parentPid: 4242,
    isAlive: () => false,
    intervalMs: 20,
    exit: (code) => seen.push(code),
    logger: () => {},
  });
  assert.ok(g);
  await new Promise((r) => setTimeout(r, 120));
  g.stop();
  assert.deepEqual(seen, [0], '必须且只退场一次（clearInterval 在 exit 之前）');
});

test('installOrphanGuard：父存活时不退场；stop() 后彻底静默', async () => {
  const seen = [];
  const g = installOrphanGuard({ parentPid: 4242, isAlive: () => true, intervalMs: 20, exit: (c) => seen.push(c) });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, [], '父存活期间不得退场');

  const g2 = installOrphanGuard({ parentPid: 4242, isAlive: () => false, intervalMs: 20, exit: (c) => seen.push(c) });
  g2.stop();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seen, [], 'stop() 必须已清掉定时器');
  g.stop();
});

test('installOrphanGuard：真实心跳文件 —— 超期触发退场，新鲜不退场', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-'));
  const file = path.join(dir, 'hy3-gateway.heartbeat');
  const now = Date.now();
  try {
    // (1) 超期心跳 + 「父存活」（模拟 PID 复用）⇒ 应退场
    fs.writeFileSync(file, 'old');
    const old = new Date(now - 10 * 60_000);
    fs.utimesSync(file, old, old);
    const seen = [];
    const g = installOrphanGuard({
      parentPid: 4242,
      isAlive: () => true,
      heartbeatFile: file,
      heartbeatStaleMs: 45_000,
      guardGraceMs: 1_000,
      startedAtMs: now - 60_000,
      intervalMs: 20,
      exit: (c) => seen.push(c),
      logger: () => {},
    });
    assert.ok(g);
    try {
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(seen, [0], '超期心跳必须触发一次退场');
    } finally {
      g.stop();
    }

    // (2) 刚写入的心跳 ⇒ 视为在服役，不得退场
    fs.writeFileSync(file, 'fresh');
    const seen2 = [];
    const g2 = installOrphanGuard({
      parentPid: 4242,
      isAlive: () => true,
      heartbeatFile: file,
      heartbeatStaleMs: 45_000,
      guardGraceMs: 1_000,
      startedAtMs: now - 60_000,
      intervalMs: 20,
      exit: (c) => seen2.push(c),
    });
    try {
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(seen2, [], '心跳新鲜时不得退场');
    } finally {
      g2.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
