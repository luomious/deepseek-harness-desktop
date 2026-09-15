/**
 * 调度器（scheduler）—— 按任务图跑角色化 sub agent，并把"长期运行不出问题"的几条铁律**写进代码**。
 *
 * 全部 IO 走注入（`dispatch` / `onEvent` / `now` / `signal`）⇒ 可以在纯 node 里用假派发做隔离测试，
 * 覆盖并发上限、超时、重试、取消、修复循环、幂等 —— 这些正是"它通过了 ≠ 它有效"的地方。
 *
 * 纪律（每条都有测试）：
 *   1. **并发有上限**：同时运行的节点数 ≤ concurrency。
 *   2. **单节点超时**：超时按 `timeout` 处理（可重试），并 abort 该节点的 signal。
 *   3. **重试只针对 failed/timeout**：`blocked`（门禁拒绝）**不重试** —— 重试它只会烧钱。
 *   4. **取消可透传**：run 级 signal → 未启动节点标 `cancelled`，在跑的节点被 abort。
 *   5. **幂等/可续跑**：已 `done` 的节点直接跳过（`resume` 场景）。
 *   6. **修复循环有上限**：门禁不过 → `nextRound` 重跑执行链；超过 `maxRounds` ⇒ `blocked` 转人工。
 *   7. **依赖失败即跳过下游**：`failed`/`cancelled` 的下游标 `skipped`（不静默、也不白跑）。
 *   8. **整轮墙钟上限**：超时 ⇒ `timeout`，避免一个 run 挂到天荒地老。
 */

const TERMINAL = new Set(['done', 'blocked', 'failed', 'cancelled', 'skipped', 'timeout']);

function clone(plan) {
  return Object.assign({}, plan, {
    nodes: plan.nodes.map((n) => Object.assign({}, n)),
    edges: (plan.edges || []).map((e) => Object.assign({}, e)),
    backEdges: (plan.backEdges || []).map((e) => Object.assign({}, e))
  });
}

function byId(plan) {
  const m = {};
  for (const n of plan.nodes) m[n.id] = n;
  return m;
}

/** 依赖是否全部完成。 */
function depsDone(node, map) {
  for (const d of node.deps || []) {
    const dep = map[d];
    if (!dep || dep.status !== 'done') return false;
  }
  return true;
}

/** 依赖里是否有"不会完成了"的节点（失败/取消/跳过）⇒ 本节点只能 skipped。 */
function depsDead(node, map) {
  for (const d of node.deps || []) {
    const dep = map[d];
    if (!dep) return true;
    if (dep.status === 'failed' || dep.status === 'cancelled' || dep.status === 'skipped' || dep.status === 'timeout') return true;
  }
  return false;
}

function timeoutAfter(ms, onTimeout) {
  let handle = null;
  const promise = new Promise((resolve) => {
    handle = setTimeout(() => { onTimeout(); resolve({ __timeout: true }); }, ms);
  });
  return { promise, cancel: () => { if (handle) clearTimeout(handle); } };
}

/**
 * 跑一个计划。
 * @param {object} inputPlan plan()
 * @param {object} opts
 *   dispatch(node, { signal, round, attempt }) => Promise<{status?, result?, artifacts?, findings?} | void>
 *   onEvent(evt) => void            evt: {type, nodeId?, round?, status?, at, detail?}
 *   evaluate(node, outcome) => { ok:boolean, blockers?:Array<{code,detail}>, status?:string }  门禁钩子
 *   concurrency / nodeTimeoutMs / retries / maxRounds / maxWallClockMs / signal / now
 */
