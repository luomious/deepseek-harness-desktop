/**
 * @dsh-external/dsh-hy3-gateway
 * 在 DSH 启动时拉起本地 hy3 OpenAI 兼容网关（免费混元 hy3：云开发 SDK 通道 -> HTTP）。
 * 诊断日志写到 GATEWAY_DIR/plugin-spawn.log。
 *
 * dsh patch exit-cleanup v1 (2026-09-04)：
 * 网关以 detached:true 拉起（进程名显示为 "DSH Desktop.exe"，
 * 实际是 electron-as-node 跑 hy3-gateway/server.js，监听 8787）。
 * 主进程退出时若无人回收，网关会变孤儿继续驻留 —— 即用户看到的
 * 「退出后任务管理器里还有一个 dsh」。本文件注册 process.on('exit') 钩子：
 *   - 应用【最终退出】：直接 TerminateProcess 网关，退出后零残留；
 *   - 应用【重启】：main.js 补丁（scripts/apply-exit-cleanup.mjs 的
 *     __dsh_relaunch_in_progress__ 标志，见 verify-patches.ps1）置位后跳过杀进程，
 *     由既有 takeover/janitor 机制无缝续活（不回归 2026-09-03 的设计）。
 * 崩溃/强杀（'exit' 事件不触发）场景由三层兜底：
 *   1) 网关自身 orphan-guard：本文件注入 HY3_PARENT_PID / HY3_HEARTBEAT_FILE，
 *      hy3-gateway/orphan-guard.js 据此判定「父进程消失」或「心跳超期」后自行退场
 *      —— 这是唯一不依赖「父进程能否优雅退出」的机制；
 *   2) dsh-instance-janitor 的孤儿回收：下次启动时兜底清理上一代的孤儿；
 *   3) hy3-gateway/server.js 的 takeover：新实例抢端口时请旧实例退场。
 * 排查/回滚指引见 docs/EXIT-PROCESS-CLEANUP.md。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const name = '@dsh-external/dsh-hy3-gateway';

// 2026-09-06 审计修复：原硬编码 'D:\\Deepseek-Harness\\hy3-gateway'，换机/换路径即失效；
// 改为从本文件位置向上推导（plugins/dsh-hy3-gateway/lib/ -> 工作区根 -> hy3-gateway/），
// 与 dsh-instance-janitor 的动态推导方式一致。
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATEWAY_DIR = join(WORKSPACE_ROOT, 'hy3-gateway');
const KEY_FILE = join(GATEWAY_DIR, 'apikey.local.txt');
const LOG = join(GATEWAY_DIR, 'plugin-spawn.log');

// DSH-2026-09-14 孤儿自愈（配合 hy3-gateway/orphan-guard.js）：
// 主进程被外部强杀时，下面的 process.on('exit') 钩子不会执行，网关于是永久驻留。
// 因此把「父进程 PID」与「心跳文件路径」注入网关，让它能自行判定该不该活着；
// 心跳由本进程周期性刷新，用于防 PID 复用导致的误判。
const GATEWAY_HEARTBEAT = join(homedir(), '.dsh', 'hy3-gateway.heartbeat');
const HEARTBEAT_INTERVAL_MS = 15_000;
let heartbeatTimer = null;

/** 开始周期性刷新心跳文件（幂等）。 */
function startHeartbeat() {
  if (heartbeatTimer) return;
  const beat = () => {
    try { writeFileSync(GATEWAY_HEARTBEAT, String(Date.now())); } catch { /* ignore */ }
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

/** 停止心跳并清除文件（仅最终退出时调用；重启续活场景保留心跳）。 */
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  try { rmSync(GATEWAY_HEARTBEAT, { force: true }); } catch { /* ignore */ }
}

/** 当前代网关子进程（模块级引用，供退出钩子使用）。 */
let activeChild = null;
let exitHookInstalled = false;

function log(msg) {
  try { appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch { /* ignore */ }
}

/** 注册一次退出钩子：最终退出时回收 detached 网关；重启时跳过（takeover 续活）。 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    const child = activeChild;
    if (child === null || child.pid === undefined) return;
    try {
      const relaunching = globalThis.__dsh_relaunch_in_progress__ === true;
      if (relaunching) {
        log('exit cleanup: skip kill (app relaunch; takeover keeps gateway alive)');
        return;
      }
      child.kill();
      stopHeartbeat();
      log('exit cleanup: killed gateway pid=' + child.pid);
    } catch (e) {
      try { log('exit cleanup error: ' + String(e)); } catch { /* ignore */ }
    }
  });
}

export function apply(ctx) {
  log('apply called execPath=' + process.execPath);
  try {
    if (!existsSync(KEY_FILE)) { log('apikey.local.txt missing'); return; }
    const key = readFileSync(KEY_FILE, 'utf8').trim();
    if (!key) { log('apikey.local.txt empty'); return; }
    installExitHook();
    startHeartbeat();
    const child = spawn(process.execPath, [join(GATEWAY_DIR, 'server.js')], {
      cwd: GATEWAY_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLOUDBASE_APIKEY: key,
        HY3_PARENT_PID: String(process.pid),
        HY3_HEARTBEAT_FILE: GATEWAY_HEARTBEAT,
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    activeChild = child;
    globalThis.__dsh_hy3_gateway_pid__ = child.pid;
    child.on('error', (e) => log('spawn error: ' + String(e)));
    child.on('exit', (code, sig) => {
      log('child exited code=' + code + ' sig=' + sig);
      if (activeChild === child) activeChild = null;
    });
    child.unref();
    log('spawned pid=' + child.pid);
  } catch (e) {
    log('apply error: ' + String(e));
  }
}
