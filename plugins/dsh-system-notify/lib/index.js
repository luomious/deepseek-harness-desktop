/**
 * @dsh-external/dsh-system-notify — host 侧占位。
 * 通知能力全部在 client 侧（Web Notification API + 主进程权限授权），
 * host 端仅需满足 cordis 加载器对包入口（main → lib/index.js）的 import 要求。
 */
export const name = '@dsh-external/dsh-system-notify'
export const inject = []

export function apply() {
  // 无 node 侧逻辑；client 侧提供 ctx.notify service 与自动任务完成提示。
}