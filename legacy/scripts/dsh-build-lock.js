#!/usr/bin/env node
// scripts/dsh-build-lock.js
// DSH profile 构建互斥锁 CLI：多个 agent 同时开发时，用它把「改 profile 的命令」
// 串行化（一个做完另一个再做），避免并发 pnpm install / build 把运行中的 dsh
// 前端打成 "bundle script ... failed to load"。
//
// 用法：
//   node scripts/dsh-build-lock.js --label "agent-A: pnpm add xxx" -- <command...>
//   node scripts/dsh-build-lock.js --label "agent-B: build" --wait 600000 -- pnpm run build
//   node scripts/dsh-build-lock.js --status          # 查看当前持锁者
//   node scripts/dsh-build-lock.js --clear           # 强制清锁（仅当持锁 pid 已死时安全）
//
// 行为：拿不到锁就排队等（指数退避），默认最多等 5 分钟；超时退出码 2。
// 被包裹命令的退出码原样透传。

const { spawnSync } = require('child_process');
const { withBuildLock, readLock, pidAlive, LOCK_FILE } = require('../src/lib/build-lock.js');

function usage() {
  console.log('Usage: node dsh-build-lock.js [--label <who>] [--wait <ms>] -- <command...>');
  console.log('       node dsh-build-lock.js --status | --clear');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { usage(); process.exit(1); }

  if (argv[0] === '--status') {
    const lock = readLock();
    if (!lock) { console.log('no lock held'); return; }
    console.log(`held by pid=${lock.pid} label="${lock.label}" since=${lock.at} alive=${pidAlive(lock.pid)}`);
    return;
  }
  if (argv[0] === '--clear') {
    const lock = readLock();
    if (!lock) { console.log('no lock held'); return; }
    if (pidAlive(lock.pid)) {
      console.error(`refusing to clear: pid ${lock.pid} is still alive (label="${lock.label}")`);
      process.exit(3);
    }
    try { require('fs').unlinkSync(LOCK_FILE); console.log('orphan lock cleared'); } catch (e) { console.error(e.message); process.exit(3); }
    return;
  }

  let label = `pid-${process.pid}`;
  let waitMs;
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--label' && argv[i + 1]) { label = argv[i + 1]; i += 2; continue; }
    if (argv[i] === '--wait' && argv[i + 1]) { waitMs = Number(argv[i + 1]); i += 2; continue; }
    if (argv[i] === '--') { i += 1; break; }
    console.error('unknown arg: ' + argv[i]); usage(); process.exit(1);
  }
  const cmd = argv.slice(i);
  if (cmd.length === 0) { usage(); process.exit(1); }

  try {
    const code = await withBuildLock(label, () => {
      console.error(`[build-lock] acquired: ${label}`);
      // Windows: 拼成单条命令行交给 shell（pnpm/npm 是 .cmd shim，需要 shell）；
      // 含空格的参数加双引号。POSIX: 直接 exec（无 shell，参数原样传递）。
      const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
      const r = process.platform === 'win32'
        ? spawnSync(cmd.map(quote).join(' '), { stdio: 'inherit', shell: true })
        : spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
      if (r.error) { console.error(r.error.message); return 1; }
      return r.status === null ? 1 : r.status;
    }, { waitMs });
    process.exit(code);
  } catch (e) {
    console.error('[build-lock] ' + e.message);
    process.exit(2);
  }
}

main();
