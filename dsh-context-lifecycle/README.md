# @dsh-external/dsh-context-lifecycle

**Token-saving context lifecycle manager.** Watches every live agent's request
pressure and, when a conversation grows expensive, asks the user — via a banner
above the composer — to confirm one of two recovery actions:

- **压缩 (compact)** — summarize old history (same engine as `/compact`)
- **新对话 (new-session)** — auto-generates a handover brief (original task,
  latest progress, referenced files, open todos) to paste into a fresh session

Nothing runs without a click. The plugin never interrupts the agent mid-turn.

## Decision engine

Measured by `ctx.tokenMeter.measure(session).totalTokens` against the model's
real context window (read from the session's `request/context` events,
fallback 131072):

| Condition | Suggestion |
| --- | --- |
| below `softRatio` (default 55%) | none |
| between soft and `hardRatio` (default 80%) | **compact** |
| at/above hard | **new-session** |
| already compacted once by this manager and pressure returned | **new-session** (repeated compaction yields diminishing returns — the tail keeps re-paying) |

Anti-nag guards: sessions under `minTokens` (8k) or under 8 events are ignored;
15-minute cooldown between suggestions; a dismissed suggestion only returns
after the ratio grows another 3 points.

## Architecture

- Host (`src/index.ts`, zero npm deps): 30s pressure poll over
  `ctx.agents.list()`, decision engine, action executor, HTTP API under
  `/context-lifecycle` (`GET /status`, `POST /decide`).
- Client (`lib/client.js`, hand-written lazy-CJS, react only): banner in the
  `conversation.input.dock` slot; polls `/status` every 8s while a session is
  open; renders the confirm buttons and the handover overlay with copy-to-clipboard.
  **Session scoping contract**: the dock slot injects the current conversation
  id as the standard prop `sessionId` and as `session`
  (`ConversationSnapshot` — whose id field is `sessionId`, **not** `id`).
  The banner matches `/status` strictly by that id, so one conversation's
  suggestion never leaks into another. Never read `session.id` — it is always
  `undefined` and silently breaks per-session matching.
- Token cost to the model: **zero** — no tools, no prompt additions; the banner
  is pure UI.

## Known degradation (empirically established)

- The compaction engine cannot be declared in this plugin's `inject` list:
  for runtime-injected external plugins, waiting on the `compaction` service
  blocks fiber creation forever (the dependency never resolves in the injected
  subtree; two reload attempts hung on exactly this). Resolution is attempted
  lazily (`ctx.compaction` → `ctx.reflect.get('compaction')`); when both fail
  (current state), the compact button returns guidance to run the identical
  built-in command `/compact` instead. Measurement, decisions, new-session
  handover, and dismissal are all fully automatic.
- Programmatic "open a new session" has no public client API; the new-session
  action generates the handover, copies it, and guides the click.

## Config

`cordis.patch.yml` config block (all optional):

```yaml
- insert:
    - id: dsh-context-lifecycle
      name: '@dsh-external/dsh-context-lifecycle'
      config:
        softRatio: 0.55
        hardRatio: 0.8
        cooldownMinutes: 15
        minTokens: 8000
        fallbackContextWindow: 131072
        pollMs: 30000
```

## Build / operate

```powershell
pnpm install
npx tsc -p tsconfig.json     # host → lib/index.js (client is hand-written)
node scripts/smoke.mjs       # 16-check offline suite (decision engine + handover)

# hot:  dev_inject_plugin dir=<folder>   /   dev_reload_package packageName=context-lifecycle
# perm: already installed in the web profile (bundles + link dep)
# rollback: dev_uninject_plugin 'context-lifecycle' (runtime), remove bundle entry for permanent
```

## Status probe

`GET http://127.0.0.1:43120/context-lifecycle/status` returns every tracked
session (tokens/window/ratio/suggestion/reason) plus `diag` (agent count,
tokenMeter availability, compaction resolution, last evaluation error).

## Verified

- 16/16 offline checks (thresholds, boundaries, zero-window safety, handover
  extraction, todo filtering, path dedup, truncation).
- Live: 11 agents measured with true per-model windows (1M / 262k / 1M);
  first real suggestion produced (`compact` at 69% on a 262k-window session).
- Persistence: profile bundles + `link:` dependency + junction confirmed;
  stale `disabled` patch entry removed.
