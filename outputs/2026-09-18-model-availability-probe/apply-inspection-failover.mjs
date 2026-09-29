#!/usr/bin/env node
// 给 dsh-model-provider-failover 加「上游内容审核拒收」定向兜底（默认关闭，零行为回归）。
// 唯一锚点校验 + 同目录 tmp + rename 原子写 + node --check。
// 用法: node apply-inspection-failover.mjs [--dry]
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ROOT = 'D:/Deepseek-Harness/plugins/dsh-model-provider-failover'
const DRY = process.argv.includes('--dry')
const LIB = join(ROOT, 'lib/index.js')
const YML = join(ROOT, 'cordis.patch.yml')
const TEST = join(ROOT, 'test/failover.test.mjs')

const LIB_FIXES = [
  {
    desc: 'file header: document the new inspection class',
    find: "// 目标：当某个 provider 在请求层稳定失败（可用性类 429/5xx/TRANSPORT，或**计费/配额类**",
    replace:
      "// 目标：当某个 provider 在请求层稳定失败（可用性类 429/5xx/TRANSPORT，**计费/配额类**，\n" +
      "// 或（2026-09-24 新增、默认关闭）**上游内容审核拒收类** data_inspection_failed）时，将其放进冷却集",
  },
  {
    desc: 'add INSPECTION_CODE_HINTS / INSPECTION_MESSAGE_PATTERN',
    find: "].join('|'), 'i')\n\n// 默认配置：与 cordis.patch.yml 的 config 保持一致（运行时注入 config={} 时靠这里兜底）。",
    replace:
      "].join('|'), 'i')\n" +
      "\n" +
      "/**\n" +
      " * 「上游内容安全审核拒收」类的 `failure.code` 提示（网关叫法不一，故 code 与 message 双判）。\n" +
      " */\n" +
      "export const INSPECTION_CODE_HINTS = Object.freeze([\n" +
      "  'DATA_INSPECTION_FAILED',\n" +
      "])\n" +
      "\n" +
      "/**\n" +
      " * 「上游内容安全审核拒收」类的 `failure.message` 特征。\n" +
      " * 实测样本（2026-09-24 modelscope / deepseek-ai/DeepSeek-V4.1-Flash，会话 session-fb08b2d6）：\n" +
      " *   `400: {\"code\":\"data_inspection_failed\",\"message\":\"<400> InternalError.Algo.DataInspectionFailed:\n" +
      " *     Input text data may contain inappropriate content.\"}`\n" +
      " *\n" +
      " * 为什么必须锚定报文而不是只看 code：该失败的 `failure.code` 是通用的 `INVALID_REQUEST`，\n" +
      " * 而 `INVALID_REQUEST` 包含“请求真的写错了”等大量正常情形 —— 整体纳入兜底会把真实故障\n" +
      " * 静默换厂商掉。所以这里只认“审核拒收”这个具体信号。\n" +
      " */\n" +
      "export const INSPECTION_MESSAGE_PATTERN = new RegExp([\n" +
      "  'data_inspection_failed',\n" +
      "  'DataInspectionFailed',\n" +
      "  'inappropriate content',\n" +
      "].join('|'), 'i')\n" +
      "\n" +
      "// 默认配置：与 cordis.patch.yml 的 config 保持一致（运行时注入 config={} 时靠这里兜底）。",
  },
  {
    desc: 'DEFAULTS: add claimInspection (default false)',
    find: "  claimRecovery: true,  // 是否对\"内核不重试的计费类失败\"接管一次恢复\n",
    replace:
      "  claimRecovery: true,  // 是否对\"内核不重试的计费类失败\"接管一次恢复\n" +
      "  claimInspection: false, // 是否对\"上游内容审核拒收\"接管一次恢复（**默认关** = 零行为回归）\n",
  },
  {
    desc: 'normalizeConfig: read claimInspection',
    find: "  const claimRecovery = raw.claimRecovery !== false\n",
    replace:
      "  const claimRecovery = raw.claimRecovery !== false\n" +
      "  // 默认 **false**：不显式打开就完全保持原有行为（内容类错误原样放行）。\n" +
      "  const claimInspection = raw.claimInspection === true\n",
  },
  {
    desc: 'normalizeConfig: return claimInspection',
    find: "  return { enabled, cooldownMs, maxFailures, fallback, fallbackModel, claimRecovery, maxRecoveriesPerKey, maxFailoversPerTurn }\n",
    replace: "  return { enabled, cooldownMs, maxFailures, fallback, fallbackModel, claimRecovery, claimInspection, maxRecoveriesPerKey, maxFailoversPerTurn }\n",
  },
  {
    desc: 'add isInspectionFailure()',
    find:
      "/** 可用性类失败判定（沿用既有码表）。 */\n" +
      "export function isAvailabilityFailure(code) {\n" +
      "  return typeof code === 'string' && AVAILABILITY_CODES.includes(code)\n" +
      "}\n",
    replace:
      "/** 可用性类失败判定（沿用既有码表）。 */\n" +
      "export function isAvailabilityFailure(code) {\n" +
      "  return typeof code === 'string' && AVAILABILITY_CODES.includes(code)\n" +
      "}\n" +
      "\n" +
      "/**\n" +
      " * 内容审核拒收类失败判定（code 或 message 任一命中即算）。\n" +
      " * 注意：它**不**并入 shouldCooldown —— 该函数的语义保持“可用性 或 计费”，\n" +
      " * 是否启用审核类兜底由 `cfg.claimInspection` 在监听器里单独门控。\n" +
      " */\n" +
      "export function isInspectionFailure(failure) {\n" +
      "  if (!failure || typeof failure !== 'object') return false\n" +
      "  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : ''\n" +
      "  if (code && INSPECTION_CODE_HINTS.includes(code)) return true\n" +
      "  const message = typeof failure.message === 'string' ? failure.message : ''\n" +
      "  return message.length > 0 && INSPECTION_MESSAGE_PATTERN.test(message)\n" +
      "}\n",
  },
  {
    desc: 'state: add inspectionFailures counter',
    find: "    billingFailures: 0,   // 计费类失败累计（可观测）\n",
    replace:
      "    billingFailures: 0,   // 计费类失败累计（可观测）\n" +
      "    inspectionFailures: 0, // 内容审核拒收累计（可观测）\n",
  },
  {
    desc: 'listener: compute inspection + early-return gate',
    find:
      "      const availability = isAvailabilityFailure(code)\n" +
      "      if (!billing && !availability) { return next() }   // 内容类错误原样放行\n",
    replace:
      "      const availability = isAvailabilityFailure(code)\n" +
      "      // 内容审核拒收：**仅当 cfg.claimInspection 显式开启**才纳入兜底；\n" +
      "      // 默认关闭 ⇒ 维持“内容类错误原样放行”的原行为（零回归）。\n" +
      "      const inspection = c.claimInspection === true && isInspectionFailure(failure)\n" +
      "      if (!billing && !availability && !inspection) { return next() }   // 内容类错误原样放行\n",
  },
  {
    desc: 'listener: cooldown branch covers inspection',
    find:
      "      if (billing) {\n" +
      "        state.billingFailures += 1\n" +
      "        // 计费/配额类：一次即冷却——同 provider 重试不可能自愈\n" +
      "        forceCooldown(state.failureState, provider, now, c.cooldownMs)\n" +
      "        log(`BILLING provider=${provider} code=${code} msg=${String(failure.message || '').slice(0, 120)} -> cooldown ${c.cooldownMs}ms`)\n" +
      "      } else {\n",
    replace:
      "      if (billing || inspection) {\n" +
      "        if (billing) state.billingFailures += 1\n" +
      "        if (inspection) state.inspectionFailures += 1\n" +
      "        // 计费/配额类 与 内容审核拒收类：一次即冷却——同 provider 重试同一报文不可能自愈\n" +
      "        forceCooldown(state.failureState, provider, now, c.cooldownMs)\n" +
      "        log(`${inspection ? 'INSPECTION' : 'BILLING'} provider=${provider} code=${code} msg=${String(failure.message || '').slice(0, 120)} -> cooldown ${c.cooldownMs}ms`)\n" +
      "      } else {\n",
  },
  {
    desc: 'listener: recovery claim gate covers inspection',
    find:
      "      if (!billing || kernelOwnsRetry) {\n" +
      "        if (billing && kernelOwnsRetry) log(`CLAIM-SKIP provider=${provider} code=${code} reason=kernel-retryable`)\n" +
      "        return next()\n" +
      "      }\n",
    replace:
      "      if ((!billing && !inspection) || kernelOwnsRetry) {\n" +
      "        if ((billing || inspection) && kernelOwnsRetry) log(`CLAIM-SKIP provider=${provider} code=${code} reason=kernel-retryable`)\n" +
      "        return next()\n" +
      "      }\n",
  },
  {
    desc: 'status tool: expose claimInspection + counter',
    find:
      "          `claimRecovery=${c.claimRecovery}  maxRecoveriesPerKey=${c.maxRecoveriesPerKey}  maxFailoversPerTurn=${c.maxFailoversPerTurn}`,\n" +
      "          `counters: billingFailures=${state.billingFailures}  claimedRecoveries=${state.claimedRecoveries}`,\n",
    replace:
      "          `claimRecovery=${c.claimRecovery}  claimInspection=${c.claimInspection}  maxRecoveriesPerKey=${c.maxRecoveriesPerKey}  maxFailoversPerTurn=${c.maxFailoversPerTurn}`,\n" +
      "          `counters: billingFailures=${state.billingFailures}  inspectionFailures=${state.inspectionFailures}  claimedRecoveries=${state.claimedRecoveries}`,\n",
  },
  {
    desc: 'configure tool: add claimInspection param',
    find: "        claimRecovery: { type: 'boolean', description: 'whether to claim one recovery for billing/quota failures' },\n",
    replace:
      "        claimRecovery: { type: 'boolean', description: 'whether to claim one recovery for billing/quota failures' },\n" +
      "        claimInspection: { type: 'boolean', description: 'whether to claim one recovery for upstream content-inspection rejections (data_inspection_failed)' },\n",
  },
  {
    desc: 'configure tool: handle claimInspection',
    find: "        if (args.claimRecovery !== undefined) { c.claimRecovery = !!args.claimRecovery; notes.push(`claimRecovery=${c.claimRecovery}`) }\n",
    replace:
      "        if (args.claimRecovery !== undefined) { c.claimRecovery = !!args.claimRecovery; notes.push(`claimRecovery=${c.claimRecovery}`) }\n" +
      "        if (args.claimInspection !== undefined) { c.claimInspection = !!args.claimInspection; notes.push(`claimInspection=${c.claimInspection}`) }\n",
  },
  {
    desc: 'armed log: include claimInspection',
    find: "  log(`armed: enabled=${state.cfg.enabled} cooldownMs=${state.cfg.cooldownMs} maxFailures=${state.cfg.maxFailures} claimRecovery=${state.cfg.claimRecovery} fallback=",
    replace: "  log(`armed: enabled=${state.cfg.enabled} cooldownMs=${state.cfg.cooldownMs} maxFailures=${state.cfg.maxFailures} claimRecovery=${state.cfg.claimRecovery} claimInspection=${state.cfg.claimInspection} fallback=",
  },
]

