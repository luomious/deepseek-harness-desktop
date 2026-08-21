// tests/build-lock.test.js — 构建锁竞争测试（node 直接运行，无 shell 引号问题）
const { withBuildLock, readLock, LOCK_FILE } = require('../src/lib/build-lock.js');
const fs = require('fs');

async function main() {
  // 清理残留
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}

  const order = [];

  // agent-A 持锁 2 秒
  const a = withBuildLock('agent-A', async () => {
    order.push('A-start');
    await new Promise(r => setTimeout(r, 2000));
    order.push('A-end');
    return 'A';
  });

  // 等 200ms 让 A 先拿到锁
  await new Promise(r => setTimeout(r, 200));

  // agent-B 应该排队等 A 完成
  const b = withBuildLock('agent-B', async () => {
    order.push('B-start');
    return 'B';
  });

  const [ra, rb] = await Promise.all([a, b]);
  console.log('results:', ra, rb);
  console.log('order:', order.join(' → '));

  // 验证：A 先完成后 B 才开始
  const aEnd = order.indexOf('A-end');
  const bStart = order.indexOf('B-start');
  if (aEnd < bStart) {
    console.log('PASS: B waited for A (serialized correctly)');
  } else {
    console.log('FAIL: B did not wait for A');
    process.exit(1);
  }

  // 验证：锁已释放
  if (readLock() === null) {
    console.log('PASS: lock released after both done');
  } else {
    console.log('FAIL: lock still held');
    process.exit(1);
  }

  console.log('ALL TESTS PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
