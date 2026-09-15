/**
 * 规划器（plan）+ 校验器（validate）—— 纯函数、零依赖、可隔离单测。
 *
 * 职责边界（重要）：
 *   `plan()` 只产出**任务图骨架**（谁做什么、依赖、验收标准），状态一律 `idle`；
 *   `scheduler.js` 负责跑并填状态；`run.js` 负责落盘。
 *
 * 校验器是**第二道闸**：模型只能"提议"，代码才"批准"。拒绝码（blockers[].code）：
 *   EMPTY_PLAN / UNKNOWN_ROLE / MULTI_WRITER / MISSING_WRITER / DEP_CYCLE / DANGLING_DEP
 *   / TOO_MANY_AGENTS / DEPTH_EXCEEDED / NO_ACCEPTANCE / DANGLING_BACKEDGE
 */

import { roleSpec, phaseOfRole } from './roles.js';

/** 从任务原文里抽出**可验收**的标准（规划期冻结，验收阶段只对照这份清单）。 */
export function acceptanceFor(task, opts = {}) {
  const text = typeof task === 'string' ? task.trim() : '';
  const out = [];
  if (text) {
    // 按并列分隔符切子句，只保留像"要求"的（太短的丢掉）
    const clauses = text
      .split(/[。；;\n]+|(?:，|,)?(?:并且|以及|同时|另外|顺便)/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4 && s.length <= 120);
    for (const c of clauses) {
      if (out.length >= 5) break;
      out.push({ id: `A${out.length + 1}`, text: c, kind: 'from-task', source: 'task-clause' });
    }
  }
  // 代码类任务补一条**派生**标准（明确标注是派生的，不假装是用户说的）
  if (/(实现|开发|新增|添加|改|修复|重构|迁移|接入)/.test(text)) {
    out.push({ id: `A${out.length + 1}`, text: '既有功能无回归（相关测试/自检保持通过）', kind: 'derived', source: 'derived:code-change' });
  }
  if (out.length === 0 && text) {
    out.push({ id: 'A1', text: '按任务描述完成交付', kind: 'fallback', source: 'fallback' });
  }
  return out.slice(0, opts.maxAcceptance || 6);
}

let runSeq = 0;
/** 运行 id：可注入（测试用），缺省按时间 + 序号生成（同进程内不重复）。 */
export function newRunId(now = Date.now()) {
  runSeq = (runSeq + 1) % 100000;
  return `run-${now.toString(36)}-${runSeq.toString(36).padStart(3, '0')}`;
}

function node(id, role, title, deps, extra = {}) {
  const spec = roleSpec(role);
  return Object.assign({
    id,
    role,
    phase: phaseOfRole(role),
    title,
    deps: deps.slice(),
    status: 'idle',
    ms: null,
    startedAt: null,
    retry: 0,
    artifacts: 0,
    wrote: spec.writable === true,
    findings: null
  }, extra);
}

/**
 * 生成计划。
 *   solo：**不派活**（nodes 为空），返回建议让上层直接做 —— 省掉 15× 成本。
 *   team：判定与规划(0) → 执行(1) → 汇总(2) → 审查(3) → 测试(4) → 验收(5)，并带三条驳回回边。
 */
