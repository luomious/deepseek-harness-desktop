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
 * 崩溃/强杀（'exit' 事件不触发）场景仍由 dsh-instance-janitor + takeover 兜底。
 * 排查/回滚指引见 docs/EXIT-PROCESS-CLEANUP.md。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = '@dsh-external/dsh-hy3-gateway';

const GATEWAY_DIR = 'D:\\Deepseek-Harness\\hy3-gateway';
const KEY_FILE = join(GATEWAY_DIR, 'apikey.local.txt');
const LOG = join(GATEWAY_DIR, 'plugin-spawn.log');

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
    const child = spawn(process.execPath, [join(GATEWAY_DIR, 'server.js')], {
      cwd: GATEWAY_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLOUDBASE_APIKEY: key },
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
