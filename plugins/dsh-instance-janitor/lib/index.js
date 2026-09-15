/**
 * @dsh-external/dsh-instance-janitor 后台旧实例清道夫（daemon-loop 形态，零依赖 host 模式）。
 *
 * 定位：应用重启后、或主进程被外部强杀后，上一代的 detached 子进程（hy3 网关、
 * crashpad-handler）会留在后台长期占用端口/资源且用户不可见。本插件在 apply 时扫一轮
 * + 每小时扫一轮。
 *
 * 清理判据（三层，2026-09-14 重构）：
 *   0. 归属闸门 ownedByDsh()：crashpad_handler.exe 是**通用**子进程名（任何 Chromium 系
 *      应用都有），只凭进程名杀会误伤第三方——2026-09-14 实测误杀 GameViewer 的
 *      crashpad_handler（父进程为 GameViewerService/Healthd/Server，与 DSH 无关）。
 *      非 DSH 归属一律不碰。
 *   1. **孤儿优先（本轮核心修复）**：父进程已不存在（pa === false）⇒ 无论启动时间，立即回收。
 *      旧判据「启动时间必须早于当前主进程」只会清上一代，**永远漏掉当前代孤儿**——
 *      而「当前代网关在主进程被强杀后失父」正是 2026-09-14 事故场景（8787 被长期占用、
 *      主进程退出钩子没跑到、detached 网关永久驻留）。
 *   2. 旧代兜底：父进程仍存活、但启动早于当前主进程（含 generationToleranceMs 容差）⇒ 按旧代回收。
 *   3. 其余 DSH Desktop.exe 进程：只记录 + 通知，绝不自动杀（保守）。
 *
 * 杀不掉的目标要记（2026-09-14 增补）：某些 crashpad_handler 属主在当前用户权限之外，
 * taskkill 必然失败。旧逻辑「每轮重扫 + 重杀」会对同一批 PID 无限重试（实测 8h/40+ 次）。
 * 现在按可执行路径记入抑制表（candidateKey），失败一次后不再重试。
 *
 * 网关补拉（respawnGateway）：
 *   - **先去重**：探测 127.0.0.1:<gatewayPort>，已有健康网关则跳过——dsh-hy3-gateway 插件
 *     装配时本来就会拉一个，janitor 再拉即**重复装配**（两个网关抢 8787）。
 *   - **注入 HY3_PARENT_PID**：让网关自带的 orphan-guard 在 DSH 退出后自退场（第三层兜底闭环）。
 *   - **不注入 HY3_HEARTBEAT_FILE**：心跳文件由 dsh-hy3-gateway 插件独占写入；若由 janitor
 *     代管，插件缺位时残留的旧心跳会让新网关在宽限期后被误判为孤儿而自杀。
 *
 * 设计规则（对齐 dsh-self-maintenance / dsh-stuck-loop-guard）：
 *   - 零 npm 运行时依赖；外部调用仅 powershell 查询 + taskkill 杀进程 + TCP 端口探测（均 windowsHide）。
 *   - fail-safe：每步 try/catch，自身出错绝不拖垮 harness；查询字段缺失时按「不是孤儿」处理。
 *   - 日志只写动作（kill/respawn/error），>logMaxBytes 截断；通知 24h 去重。
 *   - 状态快照经 /instance-janitor/status 暴露（GET 查看 / POST 手动触发一轮）。
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, statSync, truncateSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
// Relative path on purpose (not a bare specifier): see scripts/verify-plugin-imports.mjs (F14).
import { createDedupNotifier, registerRouteWithRetry } from '../../dsh-host-services/lib/shared-utils.js';

// ESM 作用域无全局 require；createRequire 提供 Electron 主进程内置模块解析能力
// （2026-09-06 审计修复：原 require('electron') 在 ESM 下 ReferenceError 被吞，通知降级为 warn）。
const nodeRequire = createRequire(import.meta.url);

export const name = '@dsh-external/dsh-instance-janitor';
export const inject = ['timer'];

// 与 dsh-hy3-gateway 插件保持一致的网关位置（本插件三上一层即工作区根）。
const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATEWAY_DIR = join(WORKSPACE_ROOT, 'hy3-gateway');
const GATEWAY_SERVER = join(GATEWAY_DIR, 'server.js');
const KEY_FILE = join(GATEWAY_DIR, 'apikey.local.txt');

// 与 hy3-gateway/server.js 的 PORT 解析保持一致（`process.env.HY3_PROXY_PORT || '8787'`）。
const DEFAULT_GATEWAY_PORT = Number(process.env.HY3_PROXY_PORT) || 8787;

const DEFAULT_CONFIG = {
  intervalMs: 60 * 60 * 1000, // 每小时一轮
  sweepOnStart: true,
  logMaxBytes: 256 * 1024,
  dedupMs: 24 * 60 * 60 * 1000,
  statusRoute: '/instance-janitor/status',
  generationToleranceMs: 2000, // 主进程启动时间前后容差
  gatewayPort: DEFAULT_GATEWAY_PORT, // 补拉去重用的探测端口
  gatewayProbeMs: 800, // 端口探测超时
};

export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (!(config.intervalMs >= 60_000)) throw new Error('dsh-instance-janitor: intervalMs must be >= 60000');
  return config;
}

// ── 判据（纯函数，可脱离运行态单测） ────────────────────────────────────

/**
 * 归属判定：该进程是否属于 DSH（含本工作区的 hy3 网关）。
 *
 * 这是 crashpad 清理的**必要闸门**：crashpad_handler.exe 通用于所有 Chromium 系应用，
 * 只看进程名会把第三方（GameViewer / 浏览器 / 其他 Electron 应用）的崩溃上报进程杀掉。
 * 判据优先级：网关命令行 → 父进程在 DSH 进程集内 → 父进程名为 DSH Desktop → 可执行路径。
 *
 * @param {object} p 查询行：{ pp, pi, pa, pn, nm, st, cl, ep }
 * @param {Set<number>} dshPids 本轮查到的全部 DSH Desktop.exe PID（含自身）
 * @returns {boolean}
 */
