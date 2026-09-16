/**
 * 运行落盘（run.js）—— 复用 S1 的**原子写引擎**（tmp → fsync(tmp) → rename → fsync(父目录) 门控），
 * 并把内部计划投影成**客户端契约形状**（`lib/client.js` 的 `runToRows` 直接吃）。
 *
 * 落点（**不污染用户工作区**）：`<DSH_HOME>/orchestration/runs/<projectId>/<runId>/`
 *   run.json                  运行总记录（客户端只认这个形状）
 *   nodes/<nodeId>/brief.md   该 agent 的任务简报（调研结论：子 agent 必须拿到完整任务描述，否则重复劳动/漂移）
 *   nodes/<nodeId>/result.json 结构化回报（符合角色 outputSchema）
 *   nodes/<nodeId>/log.ndjson 时间线（追加式）
 *   gate.json                 门禁结论
 *   deliverable.md            汇总产出（synth 节点产出时写入）
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { writeStateAtomic, sha256Hex, dshHomeDir, projectIdFor } from './ledger.js';

/**
 * 读一份 run.json —— **不复用 S1 的 `readState`**：那个读路径按"账本契约"校验
 * （`version/projectId/stages/tasks/budget`），run 记录是另一种形状，会被误判成 `invalid`。
 * 这里用同一套**诚实语义**（缺→absent、坏→corrupt、形状不对→invalid，绝不静默当空）。
 */
export function readRunFile(file, { fs = nodeFs } = {}) {
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { status: 'absent', state: null, error: String(e && e.message) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { status: 'corrupt', state: null, error: 'JSON 解析失败：' + String(e && e.message) };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.runId !== 'string' || !Array.isArray(parsed.nodes)) {
    return { status: 'invalid', state: parsed, error: 'run.json 形状不合法（缺 runId/nodes）' };
  }
  return { status: 'ok', state: parsed, error: null };
}

export function runsRoot() {
  return nodePath.join(dshHomeDir(), 'orchestration', 'runs');
}

export function projectRunsDir(projectRoot, { fs = nodeFs } = {}) {
  const pid = projectIdFor(projectRoot);
  return nodePath.join(runsRoot(), pid);
}

export function runDirFor(projectRoot, runId, opts = {}) {
  return nodePath.join(projectRunsDir(projectRoot, opts), String(runId));
}

function ensureDir(dir, fs) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在 */ }
  return dir;
}

/** 用户任务 + 该节点的职责 + 边界 + 输出格式 + 验收标准 ⇒ 一份**自包含**的任务简报。 */
export function briefFor(node, run) {
  const acceptance = (run.acceptance || []).map((a) => `- ${a.id}: ${a.text}`).join('\n') || '- （无）';
  const lines = [
    `# 任务简报 · ${node.id}（角色：${node.role}）`,
    '',
    `## 用户任务原文`,
    run.task || '(空)',
    '',
    `## 你的职责`,
    node.title || '(未命名)',
    '',
    `## 边界（务必遵守）`,
    node.wrote === true
      ? '- 你是本次运行中**唯一允许改动工作区**的角色；改动要最小、要能给出 `path:line`。'
      : '- 你是**只读**角色：不得修改任何文件；只输出分析与结论。',
    `- 只做这件事，不要顺手改无关内容；不要引入本简报以外的新目标。`,
    '',
    `## 冻结的验收标准（验收阶段只对照这份清单）`,
    acceptance,
    '',
    `## 输出格式`,
    `- 必须按本角色的结构化 schema 返回（见工具调用的 outputSchema），不要只给散文。`,
    '- 所有结论都要带证据（`path:line` 或命令与关键输出）。',
    // ⚠️ 顺序不能反（2026-09-16 源码确证）：`router-standard` 预设的 `router-bootstrap.mjs:67-83` 在会话
    // **首个 `tool/call` 之前**会把子代理工具目录裁到 coreFor(mode)（read/write/edit/glob/grep）+ shell，
    // 此时 `structured_output` **不在目录里**；只有出现 `tool/call` 后才返回全量目录。
    // 所以必须先真的用只读工具取证（首轮产生 tool/call ⇒ 目录提升），最后一步再提交结构化结果。
    '- **先取证再收尾**：先用只读工具（`read`/`grep`/`glob`，或本角色需要的命令）实际查看/验证，拿到证据；**最后一步**再调用 `structured_output` 提交结果（顺序反了会拿不到报告工具）。',
    '',
    `## 轮次`,
    `- 第 ${run.round || 1}/${run.maxRounds || 2} 轮。` + ((run.history || []).length ? `上一轮被打回的原因：${run.history[run.history.length - 1].reason}` : ''),
    ''
  ];
  return lines.join('\n');
}

