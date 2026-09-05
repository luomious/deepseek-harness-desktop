// @dsh-external/dsh-modlens-autoread/lib/model-modality.js
//
// 统一模型模态分类器（单一事实源，供 autoread 插件与
// scripts/classify-settings-modalities.mjs 共用）。
//
// 判定优先级（高→低）：
//   1. 本地覆盖文件 ~/.modlens/model-modalities.json
//      {"image": ["<精确模型id>", ...], "text": ["<精确模型id>", ...]}
//      —— 精确 id 匹配（去厂商命名空间后），显式覆盖永远赢。
//   2. 权威视觉模式表 VISION_PATTERNS：镜像 @liustack/modlens 3.23.1
//      dist/main.js VISION_MODEL_PATTERNS（2026 实测快照），并补充
//      本机确认项（glm-5.3-flash，用户实测其网关原生收图）。
//   3. 已知纯文本模式 TEXT_PATTERNS（保守、只收确证项）。
//   4. 其余 → 'unknown'：调用方按保守策略处理（默认视同 text，
//      但用脚本 --web 可经 models.dev 复核后再定）。
//
// 纯 node 内置，零依赖；供 host 侧插件与 CLI 脚本 import。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OVERRIDES_PATH = process.env.DSH_MODEL_MODALITIES_FILE
  ? process.env.DSH_MODEL_MODALITIES_FILE
  : join(homedir(), '.modlens', 'model-modalities.json')

/**
 * glob 匹配（* 任意串、? 单字符）。与 modlens dist/main.js globMatch
 * 语义一致：整串匹配，模式无隐式锚点。
 */
export function globMatch(pattern, str) {
  const src = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\?/g, '[\\s\\S]')
  try {
    return new RegExp(`^${src}$`).test(String(str))
  } catch {
    return false
  }
}

/** 权威视觉模式（镜像 modlens 3.23.1 + 本机确认补充）。 */
export const VISION_PATTERNS = [
  'claude-*',
  'gpt-4o*',
  'gpt-4.1*',
  'gpt-5*',
  'o3*',
  'o4*',
  'gemini-*',
  'glm-*v*',
  // 2026-09-04 补充：用户确认 tokenrhythm 网关 glm-5.3-flash 原生收图
  'glm-5.3-flash*',
  'qwen*-vl*',
  'qwen3.5-plus*',
  'qwen3.6-plus*',
  'qwen3.7-plus*',
  'qwen3.7-flash*',
  'qwen3.8-max*',
  'kimi-k2.5*',
  'kimi-k2.6*',
  'kimi-k2.7*',
  'kimi-k3*',
  'moonshot-v1-*vision*',
  'minimax-vl*',
  'minimax-m3*',
  // mimo-v2.5 的 pro 档是纯文本，只精确命名免费/基础档
  '*mimo-v2.5',
  '*mimo-v2.5-free',
  'mimo-v2-omni*',
  'deepseek-vl*',
  'deepseek-ocr*',
  'deepseek-*vision*',
  'janus*',
  'pixtral*',
  'llama-4*',
  'llama-3.2-*vision*',
  'grok-4*',
  'grok-2-vision*',
  'internvl*',
]

/** 已知纯文本模式（保守：只收确证项；未知一律不在此列）。 */
export const TEXT_PATTERNS = [
  'deepseek-v4-pro*',
  'deepseek-v4-flash*',
  'deepseek-v3*',
  'seed-2.1-*',
  'seed-*',
  'mimo-v2.5-pro*',
  'mimo-v2-pro*',
  'minimax-m2.5*',
  'glm-4-flash*',
  'ernie-*',
  'hy3*',
]

/** 去掉厂商命名空间/前缀别名后的裸模型 id（与 modlens 同规则）。 */
export function bareModelId(id) {
  const unaliased = String(id ?? '').replace(/^~/, '')
  return unaliased.includes('/') ? unaliased.slice(unaliased.lastIndexOf('/') + 1) : unaliased
}

let overridesCache = null
function loadOverrides() {
  if (overridesCache !== null) return overridesCache
  try {
    if (existsSync(OVERRIDES_PATH)) {
      const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'))
      overridesCache = {
        image: new Set(Array.isArray(raw.image) ? raw.image.map(bareModelId) : []),
        text: new Set(Array.isArray(raw.text) ? raw.text.map(bareModelId) : []),
      }
      return overridesCache
    }
  } catch { /* 覆盖文件损坏 → 忽略，走表判定 */ }
  overridesCache = { image: new Set(), text: new Set() }
  return overridesCache
}

/**
 * 分类一个模型 id。
 * @returns {{kind:'image'|'text'|'unknown', source:'override'|'vision-pattern'|'text-pattern', matched?:string}}
 */
export function classifyModel(id) {
  const bare = bareModelId(id)
  const ov = loadOverrides()
  if (typeof bare === 'string' && bare) {
    if (ov.image.has(bare) || ov.image.has(bare.toLowerCase())) {
      return { kind: 'image', source: 'override-image' }
    }
    if (ov.text.has(bare) || ov.text.has(bare.toLowerCase())) {
      return { kind: 'text', source: 'override-text' }
    }
  }
  for (const pattern of VISION_PATTERNS) {
    if (globMatch(pattern, bare)) return { kind: 'image', source: 'vision-pattern', matched: pattern }
  }
  for (const pattern of TEXT_PATTERNS) {
    if (globMatch(pattern, bare)) return { kind: 'text', source: 'text-pattern', matched: pattern }
  }
  return { kind: 'unknown', source: 'unknown' }
}

/** 便捷布尔：该模型 id 是否判定为原生多模态（图片输入）。 */
export function isImageModelId(id) {
  return classifyModel(id).kind === 'image'
}