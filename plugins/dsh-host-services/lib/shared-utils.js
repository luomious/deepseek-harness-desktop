/**
 * dsh-host-services shared-utils — 跨插件共享工具函数。
 *
 * 设计原则（2026-09-06 审计收敛）：
 *   1. 零依赖：只用纯逻辑 + ctx 接口，不引入外部模块
 *   2. 纯函数优先：createDedupNotifier 是纯逻辑工厂
 *   3. 有状态工具接受 ctx：registerRouteWithRetry 需要 ctx.setTimeout/logger/reflect
 *   4. 行为不变：提取自现有插件实现，保证重构零行为变化
 *
 * 收敛来源：dsh-session-hygiene、dsh-instance-janitor、dsh-self-maintenance
 * 的退避注册样板（三处几乎逐行复制）和 24h 去重通知器（三处各自实现）。
 */

/**
 * createDedupNotifier — 24h 去重通知器。
 *
 * 纯逻辑工厂，不依赖 ctx。返回 { canAlert(key): boolean }。
 * 首次调用 canAlert(key) 返回 true 并记录时间戳；后续在 cooldownMs 内返回 false。
 *
 * @param {number} cooldownMs - 冷却时间（默认 24h = 86400000ms）
 * @returns {{ canAlert: (key: string) => boolean }}
 */
export function createDedupNotifier(cooldownMs = 24 * 60 * 60 * 1000) {
  const seen = new Map();
  return {
    canAlert(key) {
      const now = Date.now();
      const last = seen.get(key) ?? 0;
      if (now - last < cooldownMs) return false;
      seen.set(key, now);
      return true;
    },
  };
}

/**
 * registerRouteWithRetry — webServer 退避注册样板统一入口。
 *
 * 从三个插件（hygiene/janitor/maintenance）的逐行复制实现中提取。
 * 行为：惰性解析 webServer via ctx.reflect.get() → 注册路由 → 失败时
 * 2s 起指数退避至 30s 封顶，共 20 次（约 8.5 分钟窗口），成功即停。
 *
 * @param {object} ctx - Cordis context
 * @param {object} opts
 * @param {string} opts.path - 路由路径（如 '/instance-janitor/status'）
 * @param {function} opts.handler - 请求处理函数 (req, res) => void
 * @param {string} [opts.logPrefix] - 日志前缀（默认 'registerRoute'）
 * @param {boolean} [opts.useEffect] - 用 ctx.effect 包装注册（便于卸载清理，默认 false）
 * @param {number} [opts.maxAttempts] - 最大重试次数（默认 20）
 * @param {number} [opts.baseDelay] - 基础延迟 ms（默认 2000）
 * @param {number} [opts.maxDelay] - 最大延迟 ms（默认 30000）
 * @returns {boolean} true = 立即注册成功，false = 已启动重试（异步）
 */
export function registerRouteWithRetry(ctx, opts) {
  const {
    path: routePath,
    handler,
    logPrefix = 'registerRoute',
    useEffect = false,
    maxAttempts = 20,
    baseDelay = 2000,
    maxDelay = 30000,
  } = opts;

  const warn = (msg) => { try { ctx.logger?.warn?.(`[${logPrefix}] ${msg}`); } catch { /* ignore */ } };
  const info = (msg) => { try { ctx.logger?.info?.(`[${logPrefix}] ${msg}`); } catch { /* ignore */ } };

  let registered = false;
  let attempts = 0;

  const doRegister = () => {
    if (registered) return true;
    let server = null;
    try { server = (typeof ctx.reflect?.get === 'function' && ctx.reflect.get('webServer')) || null; } catch { server = null; }
    if (!server?.register) return false;
    try {
      if (useEffect) {
        ctx.effect(() => server.register({ kind: 'prefix', path: routePath, handler }), `${logPrefix}: route`);
      } else {
        server.register({ kind: 'prefix', path: routePath, handler });
      }
      registered = true;
      info(`status route registered at ${routePath}`);
      return true;
    } catch (e) {
      warn(`status route register failed: ${String(e)}`);
      return false;
    }
  };

  if (doRegister()) return true;

  // 退避重试：baseDelay 起指数退避至 maxDelay 封顶，共 maxAttempts 次
  const retry = () => {
    if (registered) return;
    if (doRegister()) return;
    attempts += 1;
    if (attempts >= maxAttempts) {
      warn(`status route unavailable after ${maxAttempts} retries; retry stopped`);
      return;
    }
    const delay = Math.min(baseDelay * 2 ** Math.min(attempts, 4), maxDelay);
    try { ctx.setTimeout(retry, delay); } catch { /* tolerate */ }
  };
  try { ctx.setTimeout(retry, baseDelay); } catch { /* tolerate */ }

  return false;
}

/**
 * isLoopback — 本机回环请求校验（remoteAddress + Host 双重校验）。
 *
 * 从 dsh-session-hygiene 与 dsh-crashpad-hygiene 的逐字节等价实现中提取
 * （2026-09-12 O16 收敛）。行为不变：remoteAddress 必须是 loopback，且 Host
 * header 解析出的 hostname 也必须是 loopback 形式，任一不满足即拒绝。
 *
 * @param {object} req - http 请求对象（读取 socket.remoteAddress 与 headers.host）
 * @returns {boolean}
 */
export function isLoopback(req) {
  try {
    const addr = req?.socket?.remoteAddress;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false;
    const hostname = new URL(`http://${String(req?.headers?.host ?? '')}`).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return false;
    return true;
  } catch { return false; }
}