const YML_FIXES = [
  {
    desc: 'yml: add claimInspection: true',
    find: "        maxFailoversPerTurn: 3   # 单轮最多切换几次 provider（防 A→B→A 抖动）\n",
    replace:
      "        maxFailoversPerTurn: 3   # 单轮最多切换几次 provider（防 A→B→A 抖动）\n" +
      "        claimInspection: true    # 定向：上游内容审核拒收（data_inspection_failed）也接管一次恢复\n",
  },
  {
    desc: 'yml: fallback += modelscope x2',
    find: "          modlens-tokenrouter: modlens-tokenrhythm01\n        fallbackModel:\n",
    replace:
      "          modlens-tokenrouter: modlens-tokenrhythm01\n" +
      "          modlens-modelscope: modlens-tokenrhythm01\n" +
      "          modelscope: modlens-tokenrhythm01\n" +
      "        fallbackModel:\n",
  },
  {
    desc: 'yml: fallbackModel += modelscope x2',
    find: "          modlens-tokenrouter: deepseek-v4-flash-0731\n",
    replace:
      "          modlens-tokenrouter: deepseek-v4-flash-0731\n" +
      "          modlens-modelscope: deepseek-v4-flash-0731\n" +
      "          modelscope: deepseek-v4-flash-0731\n",
  },
  {
    desc: 'yml: header note',
    find: "# fallbackModel 强烈建议填：跨 provider 时 model id 通常不存在，必须显式映射，",
    replace:
      "#   3) modlens-modelscope / modelscope（2026-09-24 新增，需 claimInspection: true）：\n" +
      "#      上游（阿里魔搭）**输入内容安全审核**会以 400 data_inspection_failed 拒收整段上下文\n" +
      "#      （实测：同一模型发 152,038 tokens 无害长文本 → 200 OK，故不是长度限制，是内容判定；\n" +
      "#       失败那步 inputTokens=0/outputTokens=0 ⇒ 生成前就被拒）。该失败 code 是通用的\n" +
      "#      INVALID_REQUEST ⇒ 内核不重试、本插件原也不接管 ⇒ 整轮硬失败。\n" +
      "#      现定向识别该报文：一次即冷却 + 接管一次恢复，把该轮切到备用 provider。\n" +
      "#\n" +
      "# fallbackModel 强烈建议填：跨 provider 时 model id 通常不存在，必须显式映射，",
  },
]