export async function runPlan(inputPlan, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const dispatch = opts.dispatch;
  if (typeof dispatch !== 'function') throw new Error('runPlan requires opts.dispatch');
  const evaluate = typeof opts.evaluate === 'function' ? opts.evaluate : () => ({ ok: true });

  // ⚠ **原地持有**（不 clone）：调用方需要在运行过程中持续落盘真实状态（"实时进度"），
  //   若在这里 clone，宿主看到的永远是初始 idle 状态，门禁判定与 UI 都会拿到陈旧数据。
  //   （2026-09-14 被 orchestrator-tool 测试抓到：G6 因此失效、中途落盘状态陈旧。）
  let plan = inputPlan;
  const concurrency = Math.max(1, typeof opts.concurrency === 'number' ? opts.concurrency : (plan.caps && plan.caps.concurrency) || 3);
  const nodeTimeoutMs = typeof opts.nodeTimeoutMs === 'number' ? opts.nodeTimeoutMs : 10 * 60 * 1000;
  const retries = typeof opts.retries === 'number' ? opts.retries : (plan.caps && plan.caps.retries) || 2;
  const maxRounds = typeof opts.maxRounds === 'number' ? opts.maxRounds : (plan.maxRounds || 2);
  const maxWallClockMs = typeof opts.maxWallClockMs === 'number' ? opts.maxWallClockMs : 30 * 60 * 1000;
  const signal = opts.signal;

  const startedAt = now();
  const events = [];
  let peakConcurrency = 0;
  let runStatus = 'done';
  let lastRoundReason = null;

  const emit = (evt) => {
    const e = Object.assign({ at: now() }, evt);
    events.push(e);
    try { onEvent(e); } catch (err) { /* 事件回调出错不能拖垮 run */ }
  };

  emit({ type: 'run-start', round: plan.round, detail: `${plan.nodes.length} 个节点，并发上限 ${concurrency}` });

  const wallClockExceeded = () => (now() - startedAt) > maxWallClockMs;
  const aborted = () => (signal && signal.aborted) || wallClockExceeded();

  /** 跑单个节点（含重试与超时）。返回最终 status。 */
  async function runNode(node, round) {
    const map = byId(plan);
    node.status = 'running';
    node.startedAt = now();
    emit({ type: 'node-start', nodeId: node.id, round, detail: node.title });
    let attempt = 0;
    let outcome = null;
    while (attempt <= retries) {
      attempt += 1;
      const nodeAbort = typeof AbortController === 'function' ? new AbortController() : null;
      const nodeSignal = nodeAbort ? nodeAbort.signal : undefined;
      let timedOut = false;
      const t = timeoutAfter(nodeTimeoutMs, () => {
        timedOut = true;
        if (nodeAbort) nodeAbort.abort();
      });
      try {
        const result = await Promise.race([
          Promise.resolve(dispatch(node, { signal: nodeSignal, round, attempt, plan })),
          t.promise
        ]);
        t.cancel();
        if (timedOut || (result && result.__timeout)) throw Object.assign(new Error('node timeout'), { __timeout: true });
        outcome = result || {};
        node.ms = now() - node.startedAt;
        if (outcome.artifacts !== undefined) node.artifacts = outcome.artifacts;
        if (outcome.findings !== undefined) node.findings = outcome.findings;
        // 门禁钩子（代码判定，不是提示词）
        const verdict = evaluate(node, outcome) || { ok: true };
        if (verdict.ok === false) {
          node.status = verdict.status || 'blocked';
          node.findings = verdict.blockers || node.findings;
          node.ms = now() - node.startedAt;
          emit({ type: 'node-end', nodeId: node.id, round, status: node.status, detail: (verdict.blockers || []).map((b) => b.code).join(',') });
          return node.status;
        }
        node.status = 'done';
        node.ms = now() - node.startedAt;
        emit({ type: 'node-end', nodeId: node.id, round, status: 'done' });
        return 'done';
      } catch (err) {
        t.cancel();
        const isTimeout = err && err.__timeout === true;
        if (attempt > retries) {
          node.status = isTimeout ? 'timeout' : 'failed';
          node.ms = now() - node.startedAt;
          node.error = String((err && err.message) || err);
          emit({ type: 'node-end', nodeId: node.id, round, status: node.status, detail: node.error });
          return node.status;
        }
        emit({ type: 'node-retry', nodeId: node.id, round, detail: `第 ${attempt} 次失败，重试（上限 ${retries}）` });
      }
    }
    node.status = 'failed';
    return 'failed';
  }

  // ── 轮次循环 ──
  for (;;) {
    const map = byId(plan);
    const round = plan.round || 1;
    let progressed = true;
    while (progressed) {
      progressed = false;
      // ① 因依赖失败而只能跳过的
      for (const n of plan.nodes) {
        if (n.status !== 'idle') continue;
        if (depsDead(n, map)) {
          n.status = 'skipped';
          emit({ type: 'node-end', nodeId: n.id, round, status: 'skipped', detail: '上游失败/取消' });
          progressed = true;
        }
      }
      if (aborted()) {
        for (const n of plan.nodes) {
          if (n.status === 'idle') {
            n.status = 'cancelled';
            emit({ type: 'node-end', nodeId: n.id, round, status: 'cancelled', detail: 'run 被取消或超时' });
          }
        }
        runStatus = wallClockExceeded() ? 'timeout' : 'cancelled';
        break;
      }
      // ② 就绪节点（依赖全 done 且自身 idle）：按并发上限并发跑
      const ready = plan.nodes.filter((n) => n.status === 'idle' && depsDone(n, map));
      if (ready.length === 0) break;
      const batch = ready.slice(0, concurrency);
      peakConcurrency = Math.max(peakConcurrency, batch.length);
      progressed = true;
      await Promise.all(batch.map((n) => runNode(n, round)));
    }
    if (runStatus === 'cancelled' || runStatus === 'timeout') break;

    // ③ 门禁结论：有阻断 ⇒ 修复循环或转人工
    const blockedNodes = plan.nodes.filter((n) => n.status === 'blocked');
    const deadNodes = plan.nodes.filter((n) => n.status === 'failed' || n.status === 'timeout');
    if (blockedNodes.length === 0 && deadNodes.length === 0) {
      runStatus = 'done';
      break;
    }
    const reason = blockedNodes.length
      ? `门禁拒绝：${blockedNodes.map((n) => n.id).join(', ')}`
      : `节点失败：${deadNodes.map((n) => n.id).join(', ')}`;
    lastRoundReason = reason;
    if (round >= maxRounds) {
      runStatus = 'blocked';
      emit({ type: 'run-blocked', round, detail: `${reason}（已达轮次上限 ${maxRounds}，转人工）` });
      break;
    }
    // 修复循环：把执行链重置为 idle（保留规划节点与冻结的验收标准）
    if (typeof opts.nextRound === 'function') plan = opts.nextRound(plan, { reason, now: now() });
    else {
      plan = Object.assign({}, plan, {
        round: round + 1,
        nodes: plan.nodes.map((n) => (n.role === 'plan' ? n : Object.assign({}, n, { status: 'idle', ms: null, findings: null, retry: n.role === 'dev' ? (n.retry || 0) + 1 : n.retry })))
      });
    }
    emit({ type: 'round-start', round: plan.round, detail: reason });
  }

  const endedAt = now();
  const summary = {
    status: runStatus,
    round: plan.round || 1,
    maxRounds,
    roundsUsed: plan.round || 1,
    nodeCounts: countStatuses(plan),
    peakConcurrency,
    wallClockMs: endedAt - startedAt,
    lastRoundReason
  };
  emit({ type: 'run-end', round: plan.round || 1, status: runStatus, detail: lastRoundReason || '' });
  return { status: runStatus, plan, events, summary, startedAt, endedAt };
}

function countStatuses(plan) {
  const out = {};
  for (const n of plan.nodes) out[n.status] = (out[n.status] || 0) + 1;
  return out;
}

export { TERMINAL, countStatuses };
export default { runPlan, countStatuses };
