/**
 * @dsh-external/dsh-context-lifecycle
 *
 * Token-saving context lifecycle manager for DSH.
 *
 * Watches every live agent's request pressure (via ctx.tokenMeter) and, when
 * the context grows expensive, asks the user — through a client banner — to
 * confirm one of two recovery actions:
 *
 *   compact      → ctx.compaction.compactNow (same path as /compact)
 *   new-session  → deterministic handover extraction (task, progress, files,
 *                  todos) that the user pastes into a fresh conversation
 *
 * Design rules:
 *  1. User confirms every action — the plugin recommends, never acts alone.
 *  2. Zero model-context cost: registers no tools, only a webServer route and
 *     slot-based client banner.
 *  3. Fail-safe: every observer/handler is wrapped; measurement or action
 *     failures degrade to "no suggestion".
 *  4. Anti-nag: per-session cooldown, dismissal memory, minimum session size.
 */
export const name = '@dsh-external/dsh-context-lifecycle';
// Empirically established: listing 'compaction' blocks fiber creation for
// runtime-injected plugins (the dependency never resolves in the injected
// subtree), so the compaction engine is resolved lazily (ctx proxy first,
// then ctx.reflect), degrading to guidance toward the native /compact command.
export const inject = ['agents', 'webServer', 'tokenMeter'];
const DEFAULT_CONFIG = {
    softRatio: 0.55,
    hardRatio: 0.8,
    cooldownMinutes: 30,          // 2026-08-24: 15->30，减少反复骚扰
    minTokens: 8000,
    fallbackContextWindow: 131072,
    pollMs: 30_000,
    idleHours: 24,                // 2026-08-24: 会话超过 idleHours 无活动则不提示压缩（活动感知）
};
function resolveConfig(raw) {
    const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
    if (!(config.softRatio > 0 && config.softRatio < config.hardRatio && config.hardRatio <= 1))
        throw new Error('context-lifecycle: require 0 < softRatio < hardRatio <= 1');
    if (!(config.cooldownMinutes >= 1))
        throw new Error('context-lifecycle: cooldownMinutes must be >= 1');
    if (!(config.minTokens >= 0))
        throw new Error('context-lifecycle: minTokens must be >= 0');
    if (!(config.fallbackContextWindow >= 4096))
        throw new Error('context-lifecycle: fallbackContextWindow must be >= 4096');
    if (!(config.pollMs >= 5000))
        throw new Error('context-lifecycle: pollMs must be >= 5000');
    if (!(config.idleHours >= 1))
        throw new Error('context-lifecycle: idleHours must be >= 1');
    return config;
}
/**
 * Decide what the user should be asked to confirm.
 *
 * - Too small to matter           → none
 * - Below soft threshold          → none
 * - Already compacted by us and pressure returned → new-session
 *   (compaction alone cannot keep up; every further round re-pays the tail)
 * - At/above hard threshold       → new-session
 * - Between soft and hard         → compact
 */
