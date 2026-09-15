/**
 * 拆分判定器（judge）—— 纯函数、零依赖、可隔离单测。
 *
 * 为什么先做纯规则（而不是让模型判）：
 *   - multi-agent 实测约 **15× token**（Anthropic），误判的代价是钱和噪音；
 *   - 纯规则**可预测、可单测、零额外成本**，也能把"为什么不拆"讲清楚（reason + signals）；
 *   - 设计上模型只能"提议"，代码才"批准"（`plan.js` 的 validate 是第二道闸）。
 *
 * 判定倾向：**默认 solo**。只有出现足够多的"真需要拆"的信号才判 team。
 */

/** 只读/咨询类信号：出现这些且没有写操作信号 ⇒ 强烈倾向 solo。 */
const READONLY_PATTERNS = [
  /(解释|说明|讲讲|介绍一下|是什么|为什么|怎么回事)/,
  /(看一下|瞧瞧|检查一下|定位|排查|分析|总结|梳理|评估)/,
  /(怎么写|怎么用|用法|示例|文档|有没有现成)/,
  /(review\s*一下|帮我看看)/i
];

/** 写操作信号：要改东西。 */
const WRITE_PATTERNS = [
  /(实现|开发|新增|添加|加一个|加上|改造|重构|迁移|修复|修掉|改成|替换|接入|升级)/,
  /(写一个|写个|做一个|做个|搞一个|搞个|合并|拆分)/
];

/** 需要独立验证的信号（测试/回归/证明）。 */
const VERIFY_PATTERNS = [/(测试|用例|回归|验证|证明|确保|保证|不要破坏|不破坏|兼容)/];

/** 需要独立审查的信号（评审/安全/门禁）。 */
const REVIEW_PATTERNS = [/(审查|评审|review|安全|权限|越权|门禁|合规|风险)/i];

/** 规模/依赖信号：多模块、跨层、多步骤。 */
const SCALE_PATTERNS = [
  /(并且|以及|同时|顺便|另外|并且要|既要)/,
  /(前端|后端|界面|UI|插件|脚本|内核|数据库|接口|协议|配置|装配|部署)/i,
  /(多个|全部|所有|批量|整体|统一|跨)/,
  /(步骤|阶段|流程|流水线|先.*再.*然后)/
];

const TEAM_SCORE_THRESHOLD = 2;
const LONG_TASK_CHARS = 120;

function hits(patterns, text) {
  const out = [];
  for (const re of patterns) if (re.test(text)) out.push(String(re));
  return out;
}

/** team 模式的硬上限（全部由代码判断，超限在 plan.validate 里被拒）。 */
export function capsFor(mode) {
  if (mode === 'team') {
    return {
      agents: 4, agentsHard: 6,   // 节点数（默认/硬顶）
      concurrency: 3,             // 同时运行的 agent 数
      depth: 2,                   // **子代理委派深度**（worker 再派 worker 的层数，传给 maxDepth）
      chain: 8, chainHard: 12,    // **DAG 链长**（阶段数；6 阶段默认链长 5，与 depth 无关）
      retries: 2,                 // 单节点重试上限
      rounds: 2                   // 修复循环轮次上限
    };
  }
  return { agents: 1, agentsHard: 1, concurrency: 1, depth: 1, chain: 2, chainHard: 2, retries: 1, rounds: 1 };
}

/**
 * 判定一个任务该 solo 还是 team。
 * @param {string} task 用户任务原文
 * @param {{ cwd?: string, existingFiles?: string[] }} [ctx]
 * @returns {{ mode:'solo'|'team', reason:string, score:number, signals:Array<{key:string,hit:boolean,detail:string}>, caps:object }}
 */
