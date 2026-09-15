/**
 * 门禁（gate）—— **代码拒绝**，不是提示词请求。这是本方案与所有被调研开源项目最大的差异点。
 *
 * 每个角色节点跑完后，`evaluateNode()` 检查它的**结构化回报**是否满足硬条件；不满足就返回
 * `{ ok:false, blockers:[{code,...}] }`，调度器据此标 `blocked` 并触发修复循环（有轮次上限）。
 *
 * 拒绝码（故障注入测试逐个覆盖）：
 *   G1_DEV_NO_EVIDENCE        开发没给证据（changes 为空或缺 path）
 *   G2_REVIEW_CRITICAL        审查有 critical（或 verdict=block）
 *   G3_TEST_NOT_PROVEN        测试没证明"改前失败"（mustFailBefore 为空）
 *   G4_TEST_REGRESSION        回归未通过
 *   G5_READONLY_WROTE         只读节点动了工作区（前后 hash 对比）
 *   G6_SYNTH_INVENTED         汇总引入了上游不存在的事实
 *   G7_ACCEPTANCE_UNMET       验收有未满足项
 *   G8_MALFORMED_RESULT       回报形状不合法（连 schema 都没过）
 *   G9_RUN_INCOMPLETE         整轮没跑完（存在 failed/timeout/skipped/cancelled 节点，或 run 本身未收尾）
 *                             ——**运行级**判定，见 `gateVerdict()`。
 *                             2026-09-15 补：此前只看 blocked 节点 ⇒ failed 的运行也会得到 `gate=pass`
 *                             （实测 run.json 里 `status:"blocked"` 与 `gate:"pass"` 并存），
 *                             门禁在最需要它的场景（跑挂了）恰好失声。
 */