const TEST_FIXES = [
  {
    desc: 'test: import isInspectionFailure',
    find: "  forceCooldown, claimBudget, applyFailoverConfig,\n",
    replace: "  forceCooldown, claimBudget, applyFailoverConfig, isInspectionFailure,\n",
  },
  {
    desc: 'test: normalizeConfig defaults += claimInspection:false',
    find: "  claimRecovery: true, maxRecoveriesPerKey: 1, maxFailoversPerTurn: 3,\n})",
    replace: "  claimRecovery: true, claimInspection: false, maxRecoveriesPerKey: 1, maxFailoversPerTurn: 3,\n})",
  },
  {
    desc: 'test: add inspection cases (real sample + zero-regression asserts)',
    find: "console.log('ALL TESTS PASSED')",
    replace:
      "// ── isInspectionFailure（2026-09-24 modelscope 事故原文）─────────────\n" +
      "// 判据必须是“审核拒收”这个具体信号，而不是通用 code INVALID_REQUEST ——\n" +
      "// 否则“请求真的写错了”也会被静默换厂商。\n" +
      "const REAL_INSPECTION = '400: {\"code\":\"data_inspection_failed\",\"message\":\"<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.\",\"param\":null,\"type\":\"data_inspection_failed\"}'\n" +
      "assert.equal(isInspectionFailure({ code: 'INVALID_REQUEST', message: REAL_INSPECTION }), true, 'real 2026-09-24 sample must match')\n" +
      "assert.equal(isInspectionFailure({ code: 'DATA_INSPECTION_FAILED' }), true, 'code hint')\n" +
      "assert.equal(isInspectionFailure({ code: 'INVALID_REQUEST', message: 'bad tool schema' }), false, 'generic invalid request must NOT match')\n" +
      "assert.equal(isInspectionFailure({ code: 'INVALID_REQUEST' }), false)\n" +
      "assert.equal(isInspectionFailure({ message: REAL_402_A }), false, 'billing must not be seen as inspection')\n" +
      "assert.equal(isInspectionFailure(undefined), false)\n" +
      "\n" +
      "// 故障注入式回归：默认关 ⇒ 审核类失败不冷却、不接管（原行为不变）\n" +
      "assert.equal(normalizeConfig({}).claimInspection, false, 'default must stay OFF (zero regression)')\n" +
      "assert.equal(normalizeConfig({ claimInspection: true }).claimInspection, true)\n" +
      "assert.equal(normalizeConfig({ claimInspection: 'yes' }).claimInspection, false, 'only boolean true enables it')\n" +
      "assert.equal(shouldCooldown('INVALID_REQUEST', { code: 'INVALID_REQUEST', message: REAL_INSPECTION }), false, 'shouldCooldown semantics unchanged')\n" +
      "assert.equal(isBillingFailure({ code: 'INVALID_REQUEST', message: REAL_INSPECTION }), false, 'inspection is not billing')\n" +
      "\n" +
      "console.log('ALL TESTS PASSED')",
  },
]

