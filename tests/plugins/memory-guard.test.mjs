// dsh-memory-guard 判据单测：全部打在纯函数上（零 spawn、零写盘、零 flake）。
//
// 为什么必须常驻：本插件判据是**安全关键**，判错有两个方向：
//   · 漏判（该杀不杀）⇒ 回到 2026-09-14/15 的提交耗尽 + 0x50 蓝屏；
//   · 误判（不该杀却杀）⇒ 杀掉用户合法训练（v0.1 的 count>3 就会打死 workers=4）或 DSH 自身依赖。
// v0.2 修订（2026-09-15）把两条方向性缺陷固化成回归断言：
//   回归 1（度量）：必须用 commit(PageFileUsage)，WS 只作兜底 —— 实测同进程 852MB vs 41MB。
//   回归 2（误杀）：合法 workers=4（1 主 + 4 worker，count=5）**不许**触发。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConfig,
  pathAllowed,
  isCandidate,
  planGuard,
  candidateKey,
  buildQueryScript,
  parseQueryOutput,
  RULES,
  DEFAULT_CONFIG,
} from '../../plugins/dsh-memory-guard/lib/index.js';

const cfg = resolveConfig({});
// mb = 提交(commit) MB，wsMB = 工作集 MB
const proc = (over = {}) => ({
  pp: 1000, nm: 'python.exe', mb: 900, wsMB: 300,
  ep: 'E:\\Anaconda\\envs\\yolov11\\python.exe', st: '2026-09-15T09:29:04.000Z', pi: 0, ...over,
});

test('resolveConfig：默认值与校验（节奏 / 动作 / 提交比例）', () => {
  assert.equal(cfg.minIntervalMs, 15000);
  assert.equal(cfg.maxIntervalMs, 60000);
  assert.equal(cfg.action, 'kill');
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.maxCount, 8, 'count 只作扇出旁证');
  assert.equal(cfg.maxSingleCommitMB, 6000);
  assert.equal(cfg.maxCommitRatio, 0.9);
  assert.deepEqual(cfg.includeImageNames, ['python.exe']);
  assert.throws(() => resolveConfig({ minIntervalMs: 1000 }), /minIntervalMs/);
  assert.throws(() => resolveConfig({ minIntervalMs: 60000, maxIntervalMs: 15000 }), /maxIntervalMs/);
  assert.throws(() => resolveConfig({ action: 'nuke' }), /action/);
  assert.throws(() => resolveConfig({ maxCommitRatio: 1.5 }), /maxCommitRatio/);
  assert.throws(() => resolveConfig({ maxCommitRatio: 0 }), /maxCommitRatio/);
  assert.deepEqual(resolveConfig({ includeImageNames: ['PYTHON.EXE'] }).includeImageNames, ['python.exe']);
  assert.deepEqual(resolveConfig({ includeImageNames: [] }).includeImageNames, ['python.exe']);
});

test('RULES 规则表：数据驱动、id 唯一、谓词可调用（扩展点契约）', () => {
  assert.ok(Array.isArray(RULES) && RULES.length >= 4);
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, '规则 id 必须唯一');
  for (const r of RULES) {
    assert.equal(typeof r.when, 'function', `${r.id} 必须有 when 谓词`);
    assert.equal(typeof r.describe, 'string');
    // 谓词必须容错：异常输入不得抛出（planGuard 依赖这一点）
    assert.doesNotThrow(() => r.when({}, cfg));
    assert.doesNotThrow(() => r.when(undefined, cfg));
  }
});

test('pathAllowed：exclude 优先，且大小写/斜杠无关', () => {
  const c = resolveConfig({ excludePathPrefixes: ['D:\\Deepseek-Harness\\tools'], includePathPrefixes: [] });
  assert.equal(pathAllowed('D:\\Deepseek-Harness\\tools\\markitdown\\.venv\\Scripts\\python.exe', c), false);
  assert.equal(pathAllowed('d:/deepseek-harness/tools/x/python.exe', c), false);
  assert.equal(pathAllowed('E:\\Anaconda\\envs\\yolov11\\python.exe', c), true);
  assert.equal(pathAllowed(null, c), true);
  assert.equal(pathAllowed(undefined, c), true);
  const narrowed = resolveConfig({ includePathPrefixes: ['E:\\Anaconda\\envs\\yolov11'] });
  assert.equal(pathAllowed(null, narrowed), false);
  assert.equal(pathAllowed('E:\\Anaconda\\envs\\yolov11\\python.exe', narrowed), true);
  assert.equal(pathAllowed('E:\\Anaconda\\python.exe', narrowed), false);
});

