/**
 * @dsh-external/dsh-instance-janitor 后台旧实例清道夫（daemon-loop 形态，零依赖 host 模式）。
 *
 * 定位：应用重启后，上一代的 detached 子进程（hy3 网关、crashpad-handler）会留在后台
 * 长期占用端口/资源且用户不可见。本插件在 apply 时扫一轮 + 每小时扫一轮：
 *
 *   1. 识别：一次 PowerShell Win32_Process 查询（DSH Desktop.exe 全部 + cmdline 含
 *      hy3-gateway\server.js 的全部进程），附带主进程启动时间作为「当前代」分界。
 *   2. 白名单清理（仅两类，且必须早于当前主进程启动）：
 *        - cmdline 含 --type=crashpad-handler          -> 旧代崩溃上报僵尸，直接杀
 *        - cmdline 含 hy3-gateway\server.js            -> 旧代网关，杀掉后自动补拉一个
 *                                                         新网关（复用 hy3-gateway 插件
 *                                                         同款 spawn：electron-as-node）
 *   3. 其余旧代 DSH Desktop 进程：只记录 + 桌面通知，绝不自动杀（保守）。
 *   4. 护栏：绝不碰当前进程树（启动晚于主进程）、绝不碰本进程、绝不碰有 PID<=4 的系统进程。
 *
 * 设计规则（对齐 dsh-self-maintenance / dsh-stuck-loop-guard）：
 *   - 零 npm 运行时依赖；外部调用仅 powershell 查询 + taskkill 杀进程（均 windowsHide）。
 *   - fail-safe：每步 try/catch，自身出错绝不拖垮 harness。
 *   - 日志只写动作（kill/respawn/error），>logMaxBytes 截断；通知 24h 去重。
 *   - 状态快照经 /instance-janitor/status 暴露（GET 查看 / POST 手动触发一轮）。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, statSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const name = '@dsh-external/dsh-instance-janitor';
export const inject = ['timer'];

// 与 dsh-hy3-gateway 插件保持一致的网关位置（本插件三上一层即工作区根）。
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATEWAY_DIR = join(WORKSPACE_ROOT, 'hy3-gateway');
const GATEWAY_SERVER = join(GATEWAY_DIR, 'server.js');
const KEY_FILE = join(GATEWAY_DIR, 'apikey.local.txt');

const DEFAULT_CONFIG = {
  intervalMs: 60 * 60 * 1000, // 每小时一轮
  sweepOnStart: true,
  logMaxBytes: 256 * 1024,
  dedupMs: 24 * 60 * 60 * 1000,
  statusRoute: '/instance-janitor/status',
  generationToleranceMs: 2000, // 主进程启动时间前后容差
};

export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (!(config.intervalMs >= 60_000)) throw new Error('dsh-instance-janitor: intervalMs must be >= 60000');
  return config;
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const SHORT = 'dsh-instance-janitor';
  const logFile = join(homedir(), '.dsh', 'instance-janitor.log');
  const lastAlert = new Map();
  let lastSweep = null; // { ts, anchorMs, killed, reported, respawned }
  const applyTimeMs = Date.now();

  const log = (msg) => {
    try {
      let size = 0;
      try { size = statSync(logFile).size; } catch { /* 不存在则直接写 */ }
      if (size > config.logMaxBytes) { try { truncateSync(logFile, 0); } catch { /* ignore */ } }
      appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
    } catch { /* ignore */ }
  };
  const warn = (msg) => { try { ctx.logger?.warn?.(`[${SHORT}] ${msg}`); } catch { /* ignore */ } };
  const info = (msg) => { try { ctx.logger?.info?.(`[${SHORT}] ${msg}`); } catch { /* ignore */ } };

  const notify = (title, body) => {
    try {
      const { Notification } = require('electron');
      if (Notification?.isSupported?.()) {
        const n = new Notification({ title, body, urgency: 'normal' });
        n.on('error', () => {});
        n.show();
        return true;
      }
    } catch { /* 非 Electron 环境 */ }
    warn(`${title}: ${body}`);
    return false;
  };
  const canAlert = (key) => {
    const last = lastAlert.get(key) ?? 0;
    if (Date.now() - last < config.dedupMs) return false;
    lastAlert.set(key, Date.now());
    return true;
  };

  /** 一轮 PowerShell 查询：主进程启动时间 + 候选进程清单（DSH Desktop.exe + hy3 网关）。 */
  function sweepQuery() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') { resolve(null); return; }
      const script = [
        "$ErrorActionPreference='SilentlyContinue';",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
        `$self = ${process.pid};`,
        '$main = Get-CimInstance Win32_Process -Filter "ProcessId=$self" | ForEach-Object { if ($_.CreationDate) { $_.CreationDate.ToString(\'o\') } };',
        "$list = @();",
        "$list += Get-CimInstance Win32_Process -Filter \"Name='DSH Desktop.exe'\";",
        "$list += Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%hy3-gateway%server.js%'\";",
        '$procs = $list | Sort-Object ProcessId -Unique | ForEach-Object { [pscustomobject]@{ pp = $_.ProcessId; nm = $_.Name; st = if ($_.CreationDate) { $_.CreationDate.ToString(\'o\') } else { $null }; cl = $_.CommandLine } };',
        '[pscustomobject]@{ main = $main; procs = $procs } | ConvertTo-Json -Compress -Depth 3',
      ].join('\n');
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            main: parsed?.main ?? null,
            procs: Array.isArray(parsed?.procs) ? parsed.procs : (parsed?.procs ? [parsed.procs] : []),
          });
        } catch { resolve(null); }
      });
      child.on('error', () => resolve(null));
    });
  }

  function killPid(pid) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, timeout: 10_000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /** 杀掉旧代网关后补拉一个（复用 dsh-hy3-gateway 同款 spawn：electron-as-node + key 环境变量）。 */
  function respawnGateway() {
    try {
      if (!existsSync(KEY_FILE)) { log('respawn: apikey.local.txt missing; skip'); return false; }
      const key = readFileSync(KEY_FILE, 'utf8').trim();
      if (!key) { log('respawn: apikey.local.txt empty; skip'); return false; }
      const child = spawn(process.execPath, [GATEWAY_SERVER], {
        cwd: GATEWAY_DIR,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLOUDBASE_APIKEY: key },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (e) => log('respawn spawn error: ' + String(e)));
      child.on('exit', (code, sig) => log('respawn child exited code=' + code + ' sig=' + sig));
      child.unref();
      log('respawn: spawned gateway pid=' + child.pid);
      return true;
    } catch (e) {
      log('respawn error: ' + String(e));
      return false;
    }
  }

  async function sweep() {
    const ts = Date.now();
    const snapshot = { ts, anchorMs: null, killed: { crashpad: [], gateway: [] }, reported: [], respawned: false, error: null };
    try {
      const q = await sweepQuery();
      if (q === null) {
        snapshot.error = 'sweep query failed (non-Windows or PowerShell unavailable)';
        lastSweep = snapshot;
        warn(snapshot.error);
        return;
      }
      const anchorMs = q.main ? Date.parse(q.main) : NaN;
      const resolvedAnchor = Number.isFinite(anchorMs) ? anchorMs : applyTimeMs;
      snapshot.anchorMs = resolvedAnchor;

      for (const p of q.procs) {
        const pid = Number(p?.pp);
        if (!pid || pid <= 4 || pid === process.pid) continue;
        const startedMs = p?.st ? Date.parse(p.st) : NaN;
        if (!Number.isFinite(startedMs)) { snapshot.reported.push({ pid, why: 'unknown-start' }); continue; }
        if (startedMs >= resolvedAnchor - config.generationToleranceMs) continue; // 当前代，不碰
        const cl = String(p?.cl ?? '');
        const nm = String(p?.nm ?? '');
        if (cl.includes('--type=crashpad-handler')) {
          const ok = await killPid(pid);
          snapshot.killed.crashpad.push({ pid, ok });
          log(`kill crashpad-handler pid=${pid} ok=${ok} (started ${p.st})`);
        } else if (/hy3-gateway[\\/]server\.js/i.test(cl)) {
          const ok = await killPid(pid);
          snapshot.killed.gateway.push({ pid, ok });
          log(`kill stale gateway pid=${pid} ok=${ok} (started ${p.st})`);
        } else if (/dsh desktop/i.test(nm)) {
          snapshot.reported.push({ pid, why: 'stale-windowless-electron-child', started: p.st });
        }
        // 其余（非 DSH 桌面、非网关）不记录——查询面本已收窄
      }

      if (snapshot.killed.gateway.length > 0) {
        snapshot.respawned = respawnGateway();
      }
      lastSweep = snapshot;

      const killedTotal = snapshot.killed.crashpad.length + snapshot.killed.gateway.length;
      if (killedTotal > 0 || snapshot.reported.length > 0) {
        const key = 'sweep:' + (killedTotal > 0 ? 'killed' : 'reported');
        if (canAlert(key)) {
          const body = [
            killedTotal > 0 ? `清理后台旧实例 ${killedTotal} 个（crashpad=${snapshot.killed.crashpad.length}, gateway=${snapshot.killed.gateway.length}${snapshot.respawned ? ', 已补拉新网关' : ''}）` : null,
            snapshot.reported.length > 0 ? `另有 ${snapshot.reported.length} 个旧进程待观察（仅记录未杀）` : null,
          ].filter(Boolean).join('；');
          notify('DSH 实例清道夫', body);
        }
      }
      info(`sweep ok: killed=${killedTotal} reported=${snapshot.reported.length} anchorMs=${resolvedAnchor} ts=${ts}`);
    } catch (e) {
      snapshot.error = String((e && e.message) || e);
      lastSweep = snapshot;
      warn('sweep error: ' + snapshot.error);
    }
  }

  // ── 状态路由（容忍 webServer 启动竞态：惰性解析 + 指数退避重试；GET 查看 / POST 手动触发） ──
  let routeRegistered = false;
  let routeAttempts = 0;
  const registerRoute = () => {
    if (routeRegistered) return true;
    let webServer = null;
    try { webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null; } catch { webServer = null; }
    if (!webServer?.register) return false;
    try {
      webServer.register({
        kind: 'prefix',
        path: config.statusRoute,
        handler: (req, res) => {
          const send = (code, obj) => {
            try {
              const payload = JSON.stringify({ plugin: name, ok: code < 400, ...obj });
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(payload);
            } catch { /* ignore */ }
          };
          try {
            if (req.method === 'POST') {
              void sweep().then(() => send(200, { lastSweep }));
              return;
            }
            send(200, { lastSweep: lastSweep ?? null, intervalMs: config.intervalMs, logFile });
          } catch { try { send(500, {}); } catch { /* ignore */ } }
        },
      });
      routeRegistered = true;
      info(`status route registered at ${config.statusRoute}`);
      return true;
    } catch (e) {
      warn('status route register failed: ' + String(e));
      return false;
    }
  };
  if (!registerRoute()) {
    const retry = () => {
      if (routeRegistered) return;
      if (registerRoute()) return;
      routeAttempts += 1;
      if (routeAttempts >= 20) { warn('status route unavailable after retries; retry stopped'); return; }
      const delay = Math.min(2000 * 2 ** Math.min(routeAttempts, 4), 30000);
      try { ctx.setTimeout(retry, delay); } catch { /* tolerate */ }
    };
    try { ctx.setTimeout(retry, 2000); } catch { /* tolerate */ }
  }

  // 启动立即扫一轮，再按 intervalMs 周期性清理
  if (config.sweepOnStart) void sweep();
  ctx.setInterval(() => void sweep(), config.intervalMs);
  info(`${name} 启动（每 ${config.intervalMs}ms 一轮；日志 ${logFile}）`);
}
