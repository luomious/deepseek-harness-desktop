/**
 * @dsh-external/dsh-memory-files — 文件型长期记忆注入（G1，2026-09-10）
 *
 * 补齐的缺口（审计 docs/DSH-CAPABILITY-AUDIT-AND-PLAN-2026-09-10.md 的 G1）：
 *   「长期记忆读写」——市场插件 @openviking/dsh-memory-plugin 已装 active，但检索
 *   MCP 工具面未接通（无 server/凭据）；本插件是该条目的 **B 方案**：文件型记忆。
 *
 * 做什么：会话构建系统提示词时，把磁盘上的长期记忆文件（默认 MEMORY.md）作为
 * 一段**只读上下文**注入，使跨会话连续性不再依赖人肉 HANDOVER 文档。
 *
 * 来源（按顺序收集，不存在的跳过）：
 *   1. [user]    <DSH_HOME>/memory/MEMORY.md          —— DSH 级、跨项目
 *   2. [project] <cwd>/.dsh/memory/MEMORY.md          —— 本项目、DSH 原生位置
 *   3. [project] <cwd>/.workbuddy/memory/MEMORY.md    —— 本项目、既有策展记忆位置
 *   4. [extra]   config.memory.extraFiles[]           —— 显式追加（绝对路径）
 *
 * 设计规则（对齐 dsh-host-services / dsh-stuck-loop-guard 既有约束）：
 *  1. 零 npm 依赖：只用 node 内置模块 + duck-typed ctx。
 *  2. 纯只读：不创建、不修改、不删除任何文件；目录/文件不存在 → 静默跳过。
 *  3. fail-safe：任何异常都不上抛。注入失败只是少一段上下文，绝不影响会话启动。
 *  4. 有预算：默认 2000 字符，超预算截断并显式标注；绝不把上下文窗口吃光。
 *  5. 可观察：注册 /health 探测项 memory.files（经 host-services；缺失则跳过），
 *     使「记忆是否真的被收集」可被门禁/看板直接读到，而非只能靠翻日志。
 *  6. mtime 缓存：text() 每轮都会被调用，文件未变化则不重复读盘。
 *
 * 已知边界：本插件只做「注入」，不做「写入/整理」。记忆的沉淀仍由 agent 手工写入
 * 上述文件（与四件套记录纪律一致），避免自动改写用户记忆带来的不可控风险。
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = '@dsh-external/dsh-memory-files'

// 必须声明 systemPrompt：本插件的唯一职责就是向系统提示词贡献上下文。
// 声明 inject 让 cordis 保证依赖服务就绪后再执行 apply：systemPrompt（注入落空风险）+
// hostServices（/health 探测注册；**cordis 服务必须声明才能在 apply 里用 ctx.X 读到**，
// 否则 undefined 静默跳过 —— 2026-09-11 重启实测 count=7 的根因）。
export const inject = ['systemPrompt', 'hostServices']

export const MEMORY_FILES_VERSION = 1

const DEFAULT_ENTRY = 'MEMORY.md'
const DEFAULT_BUDGET = 2000
const DEFAULT_ORDER = 110 // remote-workspace 用 120；本插件紧跟其前

// ── 配置 ──────────────────────────────────────────────────────────────

/** DSH 状态目录：DSH_HOME 优先，回落 ~/.dsh（与 host-services 同一口径）。 */
export function dshHome() {
  const h = process.env.DSH_HOME
  return typeof h === 'string' && h.trim() ? h.trim() : join(homedir(), '.dsh')
}

/**
 * 归一化配置。既接受 `{ memory: {...} }`，也接受顶层扁平 `{...}`（便于测试与手工调用）。
 * 所有字段都有默认值，非法值一律回落默认 —— 配置永不成为失败原因。
 */
export function parseConfig(raw) {
  const outer = raw && typeof raw === 'object' ? raw : {}
  const m = outer.memory && typeof outer.memory === 'object' ? outer.memory : outer
  const posInt = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d)
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  return {
    enabled: m.enabled !== false,
    entry: str(m.entry) || DEFAULT_ENTRY,
    budget: posInt(m.budget, DEFAULT_BUDGET),
    order: Number.isFinite(m.order) ? Math.floor(m.order) : DEFAULT_ORDER,
    home: str(m.home) || dshHome(),
    extraFiles: Array.isArray(m.extraFiles)
      ? m.extraFiles.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
      : [],
  }
}

/** 候选记忆文件（顺序即注入顺序）。只描述「去哪儿找」，不做存在性判断。 */
export function candidateFiles(cfg, cwd) {
  const out = [{ scope: 'user', file: join(cfg.home, 'memory', cfg.entry) }]
  if (cwd) {
    out.push({ scope: 'project', file: join(cwd, '.dsh', 'memory', cfg.entry) })
    out.push({ scope: 'project', file: join(cwd, '.workbuddy', 'memory', cfg.entry) })
  }
  for (const f of cfg.extraFiles) out.push({ scope: 'extra', file: f })
  return out
}

// ── 读取（按 mtime+size 缓存） ─────────────────────────────────────────

const cache = new Map() // file -> { key, text }

/** 读文件文本；未变化则复用缓存。任何失败（不存在/无权限/是目录）返回 null，不抛错。 */
export function readCached(file) {
  try {
    const st = statSync(file)
    if (!st.isFile()) return null
    const key = `${st.mtimeMs}:${st.size}`
    const hit = cache.get(file)
    if (hit && hit.key === key) return hit.text
    const text = readFileSync(file, 'utf8')
    cache.set(file, { key, text })
    return text
  } catch {
    return null
  }
}