/** 运行总记录落盘（原子写）。 */
export function saveRun(projectRoot, run, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = ensureDir(runDirFor(projectRoot, run.runId, opts), fs);
  const file = nodePath.join(dir, 'run.json');
  const state = Object.assign({}, run, { updatedAt: (opts.now || Date.now)() });
  const res = writeStateAtomic(file, state, { fs, now: opts.now, limits: opts.limits });
  return { file, dir, bytes: res && res.bytes, renameAttempts: res && res.renameAttempts };
}

/** 读取运行总记录（诚实语义：absent/corrupt/invalid/ok，绝不静默当空）。 */
export function loadRun(projectRoot, runId, opts = {}) {
  const fs = opts.fs || nodeFs;
  const file = nodePath.join(runDirFor(projectRoot, runId, opts), 'run.json');
  return readRunFile(file, { fs });
}

/** 列出某项目下的运行摘要（按 createdAt 倒序，取前 limit 条）。 */
export function listRuns(projectRoot, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = projectRunsDir(projectRoot, opts);
  const limit = typeof opts.limit === 'number' ? opts.limit : 20;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('state.json')) continue;
    const file = nodePath.join(dir, name, 'run.json');
    let stat = null;
    try { stat = fs.statSync(file); } catch (e) { continue; }
    if (!stat || !stat.isFile()) continue;
    const read = readRunFile(file, { fs });
    if (!read || read.status !== 'ok') continue;
    const run = read.state || {};
    out.push({
      runId: run.runId || name,
      task: run.task || '',
      status: run.status || read.status || 'unknown',
      round: run.round || 1,
      maxRounds: run.maxRounds || 2,
      startedAt: run.startedAt || 0,
      endedAt: run.endedAt || 0,
      nodeCount: Array.isArray(run.nodes) ? run.nodes.length : 0,
      progress: progressOf(run),
      ledgerStatus: read.status,
      mtime: stat.mtimeMs
    });
  }
  out.sort((a, b) => (b.startedAt || b.mtime) - (a.startedAt || a.mtime));
  return out.slice(0, limit);
}

export function progressOf(run) {
  const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
  const out = { total: nodes.length, done: 0, running: 0, blocked: 0, failed: 0, idle: 0, cancelled: 0, skipped: 0 };
  for (const n of nodes) {
    const k = n.status || 'idle';
    if (out[k] === undefined) out.idle += 1;
    else out[k] += 1;
  }
  return out;
}

export function writeNodeBrief(projectRoot, run, node, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = ensureDir(nodePath.join(runDirFor(projectRoot, run.runId, opts), 'nodes', String(node.id)), fs);
  const file = nodePath.join(dir, 'brief.md');
  const text = opts.text || briefFor(node, run);
  // 简报是给 agent 读的**纯文本**：同目录临时文件 + rename 原子替换（不留半写）
  const tmp = file + '.tmp-' + String(process.pid);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { dir, file, text };
}

export function writeNodeResult(projectRoot, runId, nodeId, result, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = ensureDir(nodePath.join(runDirFor(projectRoot, runId, opts), 'nodes', String(nodeId)), fs);
  const file = nodePath.join(dir, 'result.json');
  writeStateAtomic(file, result, { fs, now: opts.now, limits: opts.limits });
  return { dir, file };
}

