/**
 * @dsh-external/dsh-orchestrator — host 侧（阶段 1-A 快速壳 + 阶段 1.0 · S1 状态账本）
 *
 * 两件事：
 *   1. 把「内核里现在有哪些 agent 活着」以只读 JSON 暴露给本机 Web GUI（阶段 1-A）。
 *   2. 提供**状态账本**的读写端点：版本化契约（`./contract.js`）+ 原子落盘引擎（`./ledger.js`）。
 *      账本是后续所有阶段（派活 / 门禁 / 预算 / 工作台）的唯一真相，S1 只交付「账本 + 契约」，
 *      **不派活、不接 session.list、不做 UI、不接健康探测、不做轮转归档**（分别属 S2/S3/S4）。
 *
 * 设计约束（对齐本仓 AGENTS.md 与既有插件范式）：
 *   1. 零运行时依赖、**inject 留空**、所有服务走 ctx.reflect.get() 惰性解析（见下方 inject 注释）。
 *      ⚠ 本轮加固：新增的 contract/ledger 也是零依赖（仅 node: 内建），因此可在纯 node 进程里
 *      直接隔离测试 —— 本仓 `node_modules/@deepseek-ai` 不存在，任何宿主包裸导入都会让
 *      `node tests/...` 直接 ERR_MODULE_NOT_FOUND（2026-09-14 实测）。
 *   2. 不猜内核 agent 对象的具体字段名：只投影「浅层 JSON 安全原始值」（含嵌套 session）。
 *   3. 仅回环（loopback）可访问；非本机一律 403。读端点无副作用；写端点受白名单 + CAS 保护。
 *   4. 任何异常都不拖垮 harness：每个 handler 全包 try/catch，失败返回 ok:false。
 *   5. **绝不回退到 process.cwd()**：宿主进程 cwd 是安装目录，不是用户工作区（本仓既有实测）。
 *      项目根只认「显式 project 参数」或「存活 agent 的 session.header.cwd」，否则明确拒绝。
 *
 * ⚠ 两个已实测的坑（2026-09-14，均已在下面注释交代）：
 *   - 直写 `ctx.setTimeout` 会抛 `cannot get property "timer" without inject`，令整个
 *     loader entry 创建失败；声明 inject 也救不了，必须走 reflect。
 *   - DSH loader **会缓存模块**：同一路径的模块在同一进程内不会因改盘而重新求值，
 *     所以改完代码后必须重启（或换路径）才能生效 —— 本次因此连错 5 轮。
 *
 * 端点（全部仅回环；写端点见 ledger.js 的 CAS/白名单语义）：
 *   GET  /orchestrator/ping          → { ok, plugin, stage, ts }
 *   GET  /orchestrator/state         → { ok, ts, agentCount, runningCount, agents[], error }
 *   GET  /orchestrator/contract      → 契约自描述 + 目录 fsync 能力**实测值** + 上限
 *   GET  /orchestrator/ledger        → 账本视图（status/rev/sha256/备份清单；损坏如实报 degraded）
 *   POST /orchestrator/ledger/init   → 幂等创建（已存在**不覆盖**）
 *   POST /orchestrator/ledger/patch  → { expectRev, patch } 白名单浅合并 + CAS 原子写
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { SCHEMA_VERSION, PATCHABLE_KEYS, describeContract } from './contract.js'
import { judge, capsFor } from './judge.js'
import { plan as buildPlan, validate as validatePlan, nextRound as nextPlanRound } from './plan.js'
import { roleSpec, subagentRequest } from './roles.js'
import { evaluateNode, gateVerdict } from './gate.js'
import { runPlan } from './scheduler.js'
import {
  runsRoot, runDirFor, saveRun, loadRun, listRuns, readRunFile, toClientRun, progressOf,
  writeNodeBrief, writeNodeResult, appendNodeLog, saveGate, saveDeliverable, hashFiles, diffHashes,
} from './run.js'
import {
  DEFAULT_LIMITS, stateFileFor, readState, updateState, applyPatch, listBackups, probeDirFsync,
} from './ledger.js'

export const name = '@dsh-external/dsh-orchestrator'

// inject 故意留空 —— 2026-09-14 实测（两次失败 + 一次对照）：
//   在 loader.create（运行时注入 dev_install_package）这条路径上，**声明服务反而让
//   loader entry 创建失败**，报 `cannot get property "<svc>" without inject`：
//     v1: inject=['webServer']             + 直写 ctx.setTimeout  → 失败
//     v2: inject=['timer','webServer']     + 去掉所有直接访问     → 仍失败
//   去掉服务声明、全部改走 ctx.reflect.get() 惰性解析后才加载成功。
//   与 dsh-session-hygiene 注释里的结论一致（"loader stage throws ... for ANY new entry"）。
// 代价：路由注册需要自已重试（见 apply 末尾的退避重试 + registerRoute 幂等）。
export const inject = []

const DEFAULT_CONFIG = {
  routePrefix: '/orchestrator',
  maxAgents: 64,
  maxKeys: 16,
  logFile: '',
  stateDir: '', // 空 = <DSH_HOME>/orchestration
  maxBodyBytes: 64 * 1024,
}

/** 路由表（同时用于 405 判定与 /contract 自描述，避免文档与实现漂移）。 */
const ENDPOINTS = {
  '/ping': { methods: ['GET'], desc: '路由存活探针' },
  '/state': { methods: ['GET'], desc: '存活 agent 只读快照（浅层 JSON 安全原始值，兼作 schema 探针）' },
  '/contract': { methods: ['GET'], desc: '账本契约自描述 + 目录 fsync 能力实测值 + 上限' },
  '/ledger': { methods: ['GET'], desc: '读账本（status/rev/sha256/备份清单；损坏如实报 degraded）' },
  '/ledger/init': { methods: ['POST'], desc: '幂等创建账本（已存在不覆盖）' },
  '/ledger/patch': { methods: ['POST'], desc: '白名单浅合并 + rev CAS 的原子写' },
  '/runs': { methods: ['GET'], desc: 'P1：本项目的历史编排运行摘要（倒序，最多 limit 条）' },
  '/run': { methods: ['GET'], desc: 'P1：单次运行详情，形状 = 客户端契约（/run/<runId>?project=<path>）' },
}