export function ownedByDsh(p, dshPids = new Set()) {
  const cl = String(p?.cl ?? '');
  const ep = String(p?.ep ?? '');
  const pn = String(p?.pn ?? '');
  const parentPid = Number(p?.pi ?? 0);
  if (/hy3-gateway[\\/]server\.js/i.test(cl)) return true;
  if (parentPid > 0 && dshPids.has(parentPid)) return true;
  if (/dsh desktop/i.test(pn)) return true;
  if (/DSH Desktop/i.test(cl)) return true;
  if (/dsh/i.test(ep) && /desktop/i.test(ep)) return true;
  return false;
}

/**
 * 孤儿判定：父进程已不存在 ⇒ 该进程已无「主人」。
 *
 * 兼容三种查询形态：
 *   - pa === false：父进程查不到（最可靠的孤儿证据）；
 *   - pa === true，但父进程名不是 DSH 且父 PID 不在 DSH 进程集内：**PID 复用**，
 *     真正的父进程其实已死（Windows 不回收 detached 子进程的 ParentProcessId）；
 *   - pa 缺失（旧格式查询 / 非 Windows）：一律**不判孤儿**（fail-safe，宁漏不误杀）。
 *
 * @param {object} p 查询行
 * @param {object} opts { dshPids }
 * @returns {boolean}
 */
export function isOrphan(p, opts = {}) {
  const pa = p?.pa;
  if (pa === false) return true;
  if (pa !== true) return false;
  const pn = String(p?.pn ?? '');
  if (!pn) return false; // 父名不可得 ⇒ 无法排除 PID 复用，保守不判
  const parentPid = Number(p?.pi ?? 0);
  const dshPids = opts.dshPids instanceof Set ? opts.dshPids : new Set();
  if (/dsh desktop/i.test(pn)) return false;
  if (parentPid > 0 && dshPids.has(parentPid)) return false;
  return true;
}

