// dsh-model-inspection-guard - pure logic + end-to-end (fake ctx) tests, no DSH runtime needed.
// Run: node plugins/dsh-model-inspection-guard/test/guard.test.mjs
import assert from "node:assert";
import { normalizeConfig, isInspectionFailure, applyGuard, apply } from "../lib/index.js";

// ---- normalizeConfig -------------------------------------------------------
assert.deepEqual(normalizeConfig({}), {
  enabled: true,
  fallback: { modelscope: "modlens-tokenrhythm01", "modlens-modelscope": "modlens-tokenrhythm01" },
  fallbackModel: { modelscope: "deepseek-v4-flash-0731", "modlens-modelscope": "deepseek-v4-flash-0731" },
  maxRetriesPerStep: 1,
  logDecisions: true,
});
assert.equal(normalizeConfig({ enabled: false }).enabled, false);
assert.equal(normalizeConfig({ maxRetriesPerStep: 0 }).maxRetriesPerStep, 0);
assert.equal(normalizeConfig({ maxRetriesPerStep: -1 }).maxRetriesPerStep, 1, "negative -> default");
assert.equal(normalizeConfig({ maxRetriesPerStep: "x" }).maxRetriesPerStep, 1, "garbage -> default");
assert.deepEqual(normalizeConfig({ fallback: { a: "b", same: "same", y: "" } }).fallback, { a: "b" }, "self/empty mappings filtered");

// ---- isInspectionFailure: must be narrow (reverse controls) ----------------
const INSP = { message: `400: {"code":"data_inspection_failed","message":"<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content."}`, code: "INVALID_REQUEST" };
assert.equal(isInspectionFailure(INSP), true);
assert.equal(isInspectionFailure({ message: "DataInspectionFailed" }), true);
assert.equal(isInspectionFailure({ message: "x", code: "data_inspection_failed" }), true);
// reverse controls: these must NOT be treated as moderation
assert.equal(isInspectionFailure({ message: "429 rate limit exceeded", code: "RATE_LIMIT" }), false);
assert.equal(isInspectionFailure({ message: "400 invalid request", code: "INVALID_REQUEST" }), false, "generic INVALID_REQUEST alone is not enough");
assert.equal(isInspectionFailure({ message: "insufficient quota", code: "QUOTA" }), false);
assert.equal(isInspectionFailure({}), false);
assert.equal(isInspectionFailure(null), false);
assert.equal(isInspectionFailure(undefined), false);

// ---- applyGuard ------------------------------------------------------------
{
  const seed = { provider: "modlens-modelscope", model: "deepseek-ai/DeepSeek-V4.1-Flash", reasoningEffort: "high", maxTokens: 8192 };
  const frozen = JSON.stringify(seed);
  const out = applyGuard(seed, "modlens-tokenrhythm01", "deepseek-v4-flash-0731");
  assert.equal(out.provider, "modlens-tokenrhythm01");
  assert.equal(out.model, "deepseek-v4-flash-0731");
  assert.equal("reasoningEffort" in out, false, "must drop reasoningEffort");
  assert.equal(out.maxTokens, 8192);
  assert.equal(JSON.stringify(seed), frozen, "must not mutate input");
  assert.equal(applyGuard(seed, "p", undefined).model, "deepseek-ai/DeepSeek-V4.1-Flash", "no model configured -> keep original");
}

// ---- end-to-end harness ----------------------------------------------------
function makeFakeCtx() {
  const listeners = {}; const registeredTools = []; const registrations = [];
  return {
    listeners, registeredTools, registrations,
    on(evt, fn, options) { (listeners[evt] ||= []).push(fn); registrations.push({ evt, options }); },
    tools: { register(tool) { registeredTools.push(tool); } },
  };
}
const AGENT = { id: "a1", session: { events: [] } };
async function driveRequest(listeners, seed, agent = AGENT) {
  const next = async () => seed;
  let result = seed;
  for (const fn of listeners["agent/request"] || []) result = await fn({ agent, turn: 1, step: 1 }, next);
  return result;
}
async function driveError(listeners, payload) {
  let calledNext = false;
  const next = async () => { calledNext = true; return undefined; };
  let result;
  for (const fn of listeners["agent/request-error"] || []) result = await fn(payload, next);
  return { result, calledNext };
}
const errPayload = (failure, provider = "modlens-modelscope", turn = 1, step = 1) =>
  ({ agent: AGENT, turn, step, provider, failure, retryPolicy: { mode: "normal", retryableCodes: ["RATE_LIMIT"] } });

// 1) prepend is registered on BOTH hooks - this is the whole reason the fix works.
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  const req = ctx.registrations.filter((r) => r.evt === "agent/request");
  const err = ctx.registrations.filter((r) => r.evt === "agent/request-error");
  assert.equal(req.length, 1);
  assert.equal(err.length, 1);
  assert.deepEqual(req[0].options, { prepend: true }, "request hook must be OUTERMOST (model-selection overwrites inner listeners)");
  assert.deepEqual(err[0].options, { prepend: true }, "error hook must be OUTERMOST (outside dsh-llm-retry)");
}

