// src/lib/brain.js
// 诊断决策引擎（闭环自愈）：感知 → 诊断 → 决策（影响评估）→ 执行反馈 → 经验学习。
// 与 loop-detect.js 配合：任何故障循环最多触发有限次自动动作
// （同指纹节流 + 全局预算 + 判环升级 + 安全模式终态），数学上不存在无限重试。
// 设计为纯逻辑模块：不依赖 electron/网络，可独立单元测试，由 main.js 后续接入真实信号源。

const fs = require('fs');
const { LoopDetector } = require('./loop-detect');

// 动作元数据（影响评估表）：level 越低破坏性越小，决策时从低往高尝试
const ACTION_DEFS = {
  retry:         { level: 0, scope: 'none',        destructive: false, expected: '等待后重试检查' },
  restart:       { level: 1, scope: 'service',     destructive: false, expected: '重启 DSH 服务（当前会话中断）' },
  'kill-port':   { level: 2, scope: 'port',        destructive: true,  expected: '终止占用端口的 node/electron 进程（白名单）' },
  'skip-plugin': { level: 3, scope: 'plugin',      destructive: true,  expected: '跳过该插件加载（相关功能降级）' },
  'safe-mode':   { level: 4, scope: 'all-plugins', destructive: true,  expected: '进入安全模式：仅核心功能' },
  notify:        { level: 5, scope: 'none',        destructive: false, expected: '通知用户人工处理' },
};

const LOOP_THRESHOLD = 2;              // 同一指纹累计失败 ≥2 次 → 判环
const THROTTLE_MS = 10 * 60 * 1000;    // 同指纹同动作 10 分钟内限 1 次
const BUDGET_MAX = 10;                 // 全局自动动作上限 / 小时（超限只通知）
const BUDGET_MS = 60 * 60 * 1000;

class Brain {
  /**
   * @param {object} options
   * @param {string} [options.stateFile] 经验表持久化路径（不传 = 内存模式，测试用）
   * @param {Function} [options.clock] 时钟注入（测试可控时间）
   */
  constructor(options = {}) {
    this.stateFile = options.stateFile || null;
    this.clock = options.clock || (() => Date.now());
    this.rules = [];
    this.loop = new LoopDetector(LOOP_THRESHOLD);
    this.experience = {};    // fp -> action -> { ok, fail }
    this.throttle = {};      // fp|action -> [ts...]
    this.budget = [];        // 失败动作时间戳（全局预算）
    this.load();
    this._registerDefaults();
  }

  // ── 规则注册 ─────────────────────────────────────────
  /**
   * 注册规则：pattern 支持完整指纹（'BOOT-004|wait|'）或前缀（'BOOT-004'）
   * @param {string} pattern
   * @param {string[]} actions 候选动作（按破坏等级升序建议，引擎会校验排序）
   */
  registerRule(pattern, actions) {
    const valid = actions.filter((a) => ACTION_DEFS[a]);
    if (valid.length === 0) return;
    // 强制按破坏等级升序存储（引擎保证「低破坏优先」原则，规则作者无需操心顺序）
    valid.sort((a, b) => ACTION_DEFS[a].level - ACTION_DEFS[b].level);
    this.rules.push({ pattern, actions: valid });
  }

  _registerDefaults() {
    // 服务启动/就绪类
    this.registerRule('BOOT-001', ['notify']);
    this.registerRule('BOOT-002', ['restart', 'safe-mode']);
    this.registerRule('BOOT-003', ['restart', 'kill-port', 'notify']);
    this.registerRule('BOOT-004', ['restart', 'kill-port', 'safe-mode']);
    // 渲染类
    this.registerRule('RENDER-001', ['retry', 'restart', 'notify']);
    this.registerRule('RENDER-002', ['retry', 'notify']);
    // 插件类
    this.registerRule('PLG-001', ['skip-plugin', 'safe-mode', 'notify']);
    this.registerRule('PLG-002', ['skip-plugin', 'safe-mode', 'notify']);
    this.registerRule('PLG-003', ['skip-plugin', 'notify']);
  }

  // ── 指纹 ─────────────────────────────────────────────
  fingerprint(event) {
    return [event.code || 'UNKNOWN', event.stage || '', event.key || ''].join('|');
  }

  _matchRule(fp) {
    // 精确匹配优先；否则取匹配的最长前缀规则
    let best = null;
    for (const r of this.rules) {
      if (r.pattern === fp) return r;
      if (fp.startsWith(r.pattern) && (!best || r.pattern.length > best.pattern.length)) best = r;
    }
    return best;
  }

