// src/lib/build-lock.js
// DSH profile 构建/安装互斥锁：多个 agent（或多个终端）同时改 ~/.dsh/profiles/web
// （pnpm install / tsdown 重建 / junction 重建）时，node_modules 会出现瞬间缺失，
// 运行中的 dsh 服务把 /plugins/<id>/client.js 读成 404 → 前端 boot 失败。
// 本锁把「改 profile 的操作」串行化：先到先得，后来者排队等待（不是失败），
// 等前一个操作完成再执行——即「一个做完另一个再做」的语义，无需人工协调。
//
// 设计要点（健壮但不死板）：
// - wx 独占创建锁文件（同 dsh-atomic-write 的协议），读者无锁，只有写者竞争；
// - 孤儿锁回收：持锁 pid 已死（kill -9 / 崩溃）才回收，pid 活着就继续等——
//   文件年龄不能证明主人已停（与 dsh-atomic-write 同一哲学）；
// - 等待有截止期限（默认 5 分钟），超时抛带现场信息的错误，由调用方决定重试；
// - 释放时校验 pid，只删自己的锁，绝不误删新持锁者的锁。
// 独立模块：不依赖 electron，可单测，scripts/dsh-build-lock.js CLI 复用本模块。

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_FILE = path.join(os.homedir(), '.dsh', 'profiles', 'web', '.dsh-build.lock');
const RETRY_INITIAL_MS = 200;
const RETRY_MAX_MS = 2000;
const DEFAULT_WAIT_MS = 5 * 60 * 1000;

/** pid 是否还活着（EPERM 也算活着：进程存在只是没权限发信号） */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 读锁文件内容（损坏/缺失返回 null） */
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) { return null; }
}

/** 尝试一次获取锁：成功 true；被占 false；孤儿锁先回收再抢 */
function tryAcquire(label) {
  const existing = readLock();
  if (existing && !pidAlive(existing.pid)) {
    // 孤儿锁：持锁进程已不存在，回收（竞态下 unlink 失败无妨，下一轮 wx 会再判）
    try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
  }
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, label: String(label || ''), at: new Date().toISOString() }, null, 2), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * 持锁执行一个（可异步）操作。竞争时指数退避排队，超 waitMs 抛错。
 * @param {string} label 持锁者描述（写入锁文件，方便排队者知道在等谁）
 * @param {() => any} fn 持锁期间执行的操作
 * @param {{waitMs?: number}} opts waitMs 等待上限，默认 5 分钟
 */
async function withBuildLock(label, fn, opts = {}) {
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let delay = RETRY_INITIAL_MS;
  for (;;) {
    if (tryAcquire(label)) break;
    if (Date.now() >= deadline) {
      const holder = readLock();
      const err = new Error(
        `build-lock: 等待 ${Math.round(waitMs / 1000)}s 超时，另一个操作仍持锁：` +
        `"${(holder && holder.label) || 'unknown'}" (pid ${(holder && holder.pid) || '?'})。` +
        `锁文件：${LOCK_FILE}。可稍后重试；确认持锁进程已死可删除锁文件。`
      );
      err.code = 'EBUILDLOCK_TIMEOUT';
      throw err;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  }
  try {
    return await fn();
  } finally {
    try {
      const cur = readLock();
      if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch (e) { /* ignore */ }
  }
}

module.exports = { withBuildLock, tryAcquire, readLock, pidAlive, LOCK_FILE };
