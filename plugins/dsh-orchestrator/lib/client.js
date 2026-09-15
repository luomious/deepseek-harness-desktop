// 编排看板 · 客户端半（P0：部门流程图板）
//
// 作用：向主内容区视图环 conversation.view 注册「编排看板」tab；面板本体是一张**部门流程图**
//   —— 节点 = agent（含角色/状态），边 = 父子委派关系；右侧是选中节点详情；点节点可跳该会话。
//
// ── 尺寸契约（决定"铺满"的关键，实测）──────────────────────────────────
//   宿主把本视图塞进 `.wSkVaW_viewArea{flex-direction:column;flex:1;min-height:0;display:flex}`
//   （`dsh-client-ui-conversation/lib/client.js:7120, 7420-7428`）⇒ 根节点必须
//   `flex:1 1 auto` + `min-height:0` + `height:100%` 才能真正铺满；否则会塌成内容高度。
//
// ── 数据纪律（不违反就会一直是"可信的看板"）────────────────────────────
//   · 只渲染**事实**：会话树来自客户端 store（`sessions.list.getSnapshot()`），host 快照仅作
//     补充/兜底；数据源在界面上**显式标注**（client / host / none）。
//   · 拿不到数据时**明说原因**（横幅），绝不空白、绝不显示假数据。
//   · 「示例预览」是**默认关闭**的排版演示，节点带虚线边框 + 「示例」水印 + 顶部横幅，
//     任何情况下都不写入状态 —— 它只是用来确认版式与交互。
//   · 有界：节点上限 200；父子环/自引用/超深链不死循环（挂死 UI 是这里唯一不可接受的失败）。
//
// ── 数据事实（实测，行号即证据）────────────────────────────────────────
//   客户端 store 行（`dsh-client-runtime/lib/client.js:9216-9237`）：
//     byId[id] = { id, displayTitle, running, completed?, blank, updatedAt, pendingInteraction?,
//                  title?, cwd?, parentId?, origin?, agentPreset? }
//   裸快照源：`sessions.list.getSnapshot()` / `.subscribe()`（`:9840, 9863`）；跳转 `open(id)` /
//   `openSubagent(address)`（`:8967-8999`）。
//   状态词表对齐内核（`dsh-client-ui-workflow-run/lib/client.js:47-63`）：
//     running / completed / failed / cancelled / interrupted ⇒ 我方 running/done/failed/cancelled/blocked。
//
// 手写 lazy-CJS bundle 协议；零依赖（唯一外部 react，由宿主提供）。

