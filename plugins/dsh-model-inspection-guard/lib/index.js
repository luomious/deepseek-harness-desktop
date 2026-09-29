// @dsh-external/dsh-model-inspection-guard - upstream content-moderation rescue (host-only)
//
// WHY (all measured, 2026-09-24):
//  1) ModelScope's gateway moderates the INPUT and rejects long agent sessions with
//     `400 data_inspection_failed` / `InternalError.Algo.DataInspectionFailed`; the
//     failure code is the generic INVALID_REQUEST and the whole turn dies.
//     Measured: the rejected step had inputTokens=0/outputTokens=0 (rejected BEFORE
//     generation); the same model accepted 152,038 tokens of benign filler (200 OK);
//     the same 3 modelscope models return 200 for a short benign prompt.
//     => it is a CONTENT verdict, amplified by context size - NOT a length limit.
//  2) History proves it is upstream drift, not user config: modelscope ran 116 turns
//     with ZERO moderation rejections from 09-06..09-23, then 4/4 rejected on 09-24.
//  3) A "reroute BEFORE the request" guard CANNOT work here: the kernel's own
//     model-selection listener (dsh-agent/lib/index.js:287, dsh-agent/lib/types/
//     model-selection.js:33) re-applies the user's chosen provider/model on the way
//     out, overwriting anything an inner listener returns. Measured: the old guard
//     logged GUARD-SWITCH at seq 55857 while request/header seq 55857 was still
//     modelscope. Length-based pre-emption is therefore both inert AND mis-premised.
//  4) The seam that DOES work is `agent/request-error`: dsh-agent-loop/lib/index.js:
//     652-663 dispatches it and honours `{ kind: "retry" }` by re-running the step
//     (`continue`). dsh-llm-retry uses that same hook, and INVALID_REQUEST is NOT in
//     its retryableCodes, so it falls through via next() and the event reaches us.
//     Registering with { prepend: true } puts us OUTSIDE it (cordis waterfall runs
//     outermost-first; verified against the real cordis: prepend -> normal -> inner).
//
// DESIGN: pure rescue, zero interference.
//   * Normal path is untouched - the user's model choice always wins until it fails.
//   * On an inspection failure only: queue a reroute for that agent and ask for ONE
//     retry. Budget is per turn:step, so a persistent rejection degrades to today's
//     behaviour instead of looping.
//   * Every path is fail-open; any error passes straight through.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "@dsh-external/dsh-model-inspection-guard";
export const inject = ["tools"];

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const LOG_PATH = join(DSH_HOME, "super-injector", "model-inspection-guard.log");
function log(...parts) {
  try {
    mkdirSync(join(DSH_HOME, "super-injector"), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch {}
}

const DEFAULTS = {
  enabled: true,
  fallback: { modelscope: "modlens-tokenrhythm01", "modlens-modelscope": "modlens-tokenrhythm01" },
  fallbackModel: { modelscope: "deepseek-v4-flash-0731", "modlens-modelscope": "deepseek-v4-flash-0731" },
  maxRetriesPerStep: 1,
  logDecisions: true,
};

function normalizeStringMap(raw, fallback) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : fallback;
  if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) {
      if (typeof k === "string" && k && typeof v === "string" && v && v !== k) out[k] = v;
    }
  }
  return out;
}

export function normalizeConfig(config) {
  const raw = config && typeof config === "object" ? config : {};
  const n = Number(raw.maxRetriesPerStep);
  return {
    enabled: raw.enabled !== false,
    fallback: normalizeStringMap(raw.fallback, DEFAULTS.fallback),
    fallbackModel: normalizeStringMap(raw.fallbackModel, DEFAULTS.fallbackModel),
    maxRetriesPerStep: Number.isFinite(n) && n >= 0 ? n : DEFAULTS.maxRetriesPerStep,
    logDecisions: raw.logDecisions !== false,
  };
}

/** Does this failure look like the upstream input-moderation rejection? */
export function isInspectionFailure(failure) {
  const msg = String((failure && failure.message) || "");
  const code = String((failure && failure.code) || "");
  return /data_inspection_failed|DataInspectionFailed/i.test(msg) || /data_inspection_failed/i.test(code);
}

/** Build the rerouted request config (new object; drop reasoningEffort - heterogeneous models reject it). */
export function applyGuard(resolved, to, model) {
  const { reasoningEffort: _drop, ...rest } = resolved || {};
  return model ? { ...rest, provider: to, model } : { ...rest, provider: to };
}