export const GATE_CODES = {
  G1: 'G1_DEV_NO_EVIDENCE',
  G2: 'G2_REVIEW_CRITICAL',
  G3: 'G3_TEST_NOT_PROVEN',
  G4: 'G4_TEST_REGRESSION',
  G5: 'G5_READONLY_WROTE',
  G6: 'G6_SYNTH_INVENTED',
  G7: 'G7_ACCEPTANCE_UNMET',
  G8: 'G8_MALFORMED_RESULT',
  G9: 'G9_RUN_INCOMPLETE'
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** 只做形状检查：schema 本身由 subagent 的 outputSchema 在内核侧校验，这里再兜一层。 */
function malformed(node, result, required) {
  if (!isObj(result)) return { code: GATE_CODES.G8, detail: `${node.id} 的回报不是对象`, evidence: JSON.stringify(result).slice(0, 200) };
  for (const k of required) {
    if (!(k in result)) return { code: GATE_CODES.G8, detail: `${node.id} 的回报缺字段 ${k}`, evidence: Object.keys(result).join(',') };
  }
  return null;
}

/**
 * 判定一个节点的门禁结论。
 * @param {object} node 计划节点（含 role/id）
 * @param {object} result 该节点的结构化回报
 * @param {object} ctx  { tampered?:string[]  G5 用：只读节点运行期间被改动的文件；upstreamFacts?:string[] G6 用 }
 * @returns {{ ok:boolean, blockers:Array<{code:string,detail:string,evidence?:string}> }}
 */
export function evaluateNode(node, result, ctx = {}) {
  const blockers = [];
  const role = node && node.role;

  // G5：只读角色不允许改动工作区（这是"权限级只读"的可验证补强）
  if (node && node.wrote !== true && Array.isArray(ctx.tampered) && ctx.tampered.length > 0) {
    blockers.push({
      code: GATE_CODES.G5,
      detail: `${node.id}（${role}，只读）运行期间工作区被改动`,
      evidence: ctx.tampered.join(', ')
    });
  }

  if (role === 'plan') {
    const bad = malformed(node, result, ['acceptance', 'tasks']);
    if (bad) blockers.push(bad);
    else if (!Array.isArray(result.acceptance) || result.acceptance.length === 0) {
      blockers.push({ code: GATE_CODES.G7, detail: '规划没有产出验收标准', evidence: 'acceptance=[]' });
    }
  } else if (role === 'dev') {
    const bad = malformed(node, result, ['changes']);
    if (bad) blockers.push(bad);
    else {
      const changes = Array.isArray(result.changes) ? result.changes : [];
      if (changes.length === 0) {
        blockers.push({ code: GATE_CODES.G1, detail: '开发没有给出任何改动', evidence: 'changes=[]' });
      } else {
        const noPath = changes.filter((c) => !isObj(c) || !isNonEmptyString(c.path));
        if (noPath.length > 0) {
          blockers.push({ code: GATE_CODES.G1, detail: `${noPath.length} 条改动没有 path 证据`, evidence: JSON.stringify(noPath).slice(0, 200) });
        }
      }
    }
  } else if (role === 'synth') {
    const bad = malformed(node, result, ['summary', 'delivered']);
    if (bad) blockers.push(bad);
    else {
      const delivered = Array.isArray(result.delivered) ? result.delivered : [];
      if (delivered.length === 0) blockers.push({ code: GATE_CODES.G6, detail: '汇总没有产出任何交付项', evidence: 'delivered=[]' });
      // G6：交付项必须能索引到上游事实（默认用 source 字段；没给 source 视为无法追溯）
      const facts = Array.isArray(ctx.upstreamFacts) ? ctx.upstreamFacts : null;
      if (facts && facts.length > 0) {
        const orphan = delivered.filter((d) => isObj(d) && isNonEmptyString(d.source) && !facts.some((f) => String(d.source).includes(f) || f.includes(String(d.source))));
        if (orphan.length > 0) {
          blockers.push({ code: GATE_CODES.G6, detail: `${orphan.length} 条交付引用了上游不存在的事实`, evidence: JSON.stringify(orphan).slice(0, 200) });
        }
      }
    }
  } else if (role === 'review') {
    const bad = malformed(node, result, ['verdict', 'findings']);
    if (bad) blockers.push(bad);
    else {
      const findings = Array.isArray(result.findings) ? result.findings : [];
      const critical = findings.filter((f) => isObj(f) && f.severity === 'critical');
      if (result.verdict === 'block' || critical.length > 0) {
        blockers.push({
          code: GATE_CODES.G2,
          detail: `审查拒绝：${critical.length} 条 critical`,
          evidence: critical.map((c) => `${c.path || '?'}:${c.line || '?'} ${c.why || ''}`).join(' | ').slice(0, 300)
        });
      }
    }
  } else if (role === 'test') {
    const bad = malformed(node, result, ['pass', 'mustFailBefore', 'mustPassAfter']);
    if (bad) blockers.push(bad);
    else {
      const before = Array.isArray(result.mustFailBefore) ? result.mustFailBefore : [];
      const after = Array.isArray(result.mustPassAfter) ? result.mustPassAfter : [];
      if (before.length === 0) {
        blockers.push({ code: GATE_CODES.G3, detail: '测试没有证明"改前失败"（反作弊核心）', evidence: 'mustFailBefore=[]' });
      } else if (before.some((b) => !isObj(b) || !isNonEmptyString(b.evidence))) {
        blockers.push({ code: GATE_CODES.G3, detail: '"改前失败"缺少证据', evidence: JSON.stringify(before).slice(0, 200) });
      }
      if (after.length === 0) blockers.push({ code: GATE_CODES.G3, detail: '测试没有给出"改后通过"', evidence: 'mustPassAfter=[]' });
      if (result.pass !== true) blockers.push({ code: GATE_CODES.G4, detail: '测试自报未通过', evidence: JSON.stringify({ pass: result.pass, regression: result.regression || [] }).slice(0, 200) });
    }
  } else if (role === 'accept') {
    const bad = malformed(node, result, ['allPass', 'items']);
    if (bad) blockers.push(bad);
    else {
      const items = Array.isArray(result.items) ? result.items : [];
      const failed = items.filter((i) => isObj(i) && i.verdict === 'fail');
      if (result.allPass !== true || failed.length > 0) {
        blockers.push({
          code: GATE_CODES.G7,
          detail: `验收未通过：${failed.length} 条不满足`,
          evidence: failed.map((f) => `${f.id}: ${f.note || f.evidence || ''}`).join(' | ').slice(0, 300)
        });
      }
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/** 节点级"没完成"的状态集：出现任一 ⇒ 整轮未完成。 */
const INCOMPLETE_STATUS = new Set(['failed', 'timeout', 'skipped', 'cancelled']);
/** 代表"正常收尾"的 run.status（其余一律视为未完成）。 */
const RUN_DONE_STATUS = new Set(['done', 'running', 'solo']);

/** 把 blockers 汇总成 gate.json 的内容（一次运行的最终门禁结论）。 */
export function gateVerdict(run, blockedNodes) {
  const blockers = [];
  for (const n of blockedNodes || []) {
    const list = Array.isArray(n.findings) ? n.findings : [];
    for (const b of list) blockers.push({ node: n.id, role: n.role, code: b.code, detail: b.detail, evidence: b.evidence });
    if (list.length === 0) blockers.push({ node: n.id, role: n.role, code: 'UNKNOWN', detail: '节点被阻断但未记录原因' });
  }
  // G9（运行级）：有 failed/timeout/skipped/cancelled 节点 ⇒ 整轮没跑完，绝不能报 pass。
  // 这类节点走的是调度器的"失败/跳过"路径，**不进 blockedNodes** ⇒ 只数 blocked 会漏掉最严重的情形。
  const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
  const incomplete = nodes.filter((n) => INCOMPLETE_STATUS.has(n.status));
  if (incomplete.length > 0) {
    const evidence = incomplete.filter((n) => n.error).map((n) => `${n.id}: ${n.error}`).join(' | ').slice(0, 300);
    blockers.push({
      node: 'run',
      role: 'run',
      code: GATE_CODES.G9,
      detail: `${incomplete.length} 个节点未完成：${incomplete.map((n) => `${n.id}=${n.status}`).join(', ')}`,
      evidence: evidence || undefined
    });
  }
  // 兜底：run 自身状态就是未完成（cancelled/timeout/blocked…），但节点已不可归因时也不能静默放过。
  const runStatus = run && run.status;
  if (blockers.length === 0 && typeof runStatus === 'string' && !RUN_DONE_STATUS.has(runStatus)) {
    blockers.push({ node: 'run', role: 'run', code: GATE_CODES.G9, detail: `运行未完成（status=${runStatus}）` });
  }
  return {
    status: blockers.length === 0 ? 'pass' : 'block',
    runId: run && run.runId,
    round: run && run.round,
    blockers,
    checkedAt: Date.now(),
    acceptance: (run && run.acceptance) || []
  };
}

export default { evaluateNode, gateVerdict, GATE_CODES };