/** 回环地址判定（与 dsh-task-scheduler 同口径）。 */
function isLoopback(addr) {
  if (!addr) return false
  const a = String(addr)
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.')
}

/** 统一 JSON 应答（写完即止，二次写被吞）。 */
function json(res, code, body) {
  try {
    if (res.writableEnded) return
    const text = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(text)
  } catch {
    try { res.end() } catch { /* noop */ }
  }
}

/** 读请求体（有上限；与 dsh-task-scheduler 同范式：UTF-8 + 结构化错误码）。 */
function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        settled = true
        reject(Object.assign(new Error(`请求体超过 ${maxBytes} 字节`), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolveBody({})
      try { resolveBody(JSON.parse(raw)) } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }))
      }
    })
    req.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
  })
}

function parseQuery(url) {
  const out = {}
  try {
    for (const [k, v] of new URLSearchParams(String(url || '').split('?')[1] || '')) out[k] = v
  } catch { /* 非法 query 视为空 */ }
  return out
}

/**
 * 浅层 JSON 安全投影：只保留 string/number/boolean/null 这类原始值。
 * 不递归对象/数组（避免把内核内部结构序列化出去），不假设具体字段名。
 */
function shallowPrimitives(obj, maxKeys) {
  const out = {}
  if (obj === null || obj === undefined) return out
  if (typeof obj !== 'object' && typeof obj !== 'function') return out
  let n = 0
  let keys
  try { keys = Object.keys(obj) } catch { return out }
  for (const k of keys) {
    if (n >= maxKeys) break
    let v
    try { v = obj[k] } catch { continue }
    const t = typeof v
    if (v === null || t === 'string' || t === 'number' || t === 'boolean') {
      out[k] = v
      n += 1
    }
  }
  return out
}

/** 取第一个非空原始值（用于少量众所周知的别名，纯 best-effort）。 */
function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined
  let v
  try { v = obj[key] } catch { return undefined }
  const t = typeof v
  return v === null || t === 'string' || t === 'number' || t === 'boolean' ? v : undefined
}

/** 把一个内核 agent 对象投影成可安全渲染的一行。 */
function describeAgent(agent, index) {
  const session = (() => {
    try { return agent && agent.session } catch { return undefined }
  })()
  // session.header 是内核 validateSessionHeader 校验过的 deepFreeze 平 JSON 记录
  // （dsh-session/lib/types/index.js:30-65）⇒ 读它完全安全，不会抛。
  const header = (() => {
    try { return session && session.header } catch { return undefined }
  })()
  const agentFields = shallowPrimitives(agent, 16)
  const sessionFields = shallowPrimitives(session, 16)
  const headerFields = shallowPrimitives(header, 24)
  const row = {
    index,
    // 字段名按内核 schema 定稿（2026-09-14 重启后实测修正）：
    //   header = { version, id, createdAt, cwd?, parentSession?, seedLength?,
    //              origin?('subagent'), delegationDepth?, agentPreset? }
    // 注意是 **parentSession**（不是 parentSessionId）。
    sessionId: pick(header, 'id') ?? pick(agent, 'id') ?? null,
    createdAt: pick(header, 'createdAt') ?? null,
    cwd: pick(header, 'cwd') ?? null,
    origin: pick(header, 'origin') ?? null,
    parentSessionId: pick(header, 'parentSession') ?? null,
    delegationDepth: pick(header, 'delegationDepth') ?? null,
    agentPreset: pick(header, 'agentPreset') ?? null,
    // ⚠ title 来自 session/title **事件**、running 来自 host/session-status **流**：
    // 两者都**不在** header 里。本阶段不猜、不伪报（预期为 null），留给阶段 1 走
    // session.list RPC 与事件流；best-effort 取值保留，以便内核将来把它们放进 header。
    title: pick(header, 'title') ?? pick(session, 'title') ?? pick(agent, 'title') ?? null,
    running: pick(header, 'running') ?? pick(session, 'running') ?? pick(agent, 'running') ?? null,
    agentFields,
    sessionFields,
    headerFields,
  }
  return row
}

/** 惰性解析 cordis 服务（ctx 代理优先，ctx.reflect 兜底）。 */
function resolveService(ctx, svcName) {
  try {
    const d = ctx[svcName]
    if (d !== undefined && d !== null) return d
  } catch { /* next */ }
  try { return ctx.reflect?.get(svcName) } catch { /* next */ }
  return undefined
}

/** 组装一次快照（纯只读，绝不抛）。 */
function snapshot(ctx, config) {
  const agentsSvc = resolveService(ctx, 'agents')
  const avail = !!(agentsSvc && typeof agentsSvc.list === 'function')
  let agents = []
  let error = null
  if (!avail) {
    error = 'agents service unavailable (ctx.agents.list is not a function)'
  } else {
    try {
      const list = agentsSvc.list()
      const arr = Array.isArray(list) ? list : []
      agents = arr.slice(0, config.maxAgents).map((a, i) => describeAgent(a, i))
      if (arr.length > config.maxAgents) error = `truncated: ${arr.length} agents, showing ${config.maxAgents}`
    } catch (e) {
      error = 'agents.list() failed: ' + String((e && e.message) || e)
    }
  }
  let runningCount = 0
  for (const a of agents) if (a.running === true) runningCount += 1
  return {
    ok: true,
    plugin: name,
    stage: 'stage-1A',
    ts: Date.now(),
    agentsAvailable: avail,
    agentCount: agents.length,
    runningCount,
    agents,
    error,
  }
}

