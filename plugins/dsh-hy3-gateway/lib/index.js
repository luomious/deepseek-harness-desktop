/**
 * @dsh-external/dsh-hy3-gateway
 * 在 DSH 启动时拉起本地 hy3 OpenAI 兼容网关（免费混元 hy3：云开发 SDK 通道 -> HTTP）。
 * 诊断日志写到 GATEWAY_DIR/plugin-spawn.log。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = '@dsh-external/dsh-hy3-gateway';

const GATEWAY_DIR = 'D:\\Deepseek-Harness\\hy3-gateway';
const KEY_FILE = join(GATEWAY_DIR, 'apikey.local.txt');
const LOG = join(GATEWAY_DIR, 'plugin-spawn.log');

function log(msg) {
  try { appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch { /* ignore */ }
}

export function apply(ctx) {
  log('apply called execPath=' + process.execPath);
  try {
    if (!existsSync(KEY_FILE)) { log('apikey.local.txt missing'); return; }
    const key = readFileSync(KEY_FILE, 'utf8').trim();
    if (!key) { log('apikey.local.txt empty'); return; }
    const child = spawn(process.execPath, [join(GATEWAY_DIR, 'server.js')], {
      cwd: GATEWAY_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLOUDBASE_APIKEY: key },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (e) => log('spawn error: ' + String(e)));
    child.on('exit', (code, sig) => log('child exited code=' + code + ' sig=' + sig));
    child.unref();
    log('spawned pid=' + child.pid);
  } catch (e) {
    log('apply error: ' + String(e));
  }
}