window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-orchestrator',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    var STATE_URL = '/orchestrator/state';
    var HOST_POLL_MS = 10000;      // host 快照只是补充/兜底：低频，避免轮询风暴
    var SUBSCRIBE_COALESCE_MS = 120;
    var MAX_NODES = 200;           // 有界渲染
    var MAX_DEPTH = 12;            // 环/超深保护
    var STYLE_ID = 'dsh-orchestrator-p0-style';
    var svgSeq = 0;                // 每次挂载一个唯一的 marker id（多实例共存不冲突）

    // 唯一开关：退役 / 挂载本插件 UI。P0 起挂载（部门流程图板）。
    var FLAGS = { mountUi: true };

    // 尺寸对齐开源实践（React Flow / Airflow / Langfuse / dagre 调研）：节点 200–280 × 80–120、
    // 内边距 12–16、ranksep 50–80、nodesep 50 量级。紧凑档用于"一眼看全局"。
    var DENSITY = {
      normal: { w: 236, h: 96, gapX: 72, gapY: 24, pad: 28, fs: 13, sub: 11, box: '12px 13px' },
      compact: { w: 180, h: 68, gapX: 52, gapY: 16, pad: 20, fs: 12, sub: 10, box: '8px 10px' }
    };

    // ---------- 主题变量（带 fallback，深浅色自适应）----------
    var C = {
      fg: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))',
      mute: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.75))',
      line: 'var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      line3: 'var(--dsw-alias-border-l3, rgba(127,127,127,.45))',
      panel: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05))',
      panel2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.09))',
      base: 'var(--dsw-alias-bg-base, transparent)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
      code: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)',
      blue: 'var(--dsw-alias-state-business-primary, #3b82f6)',
      green: 'var(--dsw-alias-state-success-primary, #10b981)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      err: 'var(--dsw-alias-state-error-primary, #ef4444)',
      shadow: 'var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.18))'
    };

    // 状态语义（对齐内核词表；颜色全部走 token ⇒ 深浅色自动适配）。
    // `glyph` 是**色盲双通道**：仅靠颜色的状态在色觉障碍下会退化成同一个灰块
    // （Airflow 3 的 Grid View 同样用形状区分 ✓/✗/⏸）。
    var STATUS = {
      running: { key: 'running', label: '运行中', color: C.blue, glyph: '▶' },
      done: { key: 'done', label: '已完成', color: C.green, glyph: '✓' },
      blocked: { key: 'blocked', label: '阻塞', color: C.warn, glyph: '⏸' },
      failed: { key: 'failed', label: '失败', color: C.err, glyph: '✕' },
      cancelled: { key: 'cancelled', label: '已取消', color: C.mute, glyph: '⊘' },
      idle: { key: 'idle', label: '待命', color: C.mute, glyph: '○' }
    };
    var STATUS_ORDER = ['running', 'blocked', 'failed', 'done', 'cancelled', 'idle'];

    // ---------- 错误不静默 ----------
    function surfaceError(phase, error) {
      var message = error instanceof Error ? error.message : String(error);
      try { console.error('[dsh-orchestrator] ' + phase + ' error:', error); } catch (e) { /* ignore */ }
      try {
        var bar = document.createElement('div');
        bar.style.cssText =
          'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;' +
          'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;' +
          'border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap';
        bar.textContent = '[dsh-orchestrator] ' + phase + ' error: ' + message;
        document.body.appendChild(bar);
      } catch (e) { /* ignore */ }
    }

    function guarded(Component, name) {
      return function (props) {
        try {
          return Component(props);
        } catch (error) {
          surfaceError(name, error);
          return null;
        }
      };
    }

    var msgOf = function (e) { return String((e && e.message) || e); };

    // ---------- 数据层（S2 已验证，P0 复用）----------

    /** 惰性解析客户端会话服务（ctx.sessions 优先，ctx.reflect 兜底）。 */
    function resolveSessions(ctx) {
      try {
        var direct = ctx.sessions;
        if (direct && direct.list && typeof direct.list.getSnapshot === 'function') return direct;
      } catch (e) { /* next */ }
      try {
        var viaReflect = ctx.reflect && typeof ctx.reflect.get === 'function' ? ctx.reflect.get('sessions') : undefined;
        if (viaReflect && viaReflect.list && typeof viaReflect.list.getSnapshot === 'function') return viaReflect;
      } catch (e) { /* next */ }
      return null;
    }

    function firstString() {
      for (var i = 0; i < arguments.length; i += 1) {
        var v = arguments[i];
        if (typeof v === 'string' && v) return v;
      }
      return null;
    }

    function shortId(id) {
      var s = String(id || '');
      return s.length > 10 ? s.slice(0, 8) + '…' : s;
    }

    /** 角色推断：只依据**真实字段**（preset / origin / 标题关键词），推断不出就老实说「主会话」。 */
    function inferRole(row) {
      var preset = row && row.agentPreset ? String(row.agentPreset) : null;
      var title = (row && (row.title || row.displayTitle)) ? String(row.title || row.displayTitle) : '';
      var origin = row && row.origin ? String(row.origin) : null;
      var probe = (preset || '') + ' ' + title;
      if (/审查|评审|review|audit/i.test(probe)) return { key: 'review', label: '审查', hint: preset || '标题匹配' };
      if (/测试|test|qa|verify|验证/i.test(probe)) return { key: 'test', label: '测试', hint: preset || '标题匹配' };
      if (/汇总|合成|synth|summar|report/i.test(probe)) return { key: 'synth', label: '汇总', hint: preset || '标题匹配' };
      if (/开发|实现|dev|impl|code|coder/i.test(probe)) return { key: 'dev', label: '开发', hint: preset || '标题匹配' };
      if (origin === 'subagent') return { key: 'subagent', label: '子代理', hint: preset || 'origin=subagent' };
      return { key: 'main', label: '主会话', hint: preset || '普通会话' };
    }

    var ROLE_COLOR = {
      dev: C.blue, review: C.warn, test: C.green, synth: '#a78bfa', subagent: C.mute, main: C.sub
    };

    /** 状态推断：只依据真实字段；**running 缺失就标「待命」并在 UI 上注明未知**。 */
    function statusOf(row) {
      if (!row) return STATUS.idle;
      if (row.running === true) return STATUS.running;
      if (row.status && STATUS[row.status]) return STATUS[row.status];
      if (row.completed === true) return STATUS.done;
      if (row.failed === true) return STATUS.failed;
      if (row.cancelled === true) return STATUS.cancelled;
      if (row.blocked === true) return STATUS.blocked;
      if (row.hasRunning === false) return STATUS.idle;
      return STATUS.idle;
    }

    /** 内核 store 的一行 → 渲染行（缺失一律降级，不伪报）。 */
    function projectRow(raw, fallbackId) {
      var r = raw && typeof raw === 'object' ? raw : {};
      var id = typeof r.id === 'string' && r.id ? r.id : String(fallbackId || '');
      var title = firstString(r.displayTitle, r.title, r.cwd);
      if (!title) title = id ? '会话 ' + shortId(id) : '(未知会话)';
      var row = {
        id: id,
        title: title,
        running: r.running === true,
        hasRunning: typeof r.running === 'boolean',
        completed: r.completed === true,
        blank: r.blank === true,
        status: typeof r.status === 'string' ? r.status : null,
        failed: r.failed === true,
        cancelled: r.cancelled === true,
        blocked: r.blocked === true,
        pending: r.pendingInteraction === undefined || r.pendingInteraction === null
          ? null
          : (typeof r.pendingInteraction === 'string' ? r.pendingInteraction : 'yes'),
        updatedAt: typeof r.updatedAt === 'number' && r.updatedAt > 0 ? r.updatedAt : null,
        startedAt: typeof r.createdAt === 'number' && r.createdAt > 0 ? r.createdAt : null,
        cwd: typeof r.cwd === 'string' && r.cwd ? r.cwd : null,
        parentId: typeof r.parentId === 'string' && r.parentId ? r.parentId : null,
        origin: typeof r.origin === 'string' && r.origin ? r.origin : null,
        agentPreset: typeof r.agentPreset === 'string' && r.agentPreset ? r.agentPreset : null,
        tokens: typeof r.tokens === 'number' ? r.tokens : null,
        artifacts: Array.isArray(r.artifacts) ? r.artifacts : null,
        evidence: Array.isArray(r.evidence) ? r.evidence : null,
        gate: typeof r.gate === 'string' ? r.gate : null,
        host: null,
        source: 'client'
      };
      row.role = inferRole(row);
      row.state = statusOf(row);
      return row;
    }

    /** 读一次客户端会话快照。返回 { rows, current, error }；**绝不抛**。 */
    function readClientRows(sessions) {
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') {
        return { rows: [], current: null, error: 'sessions.list.getSnapshot 不可用（客户端会话服务未就绪）' };
      }
      var snap;
      try { snap = sessions.list.getSnapshot(); } catch (e) {
        return { rows: [], current: null, error: 'getSnapshot() 抛错：' + msgOf(e) };
      }
      if (!snap || typeof snap !== 'object') {
        return { rows: [], current: null, error: 'store 快照不是对象（形状变更？）' };
      }
      var byId = snap.byId && typeof snap.byId === 'object' ? snap.byId : {};
      var ids = Array.isArray(snap.ids) ? snap.ids : [];
      var rows = [];
      var seen = {};
      for (var i = 0; i < ids.length; i += 1) {
        var id = ids[i];
        if (typeof id !== 'string' || !id || seen[id]) continue;
        seen[id] = true;
        rows.push(projectRow(byId[id], id));
      }
      if (rows.length === 0) {
        var keys = Object.keys(byId);
        for (var k = 0; k < keys.length; k += 1) if (!seen[keys[k]]) rows.push(projectRow(byId[keys[k]], keys[k]));
      }
      return { rows: rows, current: typeof snap.current === 'string' ? snap.current : null, error: null };
    }

    /** host 快照兜底（host 无 title 权威来源，故只作降级用）。 */
    function rowsFromHost(data) {
      var agents = data && Array.isArray(data.agents) ? data.agents : [];
      var map = {};
      var rows = [];
      for (var i = 0; i < agents.length; i += 1) {
        var a = agents[i] && typeof agents[i] === 'object' ? agents[i] : {};
        var id = typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : ('agent#' + String(a.index != null ? a.index : i));
        var row = projectRow({
          id: id,
          displayTitle: firstString(a.title, a.cwd) || ('agent ' + shortId(id)),
          running: a.running,
          cwd: a.cwd,
          parentId: a.parentSessionId,
          origin: a.origin,
          agentPreset: a.agentPreset
        }, id);
        row.host = a;
        row.source = 'host';
        rows.push(row);
        map[id] = row;
      }
      return { rows: rows, byId: map };
    }

    // ---------- 作用域过滤（把"全部会话"收窄成"你这一条对话"）----------
    // 动机（用户实测反馈 ×2）：
    //   ① 看板原本把 store 里的**所有**会话都画出来（含历史与别的工作区）⇒ 噪音太大；
    //   ② 改成"同工作区"后仍然不对 —— 用户在同一工作区里开着多条**主对话**，cwd 全都相同，
    //      于是"别人那条对话"照样进图。⇒ 默认档必须是「本对话」。
    // 三档语义（**默认 family**）：
    //   family（默认）：当前会话所在会话树的**根**及其全部后代 ≈「本对话 + 它的部门成员」；
    //                   当前会话本身是主对话时，根＝它自己 ⇒ 图里只剩"这一条对话"及其子代理。
    //   workspace      ：cwd 与当前会话相同（**会带上同工作区的其它主对话**，故不再作默认）
    //   all            ：全部（原行为，保留给"就是要看全量"的场景）
    // 拿不到当前会话（store 没给 current）时：**退回显示全部**并把原因写进 UI —— 宁可多，也不要空。
    // ⚠ 诚实边界：`相同目标(goal)` 没有可靠字段可用（会话行里没有 goal 投影），故用「会话树」近似；
    //   将来若有 goal 投影键，可在此处加一档而无需改动其它代码。
    var SCOPE_MODES = ['family', 'workspace', 'all'];
    var SCOPE_LABEL = { family: '本对话', workspace: '同工作区', all: '全部' };

    function normCwd(v) {
      return typeof v === 'string' && v ? v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null;
    }

    /** 从某会话向上走到所在树的根（带 seen + MAX_DEPTH 防环）。 */
    function rootOf(byId, id) {
      if (!id || !byId[id]) return null;
      var root = id;
      var seen = {};
      seen[root] = true;
      var p = byId[root].parentId;
      var guard = 0;
      while (p && byId[p] && !seen[p] && guard < MAX_DEPTH) {
        seen[p] = true;
        root = p;
        p = byId[p].parentId;
        guard += 1;
      }
      return root;
    }

    /** 反复扫描把"父在集合里"的行收进来（rows 有界 ⇒ 收敛快；环不会导致死循环）。 */
    function closeDescendants(rows, keep) {
      var changed = true;
      while (changed) {
        changed = false;
        for (var i = 0; i < rows.length; i += 1) {
          var r = rows[i];
          if (keep[r.id]) continue;
          if (r.parentId && keep[r.parentId]) { keep[r.id] = true; changed = true; }
        }
      }
      return keep;
    }

    function scopeRows(rows, current, mode) {
      var m = SCOPE_MODES.indexOf(mode) >= 0 ? mode : 'family';
      var byId = {};
      var i;
      for (i = 0; i < rows.length; i += 1) byId[rows[i].id] = rows[i];
      var hasCurrent = !!(current && byId[current]);
      var root = hasCurrent ? rootOf(byId, current) : null;
      var keep = {};
      var reason = null;
      if (m === 'all' || !hasCurrent) {
        for (i = 0; i < rows.length; i += 1) keep[rows[i].id] = true;
        if (m !== 'all' && !hasCurrent) reason = '拿不到当前会话（store 未给出 current）⇒ 暂显示全部，无法判定范围';
      } else if (m === 'family') {
        keep[root] = true;
        closeDescendants(rows, keep);
      } else {
        var baseCwd = normCwd(byId[current].cwd);
        if (!baseCwd) {
          for (i = 0; i < rows.length; i += 1) keep[rows[i].id] = true;
          reason = '当前会话没有 cwd ⇒ 暂显示全部，无法按工作区过滤';
        } else {
          for (i = 0; i < rows.length; i += 1) if (normCwd(rows[i].cwd) === baseCwd) keep[rows[i].id] = true;
          keep[current] = true;                    // 当前会话必留
          closeDescendants(rows, keep);            // 它的"部门成员"也必留
        }
      }
      var out = [];
      var hidden = 0;
      for (i = 0; i < rows.length; i += 1) {
        if (keep[rows[i].id]) out.push(rows[i]);
        else hidden += 1;
      }
      return { rows: out, hidden: hidden, mode: m, rootId: root, baseCwd: hasCurrent ? normCwd(byId[current].cwd) : null, error: reason };
    }

    // ---------- 运行归属过滤（同一项目下多对话共享 projectId ⇒ 必须按"发起会话"归属）----------
    /**
     * 从运行列表里挑出"该看哪一条"。
     * 规则：**本对话的优先**（哪怕它不是最新一条）；一条都没有时**默认不显示别对话的**
     * （`includeOthers=false` ⇒ pick=null，由调用方走空态/会话树回退），只在显式开启后才回退到最新一条。
     * `others` 始终如实统计"别对话还有几条"，供 UI 说明（不静默吞掉事实）。
     * ⚠ 旧记录（没有 `sessionId` 字段）无法归属 ⇒ 不算本对话，只能标「来源未知」。
     */
    function pickRun(list, currentId, includeOthers) {
      var arr = Array.isArray(list) ? list : [];
      var mine = null;
      var others = 0;
      var i;
      for (i = 0; i < arr.length; i += 1) {
        var r = arr[i];
        if (!r || typeof r !== 'object') continue;
        if (currentId && typeof r.sessionId === 'string' && r.sessionId === currentId) {
          if (!mine) mine = r;
        } else {
          others += 1;
        }
      }
      if (mine) return { pick: mine, mine: true, others: others };
      if (includeOthers && arr.length) return { pick: arr[0], mine: false, others: others };
      return { pick: null, mine: false, others: others };
    }

    // ---------- 图构建（纯函数，可单测）----------

    /**
     * 分层布局：层 = 从根算起的最长路径（列），层内自上而下堆叠并**垂直居中**（避免锯齿）。
     * 同时计算 depth（带 seen 集合 + MAX_DEPTH ⇒ 环/自引用/超深链不死循环）与 orphan 标记。
     */
    function layeredLayout(rows, opts) {
      var dense = DENSITY[(opts && opts.density) || 'normal'] || DENSITY.normal;
      // layerOf：显式分层（运行视图用「阶段序号」当层，比拓扑深度更符合人的预期）；
      // 不提供时退回"父子深度"（会话树视图），行为与既有测试完全一致。
      var layerOf = opts && typeof opts.layerOf === 'function' ? opts.layerOf : null;
      var byId = {};
      var i;
      for (i = 0; i < rows.length; i += 1) byId[rows[i].id] = rows[i];
      for (i = 0; i < rows.length; i += 1) {
        var r0 = rows[i];
        if (layerOf) {
          var L = layerOf(r0);
          r0.depth = Math.max(0, Math.min(MAX_DEPTH, typeof L === 'number' && isFinite(L) ? L : 0));
          r0.orphan = false;
          continue;
        }
        var r = rows[i];
        var depth = 0;
        var seen = {};
        seen[r.id] = true;
        var p = r.parentId;
        while (p && byId[p] && !seen[p] && depth < MAX_DEPTH) {
          seen[p] = true;
          depth += 1;
          p = byId[p].parentId;
        }
        r.depth = depth;
        r.orphan = !!(r.parentId && !byId[r.parentId]);
      }
      // 层内顺序：显式分层时保持传入顺序（= 声明顺序）；否则用"父在前子紧随"的稳定 DFS
      var ordered = [];
      if (layerOf) {
        ordered = rows.slice();
      } else {
      var childrenOf = {};
      var roots = [];
      for (i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var parent = row.parentId && byId[row.parentId] && row.parentId !== row.id ? row.parentId : null;
        if (parent) {
          if (!childrenOf[parent]) childrenOf[parent] = [];
          childrenOf[parent].push(row);
        } else roots.push(row);
      }
      var visited = {};
      var stack = [];
      for (i = roots.length - 1; i >= 0; i -= 1) stack.push(roots[i]);
      while (stack.length) {
        var cur = stack.pop();
        if (visited[cur.id]) continue;
        visited[cur.id] = true;
        ordered.push(cur);
        var kids = childrenOf[cur.id];
        if (kids) for (var j = kids.length - 1; j >= 0; j -= 1) stack.push(kids[j]);
      }
      for (i = 0; i < rows.length; i += 1) if (!visited[rows[i].id]) ordered.push(rows[i]);
      }

      var columns = [];
      for (i = 0; i < ordered.length; i += 1) {
        var d = Math.min(ordered[i].depth, MAX_DEPTH);
        if (!columns[d]) columns[d] = [];
        columns[d].push(ordered[i]);
      }
      var maxRows = 0;
      for (i = 0; i < columns.length; i += 1) if (columns[i] && columns[i].length > maxRows) maxRows = columns[i].length;
      var stepY = dense.h + dense.gapY;
      var positions = {};
      var layerCount = 0;
      for (i = 0; i < columns.length; i += 1) {
        var col = columns[i];
        if (!col) continue;
        layerCount += 1;
        var offsetY = (maxRows - col.length) * stepY / 2;
        for (var k = 0; k < col.length; k += 1) {
          positions[col[k].id] = {
            x: dense.pad + i * (dense.w + dense.gapX),
            y: dense.pad + offsetY + k * stepY,
            w: dense.w,
            h: dense.h,
            layer: i,
            index: k
          };
          col[k].pos = positions[col[k].id];
        }
      }
      var width = dense.pad * 2 + Math.max(0, columns.length) * dense.w + Math.max(0, columns.length - 1) * dense.gapX;
      var height = dense.pad * 2 + Math.max(1, maxRows) * dense.h + Math.max(0, maxRows - 1) * dense.gapY;
      return { positions: positions, ordered: ordered, layers: columns.length, layerCount: layerCount, width: width, height: height, density: dense };
    }

    /** 正交折线：源右侧中点 → 中点竖线 → 目标左侧中点（视觉上最不容易穿过节点）。 */
    function edgePath(from, to) {
      var x1 = from.x + from.w;
      var y1 = from.y + from.h / 2;
      var x2 = to.x;
      var y2 = to.y + to.h / 2;
      var mx = x1 + Math.max(14, (x2 - x1) / 2);
      return 'M ' + Math.round(x1) + ' ' + Math.round(y1) +
        ' H ' + Math.round(mx) +
        ' V ' + Math.round(y2) +
        ' H ' + Math.round(x2);
    }

    /** 驳回回边：从源节点**底部**下探到图外通道，横穿后再上到目标节点底部（不穿节点）。 */
    function backEdgePath(from, to, busY) {
      var x1 = from.x + from.w / 2;
      var y1 = from.y + from.h;
      var x2 = to.x + to.w / 2;
      var y2 = to.y + to.h;
      var y = Math.round(busY);
      return 'M ' + Math.round(x1) + ' ' + Math.round(y1) +
        ' V ' + y + ' H ' + Math.round(x2) + ' V ' + Math.round(y2);
    }

    /**
     * 行数组 → 图。
     * @param opts.layerOf      显式分层（运行视图 = 阶段序号；缺省 = 父子深度）
     * @param opts.groupLabels  阶段名（下标 = 层号）⇒ 额外产出 `groups` 阶段框
     * @param opts.edges        显式边（运行视图用；缺省 = 由 parentId 推导）
     * @param opts.backEdges    驳回回边（走图外通道）
     */
    function buildGraph(rows, opts) {
      var o = opts || {};
      var layout = layeredLayout(rows, o);
      var edges = [];
      var i;
      if (Array.isArray(o.edges)) {
        for (i = 0; i < o.edges.length; i += 1) {
          var e = o.edges[i] || {};
          var ef = layout.positions[e.from];
          var et = layout.positions[e.to];
          if (!ef || !et) continue;
          edges.push({ id: e.from + '>' + e.to, from: e.from, to: e.to, d: edgePath(ef, et) });
        }
      } else {
        for (i = 0; i < layout.ordered.length; i += 1) {
          var r = layout.ordered[i];
          if (!r.parentId) continue;
          var from = layout.positions[r.parentId];
          var to = layout.positions[r.id];
          if (!from || !to || from === to) continue;
          edges.push({ id: r.parentId + '>' + r.id, from: r.parentId, to: r.id, d: edgePath(from, to) });
        }
      }
      // 阶段框（Group Node）：按层聚合节点的包围盒，附进度 n/m（Argo / React Flow Sub Flows 的惯例）
      var groups = [];
      if (Array.isArray(o.groupLabels) && o.groupLabels.length) {
        for (var L = 0; L < o.groupLabels.length; L += 1) {
          var members = [];
          for (i = 0; i < layout.ordered.length; i += 1) if (layout.ordered[i].depth === L) members.push(layout.ordered[i]);
          if (!members.length) continue;
          var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          var done = 0, running = 0, blocked = 0, failed = 0;
          for (i = 0; i < members.length; i += 1) {
            var p = members[i].pos;
            if (!p) continue;
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x + p.w > maxX) maxX = p.x + p.w;
            if (p.y + p.h > maxY) maxY = p.y + p.h;
            var k = members[i].state.key;
            if (k === 'done') done += 1;
            else if (k === 'running') running += 1;
            else if (k === 'blocked') blocked += 1;
            else if (k === 'failed') failed += 1;
          }
          if (!isFinite(minX)) continue;
          var padX = 14, padTop = 34, padBottom = 16;
          groups.push({
            key: 'g' + L, layer: L, label: o.groupLabels[L],
            x: minX - padX, y: minY - padTop,
            w: (maxX - minX) + padX * 2, h: (maxY - minY) + padTop + padBottom,
            progress: { done: done, total: members.length, running: running, blocked: blocked, failed: failed },
            members: members.map(function (m) { return m.id; })
          });
        }
      }
      // 回边走阶段框下方的专用通道（busY），避免穿越节点
      var backEdges = [];
      var graphBottom = layout.height;
      for (i = 0; i < groups.length; i += 1) if (groups[i].y + groups[i].h > graphBottom) graphBottom = groups[i].y + groups[i].h;
      if (Array.isArray(o.backEdges)) {
        for (i = 0; i < o.backEdges.length; i += 1) {
          var b = o.backEdges[i] || {};
          var bf = layout.positions[b.from];
          var bt = layout.positions[b.to];
          if (!bf || !bt) continue;
          var bus = graphBottom + 26 + i * 22;
          backEdges.push({
            id: 'back:' + b.from + '>' + b.to, from: b.from, to: b.to,
            label: b.label || '驳回', busY: bus,
            labelX: (bf.x + bf.w / 2 + bt.x + bt.w / 2) / 2,
            labelY: bus - 6,
            d: backEdgePath(bf, bt, bus)
          });
        }
      }
      var height = layout.height;
      for (i = 0; i < backEdges.length; i += 1) height = Math.max(height, backEdges[i].busY + 18);
      return {
        nodes: layout.ordered,
        edges: edges,
        groups: groups,
        backEdges: backEdges,
        width: layout.width,
        height: height,
        layers: layout.layerCount,
        density: layout.density
      };
    }

    /** 示例数据（默认关闭）：只用于确认版式与交互，**不写入任何状态**。 */
    function demoRows() {
      var now = Date.now();
      function mk(id, title, extra) {
        var r = projectRow(Object.assign({
          id: id, displayTitle: title, running: false, updatedAt: now
        }, extra || {}), id);
        r.source = 'demo';   // 示例必须自证身份：UI 据此画虚线边框 + 「示例」水印 + 顶部横幅
        return r;
      }
      return [
        mk('demo:task', '任务：给设置页加暗色开关（示例）', { running: true }),
        mk('demo:dev', '开发 · 实现开关与持久化（示例）', { parentId: 'demo:task', agentPreset: 'dev' }),
        mk('demo:review', '审查 · 检查边界与无障碍（示例）', { parentId: 'demo:dev', agentPreset: 'review' }),
        mk('demo:test', '测试 · 证明改前失败改后通过（示例）', { parentId: 'demo:dev', agentPreset: 'test', running: true }),
        mk('demo:synth', '汇总 · 合成交付（示例）', { parentId: 'demo:review', agentPreset: 'synth' })
      ];
    }

    // ---------- 运行模型（P0.2：运行驱动的部门流程图）----------
    // 数据契约（P1 由 host 的 `GET /orchestrator/run/<id>` 提供**同形状**真实数据；客户端只认这个形状
    // ⇒ 接口稳定、可单测，P1 只需把数据源从 demoRun() 换成 fetch）。
    // 逻辑 8 阶段 → 视觉 6 个阶段框（框少一点更清楚）：
    //   ①判定 + ②规划 → 「① 判定与规划」；③执行；④汇总；⑤审查；⑥测试；⑦验收 + ⑧结束 → 「⑥ 验收与结束」
    var RUN_PHASES = ['① 判定与规划', '② 执行', '③ 汇总', '④ 审查', '⑤ 测试', '⑥ 验收与结束'];

    var ROLE_LABEL = {
      plan: '规划', dev: '开发', synth: '汇总', review: '审查', test: '测试', accept: '验收',
      subagent: '子代理', main: '主会话'
    };

    function fmtMs(ms) {
      if (typeof ms !== 'number' || ms < 0) return '—';
      if (ms < 1000) return String(Math.round(ms)) + 'ms';
      var s = ms / 1000;
      if (s < 60) return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 's';
      var m = Math.floor(s / 60);
      return String(m) + 'm ' + String(Math.round(s - m * 60)) + 's';
    }

    /** 一个 run 节点 → 渲染行（与会话行共用同一套卡片/详情组件）。 */
    function runNodeRow(node, phaseIndex) {
      var roleKey = ROLE_LABEL[node.role] ? node.role : 'main';
      var st = STATUS[node.status] || STATUS.idle;
      return {
        id: node.id,
        title: node.title || node.id,
        role: { key: roleKey, label: ROLE_LABEL[roleKey], hint: 'run.role=' + String(node.role) },
        state: st,
        layer: typeof phaseIndex === 'number' ? phaseIndex : (typeof node.phase === 'number' ? node.phase : 0),
        ms: typeof node.ms === 'number' ? node.ms : null,
        startedAt: typeof node.startedAt === 'number' ? node.startedAt : null,
        retry: typeof node.retry === 'number' ? node.retry : 0,
        artifacts: Array.isArray(node.artifacts) ? node.artifacts.length : (typeof node.artifacts === 'number' ? node.artifacts : 0),
        findings: Array.isArray(node.findings) ? node.findings : null,
        wrote: node.wrote === true,
        parentId: null, cwd: null, agentPreset: null, origin: null,
        hasRunning: true, updatedAt: null,
        source: 'demo', isRun: true
      };
    }

    /** 示例运行：覆盖 done / running / blocked / idle 四态 + 一次「审查驳回 → 第 2 轮修复」。 */
    function demoRun() {
      return {
        runId: 'demo-run-1',
        task: '给设置页加一个暗色开关，并保证现有主题无回归（示例运行）',
        status: 'running',
        startedAt: Date.now() - 128000,
        round: 2,
        maxRounds: 2,
        budget: { limit: 60000, used: 21500 },
        acceptance: [
          { id: 'A1', text: '设置页可切换暗色 / 浅色' },
          { id: 'A2', text: '刷新后保持所选主题' },
          { id: 'A3', text: '现有主题无回归' }
        ],
        nodes: [
          { id: 'r:judge', role: 'plan', phase: 0, title: '判定 team · 拆 3 个子任务', status: 'done', ms: 2400, artifacts: 1 },
          { id: 'r:plan', role: 'plan', phase: 0, title: '冻结验收标准 A1–A3 + 依赖图', status: 'done', ms: 5800, artifacts: 1 },
          { id: 'r:dev1', role: 'dev', phase: 1, title: '第 1 轮：实现开关与持久化（唯一可写）', status: 'done', ms: 41200, artifacts: 3, wrote: true },
          { id: 'r:synth1', role: 'synth', phase: 2, title: '合成交付草案 + 证据索引', status: 'done', ms: 6100, artifacts: 1 },
          {
            id: 'r:review1', role: 'review', phase: 3, title: '审查边界与无障碍', status: 'blocked', ms: 12400, artifacts: 1,
            findings: [{ severity: 'critical', path: 'src/settings/theme.ts', line: 42, why: '缺少系统偏好回退，暗色开关会覆盖用户系统设置' }]
          },
          { id: 'r:dev2', role: 'dev', phase: 1, title: '第 2 轮：修复驳回项', status: 'running', startedAt: Date.now() - 9800, retry: 1, artifacts: 1, wrote: true },
          { id: 'r:test', role: 'test', phase: 4, title: '证明改前失败 / 改后通过', status: 'idle', ms: null, artifacts: 0 },
          { id: 'r:accept', role: 'accept', phase: 5, title: '逐条对照 A1–A3', status: 'idle', ms: null, artifacts: 0 }
        ],
        edges: [
          { from: 'r:judge', to: 'r:plan' },
          { from: 'r:plan', to: 'r:dev1' },
          { from: 'r:dev1', to: 'r:synth1' },
          { from: 'r:synth1', to: 'r:review1' },
          { from: 'r:review1', to: 'r:test' },
          { from: 'r:test', to: 'r:accept' }
        ],
        backEdges: [{ from: 'r:review1', to: 'r:dev2', label: '审查驳回 · 回到修复（第 2 轮）' }]
      };
    }

    /** run → 渲染行（按阶段分层）。 */
    function runToRows(run) {
      var out = [];
      if (!run || !Array.isArray(run.nodes)) return out;
      for (var i = 0; i < run.nodes.length; i += 1) out.push(runNodeRow(run.nodes[i], run.nodes[i].phase));
      return out;
    }

    /** 跳转：子代理走 openSubagent(address)，普通会话走 open(id)；失败弹横幅。 */
    function focusSession(sessions, row) {
      try {
        if (!sessions) throw new Error('客户端会话服务不可用，无法跳转');
        if (row && row.parentId && typeof sessions.subagentAddress === 'function' && typeof sessions.openSubagent === 'function') {
          var addr = sessions.subagentAddress(row.id);
          if (addr) { sessions.openSubagent(addr); return 'subagent'; }
        }
        if (typeof sessions.open === 'function') { sessions.open(row.id); return 'open'; }
        throw new Error('sessions.open 不可用');
      } catch (e) {
        surfaceError('focusSession', e);
        return 'error';
      }
    }

    // ---------- 注入式样式（hover / 选中 / 滚动条 / 动画；幂等、绝不抛）----------
    function ensureStyle() {
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
        if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID)) return;
        var css = [
          '[data-orch-canvas]{scrollbar-width:thin}',
          '[data-orch-canvas]::-webkit-scrollbar{width:10px;height:10px}',
          '[data-orch-canvas]::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35));border-radius:999px}',
          '[data-orch-node]{transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease,background-color .12s ease}',
          '[data-orch-node]:hover{transform:translateY(-2px);box-shadow:var(--dsw-shadow-lv2,0 3px 10px rgba(0,0,0,.18));border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.55))}',
          '[data-orch-node]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3b82f6);outline-offset:2px}',
          '[data-orch-node][data-orch-selected="1"]{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#3b82f6),var(--dsw-shadow-lv2,0 3px 10px rgba(0,0,0,.18))}',
          '[data-orch-node][data-orch-dim="1"]{opacity:.45}',
          '[data-orch-chip],[data-orch-btn]{transition:background-color .12s ease,border-color .12s ease,color .12s ease}',
          '[data-orch-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.55))}',
          '[data-orch-chip]:hover{color:var(--dsw-alias-label-primary,inherit)}',
          '@keyframes dshOrchPulse{0%,100%{opacity:1}50%{opacity:.35}}',
          '[data-orch-dot="running"]{animation:dshOrchPulse 1.4s ease-in-out infinite}',
          // 运行中的边用"流动虚线"表达（Airflow / React Flow 的 animated edge 惯例）：
          // 让人一眼看出"这条委派关系正在传输中"，而不是静态连线。
          '@keyframes dshOrchFlow{to{stroke-dashoffset:-22}}',
          '[data-orch-edge-live="1"]{animation:dshOrchFlow 1s linear infinite}',
          '@media (prefers-reduced-motion:reduce){[data-orch-node]{transition:none}[data-orch-dot="running"]{animation:none}[data-orch-edge-live="1"]{animation:none}}'
        ].join('\n');
        var el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = css;
        var host = document.head || document.body;
        if (host && typeof host.appendChild === 'function') host.appendChild(el);
      } catch (e) { /* 样式失败不影响功能 */ }
    }

    // ---------- 小组件 ----------
    function Chip(props) {
      return h('span', {
        style: Object.assign({
          font: '11px/16px ' + C.code, padding: '1px 7px', borderRadius: '9px',
          border: '1px solid ' + C.line, color: C.mute, whiteSpace: 'nowrap'
        }, props.style || {}),
        'data-orch-chip': props.marker || '1',
        title: props.title || undefined
      }, props.text);
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        'data-orch-btn': props.marker || '1',
        title: props.title || undefined,
        disabled: props.disabled === true,
        onClick: props.onClick,
        style: Object.assign({
          font: '11px/16px ' + C.code, padding: '3px 9px', borderRadius: '6px',
          border: '1px solid ' + C.line, background: 'transparent', color: C.fg,
          cursor: props.disabled === true ? 'default' : 'pointer', opacity: props.disabled === true ? 0.5 : 1
        }, props.style || {})
      }, props.text);
    }

    function Dot(props) {
      var st = props.state || STATUS.idle;
      return h('span', {
        'data-orch-dot': st.key,
        style: {
          width: '8px', height: '8px', borderRadius: '999px', background: st.color,
          boxShadow: '0 0 0 3px color-mix(in srgb, ' + st.color + ' 22%, transparent)',
          flex: 'none', display: 'inline-block'
        }
      });
    }

    // ---------- 节点卡片 ----------
    function NodeCard(props) {
      var n = props.node;
      var d = props.density;
      var st = n.state;
      var selected = props.selected === true;
      var dim = props.hasSelection === true && !selected && props.connected !== true;
      var roleColor = ROLE_COLOR[n.role.key] || C.sub;
      // 实时耗时：运行中的节点用 startedAt 算（诚实：不伪造时间），其余用数据里的 ms
      var elapsed = n.state.key === 'running' && n.startedAt ? Math.max(0, (props.now || Date.now()) - n.startedAt) : n.ms;
      var meta = [];
      if (n.agentPreset) meta.push('preset=' + n.agentPreset);
      if (n.origin) meta.push(n.origin);
      if (n.isRun) {
        if (elapsed != null) meta.push('⏱ ' + fmtMs(elapsed));
        if (n.artifacts > 0) meta.push('产物 ' + String(n.artifacts));
        if (n.wrote) meta.push('可写');
      } else if (n.depth > 0) {
        meta.push('L' + n.depth);
      }
      if (!n.isRun && n.updatedAt) meta.push(new Date(n.updatedAt).toLocaleTimeString());
      // 密度降级：缩得太小时只留状态色块（防信息过载，Argo/React Flow 的常见做法）
      if (props.dense) {
        return h('button', {
          type: 'button',
          'data-orch-node': n.id,
          'data-orch-status': st.key,
          'data-orch-dense': '1',
          title: n.title + '（' + st.label + '）',
          onClick: props.onSelect,
          onDoubleClick: props.onFocus,
          style: {
            position: 'absolute',
            left: String(n.pos.x) + 'px', top: String(n.pos.y) + 'px',
            width: String(d.w) + 'px', height: String(d.h) + 'px',
            boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '6px', border: '1px solid ' + st.color, borderRadius: '10px',
            background: C.panel, color: st.color, cursor: 'pointer'
          }
        }, h('span', { style: { fontSize: '16px' } }, st.glyph));
      }
      return h('button', {
        type: 'button',
        'data-orch-node': n.id,
        'data-orch-status': st.key,
        'data-orch-role': n.role.key,
        'data-orch-selected': selected ? '1' : '0',
        'data-orch-dim': dim ? '1' : '0',
        'data-orch-demo': n.source === 'demo' ? '1' : '0',
        'data-orch-elapsed': n.isRun && elapsed != null ? String(Math.round(elapsed)) : undefined,
        'data-orch-retry': n.retry ? String(n.retry) : undefined,
        title: n.title + '\n' + n.id,
        onClick: props.onSelect,
        onDoubleClick: props.onFocus,
        style: {
          position: 'absolute',
          left: String(n.pos.x) + 'px',
          top: String(n.pos.y) + 'px',
          width: String(d.w) + 'px',
          height: String(d.h) + 'px',
          boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: '4px',
          padding: d.box,
          textAlign: 'left',
          zIndex: selected ? 3 : (props.hovered === n.id ? 2 : 1),
          border: (n.source === 'demo' ? '1px dashed ' : '1px solid ') + (selected ? C.blue : C.line),
          borderRadius: '10px',
          background: selected ? C.panel2 : C.panel,
          color: C.fg,
          cursor: 'pointer',
          overflow: 'hidden'
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h(Dot, { state: st }),
          h('span', {
            style: {
              font: '10px/14px ' + C.code, padding: '0 6px', borderRadius: '999px',
              border: '1px solid ' + roleColor, color: roleColor, flex: 'none'
            }
          }, n.role.label),
          n.retry ? h('span', {
            'data-orch-retry-badge': String(n.retry),
            title: '重试次数',
            style: {
              font: '10px/14px ' + C.code, padding: '0 5px', borderRadius: '999px',
              border: '1px solid ' + C.warn, color: C.warn, flex: 'none'
            }
          }, '⟳ ' + String(n.retry)) : null,
          h('span', {
            style: { fontSize: String(d.sub) + 'px', color: st.color, marginLeft: 'auto', flex: 'none' }
          }, st.glyph + ' ' + st.label),
          n.source === 'demo' ? h('span', { style: { font: '10px/14px ' + C.code, color: C.mute } }, '示例') : null
        ),
        h('div', {
          style: {
            fontSize: String(d.fs) + 'px', fontWeight: 500, lineHeight: '17px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }
        }, n.title),
        h('div', {
          style: {
            font: String(d.sub) + 'px/14px ' + C.code, color: C.mute,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }
        }, meta.join(' · ') || shortId(n.id)),
        n.findings && n.findings.length
          ? h('div', { style: { font: String(d.sub) + 'px/14px ' + C.code, color: C.err, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            '⛔ ' + String(n.findings.length) + ' 项阻断（' + String(n.findings[0].severity || '') + '）')
          : null,
        n.pending ? h('div', { style: { font: String(d.sub) + 'px/14px ' + C.code, color: C.warn } }, '待应答') : null
      );
    }

    // ---------- 图区 ----------
    function GraphPane(props) {
      var canvasRef = React.useRef(null);
      var markerRef = React.useRef(null);
      if (!markerRef.current) { svgSeq += 1; markerRef.current = 'dsh-orch-arrow-' + String(svgSeq); }
      var markerId = markerRef.current;
      var scrollState = React.useState({ x: 0, y: 0 });
      var scroll = scrollState[0];
      var setScroll = scrollState[1];
      var sizeState = React.useState({ w: 0, h: 0 });
      var size = sizeState[0];
      var setSize = sizeState[1];
      var g = props.graph;
      var d = g.density;
      var edgeColor = C.line3;
      // 折叠阶段里的节点不渲染（边/回边同样按端点隐藏），但**阶段框仍保留可点开的标题**
      var hiddenDepth = {};
      (function () {
        var collapsed = props.collapsed || {};
        for (var k = 0; k < g.nodes.length; k += 1) if (collapsed[g.nodes[k].depth]) hiddenDepth[g.nodes[k].id] = true;
      })();

      // 量画布尺寸（供 minimap 与"适应"用）；拿不到就退回 0，相关部件自动隐藏
      React.useEffect(function () {
        var el = canvasRef.current;
        function apply() {
          try {
            if (!el || typeof el.getBoundingClientRect !== 'function') return;
            var r = el.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
          } catch (e) { /* ignore */ }
        }
        apply();
        var ro = null;
        try {
          if (typeof ResizeObserver === 'function' && el) { ro = new ResizeObserver(apply); ro.observe(el); }
        } catch (e) { ro = null; }
        return function () { if (ro && typeof ro.disconnect === 'function') ro.disconnect(); };
      }, []);

      // >8 个节点才给 minimap（开源惯例：小图上多一块缩略图只是噪音）；
      // 位置依赖可见尺寸，拿不到尺寸时按 (8,8) 兜底而不是整块消失。
      var showMini = g.nodes.length > 8 && g.width > 0 && g.height > 0;
      var miniW = 168;
      var miniH = 96;
      var miniScale = showMini ? Math.min(miniW / g.width, miniH / g.height) : 1;
      // 内容坐标 = 屏幕坐标 / zoom（内层是 transform: scale(zoom)）
      var vx = (scroll.x / props.zoom) * miniScale;
      var vy = (scroll.y / props.zoom) * miniScale;
      var vw = (size.w / props.zoom) * miniScale;
      var vh = (size.h / props.zoom) * miniScale;

      return h('div', {
        'data-orch-canvas': '1',
        ref: canvasRef,
        onScroll: function (ev) {
          try {
            var t = ev && ev.target ? ev.target : null;
            if (t) setScroll({ x: t.scrollLeft || 0, y: t.scrollTop || 0 });
          } catch (e) { /* ignore */ }
        },
        style: {
          position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0,
          overflow: 'auto', border: '1px solid ' + C.line, borderRadius: '12px',
          background: C.base
        }
      },
        h('div', {
          style: {
            position: 'relative',
            width: String(Math.max(g.width, 320)) + 'px',
            height: String(Math.max(g.height, 200)) + 'px',
            transform: 'scale(' + String(props.zoom) + ')',
            transformOrigin: '0 0'
          }
        },
          // 阶段框（Group Node）：画在最底层；折叠后只留一行标题（仍可点开，不会丢失入口）
          (g.groups || []).map(function (grp) {
            var isCollapsed = !!(props.collapsed && props.collapsed[grp.layer]);
            var pr = grp.progress;
            return h('div', {
              key: grp.key,
              'data-orch-group': String(grp.layer),
              'data-orch-group-collapsed': isCollapsed ? '1' : '0',
              style: {
                position: 'absolute',
                left: String(grp.x) + 'px', top: String(grp.y) + 'px',
                width: String(grp.w) + 'px', height: String(isCollapsed ? 30 : grp.h) + 'px',
                boxSizing: 'border-box',
                border: '1px dashed ' + C.line, borderRadius: '12px', background: 'transparent'
              }
            },
              h('button', {
                type: 'button',
                'data-orch-group-toggle': String(grp.layer),
                title: isCollapsed ? '展开该阶段' : '折叠该阶段',
                onClick: function () { props.onTogglePhase(grp.layer); },
                style: {
                  position: 'absolute', top: '6px', left: '8px',
                  font: '11px/16px ' + C.code, color: C.sub,
                  background: C.panel, border: '1px solid ' + C.line, borderRadius: '999px',
                  padding: '1px 8px', cursor: 'pointer', whiteSpace: 'nowrap'
                }
              }, (isCollapsed ? '▸ ' : '▾ ') + grp.label + '  ' + String(pr.done) + '/' + String(pr.total) +
                (pr.running ? ' · 运行 ' + String(pr.running) : '') +
                (pr.blocked ? ' · 阻塞 ' + String(pr.blocked) : '') +
                (pr.failed ? ' · 失败 ' + String(pr.failed) : ''))
            );
          }),
          h('svg', {
            width: String(Math.max(g.width, 320)),
            height: String(Math.max(g.height, 200)),
            style: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' },
            'data-orch-edges': String(g.edges.length)
          },
            h('defs', null,
              h('marker', {
                id: markerId, viewBox: '0 0 10 10', refX: '9', refY: '5',
                markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse'
              }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: edgeColor }))
            ),
            g.edges.filter(function (e) { return !hiddenDepth[e.from] && !hiddenDepth[e.to]; }).map(function (e) {
              var hot = props.selectedId === e.from || props.selectedId === e.to;
              var live = props.runningIds && props.runningIds[e.to] === true;
              return h('path', {
                key: e.id,
                d: e.d,
                'data-orch-edge': e.id,
                'data-orch-edge-live': live ? '1' : '0',
                fill: 'none',
                stroke: hot ? C.blue : edgeColor,
                strokeWidth: hot ? 2 : 1.4,
                strokeLinejoin: 'round',
                strokeDasharray: live && !hot ? '6 5' : undefined,
                strokeLinecap: 'round',
                markerEnd: 'url(#' + markerId + ')'
              });
            }),
            // 驳回回边：走阶段框下方的专用通道，虚线 + 标签，绝不穿越节点
            (g.backEdges || []).filter(function (b) { return !hiddenDepth[b.from] && !hiddenDepth[b.to]; }).map(function (b) {
              return h('g', { key: b.id, 'data-orch-backedge': b.id },
                h('path', {
                  d: b.d, fill: 'none', stroke: C.warn, strokeWidth: 1.6,
                  strokeDasharray: '7 5', strokeLinejoin: 'round',
                  markerEnd: 'url(#' + markerId + ')'
                }),
                h('text', {
                  x: String(Math.round(b.labelX)), y: String(Math.round(b.labelY)),
                  fill: C.warn, fontSize: '10', textAnchor: 'middle'
                }, b.label)
              );
            })
          ),
          g.nodes.filter(function (n) { return !hiddenDepth[n.id]; }).map(function (n) {
            return h(NodeCard, {
              key: n.id,
              node: n,
              density: d,
              dense: props.zoom < 0.5,
              now: props.now,
              selected: props.selectedId === n.id,
              hasSelection: !!props.selectedId,
              connected: props.connectedIds && props.connectedIds[n.id] === true,
              onSelect: function () { props.onSelect(n.id); },
              onFocus: function () { props.onFocus(n); }
            });
          })
        ),
        showMini ? h('div', {
          style: { position: 'sticky', top: 0, left: 0, width: '100%', height: 0, zIndex: 5 }
        },
        h('div', {
          'data-orch-minimap': '1',
          style: {
            // 锚在**可见区**右下角：外层 sticky 容器贴在滚动视口顶/左，内层绝对定位按视口尺寸偏移，
            // 因此 minimap 常驻可见（sticky 的 top 偏移保证它跟着视口走）。
            position: 'absolute',
            left: String(Math.max(8, (size.w || 0) - miniW - 24)) + 'px',
            top: String(Math.max(8, (size.h || 0) - miniH - 24)) + 'px',
            width: String(miniW) + 'px', height: String(miniH) + 'px',
            border: '1px solid ' + C.line, borderRadius: '8px', background: C.panel,
            opacity: 0.92, pointerEvents: 'none', overflow: 'hidden'
          }
        },
          h('svg', { width: String(miniW), height: String(miniH), 'data-orch-minimap-svg': '1' },
            g.nodes.map(function (n) {
              return h('rect', {
                key: n.id,
                x: String(Math.round(n.pos.x * miniScale)),
                y: String(Math.round(n.pos.y * miniScale)),
                width: String(Math.max(2, Math.round(n.pos.w * miniScale))),
                height: String(Math.max(2, Math.round(n.pos.h * miniScale))),
                rx: '1',
                fill: n.state.color,
                opacity: props.selectedId === n.id ? 1 : 0.55
              });
            }),
            h('rect', {
              x: String(Math.round(vx)), y: String(Math.round(vy)),
              width: String(Math.max(4, Math.round(vw))), height: String(Math.max(4, Math.round(vh))),
              fill: 'none', stroke: C.blue, strokeWidth: '1.5', rx: '2'
            })
          )
        )
        ) : null,
        g.nodes.length === 0
          ? h('div', {
            style: {
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '24px'
            }
          }, h(EmptyState, { reason: props.reason, hint: props.hint }))
          : null
      );
    }

    function EmptyState(props) {
      return h('div', {
        style: {
          maxWidth: '460px', display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '18px 20px', border: '1px dashed ' + C.line, borderRadius: '12px', background: C.panel
        }
      },
        h('svg', { width: '40', height: '40', viewBox: '0 0 40 40', 'data-orch-empty-icon': '1', style: { color: C.mute } },
          h('rect', { x: '3', y: '7', width: '13', height: '9', rx: '2.5', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5' }),
          h('rect', { x: '24', y: '4', width: '13', height: '9', rx: '2.5', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5' }),
          h('rect', { x: '24', y: '26', width: '13', height: '9', rx: '2.5', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5' }),
          h('path', { d: 'M16 11.5 H20 V30.5 H24 M20 11.5 V8.5 H24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' })
        ),
        h('div', { style: { fontSize: '14px', fontWeight: 600 } }, props.reason || '还没有可显示的 agent'),
        h('div', { style: { fontSize: '12px', lineHeight: '19px', color: C.sub } }, props.hint ||
          '看板只显示真实存在的会话与子代理：新开一个会话、或让当前会话派一个子代理，这里会立刻出现节点。'),
        h('div', { style: { fontSize: '11px', lineHeight: '18px', color: C.mute } },
          '提示：按「示例预览」可以看版式与交互（示例带虚线边框与「示例」水印，不会写入任何状态）。')
      );
    }

    // ---------- 详情面板 ----------
    function KRow(props) {
      return h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '3px 0' } },
        h('span', { style: { fontSize: '11px', color: C.mute, flex: 'none', width: '62px' } }, props.k),
        h('span', {
          style: {
            fontSize: '12px', color: props.mono ? C.fg : C.sub,
            font: props.mono ? '11px/17px ' + C.code : undefined,
            minWidth: 0, wordBreak: 'break-all'
          },
          title: typeof props.v === 'string' ? props.v : undefined
        }, props.v)
      );
    }

    // ---------- 运行摘要条 + 对话内嵌运行卡 ----------

    /** 运行摘要条：任务 / 轮次 / 进度 / 已用 / 预算 / 验收标准（运行视图顶部） */
    function RunSummary(props) {
      var run = props.run;
      var done = 0;
      var running = 0;
      for (var i = 0; i < run.nodes.length; i += 1) {
        if (run.nodes[i].status === 'done') done += 1;
        if (run.nodes[i].status === 'running') running += 1;
      }
      var used = run.budget && typeof run.budget.used === 'number' ? run.budget.used : 0;
      var limit = run.budget && typeof run.budget.limit === 'number' ? run.budget.limit : 0;
      var pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
      var elapsed = props.now && run.startedAt ? Math.max(0, props.now - run.startedAt) : null;
      return h('div', {
        'data-orch-run-summary': run.runId,
        style: {
          flex: 'none', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
          padding: '8px 10px', border: '1px solid ' + C.line, borderRadius: '10px', background: C.panel
        }
      },
        h('span', { style: { fontSize: '12px', fontWeight: 500, minWidth: 0, flex: '1 1 220px' } }, run.task),
        h(Chip, { marker: 'round', text: '第 ' + String(run.round) + '/' + String(run.maxRounds) + ' 轮' }),
        h(Chip, { marker: 'progress', text: '完成 ' + String(done) + '/' + String(run.nodes.length) + (running ? ' · 运行 ' + String(running) : '') }),
        elapsed != null ? h(Chip, { marker: 'elapsed', text: '已用 ' + fmtMs(elapsed) }) : null,
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { fontSize: '11px', color: C.mute } }, '预算'),
          h('span', { style: { width: '90px', height: '6px', borderRadius: '999px', background: C.panel2, overflow: 'hidden', display: 'inline-block' } },
            h('span', { 'data-orch-budget': String(pct), style: { display: 'block', height: '100%', width: String(pct) + '%', background: pct > 80 ? C.err : C.blue } })
          ),
          h('span', { style: { font: '11px/16px ' + C.code, color: pct > 80 ? C.err : C.mute } }, String(pct) + '%')
        ),
        h(Chip, {
          marker: 'acceptance',
          text: '验收标准 ' + String((run.acceptance || []).length) + ' 条',
          title: (run.acceptance || []).map(function (a) { return a.id + ': ' + a.text; }).join('\n')
        })
      );
    }

    /**
     * 对话内嵌运行卡：P0.2 先把**效果**做出来（当前在看板里预览）；
     * P1 用 `tool.call.toolview` 挂到对话流 —— 工具一跑卡片就自动出现、实时更新。
     */
    function RunCard(props) {
      var run = props.run;
      var elapsed = props.now && run.startedAt ? Math.max(0, props.now - run.startedAt) : null;
      var done = 0;
      var i;
      for (i = 0; i < run.nodes.length; i += 1) if (run.nodes[i].status === 'done') done += 1;
      return h('div', {
        'data-orch-runcard': run.runId,
        style: {
          flex: 'none', border: '1px dashed ' + C.line, borderRadius: '10px',
          padding: '9px 10px', display: 'flex', flexDirection: 'column', gap: '7px', background: C.base
        }
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { fontSize: '11px', fontWeight: 600 } }, '部门进度 · 对话内嵌卡预览'),
          h('span', { style: { font: '10px/14px ' + C.code, color: C.mute, marginLeft: 'auto' } },
            String(done) + '/' + String(run.nodes.length) + (elapsed != null ? ' · ' + fmtMs(elapsed) : ''))
        ),
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          RUN_PHASES.map(function (label, idx) {
            var members = [];
            for (var k = 0; k < run.nodes.length; k += 1) if (run.nodes[k].phase === idx) members.push(run.nodes[k]);
            var agg = 'idle';
            for (var m = 0; m < members.length; m += 1) {
              var s = members[m].status;
              if (s === 'running') agg = 'running';
              else if (s === 'blocked' && agg !== 'running') agg = 'blocked';
              else if (s === 'done' && agg === 'idle') agg = 'done';
            }
            var state = STATUS[agg] || STATUS.idle;
            return h('span', {
              key: label,
              'data-orch-runcard-phase': String(idx),
              'data-orch-runcard-state': state.key,
              title: label + '：' + state.label,
              style: {
                flex: '1 1 auto', height: '6px', borderRadius: '999px',
                background: state.color, opacity: state.key === 'idle' ? 0.35 : 1
              }
            });
          })
        ),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
          run.nodes.slice(0, 8).map(function (nd) {
            var state = STATUS[nd.status] || STATUS.idle;
            return h('span', {
              key: nd.id,
              style: {
                font: '10px/14px ' + C.code, padding: '1px 6px', borderRadius: '999px',
                border: '1px solid ' + state.color, color: state.color
              }
            }, state.glyph + ' ' + (ROLE_LABEL[nd.role] || String(nd.role)));
          })
        ),
        h('div', { style: { fontSize: '10px', lineHeight: '15px', color: C.mute } },
          'P1 会把这张卡挂到对话流里（工具一跑就自动出现并实时更新）；点节点可跳到看板与该 agent 的会话。')
      );
    }

    function Inspector(props) {
      var n = props.node;
      if (!n) {
        return h('div', { 'data-orch-inspector': 'empty', style: Object.assign({}, S.inspector, props.style || {}) },
          h('div', { style: S.inspectorTitle }, '节点详情'),
          props.focusResult ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h(Chip, { text: '跳转：' + props.focusResult, style: props.focusResult === 'error' ? { borderColor: C.err, color: C.err } : { borderColor: C.green, color: C.green } })
          ) : null,
          h('div', { style: { fontSize: '12px', lineHeight: '19px', color: C.sub } },
            '在左侧流程图里点一个节点，这里会显示它的身份、关系、时间与产物，并提供「跳到该会话」。'),
          h('div', { style: { fontSize: '11px', lineHeight: '18px', color: C.mute, marginTop: 'auto' } },
            '交互：单击选中 · 双击直接跳转 · ←/→ 在父子上移动 · Esc 取消选中 · Tab 在节点间移动')
        );
      }
      var st = n.state;
      return h('div', { 'data-orch-inspector': n.id, style: Object.assign({}, S.inspector, props.style || {}) },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
          h(Dot, { state: st }),
          h('span', {
            style: {
              font: '10px/14px ' + C.code, padding: '0 6px', borderRadius: '999px',
              border: '1px solid ' + (ROLE_COLOR[n.role.key] || C.sub), color: ROLE_COLOR[n.role.key] || C.sub
            }
          }, n.role.label),
          h('span', { style: { fontSize: '11px', color: st.color } }, st.glyph + ' ' + st.label),
          props.focusResult ? h(Chip, { text: '跳转：' + props.focusResult }) : null
        ),
        h('div', {
          style: { fontSize: '13px', fontWeight: 500, lineHeight: '19px', wordBreak: 'break-word' }
        }, n.title),
        h('div', { style: S.inspectorSection },
          h('div', { style: S.inspectorLabel }, '身份'),
          h(KRow, { k: '会话', v: n.id, mono: true }),
          h(KRow, { k: '角色', v: n.role.label + '（' + n.role.hint + '）' }),
          h(KRow, { k: 'preset', v: n.agentPreset || '—' }),
          h(KRow, { k: 'origin', v: n.origin || '—' }),
          h(KRow, { k: '数据源', v: n.source === 'demo' ? '示例（不参与运行）' : n.source })
        ),
        h('div', { style: S.inspectorSection },
          h('div', { style: S.inspectorLabel }, '关系'),
          h(KRow, { k: '层级', v: 'L' + String(n.depth || 0) }),
          h(KRow, { k: '父', v: n.parentId ? shortId(n.parentId) : '（根）', mono: true }),
          h(KRow, { k: '子', v: String(props.children) + ' 个' })
        ),
        h('div', { style: S.inspectorSection },
          h('div', { style: S.inspectorLabel }, '时间 / 运行'),
          h(KRow, { k: '更新', v: n.updatedAt ? new Date(n.updatedAt).toLocaleString() : '—' }),
          h(KRow, { k: '运行态', v: n.hasRunning === false ? '未知（store 未提供）' : (n.running ? '运行中' : '未运行') }),
          h(KRow, { k: 'cwd', v: n.cwd || '—', mono: true }),
          n.pending ? h(KRow, { k: '待应答', v: String(n.pending) }) : null
        ),
        h('div', { style: S.inspectorSection },
          h('div', { style: S.inspectorLabel }, '运行'),
          h(KRow, { k: '阶段', v: RUN_PHASES[n.depth] || ('阶段 ' + String(n.depth)) }),
          h(KRow, { k: '耗时', v: n.ms != null ? fmtMs(n.ms) : (n.state.key === 'running' && n.startedAt ? '进行中' : '—') }),
          h(KRow, { k: '重试', v: n.retry ? String(n.retry) + ' 次' : '0 次' }),
          h(KRow, { k: '产物', v: String(n.artifacts || 0) + ' 件' }),
          h(KRow, { k: '可写', v: n.wrote ? '是（唯一可写角色）' : '否（只读）' })
        ),
        n.findings && n.findings.length ? h('div', { style: S.inspectorSection },
          h('div', { style: Object.assign({}, S.inspectorLabel, { color: C.err }) }, '阻断项（门禁）'),
          n.findings.map(function (f, i) {
            return h(KRow, { key: 'f' + i, k: String(f.severity || 'finding'), v: String(f.path || '') + ':' + String(f.line || '?') + ' — ' + String(f.why || ''), mono: true });
          })
        ) : null,
        props.run ? h('div', { style: S.inspectorSection },
          h('div', { style: S.inspectorLabel }, '验收标准（规划期冻结）'),
          (props.run.acceptance || []).map(function (a, i) {
            return h(KRow, { key: 'ac' + i, k: String(a.id), v: String(a.text) });
          })
        ) : null,
        h('div', { style: S.inspectorSection },
          h('div', { style: S.inspectorLabel }, '产物 / 证据 / 门禁'),
          n.artifacts && n.artifacts.length ? n.artifacts.map(function (a, i) {
            return h(KRow, { key: 'a' + i, k: '产物', v: typeof a === 'string' ? a : (a && a.path) || JSON.stringify(a), mono: true });
          }) : h(KRow, { k: '产物', v: '—（运行记录接入后显示）' }),
          n.evidence && n.evidence.length ? n.evidence.map(function (e, i) {
            return h(KRow, { key: 'e' + i, k: '证据', v: typeof e === 'string' ? e : JSON.stringify(e), mono: true });
          }) : h(KRow, { k: '证据', v: '—（运行记录接入后显示）' }),
          h(KRow, { k: '门禁', v: n.gate || '—（运行记录接入后显示）' })
        ),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: 'auto', paddingTop: '10px' } },
          h(Btn, { text: '跳到该会话', onClick: function () { props.onFocus(n); }, disabled: n.source === 'demo' }),
          h(Btn, { text: '在图中定位', onClick: function () { props.onReveal(n.id); } }),
          h(Btn, { text: '清除选中', onClick: function () { props.onClear(); } })
        )
      );
    }

    // ---------- 主组件 ----------
    function Workbench(props) {
      var ctx = props.__ctx;

      var clientState = React.useState({ rows: [], current: null, error: null, at: 0 });
      var client = clientState[0];
      var setClient = clientState[1];

      var hostState = React.useState({ data: null, error: null, at: 0 });
      var host = hostState[0];
      var setHost = hostState[1];

      var selectedState = React.useState(null);
      var selectedId = selectedState[0];
      var setSelectedId = selectedState[1];

      var uiState = React.useState({
        density: 'normal', zoom: 1, demo: false, probe: false, focusResult: null,
        // scope 默认「本对话」：同一工作区里的**其它主对话**不再混进图（用户实测反馈）
        // runsAny 默认 false：本对话没有运行时就**不显示别对话的运行**（要看必须显式打开）
        scope: 'family', runsAny: false, mode: 'run', collapsed: {}
      });
      var ui = uiState[0];
      var setUi = uiState[1];

      var widthState = React.useState(0);
      var width = widthState[0];
      var setWidth = widthState[1];

      var rootRef = React.useRef(null);
      var navRef = React.useRef(null);

      // 1s 心跳：只为「运行中节点的实时耗时」跳动（假定时器下不触发 ⇒ 测试仍确定）
      var nowState = React.useState(Date.now());
      var now = nowState[0];
      var setNow = nowState[1];
      React.useEffect(function () {
        var timer = setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { clearInterval(timer); };
      }, []);

      ensureStyle();

      // 客户端 store 订阅：合帧节流 + 卸载必退订
      React.useEffect(function () {
        var sessions = resolveSessions(ctx);
        var alive = true;
        var timer = 0;
        function pull() {
          if (!alive) return;
          var res = readClientRows(sessions);
          setClient({ rows: res.rows, current: res.current, error: res.error, at: Date.now() });
        }
        pull();
        var unsub = null;
        if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
          try {
            unsub = sessions.list.subscribe(function () {
              if (timer) return;
              timer = setTimeout(function () { timer = 0; pull(); }, SUBSCRIBE_COALESCE_MS);
            });
          } catch (e) { surfaceError('subscribe', e); }
        }
        return function () {
          alive = false;
          if (timer) clearTimeout(timer);
          if (typeof unsub === 'function') {
            try { unsub(); } catch (e) { surfaceError('unsubscribe', e); }
          }
        };
      }, []);

      // host 快照：低频补充/兜底
      React.useEffect(function () {
        var alive = true;
        var inflight = false;
        function tick() {
          if (inflight || !alive) return;
          inflight = true;
          fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then(function (r) {
              return r.json().then(
                function (j) { return { ok: r.ok, status: r.status, body: j }; },
                function () { return { ok: r.ok, status: r.status, body: null }; }
              );
            })
            .then(function (res) {
              if (!alive) return;
              var softErr = res.body && res.body.error ? String(res.body.error) : null;
              setHost({ data: res.body, error: res.ok ? softErr : 'HTTP ' + res.status, at: Date.now() });
            })
            .catch(function (e) {
              if (!alive) return;
              setHost(function (prev) { return { data: prev.data, error: msgOf(e), at: Date.now() }; });
            })
            .then(function () { inflight = false; });
        }
        tick();
        var timer = setInterval(tick, HOST_POLL_MS);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      // 容器宽度（决定"右侧详情 / 底部详情"的适配）—— 拿不到就退回默认值
      React.useEffect(function () {
        var el = rootRef.current;
        var apply = function () {
          try {
            if (!el || typeof el.getBoundingClientRect !== 'function') return;
            var w = el.getBoundingClientRect().width;
            if (typeof w === 'number' && w > 0) setWidth(Math.round(w));
          } catch (e) { /* ignore */ }
        };
        apply();
        var ro = null;
        try {
          if (typeof ResizeObserver === 'function' && el) {
            ro = new ResizeObserver(apply);
            ro.observe(el);
          }
        } catch (e) { ro = null; }
        return function () { if (ro && typeof ro.disconnect === 'function') ro.disconnect(); };
      }, []);

      // 键盘可达性（Airflow / React Flow 惯例）：Esc 取消选中，←/→ 在父子节点间移动
      React.useEffect(function () {
        var onKey = function (ev) {
          if (!ev) return;
          if (ev.key === 'Escape' || ev.key === 'Esc') { setSelectedId(null); return; }
          if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
          var nav = navRef.current || { nodes: [], selectedId: null };
          var i;
          var cur = null;
          for (i = 0; i < nav.nodes.length; i += 1) if (nav.nodes[i].id === nav.selectedId) cur = nav.nodes[i];
          if (!cur) { if (nav.nodes.length) setSelectedId(nav.nodes[0].id); return; }
          var next = null;
          if (ev.key === 'ArrowRight') {
            for (i = 0; i < nav.nodes.length; i += 1) if (nav.nodes[i].parentId === cur.id) { next = nav.nodes[i]; break; }
          } else if (cur.parentId) {
            for (i = 0; i < nav.nodes.length; i += 1) if (nav.nodes[i].id === cur.parentId) { next = nav.nodes[i]; break; }
          }
          if (next) setSelectedId(next.id);
        };
        var target = null;
        try { target = (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') ? window : null; } catch (e) { target = null; }
        if (target) target.addEventListener('keydown', onKey);
        return function () { if (target) target.removeEventListener('keydown', onKey); };
      }, []);

      var sessions = resolveSessions(ctx);
      var hostView = rowsFromHost(host.data);
      var hostMap = hostView.byId;
      var rows = client.rows || [];
      var source = 'client';
      if (rows.length === 0 && client.error) {
        rows = hostView.rows;
        source = rows.length ? 'host' : 'none';
      }
      for (var i = 0; i < rows.length; i += 1) if (!rows[i].host) rows[i].host = hostMap[rows[i].id] || null;

      // ── 真实运行（P1）：从 host 拉本项目最近的运行，2s 轮询（loopback、开销可忽略）──
      // 只读、有界；拿不到就**如实**回退到会话树/空态（不假装有运行）。
      var runsState = React.useState({ run: null, error: null, list: [], mine: false, others: 0, srcId: null, at: 0 });
      var realRuns = runsState[0];
      var setRealRuns = runsState[1];
      // 「包含其它对话」开关与立即重取句柄：用 ref 读，避免把 ui 塞进 effect 依赖（会重挂轮询）
      var runsAnyRef = React.useRef(false);
      var refetchRef = React.useRef(null);
      runsAnyRef.current = ui.runsAny === true;
      React.useEffect(function () {
        var alive = true;
        var inflight = false;
        function base() {
          try {
            var snap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
            var cur = snap && snap.current;
            var row = cur && snap.byId ? snap.byId[cur] : null;
            if (row && typeof row.cwd === 'string' && row.cwd) return { project: row.cwd, current: cur || null };
          } catch (e) { /* ignore */ }
          return null;
        }
        function pull() {
          if (inflight || !alive) return;
          var b = base();
          if (!b || !b.project) { setRealRuns({ run: null, error: '当前会话没有 cwd，无法定位项目', list: [], mine: false, others: 0, srcId: null, at: Date.now() }); return; }
          var project = b.project;
          inflight = true;
          fetch('/orchestrator/runs?project=' + encodeURIComponent(project) + '&limit=30', { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }, function () { return { ok: r.ok, status: r.status, body: null }; }); })
            .then(function (res) {
              if (!alive) return null;
              var list = res.body && Array.isArray(res.body.runs) ? res.body.runs : [];
              if (!res.ok || !list.length) {
                setRealRuns({ run: null, error: res.ok ? null : 'HTTP ' + res.status, list: list, mine: false, others: 0, srcId: null, at: Date.now() });
                return null;
              }
              // 按**发起会话**归属挑运行：本对话的优先；没有则默认不显示别对话的（要显式开关）
              var chosen = pickRun(list, b.current, runsAnyRef.current);
              if (!chosen.pick) {
                setRealRuns({ run: null, error: null, list: list, mine: false, others: chosen.others, at: Date.now() });
                return null;
              }
              return fetch('/orchestrator/run/' + encodeURIComponent(chosen.pick.runId) + '?project=' + encodeURIComponent(project), { headers: { accept: 'application/json' }, cache: 'no-store' })
                .then(function (r2) { return r2.json().then(function (j2) { return { ok: r2.ok, status: r2.status, body: j2 }; }, function () { return { ok: r2.ok, status: r2.status, body: null }; }); })
                .then(function (res2) {
                  if (!alive) return;
                  var run = res2.body && res2.body.run ? res2.body.run : null;
                  // 来源会话优先取**列表条目**的（`/orchestrator/run/<id>` 详情未必回显 sessionId）
                  var srcId = (chosen.pick && typeof chosen.pick.sessionId === 'string' && chosen.pick.sessionId)
                    ? chosen.pick.sessionId
                    : (run && typeof run.sessionId === 'string' && run.sessionId ? run.sessionId : null);
                  setRealRuns({ run: run, error: run ? null : ('运行详情不可读：' + (res2.body && res2.body.code ? res2.body.code : 'HTTP ' + res2.status)), list: list, mine: chosen.mine, others: chosen.others, srcId: srcId, at: Date.now() });
                });
            })
            .catch(function (e) {
              if (!alive) return;
              setRealRuns(function (p) { return { run: p.run, error: msgOf(e), list: p.list, mine: p.mine, others: p.others, srcId: p.srcId, at: Date.now() }; });
            })
            .then(function () { inflight = false; });
        }
        refetchRef.current = pull;
        pull();
        var timer = setInterval(pull, 2000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      var demo = ui.demo === true;
      // 作用域过滤：默认只看「本对话（含它的部门成员）」，避免被其它主对话/历史会话淹掉
      var scoped = scopeRows(rows, client.current, ui.scope);
      var viewRows = scoped.rows.slice(0, MAX_NODES);
      var truncated = demo ? 0 : Math.max(0, scoped.rows.length - MAX_NODES);

      // ── 视图模式（P0.2/P1）──
      //  run（默认）：**运行驱动** —— 只画本次运行的部门 DAG（真实数据来自 host 端点）
      //  sessions    ：会话树回退视图
      //  没有运行数据**且**存在会话时自动回退到会话树，并在界面上**明说这是回退**。
      var runWanted = ui.mode !== 'sessions';
      var run = runWanted ? (demo ? demoRun() : realRuns.run) : null;
      var autoFallback = runWanted && run === null && viewRows.length > 0;
      var runMode = runWanted && !autoFallback;
      // 运行来源标注：不是本对话的 run 必须**明说**（否则会让人以为是自己的运行）
      var runSrc = (!demo && runMode && run && !realRuns.mine)
        ? (realRuns.srcId ? '其它对话 ' + shortId(realRuns.srcId) : '来源未知（旧记录）')
        : null;
      var graph;
      if (runMode) {
        var runRows = run ? runToRows(run) : [];
        graph = buildGraph(runRows, {
          density: ui.density,
          layerOf: function (r) { return typeof r.layer === 'number' ? r.layer : 0; },
          groupLabels: RUN_PHASES,
          edges: run ? run.edges : [],
          backEdges: run ? run.backEdges : []
        });
      } else {
        graph = buildGraph(demo ? demoRows() : viewRows, { density: ui.density });
      }

      var counts = { running: 0, blocked: 0, failed: 0, done: 0, idle: 0, cancelled: 0 };
      var runningIds = {};
      for (i = 0; i < graph.nodes.length; i += 1) {
        counts[graph.nodes[i].state.key] = (counts[graph.nodes[i].state.key] || 0) + 1;
        if (graph.nodes[i].state.key === 'running') runningIds[graph.nodes[i].id] = true;
      }

      var selected = null;
      var children = 0;
      var connectedIds = {};
      if (selectedId) {
        for (i = 0; i < graph.nodes.length; i += 1) {
          var n = graph.nodes[i];
          if (n.id === selectedId) selected = n;
          if (n.parentId === selectedId) children += 1;
        }
        connectedIds[selectedId] = true;
        if (selected && selected.parentId) connectedIds[selected.parentId] = true;
        for (i = 0; i < graph.nodes.length; i += 1) if (graph.nodes[i].parentId === selectedId) connectedIds[graph.nodes[i].id] = true;
      }

      var stamp = client.at ? new Date(client.at).toLocaleTimeString() : '—';
      var stacked = width > 0 && width < 880;
      navRef.current = { nodes: graph.nodes, selectedId: selectedId };

      function onSelect(id) { setSelectedId(selectedId === id ? null : id); }
      function onFocus(row) {
        if (row.source === 'demo') { setUi(function (p) { return Object.assign({}, p, { focusResult: '示例节点不可跳转' }); }); return; }
        var res = focusSession(sessions, row);
        setUi(function (p) { return Object.assign({}, p, { focusResult: res }); });
      }
      function onReveal(id) {
        try {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
          var el = document.querySelector('[data-orch-node="' + String(id).replace(/"/g, '') + '"]');
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        } catch (e) { /* ignore */ }
      }
      function setZoom(z) {
        // 缩放范围 0.4–2（React Flow 惯例 0.1–2；下限抬高一点避免小图缩成不可读的点）
        setUi(function (p) { return Object.assign({}, p, { zoom: Math.max(0.4, Math.min(2, Math.round(z * 100) / 100)) }); });
      }
      function fitZoom() {
        var avail = Math.max(240, (width > 0 ? width : 1280) - (stacked ? 48 : 374) - 34);
        setZoom(graph.width > 0 ? avail / graph.width : 1);
      }
      function onTogglePhase(layer) {
        setUi(function (p) {
          var next = Object.assign({}, p.collapsed || {});
          if (next[layer]) delete next[layer];
          else next[layer] = true;
          return Object.assign({}, p, { collapsed: next });
        });
      }
      function onSetMode(mode) {
        setSelectedId(null);
        setUi(function (p) { return Object.assign({}, p, { mode: mode }); });
      }

      return h('div', {
        ref: rootRef,
        'data-orch-root': 'graph',
        'data-orch-mode': runMode ? 'run' : (autoFallback ? 'sessions-auto' : 'sessions'),
        'data-orch-source': demo ? 'demo' : source,
        style: {
          boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          flex: '1 1 auto', height: '100%', minHeight: 0, minWidth: 0, width: '100%',
          gap: '10px', padding: '12px 14px 10px', color: C.fg, background: C.base, overflow: 'hidden'
        }
      },
        // ── 顶栏 ──
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
            flex: 'none', paddingBottom: '10px', borderBottom: '1px solid ' + C.line
          }
        },
          h('span', { style: { fontSize: '14px', fontWeight: 600, marginRight: '2px' } }, '编排看板'),
          h(Chip, { text: runMode ? 'P0.2 · 运行视图' : 'P0 · 会话树' }),
          // 视图模式：运行驱动（默认）↔ 会话树（回退）
          h('span', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
            h(Btn, {
              marker: 'mode-run', text: '运行视图',
              title: '只看本次运行的部门流程（P1 接入真实运行数据）',
              style: runMode ? { borderColor: C.blue, color: C.blue, background: C.panel2 } : null,
              onClick: function () { onSetMode('run'); }
            }),
            h(Btn, {
              marker: 'mode-sessions', text: '会话树',
              title: '没有运行时，回退看「谁在跑」的会话树',
              style: runMode ? null : { borderColor: C.blue, color: C.blue, background: C.panel2 },
              onClick: function () { onSetMode('sessions'); }
            })
          ),
          h(Chip, { text: '节点 ' + String(graph.nodes.length), marker: 'nodes' }),
          h(Chip, {
            text: '运行中 ' + String(counts.running || 0),
            marker: 'running',
            style: counts.running ? { borderColor: C.blue, color: C.blue } : null
          }),
          h(Chip, { text: runMode ? '阶段 ' + String(graph.groups ? graph.groups.length : 0) : '层级 ' + String(graph.layers), marker: 'layers' }),
          h(Chip, {
            text: runMode
              ? (demo ? '源：示例运行' : (run ? '源：真实运行' : '源：暂无运行'))
              : (autoFallback
                ? '源：会话树（回退 · 暂无运行）'
                : (source === 'demo' ? '源：示例预览' : source === 'client' ? '源：客户端 store' : source === 'host' ? '源：host 快照（降级）' : '源：不可用')),
            marker: 'source',
            style: runMode ? (run ? null : { borderColor: C.warn, color: C.warn }) : (autoFallback ? { borderColor: C.warn, color: C.warn } : (source === 'client' || source === 'demo' ? null : { borderColor: C.warn, color: C.warn }))
          }),
          runSrc ? h(Chip, { text: '来源：' + runSrc, marker: 'run-src', title: '这条运行不是本对话发起的（默认只显示本对话的运行）', style: { borderColor: C.warn, color: C.warn } }) : null,
          h(Chip, { text: '更新 ' + stamp, marker: 'stamp' }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' } },
            runMode ? null : h('span', { style: { fontSize: '11px', color: C.mute } }, '范围'),
            runMode ? null : SCOPE_MODES.map(function (m) {
              var active = (ui.scope || 'family') === m;
              return h(Btn, {
                key: m,
                marker: 'scope-' + m,
                text: SCOPE_LABEL[m],
                title: m === 'family'
                  ? '只看本对话（当前会话所在会话树的根及其全部后代）—— 同工作区的其它主对话不会混进来'
                  : (m === 'workspace'
                    ? '只看与当前会话同工作区的会话（会包含同工作区的其它主对话）'
                    : '显示全部会话（含历史与其它工作区）'),
                style: active ? { borderColor: C.blue, color: C.blue, background: C.panel2 } : null,
                onClick: function () { setUi(function (p) { return Object.assign({}, p, { scope: m }); }); }
              });
            }),
            !runMode && !demo && scoped.hidden > 0
              ? h(Chip, { marker: 'hidden', text: '隐藏 ' + String(scoped.hidden), title: '被当前范围过滤掉的会话数（切「全部」可看全）' })
              : null,
            !demo && realRuns.others > 0
              ? h(Btn, {
                marker: 'runs-any',
                text: ui.runsAny ? '仅本对话' : '包含其它对话',
                title: '本项目还有 ' + String(realRuns.others) + ' 条其它对话的运行；默认不显示它们',
                style: ui.runsAny ? { borderColor: C.warn, color: C.warn } : null,
                onClick: function () {
                  setSelectedId(null);
                  var next = !(ui.runsAny === true);
                  // ⚠ 必须先同步 ref 再重取：ref 平时在渲染时从 ui 赋值，而这里重取发生在渲染之前，
                  //   不等它就会拿旧值去请求（表现为“点了开关没反应，要等下一轮轮询”）。
                  runsAnyRef.current = next;
                  setUi(function (p) { return Object.assign({}, p, { runsAny: next }); });
                  if (refetchRef.current) refetchRef.current();
                }
              })
              : null,
            h(Btn, { text: ui.density === 'compact' ? '标准密度' : '紧凑密度', onClick: function () { setUi(function (p) { return Object.assign({}, p, { density: p.density === 'compact' ? 'normal' : 'compact' }); }); } }),
            h(Btn, { text: '−', title: '缩小', onClick: function () { setZoom(ui.zoom - 0.1); } }),
            h(Chip, { text: Math.round(ui.zoom * 100) + '%', marker: 'zoom' }),
            h(Btn, { text: '+', title: '放大', onClick: function () { setZoom(ui.zoom + 0.1); } }),
            h(Btn, { text: '100%', onClick: function () { setZoom(1); } }),
            h(Btn, { text: '适应', title: '缩放到可用宽度', onClick: fitZoom }),
            h(Btn, {
              text: demo ? '退出示例' : (runWanted ? '示例运行' : '示例预览'),
              title: demo ? '回到真实数据' : (runWanted ? '看一次完整的部门运行（含审查驳回与第 2 轮修复）' : '只看版式与交互（不写入任何状态）'),
              onClick: function () { setSelectedId(null); setUi(function (p) { return Object.assign({}, p, { demo: !p.demo }); }); }
            }),
            h(Btn, { text: ui.probe ? '隐藏探针' : '显示探针', onClick: function () { setUi(function (p) { return Object.assign({}, p, { probe: !p.probe }); }); } })
          )
        ),

        // ── 状态横幅（只在该说的时候说）──
        client.error ? h('div', { style: S.banner }, '客户端会话源：' + client.error + '（已降级；看板不会显示假数据）') : null,
        scoped.error ? h('div', { style: Object.assign({}, S.banner, { color: C.warn, borderColor: C.warn }) }, '范围过滤：' + scoped.error) : null,
        host.error && ui.probe ? h('div', { style: S.banner }, 'host 快照：' + host.error) : null,
        autoFallback ? h('div', {
          'data-orch-autofallback': '1',
          style: Object.assign({}, S.banner, { color: C.warn, borderColor: C.warn })
        }, (realRuns.others > 0
          ? ('本对话暂无运行记录（已回退到「会话树」）。本项目还有 ' + String(realRuns.others) + ' 条**其它对话**的运行，默认不显示；点右上「包含其它对话」可查看。')
          : '暂无运行记录，已回退到「会话树」视图。输入一个长任务并让编排跑起来后，这里会自动显示本次运行的部门流程图。')) : null,
        demo ? h('div', { style: Object.assign({}, S.banner, { color: C.blue, borderColor: C.blue }) },
          runWanted
            ? '示例运行：这是**版式与交互演示**（含一次「审查驳回 → 第 2 轮修复」），节点带虚线边框与「示例」水印，不写入任何状态。'
            : '示例预览：这是**排版与交互演示**，节点带虚线边框与「示例」水印，不写入任何状态；点「退出示例」回到真实数据。') : null,

        // ── 运行摘要条（运行视图）：任务 / 轮次 / 预算 / 验收标准 ──
        runMode && run ? h(RunSummary, { run: run, now: now, marker: 'summary' }) : null,

        // ── 主体 ──
        h('div', {
          style: {
            display: 'flex', flexDirection: stacked ? 'column' : 'row',
            gap: '12px', flex: '1 1 auto', minHeight: 0, minWidth: 0
          }
        },
          h(GraphPane, {
            graph: graph,
            zoom: ui.zoom,
            now: now,
            collapsed: ui.collapsed || {},
            onTogglePhase: onTogglePhase,
            selectedId: selectedId,
            connectedIds: connectedIds,
            runningIds: runningIds,
            onSelect: onSelect,
            onFocus: onFocus,
            reason: runMode
              ? (run ? null : '还没有运行记录')
              : (source === 'none' && !demo ? '读不到任何 agent' : (demo ? null : '当前范围内没有 agent')),
            hint: runMode
              ? (run ? null : '在一个会话里输入一个长任务，让编排跑起来（P1 接入后）这里会出现本次运行的部门流程图。先点「示例运行」可以看版式与交互。')
              : (client.error
                ? '客户端会话源不可用，host 快照也为空。原始原因见上方横幅。'
                : (!demo && scoped.hidden > 0
                  ? '当前范围「' + SCOPE_LABEL[ui.scope || 'family'] + '」里没有会话，另有 ' + String(scoped.hidden) + ' 个被过滤掉。切到「全部」就能看到它们。'
                  : null))
          }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', flex: stacked ? 'none' : 'none', width: stacked ? '100%' : '330px', minHeight: 0, maxHeight: stacked ? '46%' : 'none' } },
            h(Inspector, {
              node: selected,
              run: runMode ? run : null,
              children: children,
              focusResult: ui.focusResult,
              onFocus: onFocus,
              onClear: function () { setSelectedId(null); },
              onReveal: onReveal,
              style: stacked ? { width: '100%', flex: '1 1 auto', maxHeight: 'none' } : null,
              stacked: stacked
            }),
            // 内嵌运行卡预览：P1 会把它挂到对话流（tool.call.toolview）——现在在示例模式下先看效果
            runMode && run ? h(RunCard, { run: run, now: now, compact: true }) : null
          )
        ),

        // ── 底栏：图例 + 提示 ──
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
            flex: 'none', paddingTop: '8px', borderTop: '1px solid ' + C.line, fontSize: '11px', color: C.mute
          }
        },
          STATUS_ORDER.map(function (k) {
            var st = STATUS[k];
            return h('span', { key: k, style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
              h(Dot, { state: st }), h('span', null, st.glyph + ' ' + st.label)
            );
          }),
          h('span', { style: { color: C.line3 } }, '|'),
          h('span', null, '边 = 父子委派（父 → 子）'),
          h('span', { style: { color: C.line3 } }, '|'),
          h('span', null, '单击选中 · 双击跳转 · Esc 取消 · Tab 移动 · 滚轮/滚动条平移'),
          truncated > 0
            ? h('span', { 'data-orch-truncated': String(rows.length), style: { color: C.warn } },
              '节点超过上限：显示 ' + String(MAX_NODES) + ' / 共 ' + String(rows.length))
            : null,
          !demo && scoped.hidden > 0
            ? h('span', { 'data-orch-scope-note': String(scoped.hidden) },
              '范围「' + SCOPE_LABEL[ui.scope || 'family'] + '」过滤掉 ' + String(scoped.hidden) + ' 个会话')
            : null,
          ui.probe ? h('span', { style: { font: '10px/16px ' + C.code } },
            JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length, w: graph.width, h: graph.height, stacked: stacked, width: width })
          ) : null
        )
      );
    }

    var S = {
      banner: {
        flex: 'none', padding: '7px 10px', borderRadius: '8px', fontSize: '11px',
        fontFamily: C.code, color: C.err, border: '1px solid ' + C.err
      },
      inspector: {
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '10px',
        width: '330px', flex: 'none', minHeight: 0, overflowY: 'auto',
        border: '1px solid ' + C.line, borderRadius: '12px', background: C.panel, padding: '12px'
      },
      inspectorTitle: { fontSize: '12px', fontWeight: 600, flex: 'none' },
      inspectorSection: { display: 'flex', flexDirection: 'column', gap: '1px', paddingBottom: '8px', borderBottom: '1px solid ' + C.line },
      inspectorLabel: { fontSize: '11px', fontWeight: 600, color: C.mute, paddingBottom: '4px' }
    };

    // ---------- plugin entry ----------
    var inject = ['slots'];

    function apply(ctx) {
      try {
        if (FLAGS.mountUi !== true) {
          console.log('[dsh-orchestrator] UI retired (FLAGS.mountUi=false): conversation.view not registered; host endpoints and data layer kept');
          return;
        }
        console.log('[dsh-orchestrator] client apply called');

        function registerTab(slots) {
          try {
            if (!slots || typeof slots.inject !== 'function') {
              surfaceError('registerTab', new Error('slots service has no inject()'));
              return;
            }
            slots.inject('conversation.view', function () {
              return slots.register({
                name: 'conversation.view',
                id: 'orchestrator',
                order: 20,
                label: function () { return '编排看板'; }
              }, guarded(function (props) {
                // 视图组件由宿主传 {inspect, onInspectDone}；服务从 apply 闭包注入
                // （slot 文档明说「数据访问位于 apply 闭包的 ctx 中」）⇒ 不依赖 root-scope 钩子。
                return Workbench(Object.assign({}, props, { __ctx: ctx }));
              }, 'Workbench'));
            });
            console.log('[dsh-orchestrator] conversation.view entry registered');
          } catch (error) {
            surfaceError('registerTab', error);
          }
        }

        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          registerTab(ctx.slots);
        } else if (typeof ctx.inject === 'function') {
          ctx.inject(['slots'], registerTab);
        } else {
          surfaceError('apply', new Error('neither ctx.slots nor ctx.inject is available'));
        }
      } catch (error) {
        surfaceError('apply', error);
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.__internals = {
      flags: FLAGS,
      resolveSessions: resolveSessions,
      readClientRows: readClientRows,
      projectRow: projectRow,
      inferRole: inferRole,
      statusOf: statusOf,
      scopeRows: scopeRows,
      pickRun: pickRun,
      rootOf: rootOf,
      normCwd: normCwd,
      SCOPE_MODES: SCOPE_MODES,
      SCOPE_LABEL: SCOPE_LABEL,
      layeredLayout: layeredLayout,
      edgePath: edgePath,
      buildGraph: buildGraph,
      demoRows: demoRows,
      demoRun: demoRun,
      runToRows: runToRows,
      runNodeRow: runNodeRow,
      fmtMs: fmtMs,
      backEdgePath: backEdgePath,
      RUN_PHASES: RUN_PHASES,
      ROLE_LABEL: ROLE_LABEL,
      focusSession: focusSession,
      rowsFromHost: rowsFromHost,
      Workbench: Workbench,
      STATUS: STATUS,
      DENSITY: DENSITY,
      MAX_NODES: MAX_NODES,
      constants: { HOST_POLL_MS: HOST_POLL_MS, SUBSCRIBE_COALESCE_MS: SUBSCRIBE_COALESCE_MS, MAX_DEPTH: MAX_DEPTH }
    };
    return module.exports;
  },
});