/**
 * 候选分类（纯函数）。返回 { action, kind?, reason }：
 *   - action 'kill'  ：确认是 DSH 的旧代/孤儿 crashpad 或网关，直接回收
 *   - action 'report'：仅记录 + 通知，绝不自动杀
 *   - action 'ignore'：不在处理范围（含非 DSH 归属的 crashpad）
 *
 * @param {object} p 查询行
 * @param {object} opts { anchorMs, toleranceMs, dshPids, selfPid }
 * @returns {{action:'kill'|'report'|'ignore', kind?:'crashpad'|'gateway', reason:string}}
 */
export function classifyCandidate(p, opts = {}) {
  const pid = Number(p?.pp);
  if (!pid || pid <= 4) return { action: 'ignore', reason: 'system-or-invalid-pid' };
  if (pid === Number(opts.selfPid ?? NaN)) return { action: 'ignore', reason: 'self' };

  const cl = String(p?.cl ?? '');
  const nm = String(p?.nm ?? '');
  const isCrashpad = /--type=crashpad-handler/i.test(cl) || /crashpad/i.test(nm);
  const isGateway = /hy3-gateway[\\/]server\.js/i.test(cl);
  const isDesktop = /dsh desktop/i.test(nm);
  if (!isCrashpad && !isGateway && !isDesktop) return { action: 'ignore', reason: 'not-a-target' };

  const dshPids = opts.dshPids instanceof Set ? opts.dshPids : new Set();
  // 归属闸门：仅对通用名进程（crashpad）强制；网关靠命令行自证，DSH Desktop 靠进程名自证。
  if (isCrashpad && !ownedByDsh(p, dshPids)) return { action: 'ignore', reason: 'crashpad-not-owned' };

  const startedMs = p?.st ? Date.parse(String(p.st)) : NaN;
  const startedKnown = Number.isFinite(startedMs);
  const tolerance = Number.isFinite(opts.toleranceMs) ? Number(opts.toleranceMs) : 2000;
  const anchorMs = Number.isFinite(opts.anchorMs) ? Number(opts.anchorMs) : NaN;
  const stale = startedKnown && Number.isFinite(anchorMs) && startedMs < anchorMs - tolerance;
  const orphan = isOrphan(p, { dshPids });

  // 1) 孤儿优先：与启动时间无关（当前代孤儿也必须能被回收）
  if (isCrashpad) {
    if (orphan) return { action: 'kill', kind: 'crashpad', reason: 'orphan' };
    if (!startedKnown) return { action: 'report', reason: 'unknown-start' };
    if (stale) return { action: 'kill', kind: 'crashpad', reason: 'stale-generation' };
    return { action: 'ignore', reason: 'current-generation' };
  }
  if (isGateway) {
    if (orphan) return { action: 'kill', kind: 'gateway', reason: 'orphan' };
    if (!startedKnown) return { action: 'report', reason: 'unknown-start' };
    if (stale) return { action: 'kill', kind: 'gateway', reason: 'stale-generation' };
    return { action: 'ignore', reason: 'current-generation' };
  }
  // 2) 其余 DSH Desktop.exe：只报告，绝不自动杀（保守）
  if (orphan) return { action: 'report', reason: 'orphan-desktop' };
  if (!startedKnown) return { action: 'report', reason: 'unknown-start' };
  if (stale) return { action: 'report', reason: 'stale-windowless-electron-child' };
  return { action: 'ignore', reason: 'current-generation' };
}

/**
 * 计划编译：把一轮查询结果编译成动作计划（纯函数，无副作用、无 IO）——sweep() 的唯一判据入口。
 * 抽出来的目的：让「该杀谁 / 该报谁 / 当前代存活网关有几个」可以被单测直接驱动，
 * 不必真跑 PowerShell 或真杀进程（2026-09-14：孤儿回收缺陷正是判据层面的 bug）。
 *
 * @param {Array<object>} procs 查询行数组
 * @param {object} opts { anchorMs, toleranceMs, selfPid, suppressed }
 * @returns {{kills: Array<{pid:number,kind:string,reason:string,started:(string|null)}>,
 *            reports: Array<{pid:number,why:string,started:(string|null)}>,
 *            liveGateways: number, dshPids: number[], suppressedSkipped: number}}
 */
