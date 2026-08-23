// @dsh-external/dsh-bandof-diag — 临时诊断插件：定义 globalThis.bandOf 打点，
// 捕获引用 bandOf 的 session listener 调用现场（stack）。定位后即可卸载本插件。
export const name = '@dsh-external/dsh-bandof-diag'
export const inject = []
export function apply(ctx) {
  if (typeof globalThis.bandOf === 'undefined') {
    globalThis.bandOf = function bandOf(...args) {
      try { throw new Error('bandOf 被调用（诊断打点）') } catch (e) {
        const stack = (e && e.stack) || String(e)
        ctx.logger?.warn?.('[bandof-diag] stack:\n' + stack)
      }
      return args.length ? args[0] : undefined
    }
    ctx.logger?.warn?.('[bandof-diag] 已注入 globalThis.bandOf 打点，观察日志中 bandof-diag 条目')
  }
}