test('isCandidate：PID 闸门 + 镜像名 + DSH 自身依赖永不入选', () => {
  assert.equal(isCandidate(proc(), cfg), true);
  assert.equal(isCandidate(proc({ pp: 4 }), cfg), false);
  assert.equal(isCandidate(proc({ nm: 'node.exe' }), cfg), false);
  assert.equal(isCandidate(proc({ ep: 'D:\\Deepseek-Harness\\tools\\markitdown\\.venv\\Scripts\\python.exe' }), cfg), false);
});

test('planGuard：平静轮次零动作（误杀方向的第一道锁）', () => {
  const p = planGuard([proc({ mb: 900 })], cfg, { selfPid: 1, availMB: 6000, commitMB: 23000, limitMB: 31000 });
  assert.equal(p.action, 'none');
  assert.deepEqual(p.triggers, []);
  assert.deepEqual(p.targets, []);
  assert.equal(p.stats.count, 1);
});

test('回归 2（关键）：合法训练 workers=4 不得被击杀', () => {
  // 1 主 900MB + 4 worker × 420MB = 5 个进程、合计 2580MB 提交
  const legit = [proc({ pp: 101, mb: 900 }), proc({ pp: 102, mb: 420 }), proc({ pp: 103, mb: 420 }), proc({ pp: 104, mb: 420 }), proc({ pp: 105, mb: 420 })];
  const p = planGuard(legit, cfg, { availMB: 5000, commitMB: 23000, limitMB: 31000 });
  assert.equal(p.action, 'none', 'v0.1 的 count>3 会在这里误杀 —— 本断言锁死修复');
  assert.deepEqual(p.triggers, []);
  assert.equal(p.stats.count, 5);
  // workers=8 但合计提交不高（4.0GB 以内）也不算扇出风暴：count 单独不定罪
  const mid = [proc({ pp: 201, mb: 800 })];
  for (let i = 0; i < 8; i++) mid.push(proc({ pp: 300 + i, mb: 350 }));
  const p2 = planGuard(mid, cfg, { availMB: 5000, commitMB: 23000, limitMB: 31000 });
  assert.deepEqual(p2.triggers, [], 'count=9 但合计提交 3.6GB < 4000 ⇒ 不触发');
});

test('planGuard：扇出 / 单体 / 提交压力 / 低可用 四条规则各自独立生效', () => {
  // ① 扇出：count>8 且 合计提交 > 4000MB（事故形态：主 4.8GB + 25×600MB）
  const swarm = [proc({ pp: 10, mb: 4800 })];
  for (let i = 0; i < 25; i++) swarm.push(proc({ pp: 100 + i, mb: 600 }));
  const pf = planGuard(swarm, cfg, { availMB: 500, commitMB: 30000, limitMB: 31000 });
  assert.ok(pf.triggers.includes('fanout'));
  assert.ok(pf.triggers.includes('commitPressure'));
  assert.equal(pf.action, 'kill');
  assert.equal(pf.stats.count, 26);

  // ② 单体提交失控
  const single = planGuard([proc({ mb: 6500 })], cfg, { availMB: 6000, commitMB: 23000, limitMB: 31000 });
  assert.deepEqual(single.triggers, ['singleCommit']);

  // ③ 系统提交压力（commit/limit > 0.9），候选存在
  const byRatio = planGuard([proc({ mb: 900 })], cfg, { availMB: 4000, commitMB: 29500, limitMB: 31000 });
  assert.deepEqual(byRatio.triggers, ['commitPressure']);
  // 比例阈值边界：0.85 不触发（避免对合法重负载过敏）
  assert.deepEqual(planGuard([proc({ mb: 900 })], cfg, { availMB: 4000, commitMB: 26350, limitMB: 31000 }).triggers, []);

  // ④ 可用物理内存过低（且存在候选）
  const byAvail = planGuard([proc({ mb: 900 })], cfg, { availMB: 500, commitMB: 23000, limitMB: 31000 });
  assert.deepEqual(byAvail.triggers, ['lowAvailable']);
  assert.equal(planGuard([], cfg, { availMB: 100, commitMB: 23000, limitMB: 31000 }).action, 'none', '无候选则不动手');
});