// 2) inspection failure -> retry + reroute queued; the reroute then reaches the request
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  const { result } = await driveError(ctx.listeners, errPayload(INSP));
  assert.deepEqual(result, { kind: "retry" }, "must ask the kernel to re-run the step");
  const out = await driveRequest(ctx.listeners, { provider: "modlens-modelscope", model: "deepseek-ai/DeepSeek-V4.1-Flash", reasoningEffort: "high" });
  assert.equal(out.provider, "modlens-tokenrhythm01", "queued reroute must be applied");
  assert.equal(out.model, "deepseek-v4-flash-0731");
  assert.equal("reasoningEffort" in out, false);
}

// 3) REVERSE CONTROL: a non-moderation failure must NOT be rescued
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  const { result, calledNext } = await driveError(ctx.listeners, errPayload({ message: "429 rate limit", code: "RATE_LIMIT" }));
  assert.equal(result, undefined);
  assert.equal(calledNext, true, "must delegate to the normal retry policy");
  const out = await driveRequest(ctx.listeners, { provider: "modlens-modelscope", model: "m" });
  assert.equal(out.provider, "modlens-modelscope", "no reroute may be queued for non-moderation failures");
}

// 4) REVERSE CONTROL: generic INVALID_REQUEST must not trigger a rescue
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  const { calledNext } = await driveError(ctx.listeners, errPayload({ message: "400 bad request", code: "INVALID_REQUEST" }));
  assert.equal(calledNext, true);
}

// 5) REVERSE CONTROL: no fallback mapping -> no rescue
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({ fallback: {} }));
  const { calledNext } = await driveError(ctx.listeners, errPayload(INSP));
  assert.equal(calledNext, true, "unmapped provider must pass through");
}

// 6) REVERSE CONTROL: disabled -> no rescue
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({ enabled: false }));
  const { calledNext } = await driveError(ctx.listeners, errPayload(INSP));
  assert.equal(calledNext, true);
}

// 7) Retry budget: a second rejection in the same step must NOT loop
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({ maxRetriesPerStep: 1 }));
  const first = await driveError(ctx.listeners, errPayload(INSP));
  assert.deepEqual(first.result, { kind: "retry" });
  const second = await driveError(ctx.listeners, errPayload(INSP));
  assert.equal(second.calledNext, true, "budget exhausted -> pass through (degrade, never loop)");
  assert.equal(second.result, undefined);
}
// 7b) a DIFFERENT step gets its own budget
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({ maxRetriesPerStep: 1 }));
  await driveError(ctx.listeners, errPayload(INSP, "modlens-modelscope", 1, 1));
  const other = await driveError(ctx.listeners, errPayload(INSP, "modlens-modelscope", 1, 2));
  assert.deepEqual(other.result, { kind: "retry" }, "budget is per turn:step");
}

// 8) Zero interference on the happy path
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  const seed = { provider: "tokenrhythm01", model: "deepseek-flash", reasoningEffort: "high" };
  const out = await driveRequest(ctx.listeners, seed);
  assert.deepEqual(out, seed, "a normal request must be returned untouched");
}

// 9) fail-open on malformed input
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  let threw = false;
  try {
    for (const fn of ctx.listeners["agent/request-error"] || []) await fn(null, async () => undefined);
    for (const fn of ctx.listeners["agent/request"] || []) await fn(null, async () => ({ provider: "x", model: "y" }));
  } catch { threw = true; }
  assert.equal(threw, false, "malformed payloads must be swallowed");
}

// 10) tools registered and usable
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  const names = ctx.registeredTools.map((t) => t.name);
  assert.ok(names.includes("dev_inspection_guard_status"));
  assert.ok(names.includes("dev_inspection_guard_configure"));
  const cfgTool = ctx.registeredTools.find((t) => t.name === "dev_inspection_guard_configure");
  assert.ok(cfgTool.execute({ maxRetriesPerStep: 0 }).includes("maxRetriesPerStep=0"));
  assert.ok(cfgTool.execute({}).includes("no-op"));
  const statusTool = ctx.registeredTools.find((t) => t.name === "dev_inspection_guard_status");
  assert.ok(statusTool.execute({}).includes("fallback map"));
  assert.ok(statusTool.execute({}).includes("rescues="));
}

// 11) a rescue is idempotent w.r.t. the request hook (consumed once)
{
  const ctx = makeFakeCtx();
  apply(ctx, normalizeConfig({}));
  await driveError(ctx.listeners, errPayload(INSP));
  const first = await driveRequest(ctx.listeners, { provider: "modlens-modelscope", model: "m" });
  assert.equal(first.provider, "modlens-tokenrhythm01");
  const second = await driveRequest(ctx.listeners, { provider: "modlens-modelscope", model: "m" });
  assert.equal(second.provider, "modlens-modelscope", "queued reroute must be consumed exactly once");
}

console.log("ALL TESTS PASSED");