export function appendNodeLog(projectRoot, runId, nodeId, entry, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = ensureDir(nodePath.join(runDirFor(projectRoot, runId, opts), 'nodes', String(nodeId)), fs);
  const file = nodePath.join(dir, 'log.ndjson');
  try { fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8'); } catch (e) { /* 日志失败不拖垮 run */ }
  return file;
}

export function saveGate(projectRoot, runId, gate, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = ensureDir(runDirFor(projectRoot, runId, opts), fs);
  const file = nodePath.join(dir, 'gate.json');
  writeStateAtomic(file, gate, { fs, now: opts.now, limits: opts.limits });
  return file;
}

export function saveDeliverable(projectRoot, runId, text, opts = {}) {
  const fs = opts.fs || nodeFs;
  const dir = ensureDir(runDirFor(projectRoot, runId, opts), fs);
  const file = nodePath.join(dir, 'deliverable.md');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, String(text || ''), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 文件哈希快照（G5 用）：只对**相关文件**做，不扫全仓库（成本可控）。
 * 返回 { relPath: sha8 }；不存在的文件记 null（"本来没有" vs "被删了"要能区分）。
 */
export function hashFiles(root, relPaths, opts = {}) {
  const fs = opts.fs || nodeFs;
  const out = {};
  for (const rel of relPaths || []) {
    if (typeof rel !== 'string' || !rel) continue;
    const abs = nodePath.isAbsolute(rel) ? rel : nodePath.join(root, rel);
    try {
      const buf = fs.readFileSync(abs);
      out[rel] = sha256Hex(buf).slice(0, 8);
    } catch (e) {
      out[rel] = null;
    }
  }
  return out;
}

/** 对比两次快照，返回**被改动/被删**的文件列表（G5 的判据）。 */
export function diffHashes(before, after) {
  const changed = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if ((before || {})[k] !== (after || {})[k]) changed.push(k);
  }
  return changed;
}

/** 内部计划 → **客户端契约形状**（多余字段保留，客户端只读它认识的）。 */
export function toClientRun(run, opts = {}) {
  const nodes = (run.nodes || []).map((n) => ({
    id: n.id,
    role: n.role,
    phase: typeof n.phase === 'number' ? n.phase : 0,
    title: n.title || n.id,
    status: n.status || 'idle',
    ms: typeof n.ms === 'number' ? n.ms : null,
    startedAt: typeof n.startedAt === 'number' ? n.startedAt : null,
    retry: n.retry || 0,
    artifacts: n.artifacts || 0,
    wrote: n.wrote === true,
    // 失败根因必须落盘：scheduler 把错误写在 `node.error` 上，这里不投影就等于丢失
    //（2026-09-14 e2e 实测：run.json 里有 failed 节点却看不到任何 error，只能猜根因）。
    error: typeof n.error === 'string' && n.error ? n.error : null,
    findings: (n.findings || []).map((f) => (typeof f === 'string' ? { severity: 'critical', why: f } : { severity: f.severity || 'critical', path: f.path, line: f.line, why: f.detail || f.why }))
  }));
  return {
    version: run.version || 1,
    runId: run.runId,
    // 发起会话 id（客户端据此只显示「本对话」的运行；旧记录为 null ⇒ 客户端标「来源未知」）
    sessionId: typeof run.sessionId === 'string' && run.sessionId ? run.sessionId : null,
    task: run.task || '',
    mode: run.mode || 'team',
    status: opts.status || run.status || 'running',
    startedAt: run.startedAt || run.createdAt || null,
    endedAt: run.endedAt || null,
    round: run.round || 1,
    maxRounds: run.maxRounds || 2,
    budget: run.budget || { limit: 0, used: 0 },
    // 调度器摘要（峰值并发/墙钟/节点计数）：进程一结束就只剩它，是容量评估与长期运行观测的唯一依据
    summary: run.summary || null,
    acceptance: run.acceptance || [],
    nodes,
    edges: run.edges || [],
    backEdges: run.backEdges || [],
    gate: run.gate || null,
    history: run.history || []
  };
}

export default {
  runsRoot, projectRunsDir, runDirFor, briefFor, saveRun, loadRun, listRuns, progressOf,
  writeNodeBrief, writeNodeResult, appendNodeLog, saveGate, saveDeliverable,
  hashFiles, diffHashes, toClientRun
};
