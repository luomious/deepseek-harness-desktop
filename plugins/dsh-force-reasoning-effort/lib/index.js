// @dsh-external/dsh-force-reasoning-effort
//
// 宿主侧插件：让「所有模型」都能在模型选择器里设置思考强度（reasoning effort）。
//
// 背后原理（调研结论，见 README.md）：
//   DSH 的思考强度选择器由模型的 `reasoning` 能力元数据驱动：
//     - 前端 dsh-client-ui-model-selection 只有在 model.reasoning 存在时才渲染
//       强度菜单（reasoning.efforts → Off/Low/Medium/High…）；
//     - 请求路径 dsh-llm.resolveCallFor / dsh-llm-pi-ai.resolveReasoningLevel
//       也按同一份元数据校验，缺元数据的模型显式请求强度会以
//       UNSUPPORTED_REASONING_EFFORT 在网络 I/O 前失败。
//   这份元数据来自 pi-ai 模型描述符（Model.reasoning + thinkingLevelMap，
//   getSupportedThinkingLevels() 据此返回可选档位）。catalog 标记为
//   reasoning:false 的模型、以及手工声明且未写 reasoningEfforts 的模型，
//   都没有这份元数据 → 界面不显示强度控件 → “设置不了”。
//
// 本插件做法：
//   在运行时把 pi-ai 适配器实例包一层：
//     - current()：每个新 snapshot（模型集合）里，给所有缺失推理元数据的
//       模型描述符注入 reasoning:true + thinkingLevelMap（档位按配置），
//       于是 getSupportedThinkingLevels() 返回可选项、resolveModel 对外公开
//       reasoning（界面出现强度菜单）、请求校验通过、协议按
//       compat.thinkingFormat 正常序列化（openai 风格 → reasoning_effort）。
//     - resolveModel()（可选）：注入配置的默认档位。
//   不改任何 core 包文件、不重启、不动 patch/package.json；卸载即恢复原状
//   （wrapped 方法还原 + 已打补丁的描述符还原）。
//
// 注意（诚实边界）：对提供方本身不支持的模型，把档位发到线上可能被忽略
// 或 400——插件只能让 Harness 提供控件并发送参数，不能改变提供方行为。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-force-reasoning-effort'
// llm 是核心 bundle 服务，启动期已装配；inject 声明 + duck-typed 双保险。
export const inject = ['llm']

/** pi-ai 的规范档位集合（getSupportedThinkingLevels 的 EXTENDED_THINKING_LEVELS）。 */
const CANONICAL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 插件配置（apply 第二参数，可缺省 → 全部默认值）：
 *   enabled       总开关（默认 true）
 *   levels        提供给所有模型的档位，CANONICAL_LEVELS 子集（默认 off/low/medium/high）
 *   wire          档位 → 线上拼写覆盖（默认原样透传，如 { high: 'ultra' }）
 *   defaultEffort 默认档位；'' = 保持提供方默认（默认 ''）
 *   onlyMissing   只给完全缺失推理元数据的模型打补丁（默认 true，推荐）
 *   skipKnownNonReasoning  跳过「catalog 明确标注的非推理模型」（默认 true，自动判断）
 *   onlyProviders 只处理这些 provider 路由（空 = 不限；白名单优先）
 *   skipProviders 跳过这些 provider 路由（空 = 不跳过）
 *   log           写日志（默认 true）
 *   logFile       日志路径；空 → ~/.dsh/super-injector/dsh-force-reasoning-effort.log
 */
const DEFAULT_CONFIG = {
  enabled: true,
  levels: ['off', 'low', 'medium', 'high'],
  wire: {},
  defaultEffort: '',
  onlyMissing: true,
  skipKnownNonReasoning: true,
  onlyProviders: [],
  skipProviders: [],
  log: true,
  logFile: '',
}

function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  if (!Array.isArray(config.levels) || config.levels.length === 0) {
    throw new Error('dsh-force-reasoning-effort: levels 必须是非空数组（如 ["off","low","medium","high"]）')
  }
  for (const level of config.levels) {
    if (!CANONICAL_LEVELS.includes(level)) {
      throw new Error(`dsh-force-reasoning-effort: 未知档位 "${level}"（合法: ${CANONICAL_LEVELS.join(', ')}）`)
    }
  }
  if (config.wire && typeof config.wire === 'object') {
    for (const level of Object.keys(config.wire)) {
      if (!CANONICAL_LEVELS.includes(level)) {
        throw new Error(`dsh-force-reasoning-effort: wire 的键 "${level}" 不是合法档位`)
      }
      if (typeof config.wire[level] !== 'string' || config.wire[level].length === 0) {
        throw new Error(`dsh-force-reasoning-effort: wire["${level}"] 必须是非空字符串`)
      }
    }
  }
  if (config.defaultEffort !== '' && !config.levels.includes(config.defaultEffort)) {
    throw new Error(`dsh-force-reasoning-effort: defaultEffort "${config.defaultEffort}" 不在 levels 中`)
  }
  for (const key of ['onlyProviders', 'skipProviders']) {
    const v = config[key]
    if (v !== undefined && v !== null && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
      throw new Error(`dsh-force-reasoning-effort: ${key} 必须是字符串数组`)
    }
  }
  return config
}