test('回归 1（关键）：度量必须是提交(commit)，WS 仅兜底', () => {
  // 提交膨胀型：commit 800MB，WS 只有 40MB（实测同类差异达 20 倍）—— 必须按 commit 计入
  const inflated = proc({ mb: 800, wsMB: 40 });
  const p = planGuard([inflated], cfg, { availMB: 5000, commitMB: 23000, limitMB: 31000 });
  assert.equal(p.stats.totalMB, 800, '按 commit 计；若按 WS 会只看到 40MB 而漏判');
  assert.equal(p.stats.maxWsMB, 40);
  // 缺 cmb 时兜底到 wsMB（不得算成 0 而漏判）
  const noCommit = { pp: 1001, nm: 'python.exe', wsMB: 4200, ep: 'E:\\x\\python.exe', st: 't', pi: 0 };
  const q = planGuard([noCommit], cfg, { availMB: 5000, commitMB: 23000, limitMB: 31000 });
  assert.equal(q.stats.maxMB, 4200);
  assert.ok(q.triggers.includes('singleCommit') === false, '4200 < 6000 不触发单体');
});

test('planGuard：dryRun / action=notify ⇒ 只告警不设目标（统计仍可见）', () => {
  const swarm = [proc({ pp: 10, mb: 4800 })];
  for (let i = 0; i < 25; i++) swarm.push(proc({ pp: 100 + i, mb: 600 }));
  const dry = planGuard(swarm, resolveConfig({ dryRun: true }), { availMB: 500, commitMB: 30000, limitMB: 31000 });
  assert.equal(dry.action, 'notify');
  assert.deepEqual(dry.targets, []);
  assert.equal(dry.stats.count, 26);
  const ntf = planGuard(swarm, resolveConfig({ action: 'notify' }), { availMB: 500, commitMB: 30000, limitMB: 31000 });
  assert.equal(ntf.action, 'notify');
  assert.deepEqual(ntf.targets, []);
});

test('planGuard：minKillMB 过滤 + maxTargets 限爆炸半径', () => {
  const procs = [proc({ mb: 100 }), proc({ pp: 1001, mb: 350 }), proc({ pp: 1002, mb: 350 }), proc({ pp: 1003, mb: 350 })];
  const p = planGuard(procs, cfg, { availMB: 5000, commitMB: 23000, limitMB: 31000 });
  assert.equal(p.stats.count, 4);
  assert.equal(p.killable.length, 3, '100MB 候选不进入目标');
  // 20 个超阈值候选 ⇒ 目标被 maxTargets(12) 截断，且按 commit 降序
  const many = [];
  for (let i = 0; i < 20; i++) many.push(proc({ pp: 2000 + i, mb: 2000 + i * 10 }));
  const capped = planGuard(many, cfg, { availMB: 500, commitMB: 30000, limitMB: 31000 });
  assert.equal(capped.targets.length, 12);
  assert.equal(capped.targets[0].mb, 2190, '先杀最大提交者');
  assert.ok(capped.targets[0].mb >= capped.targets[11].mb);
});

test('planGuard：selfPid / protectedPids / DSH 直属子进程豁免', () => {
  assert.equal(planGuard([proc({ pp: 999, mb: 6500 })], cfg, { selfPid: 999, commitMB: 23000, limitMB: 31000 }).stats.count, 0);
  assert.equal(planGuard([proc({ pp: 777, mb: 6500 })], cfg, { protectedPids: new Set([777]), commitMB: 23000, limitMB: 31000 }).stats.count, 0);
  // 父进程 = DSH 主进程(4242) ⇒ 豁免；父为 cmd.exe(9999) ⇒ 照常入选
  const p = planGuard([proc({ pp: 1002, mb: 6500, pi: 4242 }), proc({ pp: 1003, mb: 6500, pi: 9999 })], cfg, {
    protectedParentPids: new Set([4242]), commitMB: 23000, limitMB: 31000,
  });
  assert.equal(p.stats.count, 1);
  assert.equal(p.targets[0].pid, 1003);
});

