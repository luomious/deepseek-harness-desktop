/**
 * @dsh-external/dsh-orchestrator — 状态账本的**版本化契约**（阶段 1.0 · S1）
 *
 * 本文件是「编排状态账本」的唯一 schema 权威：它定义 v1 的形状、校验规则、迁移机制
 * 与自描述清单。它**零依赖、不碰文件系统**，因此可以在纯 node 进程里直接单测
 * （这一点是硬约束：本仓 `node_modules/@deepseek-ai` 不存在 ⇒ 任何宿主包裸导入都会
 *  让隔离测试在 `node tests/...` 下 ERR_MODULE_NOT_FOUND，2026-09-14 实测）。
 *
 * 设计原则（对齐计划书第 5 节，并为「长期运行」加固）：
 *   1. **未知键原位保留**：迁移与 patch 全程不剥离未知顶层键 —— 旧版本进程读到新版本
 *      写的文件时，不会因为「不认识」而把别人的数据抹掉。
 *   2. **不猜版本**：`version` 缺失/非整数 ⇒ invalid（fail-closed），绝不默认当成 v1；
 *      `version > 当前` ⇒ too-new，**只读**，写操作一律拒绝（保护更新版本的数据）。
 *   3. **迁移可回退**：迁移是「先铺旧值、再铺迁移器返回值」（`{...cur, ...patched}`），
 *      所以迁移器**无法意外丢键**；真正落盘迁移前由 ledger 侧先留一份旧版本备份。
 *   4. **不伪造历史**：v1 是首版，`MIGRATIONS` 为空**不是缺陷**；迁移机制由测试注入
 *      假迁移（v0→v1）证明可用，而不是在代码里编一个假的 v0。
 *
 * 证据口径：本文件的约束全部可执行验证 —— 见 `tests/plugins/orchestrator-ledger.test.mjs`。
 */
import { createHash } from 'node:crypto'

/** 当前契约版本。改动 schema 形状时必须 +1 并补一条 MIGRATIONS 迁移器。 */
export const SCHEMA_VERSION = 1

/** 四阶段流水线（可行性 → 开发 → 测试 → 评审）。 */
export const STAGE_IDS = Object.freeze(['feasibility', 'dev', 'test', 'review'])

/** 阶段状态词表。 */
export const STAGE_STATUSES = Object.freeze(['pending', 'active', 'passed', 'failed', 'blocked'])

/** 任务状态词表（对齐计划书 5.1）。 */
export const TASK_STATUSES = Object.freeze(['pending', 'running', 'blocked', 'done', 'failed'])

/** 账本顶层字段清单（自描述用；**不是白名单** —— 未知键照样保留）。 */
export const TOP_LEVEL_KEYS = Object.freeze([
  'version', 'rev', 'projectId', 'projectRoot', 'createdAt', 'updatedAt',
  'constitution', 'stages', 'tasks', 'budget',
])

/**
 * 允许经 `POST /orchestrator/ledger/patch` 修改的顶层键（写入面白名单）。
 * 其余顶层键（version/rev/projectId/createdAt…）由 ledger 引擎自己管理，不接受外部写入。
 */
export const PATCHABLE_KEYS = Object.freeze(['constitution', 'stages', 'tasks', 'budget'])

/**
 * 迁移注册表：`{ [fromVersion]: (state) => partialState }`，逐级 +1。
 *
 * 当前为空 = v1 是首版（**不伪造 v0 历史**）。新增 v2 时的写法：
 *   MIGRATIONS[1] = (s) => ({ budget: s.budget ?? { total: 0 } })
 */
export const MIGRATIONS = Object.freeze({})

/** 空账本（新建时的唯一合法初值）。 */
export function emptyState({ projectId, projectRoot, now = Date.now() } = {}) {
  const ts = Number(now) || Date.now()
  return {
    version: SCHEMA_VERSION,
    rev: 0,
    projectId: String(projectId || ''),
    projectRoot: String(projectRoot || ''),
    createdAt: ts,
    updatedAt: ts,
    constitution: null,
    stages: [],
    tasks: [],
    budget: null,
  }
}

/** 稳定 JSON（键排序）——仅用于契约哈希，不用于落盘。 */
export function canonicalJson(value) {
  const seen = new WeakSet()
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
    return out
  }
  return JSON.stringify(walk(value))
}

/**
 * 校验一份账本状态。**纯函数、绝不抛**。
 * @returns {{ok: boolean, errors: Array<{code: string, path: string, message: string}>, warnings: string[]}}
 */
