// @dsh-external/dsh-developer-role-guard
//
// 宿主侧插件：保证「非真 OpenAI 上游」永不收到 role:"developer"（改用 role:"system"）。
//
// ── 背景（2026-09-15 事故，见 outputs/2026-09-15-report-modelscope-developer-role-fix/）──
// pi-ai 组装 Chat Completions 请求时，系统提示词用哪个角色由这一个表达式决定：
//     @earendil-works/pi-ai/dist/api/openai-completions.js:787
//       const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
// 其中 compat.supportsDeveloperRole 在模型/路由都未显式配置时，由 pi-ai 的 detectCompat()
// （同文件 1148 行）探测得出，规则等价于「不在已知非标准厂商列表里、且不是 OpenRouter ⇒ true」。
// 后果：**任何未登记的第三方 OpenAI 兼容端点都被默认当成真 OpenAI**，系统提示词发 developer。
// ModelScope（api-inference.modelscope.cn）正是如此，流式请求直接 400：
//     {"code":"invalid_parameter_error",
//      "message":"developer is not one of ['system','assistant','user','tool','function']"}
// 更阴的是非流式只回 200 + "choices":null（静默空响应），只有流式路径才报错——
// 而 DSH 恒为流式，所以表现为「这个提供商时不时整条不能用」。
//
// 放大器：dsh-force-reasoning-effort 会给缺推理元数据的模型注入 reasoning=true，
// 使上面的 useDeveloperRole 判定成立（手工声明的模型 cost 全零 ⇒ 被判为"未知"而非"已知不支持"）。
//
// ── 本插件做法 ──
// 把 pi-ai 适配器实例包一层（与 dsh-force-reasoning-effort 同款、已在本机验证的模式）：
// 每个 snapshot 的模型描述符上，对**不在允许名单**的路由强制
//     model.compat.supportsDeveloperRole = false
// ⇒ 系统提示词走 system 角色。system 被所有 OpenAI 兼容端点接受（真 OpenAI 也接受），
// 所以这是"更保守"的方向，不是能力损失。
//
// ── 安全边界（为什么它不会把 LLM 调用搞坏）──
//   · 只改一个布尔字段，且是 pi-ai 明确读取的那一个
//     （getCompat: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole）；
//   · 全程 fail-open：任何异常都退回**未打补丁**的快照，绝不抛出、绝不阻断请求；
//   · 幂等：重复打补丁只生效一次，原值记录可还原；
//   · 卸载即还原（ctx.effect 清理 + 原值回写）；
//   · 不碰配置文件、不碰 vendor 文件、不改请求体。
//
// ── 边界（诚实说明）──
//   · 它只解决**角色**这一项；其它协议差异（reasoning_effort 字段、thinking 格式、
//     tool call 细节）不在范围内，需要时各自按 compat 字段处理；
//   · modlens 的包装路由是纯对象适配器（无 current()），本插件跳过它 —— 但它透传到的
//     upstream（真 pi-ai 路由）会被本插件覆盖，所以链路仍受保护。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-developer-role-guard'
// llm 是核心 bundle 服务，启动期已装配；hostServices 是观测面 ——
// 本仓 8/8 个使用它的插件都写进 inject（2026-09-15 实测：不 inject 会导致
// 健康探测项静默缺失，见下方 registerHealthProbe 段注释）。
export const inject = ['llm', 'hostServices']

/** pi-ai 读取该字段决定系统提示词角色（openai-completions.js 的 getCompat）。 */
const FIELD = 'supportsDeveloperRole'

/** 打补丁的标记字段（可枚举，便于还原时定位）。 */
export const PATCH_FLAG = '__dshDevRoleGuardPatched'
/** 原值备份字段。 */
export const ORIGIN_FLAG = '__dshDevRoleGuardOriginal'

/**
 * 真 OpenAI 系端点：developer 角色本就是它们的能力（o 系列推理模型需要它），保持不动。
 * 其余一律强制 false —— 因为「未知端点是否支持 developer」无法预先知道，
 * 而 system 是保守且通用的选择。
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  allowProviders: [
    'openai',
    'openai-responses',
    'openai-codex',
    'openai-codex-responses',
    'azure-openai-responses',
    'azure',
    'github-copilot',
  ],
  allowHosts: [
    'api.openai.com',
    'openai.azure.com',
    'cognitiveservices.azure.com',
    'chatgpt.com',
    'githubcopilot.com',
  ],
  /** true = 只记录"将要打补丁"而不真的改（谨慎试运行用）。 */
  dryRun: false,
  log: true,
  logFile: '',
}

