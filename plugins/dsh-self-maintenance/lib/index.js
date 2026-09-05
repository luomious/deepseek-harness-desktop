/**
 * @dsh-external/dsh-self-maintenance — 智能自检守护（daemon-loop 形态）。
 *
 * 定位：把「每日手动巡检」升级为应用内常驻智能自检，无需计划任务、无需管理员权限。
 * 每 intervalMs（默认 1h）一轮，纯进程内判断，不 spawn 任何外部命令：
 *
 *   1. 磁盘健康：statfsSync 检查 ~/.dsh 所在卷剩余空间
 *      - free < warnFreeGB(5)   -> warning（24h 去重通知）
 *      - free < errorFreeGB(2)  -> error 级别
 *   2. 会话体积：轻量目录直扫（不递归进 zstd 解码，区别于 session-hygiene 的深度分析）
 *      - 单个会话 > bigSessionMB(8) 数量 >= bigSessionCount(10) -> warning
 *      - 全部会话总量 > totalSessionGB(0.4)                     -> warning
 *   3. Web GUI 连接卡顿探测（phase1.3 2026-09-04 新增，参考上游 0.1.2 原生重连能力、
 *      升级前先做「检测+通知」）：周期 GET http://127.0.0.1:<webPort>/，
 *      连续 connFailThreshold(3) 次失败 -> warning 通知「建议重启」；
 *      恢复后自动发解除通知。只观测，绝不自动重启（重启守则）。
 *      边界说明：本插件与 webServer 同进程，探测的是「事件循环卡顿/端口未监听」；
 *      进程死亡无法自报，由启动自愈 / 实例清道夫兜底。
 *   4. 上游雷达巡检（phase1.4 2026-09-04）：配置 radarStateFile 时启用（本工作区经
 *      cordis.patch.yml 指向 scripts/update-watch.mjs 的快照）。节流对比 npm 当前
 *      latest 与雷达快照——快照缺失/超龄/上游再动 -> 通知运行 update-watch；
 *      纯 fetch 只读、不 spawn、网络失败静默（fail-open）。跑一次 update-watch 即
 *      消除告警（自愈闭环）。与 conn 探测共同构成常驻「升级触发监控」。
 *   5. 健康心跳：全部正常 -> 静默，仅更新 /self-maintenance/status 快照
 *
 * 设计规则（对齐 dsh-stuck-loop-guard / dsh-session-watchdog / dsh-context-lifecycle）：
 *   1. 零运行时依赖：只硬依赖 timer（ctx.setInterval），webServer 经 ctx.reflect.get 惰性解析。
 *   2. fail-safe：每步 try/catch，自身出错绝不影响 harness。
 *   3. 只观测 + 通知，绝不删除/移动/修改任何用户文件（安全守则）。
 *   4. 24h 去重：同一类告警一天最多通知一次，避免刷屏。
 *   5. 无跨插件 HTTP 耦合：不 loopback 拉取其他插件报表，独立轻扫（目录 stat 级，开销可忽略）。
 */
import { statSync, readdirSync, statfsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = '@dsh-external/dsh-self-maintenance';
export const inject = ['timer'];

const DEFAULT_CONFIG = {
  intervalMs: 60 * 60 * 1000, // 每小时一轮
  warnFreeGB: 5,
  errorFreeGB: 2,
  bigSessionMB: 8,
  bigSessionCount: 10,
  totalSessionGB: 0.4,
  dedupMs: 24 * 60 * 60 * 1000, // 同类告警 24h 去重
  statusRoute: '/self-maintenance/status',
  webPort: 43120, // Web GUI 探测端口（桌面默认；可在 cordis.patch.yml 覆盖）
  probeTimeoutMs: 5000, // 单次探测超时
  connFailThreshold: 3, // 连续失败 N 次才告警（避免启动竞态误报）
  radarStateFile: null, // 上游雷达快照路径（update-watch.mjs 写入）；null = 巡检关闭
  radarProbeIntervalMs: 6 * 60 * 60 * 1000, // 雷达巡检节流（默认 6h 一次）
  radarMaxAgeDays: 7, // 快照超过 N 天未刷新 -> 提醒跑 update-watch
  npmRegistry: 'https://registry.npmmirror.com', // dist-tags 探测源
};

export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (!(config.intervalMs >= 60_000))
    throw new Error('dsh-self-maintenance: intervalMs must be >= 60000');
  if (!(config.warnFreeGB >= 1))
    throw new Error('dsh-self-maintenance: warnFreeGB must be >= 1');
  if (!(Number.isInteger(config.webPort) && config.webPort >= 1 && config.webPort <= 65535))
    throw new Error('dsh-self-maintenance: webPort must be an integer in [1, 65535]');
  if (!(config.probeTimeoutMs >= 1000))
    throw new Error('dsh-self-maintenance: probeTimeoutMs must be >= 1000');
  if (!(config.connFailThreshold >= 1))
    throw new Error('dsh-self-maintenance: connFailThreshold must be >= 1');
  if (config.radarStateFile !== null && typeof config.radarStateFile !== 'string')
    throw new Error('dsh-self-maintenance: radarStateFile must be null or a string path');
  if (!(config.radarProbeIntervalMs >= 60_000))
    throw new Error('dsh-self-maintenance: radarProbeIntervalMs must be >= 60000');
  if (!(config.radarMaxAgeDays >= 1))
    throw new Error('dsh-self-maintenance: radarMaxAgeDays must be >= 1');
  return config;
}