export function plan(task, judged, opts = {}) {
  const acceptance = Array.isArray(opts.acceptance) ? opts.acceptance : acceptanceFor(task);
  const base = {
    version: 1,
    runId: opts.runId || newRunId(opts.now),
    task: typeof task === 'string' ? task : '',
    mode: judged && judged.mode === 'team' ? 'team' : 'solo',
    judge: judged ? { mode: judged.mode, reason: judged.reason, score: judged.score, signals: judged.signals } : null,
    acceptance,
    caps: (judged && judged.caps) || { agents: 4, agentsHard: 6, concurrency: 3, depth: 2, retries: 2, rounds: 2 },
    round: 1,
    maxRounds: (judged && judged.caps && judged.caps.rounds) || 2,
    nodes: [],
    edges: [],
    backEdges: [],
    createdAt: opts.now || Date.now()
  };

  if (base.mode === 'solo') {
    base.advice = '判定为 solo：不需要编排。直接用单 agent 完成即可（multi-agent 约 15× token，不值得）。';
    return base;
  }

  const n1 = node('n1-plan', 'plan', '冻结验收标准与依赖图', []);
  const n2 = node('n2-dev', 'dev', '实现改动（本次唯一可写）', ['n1-plan']);
  const n3 = node('n3-synth', 'synth', '合成交付草案 + 证据索引', ['n2-dev']);
  const n4 = node('n4-review', 'review', '审查改动与逻辑（只读）', ['n3-synth']);
  const n5 = node('n5-test', 'test', '证明改前失败 / 改后通过（只读）', ['n4-review']);
  const n6 = node('n6-accept', 'accept', '逐条对照冻结的验收标准', ['n5-test']);
  base.nodes = [n1, n2, n3, n4, n5, n6];
  base.edges = [
    { from: 'n1-plan', to: 'n2-dev' },
    { from: 'n2-dev', to: 'n3-synth' },
    { from: 'n3-synth', to: 'n4-review' },
    { from: 'n4-review', to: 'n5-test' },
    { from: 'n5-test', to: 'n6-accept' }
  ];
  // 三条驳回回边：任一门禁不过 ⇒ 回到开发修复（图上走专用通道，不穿节点）
  base.backEdges = [
    { from: 'n4-review', to: 'n2-dev', label: '审查驳回 · 回到修复' },
    { from: 'n5-test', to: 'n2-dev', label: '测试未过 · 回到修复' },
    { from: 'n6-accept', to: 'n2-dev', label: '验收未满足 · 回到修复' }
  ];
  return base;
}

/** 深度：从入口到该节点的最长依赖链长度（用于 DEPTH_EXCEEDED）。 */
function depthOf(nodes, id, memo = {}) {
  if (memo[id] !== undefined) return memo[id];
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const seen = new Set();
  let depth = 0;
  let cursor = byId[id];
  while (cursor && Array.isArray(cursor.deps) && cursor.deps.length > 0) {
    if (seen.has(cursor.id)) return Infinity; // 环
    seen.add(cursor.id);
    let next = null;
    for (const dep of cursor.deps) {
      const d = byId[dep];
      if (d && (!next || (d.deps || []).length > (next.deps || []).length)) next = d;
    }
    if (!next) break;
    depth += 1;
    cursor = next;
  }
  memo[id] = depth;
  return depth;
}

/**
 * 校验计划：**代码批准**。任何一条不通过都必须被拒（返回 blocker code），不得"警告后放行"。
 * @returns {{ ok:boolean, blockers:Array<{code:string, detail:string}> }}
 */
