// @dsh-external/dsh-bandof-diag — 诊断插件（2026-08-23 定位完成）。
// 原用途：定义 globalThis.bandOf 打点，捕获引用 bandOf 的 session listener 调用现场。
// 结论：router-bootstrap.mjs 缺少 `bandOf`/`extractText` 的模块导入，导致解析到全局打点。
// 已修复 router-bootstrap 导入；本插件降级为安全 no-op（即使有代码引用也不抛错/刷日志），
// 待下次重启后可卸载。
export const name = '@dsh-external/dsh-bandof-diag'
export const inject = []
export function apply() {
  if (typeof globalThis.bandOf === 'undefined') {
    globalThis.bandOf = function bandOf(...args) {
      return args.length ? args[0] : undefined
    }
  }
}