/** 目录字节数（文件累加，子目录限深递归，深度上限 4 防病态结构）。 */
function dirSizeBytes(p, depth) {
  if (depth > 4) return 0;
  let total = 0;
  let entries;
  try {
    entries = readdirSync(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    try {
      if (e.isFile()) total += statSync(join(p, e.name)).size;
      else if (e.isDirectory()) total += dirSizeBytes(join(p, e.name), depth + 1);
    } catch { /* 单项失败忽略 */ }
  }
  return total;
}

/**
 * 轻量目录扫：返回 { bigCount, totalMB, workspaces, sessions }（只 stat，不解码内容）。
 * 布局：~/.dsh/sessions/<workspace>/<sessionId>/files —— 会话在第 2 层。
 */
export function scanSessions(root, bigSessionMB) {
  const out = { bigCount: 0, totalMB: 0, workspaces: 0, sessions: 0 };
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 目录不存在/不可读 -> 视为健康
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    out.workspaces += 1;
    let sessions;
    try {
      sessions = readdirSync(join(root, ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      out.sessions += 1;
      const bytes = dirSizeBytes(join(root, ws.name, s.name), 0);
      const mb = bytes / (1024 * 1024);
      out.totalMB += mb;
      if (mb > bigSessionMB) out.bigCount += 1;
    }
  }
  return out;
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const SHORT = 'dsh-self-maintenance';
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const sessRoot = join(dshHome, 'sessions');
  const lastAlert = new Map(); // kind -> ts
  let lastScan = null; // { ts, diskFreeGB, bigCount, totalMB, alerts }
  // 连接卡顿探测状态（模块级，重启归零；phase1.3 2026-09-04）
  let connFailStreak = 0;
  let connNotified = false;
  let firstCycle = true; // 启动第一轮跳过探测（webServer 可能尚未监听，避免竞态误报）
  // 上游雷达巡检状态（phase1.4 2026-09-04）
  let lastRadarProbeAt = 0;

  const log = (msg) => {
    try { ctx.logger?.info?.(`[${SHORT}] ${msg}`); } catch { /* ignore */ }
  };
  const warn = (msg) => {
    try { ctx.logger?.warn?.(`[${SHORT}] ${msg}`); } catch { /* ignore */ }
  };

  const notify = (title, body) => {
    // 优先走 Electron Notification（与 session-hygiene 同款），失败静默
    try {
      const { Notification } = require('electron');
      if (Notification?.isSupported?.()) {
        const n = new Notification({ title, body, urgency: 'normal' });
        n.on('error', () => {});
        n.show();
        return true;
      }
    } catch { /* fall through（非 Electron 环境） */ }
    // 回退：context 注入提示（桌面端日志可见）
    warn(`${title}: ${body}`);
    return false;
  };

  const canAlert = (kind) => {
    const last = lastAlert.get(kind) ?? 0;
    if (Date.now() - last < config.dedupMs) return false;
    lastAlert.set(kind, Date.now());
    return true;
  };

  /** Web GUI 探测：任何 HTTP 响应（含 4xx/5xx）= 事件循环活着；网络错误/超时 = 疑似卡顿。 */
  const probeWebGui = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.probeTimeoutMs);
    try {
      await fetch(`http://127.0.0.1:${config.webPort}/`, { signal: ctrl.signal, cache: 'no-store' });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 上游雷达巡检（phase1.4 2026-09-04）：radarStateFile 配置后启用。
   * 对比 npm 当前 latest 与雷达快照：快照缺失/超龄/上游再动 -> 返回告警（notify-only）。
   * 节流 radarProbeIntervalMs；fetch 失败静默（fail-open）；跑一次 update-watch 即自愈。
   */
  const checkUpstreamRadar = async () => {
    if (!config.radarStateFile) return null; // 未配置 = 功能关闭
    const now = Date.now();
    if (now - lastRadarProbeAt < config.radarProbeIntervalMs) return null; // 节流
    lastRadarProbeAt = now;
    let snapshot = null;
    try {
      snapshot = JSON.parse(readFileSync(config.radarStateFile, 'utf8'));
    } catch { /* 缺失/损坏 -> 下方统一处理 */ }
    const snapshotLatest = snapshot && snapshot.npm && snapshot.npm.distTags ? snapshot.npm.distTags.latest : null;
    const capturedAt = snapshot && snapshot.capturedAt ? Date.parse(snapshot.capturedAt) : NaN;
    if (!snapshotLatest || !Number.isFinite(capturedAt)) {
      return { level: 'warning', kind: 'upstream', msg: `上游雷达快照缺失/损坏（${config.radarStateFile}），请运行 node scripts/update-watch.mjs` };
    }
    const ageDays = (now - capturedAt) / 86400000;
    if (ageDays > config.radarMaxAgeDays) {
      return { level: 'warning', kind: 'upstream', msg: `上游雷达已 ${ageDays.toFixed(1)} 天未运行（> ${config.radarMaxAgeDays} 天），请运行 node scripts/update-watch.mjs 刷新快照` };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${config.npmRegistry}/@deepseek-ai%2Fdsh`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return null; // registry 失败：静默，避免噪音
      const doc = await res.json();
      const currentLatest = doc && doc['dist-tags'] ? doc['dist-tags'].latest : null;
      if (currentLatest && currentLatest !== snapshotLatest) {
        return { level: 'warning', kind: 'upstream', msg: `npm latest 已翻转：${snapshotLatest} -> ${currentLatest}；请运行 node scripts/update-watch.mjs 刷新快照并查阅 docs/UPSTREAM-UPDATE-PREP.md 升级 runbook` };
      }
    } catch { /* fetch 失败静默 */ }
    finally {
      clearTimeout(timer);
    }
    return null;
  };

  const cycle = () => {
    void (async () => {
      const ts = Date.now();
      const alerts = [];

      // ── 1. 磁盘健康（statfsSync，Node 18.15+；失败则跳过该项） ──
      let diskFreeGB = null;
      try {
        const st = statfsSync(sessRoot);
        const freeBytes = Number(st.bavail) * Number(st.bsize);
        diskFreeGB = freeBytes / (1024 * 1024 * 1024);
        if (diskFreeGB < config.errorFreeGB) {
          alerts.push({ level: 'error', kind: 'disk', msg: `磁盘剩余 ${diskFreeGB.toFixed(1)}GB < ${config.errorFreeGB}GB，请尽快清理` });
        } else if (diskFreeGB < config.warnFreeGB) {
          alerts.push({ level: 'warning', kind: 'disk', msg: `磁盘剩余 ${diskFreeGB.toFixed(1)}GB < ${config.warnFreeGB}GB，建议清理` });
        }
      } catch { /* statfs 不可用 -> 该项跳过 */ }

      // ── 2. 会话体积轻扫 ──
      const scan = scanSessions(sessRoot, config.bigSessionMB);
      if (scan.bigCount >= config.bigSessionCount) {
        alerts.push({ level: 'warning', kind: 'sessions', msg: `${scan.bigCount} 个会话 >${config.bigSessionMB}MB，建议归档/压缩（hygiene 报表见 /session-hygiene/report）` });
      }
      if (scan.totalMB > config.totalSessionGB * 1024) {
        alerts.push({ level: 'warning', kind: 'sessions', msg: `全部会话共 ${scan.totalMB.toFixed(0)}MB > ${config.totalSessionGB}GB，建议清理` });
      }

      // ── 2.5 Web GUI 连接卡顿探测（只观测；详见文件头第 3 点） ──
      if (!firstCycle) {
        const alive = await probeWebGui();
        if (alive) {
          if (connFailStreak > 0) {
            log(`conn probe recovered after ${connFailStreak} failures`);
            if (connNotified) {
              notify('DSH Web GUI 已恢复', `此前连续 ${connFailStreak} 次探测失败已解除。`);
              connNotified = false;
            }
          }
          connFailStreak = 0;
        } else {
          connFailStreak += 1;
          log(`conn probe failed (streak=${connFailStreak}/${config.connFailThreshold})`);
          if (connFailStreak >= config.connFailThreshold) {
            alerts.push({ level: 'warning', kind: 'conn', msg: `Web GUI 连续 ${connFailStreak} 次探测失败（疑似卡顿），建议重启桌面应用恢复` });
          }
        }
      }
      firstCycle = false;

      // ── 2.6 上游雷达巡检（phase1.4；详见文件头第 4 点） ──
      let radarFinding = null;
      try { radarFinding = await checkUpstreamRadar(); } catch { radarFinding = null; }
      if (radarFinding) alerts.push(radarFinding);

      lastScan = { ts, diskFreeGB, workspaces: scan.workspaces, sessions: scan.sessions, bigCount: scan.bigCount, totalMB: Math.round(scan.totalMB), connFailStreak, radar: radarFinding ? radarFinding.msg : 'ok', alerts };

      // ── 3. 分级通知（24h 去重） ──
      if (alerts.length === 0) {
        log(`cycle ok: disk=${diskFreeGB !== null ? diskFreeGB.toFixed(1) + 'GB' : 'n/a'} sessions=${scan.sessions} bigSessions=${scan.bigCount} total=${scan.totalMB.toFixed(0)}MB conn=ok radar=ok`);
        return;
      }
      const err = alerts.find((a) => a.level === 'error');
      const title = err ? 'DSH 自检告警（错误）' : 'DSH 自检提醒';
      const body = alerts.map((a) => `• ${a.msg}`).join('\n');
      const key = alerts.map((a) => a.kind).sort().join('+');
      if (canAlert(key)) {
        notify(title, body);
        warn(`alerts: ${body.split('\n').join(' | ')}`);
        if (alerts.some((a) => a.kind === 'conn')) connNotified = true;
      } else {
        log(`alerts deduped (last <24h): ${key}`);
      }
    })().catch((e) => warn(`cycle error: ${String(e)}`));
  };

  // ── 状态路由（容忍 webServer 启动竞态：惰性解析 + 2s→30s 退避重试，注册成功后即停；失败不影响主体） ──
  let routeRegistered = false;
  let routeAttempts = 0;
  const registerRoute = () => {
    if (routeRegistered) return true;
    let webServer = null;
    try {
      webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null;
    } catch { webServer = null; }
    if (!webServer?.register) return false;
    try {
      webServer.register({
        kind: 'prefix',
        path: config.statusRoute,
        handler: (req, res) => {
          try {
            const payload = JSON.stringify({
              plugin: name,
              ok: true,
              sessionsRoot: sessRoot,
              lastScan: lastScan ?? null,
              connWatch: { webPort: config.webPort, probeTimeoutMs: config.probeTimeoutMs, failThreshold: config.connFailThreshold, currentStreak: connFailStreak },
              radarWatch: { enabled: !!config.radarStateFile, stateFile: config.radarStateFile, probeIntervalMs: config.radarProbeIntervalMs, maxAgeDays: config.radarMaxAgeDays, lastProbeAt: lastRadarProbeAt },
              intervalMs: config.intervalMs,
            });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(payload);
          } catch {
            try { res.writeHead(500); res.end('{}'); } catch { /* ignore */ }
          }
        },
      });
      routeRegistered = true;
      log(`status route registered at ${config.statusRoute}`);
      return true;
    } catch (e) {
      warn(`status route register failed: ${String(e)}`);
      return false;
    }
  };
  if (!registerRoute()) {
    // 退避重试：2s 起指数退避至 30s 封顶，共 20 次（约 8.5 分钟窗口）；成功即早退。
    const retry = () => {
      if (routeRegistered) return;
      if (registerRoute()) return;
      routeAttempts += 1;
      if (routeAttempts >= 20) {
        warn('status route unavailable after retries; retry stopped (webServer never came up in window)');
        return;
      }
      const delay = Math.min(2000 * 2 ** Math.min(routeAttempts, 4), 30000);
      try { ctx.setTimeout(retry, delay); } catch { /* tolerate */ }
    };
    try { ctx.setTimeout(retry, 2000); } catch { /* tolerate */ }
  }

  // 启动立即扫一轮，再按 intervalMs 周期性自检
  cycle();
  ctx.setInterval(cycle, config.intervalMs);
  ctx.logger?.info?.(`[${name}] 智能自检守护启动（每 ${config.intervalMs}ms 一轮；warnFreeGB=${config.warnFreeGB} errorFreeGB=${config.errorFreeGB} bigSessionMB=${config.bigSessionMB} connWatch=127.0.0.1:${config.webPort} streak>${config.connFailThreshold} 告警；radarWatch=${config.radarStateFile ? 'on' : 'off'}）`);
}
