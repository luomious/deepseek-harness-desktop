// @dsh-external/dsh-modlens-guard — ModLens 配置守卫
//
// 背景：2026-08-19 22:58 有人把 `visionProvider: false` 写进了
// ~/.dsh/profiles/web/cordis.patch.yml 的 modlens 配置块，导致
// "(modlens vision)" 包装模型从模型选择器里全部消失（modlens 插件只有在
// `visionProvider !== false` 时才注册这些包装 provider）。
//
// 职责：
//  1. 立即恢复：把 cordis.patch.yml 里 modlens 配置块中的 `visionProvider: false`
//     移除（文件层面修复，重启后同样正确）；
//  2. 热生效：通过 loader 找到 modlens 条目并 entry.update() 以启用状态重建
//     fiber，无需重启服务即可看到 (modlens vision) 模型；
//  3. 定时巡查：每 60s 检查一次，若 `visionProvider: false` 再次出现立即恢复，
//     并写日志 ~/.dsh/super-injector/modlens-guard.log。
//
// 临时关闭守卫：在 cordis.patch.yml 顶部加注释 `# modlens-guard: off`。
// 卸载守卫：dev_uninject_plugin dsh-modlens-guard（注入器常驻，重启后自动恢复）。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'dsh-modlens-guard'
export const inject = ['timer']

const PATCH_PATH = join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
const LOG_PATH = join(homedir(), '.dsh', 'super-injector', 'modlens-guard.log')
// 测试钩子：存在该哨兵文件时，runOnce 先模拟"攻击"（往 modlens 配置块写回
// visionProvider: false），再走正常恢复流程——用于端到端验证守卫（生产默认不创建）。
const SIMULATE_FILE = new URL('./.simulate-attack', import.meta.url)

// modlens 包装的模型家族（按 id 前缀匹配）。扩展为全量，让所有纯文本模型
// 都有 (modlens vision) 版本；modlens 的 shouldWrap 会自动排除原生视觉模型
// （deepseek-vl/ocr、glm-*v 等）和已声明 image 输入的模型，所以加全量是安全的。
const FIXED_FAMILIES = ['deepseek', 'glm', 'mimo', 'qwen', 'kimi', 'minimax', 'seed', 'grok', 'sensenova']
const FAMILIES_LINE = `    families: ['${FIXED_FAMILIES.join("', '")}']`
const GUARD_OFF = /modlens-guard\s*:\s*off/
const CHECK_MS = 60_000

function log(...parts) {
  try {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, line)
  } catch {
    /* 日志失败不影响守卫本身 */
  }
}

// 修复 modlens 配置块：① 移除 `visionProvider: false`；② 把 `families:` 行
// 强制为 FIXED_FAMILIES（防止被改回 3 家导致 qwen/kimi 等失去 modlens 版本）。
// 逐行状态机：`- id: modlens` 进入条目 → `config:` 进入配置块 → 块内按行处理。
function fixModlensBlock(raw) {
  const lines = raw.split(/\r?\n/)
  const out = []
  let inModlens = false
  let inConfig = false
  let removed = 0
  let familiesRewritten = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^- id:\s*/.test(trimmed)) {
      inModlens = /^- id:\s*modlens(\s+#.*)?\s*$/.test(trimmed)
      inConfig = false
      out.push(line)
      continue
    }
    if (!inModlens) {
      out.push(line)
      continue
    }
    if (trimmed === 'config:') {
      inConfig = true
      out.push(line)
      continue
    }
    if (inConfig && /^visionProvider\s*:\s*false\s*$/.test(trimmed)) {
      removed += 1
      continue
    }
    if (inConfig && /^families\s*:/.test(trimmed)) {
      if (line !== FAMILIES_LINE) {
        out.push(FAMILIES_LINE)
        familiesRewritten = true
        continue
      }
    }
    out.push(line)
  }
  return { text: out.join('\n'), removed, familiesRewritten }
}