export function validateState(state, { allowAnyVersion = false } = {}) {
  const errors = []
  const warnings = []
  const err = (code, path, message) => errors.push({ code, path, message })

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    err('NOT_OBJECT', '', '账本必须是 JSON 对象')
    return { ok: false, errors, warnings }
  }

  // ── 标量字段 ──────────────────────────────────────────────────────────
  if (!Number.isInteger(state.version)) {
    err('VERSION_NOT_INTEGER', 'version', 'version 必须是整数（缺失或非整数一律 invalid，不猜）')
  } else if (!allowAnyVersion && state.version !== SCHEMA_VERSION) {
    err('VERSION_MISMATCH', 'version', `version=${state.version} 与当前契约 ${SCHEMA_VERSION} 不符`)
  }
  if (!Number.isInteger(state.rev) || state.rev < 0) {
    err('REV_INVALID', 'rev', 'rev 必须是 >= 0 的整数（CAS 基线）')
  }
  if (typeof state.projectId !== 'string' || !state.projectId) {
    err('PROJECT_ID_INVALID', 'projectId', 'projectId 必须是非空字符串')
  }
  if (typeof state.projectRoot !== 'string' || !state.projectRoot) {
    warnings.push('projectRoot 为空：账本将无法自证属于哪个项目目录（可接受，但会降低可审计性）')
  }
  if (!Number.isFinite(state.createdAt)) err('CREATED_AT_INVALID', 'createdAt', 'createdAt 必须是有限数字')
  if (!Number.isFinite(state.updatedAt)) err('UPDATED_AT_INVALID', 'updatedAt', 'updatedAt 必须是有限数字')

  // ── constitution（红线文件；null 合法） ───────────────────────────────
  if (state.constitution !== null && state.constitution !== undefined) {
    if (typeof state.constitution !== 'object' || Array.isArray(state.constitution)) {
      err('CONSTITUTION_INVALID', 'constitution', 'constitution 必须是对象或 null')
    } else if (typeof state.constitution.path !== 'string' || !state.constitution.path) {
      err('CONSTITUTION_PATH_INVALID', 'constitution.path', 'constitution.path 必须是非空字符串')
    }
  }

  // ── stages ───────────────────────────────────────────────────────────
  if (!Array.isArray(state.stages)) {
    err('STAGES_NOT_ARRAY', 'stages', 'stages 必须是数组')
  } else {
    const ids = new Set()
    state.stages.forEach((s, i) => {
      const p = `stages[${i}]`
      if (!s || typeof s !== 'object' || Array.isArray(s)) return err('STAGE_NOT_OBJECT', p, '阶段必须是对象')
      if (typeof s.id !== 'string' || !s.id) return err('STAGE_ID_INVALID', `${p}.id`, '阶段 id 必须是非空字符串')
      if (ids.has(s.id)) err('STAGE_DUPLICATE', `${p}.id`, `阶段 id 重复：${s.id}`)
      ids.add(s.id)
      if (s.status !== undefined && !STAGE_STATUSES.includes(s.status)) {
        err('STAGE_STATUS_INVALID', `${p}.status`, `阶段状态非法：${String(s.status)}（允许 ${STAGE_STATUSES.join('|')}）`)
      }
    })
  }

  // ── tasks（含引用完整性与环检测） ────────────────────────────────────
  if (!Array.isArray(state.tasks)) {
    err('TASKS_NOT_ARRAY', 'tasks', 'tasks 必须是数组')
  } else {
    const taskIds = new Set()
    state.tasks.forEach((t, i) => {
      const p = `tasks[${i}]`
      if (!t || typeof t !== 'object' || Array.isArray(t)) return err('TASK_NOT_OBJECT', p, '任务必须是对象')
      if (typeof t.id !== 'string' || !t.id) return err('TASK_ID_INVALID', `${p}.id`, '任务 id 必须是非空字符串')
      if (taskIds.has(t.id)) err('TASK_DUPLICATE', `${p}.id`, `任务 id 重复：${t.id}`)
      taskIds.add(t.id)
      if (t.status !== undefined && !TASK_STATUSES.includes(t.status)) {
        err('TASK_STATUS_INVALID', `${p}.status`, `任务状态非法：${String(t.status)}`)
      }
      if (t.dependsOn !== undefined) {
        if (!Array.isArray(t.dependsOn)) {
          err('TASK_DEPS_NOT_ARRAY', `${p}.dependsOn`, 'dependsOn 必须是数组')
        } else {
          t.dependsOn.forEach((d, j) => {
            if (typeof d !== 'string' || !d) err('TASK_DEP_INVALID', `${p}.dependsOn[${j}]`, '依赖项必须是非空字符串')
          })
        }
      }
    })
    // 引用完整性：依赖必须指向存在的任务
    state.tasks.forEach((t, i) => {
      if (!t || typeof t !== 'object' || !Array.isArray(t.dependsOn)) return
      for (const d of t.dependsOn) {
        if (typeof d === 'string' && d && !taskIds.has(d)) {
          err('DEP_UNKNOWN', `tasks[${i}].dependsOn`, `依赖的任务不存在：${d}`)
        }
      }
    })
    // 环检测（否则长项目会出现「互相等待、永不推进」的死锁，且只在运行期才暴露）
    const cycle = findDependencyCycle(state.tasks, taskIds)
    if (cycle) err('DEP_CYCLE', 'tasks', `依赖成环：${cycle.join(' → ')}`)
  }

  // ── budget ───────────────────────────────────────────────────────────
  if (state.budget !== null && state.budget !== undefined) {
    if (typeof state.budget !== 'object' || Array.isArray(state.budget)) {
      err('BUDGET_INVALID', 'budget', 'budget 必须是对象或 null')
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 迭代式 DFS 找出一处依赖环（返回环上的 id 列表；无环返回 null）。 */
function findDependencyCycle(tasks, knownIds) {
  const graph = new Map()
  for (const t of tasks) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string') continue
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => typeof d === 'string' && knownIds.has(d)) : []
    graph.set(t.id, deps)
  }
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]))
  for (const root of graph.keys()) {
    if (color.get(root) !== WHITE) continue
    const stack = [{ id: root, path: [root] }]
    color.set(root, GREY)
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const deps = graph.get(frame.id) || []
      const next = deps.find((d) => color.get(d) === GREY)
      if (next !== undefined) {
        const at = frame.path.indexOf(next)
        return [...frame.path.slice(at >= 0 ? at : 0), next]
      }
      const unvisited = deps.find((d) => color.get(d) === WHITE)
      if (unvisited !== undefined) {
        color.set(unvisited, GREY)
        stack.push({ id: unvisited, path: [...frame.path, unvisited] })
        continue
      }
      color.set(frame.id, BLACK)
      stack.pop()
    }
  }
  return null
}