/** 从存活 agent 的 session.header.cwd 推导项目根（多数派；同数按路径字典序，保证确定性）。 */
function projectFromAgents(ctx) {
  const agentsSvc = resolveService(ctx, 'agents')
  if (!agentsSvc || typeof agentsSvc.list !== 'function') return null
  let list
  try { list = agentsSvc.list() } catch { return null }
  const counts = new Map()
  for (const a of (Array.isArray(list) ? list : [])) {
    let cwd
    try { cwd = a && a.session && a.session.header && a.session.header.cwd } catch { cwd = undefined }
    if (typeof cwd === 'string' && cwd) counts.set(cwd, (counts.get(cwd) || 0) + 1)
  }
  if (!counts.size) return null
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0][0]
}

/**
 * 解析本次请求的「项目根」。
 * **绝不回退到 process.cwd()**：宿主进程 cwd 是安装目录（打包后 dist\win-unpacked），
 * 把账本写到那里会给出随安装位置漂移的假信号，且用户根本找不到。
 */
function resolveProject(ctx, query, body) {
  const raw = (body && body.project !== undefined && body.project !== null)
    ? body.project
    : (query && query.project)
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const text = String(raw).trim()
    const abs = resolve(text)
    let st
    try {
      st = statSync(abs)
    } catch (e) {
      return { ok: false, code: 'PROJECT_INVALID', error: `project 不存在或不可访问：${text}（${String((e && e.code) || '')}）` }
    }
    if (!st.isDirectory()) return { ok: false, code: 'PROJECT_INVALID', error: `project 不是目录：${text}` }
    return { ok: true, projectRoot: abs, source: 'explicit' }
  }
  const derived = projectFromAgents(ctx)
  if (derived) {
    try {
      if (statSync(derived).isDirectory()) return { ok: true, projectRoot: resolve(derived), source: 'agents' }
    } catch { /* 推导出的路径不在了：继续往拒绝走 */ }
  }
  return {
    ok: false,
    code: 'PROJECT_REQUIRED',
    error: '未提供 project，且无法从存活 agent 的 session.header.cwd 推导（不回退 process.cwd()）',
  }
}

/** 把 ledger 引擎的错误码映射为 HTTP 状态码（写面语义集中在此，便于审阅）。 */
function statusForLedgerError(code) {
  switch (code) {
    case 'STALE_BASE': return 409
    case 'STATE_INVALID': return 422
    case 'EXPECT_REV_INVALID': return 400
    case 'LEDGER_NOT_WRITABLE': return 503
    default: return 500
  }
}

/**
 * 从 subagent 的返回值里取**结构化对象**。
 * 2026-09-14 内核源码实证（此前为"未验证"，现已定死）：
 *   结构化结果挂在 `run.result.structured`——`dsh-subagent-in-process-driver/lib/index.js:228-239`
 *   的 `readResult`：`if (structured.captured !== void 0) return { output, structured: captured.value, stopReason }`。
 *   机制：内核给带 outputSchema 的子代理注入 `structured_output` 工具（L20）+ order-190 提示段（L26）；
 *   子代理必须调用该工具收尾，**没调用就完成 ⇒ stopReason 变 error**（L240-243），由调度器重试 + G8 兜底。
 *   下面的多候选宽容取保留为防御（万一内核未来改字段名），但第一候选已是实证路径。
 */
function structuredOf(result) {
  if (!result || typeof result !== 'object') return null;
  for (const k of ['structured', 'value', 'outputSchemaValue', 'data']) {
    if (result[k] !== undefined && result[k] !== null && typeof result[k] === 'object') return result[k];
  }
  if (Array.isArray(result.output)) {
    const text = result.output.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (text) {
      try { return JSON.parse(text); } catch (e) { return null; }
    }
  }
  return null;
}

/** 拿不到结构化结果时，把原始返回压成可读证据（写进 result.json，便于事后追责）。 */
function describeResult(result) {
  if (!result) return null;
  if (Array.isArray(result.output)) {
    return result.output.filter((b) => b && b.type === 'text').map((b) => String(b.text).slice(0, 2000)).join('\n').slice(0, 4000);
  }
  try { return JSON.stringify(result).slice(0, 4000); } catch (e) { return String(result).slice(0, 4000); }
}

/**
 * 把任意抛出物压成**可落盘的诊断证据**（message + 栈前 500 字 + code）。
 * 2026-09-15 补：此前 dispatch 抛错只被调度器记进内存 `node.error`，而 `toClientRun` 不投影该字段
 * ⇒ 错误**既不落盘也不进工具输出**；实测代价是 e2e 失败后只能"猜根因"。
 */
function describeError(err) {
  const message = String((err && err.message) || err || 'unknown error');
  const stack = String((err && err.stack) || '').slice(0, 500);
  const code = err && err.code ? String(err.code) : null;
  return { message, stack, code };
}

/**
 * 取「发起会话」的 id（真实内核形状：agent.session.header.id；缺失时退回 agent.id）。
 * 为什么必须落盘：同一项目下的多条对话共享 projectId，GET /orchestrator/runs?project= 会返回**所有**对话的运行；
 * 客户端只有拿到发起会话 id 才能只显示「本对话那条」（否则会串台）。
 */
function sessionIdOf(agent) {
  if (!agent || typeof agent !== 'object') return null;
  let header;
  try { header = agent.session && agent.session.header; } catch { header = undefined; }
  const fromHeader = header && typeof header.id === 'string' && header.id ? header.id : null;
  if (fromHeader) return fromHeader;
  let id;
  try { id = agent.id; } catch { id = undefined; }
  return typeof id === 'string' && id ? id : null;
}

/**
 * `orchestrate` 工具的实现：判定 → 规划 → 校验 → 角色化派发 → 门禁 → 落盘。
 * 全程**代码调度**（不靠提示词自律），每一步都落盘（崩溃可恢复、事后可审计）。
 */
