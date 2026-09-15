#!/usr/bin/env node
/**
 * scripts/audit-developer-role.mjs — 只读门禁（check-all Step 1.15）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 2026-09-15 的 ModelScope 400 事故（复盘：outputs/2026-09-15-report-modelscope-developer-role-fix/）
 * 根因是 pi-ai 对「长得像标准 OpenAI 的端点」默认假定其支持 `developer` 角色，而部分网关只认 `system`。
 * 修复只需在 `providers.<name>` 加一行 `compat.supportsDeveloperRole: false`；
 * 但同一天内本机又新增了 `codecraft`(6 模型) / `apinex`(9 模型) 两家供应商，**都没带这一行**,
 * 15 个模型一度完全依赖运行时守卫插件兜底 —— 说明「靠人记得写」不可持续。
 * 本脚本把这条判据变成门禁：新增供应商若会发 developer 且不是真 OpenAI 系，check-all 直接报红。
 *
 * ── 判据（对齐 pi-ai，尽量单一来源）────────────────────────────────────────
 * pi-ai: `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`
 *        （@earendil-works/pi-ai openai-completions.js，2026-09-15 读）
 * 本脚本只算「有效 supportsDeveloperRole」的优先级：模型级 > 路由级 > 端点探测默认值。
 * 端点探测默认值镜像 detectCompat：
 *   default = isOpenRouter ? (模型 id 以 `anthropic/` 或 `openai/` 开头) : !isNonStandard
 * 白名单（真 OpenAI 系必须**保留** developer，o 系列依赖它）**复用守卫插件的同一份函数**
 * `isAllowedUpstream`，避免「门禁一套规则、守卫另一套」的漂移。
 *
 * ── 退出码 ─────────────────────────────────────────────────────────────────
 * 0 = 无缺口（settings.yaml 不存在也算 0 ⇒ skipped，与 /health 探测的 skipped 语义一致）
 * 1 = 存在缺口（**阻塞**；逃生口 `DSH_ALLOW_DEVELOPER_ROLE_GAPS=1` 降级为警告）
 * 2 = 无法读取/解析（fail-closed：绝不在读不到配置时假装通过）
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 * node scripts/audit-developer-role.mjs [--settings <path>] [--json] [--self-test] [--help]
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = join(SCRIPT_DIR, '..')
const HOME = homedir()
const SETTINGS_DEFAULT = join(HOME, '.dsh', 'settings.yaml')

/** 守卫插件（白名单判据的单一来源）。 */
const GUARD_MODULE = pathToFileURL(join(WORKSPACE, 'plugins', 'dsh-developer-role-guard', 'lib', 'index.js')).href

/** js-yaml 定位（desktop profile → web profile → workspace），与 classify-settings-modalities.mjs 同惯例。 */
function resolveYaml() {
  const candidates = [
    join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml'),
    join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'js-yaml'),
    join(WORKSPACE, 'node_modules', 'js-yaml'),
  ]
  for (const base of candidates) {
    try { return require(join(base, 'index.js')) } catch { /* 下一个 */ }
  }
  throw new Error('js-yaml 不可用：请先在任一 profile 安装（本机 desktop profile 自带）。')
}

/**
 * 端点探测默认值（镜像 pi-ai detectCompat）。**若上游改成"未知即不支持"，只需改这一处。**
 * @param {string} provider - 路由名（DSH provider key）。
 * @param {string} baseUrl - 路由 baseURL。
 * @param {string} modelId - 模型 id。
 * @returns {boolean} 探测出来的 supportsDeveloperRole 默认值。
 */