/** 由配置构建 thinkingLevelMap：未提供的档位固定 null（不支持），off 缺席 = 支持且线上不带参数。 */
function buildThinkingLevelMap(config) {
  const map = {}
  for (const level of CANONICAL_LEVELS) {
    if (level === 'off') continue // 缺席 = pi-ai 语义「支持 off，发送时省略」
    if (!config.levels.includes(level)) {
      map[level] = null // 明确不支持
      continue
    }
    map[level] = config.wire[level] ?? level
  }
  return map
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const SHORT = 'dsh-force-reasoning-effort'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')

  const log = (msg) => {
    if (!config.log) return
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  /** 解析 llm 服务：ctx.llm 优先，ctx.reflect 兜底（运行时注入双保险）。 */
  const resolveLlm = () => {
    try {
      const direct = ctx.llm
      if (direct !== undefined) return direct
    } catch { /* fall through */ }
    try {
      return ctx.reflect?.get('llm')
    } catch { /* fall through */ }
    return undefined
  }

  /**
   * 自动判断「catalog 明确标注的非推理模型」：reasoning=false 且有真实定价
   * （cost 非全零）。dsh-llm-pi-ai 物化模型时 catalog 模型保留真实 cost，
   * 手工声明/自定义网关模型则是全零的 NO_COST —— 这正是「未知」与「已知不支持」
   * 的分界。
   */
  const isKnownNonReasoning = (model) => {
    if (!config.skipKnownNonReasoning) return false
    if (model.reasoning) return false
    const c = model.cost
    if (!c || typeof c !== 'object') return false
    // 任一档位 > 0 = 有定价的 catalog 模型；全零 = 手工声明（NO_COST）或免费 catalog → 未知
    return Object.values(c).some((v) => typeof v === 'number' && v > 0)
  }

  /** provider 路由白名单优先，其次黑名单。 */
  const providerAllowed = (provider) => {
    if (Array.isArray(config.onlyProviders) && config.onlyProviders.length > 0) {
      return config.onlyProviders.includes(provider)
    }
    if (Array.isArray(config.skipProviders) && config.skipProviders.includes(provider)) return false
    return true
  }

  /** 给一个 pi-ai 模型描述符注入推理能力（幂等；可还原）。 */
  const patchModel = (model, provider) => {
    if (!model || typeof model !== 'object') return false
    if (config.onlyMissing && model.reasoning) return false
    if (model.__dshForceReasoningPatched) return false
    if (isKnownNonReasoning(model)) return false
    if (!providerAllowed(provider)) return false
    model.__dshForceReasoningOriginal = {
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
    }
    model.reasoning = true
    model.thinkingLevelMap = buildThinkingLevelMap(config)
    model.__dshForceReasoningPatched = true
    return true
  }

  /** 还原由本插件打过的补丁（卸载/重载时）。 */
  const restorePatchedModels = (snapshot) => {
    try {
      if (!snapshot || typeof snapshot.models?.getModels !== 'function') return
      const models = snapshot.models.getModels()
      if (!Array.isArray(models)) return
      for (const m of models) {
        if (!m || typeof m !== 'object' || !m.__dshForceReasoningPatched) continue
        const original = m.__dshForceReasoningOriginal
        if (original && typeof original === 'object') {
          m.reasoning = original.reasoning
          m.thinkingLevelMap = original.thinkingLevelMap
        } else {
          delete m.reasoning
          delete m.thinkingLevelMap
        }
        delete m.__dshForceReasoningOriginal
        delete m.__dshForceReasoningPatched
      }
    } catch { /* 还原失败静默 */ }
  }

  /** 给一个 snapshot（pi-ai Models 集合）的全部模型打补丁。返回 { patched, skippedKnown }。 */
  const patchSnapshot = (snapshot) => {
    const out = { patched: 0, skippedKnown: 0 }
    try {
      if (!snapshot || typeof snapshot.models?.getModels !== 'function') return out
      const models = snapshot.models.getModels()
      if (!Array.isArray(models)) return out
      for (const m of models) {
        try {
          if (patchModel(m, m?.provider)) out.patched += 1
          else if (isKnownNonReasoning(m)) out.skippedKnown += 1
        } catch { /* 单模型失败跳过 */ }
      }
      return out
    } catch {
      return out
    }
  }

  /**
   * 包一层 pi-ai 适配器（duck-typed：有 current() 且 snapshot 带 models.getModels）。
   * - current()：每个新 snapshot 打补丁（适配器按 profiles 身份 memoize，配置变更
   *   会产生新 snapshot，自动重打）。
   * - resolveModel()：可选注入默认档位。
   * 通过 ctx.effect 注册，插件卸载时自动还原原方法。
   */
  const wrapAdapter = (adapter) => {
    if (!adapter || typeof adapter.current !== 'function' || typeof adapter !== 'object') return false
    if (adapter.__dshForceReasoningWrapped) return false

    const originalCurrent = adapter.current.bind(adapter)
    const originalResolveModel = typeof adapter.resolveModel === 'function'
      ? adapter.resolveModel.bind(adapter)
      : undefined

    adapter.current = function () {
      const snapshot = originalCurrent()
      try {
        const r = patchSnapshot(snapshot)
        if (r.patched > 0 || r.skippedKnown > 0) log(`snapshot 补丁: ${r.patched} 个模型获得思考强度，跳过 ${r.skippedKnown} 个已知非推理模型`)
      } catch (e) {
        log(`snapshot 补丁失败: ${e instanceof Error ? e.message : String(e)}`)
      }
      return snapshot
    }

    if (config.defaultEffort !== '' && originalResolveModel) {
      adapter.resolveModel = async function (provider, model, signal) {
        const info = await originalResolveModel(provider, model, signal)
        try {
          if (
            info &&
            info.reasoning &&
            info.reasoning.defaultEffort === undefined &&
            Array.isArray(info.reasoning.efforts) &&
            info.reasoning.efforts.some((e) => e && e.id === config.defaultEffort)
          ) {
            return { ...info, reasoning: { ...info.reasoning, defaultEffort: config.defaultEffort } }
          }
        } catch { /* 默认档位注入失败则返回原样 */ }
        return info
      }
    }

    adapter.__dshForceReasoningWrapped = true

    // 卸载/重载时还原：恢复原方法 + 还原已打补丁的模型。
    try {
      ctx.effect(() => () => {
        try {
          adapter.current = originalCurrent
          if (originalResolveModel) adapter.resolveModel = originalResolveModel
          try {
            restorePatchedModels(adapter.current())
          } catch { /* 还原 snapshot 失败静默 */ }
          delete adapter.__dshForceReasoningWrapped
          log('已还原（插件卸载）')
        } catch { /* 还原失败静默 */ }
      }, SHORT + '.wrap')
    } catch (e) {
      // ctx.effect 不可用：至少保留包装（功能仍生效），仅记日志。
      log(`ctx.effect 注册失败（卸载时无法自动还原）: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 立即触发一次补丁，让当前已缓存的 snapshot 马上获得能力（目录/选择器即时可见）。
    try {
      const r = patchSnapshot(adapter.current())
      if (r.patched > 0 || r.skippedKnown > 0) log(`启动补丁: ${r.patched} 个模型获得思考强度，跳过 ${r.skippedKnown} 个已知非推理模型`)
    } catch { /* 延迟到下次 current() 也 OK */ }
    return true
  }

  /** 扫描 llm 适配器注册表，包装所有 pi-ai 形态的适配器。 */
  const wrapAll = () => {
    try {
      const llm = resolveLlm()
      if (!llm || !(llm.adapters instanceof Map)) {
        log('llm.adapters 不可访问（Map 缺失），跳过包装')
        return
      }
      let wrapped = 0
      for (const registration of llm.adapters.values()) {
        const adapter = registration && typeof registration === 'object'
          ? (registration.adapter ?? registration)
          : registration
        try {
          if (wrapAdapter(adapter)) wrapped += 1
        } catch (e) {
          log(`包装适配器失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (wrapped > 0) log(`已包装 ${wrapped} 个 pi-ai 适配器实例`)
    } catch (e) {
      log(`wrapAll 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  wrapAll()
  // 适配器注册/替换（含配置变更、HMR）后重新扫描。
  try {
    ctx.on('llm/adapters-updated', wrapAll)
  } catch (e) {
    log(`监听 llm/adapters-updated 失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  log(`已启用（levels=${config.levels.join(',')} defaultEffort=${config.defaultEffort || '(提供方默认)'} onlyMissing=${config.onlyMissing}）`)
  try {
    ctx.logger?.info?.('[dsh-force-reasoning-effort] 已启用：为缺失推理元数据的模型注入思考强度能力')
  } catch { /* logger 不可用静默 */ }
}