function applyFixes(file, fixes, label, checkJs) {
  const raw = readFileSync(file, 'utf8')
  const before = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  let out = raw
  for (const f of fixes) {
    const n = out.split(f.find).length - 1
    if (n !== 1) {
      console.error(`ABORT [${label}]: anchor hit ${n} times (expected 1) -> ${f.desc}`)
      process.exit(1)
    }
    out = out.replace(f.find, f.replace)
    console.log(`  ok  ${label}: ${f.desc}`)
  }
  const after = createHash('sha256').update(out).digest('hex').slice(0, 16)
  console.log(`${label}: ${raw.length}B -> ${out.length}B  (${before} -> ${after})`)
  if (DRY) return
  // 临时文件必须**保留原扩展名**，否则 node --check 报 ERR_UNKNOWN_FILE_EXTENSION
  // （上轮已踩过：client.js.checktmp-50696）。
  const tmp = file.replace(/(\.[^./\\]+)$/, '.tmp-inspection$1')
  writeFileSync(tmp, out, 'utf8')
  if (checkJs) {
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      console.error(`ABORT [${label}]: node --check failed\n${(e.stderr || '').toString() || e.message}`)
      process.exit(1)
    }
  }
  renameSync(tmp, file)
  const back = readFileSync(file, 'utf8')
  if (back !== out) { console.error(`ABORT [${label}]: read-back mismatch`); process.exit(1) }
}

console.log('--- lib/index.js ---')
applyFixes(LIB, LIB_FIXES, 'lib', true)
console.log('--- cordis.patch.yml ---')
applyFixes(YML, YML_FIXES, 'yml', false)
console.log('--- test/failover.test.mjs ---')
applyFixes(TEST, TEST_FIXES, 'test', true)
console.log(DRY ? '\n[dry-run] no write' : '\nDONE')