test('planGuard：压力型触发但候选很小 ⇒ 诚实标注（不越界杀无关进程）', () => {
  const p = planGuard([proc({ mb: 320 })], cfg, { availMB: 250, commitMB: 30500, limitMB: 31000 });
  assert.ok(p.triggers.includes('commitPressure'));
  assert.equal(p.pressureNotCausedByCandidates, true, '元凶不在候选范围内时必须标注，供日志/通知说明');
  // 有真正的大候选时不该标
  const q = planGuard([proc({ mb: 6500 })], cfg, { availMB: 250, commitMB: 30500, limitMB: 31000 });
  assert.equal(q.pressureNotCausedByCandidates, false);
});

test('planGuard：抑制表让「杀不掉」的候选不再产生目标（避免无限重试）', () => {
  const p = proc({ mb: 6500 });
  const sup = planGuard([p], cfg, { commitMB: 23000, limitMB: 31000, suppressed: new Set([candidateKey(p)]) });
  assert.ok(sup.triggers.length > 0, '事实仍成立');
  assert.equal(sup.killable.length, 0);
  assert.equal(sup.suppressedSkipped, 1);
});

test('buildQueryScript：查询必须带提交口径字段与镜像过滤（可被外部诊断脚本复用）', () => {
  const s = buildQueryScript(cfg);
  assert.match(s, /PageFileUsage/, '必须查提交电荷（v0.2 的核心修复）');
  assert.match(s, /WorkingSetSize/, 'WS 作兜底/观测');
  assert.match(s, /Name='python\.exe'/);
  assert.match(s, /DSH Desktop\.exe/, '必须查 DSH 主进程 PID 集合（直属子进程豁免闸门）');
  assert.match(s, /FreePhysicalMemory|TotalVirtualMemorySize/);
  assert.match(s, /ConvertTo-Json/);
  // 多变体镜像名 → OR 过滤器；单引号被剥离（防注入）
  const multi = buildQueryScript(resolveConfig({ includeImageNames: ["py'thon.exe", 'python3.exe'] }));
  assert.match(multi, /Name='python.exe' OR Name='python3.exe'/);
});

test('parseQueryOutput：容错解析（单对象 / 缺字段 / cmb 缺失兜底到 WS）', () => {
  const one = parseQueryOutput(JSON.stringify({ mem: { availMB: 100, commitMB: 200, limitMB: 300 }, dshPids: 4242, procs: { pp: 5, pi: 1, nm: 'python.exe', cmb: 700, wmb: 90, ep: 'E:\\a\\python.exe', st: 't' } }));
  assert.equal(one.procs.length, 1);
  assert.equal(one.procs[0].mb, 700);
  assert.equal(one.procs[0].wsMB, 90);
  assert.deepEqual(one.dshPids, [4242]);
  const missing = parseQueryOutput(JSON.stringify({ mem: null, procs: [{ pp: 6, nm: 'python.exe', wmb: 512 }] }));
  assert.equal(missing.procs[0].mb, 512, 'cmb 缺失时兜底 wsMB');
  assert.equal(missing.procs[0].wsMB, 512);
  assert.throws(() => parseQueryOutput('not json'));
});

test('candidateKey：按「路径+启动时间」稳定，PID 复用不会误抑制', () => {
  assert.equal(candidateKey(proc({ pp: 1000 })), candidateKey(proc({ pp: 2000 })));
  assert.notEqual(candidateKey(proc()), candidateKey(proc({ st: '2026-09-15T10:00:00.000Z' })));
  assert.match(candidateKey(proc()), /^ep:.*yolov11.*$/);
});

test('DEFAULT_CONFIG 快照：阈值口径变更必须显式（防静默漂移）', () => {
  assert.equal(DEFAULT_CONFIG.minKillMB, 300);
  assert.equal(DEFAULT_CONFIG.maxTargets, 12);
  assert.equal(DEFAULT_CONFIG.fanoutTotalCommitMB, 4000);
  assert.equal(DEFAULT_CONFIG.minAvailableMB, 700);
  assert.equal(DEFAULT_CONFIG.idleAfterSweeps, 4);
});