async function runOrchestration(ctx, args, exec, config, log) {
  const task = String((args && args.task) || '').trim();
  const judged = judge(task);
  if (!task) return { mode: 'solo', reason: '任务为空：没有做任何事（也不派活）', status: 'refused' };
  if (judged.mode === 'solo') {
    return {
      mode: 'solo',
      reason: judged.reason,
      status: 'solo',
      acceptance: [],
      summaryText: '判定为 solo：**不拆**。直接由当前 agent 完成即可（multi-agent 约 15× token，不值得）。'
    };
  }

  const proj = resolveProject(ctx, args && args.project ? { project: args.project } : {}, null);
  if (!proj.ok) {
    return { mode: 'team', reason: `无法确定项目根：${proj.error}`, status: 'refused', blocked: [proj.code] };
  }
  const projectRoot = proj.projectRoot;

  let p = buildPlan(task, judged, { now: Date.now() });
  if (args && typeof args.maxAgents === 'number') {
    p.caps = Object.assign({}, p.caps, { agentsHard: Math.max(1, Math.min(6, Math.floor(args.maxAgents))) });
  }
  const verdict = validatePlan(p, { maxAgents: p.caps.agentsHard });
  if (!verdict.ok) {
    log(`orchestrate refused by validate: ${verdict.blockers.map((b) => b.code).join(',')}`);
    return {
      mode: 'team',
      reason: '计划被**代码**校验拒绝（模型只能提议，代码才批准）',
      status: 'refused',
      blocked: verdict.blockers.map((b) => b.code),
      acceptance: p.acceptance.map((a) => `${a.id}: ${a.text}`)
    };
  }

  const subagents = resolveService(ctx, 'subagents');
  const parent = exec && exec.agent;
  // 来源会话：客户端据此只显示「本对话」的运行（同一项目下多对话共享 projectId，否则会串台）
  p.sessionId = sessionIdOf(parent);
  p.status = 'running';
  p.startedAt = Date.now();
  const persist = () => { try { saveRun(projectRoot, toClientRun(p, { status: p.status })) } catch (e) { log(`saveRun failed: ${String(e)}`) } };
  persist();

  // G5：以"开发声称改动过的文件"为观察集，只读节点前后比 hash（成本可控，不扫全仓库）
  const watch = new Set();
  let beforeHashes = {};
  // 已完成的节点 id（G6 用它判断"交付项引用的来源是否真的在上游存在"）
  const doneIds = new Set();
  // 最近一次派发失败的根因（node.error 为空时的兜底露出手段）
  let lastDispatchError = null;

  // 派发包装：**任何**抛出都要留痕（但**不吞**——错误照常交回调度器重试/记 failed）。
  // 这是"根因可诊断"的唯一来源：调度器只把错误写进内存 node.error 并重试，不落盘就等于丢失。
  const dispatch = async (node, nodeCtx) => {
    try {
      return await dispatchOnce(node, nodeCtx);
    } catch (err) {
      const d = describeError(err);
      lastDispatchError = d.message;
      appendNodeLog(projectRoot, p.runId, node.id, {
        at: Date.now(), type: 'dispatch-error', round: nodeCtx.round, attempt: nodeCtx.attempt,
        message: d.message, code: d.code, stack: d.stack,
      });
      try { persist(); } catch { /* 落盘失败不能掩盖原始错误 */ }
      throw err;
    }
  };

  const dispatchOnce = async (node, nodeCtx) => {
    const spec = roleSpec(node.role);
    const briefFile = writeNodeBrief(projectRoot, p, node);
    appendNodeLog(projectRoot, p.runId, node.id, { at: Date.now(), type: 'brief-written', round: nodeCtx.round, file: briefFile.file });
    if (spec.writable !== true && watch.size > 0) beforeHashes = hashFiles(projectRoot, Array.from(watch));
    if (!subagents || typeof subagents.start !== 'function') throw new Error('subagents 服务不可用：无法派发角色 ' + node.role);
    const request = subagentRequest(node.role, {
      parent,
      prompt: briefFile.text,
      label: `${p.runId}:${node.id}`,
      maxDepth: p.caps.depth,
      signal: nodeCtx && nodeCtx.signal
    });
    const run = await subagents.start('spawn', request);
    const raw = run && run.result ? await run.result : run;
    const structured = structuredOf(raw);
    writeNodeResult(projectRoot, p.runId, node.id, structured || { malformed: true, raw: describeResult(raw) });
    appendNodeLog(projectRoot, p.runId, node.id, { at: Date.now(), type: 'result', round: nodeCtx.round, structured: !!structured });
    // 开发声称改动过的文件 ⇒ 加入观察集（供后续只读节点的 G5 判定）
    if (spec.writable === true && structured && Array.isArray(structured.changes)) {
      for (const c of structured.changes) if (c && typeof c.path === 'string' && c.path) watch.add(c.path);
    }
    let tampered = null;
    if (spec.writable !== true && watch.size > 0) {
      const after = hashFiles(projectRoot, Array.from(watch));
      tampered = diffHashes(beforeHashes, after);
      if (tampered.length > 0) appendNodeLog(projectRoot, p.runId, node.id, { at: Date.now(), type: 'tamper-detected', files: tampered });
    }
    return { result: structured, artifacts: 1, __tampered: tampered };
  };

  const result = await runPlan(p, {
    concurrency: p.caps.concurrency,
    retries: p.caps.retries,
    maxRounds: p.maxRounds,
    nodeTimeoutMs: config.orchestrateNodeTimeoutMs || 10 * 60 * 1000,
    maxWallClockMs: config.orchestrateMaxWallClockMs || 30 * 60 * 1000,
    signal: exec && exec.signal,
    nextRound: nextPlanRound,
    dispatch,
    onEvent: (evt) => {
      if (evt.type === 'node-end' && evt.status === 'done') doneIds.add(evt.nodeId);
      if (evt.type === 'node-start' || evt.type === 'node-end' || evt.type === 'round-start' || evt.type === 'run-end') {
        const node = p.nodes.find((n) => n.id === evt.nodeId);
        if (node && evt.status) node.status = evt.status;
        if (evt.type === 'round-start') p.round = evt.round;
        persist();
      }
    },
    evaluate: (node, outcome) => {
      const structured = outcome && outcome.result;
      // 注意：不要从 `p` 读状态做判据（调度器可能持有的是另一个对象）；用事件累计的 doneIds
      const g = evaluateNode(node, structured, { tampered: outcome && outcome.__tampered, upstreamFacts: Array.from(doneIds) });
      if (!g.ok) {
        appendNodeLog(projectRoot, p.runId, node.id, { at: Date.now(), type: 'gate-rejected', blockers: g.blockers });
        // G8（协议违背：子代理没调 structured_output / 回报缺字段）重试有意义——再采样一次
        // 也许就合规了；G1-G7 是"事实不满足"，代码没变，重跑只会烧钱 ⇒ blocked 走修复循环。
        const isProtocol = g.blockers.length > 0 && g.blockers.every((b) => b.code === 'G8_MALFORMED_RESULT');
        return { ok: false, blockers: g.blockers, status: isProtocol ? 'failed' : 'blocked' };
      }
      return { ok: true };
    }
  });

  p = result.plan;
  p.status = result.status;
  p.endedAt = result.endedAt;
  // 调度器摘要（峰值并发 / 墙钟 / 节点计数 / 轮次）必须落盘：
  // 否则进程一结束，"这台机器能不能带动这么多 agent"就再也没有数据支撑。
  p.summary = result.summary || null;
  const blockedNodes = p.nodes.filter((n) => n.status === 'blocked');
  const gate = gateVerdict(p, blockedNodes);
  p.gate = gate.status;
  saveGate(projectRoot, p.runId, gate);
  const synth = p.nodes.find((n) => n.role === 'synth' && n.status === 'done');
  if (synth) {
    try {
      const file = join(runDirFor(projectRoot, p.runId), 'nodes', synth.id, 'result.json');
      const read = readRunFile(file);
      const structured = read && read.status === 'ok' ? read.state : null;
      const text = structured && typeof structured.summary === 'string' ? structured.summary : null;
      if (text) saveDeliverable(projectRoot, p.runId, text);
    } catch (e) {
      // 交付文件是尽力而为：run.json 与各节点的 result.json 才是权威证据
    }
  }
  // 失败节点的根因（scheduler 写在 node.error 上；现已由 toClientRun 落盘）
  const nodeErrors = p.nodes
    .filter((n) => typeof n.error === 'string' && n.error)
    .map((n) => `${n.id}（${n.role}）: ${n.error}`);
  if (nodeErrors.length === 0 && lastDispatchError) nodeErrors.push(`派发阶段: ${lastDispatchError}`);
  // 工具输出的 summary 只放**已声明**的原始值字段（schema 是 additionalProperties:false 的封闭形状）
  const summaryOut = p.summary ? {
    status: String(p.summary.status || ''),
    round: Number(p.summary.round) || 1,
    roundsUsed: Number(p.summary.roundsUsed) || 1,
    maxRounds: Number(p.summary.maxRounds) || 1,
    peakConcurrency: Number(p.summary.peakConcurrency) || 0,
    wallClockMs: Number(p.summary.wallClockMs) || 0,
    lastRoundReason: typeof p.summary.lastRoundReason === 'string' ? p.summary.lastRoundReason : ''
  } : null;

  persist();
  log(`orchestrate done: run=${p.runId} status=${p.status} gate=${gate.status} round=${p.round} nodes=${p.nodes.length}`);

  return {
    mode: 'team',
    reason: judged.reason,
    runId: p.runId,
    status: p.status,
    round: p.round,
    gate: gate.status,
    blocked: gate.blockers.map((b) => `${b.node}/${b.code}`),
    acceptance: p.acceptance.map((a) => `${a.id}: ${a.text}`),
    nodes: p.nodes.map((n) => ({
      id: n.id,
      role: n.role,
      status: n.status,
      ms: typeof n.ms === 'number' ? Math.round(n.ms) : 0,
      retry: n.retry || 0,
      note: n.title
    })),
    ...(summaryOut ? { summary: summaryOut } : {}),
    summaryText: [
      `运行记录：\`${runDirFor(projectRoot, p.runId)}\``,
      `门禁：**${gate.status}**${gate.blockers.length ? '（' + gate.blockers.map((b) => b.code).join('、') + '）' : ''}`,
      p.summary ? `容量：并发峰值 ${p.summary.peakConcurrency} · 墙钟 ${(Number(p.summary.wallClockMs) / 1000).toFixed(1)}s · 轮次 ${p.summary.roundsUsed}/${p.summary.maxRounds}` : '',
      nodeErrors.length ? `失败原因：${nodeErrors.join('；')}` : '',
      p.status === 'blocked' ? '已达修复轮次上限 ⇒ 转人工：请看上面未通过项。' : ''
    ].filter(Boolean).join('\n')
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', 'dsh-orchestrator.log')
  const stateDir = config.stateDir || join(dshHome, 'orchestration')

  const log = (msg) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`)
    } catch { /* 日志失败静默 */ }
  }

  // ── 端点实现 ────────────────────────────────────────────────────────

  const handleContract = () => ({
    ok: true,
    plugin: name,
    stage: 'S1',
    ts: Date.now(),
    contract: describeContract(),
    stateDir,
    // 目录 fsync 能力是**探测值**（win32 实测 EPERM ⇒ supported:false），不是平台假设
    dirFsync: probeDirFsync(stateDir),
    limits: { ...DEFAULT_LIMITS, maxBodyBytes: config.maxBodyBytes },
    endpoints: Object.entries(ENDPOINTS).map(([p, v]) => ({ path: config.routePrefix + p, methods: v.methods, desc: v.desc })),
  })

  const handleLedgerGet = (query) => {
    const proj = resolveProject(ctx, query, null)
    if (!proj.ok) return { code: 400, body: { ok: false, code: proj.code, error: proj.error } }
    const loc = stateFileFor(proj.projectRoot, { stateDir })
    const r = readState(loc.path)
    const healthy = r.status === 'ok' || r.status === 'absent'
    return {
      code: 200,
      body: {
        ok: healthy,
        status: r.status,
        code: r.code ?? null,
        error: r.error ?? null,
        errors: r.errors ?? null,
        warnings: r.warnings ?? null,
        path: loc.path,
        stateDir,
        projectId: loc.projectId,
        projectRoot: proj.projectRoot,
        projectSource: proj.source,
        version: r.version ?? r.currentVersion ?? null,
        currentVersion: SCHEMA_VERSION,
        rev: r.rev ?? null,
        migratedFrom: r.migratedFrom ?? null,
        sha256: r.sha256 ?? null,
        bytes: r.bytes ?? null,
        mtimeMs: r.mtimeMs ?? null,
        backup: r.backup ?? null,
        backups: listBackups(loc.path),
        fsync: { dir: probeDirFsync(dirname(loc.path)) },
        ts: Date.now(),
      },
    }
  }

  const handleInit = async (body) => {
    const proj = resolveProject(ctx, null, body)
    if (!proj.ok) return { code: 400, body: { ok: false, code: proj.code, error: proj.error } }
    const loc = stateFileFor(proj.projectRoot, { stateDir })
    // expectRev:0 ⇒ 只有「不存在」或「rev 恰为 0」时才写：天然幂等、**绝不覆盖**已有账本
    const r = await updateState(loc.path, (s) => s, { expectRev: 0, projectId: loc.projectId, projectRoot: proj.projectRoot })
    if (r.ok) {
      log(`ledger created: ${loc.path} rev=${r.rev} bytes=${r.bytes} dirFsync=${r.fsync && r.fsync.dir}`)
      return {
        code: 200,
        body: {
          ok: true, created: true, rev: r.rev, path: loc.path, stateDir,
          projectId: loc.projectId, projectRoot: proj.projectRoot, projectSource: proj.source,
          version: SCHEMA_VERSION, sha256: r.sha256, bytes: r.bytes, steps: r.steps, fsync: r.fsync,
        },
      }
    }
    if (r.code === 'STALE_BASE') {
      return {
        code: 200,
        body: {
          ok: true, created: false, rev: r.rev, path: loc.path, stateDir,
          projectId: loc.projectId, projectRoot: proj.projectRoot,
          note: '账本已存在：init 幂等，不做覆盖（改内容请用 ledger/patch + expectRev）',
        },
      }
    }
    log(`ledger init refused: ${r.code} status=${r.status || ''} ${r.error || ''}`)
    return {
      code: statusForLedgerError(r.code),
      body: {
        ok: false, code: r.code, status: r.status ?? null, error: r.error ?? null,
        errors: r.errors ?? null, path: loc.path, step: r.step ?? null, tmpRemoved: r.tmpRemoved ?? null,
      },
    }
  }

  const handlePatch = async (body) => {
    const proj = resolveProject(ctx, null, body)
    if (!proj.ok) return { code: 400, body: { ok: false, code: proj.code, error: proj.error } }
    const expectRev = body ? body.expectRev : undefined
    if (!Number.isInteger(expectRev) || expectRev < 0) {
      return {
        code: 400,
        body: {
          ok: false, code: 'EXPECT_REV_REQUIRED',
          error: 'expectRev 必须是 >= 0 的整数（CAS 基线；先 GET /orchestrator/ledger 读取当前 rev）',
        },
      }
    }
    // 白名单预检（不需要状态）：拒绝 version/rev/createdAt 等引擎自管字段
    const pre = applyPatch({}, body ? body.patch : undefined)
    if (!pre.ok) {
      return {
        code: 400,
        body: {
          ok: false, code: pre.code,
          rejected: pre.rejected ?? null,
          allowed: pre.allowed ?? [...PATCHABLE_KEYS],
          error: pre.code === 'PATCH_NOT_OBJECT' ? 'patch 必须是对象' : 'patch 含不可写顶层键',
        },
      }
    }
    const loc = stateFileFor(proj.projectRoot, { stateDir })
    const r = await updateState(
      loc.path,
      (base) => {
        const merged = applyPatch(base, body.patch)
        if (!merged.ok) throw Object.assign(new Error(merged.code), { code: merged.code })
        return merged.next
      },
      { expectRev, projectId: loc.projectId, projectRoot: proj.projectRoot },
    )
    if (r.ok) {
      log(`ledger patched: ${loc.path} rev=${r.rev} bytes=${r.bytes} dirFsync=${r.fsync && r.fsync.dir}`)
      return {
        code: 200,
        body: {
          ok: true, rev: r.rev, path: loc.path, stateDir,
          projectId: loc.projectId, projectRoot: proj.projectRoot,
          version: SCHEMA_VERSION, sha256: r.sha256, bytes: r.bytes, steps: r.steps, fsync: r.fsync,
          prevBackup: r.prevBackup ?? null, migrationBackup: r.migrationBackup ?? null,
        },
      }
    }
    log(`ledger patch refused: ${r.code} status=${r.status || ''} ${r.error || ''}`)
    return {
      code: statusForLedgerError(r.code),
      body: {
        ok: false, code: r.code, status: r.status ?? null, rev: r.rev ?? null, expectRev: r.expectRev ?? expectRev,
        error: r.error ?? null, errors: r.errors ?? null, path: loc.path,
        step: r.step ?? null, tmpRemoved: r.tmpRemoved ?? null, backup: r.backup ?? null,
      },
    }
  }

  const routeHandler = (req, res) => {
    void (async () => {
      try {
        if (!isLoopback(req.socket && req.socket.remoteAddress)) {
          return json(res, 403, { ok: false, code: 'LOOPBACK_ONLY', error: 'loopback only' })
        }
        const method = req.method || 'GET'
        const pathname = String(req.url || '/').split('?')[0].replace(/\/+$/, '')
        const rel = pathname.startsWith(config.routePrefix) ? pathname.slice(config.routePrefix.length) : pathname
        const key = rel || '/'

        // ── P1 动态路径：/run/<runId>（路由表只登记前缀，具体 id 在 handler 里解析）──
        if (key === '/run' || key.startsWith('/run/')) {
          if (method !== 'GET') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET required' })
          const q = parseQuery(req.url)
          const runId = key.startsWith('/run/') ? decodeURIComponent(key.slice('/run/'.length)) : String(q.runId || '')
          const proj = resolveProject(ctx, q, null)
          if (!runId) return json(res, 400, { ok: false, code: 'RUN_ID_REQUIRED', error: '/run/<runId> 需要运行 id' })
          if (!proj.ok) return json(res, proj.code === 'PROJECT_REQUIRED' ? 400 : 422, { ok: false, code: proj.code, error: proj.error })
          const read = loadRun(proj.projectRoot, runId)
          if (read.status === 'absent') return json(res, 404, { ok: false, code: 'RUN_NOT_FOUND', error: `没有运行 ${runId}` })
          if (read.status !== 'ok') {
            // 诚实：读不回来就如实报，不假装空
            return json(res, 422, { ok: false, code: 'RUN_' + String(read.status).toUpperCase(), error: read.error, runId })
          }
          return json(res, 200, { ok: true, run: read.state, dir: runDirFor(proj.projectRoot, runId), projectRoot: proj.projectRoot })
        }
        if (key === '/runs') {
          if (method !== 'GET') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET required' })
          const q = parseQuery(req.url)
          const proj = resolveProject(ctx, q, null)
          if (!proj.ok) return json(res, proj.code === 'PROJECT_REQUIRED' ? 400 : 422, { ok: false, code: proj.code, error: proj.error })
          const limit = Math.max(1, Math.min(100, Number(q.limit) || 20))
          const runs = listRuns(proj.projectRoot, { limit })
          return json(res, 200, { ok: true, runs, projectRoot: proj.projectRoot, runsRoot: runsRoot() })
        }

        const spec = ENDPOINTS[key]
        if (!spec) {
          return json(res, 404, { ok: false, code: 'NOT_FOUND', error: `unknown endpoint ${config.routePrefix}${key}` })
        }
        if (!spec.methods.includes(method)) {
          return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `${spec.methods.join('/')} required` })
        }

        if (key === '/ping') {
          return json(res, 200, { ok: true, plugin: name, stage: 'stage-1A', ts: Date.now() })
        }
        if (key === '/state') {
          return json(res, 200, snapshot(ctx, config))
        }
        if (key === '/contract') {
          return json(res, 200, handleContract())
        }
        if (key === '/ledger') {
          const r = handleLedgerGet(parseQuery(req.url))
          return json(res, r.code, r.body)
        }

        // ── 以下为 POST 面：读体（有上限） ──
        let body
        try {
          body = await readBody(req, config.maxBodyBytes)
        } catch (e) {
          const code = e && e.code
          if (code === 'BODY_TOO_LARGE') return json(res, 413, { ok: false, code, error: String(e.message) })
          return json(res, 400, { ok: false, code: code || 'BAD_BODY', error: String((e && e.message) || e) })
        }
        if (key === '/ledger/init') {
          const r = await handleInit(body)
          return json(res, r.code, r.body)
        }
        if (key === '/ledger/patch') {
          const r = await handlePatch(body)
          return json(res, r.code, r.body)
        }
        return json(res, 404, { ok: false, code: 'NOT_FOUND', error: `unknown endpoint ${config.routePrefix}${key}` })
      } catch (e) {
        return json(res, 500, { ok: false, code: 'INTERNAL', error: String((e && e.message) || e) })
      }
    })().catch((e) => log(`route error: ${String(e)}`))
  }

  // 幂等：首次注册成功后，退避重试必须**直接返回**。
  // 否则每次启动都会多出 3 条 `webserver: duplicate prefix route "/orchestrator"` 错误日志
  // （2026-09-14 重启后实测到该噪声），虽然功能无影响，但污染日志、掩盖真故障。
  let routeRegistered = false
  const registerRoute = () => {
    if (routeRegistered) return true
    const ws = resolveService(ctx, 'webServer')
    if (!ws || typeof ws.register !== 'function') {
      log('webServer unavailable; route NOT registered')
      return false
    }
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => ws.register({ kind: 'prefix', path: config.routePrefix, handler: routeHandler }), 'dsh-orchestrator: routes')
      } else {
        ws.register({ kind: 'prefix', path: config.routePrefix, handler: routeHandler })
      }
      routeRegistered = true
      log(`routes registered at ${config.routePrefix}/* (GET ${Object.keys(ENDPOINTS).join('|')})`)
      return true
    } catch (e) {
      log(`route register failed: ${String(e)}`)
      return false
    }
  }

  registerRoute()

  // 双保险：启动早期 webServer 尚未就绪时，用退避重试补挂。
  // ⚠ 必须经 resolveService（try/catch + reflect 兜底）取 timer：
  //   直写 ctx.setTimeout 会触发 `cannot get property "timer" without inject` 并让**整个**
  //   loader entry 创建失败。2026-09-14 实测：即使把 timer 写进 inject 也救不了
  //   loader.create 这条路径（与 dsh-session-hygiene 注释里 “for ANY new entry” 一致）。
  //   最内层再兜 globalThis.setTimeout ⇒ 这段逻辑永不可能弄挂 apply。
  const timerSvc = resolveService(ctx, 'timer')
  const setT = timerSvc && typeof timerSvc.setTimeout === 'function'
    ? (fn, ms) => timerSvc.setTimeout(fn, ms)    : (fn, ms) => globalThis.setTimeout(fn, ms)
  for (const ms of [1000, 3000, 10000, 30000]) {
    try { setT(() => { try { registerRoute() } catch { /* noop */ } }, ms) } catch { /* noop */ }
  }

  // ── P1：orchestrate 工具（唯一权威入口）──────────────────────────────────
  // 形态由硬约束决定：`ctx.subagents.start()` 的 parent **必须是活着的 Agent**
  // （`dsh-subagent/lib/types/index.js:287`）⇒ 插件不能做无人监督的后台调度器，
  // 必须由会话里的 agent 调用一次，工具内部用代码把整条 DAG 跑完。
  // ⚠ 下面这段必须在**路由重试循环之后**，且不得删掉上面的 registerRoute 重试。
  const ORCHESTRATE_TOOL = 'orchestrate'
  let toolRegistered = false
  const registerTool = () => {
    if (toolRegistered) return true
    const tools = resolveService(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') {
      log('tools service unavailable; orchestrate tool NOT registered')
      return false
    }
    try {
      const definition = {
        name: ORCHESTRATE_TOOL,
        description: [
          '把**一个长任务**交给「部门」执行：先用纯规则判定要不要拆（不拆就直接告诉你，省钱），',
          '要拆则冻结验收标准、派角色化子代理（开发可写；汇总/审查/测试/验收只读）并行干活，',
          '经代码级门禁（缺证据 / 审查有 critical / 测试未证明改前失败 / 只读越权 / 汇总失真 / 验收未满足）',
          '判定后汇总交付；不通过则回到修复（有轮次上限），超限转人工。全程落盘可审计。',
          '只在任务确实多步且需要验证时用它；只读咨询类任务不要调。'
        ].join(''),
        parameters: {
          task: { type: 'string', required: true, description: '用户的完整任务原文（不要自己改写需求）' },
          project: { type: 'string', description: '项目根目录绝对路径（缺省从存活会话的 cwd 推导）' },
          maxAgents: { type: 'number', description: '本次运行 agent 数上限（默认 4，硬顶 6）' }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'reason'],
            properties: {
              mode: { type: 'string', enum: ['solo', 'team'] },
              reason: { type: 'string' },
              runId: { type: 'string' },
              status: { type: 'string' },
              round: { type: 'number' },
              gate: { type: 'string' },
              blocked: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'array', items: { type: 'string' } },
              // 调度器摘要（只放原始值，保持 additionalProperties:false 的封闭形状）
              summary: {
                type: 'object',
                additionalProperties: false,
                required: ['status', 'peakConcurrency', 'wallClockMs'],
                properties: {
                  status: { type: 'string' },
                  round: { type: 'number' },
                  roundsUsed: { type: 'number' },
                  maxRounds: { type: 'number' },
                  peakConcurrency: { type: 'number' },
                  wallClockMs: { type: 'number' },
                  lastRoundReason: { type: 'string' }
                }
              },
              nodes: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'role', 'status'],
                  properties: {
                    id: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' },
                    ms: { type: 'number' }, retry: { type: 'number' }, note: { type: 'string' }
                  }
                }
              },
              summaryText: { type: 'string' }
            }
          },
          render: (_args, value) => {
            const v = value || {}
            const lines = []
            if (v.mode === 'solo') {
              lines.push(`**判定：solo（不拆）** — ${v.reason || ''}`)
              if (v.summaryText) lines.push(v.summaryText)
              return [{ type: 'text', text: lines.join('\n') }]
            }
            const nodes = Array.isArray(v.nodes) ? v.nodes : []
            const icon = (s) => ({ done: '✓', running: '▶', blocked: '⏸', failed: '✕', cancelled: '⊘', skipped: '⤫' }[s] || '○')
            lines.push(`**部门运行 ${v.runId || ''}** — ${v.status || ''} · 第 ${v.round || 1} 轮 · 门禁 ${v.gate || '—'}`)
            for (const n of nodes) {
              lines.push(`${icon(n.status)} ${n.role} — ${n.note || n.id}${n.ms ? ` (${Math.round(n.ms / 1000)}s${n.retry ? `, ⟳${n.retry}` : ''})` : ''}`)
            }
            if (Array.isArray(v.acceptance) && v.acceptance.length) lines.push('验收标准：' + v.acceptance.join(' / '))
            if (v.summary && typeof v.summary.peakConcurrency === 'number') {
              lines.push(`容量：并发峰值 ${v.summary.peakConcurrency} · 墙钟 ${(Number(v.summary.wallClockMs || 0) / 1000).toFixed(1)}s · 轮次 ${v.summary.roundsUsed || 1}/${v.summary.maxRounds || 1}`)
            }
            if (Array.isArray(v.blocked) && v.blocked.length) lines.push('未通过：' + v.blocked.join('、'))
            if (v.summaryText) lines.push(v.summaryText)
            return [{ type: 'text', text: lines.join('\n') }]
          }
        },
        async execute(args, exec) {
          return await runOrchestration(ctx, args, exec, config, log)
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => tools.register(definition), 'dsh-orchestrator: orchestrate tool')
      else tools.register(definition)
      toolRegistered = true
      log(`tool registered: ${ORCHESTRATE_TOOL}`)
      return true
    } catch (e) {
      log(`tool register failed: ${String(e)}`)
      return false
    }
  }
  registerTool()
  for (const ms of [1000, 3000, 10000]) {
    try { setT(() => { try { registerTool() } catch { /* noop */ } }, ms) } catch { /* noop */ }
  }
}