/**
 * 逐级迁移到目标版本。
 *
 * 关键保证：`{...cur, ...patched}` —— 迁移器只提供「要改的键」，**未提及的键（含未知键）
 * 一律原样保留**，因此迁移在物理上不可能静默抹掉别人的数据。
 *
 * @returns {{ok: true, state: object, from: number, to: number, applied: Array<{from:number,to:number}>}
 *          | {ok: false, code: string, from?: number, at?: number, applied?: any[], errors?: any[], error?: string}}
 */
export function migrate(state, { migrations = MIGRATIONS, target = SCHEMA_VERSION } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, code: 'NOT_OBJECT' }
  if (!Number.isInteger(state.version)) return { ok: false, code: 'VERSION_MISSING' }
  const from = state.version
  if (from > target) return { ok: false, code: 'TOO_NEW', from }
  const applied = []
  let cur = state
  let v = from
  while (v < target) {
    const step = migrations[v]
    if (typeof step !== 'function') return { ok: false, code: 'MIGRATION_MISSING', from, at: v, applied }
    let patched
    try {
      patched = step({ ...cur })
    } catch (e) {
      return { ok: false, code: 'MIGRATION_THREW', from, at: v, applied, error: String((e && e.message) || e) }
    }
    if (patched && typeof patched === 'object' && !Array.isArray(patched)) {
      cur = { ...cur, ...patched, version: v + 1 }
    } else {
      cur = { ...cur, version: v + 1 }
    }
    applied.push({ from: v, to: v + 1 })
    v += 1
  }
  const check = validateState(cur)
  if (!check.ok) return { ok: false, code: 'MIGRATION_INVALID', from, to: target, applied, errors: check.errors }
  return { ok: true, state: cur, from, to: target, applied }
}

/**
 * 自描述清单。`GET /orchestrator/contract` 直接返回它，测试用它防「契约漂移」
 * （端点上看到的 version 必须等于本模块的 SCHEMA_VERSION）。
 */
export function describeContract() {
  const body = {
    version: SCHEMA_VERSION,
    topLevelKeys: [...TOP_LEVEL_KEYS],
    patchableKeys: [...PATCHABLE_KEYS],
    stageIds: [...STAGE_IDS],
    stageStatuses: [...STAGE_STATUSES],
    taskStatuses: [...TASK_STATUSES],
    migrations: Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b).map((from) => ({ from, to: from + 1 })),
    rules: [
      'version 缺失或非整数 ⇒ invalid（fail-closed，不猜版本）',
      'version > 当前 ⇒ too-new：可读、拒绝一切写操作',
      'version < 当前 ⇒ 逐级迁移；落盘前先备份旧版本文件',
      '未知顶层键原位保留（迁移与 patch 均不剥离）',
      '全部写入经 rev CAS：expectRev 不匹配 ⇒ STALE_BASE，不落盘',
    ],
  }
  return { ...body, contractHash: createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 16) }
}