export function planSweep(procs, opts = {}) {
  const list = Array.isArray(procs) ? procs : [];
  const selfPid = Number(opts.selfPid ?? -1);
  const suppressed = opts.suppressed instanceof Set ? opts.suppressed : new Set();
  const dshPids = new Set(
    list
      .filter((p) => /dsh desktop/i.test(String(p?.nm ?? '')))
      .map((p) => Number(p?.pp))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  if (Number.isFinite(selfPid) && selfPid > 0) dshPids.add(selfPid);

  const kills = [];
  const reports = [];
  let liveGateways = 0;
  let suppressedSkipped = 0;
  for (const p of list) {
    const pid = Number(p?.pp);
    if (!pid || pid <= 4 || pid === selfPid) continue;
    const cls = classifyCandidate(p, { ...opts, dshPids, selfPid });
    if (cls.action === 'kill') {
      // 抑制表命中 ⇒ 不再重复尝试（该目标已被判定为「当前权限杀不掉」，见 markUnkillable 注释）。
      if (suppressed.has(candidateKey(p))) {
        suppressedSkipped += 1;
        continue;
      }
      kills.push({ pid, kind: cls.kind, reason: cls.reason, started: p?.st ?? null });
    } else if (cls.action === 'report') {
      reports.push({ pid, why: cls.reason, started: p?.st ?? null });
    } else if (/hy3-gateway[\\/]server\.js/i.test(String(p?.cl ?? ''))) {
      // 未被回收的网关 = 当前代存活网关（补拉去重时参考）
      liveGateways += 1;
    }
  }
  return { kills, reports, liveGateways, dshPids: [...dshPids], suppressedSkipped };
}

/**
 * 抑制表键：优先用可执行路径（PID 会复用、路径不会），路径缺失时退回进程名+PID。
 * 关键：**不能用「进程名+PID」单独作键**——PID 复用会让新进程被旧结论误抑制；
 * 而「可执行路径」在 PID 变化后依然能正确沿用抑制结论。
 *
 * @param {object} p 查询行
 * @returns {string}
 */
export function candidateKey(p) {
  const ep = String(p?.ep ?? '').trim();
  if (ep) return 'ep:' + ep.toLowerCase();
  const nm = String(p?.nm ?? '').trim();
  const pid = Number(p?.pp ?? 0);
  return 'np:' + nm.toLowerCase() + '#' + pid;
}

/**
 * TCP 连通性探测（补拉去重用；零依赖，不 spawn 任何外部进程）。
 * @returns {Promise<boolean>} 端口可连接 ⇒ true
 */
export function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    try {
      socket = connect({ host, port: Number(port) });
    } catch {
      resolve(false);
      return;
    }
    socket.setTimeout(Math.max(100, Number(timeoutMs) || 800));
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const SHORT = 'dsh-instance-janitor';
  const logFile = join(homedir(), '.dsh', 'instance-janitor.log');
  let lastSweep = null; // { ts, anchorMs, killed, reported, respawned, liveGateways, suppressedSkipped }
  const applyTimeMs = Date.now();
  /**
   * 「已知杀不掉」目标抑制表（内存态，跨进程重启清零；键 = 可执行路径优先，见 candidateKey）。
   *
   * 背景（2026-09-14 实测）：有 3 个 crashpad_handler.exe 进程属于**当前用户权限之外**的
   * 宿主（taskkill 返回失败），旧逻辑每小时重扫又重杀，8 小时内对同一批 PID 累计 40+ 次
   * 无效 taskkill（日志噪音 + 无谓的进程创建开销）。判据本身没错（它们确实是孤儿），
   * 错在**失败后不记忆**。此处只抑制「已确认杀不掉」的目标，不影响新出现的正常孤儿回收。
   */
  const unkillable = new Set();

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
      const { Notification } = nodeRequire('electron');
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
  // 24h 去重通知器（2026-09-06 收敛到 host-services shared-utils，行为不变）
  const { canAlert } = createDedupNotifier(config.dedupMs);

  /**
   * 一轮 PowerShell 查询：主进程启动时间 + 候选进程清单（DSH Desktop.exe + hy3 网关 + crashpad）。
   * 2026-09-14 增补字段：pi=父 PID、pa=父进程是否存活、pn=父进程名、ep=可执行路径 —— 供孤儿判定
   * 与归属闸门使用（父进程存活与否是「当前代孤儿」唯一可靠的判别依据）。
   */
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
        // 2026-09-07 修复：crashpad 进程名为 crashpad_handler.exe，既不匹配上面的
        // Name='DSH Desktop.exe'，也不含 hy3 命令行，导致下方 crashpad 分支永远进不去
        // （死代码，孤儿 crashpad 永不清理）。补查该进程名。
        "$list += Get-CimInstance Win32_Process -Filter \"Name='crashpad_handler.exe'\";",
        // 2026-09-14：补父进程存活/名称/可执行路径，供孤儿判定与归属闸门使用。
        // （PS 5.1：整个 PS 片段内不得出现嵌套双引号。）
        '$procs = $list | Sort-Object ProcessId -Unique | ForEach-Object { $ppid = [int]$_.ParentProcessId; $par = if ($ppid -gt 0) { Get-Process -Id $ppid -ErrorAction SilentlyContinue } else { $null }; [pscustomobject]@{ pp = $_.ProcessId; pi = $ppid; pa = [bool]$par; pn = if ($par) { $par.ProcessName } else { $null }; nm = $_.Name; st = if ($_.CreationDate) { $_.CreationDate.ToString(\'o\') } else { $null }; cl = $_.CommandLine; ep = $_.ExecutablePath } };',
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

  /**
   * 杀掉旧代/孤儿网关后按需补拉一个（复用 dsh-hy3-gateway 同款 spawn：electron-as-node + key 环境变量）。
   * 去重：先探测 gatewayPort，已有健康网关就跳过（避免与 dsh-hy3-gateway 插件重复装配）。
   * @returns {Promise<{spawned:boolean, note:string}>}
   */
  async function respawnGateway() {
    try {
      if (await probeTcp('127.0.0.1', config.gatewayPort, config.gatewayProbeMs)) {
        const note = `gateway already alive on 127.0.0.1:${config.gatewayPort}; respawn skipped`;
        log('respawn: ' + note);
        return { spawned: false, note };
      }
      if (!existsSync(KEY_FILE)) {
        log('respawn: apikey.local.txt missing; skip');
        return { spawned: false, note: 'apikey-missing' };
      }
      const key = readFileSync(KEY_FILE, 'utf8').trim();
      if (!key) {
        log('respawn: apikey.local.txt empty; skip');
        return { spawned: false, note: 'apikey-empty' };
      }
      const child = spawn(process.execPath, [GATEWAY_SERVER], {
        cwd: GATEWAY_DIR,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          CLOUDBASE_APIKEY: key,
          // 第三层兜底闭环：网关自带 orphan-guard 据此在 DSH 主进程消失后自退场。
          HY3_PARENT_PID: String(process.pid),
        },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (e) => log('respawn spawn error: ' + String(e)));
      child.on('exit', (code, sig) => log('respawn child exited code=' + code + ' sig=' + sig));
      child.unref();
      log('respawn: spawned gateway pid=' + child.pid);
      return { spawned: true, note: 'spawned pid=' + child.pid };
    } catch (e) {
      log('respawn error: ' + String(e));
      return { spawned: false, note: 'error: ' + String(e) };
    }
  }

  async function sweep() {
    const ts = Date.now();
    const snapshot = {
      ts,
      anchorMs: null,
      killed: { crashpad: [], gateway: [] },
      reported: [],
      respawned: false,
      respawnNote: null,
      liveGateways: 0,
      suppressedSkipped: 0,
      error: null,
    };
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

      // 判据全部收敛到纯函数 planSweep（crashpad 归属闸门 / 孤儿优先 / 旧代兜底 / 抑制表）
      const plan = planSweep(q.procs, {
        anchorMs: resolvedAnchor,
        toleranceMs: config.generationToleranceMs,
        selfPid: process.pid,
        suppressed: unkillable,
      });
      snapshot.liveGateways = plan.liveGateways;
      snapshot.reported.push(...plan.reports);
      snapshot.suppressedSkipped = plan.suppressedSkipped;

      for (const k of plan.kills) {
        const ok = await killPid(k.pid);
        snapshot.killed[k.kind].push({ pid: k.pid, ok, reason: k.reason });
        log(`kill ${k.kind} pid=${k.pid} ok=${ok} reason=${k.reason} (started ${k.started ?? 'unknown'})`);
        // 杀不掉 ⇒ 记入抑制表（按可执行路径），后续轮次不再重试，避免「每小时同一批 PID 反复失败」。
        // 退出条件：该目标从进程表消失（key 自然不再被查询到）或跨进程重启（内存表清零）。
        if (!ok) {
          const src = q.procs.find((p) => Number(p?.pp) === k.pid);
          if (src) {
            const key = candidateKey(src);
            unkillable.add(key);
            log(`suppress: ${key} (kill failed; will not retry)`);
          }
        }
      }

      if (snapshot.killed.gateway.length > 0) {
        const r = await respawnGateway();
        snapshot.respawned = r.spawned;
        snapshot.respawnNote = r.note;
        if (r.spawned) snapshot.liveGateways += 1;
      }
      lastSweep = snapshot;

      const killedTotal = snapshot.killed.crashpad.length + snapshot.killed.gateway.length;
      if (killedTotal > 0 || snapshot.reported.length > 0) {
        const key = 'sweep:' + (killedTotal > 0 ? 'killed' : 'reported');
        if (canAlert(key)) {
          const body = [
            killedTotal > 0
              ? `清理后台旧实例 ${killedTotal} 个（crashpad=${snapshot.killed.crashpad.length}, gateway=${snapshot.killed.gateway.length}${snapshot.respawned ? ', 已补拉新网关' : ''}）`
              : null,
            snapshot.reported.length > 0 ? `另有 ${snapshot.reported.length} 个旧进程待观察（仅记录未杀）` : null,
          ].filter(Boolean).join('；');
          notify('DSH 实例清道夫', body);
        }
      }
      info(`sweep ok: killed=${killedTotal} reported=${snapshot.reported.length} suppressed=${snapshot.suppressedSkipped} liveGateways=${snapshot.liveGateways} anchorMs=${resolvedAnchor} ts=${ts}`);
    } catch (e) {
      snapshot.error = String((e && e.message) || e);
      lastSweep = snapshot;
      warn('sweep error: ' + snapshot.error);
    }
  }

  // 状态路由（2026-09-06 收敛到 host-services shared-utils，行为不变）
  const statusHandler = (req, res) => {
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
      send(200, { lastSweep: lastSweep ?? null, intervalMs: config.intervalMs, gatewayPort: config.gatewayPort, logFile, suppressed: [...unkillable] });
    } catch { try { send(500, {}); } catch { /* ignore */ } }
  };
  registerRouteWithRetry(ctx, { path: config.statusRoute, handler: statusHandler, logPrefix: 'instance-janitor' });

  // 启动立即扫一轮，再按 intervalMs 周期性清理
  if (config.sweepOnStart) void sweep();
  ctx.setInterval(() => void sweep(), config.intervalMs);
  info(`${name} 启动（每 ${config.intervalMs}ms 一轮；日志 ${logFile}）`);
}