export function detectDeveloperRole(provider, baseUrl, modelId) {
  const u = String(baseUrl || '')
  const id = String(modelId || '')
  const isZai = provider === 'zai' || provider === 'zai-coding-cn' || u.includes('api.z.ai') || u.includes('open.bigmodel.cn')
  const isTogether = provider === 'together' || u.includes('api.together.')
  const isMoonshot = provider === 'moonshotai' || u.includes('api.moonshot.')
  const isOpenRouter = provider === 'openrouter' || u.includes('openrouter.ai')
  const isCloudflareWorkers = provider === 'cloudflare-workers-ai' || u.includes('api.cloudflare.com')
  const isCloudflareGateway = provider === 'cloudflare-ai-gateway' || u.includes('gateway.ai.cloudflare.com')
  const isNvidia = provider === 'nvidia' || u.includes('integrate.api.nvidia.com')
  const isAntLing = provider === 'ant-ling' || u.includes('api.ant-ling.com')
  const isNonStandard =
    isNvidia ||
    provider === 'cerebras' || u.includes('cerebras.ai') ||
    provider === 'xai' || u.includes('api.x.ai') ||
    isTogether || u.includes('chutes.ai') || u.includes('deepseek.com') ||
    isZai || isMoonshot ||
    provider === 'opencode' || u.includes('opencode.ai') ||
    isCloudflareWorkers || isCloudflareGateway || isAntLing
  if (isOpenRouter) return id.startsWith('anthropic/') || id.startsWith('openai/')
  return !isNonStandard
}

/**
 * 扫描一份 `llm-pi-ai` 配置节，输出逐模型判定。
 * @param {object} section - `settings.yaml` 的 `llm-pi-ai` 节。
 * @param {object} guardConfig - 归一化守卫配置（白名单来源）。
 * @param {(model: object, config: object) => boolean} isAllowed - 守卫插件的 `isAllowedUpstream`（显式注入：
 *   既让白名单只有一份实现，也让本函数可被单测用假实现替换）。
 * @returns {{rows: Array, counts: object}}
 */
export function auditSection(section, guardConfig, isAllowed) {
  if (typeof isAllowed !== 'function') throw new TypeError('auditSection 需要 isAllowedUpstream 函数（显式注入）')
  const providers = (section && section.providers) || {}
  const rows = []
  const counts = { providers: 0, models: 0, audited: 0, skippedApi: 0, routeCompatByProvider: {} }
  for (const [name, cfg] of Object.entries(providers)) {
    counts.providers += 1
    const routeFlag = cfg && cfg.compat ? cfg.compat.supportsDeveloperRole : undefined
    counts.routeCompatByProvider[name] = routeFlag
    // compat.supportsDeveloperRole 只对 openai-completions 生效；其它 api 不涉及该角色。
    const api = cfg && typeof cfg.api === 'string' && cfg.api !== '' ? cfg.api : 'openai-completions'
    const models = (cfg && cfg.models) || []
    counts.models += models.length
    if (api !== 'openai-completions') { counts.skippedApi += models.length; continue }
    for (const m of models) {
      counts.audited += 1
      const modelFlag = m && m.compat ? m.compat.supportsDeveloperRole : undefined
      const effective = modelFlag !== undefined
        ? modelFlag
        : (routeFlag !== undefined ? routeFlag : detectDeveloperRole(name, cfg.baseURL, m.id))
      const allowed = isAllowed({ provider: name, baseUrl: cfg.baseURL }, guardConfig)
      rows.push({ provider: name, model: m.id, effective, allowed, gap: effective !== false && !allowed })
    }
  }
  return { rows, counts }
}

/** 给人看的修复建议。 */
export function gapSuggestion(provider) {
  return `在 settings.yaml 的 providers.${provider} 下加：compat: { supportsDeveloperRole: false }（一行，热加载生效，免重启）`
}

// ── 入口 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (key) => {
    const i = argv.indexOf(key)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    settings: get('--settings') || SETTINGS_DEFAULT,
    json: argv.includes('--json'),
    help: argv.includes('--help') || argv.includes('-h'),
    selfTest: argv.includes('--self-test'),
    quiet: argv.includes('--quiet'),
  }
}

