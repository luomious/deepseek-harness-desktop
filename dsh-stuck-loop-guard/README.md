# @dsh-external/dsh-stuck-loop-guard

Advisory **failure-loop guard** for DeepSeek Harness. Detects when an agent
keeps failing on the *same approach* and injects escalating pivot directives,
so stuck sessions burn fewer tokens and recover faster.

## Why it exists

The in-box `dsh-repeat-tool-reminder` only catches **exact-argument**
repetition. Real stuck loops usually vary the arguments slightly (different
`old_string`, different path, different retry flag) while repeating a failing
approach — invisible to exact-match detection.

This guard tracks per-agent chains of consecutive failures keyed by
**tool name + error code + normalized error signature** (whitespace collapsed,
numbers/hex runs masked), so near-identical failures share one chain.

## Behavior

| Consecutive same-signature failures | Action |
| --- | --- |
| 3 (tier 1) | Diagnose directive: read the error literally, re-verify assumptions, one targeted change. `TOOL_TIMEOUT` failures get an extra hint to use `timeoutMs`/background jobs. |
| 5 (tier 2), then every multiple of 5 | Escalation ladder: switch approach → reduce scope → subagent with error context → ask the user. |

Reset rules: any success resets the chain; `ABORTED`/`ABORTED_BEFORE_DISPATCH`
(user-initiated cancels) are neither counted nor counted against; a fresh user
message resets the chain (`agent/pre-step`).

**Safety contract**

- Advisory only — never blocks, rewrites, or denies calls.
- Fail-safe — every observer runs inside try/catch; a guard bug cannot break
  the `tools/post-execute` waterfall.
- Zero runtime imports — no dependency drift against harness upgrades.
- O(1) per call; signatures capped at `signatureChars`.

## Config

Defaults are applied in code. To override persistently, edit `config` in
`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-stuck-loop-guard
      name: '@dsh-external/dsh-stuck-loop-guard'
      config:
        thresholds: [3, 5]      # integers >= 2, ascending; reminders fire here
        signatureChars: 160     # max normalized error text quoted in reminders
        include: []             # wildcard allowlist, empty = all tools
        exclude: ['job_output'] # wildcard denylist (e.g. legitimate polling tools)
```

Tuning guidance:

- Legitimate polling/retry tools (job watchers, log tailers) → add to `exclude`.
- Slow builds/tests that can hang → keep tracked; tier-1 reminds the agent to
  use `timeoutMs` or background jobs.
- Softer touch: `thresholds: [4, 7]`. More aggressive: `[2, 4]`.

## Build / install

```powershell
# Build (needs only TypeScript; zero runtime deps)
pnpm install            # or npm i -D typescript
npx tsc -p tsconfig.json
node scripts/smoke.mjs  # 19-check offline behavior test

# Runtime inject (no restart; lasts until harness restart):
#   dev_inject_plugin  dir=<this folder>

# Persistent install (survives restarts):
#   dsh plugin --profile web add <this folder>

# Rollback:
#   dev_uninject_plugin 'stuck-loop-guard'   (runtime)
```

## Monitoring and evaluation

Every fired reminder and every failure-chain settlement (>= 2 consecutive
failures) is appended to `data/events.jsonl` (disable with `stats: false`,
relocate with `statsFile`). This is the durable record the guard watches over.

```powershell
# Report to stdout (last 7 days by default):
node scripts/evaluate.mjs

# Write REPORT.md for a specific window:
node scripts/evaluate.mjs --days 4 --write
```

The report covers: fire volume per tool/day, diagnose vs escalate split,
chain-settle depth histogram, recurring problem clusters (same tool + error
signature), verdict heuristics, and concrete tuning suggestions.

Automatic evaluation: `scripts/timer-2026-08-23.cjs` runs detached and writes
`REPORT.md` at the window end; the plugin additionally self-checks on every
harness boot (reboot catch-up) and spawns the evaluator once the audit trail
has aged past 3 days without a report.

## Verified

- `scripts/smoke.mjs`: 19/19 checks (firing tiers, resets, abort handling,
  decision passthrough, freezing, config fail-loud).
- Hot-injected into the live `web` profile; triggered end-to-end by three
  consecutive `edit` failures with distinct arguments and identical error
  signature (`FS_EDIT_NOT_FOUND`), injecting the tier-1 directive while the
  stock repeat-tool-reminder correctly stayed silent.