export function decideSuggestion(input, config) {
    const ratio = input.window > 0 ? input.tokens / input.window : 0;
    const pct = `${Math.round(ratio * 100)}%`;
    if (input.tokens < config.minTokens || input.eventCount < 8) {
        return { suggestion: 'none', ratio, reason: 'session still small' };
    }
    if (ratio < config.softRatio)
        return { suggestion: 'none', ratio, reason: 'below soft threshold' };
    if (input.compactedByUs) {
        return {
            suggestion: 'new-session',
            ratio,
            reason: `context back to ${pct} after compaction — repeated compaction yields diminishing returns`,
        };
    }
    if (ratio >= config.hardRatio) {
        return { suggestion: 'new-session', ratio, reason: `context at ${pct} of the window — near the ceiling` };
    }
    return { suggestion: 'compact', ratio, reason: `context at ${pct} — compressing old history is cheap now` };
}
// ── Handover extraction (deterministic, no LLM, no extra tokens) ────────
const PATH_ARG_KEYS = ['file_path', 'filePath', 'path', 'dir', 'directory'];
function textOf(blocks, cap) {
    const parts = [];
    for (const block of blocks ?? []) {
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        if (parts.join('\n').length > cap)
            break;
    }
    const joined = parts.join('\n').trim();
    return joined.length > cap ? `${joined.slice(0, cap)}…` : joined;
}
/** Collect file-ish paths from tool-call arguments across the surface. */
function collectFiles(messages, cap = 30) {
    const seen = new Set();
    const out = [];
    for (const message of messages) {
        for (const block of message.content ?? []) {
            if (block.type !== 'tool-call' || typeof block.arguments !== 'object' || block.arguments === null)
                continue;
            const args = block.arguments;
            for (const key of PATH_ARG_KEYS) {
                const value = args[key];
                if (typeof value === 'string' && value.length > 1 && value.length < 512 && !seen.has(value)) {
                    seen.add(value);
                    out.push(value);
                    if (out.length >= cap)
                        return out;
                }
            }
        }
    }
    return out;
}
/** Latest todo_write payload, reduced to its open items. */
function collectOpenTodos(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        for (const block of messages[i].content ?? []) {
            if (block.type !== 'tool-call' || block.name !== 'todo_write')
                continue;
            const todos = block.arguments?.todos;
            if (!Array.isArray(todos))
                continue;
            return todos.filter((t) => t.status !== 'completed').map((t) => String(t.content ?? '')).filter(Boolean);
        }
    }
    return [];
}
export function extractHandover(messages) {
    const firstUser = messages.find((m) => m.role === 'user');
    const task = textOf(firstUser?.content, 800) || '(unable to locate the opening task)';
    const assistantTexts = [];
    for (let i = messages.length - 1; i >= 0 && assistantTexts.length < 3; i--) {
        if (messages[i].role !== 'assistant')
            continue;
        const text = textOf(messages[i].content, 400);
        if (text)
            assistantTexts.unshift(text);
    }
    const files = collectFiles(messages);
    const todos = collectOpenTodos(messages);
    const lines = [
        '# Conversation handover (auto-generated by dsh-context-lifecycle)',
        '',
        '## Original task',
        task,
        '',
        '## Latest progress (verbatim tails)',
        ...assistantTexts.map((t) => `> ${t.replace(/\n/g, '\n> ')}`),
        '',
        '## Relevant files (referenced by tool calls)',
        ...(files.length ? files.map((f) => `- \`${f}\``) : ['- (none recorded)']),
    ];
    if (todos.length) {
        lines.push('', '## Open todos', ...todos.map((t) => `- [ ] ${t}`));
    }
    lines.push('', 'Continue from here. Re-read only the files you actually need before acting.');
    return { task, progress: assistantTexts.join('\n'), files, todos, markdown: lines.join('\n') };
}
// ── Context window discovery ────────────────────────────────────────────
function contextWindowOf(session, fallback) {
    for (let i = session.events.length - 1; i >= 0; i--) {
        const event = session.events[i];
        if (event.type !== 'request/context')
            continue;
        const value = event.data?.contextWindow ?? event.contextWindow ?? event.payload?.contextWindow;
        if (typeof value === 'number' && value > 0)
            return value;
    }
    return fallback;
}
// ── Plugin entry ────────────────────────────────────────────────────────
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    const states = new Map();
    const pendingCompact = new Map(); // sessionId -> agentId
    let lastEvalError = '';
    function agentKey(agent) {
        return String(agent.session.id ?? agent.id);
    }
    function evaluate(agent) {
        try {
            if (typeof ctx.tokenMeter?.measure !== 'function')
                return;
            const session = agent.session;
            const key = agentKey(agent);
            const window = contextWindowOf(session, config.fallbackContextWindow);
            const measurement = ctx.tokenMeter.measure(session);
            const tokens = Number(measurement?.totalTokens ?? 0);
            const prev = states.get(key);
            // 2026-08-24: 活动感知——取最后一条事件时间作为"最后活跃"，闲置会话不提示
            const lastEvent = session.events[session.events.length - 1];
            const lastActiveAt = Number(lastEvent?.time ?? lastEvent?.timestamp ?? 0) || 0;
            const idleMs = Date.now() - lastActiveAt;
            let decision = decideSuggestion({ tokens, window, compactedByUs: prev?.compactedByUs ?? false, eventCount: session.events.length }, config);
            if (idleMs > config.idleHours * 3600_000) {
                decision = { suggestion: 'none', ratio: decision.ratio, reason: 'session idle (no recent activity)' };
            }
            const state = prev ?? {
                sessionId: key,
                agentId: String(agent.id),
                tokens,
                window,
                ratio: decision.ratio,
                eventCount: session.events.length,
                suggestion: 'none',
                reason: decision.reason,
                compactedByUs: false,
                postCompactTokens: 0,
                lastSuggestionAt: 0,
                dismissedAtRatio: 0,
                lastEvaluatedAt: 0,
                actionBusy: false,
            };
            state.tokens = tokens;
            state.window = window;
            state.ratio = decision.ratio;
            state.eventCount = session.events.length;
            state.agentId = String(agent.id);
            state.lastEvaluatedAt = Date.now();
            if (decision.suggestion === 'none') {
                state.suggestion = 'none';
                state.reason = decision.reason;
            }
            else {
                const cooled = Date.now() - state.lastSuggestionAt >= config.cooldownMinutes * 60_000;
                const pastDismissal = decision.ratio >= state.dismissedAtRatio + 0.05; // 2026-08-24: 0.03->0.05，驳回后需涨更多才重提
                if ((state.suggestion === 'none' || state.suggestion !== decision.suggestion) && cooled && pastDismissal) {
                    state.suggestion = decision.suggestion;
                    state.reason = decision.reason;
                    state.lastSuggestionAt = Date.now();
                }
                else if (state.suggestion === decision.suggestion) {
                    state.reason = decision.reason; // keep existing suggestion fresh
                }
            }
            states.set(key, state);
        }
        catch (error) {
            lastEvalError = String(error?.message ?? error);
            try {
                ctx.logger.warn(`context-lifecycle: evaluate failed: ${String(error)}`);
            }
            catch { /* ignore */ }
        }
    }
    function findAgent(sessionId) {
        for (const agent of ctx.agents.list()) {
            if (agentKey(agent) === sessionId)
                return agent;
        }
        return undefined;
    }
    /** Resolve the compaction engine without an inject declaration. */
    function compactionEngine() {
        try {
            const direct = ctx.compaction;
            if (typeof direct?.compactNow === 'function')
                return direct;
        }
        catch { /* not injectable from this subtree */ }
        try {
            const viaReflect = ctx.reflect?.get?.('compaction', false);
            if (typeof viaReflect?.compactNow === 'function')
                return viaReflect;
        }
        catch { /* reflect path unavailable */ }
        return undefined;
    }
    /**
     * Resolve the human-command registry (same lazy strategy as compactionEngine).
     * Fallback path: `commands.execute(agent, '/compact')` runs the native slash
     * command — the exact code path the user would get by typing /compact — so
     * the button works even when the abstract compaction seam is unreachable
     * from this runtime-injected subtree.
     */
    function commandsRegistry(agent) {
        const usable = (r) => typeof r?.execute === 'function' ? r : undefined;
        try {
            const direct = usable(ctx.commands);
            if (direct)
                return direct;
        }
        catch { /* not injectable from this subtree */ }
        try {
            const viaReflect = usable(ctx.reflect?.get?.('commands', false));
            if (viaReflect)
                return viaReflect;
        }
        catch { /* reflect path unavailable */ }
        try {
            // Agent-scoped context: commands resolve inside the agent's own subtree.
            const viaAgent = usable(agent?.ctx?.commands);
            if (viaAgent)
                return viaAgent;
        }
        catch { /* agent ctx unavailable */ }
        return undefined;
    }
    async function runCompact(state) {
        const agent = findAgent(state.sessionId);
        if (!agent)
            return { status: 'error', detail: 'agent not live anymore' };
        if (agent.status !== 'idle') {
            pendingCompact.set(state.sessionId, state.agentId);
            return { status: 'queued', detail: 'agent busy; compaction will run as soon as it is idle' };
        }
        const engine = compactionEngine();
        const commands = engine ? undefined : commandsRegistry(agent);
        if (!engine && !commands)
            return { status: 'guidance', detail: '压缩服务在本插件作用域不可直接调用——请在输入框发送 /compact，效果相同' };
        state.actionBusy = true;
        try {
            const controller = new AbortController();
            let ok = false;
            let detail = '';
            if (engine) {
                const result = await engine.compactNow(agent, controller.signal);
                ok = true;
                detail = result ? 'compacted' : 'compaction reported nothing to do';
            }
            else {
                // Native /compact path: full command lifecycle logging included.
                const exec = await commands.execute(agent, '/compact', controller.signal);
                const result = exec?.result ?? exec;
                ok = !!result && result.kind === 'success';
                detail = result?.text ?? (ok ? 'compacted' : 'command did not resolve');
            }
            state.compactedByUs = ok;
            state.postCompactTokens = Number(ctx.tokenMeter?.measure?.(agent.session)?.totalTokens ?? 0);
            if (ok) {
                state.suggestion = 'none';
                state.reason = detail;
            }
            state.lastSuggestionAt = Date.now();
            return { status: ok ? 'done' : 'error', detail };
        }
        catch (error) {
            return { status: 'error', detail: String(error?.message ?? error) };
        }
        finally {
            state.actionBusy = false;
        }
    }
    // ── Polling loops ─────────────────────────────────────────────────────
    const pollTimer = setInterval(() => {
        try {
            for (const agent of ctx.agents.list())
                evaluate(agent);
        }
        catch { /* polling must never throw */ }
    }, config.pollMs);
    const pendingTimer = setInterval(() => {
        try {
            if (pendingCompact.size === 0)
                return;
            for (const [sessionId] of [...pendingCompact]) {
                const state = states.get(sessionId);
                const agent = findAgent(sessionId);
                if (!state || !agent) {
                    pendingCompact.delete(sessionId);
                    continue;
                }
                if (agent.status === 'idle') {
                    pendingCompact.delete(sessionId);
                    void runCompact(state).catch((e) => ctx.logger?.warn?.(`[context-lifecycle] runCompact failed: ${String(e)}`));
                }
            }
        }
        catch (e) {
            ctx.logger?.warn?.(`[context-lifecycle] pendingTimer error: ${String(e)}`);
        }
    }, 10_000);
    // ── HTTP surface for the client banner ────────────────────────────────
    const ROUTE = '/context-lifecycle';
    function json(res, code, body) {
        const payload = JSON.stringify(body);
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(payload);
    }
    async function readBody(req) {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        }
        catch {
            return {};
        }
    }
    function publicState(state) {
        return {
            sessionId: state.sessionId,
            agentId: state.agentId,
            tokens: state.tokens,
            window: state.window,
            ratio: state.ratio,
            suggestion: state.suggestion,
            reason: state.reason,
            busy: state.actionBusy || pendingCompact.has(state.sessionId),
        };
    }
    async function handle(req, res) {
        // 本机校验:回环对端 + Host 为本机名(GET 同源请求无 Origin,故不做 Origin 要求)
        const cAddr = req?.socket?.remoteAddress;
        if (cAddr !== '127.0.0.1' && cAddr !== '::1' && cAddr !== '::ffff:127.0.0.1') {
            return json(res, 403, { error: '拒绝非本机请求' });
        }
        try {
            const cHost = new URL(`http://${String(req?.headers?.host ?? '')}`).hostname;
            if (cHost !== '127.0.0.1' && cHost !== 'localhost' && cHost !== '[::1]' && cHost !== '::1') {
                return json(res, 403, { error: '拒绝非本机请求' });
            }
        }
        catch {
            return json(res, 403, { error: '拒绝非本机请求' });
        }
        try {
            let url = String(req.url ?? '').split('?')[0];
            // Tolerate both the full path and a prefix-stripped path.
            if (url.startsWith(ROUTE))
                url = url.slice(ROUTE.length) || '/';
            if (req.method === 'GET' && url.startsWith('/status')) {
                const probe = (fn) => {
                    try {
                        return String(fn());
                    }
                    catch (e) {
                        return `ERR:${String(e?.message ?? e)}`;
                    }
                };
                return json(res, 200, {
                    sessions: [...states.values()].map(publicState),
                    diag: {
                        agents: probe(() => ctx.agents.list().length),
                        tokenMeter: probe(() => typeof ctx.tokenMeter?.measure),
                        compaction: probe(() => (compactionEngine() ? 'resolved' : 'unresolved')),
                        commands: probe(() => (commandsRegistry() ? 'resolved' : 'unresolved')),
                        lastError: lastEvalError,
                    },
                });
            }
            if (req.method === 'POST' && url.startsWith('/decide')) {
      // M4 fix: require local Origin (blocks CSRF-triggered compaction from any local page)
      const hdrs = req.headers || {}
      const origin = String(hdrs.origin || '')
      if (origin) { try { const ou = new URL(origin); if (!['127.0.0.1','localhost','::1','[::1]'].includes(ou.hostname)) { res.writeHead(403); res.end(); return } } catch { res.writeHead(403); res.end(); return } }
      const sfs = String(hdrs['sec-fetch-site'] || '').toLowerCase()
      if (sfs && sfs !== 'same-origin' && sfs !== 'none') { res.writeHead(403); res.end(); return }
                const body = await readBody(req);
                const sessionId = String(body.sessionId ?? '');
                const action = String(body.action ?? '');
                const state = states.get(sessionId) ?? [...states.values()].find(() => true);
                if (!state)
                    return json(res, 404, { error: 'no tracked session' });
                if (action === 'dismiss') {
                    state.dismissedAtRatio = state.ratio;
                    state.suggestion = 'none';
                    state.reason = 'dismissed by user';
                    return json(res, 200, { status: 'done' });
                }
                if (action === 'compact') {
                    const result = await runCompact(state);
                    return json(res, 200, result);
                }
                if (action === 'new-session') {
                    const agent = findAgent(state.sessionId);
                    const messages = agent ? agent.session.deriveMessages() : [];
                    const handover = extractHandover(messages);
                    state.suggestion = 'none';
                    state.reason = 'user chose a new session';
                    state.lastSuggestionAt = Date.now();
                    return json(res, 200, { status: 'done', handover: handover.markdown });
                }
                return json(res, 400, { error: `unknown action ${JSON.stringify(action)}` });
            }
            json(res, 404, { error: 'not found' });
        }
        catch (error) {
            try {
                json(res, 500, { error: String(error?.message ?? error) });
            }
            catch { /* give up */ }
        }
    }
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }), 'context-lifecycle: api route');
    ctx.effect(() => () => {
        clearInterval(pollTimer);
        clearInterval(pendingTimer);
    }, 'context-lifecycle: timers');
    // Evaluate live agents once on load so the first poll is not 30s away.
    setTimeout(() => {
        try {
            for (const agent of ctx.agents.list())
                evaluate(agent);
        }
        catch { /* ignore */ }
    }, 1500);
}
//# sourceMappingURL=index.js.map