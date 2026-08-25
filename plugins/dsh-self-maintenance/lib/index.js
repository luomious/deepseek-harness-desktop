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
 *   3. 健康心跳：全部正常 -> 静默，仅更新 /self-maintenance/status 快照
 *
 * 设计规则（对齐 dsh-stuck-loop-guard / dsh-session-watchdog / dsh-context-lifecycle）：
 *   1. 零运行时依赖：只硬依赖 timer（ctx.setInterval），webServer 经 ctx.reflect.get 惰性解析。
 *   2. fail-safe：每步 try/catch，自身出错绝不影响 harness。
 *   3. 只观测 + 通知，绝不删除/移动/修改任何用户文件（安全守则）。
 *   4. 24h 去重：同一类告警一天最多通知一次，避免刷屏。
 *   5. 无跨插件 HTTP 耦合：不 loopback 拉取其他插件报表，独立轻扫（目录 stat 级，开销可忽略）。
 */
import { statSync, readdirSync, statfsSync } from 'node:fs';
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
};

export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (!(config.intervalMs >= 60_000))
    throw new Error('dsh-self-maintenance: intervalMs must be >= 60000');
  if (!(config.warnFreeGB >= 1))
    throw new Error('dsh-self-maintenance: warnFreeGB must be >= 1');
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

      lastScan = { ts, diskFreeGB, workspaces: scan.workspaces, sessions: scan.sessions, bigCount: scan.bigCount, totalMB: Math.round(scan.totalMB), alerts };

      // ── 3. 分级通知（24h 去重） ──
      if (alerts.length === 0) {
        log(`cycle ok: disk=${diskFreeGB !== null ? diskFreeGB.toFixed(1) + 'GB' : 'n/a'} sessions=${scan.sessions} bigSessions=${scan.bigCount} total=${scan.totalMB.toFixed(0)}MB`);
        return;
      }
      const err = alerts.find((a) => a.level === 'error');
      const title = err ? 'DSH 自检告警（错误）' : 'DSH 自检提醒';
      const body = alerts.map((a) => `• ${a.msg}`).join('\n');
      const key = alerts.map((a) => a.kind).sort().join('+');
      if (canAlert(key)) {
        notify(title, body);
        warn(`alerts: ${body.split('\n').join(' | ')}`);
      } else {
        log(`alerts deduped (last <24h): ${key}`);
      }
    })().catch((e) => warn(`cycle error: ${String(e)}`));
  };

  // ── 状态路由（惰性解析 webServer，失败不影响主体） ──
  try {
    const webServer = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null;
    if (webServer?.register) {
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
              intervalMs: config.intervalMs,
            });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(payload);
          } catch {
            try { res.writeHead(500); res.end('{}'); } catch { /* ignore */ }
          }
        },
      });
      log(`status route registered at ${config.statusRoute}`);
    } else {
      warn('webServer unavailable; status route disabled');
    }
  } catch (e) {
    warn(`status route register failed: ${String(e)}`);
  }

  // 启动立即扫一轮，再按 intervalMs 周期性自检
  cycle();
  ctx.setInterval(cycle, config.intervalMs);
  ctx.logger?.info?.(`[${name}] 智能自检守护启动（每 ${config.intervalMs}ms 一轮；warnFreeGB=${config.warnFreeGB} errorFreeGB=${config.errorFreeGB} bigSessionMB=${config.bigSessionMB}）`);
}