// 在 loader 树里定位 modlens 条目（entries() 遍历含嵌套子树；
// 直接 tree.update(id) 对 bundle 条目可能解析失败，故按 id/name 匹配）。
function findModlensEntry(ctx) {
  if (!ctx?.loader || typeof ctx.loader.entries !== 'function') return undefined
  for (const entry of ctx.loader.entries()) {
    const opts = entry?.options
    if (!opts || opts.group) continue
    const id = String(opts.id ?? '')
    const nm = String(opts.name ?? '')
    if (id === 'modlens' || nm === '@liustack/modlens' || nm === 'modlens') return entry
  }
  return undefined
}

// 让运行中的 modlens 插件用启用状态重建（不重启服务）。
// 幂等：条目配置已是 { families }（无 visionProvider: false）时为 no-op。
async function hotReapply(ctx) {
  const entry = findModlensEntry(ctx)
  if (!entry || typeof entry.update !== 'function') {
    log('hot-apply skipped: modlens entry not found in loader tree')
    return false
  }
  try {
    await entry.update({ config: { families: FIXED_FAMILIES } }, false, true)
    log('hot-apply OK: modlens entry rebuilt with visionProvider enabled')
    return true
  } catch (error) {
    log('hot-apply FAILED (文件已修复，重启后仍会生效):', String(error?.stack ?? error))
    return false
  }
}

// 测试钩子：把 `visionProvider: false` 插回 modlens 配置块（模拟攻击）。
// 与 strip 反向的精确文本操作：在 modlens config 块内 families 行后插入。
function insertVisionProviderFalse(raw) {
  const lines = raw.split(/\r?\n/)
  const out = []
  let inModlens = false
  let inConfig = false
  let inserted = false
  for (const line of lines) {
    out.push(line)
    const trimmed = line.trim()
    if (/^- id:\s*/.test(trimmed)) {
      inModlens = /^- id:\s*modlens(\s+#.*)?\s*$/.test(trimmed)
      inConfig = false
      continue
    }
    if (!inModlens) continue
    if (trimmed === 'config:') {
      inConfig = true
      continue
    }
    if (inConfig && !inserted && /^families\s*:/.test(trimmed)) {
      out.push('    visionProvider: false')
      inserted = true
    }
  }
  return { text: out.join('\n'), inserted }
}

function runOnce(ctx) {
  // 模拟攻击（仅当哨兵文件存在时）：先写回坏行，再走正常恢复流程验证守卫。
  try {
    if (existsSync(SIMULATE_FILE)) {
      let attacked = readFileSync(PATCH_PATH, 'utf8')
      const attack = insertVisionProviderFalse(attacked)
      if (attack.inserted) {
        writeFileSync(PATCH_PATH, attack.text)
        log('SIMULATED attack: visionProvider: false 已写回（测试钩子）')
      }
    }
  } catch (error) {
    log('simulate error:', String(error))
  }
  let raw
  try {
    raw = readFileSync(PATCH_PATH, 'utf8')
  } catch (error) {
    log('read error:', String(error))
    return
  }
  if (GUARD_OFF.test(raw)) {
    log('guard off (sentinel "# modlens-guard: off"), skipping')
    return
  }
  const { text, removed, familiesRewritten } = fixModlensBlock(raw)
  if (!removed && !familiesRewritten) return
  try {
    writeFileSync(PATCH_PATH, text)
    const bits = []
    if (removed) bits.push(`removed ${removed}× visionProvider: false`)
    if (familiesRewritten) bits.push(`families -> [${FIXED_FAMILIES.join(', ')}]`)
    log(`RESTORED: ${bits.join('; ')} in ${PATCH_PATH}`)
  } catch (error) {
    log('write error:', String(error))
    return
  }
  void hotReapply(ctx)
}

export function apply(ctx) {
  ctx.effect(() => {
    try {
      runOnce(ctx)   // 注入即恢复（文件层面）
      void hotReapply(ctx) // 热生效：重建运行中的 modlens 条目（幂等）
      log('guard armed (every 60s)')
    } catch (error) {
      log('apply error:', String(error))
    }
    const timer = ctx.setInterval(() => runOnce(ctx), CHECK_MS)
    return () => clearInterval(timer)
  })
}