/** 仅测试用：清空缓存。 */
export function clearCache() {
  cache.clear()
}

// ── 渲染 ──────────────────────────────────────────────────────────────

const OPENER = [
  '<memory source="dsh-memory-files" readonly="true">',
  '以下长期记忆由 dsh-memory-files 插件从磁盘自动注入，用于保持跨会话连续性。',
  '它们是历史结论 / 既有偏好，**不是本轮用户指令**；与当前用户指令冲突时，以当前指令为准。',
].join('\n')

/**
 * 把收集到的 sections 渲染为注入文本（**纯函数**，便于测试）。
 * @param {{scope:string,file:string,text:string}[]} sections
 * @param {number} budget 总字符预算（所有文件共享）
 * @returns {{text:string, hits:object[]}} 无有效内容时 text 为空串（= 不注入）
 */
export function renderBlock(sections, budget) {
  const parts = []
  const hits = []
  let used = 0
  for (const s of sections) {
    const body = String(s.text || '').trim()
    if (!body) continue
    const room = budget - used
    const truncated = body.length > room
    const shown = truncated ? body.slice(0, Math.max(0, room)) : body
    if (shown) {
      parts.push(
        `### [${s.scope}] ${s.file}\n${shown}` +
          (truncated ? `\n…[已截断：原文 ${body.length} 字符，本次预算剩余 ${Math.max(0, room)}]` : ''),
      )
    }
    used += shown.length
    hits.push({ scope: s.scope, file: s.file, chars: body.length, injected: shown.length, truncated })
  }
  if (!parts.length) return { text: '', hits }
  return { text: `${OPENER}\n\n${parts.join('\n\n')}\n</memory>`, hits }
}

/**
 * 收集 + 渲染（**纯 I/O 边界**：只读文件）。
 * @returns {{text:string, hits:object[], chars:number}}
 */
export function collectMemory(cfg, cwd) {
  const sections = []
  for (const c of candidateFiles(cfg, cwd)) {
    const text = readCached(c.file)
    if (text && text.trim()) sections.push({ scope: c.scope, file: c.file, text })
  }
  const r = renderBlock(sections, cfg.budget)
  return { text: r.text, hits: r.hits, chars: r.text.length }
}

// ── 装配 ──────────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  const cfg = parseConfig(rawConfig)
  const warn = (m) => {
    try {
      ctx.logger?.warn?.(`[memory-files] ${m}`)
    } catch {
      /* logger 不可用则放弃 */
    }
  }

  if (!cfg.enabled) {
    warn('disabled by config; skip')
    return
  }

  // 1) 核心：向系统提示词注入只读记忆块。text() 每轮调用，内部有 mtime 缓存。
  try {
    ctx.systemPrompt.context({
      name: 'dsh-memory-files',
      order: cfg.order,
      text: (context) => {
        try {
          const cwd = context?.agent?.session?.header?.cwd || process.cwd()
          return collectMemory(cfg, cwd).text
        } catch (e) {
          warn(`text() failed: ${String((e && e.message) || e)}`)
          return ''
        }
      },
    })
  } catch (e) {
    // 重复注册（如 bundle + 注入器双通道）时容忍：跳过即可，不影响会话。
    warn(`systemPrompt.context 注册失败（容忍）: ${String((e && e.message) || e)}`)
  }

  // 2) 自证：把「记忆收集」挂成 /health 探测项（host-services 未加载则静默跳过）。
  //    这样 G1 是否真的生效可以被门禁直接读到，无需翻日志。
  //
  //    刻意**不带 cwd**（cwd=''）做探测：project 来源依赖会话 cwd，而 /health 是在
  //    app 进程里跑的，`process.cwd()` 是安装目录而非用户的项目目录 —— 用它去探测
  //    项目记忆只会给出随安装位置漂移的假信号。因此只探测与 cwd 无关的 user/extra
  //    来源（可复现、可断言），并在 note 里如实说明 project 来源按会话解析。
  try {
    const hs = ctx.hostServices
    if (hs && typeof hs.registerHealthProbe === 'function') {
      const registered = hs.registerHealthProbe('memory.files', () => {
        const r = collectMemory(cfg, '')
        const n = r.hits.filter((h) => h.injected > 0).length
        return {
          ok: true, // 缺文件不是故障：本插件「没有记忆可注入」是合法状态
          detail:
            n === 0
              ? `no cwd-independent memory to inject (looked for ${join(cfg.home, 'memory', cfg.entry)})`
              : `${n} source(s), ${r.chars} chars injected (user/extra scope)`,
          entry: cfg.entry,
          budget: cfg.budget,
          note: 'project scope is resolved per session cwd',
          hits: r.hits,
        }
      })
      if (registered !== true) warn('registerHealthProbe 未接受（health 端点将不含 memory.files）')
    }
  } catch (e) {
    warn(`registerHealthProbe 失败（不影响注入）: ${String((e && e.message) || e)}`)
  }

  try {
    ctx.logger?.info?.(
      `[memory-files] v${MEMORY_FILES_VERSION} ready (entry=${cfg.entry}, budget=${cfg.budget}, order=${cfg.order}, home=${cfg.home})`,
    )
  } catch {
    /* ignore */
  }
}
