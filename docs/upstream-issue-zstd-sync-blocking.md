# [Performance] `zstdDecompressSync` blocks the event loop while loading large sessions

**Repo**: deepseek-ai/deepseek-harness
**Package**: `@deepseek-ai/dsh-session-persistence-jsonl`
**Severity**: High — reproducible multi-second UI freezes ("not responding") on Windows desktop shell
**Proposed fix**: async / worker-thread decompression

---

## Summary

Loading large compressed session logs (4–17 MB on disk) synchronously blocks the
Node.js event loop for hundreds of milliseconds to multiple seconds, freezing the
whole host (Electron renderer shows "not responding", input becomes unresponsive).
Both Zstandard decoder paths in `dsh-session-persistence-jsonl` are synchronous.

## Root cause — exact source locations

`vendor/.../node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
(verified against the build shipping with the desktop app):

1. **Public fallback decoder** — `PublicZstdFrameDecoder.decode()`, line 468:
   ```js
   decoded = zstdDecompressSync(source.subarray(start, end));
   ```
   One-shot synchronous decode per frame via `node:zlib.zstdDecompressSync`.

2. **Private optimized decoder** — `NodePrivateZstdFrameDecoder.decodeFrame()`, line 412:
   ```js
   handle.writeSync(this.stream._defaultFlushFlag, input, inputOffset, inputRemaining, this.output, 0, this.output.length);
   ```
   The "optimized" path reuses a Node Zstd stream's private handle via `writeSync`
   (using `candidate._handle`, `_writeState`, `_defaultFlushFlag` — Node-private
   contracts). It avoids per-frame `zstdDecompressSync` overhead but is **still
   fully synchronous** on the main thread.

3. **Hot call sites that trigger the sync decode**:
   - `readZstdPrefix()` (lines 955–1019) — loads a session's event prefix; iterates
     frames with `await scheduler.yield()` **between** frames (line 976), but each
     individual frame decode inside the loop is synchronous.
   - `readFirstZstdLine()` (lines 1279–1313) — reads the header frame; called by
     `listArtifacts()`/`list()` for **every session in the sidebar**, so a single
     oversized session stalls the whole sidebar hydration.
   - `readRaw()` (lines 869–895) — full artifact export.

4. **Compression is async, decompression is not** — `compressZstdFrame()` uses the
   promisified `zstdCompressAsync`, while the read paths deliberately use the
   synchronous decoders (see `createZstdFrameDecoder()` selection, lines 588–590).

## Evidence / monitoring timeline

From the desktop wrapper's changelog (2026-08-25):

- `session-34b88ace` — 8.9 MB on disk, 11,600+ frames: opening/touching it caused
  a multi-second main-thread stall.
- `session-a74ea214` — 17.5 MB on disk: opening it froze the app hard ("休眠地雷",
  i.e. a dormant landmine; users are told not to open it).
- UI symptom: window goes transparent / "DSH Desktop 未响应", input cannot be
  typed — the same freeze class previously attributed to GPU issues, re-diagnosed
  as event-loop starvation by the synchronous decompress.

## Reproduction

1. Let one session grow large (extensive tool use, 1,000+ events; compressed
   artifact reaches 4–17 MB).
2. Open or hover that session in the sidebar (triggers `list()` →
   `readFirstZstdLine()`, or `readPrefix()` on resume).
3. Observe the event loop stall; on Windows the Electron window reports
   "not responding".

A 17.5 MB file with ~11,600 frames means thousands of synchronous decode
round-trips on one thread.

## Suggested fix (the only real cure)

Move frame decode off the main thread:

- **Option A (minimal)**: switch the hot read paths to the async per-frame API
  that already exists in the same module — `decompressZstdFrame()` /
  `promisify(zstdDecompress)` — and keep the existing `scheduler.yield()` points,
  which then actually become effective. Frame boundary semantics are unchanged
  (each frame is independently decodable and checksummed).
- **Option B (optimal)**: decode in a `worker_threads` pool. The
  `NodePrivateZstdFrameDecoder`'s native stream context can be created once per
  worker and reused across frames/sessions, preserving the existing performance
  optimization without blocking the main thread.

Suggested priority: A for a quick unblock, B as the durable fix. Both are
backward compatible — the container format (concatenated independent frames,
header-first) is unchanged, so existing artifacts remain readable.

## Environment

- Node.js 22/24/26 (module has explicit compatibility probes for these)
- Windows desktop shell (Electron), observed freeze; same blocking applies to any
  host process since it is main-thread sync work