function selfTest() {
  const cases = [
    { args: ['apinex', 'https://api.apinex.bond/v1', 'free/qwen-3.8-max'], want: true, why: '未登记端点 ⇒ 探测 true（本机 15 缺口同源）' },
    { args: ['modelscope', 'https://api-inference.modelscope.cn/v1', 'deepseek-ai/DeepSeek-V4.1-Flash'], want: true, why: '未登记端点 ⇒ 探测 true（原始事故模型）' },
    { args: ['deepseek', 'https://api.deepseek.com', 'deepseek-chat'], want: false, why: '非标准名单（deepseek.com）' },
    { args: ['openrouter', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4'], want: true, why: 'OpenRouter + anthropic/ 前缀' },
    { args: ['openrouter', 'https://openrouter.ai/api/v1', 'meta-llama/llama-3-70b'], want: false, why: 'OpenRouter 非 anthropic|openai 前缀' },
    { args: ['openai', 'https://api.openai.com/v1', 'gpt-5.6'], want: true, why: '真 OpenAI ⇒ 保留 developer' },
    { args: ['xai', 'https://api.x.ai/v1', 'grok-5'], want: false, why: '非标准名单（api.x.ai）' },
    { args: ['cerebras', 'https://api.cerebras.ai/v1', 'llama-4'], want: false, why: '非标准名单（cerebras）' },
  ]
  let bad = 0
  for (const c of cases) {
    const got = detectDeveloperRole(...c.args)
    if (got !== c.want) { bad += 1; console.error(`  FAIL detectDeveloperRole(${c.args.join(', ')}) = ${got}, want ${c.want} — ${c.why}`) }
  }
  if (bad === 0) console.log(`  self-test OK (${cases.length} cases)`)
  return bad
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('用法: node scripts/audit-developer-role.mjs [--settings <path>] [--json] [--self-test] [--quiet]')
    console.log('退出码: 0 无缺口/skipped, 1 有缺口(阻塞), 2 读取或解析失败(fail-closed)')
    return 0
  }
  if (opts.selfTest) return selfTest() === 0 ? 0 : 2

  if (!existsSync(opts.settings)) {
    if (!opts.quiet) console.log(`  SKIP  ${opts.settings} 不存在（非源码部署/新机器）⇒ 视为通过`)
    return 0
  }
  let section
  try {
    const yaml = resolveYaml()
    const parsed = yaml.load(readFileSync(opts.settings, 'utf8')) || {}
    section = parsed['llm-pi-ai']
  } catch (e) {
    console.error(`  FAIL  无法读取/解析 ${opts.settings}: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  if (!section || typeof section !== 'object') {
    if (!opts.quiet) console.log('  SKIP  settings.yaml 无 llm-pi-ai 节 ⇒ 视为通过')
    return 0
  }

  const guard = await import(GUARD_MODULE)
  const guardConfig = guard.resolveConfig({})
  const { rows, counts } = auditSection(section, guardConfig, guard.isAllowedUpstream)
  const gaps = rows.filter((r) => r.gap)
  const allowGaps = process.env.DSH_ALLOW_DEVELOPER_ROLE_GAPS === '1'

  if (opts.json) {
    console.log(JSON.stringify({ settings: opts.settings, counts, gaps, ok: gaps.length === 0 }, null, 2))
    return gaps.length === 0 || allowGaps ? 0 : 1
  }

  if (!opts.quiet) {
    console.log(`  settings=${opts.settings}`)
    console.log(`  providers=${counts.providers} models=${counts.models} audited(openai-completions)=${counts.audited} skipped(non-openai-completions)=${counts.skippedApi}`)
    const missingRouteCompat = Object.entries(counts.routeCompatByProvider).filter(([, v]) => v === undefined).map(([k]) => k)
    console.log(`  未设路由级 compat 的 provider: ${missingRouteCompat.length === 0 ? '(无)' : missingRouteCompat.join(', ')}`)
  }
  if (gaps.length === 0) {
    if (!opts.quiet) console.log('  OK    所有 openai-completions 模型都会走 system（或属真 OpenAI 系保留 developer）')
    return 0
  }
  const byProvider = new Map()
  for (const g of gaps) byProvider.set(g.provider, (byProvider.get(g.provider) || 0) + 1)
  for (const [provider, n] of byProvider) {
    console.error(`  GAP   ${provider}: ${n} 个模型会发 developer ⇒ ${gapSuggestion(provider)}`)
  }
  for (const g of gaps) console.error(`        - ${g.provider}/${g.model}`)
  if (allowGaps) {
    console.error('  WARN  DSH_ALLOW_DEVELOPER_ROLE_GAPS=1 ⇒ 仅警告（运行时守卫插件仍会兜住，但这是纵深防御，不是替代）')
    return 0
  }
  console.error('  HINT  逃生口：DSH_ALLOW_DEVELOPER_ROLE_GAPS=1（仅降级为警告，不建议长期使用）')
  return 1
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }, (e) => {
    console.error(`  FAIL  未预期错误: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 2
  })
}
