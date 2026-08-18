# dsh-session-history

**Message mini-map rail for DeepSeek Harness.**  
A narrow vertical bar pinned to the left edge of the conversation area, showing one short horizontal line per user-sent message. Click a line to jump the chat to that message; hover reveals the message content. The most-recent message is highlighted blue; clicking a line keeps it highlighted while the rest fade to white.

## Location

The rail mounts into the `shell.overlay` slot (root layout overlay list slot) and positions itself **at the left edge of the center (conversation) column** — it sits between the session list sidebar and the conversation pane, without blocking the conversation header or content. Only renders when a conversation is open (no effect on the new-session hero page).

## Features

- **Short horizontal lines** — one bar per user message, positioned proportionally by the message's real scroll position in the conversation (a mini-map).
- **No text in the rail** — pure lines; hover a bar to pop a tooltip with the message content.
- **Click to jump** — smooth-scrolls the chat to that message and centers it.
- **Selected highlighting** — the clicked bar stays blue; all other bars turn white (faded) for at-a-glance orientation.
- **Live updates** — new messages add bars automatically via MutationObserver.
- **Session switching** — bars re-enumerate for the current session; selection resets on switch.
- **Transparent, non-intrusive** — container has no background/border, only the bars are visible; the empty area passes clicks through.

## Files

| File | Purpose |
|------|---------|
| `package.json` | DSH bundle plugin manifest (name, exports, dsh.client config) |
| `cordis.patch.yml` | Loader patch (inserts the plugin row) |
| `lib/index.js` | Host-side entry (no-op — feature is purely client-side) |
| `lib/client.js` | Client-side bundle (hand-written, lazy-CJS, requires only `react`) |
| `README.md` | This file |

## Build

No build step. The client bundle is hand-written in the lazy-CJS bundle protocol (`window.__ModuleLoader__.load({...})`). The only external dependency is `react` (a platform seed word).

## Slot Registration

- `shell.overlay` (list, root scope) — the rail container
- Position: measured from the center column (`div[class*="centerCol"]`) via ResizeObserver
- Bars read from DOM: `[data-chat-flow-kind="user"]` rows inside the chat scroll container

## Credits

Created for the DeepSeek Harness desktop environment.  
GitHub: [luomious/deepseek-harness-desktop](https://github.com/luomious/deepseek-harness-desktop)