  // ── 决策入口：感知错误/信号 → 输出动作决策（含影响评估） ──
  /**
   * @param {object} event { code, stage, key }
   * @returns {{action:string, fingerprint:string, looped:boolean, impact:object}|null} null = 本次不动作
   */
  emit(event) {
    const fp = this.fingerprint(event);
    const rule = this._matchRule(fp);
    let candidates = rule ? rule.actions.slice() : ['notify'];
    if (candidates.length === 0) candidates = ['notify'];
    // 保底终态：任何规则最后都能落到 notify（不满足则不再自动动作，仅提示用户）
    if (!candidates.includes('notify')) candidates.push('notify');

    // 回环检测：同一指纹累计失败达阈值 → 跳过当前等级及以下，强制升级
    const looped = this.loop.looped(fp);
    if (looped) {
      const curAction = this.loop.lastAction(fp);
      const curLevel = ACTION_DEFS[curAction] ? ACTION_DEFS[curAction].level : -1;
      const higher = candidates.filter((a) => ACTION_DEFS[a].level > curLevel);
      if (higher.length > 0) candidates = higher;
      // 无更高级候选时保留原候选（最终会落到 notify/受限返回 null）
    }

    // 经验排序：等级升序为主，同等级按历史成功率降序
    candidates = this._sortByExperience(fp, candidates);

    // 节流 + 全局预算过滤
    for (const action of candidates) {
      if (this._throttled(fp, action)) continue;
      if (action !== 'notify' && this._budgetExhausted()) continue;
      return { action, fingerprint: fp, looped, impact: this._impact(action) };
    }
    return null;
  }

  // ── 执行反馈：判断动作实际影响，写入经验表 ──
  /**
   * @param {object} event 与 emit 相同的事件
   * @param {string} action 执行的动作
   * @param {boolean} success 实际结果
   */
  report(event, action, success) {
    const fp = this.fingerprint(event);
    const key = fp + '|' + action;
    const now = this.clock();
    const exp = (this.experience[fp] = this.experience[fp] || {});
    const rec = (exp[action] = exp[action] || { ok: 0, fail: 0 });

    if (success) {
      this.loop.reset(fp);
      // 问题解决：解除该指纹的全部节流（重新从最低破坏等级开始）
      for (const k of Object.keys(this.throttle)) {
        if (k.startsWith(fp + '|')) this.throttle[k] = [];
      }
      rec.ok += 1;
    } else {
      this.loop.record(fp, action);
      this.throttle[key] = (this.throttle[key] || []).filter((t) => now - t < THROTTLE_MS);
      this.throttle[key].push(now);
      this.budget = this.budget.filter((t) => now - t < BUDGET_MS);
      this.budget.push(now);        // 失败动作消耗全局预算
      rec.fail += 1;
    }
    this.save();
  }

  // ── 内部：排序 / 节流 / 预算 / 影响 ──
  _sortByExperience(fp, actions) {
    const exp = this.experience[fp] || {};
    return actions.slice().sort((a, b) => {
      const la = ACTION_DEFS[a].level;
      const lb = ACTION_DEFS[b].level;
      if (la !== lb) return la - lb;
      const ea = exp[a];
      const eb = exp[b];
      const ra = ea ? ea.ok / (ea.ok + ea.fail) : 0;
      const rb = eb ? eb.ok / (eb.ok + eb.fail) : 0;
      return rb - ra;
    });
  }

  _throttled(fp, action) {
    const now = this.clock();
    const list = this.throttle[fp + '|' + action] || [];
    return list.some((t) => now - t < THROTTLE_MS);
  }

  _budgetExhausted() {
    const now = this.clock();
    this.budget = this.budget.filter((t) => now - t < BUDGET_MS);
    return this.budget.length >= BUDGET_MAX;
  }

  _impact(action) {
    const d = ACTION_DEFS[action] || ACTION_DEFS.notify;
    return { level: d.level, scope: d.scope, destructive: d.destructive, expected: d.expected };
  }

  // ── 持久化（经验表 / 节流 / 预算，损坏时忽略） ──
  save() {
    if (!this.stateFile) return;
    try {
      const now = this.clock();
      const data = {
        ts: now,
        experience: this.experience,
        throttle: Object.fromEntries(
          Object.entries(this.throttle).map(([k, list]) => [k, list.filter((t) => now - t < THROTTLE_MS)])
        ),
        budget: this.budget.filter((t) => now - t < BUDGET_MS),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (e) { /* 持久化失败不阻断主流程 */ }
  }

  load() {
    if (!this.stateFile) return;
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (d.experience && typeof d.experience === 'object') this.experience = d.experience;
      if (d.throttle && typeof d.throttle === 'object') this.throttle = d.throttle;
      if (Array.isArray(d.budget)) this.budget = d.budget;
    } catch (e) { /* 状态文件损坏则从头开始 */ }
  }
}

module.exports = { Brain, ACTION_DEFS };