export function apply(ctx, config) {
  const state = { cfg: normalizeConfig(config), retries: 0, rescues: [], pending: new Map(), budget: new Map() };

  // Outermost request hook: apply a rescue reroute queued by the error hook.
  // prepend is required - an inner listener is overwritten by model-selection.
  ctx.on("agent/request", async (payload, next) => {
    let queued;
    try {
      const agent = payload && payload.agent;
      if (agent && state.pending.has(agent)) { queued = state.pending.get(agent); state.pending.delete(agent); }
    } catch { queued = undefined; }
    const resolved = await next();
    try {
      if (!queued) return resolved;
      const out = applyGuard(resolved, queued.provider, queued.model);
      if (state.cfg.logDecisions) log(`RESCUE-APPLIED ${resolved && resolved.provider}/${resolved && resolved.model} -> ${out.provider}/${out.model}`);
      return out;
    } catch { return resolved; }
  }, { prepend: true });

  // Failure hook: only an upstream moderation rejection triggers a rescue.
  ctx.on("agent/request-error", async (payload, next) => {
    try {
      const c = state.cfg;
      if (!c.enabled) return next();
      const failure = payload && payload.failure;
      if (!isInspectionFailure(failure)) return next();
      const from = payload && payload.provider;
      const to = c.fallback[from];
      if (!to || to === from) return next();
      const key = `${payload.turn}:${payload.step}`;
      const used = state.budget.get(key) || 0;
      if (used >= c.maxRetriesPerStep) { log(`RESCUE-BUDGET-EXHAUSTED ${key} (${used}) -> pass through`); return next(); }
      state.budget.set(key, used + 1);
      if (state.budget.size > 200) state.budget.clear();
      const model = c.fallbackModel[from];
      if (payload.agent) state.pending.set(payload.agent, { provider: to, model });
      state.retries += 1;
      const rec = { at: new Date().toISOString().slice(11, 19), turn: payload.turn, step: payload.step, from, to, model: model || "(kept)" };
      state.rescues.push(rec);
      if (state.rescues.length > 50) state.rescues.shift();
      log(`RESCUE-TRIGGERED turn=${payload.turn} step=${payload.step} ${from} -> ${to}/${model || "(kept)"} (retry ${used + 1}/${c.maxRetriesPerStep})`);
      return { kind: "retry" };
    } catch (e) {
      log("RESCUE-ERROR " + (e && e.message));
      return next();
    }
  }, { prepend: true });

  const registerTool = (tool) => ctx.tools.register({ ...tool, parameters: toJsonSchema(tool.parameters) });
  try {
    registerTool({
      name: "dev_inspection_guard_status",
      description: "Show the content-moderation rescue config (fallback map, retry budget) and recent rescue decisions. Read-only.",
      parameters: {},
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      execute: () => {
        const c = state.cfg;
        return [
          `enabled=${c.enabled}  maxRetriesPerStep=${c.maxRetriesPerStep}  logDecisions=${c.logDecisions}`,
          `trigger=agent/request-error (inspection failures only)  action=reroute + {kind:"retry"}`,
          "fallback map:",
          ...Object.keys(c.fallback).sort().map((p) => `  ${p} -> ${c.fallback[p]}${c.fallbackModel[p] ? " model->" + c.fallbackModel[p] : ""}`),
          `counters: rescues=${state.retries}  pendingReroutes=${state.pending.size}`,
          `recent rescues (${state.rescues.length}):`,
          ...state.rescues.slice(-8).map((d) => `  ${d.at} turn=${d.turn} step=${d.step} ${d.from} -> ${d.to}/${d.model}`),
        ].join("\n");
      },
    });
  } catch {}

  try {
    registerTool({
      name: "dev_inspection_guard_configure",
      description: "Runtime-configure the moderation rescue: enable/disable, retry budget, fallback mapping, logging. NOT persisted - reverts to patch config on restart.",
      parameters: {
        enabled: { type: "boolean", description: "enable/disable the rescue" },
        maxRetriesPerStep: { type: "number", description: "retries allowed per turn:step (0 disables)" },
        setFallback: { type: "string", description: "rejected provider whose fallback to set (pair with fallbackTo)" },
        fallbackTo: { type: "string", description: "provider to rescue onto" },
        setFallbackModel: { type: "string", description: "provider whose fallback model to set (pair with fallbackModelTo)" },
        fallbackModelTo: { type: "string", description: "model id on the rescue provider" },
        logDecisions: { type: "boolean", description: "log each rescue decision" },
        clearStats: { type: "boolean", description: "reset counters" },
      },
      output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
      execute: (args) => {
        const c = state.cfg; const notes = [];
        if (args.enabled !== undefined) { c.enabled = !!args.enabled; notes.push(`enabled=${c.enabled}`); }
        if (args.maxRetriesPerStep !== undefined) { c.maxRetriesPerStep = Number(args.maxRetriesPerStep) || 0; notes.push(`maxRetriesPerStep=${c.maxRetriesPerStep}`); }
        if (args.setFallback && args.fallbackTo) { c.fallback[String(args.setFallback)] = String(args.fallbackTo); notes.push(`fallback ${args.setFallback}->${args.fallbackTo}`); }
        if (args.setFallbackModel && args.fallbackModelTo) { c.fallbackModel[String(args.setFallbackModel)] = String(args.fallbackModelTo); notes.push(`fallbackModel ${args.setFallbackModel}->${args.fallbackModelTo}`); }
        if (args.logDecisions !== undefined) { c.logDecisions = !!args.logDecisions; notes.push(`logDecisions=${c.logDecisions}`); }
        if (args.clearStats) { state.retries = 0; state.rescues.length = 0; state.budget.clear(); notes.push("stats cleared"); }
        log(`CONFIGURE ${notes.join("; ") || "no-op"}`);
        return notes.join("; ") || "no-op";
      },
    });
  } catch {}

  log(`armed: enabled=${state.cfg.enabled} maxRetriesPerStep=${state.cfg.maxRetriesPerStep} fallback=${JSON.stringify(state.cfg.fallback)}`);
}

export function toJsonSchema(spec) {
  const properties = {}; const required = [];
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type };
    if (Array.isArray(meta.enum)) prop.enum = meta.enum;
    if (meta.description) prop.description = meta.description;
    properties[key] = prop;
    if (meta.required) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
