/**
 * @dsh-external/dsh-memory-guard 进程内存哨兵（零依赖 host 模式 / daemon-loop 形态）。
 *
 * 背景（2026-09-14 ~ 09-15 事故，复盘见 outputs/2026-09-15-report-yolo-training-incident/README.md）：
 * 另一 DSH 会话无人值守地反复重启两阶段 YOLO 训练（25 个 dataloader worker），把 16 GB 机器的
 * **提交内存（commit）** 推到 50.6 GB 上限 ⇒ DSH Desktop 崩溃 ×2 + 系统 `0x00000050` 蓝屏。
 *
 * ── v0.2 标定修订（2026-09-15，两个实测发现驱动）─────────────────────────────
 * 发现 A（度量选错）：同一个进程实测 **WS 41 MB vs 私有/提交 852 MB（差 20 倍）**。
 *   v0.1 用 WorkingSetSize ⇒ "提交膨胀型"风暴会被漏判，而事故资源恰在 commit 维度
 *   （System 2004 事件、`WinError 1455 (commit limit)`、`0x50` 蓝屏）。⇒ v0.2 改用
 *   `Win32_Process.PageFileUsage`（每进程提交电荷，KB）为主口径，WS 作兜底并同时暴露。
 * 发现 B（误杀方向）：v0.1 的 `count > 3` 会把**合法**训练（`workers=4` ⇒ 1 主 + 4 worker）
 *   判为风暴并杀掉 —— 即本插件会打死它自己推荐的"安全跑法"。⇒ v0.2 把 count 降级为
 *   "扇出旁证"（`count > 8` **且** 合计 commit 超限才算），并引入**系统提交压力**规则
 *   （`commit/limit > 0.90` 或 可用物理 < 700 MB）—— 这才是蓝屏的真实前兆。
 *
 * ── 判据（纯函数，可脱离运行态单测）──────────────────────────────────────
 * 候选筛选 isCandidate：镜像名 ∈ includeImageNames（默认 python.exe）+ 路径闸门
 *   + PID > 4 / 非自身 / 父进程不是 DSH 主进程（豁免 DSH 直属子进程，保护 MCP python）。
 * 规则表 RULES（数据驱动，新增规则 = 加一条纯谓词 + 单测）：
 *   fanout          候选数 > maxCount(8) 且 合计 commit > fanoutTotalCommitMB(4000)
 *   singleCommit    单体 commit > maxSingleCommitMB(6000)
 *   commitPressure  系统 commit/limit > maxCommitRatio(0.90) 且存在候选
 *   lowAvailable    系统可用物理 < minAvailableMB(700) 且存在候选
 * 动作：action='kill'（默认）⇒ 回收 commit ≥ minKillMB(300) 的候选，按 commit 降序、最多
 *   maxTargets(12) 个；`dryRun` 或 `action='notify'` ⇒ 只告警不动作。
 *
 * ── 长期运行（2026-09-15 加固）──────────────────────────────────────────
 * 自适应轮询：`ctx.setInterval` 固定按 minIntervalMs(15s) 打点，但内部按 due-time 门控 ——
 *   连续 idleAfterSweeps(4) 轮平静后把实际周期升到 maxIntervalMs(60s)，任何触发/击杀立即回落到
 *   15s。⇒ 空闲时 PowerShell 轮询从 5,760 次/天降到 ~1,440 次/天（少 spawn、少 HIPS 噪声）。
 *   （不用 `ctx.setTimeout`：orchestrator README 实测"直写 ctx.setTimeout 会让 loader entry 创建失败"。）
 *
 * ── 安全护栏（防"修一个问题、造一个问题"）────────────────────────────────
 *   放行闸门 ~/.dsh/memory-guard/paused（合法训练放行，跨重启有效）
 *   + DSH 直属子进程豁免 + 路径排除 + minKillMB + maxTargets（限制爆炸半径）
 *   + dryRun/notify 观察模式 + 杀不掉者抑制 10 min + 每步 try/catch fail-safe
 *   + **绝不越出 includeImageNames 范围**：压力即使来自别的进程也不杀无关程序，只记警告。
 *   + 全部 execFile 带 windowsHide（桌面壳无控制台）。
 *
 * ── 可观测 ──────────────────────────────────────────────────────────────
 *   GET  /memory-guard/status   快照（配置/最近一轮/累计击杀/实例标签/sweepCount）
 *   POST /memory-guard/status   手动一轮；`?paused=1|0` 设放行闸门
 *   /health 探测项 memory.guard
 *   日志 ~/.dsh/memory-guard/guard.log（>512 KB 截断；平静轮次不写）
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
// 相对深路径（非裸说明符）：见 scripts/verify-plugin-imports.mjs（F14 禁裸引兄弟插件）。
import { createDedupNotifier, registerRouteWithRetry } from '../../dsh-host-services/lib/shared-utils.js';

// ESM 作用域无全局 require；Electron 主进程内置模块（Notification）需 createRequire
const nodeRequire = createRequire(import.meta.url);

export const name = '@dsh-external/dsh-memory-guard';
export const inject = ['timer', 'hostServices'];

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(SELF_DIR, '..', '..', '..');
const STATE_DIR = join(homedir(), '.dsh', 'memory-guard');
export const LOG_FILE = join(STATE_DIR, 'guard.log');
export const PAUSE_FILE = join(STATE_DIR, 'paused');

export const DEFAULT_CONFIG = {
  enabled: true,
  // ── 轮询节奏（自适应）
  minIntervalMs: 15000,
  maxIntervalMs: 60000,
  idleAfterSweeps: 4,
  sweepOnStart: true,
  // ── 动作
  action: 'kill', // 'kill' | 'notify'
  dryRun: false,
  // ── 候选范围
  includeImageNames: ['python.exe'],
  includePathPrefixes: [],
  excludePathPrefixes: [join(WORKSPACE_ROOT, 'tools')],
  // ── 阈值（commit 口径，单位 MB）
  maxCount: 8,
  fanoutTotalCommitMB: 4000,
  maxSingleCommitMB: 6000,
  maxCommitRatio: 0.9,
  minAvailableMB: 700,
  minKillMB: 300,
  maxTargets: 12,
  // ── 运维
  logMaxBytes: 512 * 1024,
  dedupMs: 30 * 60 * 1000,
  statusRoute: '/memory-guard/status',
};

export function resolveConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (!(Number(c.minIntervalMs) >= 5000)) throw new Error('dsh-memory-guard: minIntervalMs must be >= 5000');
  if (!(Number(c.maxIntervalMs) >= Number(c.minIntervalMs))) throw new Error('dsh-memory-guard: maxIntervalMs must be >= minIntervalMs');
  if (c.action !== 'kill' && c.action !== 'notify') throw new Error("dsh-memory-guard: action must be 'kill' or 'notify'");
  if (!(Number(c.maxCommitRatio) > 0 && Number(c.maxCommitRatio) <= 1)) throw new Error('dsh-memory-guard: maxCommitRatio must be in (0, 1]');
  const names = Array.isArray(c.includeImageNames) && c.includeImageNames.length > 0 ? c.includeImageNames : DEFAULT_CONFIG.includeImageNames;
  c.includeImageNames = names.map((n) => String(n).toLowerCase());
  c.includePathPrefixes = (Array.isArray(c.includePathPrefixes) ? c.includePathPrefixes : []).map(String);
  c.excludePathPrefixes = (Array.isArray(c.excludePathPrefixes) ? c.excludePathPrefixes : []).map(String);
  return c;
}

// ── 纯函数：路径与候选判据 ────────────────────────────────────────────────

/** 路径归一：统一反斜杠 + 小写（Windows 路径比较） */
function normPath(p) {
  return String(p ?? '').replace(/\//g, '\\').toLowerCase();
}

/**
 * 路径闸门：exclude 优先（保护），include 非空时要求命中其一。
 * 路径缺失（权限受限查不到 ExecutablePath）时：仅当未按路径收窄才视为候选
 * （不按路径收窄＝用户接受"所有该镜像名的进程"；一旦收窄，无路径信息就不敢杀）。
 */
export function pathAllowed(execPath, cfg) {
  const p = normPath(execPath);
  if (!p) return cfg.includePathPrefixes.length === 0;
  if (cfg.excludePathPrefixes.some((x) => p.startsWith(normPath(x)))) return false;
  if (cfg.includePathPrefixes.length === 0) return true;
  return cfg.includePathPrefixes.some((x) => p.startsWith(normPath(x)));
}

/** 候选判定：镜像名 + 路径闸门 + 合法 PID */
export function isCandidate(proc, cfg) {
  const pid = Number(proc?.pp ?? 0);
  if (!Number.isFinite(pid) || pid <= 4) return false;
  const nm = String(proc?.nm ?? '').toLowerCase();
  if (!cfg.includeImageNames.includes(nm)) return false;
  return pathAllowed(proc?.ep, cfg);
}

/**
 * 抑制表键：可执行路径 + 启动时间（PID 会复用，路径+启动时间不会）。
 * 用于"已确认杀不掉"的候选，避免每轮重复 taskkill（janitor 实测 8h/40+ 次无效重试的教训）。
 */
export function candidateKey(p) {
  const ep = normPath(p?.ep);
  const st = String(p?.st ?? '');
  if (ep) return 'ep:' + ep + '@' + st;
  return 'np:' + String(p?.nm ?? '').toLowerCase() + '#' + Number(p?.pp ?? 0) + '@' + st;
}

// ── 纯函数：规则表（数据驱动，扩展点）────────────────────────────────────

/** 数值归一：非有限值一律算 0（规则谓词必须对残缺输入安全，见 RULES 契约测试） */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 规则表：每条 = 一个纯谓词。新增保护/回收策略只需在此加一条 + 一条单测，
 * 判定/日志/端点/通知全部自动适配（planGuard 只消费 RULES 的输出）。
 * 契约：谓词必须**永不抛出**且对残缺 stats 返回 false（planGuard 另有 try/catch 双保险）。
 *
 * @type {Array<{id:string, describe:string, when:(stats:object,cfg:object)=>boolean}>}
 */
export const RULES = [
  {
    id: 'fanout',
    describe: '进程扇出（count > maxCount 且 合计 commit > fanoutTotalCommitMB）',
    // count 单独不定罪：合法训练 workers=4 ⇒ 1 主 + 4 worker = 5 个进程（2026-09-15 发现 B）
    when: (s, cfg) => num(s?.count) > num(cfg?.maxCount) && num(s?.totalMB) > num(cfg?.fanoutTotalCommitMB),
  },
  {
    id: 'singleCommit',
    describe: '单体提交失控（max commit > maxSingleCommitMB）',
    when: (s, cfg) => num(s?.maxMB) > num(cfg?.maxSingleCommitMB),
  },
  {
    id: 'commitPressure',
    describe: '系统提交压力（commit/limit > maxCommitRatio）',
    when: (s, cfg) => s?.commitRatio !== null && s?.commitRatio !== undefined && num(s.commitRatio) > num(cfg?.maxCommitRatio) && num(s?.count) > 0,
  },
  {
    id: 'lowAvailable',
    describe: '可用物理内存过低（availMB < minAvailableMB）',
    when: (s, cfg) => s?.availMB !== null && s?.availMB !== undefined && num(s.availMB) < num(cfg?.minAvailableMB) && num(s?.count) > 0,
  },
];

/**
 * 一轮计划编译（纯函数，无副作用）：把查询结果编译成「该不该动手 / 动谁」。
 *
 * @param {Array<object>} procs 查询行 { pp, pi, nm, mb(=commit MB), wsMB, ep, st }
 * @param {object} cfg resolveConfig 结果
 * @param {object} info { selfPid, availMB, commitMB, limitMB, protectedPids:Set, protectedParentPids:Set, suppressed:Set }
 * @returns {{action:'kill'|'notify'|'none', triggers:string[], targets:object[], killable:object[],
 *            candidates:object[], suppressedSkipped:number, pressureNotCausedByCandidates:boolean,
 *            stats:{count:number,totalMB:number,maxMB:number,maxWsMB:number,availMB:(number|null),commitRatio:(number|null),killableCount:number}}}
 */
export function planGuard(procs, cfg, info = {}) {
  const list = Array.isArray(procs) ? procs : [];
  const selfPid = Number(info.selfPid ?? -1);
  const protectedPids = info.protectedPids instanceof Set ? info.protectedPids : new Set();
  const protectedParentPids = info.protectedParentPids instanceof Set ? info.protectedParentPids : new Set();
  const suppressed = info.suppressed instanceof Set ? info.suppressed : new Set();

  const candidates = [];
  for (const p of list) {
    const pid = Number(p?.pp ?? 0);
    if (pid === selfPid || protectedPids.has(pid)) continue;
    // DSH 直属子进程豁免：MCP python（markitdown venv、Anaconda base）的父进程就是 DSH 主进程，
    // 误杀会打断 DSH 工具链；风暴进程是 DSH → shell → cmd → python 的**深层**后代（父为 cmd.exe），
    // 故本闸门只豁免直属子进程，不影响拦截。
    if (protectedParentPids.has(Number(p?.pi ?? 0))) continue;
    if (!isCandidate(p, cfg)) continue;
    // 度量：commit（提交）为主口径，WS 兜底（v0.2：实测两者可差 20 倍，见文件头发现 A）
    const commitMB = Number.isFinite(Number(p?.mb)) ? Number(p.mb) : Number(p?.wsMB ?? 0);
    candidates.push({
      pid,
      mb: Math.max(0, commitMB),
      wsMB: Math.max(0, Number(p?.wsMB ?? 0)),
      nm: p?.nm ?? null,
      ep: p?.ep ?? null,
      st: p?.st ?? null,
      pi: Number(p?.pi ?? 0),
    });
  }

  const totalMB = candidates.reduce((s, c) => s + c.mb, 0);
  const maxMB = candidates.reduce((m, c) => Math.max(m, c.mb), 0);
  const maxWsMB = candidates.reduce((m, c) => Math.max(m, c.wsMB), 0);
  const availMB = Number.isFinite(Number(info.availMB)) ? Number(info.availMB) : null;
  const commitMBsys = Number.isFinite(Number(info.commitMB)) ? Number(info.commitMB) : null;
  const limitMB = Number.isFinite(Number(info.limitMB)) && Number(info.limitMB) > 0 ? Number(info.limitMB) : null;
  const commitRatio = commitMBsys !== null && limitMB !== null ? commitMBsys / limitMB : null;

  const stats = { count: candidates.length, totalMB, maxMB, maxWsMB, availMB, commitRatio, killableCount: 0 };
  const triggers = RULES.filter((r) => {
    try { return r.when(stats, cfg) === true; } catch { return false; } // 规则异常不影响其它规则
  }).map((r) => r.id);

  const killable = candidates
    .filter((c) => c.mb >= cfg.minKillMB && !suppressed.has(candidateKey(c)))
    .sort((a, b) => b.mb - a.mb)
    .slice(0, Math.max(1, Number(cfg.maxTargets) || 12));
  stats.killableCount = killable.length;
  const suppressedSkipped = candidates.filter((c) => suppressed.has(candidateKey(c))).length;

  let action = 'none';
  if (triggers.length > 0) action = cfg.dryRun ? 'notify' : cfg.action;
  const targets = action === 'kill' ? killable : [];

  // 压力型触发的诚实标注：commit/available 报警但候选本身很小 ⇒ 元凶不在候选范围内
  const pressureOnly = triggers.length > 0
    && triggers.every((t) => t === 'commitPressure' || t === 'lowAvailable')
    && stats.maxMB < cfg.maxSingleCommitMB;

  return { action, triggers, targets, killable, candidates, suppressedSkipped, pressureNotCausedByCandidates: pressureOnly, stats };
}

// ── 纯函数：查询构造与解析（可测、可被外部复用做诊断脚本）──────────────────

/** 构造 PowerShell 查询脚本（PS 5.1：片段内不得出现嵌套双引号） */
export function buildQueryScript(cfg) {
  const nameFilter = cfg.includeImageNames.map((n) => "Name='" + String(n).replace(/'/g, '') + "'").join(' OR ');
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$os = Get-CimInstance Win32_OperatingSystem;',
    '$mem = [pscustomobject]@{ availMB = [int]($os.FreePhysicalMemory/1KB); commitMB = [int](($os.TotalVirtualMemorySize-$os.FreeVirtualMemory)/1KB); limitMB = [int]($os.TotalVirtualMemorySize/1KB) };',
    '$list = Get-CimInstance Win32_Process -Filter "' + nameFilter + '";',
    // DSH 主进程 PID 集合（供「直属子进程豁免」闸门用）
    '$dsh = @(Get-CimInstance Win32_Process -Filter "Name=\'DSH Desktop.exe\'" | ForEach-Object { $_.ProcessId });',
    // cmb = PageFileUsage（提交电荷，KB）→ MB；wmb = WorkingSetSize → MB（兜底 + 观测）
    '$procs = $list | ForEach-Object { [pscustomobject]@{ pp = $_.ProcessId; pi = [int]$_.ParentProcessId; nm = $_.Name; cmb = [int]($_.PageFileUsage/1KB); wmb = [int]($_.WorkingSetSize/1MB); st = if ($_.CreationDate) { $_.CreationDate.ToString(\'o\') } else { $null }; ep = $_.ExecutablePath } };',
    '[pscustomobject]@{ mem = $mem; dshPids = $dsh; procs = $procs } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
}

/** 解析查询输出（容错：单对象/数组/缺字段） */
export function parseQueryOutput(text) {
  const parsed = JSON.parse(String(text ?? ''));
  const arr = (v) => (Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]));
  const procs = arr(parsed?.procs).map((p) => ({
    pp: Number(p?.pp ?? 0),
    pi: Number(p?.pi ?? 0),
    nm: p?.nm ?? null,
    mb: Number.isFinite(Number(p?.cmb)) ? Number(p.cmb) : Number(p?.wmb ?? 0),
    wsMB: Number.isFinite(Number(p?.wmb)) ? Number(p.wmb) : 0,
    st: p?.st ?? null,
    ep: p?.ep ?? null,
  }));
  return {
    mem: parsed?.mem ?? null,
    dshPids: arr(parsed?.dshPids).map(Number),
    procs,
  };
}

// ── 运行态 ───────────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const SHORT = 'dsh-memory-guard';
  const applyTimeMs = Date.now();
  const instanceTag = Math.random().toString(36).slice(2, 8);

  const log = (msg) => {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      let size = 0;
      try { size = statSync(LOG_FILE).size; } catch { /* 不存在则直接写 */ }
      if (size > config.logMaxBytes) { try { truncateSync(LOG_FILE, 0); } catch { /* ignore */ } }
      appendFileSync(LOG_FILE, new Date().toISOString() + ' [' + instanceTag + '] ' + msg + '\n');
    } catch { /* ignore */ }
  };
  const warn = (msg) => { try { ctx.logger?.warn?.(`[${SHORT}] ${msg}`); } catch { /* ignore */ } };
  const info = (msg) => { try { ctx.logger?.info?.(`[${SHORT}] ${msg}`); } catch { /* ignore */ } };

  const notify = (title, body) => {
    try {
      const { Notification } = nodeRequire('electron');
      if (Notification?.isSupported?.()) {
        const n = new Notification({ title, body, urgency: 'critical' });
        n.on('error', () => {});
        n.show();
        return true;
      }
    } catch { /* 非 Electron 环境 */ }
    warn(`${title}: ${body}`);
    return false;
  };
  const { canAlert } = createDedupNotifier(config.dedupMs);

  const suppressed = new Map(); // key -> expiry(ms)
  const state = {
    paused: existsSync(PAUSE_FILE),
    lastSweep: null,
    killsTotal: 0,
    lastKillAt: null,
    sweepCount: 0,
    idleStreak: 0,
    currentIntervalMs: config.minIntervalMs,
    applyTimeMs,
    instanceTag,
  };

  function refreshPaused() {
    try { state.paused = existsSync(PAUSE_FILE); } catch { state.paused = false; }
    return state.paused;
  }

  function setPaused(v) {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      if (v) writeFileSync(PAUSE_FILE, new Date().toISOString() + ' paused by /memory-guard/status\n');
      else if (existsSync(PAUSE_FILE)) rmSync(PAUSE_FILE, { force: true });
      refreshPaused();
      log('paused=' + state.paused + ' (via endpoint)');
    } catch (e) {
      warn('setPaused failed: ' + String((e && e.message) || e));
    }
    return state.paused;
  }

  /** 一轮 PowerShell 查询：目标镜像进程清单（commit/WS/路径/父PID）+ 系统内存水位 */
  function query() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') { resolve(null); return; }
      const script = buildQueryScript(config);
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        timeout: 25_000,
        maxBuffer: 8 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) { resolve(null); return; }
        try { resolve(parseQueryOutput(stdout)); } catch { resolve(null); }
      });
      child.on('error', () => resolve(null));
    });
  }

  function killPid(pid) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, timeout: 10_000 }, (err) => resolve(!err));
    });
  }

  async function sweep(trigger = 'timer') {
    const ts = Date.now();
    const snapshot = {
      ts, trigger, paused: state.paused, action: 'none', triggers: [], stats: null,
      killed: [], suppressedSkipped: 0, pressureNotCausedByCandidates: false, error: null,
    };
    try {
      refreshPaused();
      const q = await query();
      if (q === null) {
        snapshot.error = 'query failed (non-Windows or PowerShell unavailable)';
        state.lastSweep = snapshot;
        state.sweepCount += 1;
        warn(snapshot.error);
        return snapshot;
      }
      const plan = planGuard(q.procs, config, {
        selfPid: process.pid,
        availMB: q.mem?.availMB,
        commitMB: q.mem?.commitMB,
        limitMB: q.mem?.limitMB,
        suppressed: new Set(suppressed.keys()),
        protectedParentPids: new Set((q.dshPids ?? []).map(Number)),
      });
      snapshot.action = state.paused ? 'paused' : plan.action;
      snapshot.triggers = plan.triggers;
      snapshot.pressureNotCausedByCandidates = plan.pressureNotCausedByCandidates;
      snapshot.stats = {
        ...plan.stats,
        commitMBsys: Number.isFinite(Number(q.mem?.commitMB)) ? Number(q.mem.commitMB) : null,
        limitMB: Number.isFinite(Number(q.mem?.limitMB)) ? Number(q.mem.limitMB) : null,
      };
      snapshot.suppressedSkipped = plan.suppressedSkipped;

      if (state.paused) {
        log(`skip: paused (would have ${plan.action} ${plan.killable.length} proc; triggers=${plan.triggers.join(',') || 'none'})`);
      } else if (plan.action === 'none') {
        // 平静轮次不写日志（避免噪声），只更新快照
      } else if (plan.action === 'notify') {
        log(`NOTIFY-ONLY (dryRun/notify) triggers=${plan.triggers.join(',')} count=${plan.stats.count} totalCommitMB=${plan.stats.totalMB} maxCommitMB=${plan.stats.maxMB} availMB=${plan.stats.availMB} commitRatio=${plan.stats.commitRatio === null ? 'n/a' : plan.stats.commitRatio.toFixed(3)}`);
      } else {
        for (const t of plan.targets) {
          const ok = await killPid(t.pid);
          snapshot.killed.push({ pid: t.pid, mb: t.mb, wsMB: t.wsMB, ok, ep: t.ep });
          state.killsTotal += 1;
          state.lastKillAt = new Date().toISOString();
          log(`KILL pid=${t.pid} commitMB=${t.mb} wsMB=${t.wsMB} ok=${ok} triggers=${plan.triggers.join(',')} path=${t.ep ?? 'unknown'} started=${t.st ?? 'unknown'}`);
          if (!ok) {
            suppressed.set(candidateKey(t), Date.now() + 10 * 60 * 1000);
            log(`suppress: ${candidateKey(t)} (kill failed; retry in >=10min)`);
          }
        }
      }
      if (plan.pressureNotCausedByCandidates && plan.triggers.length > 0) {
        log(`WARN pressure triggers=${plan.triggers.join(',')} but candidates are small (maxCommitMB=${plan.stats.maxMB} < ${config.maxSingleCommitMB}) — culprit outside includeImageNames; NOT killing unrelated processes`);
      }
      state.lastSweep = snapshot;
      state.sweepCount += 1;

      // 自适应节奏：有触发/击杀 → 立即回到最密；平静 → 累积 idleStreak
      if (plan.triggers.length > 0 || snapshot.killed.length > 0) {
        state.idleStreak = 0;
        state.currentIntervalMs = config.minIntervalMs;
      } else {
        state.idleStreak += 1;
        if (state.idleStreak >= config.idleAfterSweeps) state.currentIntervalMs = config.maxIntervalMs;
      }

      const acted = snapshot.killed.filter((k) => k.ok).length;
      if (acted > 0 || plan.action === 'notify') {
        const alertKey = acted > 0 ? 'killed' : 'notify';
        if (canAlert(alertKey)) {
          const body = acted > 0
            ? `已回收 ${acted} 个内存风暴进程（触发：${plan.triggers.join('、')}；合计提交 ${plan.stats.totalMB} MB）`
            : `检测到内存风暴（触发：${plan.triggers.join('、')}；合计提交 ${plan.stats.totalMB} MB），当前为只观察模式`;
          notify('DSH 内存哨兵', body);
        }
      }
      if (acted > 0 || plan.action === 'notify' || state.paused) {
        info(`sweep ok: action=${snapshot.action} triggers=${plan.triggers.join(',') || 'none'} count=${plan.stats.count} totalCommitMB=${plan.stats.totalMB} killed=${acted} availMB=${plan.stats.availMB} next=${state.currentIntervalMs}ms`);
      }
      const now = Date.now();
      for (const [k, until] of suppressed) if (until <= now) suppressed.delete(k);
      return snapshot;
    } catch (e) {
      snapshot.error = String((e && e.message) || e);
      state.lastSweep = snapshot;
      state.sweepCount += 1;
      warn('sweep error: ' + snapshot.error);
      return snapshot;
    }
  }

  // 状态路由（GET 查看 / POST 手动一轮；?paused=1|0 设放行闸门）
  const statusHandler = (req, res) => {
    const send = (code, obj) => {
      try {
        const payload = JSON.stringify({ plugin: name, ok: code < 400, ...obj });
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(payload);
      } catch { /* ignore */ }
    };
    try {
      const url = String(req.url ?? '');
      const m = /[?&]paused=([01])/.exec(url);
      if (req.method === 'POST' && m) {
        const paused = setPaused(m[1] === '1');
        send(200, { paused, pauseFile: PAUSE_FILE });
        return;
      }
      if (req.method === 'POST') {
        void sweep('manual').then((s) => send(200, { lastSweep: s }));
        return;
      }
      send(200, {
        paused: refreshPaused(),
        pauseFile: PAUSE_FILE,
        instanceTag: state.instanceTag,
        applyTimeMs: state.applyTimeMs,
        sweepCount: state.sweepCount,
        currentIntervalMs: state.currentIntervalMs,
        idleStreak: state.idleStreak,
        metric: 'commit(PageFileUsage), ws fallback',
        rules: RULES.map((r) => ({ id: r.id, describe: r.describe })),
        config: {
          enabled: config.enabled, minIntervalMs: config.minIntervalMs, maxIntervalMs: config.maxIntervalMs,
          idleAfterSweeps: config.idleAfterSweeps, action: config.action, dryRun: config.dryRun,
          includeImageNames: config.includeImageNames, includePathPrefixes: config.includePathPrefixes,
          excludePathPrefixes: config.excludePathPrefixes, maxCount: config.maxCount,
          fanoutTotalCommitMB: config.fanoutTotalCommitMB, maxSingleCommitMB: config.maxSingleCommitMB,
          maxCommitRatio: config.maxCommitRatio, minAvailableMB: config.minAvailableMB,
          minKillMB: config.minKillMB, maxTargets: config.maxTargets,
        },
        killsTotal: state.killsTotal,
        lastKillAt: state.lastKillAt,
        lastSweep: state.lastSweep ?? null,
        logFile: LOG_FILE,
      });
    } catch { try { send(500, {}); } catch { /* ignore */ } }
  };
  registerRouteWithRetry(ctx, { path: config.statusRoute, handler: statusHandler, logPrefix: 'memory-guard' });

  // /health 探测项（子系统缺失要 skipped 仍算绿，避免"狼来了"）
  try {
    const hs = ctx.hostServices;
    if (hs && typeof hs.registerHealthProbe === 'function') {
      const registered = hs.registerHealthProbe('memory.guard', () => ({
        ok: true,
        paused: refreshPaused(),
        killsTotal: state.killsTotal,
        sweepCount: state.sweepCount,
        currentIntervalMs: state.currentIntervalMs,
        lastSweepTs: state.lastSweep?.ts ?? null,
        lastAction: state.lastSweep?.action ?? null,
      }));
      if (registered !== true) warn('registerHealthProbe 未接受（/health 将不含 memory.guard）');
    }
  } catch (e) {
    warn(`registerHealthProbe 失败（不影响哨兵本体）: ${String((e && e.message) || e)}`);
  }

  if (config.enabled === false) {
    info('enabled=false ⇒ 哨兵未启动（仅注册状态端点）');
    return;
  }
  // 自适应节奏：固定按 minIntervalMs 打点 + 内部 due-time 门控（不用 ctx.setTimeout，见文件头）
  let dueAt = Date.now() + (config.sweepOnStart ? 0 : config.minIntervalMs);
  ctx.setInterval(() => {
    const now = Date.now();
    if (now < dueAt) return;
    dueAt = now + state.currentIntervalMs;
    void sweep('timer');
  }, config.minIntervalMs);
  if (config.sweepOnStart) void sweep('start').then(() => { dueAt = Date.now() + state.currentIntervalMs; });
  log(`start v0.2 tag=${instanceTag} min=${config.minIntervalMs}ms max=${config.maxIntervalMs}ms action=${config.action} dryRun=${config.dryRun} rules=${RULES.map((r) => r.id).join('|')}`);
  info(`${name} 启动（metr=commit；节奏 ${config.minIntervalMs}–${config.maxIntervalMs}ms；action=${config.action} dryRun=${config.dryRun}；日志 ${LOG_FILE}）`);
}