/**
 * 校验并归一化配置（config 缺省 → 全默认）。
 * @param raw - 插件配置。
 * @returns 归一化后的配置。
 * @throws 类型非法 / 必填缺失时抛出（让装配期就失败，而不是运行期静默）。
 */
export function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  for (const key of ['allowProviders', 'allowHosts']) {
    const v = config[key]
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
      throw new Error(`dsh-developer-role-guard: ${key} 必须是非空字符串数组`)
    }
  }
  config.allowHosts = config.allowHosts.map((h) => h.trim().toLowerCase())
  if (typeof config.dryRun !== 'boolean') throw new Error('dsh-developer-role-guard: dryRun 必须是布尔值')
  if (typeof config.log !== 'boolean') throw new Error('dsh-developer-role-guard: log 必须是布尔值')
  if (config.logFile !== '' && typeof config.logFile !== 'string') {
    throw new Error('dsh-developer-role-guard: logFile 必须是字符串（空 = 默认路径）')
  }
  return config
}

/**
 * 从 baseUrl 安全取 host（容错：非字符串/非法 URL 一律返回空串，绝不抛出）。
 * @param baseUrl - 路由基址。
 * @returns 小写 host，取不到时空串。
 */
export function hostOf(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return ''
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 该路由是否属于「真 OpenAI 系」而应保持 developer 能力。
 * 命中 provider 名单，或 baseUrl 的 host 命中（含子域）名单即放行。
 * @param model - pi-ai 模型描述符（读 provider / baseUrl）。
 * @param config - 归一化配置。
 * @returns 放行（保持不动）为 true。
 */
export function isAllowedUpstream(model, config) {
  const provider = model && typeof model.provider === 'string' ? model.provider : ''
  if (provider !== '' && config.allowProviders.includes(provider)) return true
  const host = hostOf(model?.baseUrl ?? model?.baseURL)
  if (host === '') return false
  return config.allowHosts.some((allowed) => host === allowed || host.endsWith('.' + allowed))
}

/**
 * 给一个模型描述符关掉 developer 角色（幂等）。
 * @param model - pi-ai 模型描述符。
 * @param config - 归一化配置。
 * @returns 'patched' | 'allowed' | 'already' | 'skipped' | 'failed'。
 */
export function patchModel(model, config) {
  if (!model || typeof model !== 'object') return 'skipped'
  if (isAllowedUpstream(model, config)) return 'allowed'
  if (model[PATCH_FLAG]) return 'already'
  const before = model.compat && typeof model.compat === 'object' ? model.compat : undefined
  if (before && before[FIELD] === false) return 'already' // 配置/前一层已合规，无需改动
  if (config.dryRun) return 'would-patch'
  try {
    // 复制而非原地改：model.compat 可能被上一层（dsh-llm-pi-ai）共享，原地改会污染其它 snapshot。
    model.compat = { ...(before ?? {}), [FIELD]: false }
    model[ORIGIN_FLAG] = { compat: before }
    model[PATCH_FLAG] = true
    return 'patched'
  } catch {
    return 'failed' // 冻结对象 / 只读描述符：放弃该模型，不影响其它
  }
}

/**
 * 还原一个被本插件改过的模型描述符。
 * @param model - pi-ai 模型描述符。
 * @returns 真的还原了为 true。
 */
export function restoreModel(model) {
  if (!model || typeof model !== 'object' || !model[PATCH_FLAG]) return false
  try {
    const origin = model[ORIGIN_FLAG]
    if (!origin || origin.compat === undefined) delete model.compat
    else model.compat = origin.compat
    delete model[ORIGIN_FLAG]
    delete model[PATCH_FLAG]
    return true
  } catch {
    return false
  }
}

/**
 * 给一个 snapshot 的全部模型打补丁（容错：任何异常都不向外抛）。
 * @param snapshot - pi-ai Models 快照（需有 models.getModels()）。
 * @param config - 归一化配置。
 * @returns 各类计数。
 */
export function patchSnapshot(snapshot, config) {
  const out = { patched: 0, allowed: 0, already: 0, skipped: 0, failed: 0, wouldPatch: 0 }
  try {
    const models = snapshot?.models
    if (!models || typeof models.getModels !== 'function') return out
    const list = models.getModels()
    if (!Array.isArray(list)) return out
    for (const model of list) {
      let verdict
      try {
        verdict = patchModel(model, config)
      } catch {
        verdict = 'failed'
      }
      if (verdict === 'would-patch') out.wouldPatch += 1
      else if (out[verdict] !== undefined) out[verdict] += 1
    }
  } catch {
    /* fail-open：读 snapshot 失败不该影响任何请求 */
  }
  return out
}

/**
 * 还原一个 snapshot 上由本插件打过的全部补丁。
 * @param snapshot - pi-ai Models 快照。
 * @returns 还原数量。
 */
export function restoreSnapshot(snapshot) {
  let restored = 0
  try {
    const models = snapshot?.models
    if (!models || typeof models.getModels !== 'function') return restored
    const list = models.getModels()
    if (!Array.isArray(list)) return restored
    for (const model of list) {
      try {
        if (restoreModel(model)) restored += 1
      } catch {
        /* 单个失败不影响其它 */
      }
    }
  } catch {
    /* fail-open */
  }
  return restored
}

/** 运行期统计（供日志与健康探测读取）。 */
export const stats = {
  adapters: 0,
  patched: 0,
  allowed: 0,
  already: 0,
  skipped: 0,
  failed: 0,
  wouldPatch: 0,
  lastRunAt: '',
}

/**
 * 插件入口。包装所有 pi-ai 形态的适配器实例。
 * @param ctx - cordis 上下文（需 llm 服务）。
 * @param rawConfig - 插件配置。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const SHORT = 'dsh-developer-role-guard'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', SHORT + '.log')

  const log = (msg) => {
    if (!config.log) return
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* 日志失败静默 */
    }
  }

  /** 解析 llm 服务：ctx.llm 优先，ctx.reflect 兜底（运行时注入双保险）。 */
  const resolveLlm = () => {
    try {
      const direct = ctx.llm
      if (direct !== undefined) return direct
    } catch {
      /* fall through */
    }
    try {
      return ctx.reflect?.get('llm')
    } catch {
      /* fall through */
    }
    return undefined
  }

  const record = (r) => {
    stats.patched += r.patched
    stats.allowed += r.allowed
    stats.already += r.already
    stats.skipped += r.skipped
    stats.failed += r.failed
    stats.wouldPatch += r.wouldPatch
    stats.lastRunAt = new Date().toISOString()
  }

  const describe = (r) => `patched=${r.patched} allowed=${r.allowed} already=${r.already} failed=${r.failed}` +
    (config.dryRun ? ` wouldPatch=${r.wouldPatch}` : '')

  /**
   * 包一层 pi-ai 适配器（duck-typed：有 current() 且 snapshot 带 models.getModels）。
   * current()：每个新 snapshot 打补丁（适配器按 profile 身份 memoize，配置变更产生新 snapshot，自动重打）。
   */
  const wrapAdapter = (adapter) => {
    if (!adapter || typeof adapter !== 'object' || typeof adapter.current !== 'function') return false
    if (adapter.__dshDevRoleGuardWrapped) return false

    const originalCurrent = adapter.current.bind(adapter)

    adapter.current = function () {
      const snapshot = originalCurrent()
      try {
        const r = patchSnapshot(snapshot, config)
        record(r)
        if (r.patched > 0 || r.failed > 0 || r.wouldPatch > 0) log(`snapshot 处理: ${describe(r)}`)
      } catch (e) {
        log(`snapshot 处理失败（已忽略，请求不受影响）: ${e instanceof Error ? e.message : String(e)}`)
      }
      return snapshot // fail-open：永远返回快照本身
    }

    adapter.__dshDevRoleGuardWrapped = true

    // 卸载/重载时还原：恢复原方法 + 还原已打补丁的描述符。
    try {
      ctx.effect(() => () => {
        try {
          adapter.current = originalCurrent
          try {
            const restored = restoreSnapshot(adapter.current())
            if (restored > 0) log(`已还原 ${restored} 个模型描述符（插件卸载）`)
          } catch {
            /* 还原 snapshot 失败静默 */
          }
          delete adapter.__dshDevRoleGuardWrapped
        } catch {
          /* 还原失败静默 */
        }
      }, SHORT + '.wrap')
    } catch (e) {
      log(`ctx.effect 注册失败（卸载时无法自动还原）: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 立即触发一次，让当前已缓存的 snapshot 马上受保护。
    // 用 originalCurrent() 而非 adapter.current()：后者已是我们包装过的版本，
    // 会让同一次补丁被记两遍（统计虚高 ⇒ /health 读数失真）。
    try {
      const r = patchSnapshot(originalCurrent(), config)
      record(r)
    } catch {
      /* 延迟到下次 current() 也 OK */
    }
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
      // ⚠️ 2026-09-15 线上实测的账目 bug（已修）：原实现只写 `stats.adapters = wrapped`（本次新包装数），
      // 于是「适配器都已包装」的后续扫描（llm/adapters-updated 触发）会把它**刷成 0**，
      // 而日志里明明写着「已包装 1 个」—— /health 探测项因此报出误导性的 adapters=0。
      // 现改为统计「当前处于守护下的适配器数」，语义与探测项读数一致。
      let guarded = 0
      for (const registration of llm.adapters.values()) {
        const adapter = registration && typeof registration === 'object'
          ? (registration.adapter ?? registration)
          : registration
        if (adapter && typeof adapter === 'object' && adapter.__dshDevRoleGuardWrapped) {
          guarded += 1
          continue
        }
        try {
          if (wrapAdapter(adapter)) {
            wrapped += 1
            guarded += 1
          }
        } catch (e) {
          log(`包装适配器失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      stats.adapters = guarded
      if (wrapped > 0) log(`已包装 ${wrapped} 个 pi-ai 适配器实例（当前受守护 ${guarded} 个）`)
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

  // 可选能力：向 dsh-host-services 的 /health 注册探测项。
  // ⚠️ 2026-09-15 重启后实测缺陷（已修）：原实现把 ctx.hostServices 与反射兜底写在同一个
  // try 里 —— 访问未注入的服务会抛错，反射兜底因此永远走不到，探测项**静默缺失**
  // （文档承诺了却没生效）。现改为：hostServices 进 inject（本仓 8/8 插件同此写法）+
  // 分段兜底 + **注册失败显式记日志**（不再静默吞掉这一类缺陷）。
  const resolveHostServices = () => {
    try {
      const direct = ctx.hostServices
      if (direct !== undefined) return direct
    } catch {
      /* 未注入时访问可能抛错：继续走反射兜底 */
    }
    try {
      return ctx.reflect?.get?.('hostServices')
    } catch {
      /* 反射不可用 */
    }
    return undefined
  }
  try {
    const host = resolveHostServices()
    if (host && typeof host.registerHealthProbe === 'function') {
      const accepted = host.registerHealthProbe('developerRole.guard', () => ({
        ok: stats.failed === 0,
        detail: config.dryRun
          ? `DRY-RUN adapters=${stats.adapters} wouldPatch=${stats.wouldPatch}`
          : `adapters=${stats.adapters} patched=${stats.patched} allowed=${stats.allowed} failed=${stats.failed}`,
      }))
      if (accepted !== true) log('registerHealthProbe 未接受（/health 将不含 developerRole.guard）')
    } else {
      log('hostServices 不可用：/health 将不含 developerRole.guard（护栏本体照常工作）')
    }
  } catch (e) {
    log(`registerHealthProbe 失败（不影响护栏本体）: ${e instanceof Error ? e.message : String(e)}`)
  }

  log(`已启用（dryRun=${config.dryRun} allowProviders=${config.allowProviders.join(',')} allowHosts=${config.allowHosts.join(',')}）`)
  try {
    ctx.logger?.info?.('[dsh-developer-role-guard] 已启用：非 OpenAI 上游强制 system 角色')
  } catch {
    /* logger 不可用静默 */
  }
}