export function judge(task, ctx = {}) {
  const text = typeof task === 'string' ? task : '';
  const trimmed = text.trim();
  const signals = [];

  const readOnly = hits(READONLY_PATTERNS, trimmed);
  const write = hits(WRITE_PATTERNS, trimmed);
  const verify = hits(VERIFY_PATTERNS, trimmed);
  const review = hits(REVIEW_PATTERNS, trimmed);
  const scale = hits(SCALE_PATTERNS, trimmed);
  const long = trimmed.length >= LONG_TASK_CHARS;
  const multiClause = /[、；;]|^\s*\d+[.、)]/m.test(trimmed);

  signals.push({ key: 'readonly', hit: readOnly.length > 0, detail: readOnly.length ? '任务里出现只读/咨询类措辞' : '无' });
  signals.push({ key: 'write', hit: write.length > 0, detail: write.length ? '任务要求改代码/产物' : '无' });
  signals.push({ key: 'verify', hit: verify.length > 0, detail: verify.length ? '任务要求测试/回归/证明' : '无' });
  signals.push({ key: 'review', hit: review.length > 0, detail: review.length ? '任务要求审查/评审/安全' : '无' });
  signals.push({ key: 'scale', hit: scale.length > 0, detail: scale.length ? '任务涉及多模块/跨层/多步骤' : '无' });
  signals.push({ key: 'long', hit: long, detail: long ? `任务描述较长（${trimmed.length} 字符），通常不是单步` : '任务描述短' });
  signals.push({ key: 'multiClause', hit: multiClause, detail: multiClause ? '任务含多个并列子句' : '单一句子' });

  // 空任务：不猜，保守 solo（省钱、也不假装理解）
  if (!trimmed) {
    return { mode: 'solo', reason: '任务为空 ⇒ 无法判定，保守按 solo 处理（不派活）', score: 0, signals, caps: capsFor('solo') };
  }

  // 纯只读且没有写操作 ⇒ solo（即使用户要求审查，也只读咨询，不需要"部门"）
  if (readOnly.length > 0 && write.length === 0) {
    return {
      mode: 'solo',
      reason: '只读/咨询类任务（没有改代码的诉求）⇒ 单 agent 直接回答更快也更省',
      score: 0,
      signals,
      caps: capsFor('solo')
    };
  }

  let score = 0;
  const reasons = [];
  if (write.length > 0) { score += 1; reasons.push('需要真的改动产物'); }
  if (verify.length > 0) { score += 1; reasons.push('需要独立验证（测试/回归）'); }
  if (review.length > 0) { score += 1; reasons.push('需要独立审查（评审/安全）'); }
  if (scale.length > 0) { score += 1; reasons.push('涉及多模块/跨层/多步骤'); }
  if (long) { score += 1; reasons.push('任务描述较长，通常需要计划'); }
  if (multiClause) { score += 1; reasons.push('含多个并列子句，存在可并行的子交付'); }
  if (readOnly.length > 0 && write.length > 0) { score -= 1; reasons.push('（同时含只读措辞，扣一分保持保守）'); }

  const mode = score >= TEAM_SCORE_THRESHOLD ? 'team' : 'solo';
  const reason = mode === 'team'
    ? `命中 ${score} 个"该拆"信号：${reasons.join('；')} ⇒ 派角色化 sub agent（开发可写，审查/测试只读，最后汇总与验收）`
    : `只有 ${score} 个"该拆"信号（阈值 ${TEAM_SCORE_THRESHOLD}）：${reasons.length ? reasons.join('；') : '均为弱信号'} ⇒ 不拆，单 agent 直接做（multi-agent 约 15× token）`;
  return { mode, reason, score, signals, caps: capsFor(mode) };
}

/** 供 CLI/调试：把判定结果渲染成可读文本。 */
export function describeJudge(result) {
  const lines = [`mode=${result.mode}  score=${result.score}`, `reason: ${result.reason}`];
  for (const s of result.signals) lines.push(`  [${s.hit ? 'x' : ' '}] ${s.key}: ${s.detail}`);
  return lines.join('\n');
}

export const JUDGE_DEFAULTS = { TEAM_SCORE_THRESHOLD, LONG_TASK_CHARS };
export default { judge, describeJudge, capsFor, JUDGE_DEFAULTS };