export function validate(p, opts = {}) {
  const blockers = [];
  const push = (code, detail) => blockers.push({ code, detail });
  if (!p || typeof p !== 'object') { push('EMPTY_PLAN', '计划不是对象'); return { ok: false, blockers }; }
  const nodes = Array.isArray(p.nodes) ? p.nodes : [];
  const edges = Array.isArray(p.edges) ? p.edges : [];
  const backEdges = Array.isArray(p.backEdges) ? p.backEdges : [];
  const caps = p.caps || {};
  const maxAgents = typeof opts.maxAgents === 'number' ? opts.maxAgents : (caps.agentsHard || 6);

  if (p.mode === 'team' && nodes.length === 0) push('EMPTY_PLAN', 'team 模式必须有节点');
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) { push('EMPTY_PLAN', '节点缺少 id'); continue; }
    if (ids.has(n.id)) push('EMPTY_PLAN', `节点 id 重复：${n.id}`);
    ids.add(n.id);
    try { roleSpec(n.role); } catch (e) { push('UNKNOWN_ROLE', `节点 ${n.id} 的角色未知：${String(n.role)}`); }
    if (!Array.isArray(n.deps)) push('DANGLING_DEP', `节点 ${n.id} 的 deps 不是数组`);
  }
  for (const n of nodes) {
    for (const dep of (n.deps || [])) if (!ids.has(dep)) push('DANGLING_DEP', `节点 ${n.id} 依赖不存在的 ${dep}`);
  }
  // 单写者铁律（并行写是 multi-agent 最大的坑）
  const writers = nodes.filter((n) => n.wrote === true);
  if (writers.length > 1) push('MULTI_WRITER', `存在 ${writers.length} 个可写节点（${writers.map((n) => n.id).join(', ')}）—— 全局只允许一个`);
  if (p.mode === 'team' && writers.length === 0) push('MISSING_WRITER', 'team 模式必须恰好有一个可写节点（开发）');
  // 依赖成环（DFS 三色）
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const state = {};
  let cycle = null;
  const visit = (id, stack) => {
    if (cycle) return;
    if (state[id] === 1) { cycle = stack.concat(id).join(' → '); return; }
    if (state[id] === 2) return;
    state[id] = 1;
    const n = byId[id];
    for (const dep of (n && n.deps) || []) if (byId[dep]) visit(dep, stack.concat(id));
    state[id] = 2;
  };
  for (const n of nodes) visit(n.id, []);
  if (cycle) push('DEP_CYCLE', `依赖成环：${cycle}`);  // 上限①：节点（agent）总数 —— 防"一个查询派 50 个 agent"那类失控 spawn
  if (nodes.length > maxAgents) push('TOO_MANY_AGENTS', `节点数 ${nodes.length} 超过上限 ${maxAgents}`);
  // 上限②：链长（阶段数）与 agent 数分开——**委派深度 depth 不在这里判**，
  // 它是"worker 再派 worker"的层数（派发时传给 subagent 的 maxDepth）。
  const maxChain = typeof opts.maxChain === 'number' ? opts.maxChain : (caps.chainHard || 12);
  let chainReported = false;
  for (const n of nodes) {
    const d = depthOf(nodes, n.id);
    if (!isFinite(d)) { if (!cycle) push('DEP_CYCLE', `节点 ${n.id} 在环上`); }
    else if (d > maxChain && !chainReported) { chainReported = true; push('CHAIN_TOO_LONG', `链长 ${d} 超过上限 ${maxChain}`); }
  }
  // 验收标准必须有（否则"是否符合要求"无法判定）
  if (!Array.isArray(p.acceptance) || p.acceptance.length === 0) push('NO_ACCEPTANCE', '缺少验收标准：无法判定"是否符合要求"');
  if (p.mode === 'team' && !nodes.some((n) => n.role === 'accept')) push('NO_ACCEPTANCE', 'team 模式必须有验收节点（否则没人对照标准）');
  // 回边端点必须存在
  for (const b of backEdges) {
    if (!b || !ids.has(b.from) || !ids.has(b.to)) push('DANGLING_BACKEDGE', `回边端点不存在：${String(b && b.from)} → ${String(b && b.to)}`);
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * 进入下一轮（修复循环）：保留规划节点与验收标准，把执行链重置为 idle，开发节点 retry+1。
 * 超限由调用方判断（`round > maxRounds` ⇒ blocked 转人工）。
 */
export function nextRound(p, opts = {}) {
  const round = (p.round || 1) + 1;
  const nodes = p.nodes.map((n) => {
    if (n.role === 'plan') return Object.assign({}, n);
    const fresh = Object.assign({}, n, { status: 'idle', ms: null, startedAt: null, findings: null });
    if (n.role === 'dev') fresh.retry = (n.retry || 0) + 1;
    return fresh;
  });
  return Object.assign({}, p, {
    round,
    nodes,
    history: (p.history || []).concat([{ round: p.round || 1, reason: (opts.reason || '门禁未通过'), at: opts.now || Date.now() }])
  });
}

/** 汇总计划里各角色的数量（给 UI/日志用）。 */
export function planCounts(p) {
  const out = { total: 0, byRole: {}, writable: 0 };
  for (const n of (p && p.nodes) || []) {
    out.total += 1;
    out.byRole[n.role] = (out.byRole[n.role] || 0) + 1;
    if (n.wrote) out.writable += 1;
  }
  return out;
}

export default { plan, validate, acceptanceFor, newRunId, nextRound, planCounts };
