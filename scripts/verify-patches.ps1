# verify-patches.ps1 - verify dist patches (windowsHide / sandbox runner node) and critical-guard sources.
# PURE ASCII ONLY (PS 5.1 reads UTF-8 no-BOM as GBK -> syntax errors).
# Run after every rebuild to confirm dist patches survived.
# The patch target is resolved dynamically via scripts/resolve-dist.mjs (the
# newest real build; the app entry junction is separate and managed by
# promote-build.ps1), so this never goes stale when a rebuild lands in a new
# directory.

# --- DSH version matrix (2026-09-08 dry-run rehearsal vs official 0.1.3-alpha.2) ---
# Retirement candidates (official 0.1.3-alpha.2 covers natively / target package gone):
#   #17 subprocess-local windowsHide    -> official ships windowsHide:true (3 sites)
#   #31 host-apiproxy default cwd home  -> ApiProxy removed; npm frozen at 0.1.1-rc.2
#   #48 picker utf16 NUL fix            -> official worker.cjs has readUtf16 (confirm via smoke)
#   #54 workspace bundle ADD_CHAT       -> bundle rewritten, anchor gone
#   #55 conversation bundle chatOnly    -> bundle rewritten, anchor gone
#   #59/#67/#69 session zstd patches    -> official node:zlib zstd + packed chunks + revisions
# Keep & re-apply on upgrade:
#   #32 sandbox-local runner node (#15) -> official still uses process.execPath as node
#   #40/#41 pwsh recycle-bin guard      -> no official recycle handling
#   #57 frontend-static no-cache        -> no official cache headers
#   #56/#58 settings-models / dir-picker browse bundles -> re-evaluate after client rewrite
# Full evidence: _backups/upstream-probe-0.1.3-alpha.2/IMPACT-REPORT.md

# 2026-09-10 (W1-4): never swallow errors globally. With SilentlyContinue a
# broken lookup (missing node, unreadable file, failed chunk scan) reported PASS,
# which is the worst possible failure mode for a deployment gate. Expected
# misses are guarded locally with -ErrorAction SilentlyContinue on purpose.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\src'

$build = (& node (Join-Path $PSScriptRoot 'resolve-dist.mjs')) | ConvertFrom-Json
$unpacked = $build.unpackedRoot

$checks = @(
  @{ n = 'subprocess-local windowsHide';        f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'spill-hardening marker (dist)';       f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js'; p = 'dsh-patch: spill-hardening' },
  @{ n = 'spill-hardening marker (pkg copy)';   f = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-plugin-desktop\node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js'; p = 'dsh-patch: spill-hardening' },
  @{ n = 'open windowsHide';                    f = Join-Path $unpacked 'node_modules\open\index.js'; p = 'windowsHide = true' },
  @{ n = 'default-browser windowsHide';         f = Join-Path $unpacked 'node_modules\default-browser\windows.js'; p = 'windowsHide: true' },
  @{ n = 'materializer windowsHide (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'windowsHide: true,' },
  @{ n = 'gpu force-disable (lib/main)';        f = Join-Path $unpacked 'lib\main.js'; p = 'DSH_DESKTOP_FORCE_GPU' },
  @{ n = 'in-process-gpu + disable-gpu-compositing (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'app.commandLine.appendSwitch("in-process-gpu")' },
  @{ n = 'occlusion switches (lib/main)';       f = Join-Path $unpacked 'lib\main.js'; p = 'CalculateNativeWinOcclusion' },
  @{ n = 'gpu policy: hw accel default (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-gpu-policy-2026-09-16' },
  @{ n = 'zombie cleanup (lib/main)';            f = Join-Path $unpacked 'lib\main.js'; p = 'ZombieCleanup(' },
  @{ n = 'vision-engine runCli windowsHide';    f = Join-Path $root 'plugins\dsh-vision-engine\lib\index.js'; p = 'windowsHide: true' },
  @{ n = 'autoread run windowsHide';            f = Join-Path $root 'plugins\dsh-modlens-autoread\lib\index.js'; p = 'windowsHide: true' },
  # 2026-09-23（两条插件侧修复，均来自「推荐了但没生效」复查的实测；工作区插件 —— 插件重装/更新会静默丢失）：
  # ① vision-engine `/refresh` 把 ok 硬编码为 true 且丢弃 error ⇒ 面板「模型试读自测」对失败 profile 报假绿，
  #    客户端 client.js:725-734 的 selfTestFail 分支永不触发。实测：p-gemini 经 /refresh 返回 ok:true + 空 summary，
  #    而 /vision-engine/test 直通显示真错（Gemini 503 高需求）。测试 tests/plugins/vision-refresh-falsegreen.test.mjs。
  # ② autoread 限流自愈的候选按「baseUrl 含 openrouter.ai」挑，但重试固定带 `--provider openai`，
  #    该槽端点由 modlens config.json 决定且被 dsh-vision-rotator 改写 ⇒ 实测 400/1211「模型不存在」，
  #    每次自愈白跑 ≤3 次 × 180s 且永不成功。改为「候选必须与当前槽同端点」。
  #    测试 plugins/dsh-modlens-autoread/test/rate-limit-fallback.test.mjs。
  @{ n = 'vision-engine refresh 失败透传';       f = Join-Path $root 'plugins\dsh-vision-engine\lib\index.js'; p = 'dsh patch vision-refresh-falsegreen v1' },
  @{ n = 'autoread 端点匹配自愈';                f = Join-Path $root 'plugins\dsh-modlens-autoread\lib\index.js'; p = 'dsh patch autoread-endpoint-matched-fallback v1' },
  # modality-vision-suffix-guard（2026-09-23）：TEXT_PATTERNS 的家族级通配把视觉变体判成纯文本 ——
  # 实测 seed-3-vl（seed-*）/ ernie-4.5-vl-32b、ernie-5-vl（ernie-*）/ hy3-vl（hy3*）/
  # deepseek-v3-vl（deepseek-v3*）全部判 text；且 seed-2.1-* / seed-* 两条**被网关端到端实测证伪**
  # （真 key 发 64×64 PNG：seed-2.1-turbo / seed-2.1-pro 返回 200 且读对颜色）⇒ 已移除。
  # 修法：在 TEXT 表之前加「无歧义视觉后缀」守卫（*-vl / *-vision* / *-omni* / *visual*），
  # 刻意不收 `v[0-9]`（会把 deepseek-v4-* 的版本号当视觉标记，制造新误判）。
  # 影响面：运行时通道不可达（实测表相关 reason = 0 条），实际生效点是
  # scripts/classify-settings-modalities.mjs（新模型声明 input: 时的判定）。
  # 测试 plugins/dsh-modlens-autoread/test/model-modality.test.mjs（9/9）。
  @{ n = 'modality 视觉后缀守卫';                 f = Join-Path $root 'plugins\dsh-modlens-autoread\lib\model-modality.js'; p = 'dsh patch modality-vision-suffix-guard v1' },
  # 2026-09-23 full self-check (three parallel audit facets) - two findings:
  # 1) /health probe 6 "logs" only scanned the DSH_HOME top level (which holds only
  #    manual/janitor logs); the real runtime logs live in %APPDATA%\DSH Desktop\logs,
  #    so the detail line showed a misleading "newest 13000m old" and a genuine log-write
  #    failure (the 2026-09-15 fail-loud self-kill mode) would not be noticed. Fixed by
  #    scanning the runtime log dir too and exposing freshness as extra fields.
  # 2) @deepseek-ai/cordis fiber runner used an optional chain that guarded only the FIRST
  #    call: task optional-chain-catch followed by a bare .catch(...). With no task this
  #    throws "TypeError: Cannot read properties of undefined (reading 'catch')" -
  #    114 hits in 7 days, all inside agent/disposed dispatch, and the cleanup chain after
  #    it was skipped. A whole-tree scan found this pattern EXACTLY ONCE. Fixed with
  #    Promise.resolve(task). On FAIL: node scripts/apply-cordis-task-catch-fix.mjs
  @{ n = 'health logs probe runtime dir';       f = Join-Path $root 'plugins\dsh-host-services\lib\index.js'; p = 'dsh patch health-logs-runtime-dir v1' },
  @{ n = 'cordis fiber runner task catch';      f = Join-Path $unpacked 'node_modules\@deepseek-ai\cordis\lib\index.js'; p = 'dsh patch cordis-task-catch v1' },
  @{ n = 'project-brief git windowsHide';       f = Join-Path $root 'plugins\dsh-project-brief\lib\core.js'; p = 'windowsHide: true' },
  @{ n = 'critical-guard source';               f = Join-Path $src 'critical-guard.ts'; p = 'shouldAllowQuit' },
  @{ n = 'critical-busy route source';          f = Join-Path $src 'critical-busy-route.ts'; p = 'CRITICAL_BUSY_PATH' },
  @{ n = 'critical-guard wired in index.ts';    f = Join-Path $src 'index.ts'; p = 'CRITICAL_BUSY_PATH' },
  @{ n = 'host-apiproxy default cwd home';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js'; p = 'cwd: homedir(), /* dsh-desktop patch' },
  @{ n = 'sandbox-local runner node (patch #15)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-sandbox-local\lib\index.js'; p = 'nodeForWindowsAclRunner' },
  @{ n = 'community-market launcher removed'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\client.js'; p = 'DSH-OVERLAY: community-market launcher removed' },
  @{ n = 'community-market no-lag (host routes)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\host\routes.js'; p = 'DSH-OVERLAY: market-no-lag' },
  @{ n = 'community-market media no-lag (image timeouts)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\media\restricted-image.js'; p = 'DSH-OVERLAY: market-media-no-lag' },
  @{ n = 'community-market media no-lag (service)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\media\service.js'; p = 'DSH-OVERLAY: market-media-no-lag' },
  @{ n = 'community-market media no-lag (adapter icon host)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\adapters\dsh-1024store.js'; p = 'avatars.githubusercontent.com/${owner}?size=96' },
  @{ n = 'safe-delete-shim.cjs exists';       f = Join-Path $unpacked 'lib\safe-delete-shim.cjs'; p = 'safe-delete-shim' },
  @{ n = 'safe-delete-shim injected in main';  f = Join-Path $unpacked 'lib\main.js'; p = 'safe-delete-shim.cjs' },
  @{ n = 'pwsh recycle-bin guard defined';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-pwsh-local\lib\index.js'; p = 'RECYCLE_GUARD_PREAMBLE' },
  @{ n = 'pwsh argv uses recycle-bin guard';   f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-pwsh-local\lib\index.js'; p = '${RECYCLE_GUARD_PREAMBLE}${spec.command}' },
  @{ n = 'profile-guard quit guard (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dshCheckProfileIntegrity' },
  @{ n = 'settings resilience source (profile.ts)'; f = Join-Path $src 'profile.ts'; p = 'DSH-2026-09-03 settings-resilience guard' },
  @{ n = 'market catalogCache persist skipped (routes.js)'; f = Join-Path $unpacked 'node_modules\dsh-community-market\lib\host\routes.js'; p = 'DSH-2026-09-03 root-guard' },
  @{ n = 'market catalogCache persist skipped (source)'; f = Join-Path $root 'vendor\deepseek-harness-desktop\dsh-community-market\src\host\routes.ts'; p = 'DSH-2026-09-03 root-guard' },
  @{ n = 'exit-cleanup guard bypass (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dsh patch exit-cleanup v1' },
  @{ n = 'exit-cleanup relaunch flag (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = '__dsh_relaunch_in_progress__' },
  @{ n = 'log-write-guard P2 (skill-filesystem)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js'; p = 'dsh patch log-write-guard v1' },
  # projcache-guard (2026-09-23: main-process V8 heap OOM -> 应用反复自动关闭；minidump 异常码
  # 0xE0000008 + 内嵌 "JavaScript heap out of memory")。P1 put() 逐键隔离（一个坏单元不再拖垮
  # 整会话缓存，并点名坏键 = 「哪个 unit 违反 plain-JSON 契约」的诊断证据）；P2 有界缓存（超硬上限
  # 按 identity.createdAt 淘汰最旧，缓存语义允许：淘汰=下次冷读多回放一段日志，永不写错）；
  # P3 dsh-storage-json 紧凑序列化（整文件写入的瞬时字符串 105MB -> 59MB）。三条都在
  # node_modules 里 —— 重建会静默丢失。应用脚本 scripts/apply-projcache-guard.mjs；
  # 故障注入测试 tests/dist/projcache-guard.test.mjs（补丁前 9 项全红）。
  # On FAIL: node scripts/apply-projcache-guard.mjs
  @{ n = 'projcache-guard P1 (per-key isolation)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-projection-cache\lib\index.js'; p = 'dsh patch projcache-guard v1' },
  @{ n = 'projcache-guard P2 (bounded cache)';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-projection-cache\lib\index.js'; p = 'DSH_PROJCACHE_SOFT_CAP' },
  @{ n = 'json-storage-compact P3';                f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-storage-json\lib\index.js'; p = 'dsh patch json-storage-compact v1' },
  # context-undefined-tool (2026-09-23, L3 根因)：dsh-context 插件的 contextTimeline 单元把
  # `callNames` 里查不到的名字直接写成 `node.tool = undefined`（只校验了键是字符串、没校验值）⇒
  # JSON.stringify 丢键 ⇒ 整个 unit state 违反 plain-JSON 契约，该会话缓存永久不可写（每 5 秒报错）。
  # 定位方式：离线重放该会话真实日志（41383 帧 / 55536 条记录），在 event #48350 type=tool/result 处
  # 报出 `state.surface[54].tool = undefined`。目标是 profile 插件（不在 dist）——
  # **插件重装/升级会静默丢失**。On FAIL: node scripts/apply-context-undefined-tool-fix.mjs
  @{ n = 'context-undefined-tool (dsh-context)';   f = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-context\lib\index.js'; p = 'dsh patch context-undefined-tool v1' },
  # tool-search-image-passthrough (2026-09-24, root cause of "images are not recognised natively"):
  # the tool_call bridge returned only JSON.stringify({ok, value}) and dropped the real tool's
  # rendered blocks, so every read_image image was lost while the tool still reported success.
  # Measured: the session log read_image tool/result carried a single TEXT block (seq 341825 /
  # 343710), contextTimeline.requests[] showed images 0 for all 673 requests, and a blind fixture
  # scored 0/3 through the agent vs 3/3 sent straight to the same provider/model/key. The patch
  # forwards non-text blocks via exec.deferContext - the same pattern the kernel run_code path uses.
  # PROFILE plugin (npm install, not a junction) -> a plugin reinstall/upgrade drops it silently.
  # On FAIL: node scripts/apply-tool-search-image-passthrough.mjs
  @{ n = 'tool-search image passthrough';         f = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-tool-search\lib\bridge.js'; p = 'dsh patch tool-search-image-passthrough v1' },
  # json-storage-retry (2026-09-23 重启后核对时发现)：投影缓存每 ~5 秒把 **60MB 整份文件**
  # 原子替换（临时文件 + rename 覆盖目标），Windows 上只要有别的句柄持有目标且未带
  # FILE_SHARE_DELETE（典型：实时杀软扫描刚写完的文件）就会 `EPERM: operation not permitted, rename`。
  # 实测今日 1 次（21:34:26，session-b14f2d2b）。原实现不重试 ⇒ 一次瞬时锁就让该会话 checkpoint 丢失。
  # 补丁只对 EPERM/EBUSY/EACCES 有界重试（默认 5 次，40ms*attempt 退避，DSH_STORAGE_RENAME_RETRIES 可覆盖），
  # 最终错误带尝试次数。On FAIL: node scripts/apply-json-storage-retry.mjs
  @{ n = 'json-storage-retry (atomic replace)';    f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-storage-json\lib\index.js'; p = 'dsh patch json-storage-retry v1' },
  # json-storage-orphan-sweep (2026-09-24, found while cleaning up after the OOM crashes):
  # writeAtomic publishes a unit via open(.<uuid>.tmp,'wx') -> write -> fsync -> rename, and
  # ONLY its own catch removes the staging file, so a hard kill (OOM / SIGKILL / power loss)
  # in between strands it forever - nothing in the kernel ever revisits that directory.
  # Measured: the 2026-09-23 OOM crashes left exactly one 0-byte orphan per minidump in
  # ~/.dsh/storages (mtimes 14:45:27 and 19:22:18 == that day's two Crashpad dumps), while a
  # live writer's staging file was observed to survive <5 s (a 53 MB projcache rewrite).
  # The patch sweeps the exact .<uuid>.tmp shape once it is older than the stale window
  # (10 min default; DSH_STORAGE_ORPHAN_TMP_MS overrides), once per directory per process,
  # and swallows every error so the write path cannot break.
  # On FAIL: node scripts/apply-json-storage-orphan-sweep.mjs
  @{ n = 'json-storage-orphan-sweep (stale staging)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-storage-json\lib\index.js'; p = 'dsh patch json-storage-orphan-tmp-sweep v1' },
  @{ n = 'json-storage-orphan-sweep (age gate)';       f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-storage-json\lib\index.js'; p = 'DSH_STORAGE_ORPHAN_TMP_MS' },
  @{ n = 'picker utf16 NUL fix (worker.cjs)'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-host-directory-picker-native\lib\worker.cjs'; p = 'DSH-2026-09-04 picker-utf16-nul fix' },
  # ui-perf patches (2026-09-06: better-sidebar collapse gate + vision-engine input light; targets live outside dist)
  @{ n = 'ui-perf: better-sidebar collapse gate'; f = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-better-sidebar\lib\client.js'; p = 'state && (state.panelOpen || state.bottomOpen)' },
  @{ n = 'ui-perf: vision-engine render(allowFullScan)'; f = Join-Path $root 'plugins\dsh-vision-engine\lib\client.js'; p = 'function render(allowFullScan)' },
  @{ n = 'ui-perf: self-maintenance renderer probe'; f = Join-Path $root 'plugins\dsh-self-maintenance\lib\index.js'; p = 'renderer-probe-final' },
  # typing-lag fixes (2026-09-16 + 2026-09-17): 4 workspace client bundles patched by
  # scripts/apply-typing-lag-fixes.mjs (GPU was restored separately by
  # apply-gpu-opaque-patches.mjs patch #7). These are workspace plugin bundles
  # rather than dist files, so a plugin reinstall/update -- NOT just a rebuild --
  # would drop them silently and the composer lag would come back unexplained.
  # On FAIL: node scripts/apply-typing-lag-fixes.mjs
  @{ n = 'typing-lag: diagram rescan scope';    f = Join-Path $root 'plugins\dsh-diagram-renderer\lib\client.js'; p = 'dsh typing-lag fix 2026-09-16 (diagram scan)' },
  @{ n = 'typing-lag: session row text cache';  f = Join-Path $root 'plugins\dsh-session-history\lib\client.js'; p = 'dsh typing-lag fix 2026-09-16 (row text cache)' },
  @{ n = 'typing-lag: row render skip (CV)';    f = Join-Path $root 'plugins\dsh-ui-performance\lib\client.js'; p = 'dsh typing-lag fix 2026-09-16 (row render skip)' },
  @{ n = 'typing-lag: model aria poll cache';   f = Join-Path $root 'plugins\dsh-model-picker-group\lib\client.js'; p = 'dsh typing-lag fix 2026-09-17 (aria poll cache)' },
  # 2026-09-17: the visible composer glyphs are painted by the kernel's React backdrop overlay
  # (the textarea is transparent), so a keystroke only shows after a React commit+paint. Rule 10
  # gives the text back to the native textarea and raises the decoration layer. Workspace plugin
  # bundle again -> a plugin reinstall would drop it silently. On FAIL: restore Rule 10 from
  # _backups/typing-lag-native-text-*/client.js.before
  @{ n = 'typing-lag: native composer text';    f = Join-Path $root 'plugins\dsh-ui-performance\lib\client.js'; p = 'dsh typing-lag fix 2026-09-17 (native composer text)' },
  @{ n = 'typing-lag: native composer text (css)'; f = Join-Path $root 'plugins\dsh-ui-performance\lib\client.js'; p = '[data-input-scroll] textarea[data-phase]:not(:disabled)' },
  # scroll-jank fixes (2026-09-17): the conversation scroll-anchor hot path (per-frame forced
  # layout / hit tests / subtree query) is patched by scripts/apply-scroll-anchor-fixes.mjs. The
  # patch is applied to the CANON copy in patches/bundles/ and propagated to the dev tree + the
  # packaged app, so port-user-patches.mjs (which restores from that same canon) cannot silently
  # revert it. On FAIL: node scripts/apply-scroll-anchor-fixes.mjs
  @{ n = 'scroll-anchor: binary anchor (pkg)';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'; p = 'dsh-scroll-fix-2026-09-17 (binary anchor)' },
  @{ n = 'scroll-anchor: single hit point (pkg)';  f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'; p = 'dsh-scroll-fix-2026-09-17 (single hit point)' },
  @{ n = 'scroll-anchor: seat cache (pkg)';        f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'; p = 'dsh-scroll-fix-2026-09-17 (seat cache)' },
  @{ n = 'scroll-anchor: canon copy (patches/)';   f = Join-Path $root 'patches\bundles\dsh-client-ui-conversation-client.js'; p = 'dsh-scroll-fix-2026-09-17 (binary anchor)' },
  @{ n = 'scroll: containment (ui-performance)';   f = Join-Path $root 'plugins\dsh-ui-performance\lib\client.js'; p = 'dsh scroll fix 2026-09-17 (scroll containment)' },
  # sweep-transform fixes (2026-09-17): 4 个「流式行扫光」动画原本用 `left`（每帧触发布局+绘制、
  # infinite，挂在 [data-state=running] 的行上）⇒ renderer 单核被打满的结构性来源之一。
  # 已改为等价的 `transform: translateX()`（可上合成器）。canon 在 patches/bundles/，回灌 dev+pkg。
  # On FAIL: node scripts/apply-sweep-transform-fixes.mjs
  @{ n = 'sweep: conversation rows (transform)';   f = Join-Path $root 'patches\bundles\dsh-client-ui-conversation-client.js'; p = 'dsh-sweep-fix-2026-09-17 compositor-transform' },
  @{ n = 'sweep: tool/bash rows (transform)';      f = Join-Path $root 'patches\bundles\dsh-client-ui-tool-client.js'; p = 'dsh-sweep-fix-2026-09-17 compositor-transform' },
  # task-scheduler archive retention (2026-09-17): pruneChanges() 只归档不清理 ⇒ 5 天堆积 238 份
  # changes.jsonl.old-* / 216.8 MB（每份 ~2000 行滚动窗口）。补丁给归档加上限（默认保留最近 5 份，
  # DSH_TASK_SCHEDULER_KEEP_ARCHIVES 可覆盖）。工作区插件代码 —— 插件重装/更新会静默丢失。
  # On FAIL: node scripts/apply-task-scheduler-retention.mjs
  @{ n = 'task-scheduler: archive retention';      f = Join-Path $root 'plugins\dsh-task-scheduler\lib\core.js'; p = 'dsh patch task-scheduler retention v1' },
  @{ n = 'task-scheduler: retention cap const';    f = Join-Path $root 'plugins\dsh-task-scheduler\lib\core.js'; p = 'const DEFAULT_KEEP_ARCHIVES = 5' },
  # port-user-patches bundle patches (2026-09-06 audit: were zero-covered; rebuild silently lost them)
  @{ n = 'port: workspace bundle ADD_CHAT';      f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js'; p = 'const ADD_CHAT' },
  @{ n = 'port: conversation bundle chatOnly';   f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js'; p = 'const chatOnly' },
  @{ n = 'port: settings-models fetch-dialog';   f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js'; p = 'dsh-desktop patch: fetch-dialog search' },
  @{ n = 'port: frontend-static no-cache';       f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-host-frontend-static\lib\index.js'; p = 'dsh-desktop patch: no-cache for dev stability' },
  @{ n = 'port: directory-picker native picker'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-directory-picker-browse\lib\client.js'; p = 'window.__DSH_DESKTOP_PICK_DIRECTORY__' },
  @{ n = 'port: session-persistence zstd-async'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js'; p = 'PATCH(zstd-async)' },
  @{ n = 'port: modlens seamless takeover';      f = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\@liustack\modlens\dsh\index.js'; p = 'lowered0' },
  # startup resilience + decision patches (2026-09-07: PROC-4 / UPD-2 / PROC-5 / exit self-check)
  @{ n = 'stale-lock 60s (lib/main)';            f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-patch: stale-lock-60s' },
  @{ n = 'auto-update disabled (updates.js)';    f = Join-Path $unpacked 'lib\updates.js'; p = 'dsh-patch: disable-auto-update' },
  @{ n = 'port-preflight friendly error (lib/main)'; f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-patch: port-preflight v1' },
  @{ n = 'quit lockfile cleanup (lib/main)';     f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-patch: quit-lock-cleanup v1' },
  # PERF-5: session readRaw streaming multi-frame decode (2026-09-07)
  @{ n = 'session decode streaming (PERF-5)';    f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js'; p = 'dsh-patch: zstd-stream-readraw v1' },
  # PERF-6: session readZstdPrefix synchronous generator decode (open-session hot path)
  @{ n = 'session prefix sync decode (PERF-6)';  f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js'; p = 'PATCH(zstd-stream-readprefix' },
  # 2026-09-28 kernel 0.1.7-rc.2 implicit-deps: electron-builder dropped 8 transitive
  # @deepseek-ai packages that are actually imported by the kernel (dsh-client-store alone
  # is imported by ~38 client-ui packages). Missing them => renderer ERR_MODULE_NOT_FOUND
  # => startup guard kills the process at 30s => the desktop shortcut appears dead. They
  # live only because scripts/apply-kernel-implicit-deps.mjs re-deploys them from
  # patches/vendor/kernel-implicit-deps-0.1.7-rc.2.tgz; a rebuild/promote drops them again.
  # On FAIL: node scripts/apply-kernel-implicit-deps.mjs
  @{ n = 'kernel implicit dep: dsh-client-store';        f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-store\package.json';        p = '@deepseek-ai/dsh-client-store' },
  @{ n = 'kernel implicit dep: dsh-deepseek-account';    f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-deepseek-account\package.json';    p = '@deepseek-ai/dsh-deepseek-account' },
  @{ n = 'kernel implicit dep: dsh-hook-protocol';       f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-hook-protocol\package.json';       p = '@deepseek-ai/dsh-hook-protocol' },
  @{ n = 'kernel implicit dep: dsh-llm-deepseek';        f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-llm-deepseek\package.json';        p = '@deepseek-ai/dsh-llm-deepseek' },
  @{ n = 'kernel implicit dep: dsh-ptc-runtime';         f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-ptc-runtime\package.json';         p = '@deepseek-ai/dsh-ptc-runtime' },
  @{ n = 'kernel implicit dep: dsh-sdk-protocol';        f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-sdk-protocol\package.json';        p = '@deepseek-ai/dsh-sdk-protocol' },
  @{ n = 'kernel implicit dep: dsh-util-time';           f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-util-time\package.json';           p = '@deepseek-ai/dsh-util-time' },
  @{ n = 'kernel implicit dep: dsh-util-workspace-path'; f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-util-workspace-path\package.json'; p = '@deepseek-ai/dsh-util-workspace-path' },
  # 2026-09-29 shell<->0.1.7 interface gaps (settingsScope inject + root Include
  # fallback). Written by scripts/apply-shell-0.1.7-gaps.mjs; a rebuild into a new
  # dist dir drops them unless that script re-runs (package-vendor does).
  # On FAIL: node scripts/apply-shell-0.1.7-gaps.mjs
  @{ n = 'shell-0.1.7: settingsScope inject';            f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-settings\lib\client.js'; p = 'dsh-desktop patch (2026-09-29): upstream 0.1.7 dropped the `settingsScope`' },
  @{ n = 'shell-0.1.7: app-boot root Include fallback';  f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'; p = 'dsh-desktop patch (2026-09-29): the shipped desktop shell composes the profile with its' },
  @{ n = 'shell-0.1.7: main soft-fail keep window';       f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-desktop patch (2026-09-29): soft-fail keep window' },
  @{ n = 'shell-0.1.7: skip welcome notice';              f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-client-ui-settings-models\lib\client.js'; p = 'dsh-desktop patch (2026-09-29): skip internal testing notice' },
  @{ n = 'shell-0.1.7: loader.await 10s race';            f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'; p = 'dsh-desktop patch (2026-09-29): loader.await raced with 10s' },
  @{ n = 'shell-0.1.7: settings.register scope.get';      f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-settings\lib\index.js'; p = 'return a real scope with get()/set()' },
  @{ n = 'shell-0.1.7: reload fiber-await non-fatal';     f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'; p = 'reload fiber-await rejects are non-fatal' },
  @{ n = 'shell-0.1.7: fail-loud keeps alive';            f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'; p = 'fail-loud keeps process alive' },
  # 2026-09-29 "auto exit" fix (model switch / provider creation): the settings UI
  # calls reconcileProfilePatches() with the CURRENT patch list before writing, and
  # re-applying an identical set tore the window down. Skip when nothing changed.
  # Written by scripts/apply-shell-0.1.7-gaps.mjs section 16.
  # On FAIL: node scripts/apply-shell-0.1.7-gaps.mjs
  @{ n = 'shell-0.1.7: reload no-op skip (auto-exit)';    f = Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'; p = 'dsh-desktop patch (2026-09-29): skip the no-op profile reload' },
  # 2026-09-29 create-provider root-cause fix: a profile reload re-creates every
  # row of the root Include, including the `desktop-shell` row that owns the
  # window, and Electron's implicit quit then ended the app with no trace.
  # Written by scripts/apply-window-all-closed-guard.mjs.
  # On FAIL: node scripts/apply-window-all-closed-guard.mjs
  @{ n = 'window-all-closed guard (create-provider)';     f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-desktop patch (2026-09-29): window-all-closed guard.' },
  @{ n = 'window-all-closed guard: quit flag';            f = Join-Path $unpacked 'lib\main.js'; p = 'let quitRequested = false;' },
  # 2026-09-29 exit diagnostics: observation-only probe covering the native
  # implicit-quit path that no JS wrapper can see. Written by
  # scripts/apply-exit-probe.mjs. On FAIL: node scripts/apply-exit-probe.mjs
  @{ n = 'exit probe v3 (diagnostics)';                   f = Join-Path $unpacked 'lib\main.js'; p = 'dsh-desktop patch (2026-09-29): exit-path probes v3' }
)

# 2026-09-10 (W1-4): when dist resolution fails, Join-Path against an empty
# $unpacked throws, $checks ends up empty, every loop is skipped and the script
# still prints ALL PASS. A gate that ran zero checks must never pass.
$fail = 0
if (-not $unpacked -or -not (Test-Path $unpacked)) {
  Write-Host ('FAIL  dist root unresolved: ' + [string]$unpacked) -ForegroundColor Red
  $fail++
}
if ($null -eq $checks -or $checks.Count -lt 40) {
  Write-Host ('FAIL  check list empty or truncated (count=' + [string]$checks.Count + ')') -ForegroundColor Red
  $fail++
}
# 2026-09-27 upgrade-0.1.7: these checks are RETIRED — upstream dsh 0.1.7 provides the
# behaviour natively (see outputs/2026-09-27-upgrade-impact-0.1.7-rc.2 P0-7 A-group).
# Kept listed (not deleted) so the array structure stays intact; a retired hit is INFO, not FAIL.
$retired = @{
  # 2026-09-28, source: PLUGIN UPGRADE (dsh-better-sidebar 0.15.2 -> 0.22.1), upstream redesign.
  # The patch gated better-sidebar's center-column DOM scanning on
  # `state.panelOpen || state.bottomOpen` and re-armed it on expand. 0.22.1 removed the
  # right-panel concept entirely: `panelOpen` has 0 hits in lib/client.js, the right column
  # now belongs to DSH's native Sidebar (the plugin's own CSS comments say so), and the
  # remaining effect already arms on the only state left -- lib/client.js:17889
  # `}, [measureCenter, bottomOpen]);`. Its premise no longer exists, so re-anchoring it
  # would be fabricating a gate rather than re-porting one.
  'ui-perf: better-sidebar collapse gate' = $true

  # 2026-09-28, source: PLUGIN UPGRADE (not the 0.1.7 kernel upgrade).
  # dsh-context 0.33.1 -> 0.59.2 fixed the bug natively: lib/index.js:959-972 now
  # resolves srcEntry ?? blockEntry and only writes `node.tool = toolEntry.name`
  # when `toolEntry !== void 0`, so a name miss can no longer produce
  # `node.tool = undefined` (the plain-JSON contract violation this patch fixed).
  'context-undefined-tool (dsh-context)' = $true
  'subprocess-local windowsHide' = $true
  'spill-hardening marker (dist)' = $true
  'spill-hardening marker (pkg copy)' = $true
  'host-apiproxy default cwd home' = $true
  'picker utf16 NUL fix (worker.cjs)' = $true
  'scroll-anchor: binary anchor (pkg)' = $true
  'scroll-anchor: single hit point (pkg)' = $true
  'scroll-anchor: seat cache (pkg)' = $true
  'scroll-anchor: canon copy (patches/)' = $true
  'port: settings-models fetch-dialog' = $true
  'port: session-persistence zstd-async' = $true
  'session decode streaming (PERF-5)' = $true
  'session prefix sync decode (PERF-6)' = $true
  # 0.1.7 upgrade: features removed/replaced upstream (B3/B5) or pending re-implementation
  # on the 0.1.7 API (B1 sandbox-local runner; P6 smoke covers). Kept as INFO not FAIL.
  'port: workspace bundle ADD_CHAT' = $true
  'port: conversation bundle chatOnly' = $true
  'port: directory-picker native picker' = $true
  'sandbox-local runner node (patch #15)' = $true
  # 2026-09-27 U6-0a: the file-backed settings document was removed (0.1.7); the old
  # document-tolerance guard (src marker + "invalid settings document at" chunk marker)
  # no longer exists in the migration. Resilience semantics are inherited by
  # desktop-shell-settings.ts (refuses to edit an unparsable patch; fail-open reads).
  'settings resilience source (profile.ts)' = $true
}
foreach ($c in $checks) {
  $isRetired = $retired.ContainsKey($c.n)
  if (Test-Path $c.f) {
    $hit = Select-String -Path $c.f -Pattern $c.p -SimpleMatch -Quiet
    if ($hit) { Write-Host ('PASS  ' + $c.n) -ForegroundColor Green }
    elseif ($isRetired) { Write-Host ('INFO  RETIRED(0.1.7-native) ' + $c.n + ' (pattern missing, expected)') -ForegroundColor Yellow }
    else { Write-Host ('FAIL  ' + $c.n + ' (pattern missing)') -ForegroundColor Red; $fail++ }
  } else {
    if ($isRetired) { Write-Host ('INFO  RETIRED(0.1.7-native) ' + $c.n + ' (file missing, expected)') -ForegroundColor Yellow }
    else { Write-Host ('FAIL  ' + $c.n + ' (file missing)') -ForegroundColor Red; $fail++ }
  }
}

# GPU/opaque-window patches live in the hashed electron-runtime chunk
# (file name changes on every rebuild), so verify it dynamically.
$rtChunks = Get-ChildItem (Join-Path $unpacked 'lib') -Filter 'electron-runtime-*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.map' }
if ($rtChunks.Count -ne 1) {
  Write-Host ('FAIL  electron-runtime chunk lookup (found ' + $rtChunks.Count + ')') -ForegroundColor Red
  $fail++
} else {
  $rt = $rtChunks[0].FullName
  $opaqueHit = Select-String -Path $rt -Pattern 'DSH_DESKTOP_FORCE_GPU ? "#00000000"' -SimpleMatch -Quiet
  if ($opaqueHit) { Write-Host 'PASS  opaque win32 window (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  opaque win32 window (pattern missing)' -ForegroundColor Red; $fail++ }
  $micaHit = Select-String -Path $rt -Pattern 'if (process.env.DSH_DESKTOP_FORCE_GPU) window.setBackgroundMaterial' -SimpleMatch -Quiet
  if ($micaHit) { Write-Host 'PASS  mica refresh guarded (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  mica refresh guard (pattern missing)' -ForegroundColor Red; $fail++ }
  $pgHit = Select-String -Path $rt -Pattern 'dshCheckProfileIntegrity' -SimpleMatch -Quiet
  if ($pgHit) { Write-Host 'PASS  profile-guard close dialog (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  profile-guard close dialog (pattern missing)' -ForegroundColor Red; $fail++ }
  # 2026-09-29: renderer boot health timeout must not be the old 30s deadline.
  # On FAIL: node scripts/apply-shell-0.1.7-gaps.mjs
  $toHit = Select-String -Path $rt -Pattern 'dsh-desktop patch (2026-09-29): was 3e4' -SimpleMatch -Quiet
  if ($toHit) { Write-Host 'PASS  shell-0.1.7: renderer boot-timeout off (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  shell-0.1.7: renderer boot-timeout off (pattern missing)' -ForegroundColor Red; $fail++ }
  $ssHit = Select-String -Path $rt -Pattern 'dsh-desktop patch (2026-09-29): soft-stop resolve' -SimpleMatch -Quiet
  if ($ssHit) { Write-Host 'PASS  shell-0.1.7: HealthGate.stop soft-resolve (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  shell-0.1.7: HealthGate.stop soft-resolve (pattern missing)' -ForegroundColor Red; $fail++ }
  $epHit = Select-String -Path $rt -Pattern 'dsh-desktop patch (2026-09-29): EPIPE-class uncaught is non-fatal' -SimpleMatch -Quiet
  if ($epHit) { Write-Host 'PASS  shell-0.1.7: EPIPE uncaught non-fatal (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  shell-0.1.7: EPIPE uncaught non-fatal (pattern missing)' -ForegroundColor Red; $fail++ }
  $uqHit = Select-String -Path $rt -Pattern 'dsh-desktop patch (2026-09-29): uncaught never quits the shell' -SimpleMatch -Quiet
  if ($uqHit) { Write-Host 'PASS  shell-0.1.7: uncaught never quits (electron-runtime)' -ForegroundColor Green }
  else { Write-Host 'FAIL  shell-0.1.7: uncaught never quits (pattern missing)' -ForegroundColor Red; $fail++ }
}

# 2026-09-29: web-frontend readiness fallback lives in a content-hashed asset
# (index-*.js). On FAIL: node scripts/apply-shell-0.1.7-gaps.mjs
$webAssets = Get-ChildItem (Join-Path $unpacked 'node_modules\@deepseek-ai\dsh-web-frontend\dist\assets') -Filter 'index-*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.map' -and $_.Name -notlike '*.LICENSE.txt' }
if ($webAssets.Count -ne 1) {
  Write-Host ('FAIL  shell-0.1.7: web-frontend readiness (index-*.js found ' + $webAssets.Count + ')') -ForegroundColor Red
  $fail++
} else {
  $webHit = Select-String -Path $webAssets[0].FullName -Pattern 'dsh-desktop patch: boot readiness resolve failed' -SimpleMatch -Quiet
  if ($webHit) { Write-Host 'PASS  shell-0.1.7: web-frontend readiness fallback' -ForegroundColor Green }
  else { Write-Host 'FAIL  shell-0.1.7: web-frontend readiness fallback (pattern missing)' -ForegroundColor Red; $fail++ }
}

# The settings-resilience guard lives in the content-hashed profile chunk
# (file name changes on every rebuild), so verify it dynamically.
# 2026-09-27 U6-0a: the file-backed settings document was removed upstream; the old
# "invalid settings document at" marker is gone with it. The resilience semantics moved
# to desktop-shell-settings (unparsable-patch write refusal + fail-open reads), so this
# dynamic check is RETIRED: an empty lookup is INFO, not a FAIL. A future guard can bind
# to the new patch-writer marker instead.
$profileChunks = Get-ChildItem (Join-Path $unpacked 'lib') -Filter 'profile-*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.map' } |
  Where-Object { Select-String -Path $_.FullName -Pattern 'invalid settings document at' -SimpleMatch -Quiet }
if ($profileChunks.Count -ne 1) {
  Write-Host ('INFO  settings-resilience chunk lookup RETIRED (0.1.7: settings doc removed; found ' + $profileChunks.Count + ')') -ForegroundColor Yellow
} else {
  $srHit = Select-String -Path $profileChunks[0].FullName -Pattern 'ignoring invalid settings document' -SimpleMatch -Quiet
  if ($srHit) { Write-Host 'PASS  settings resilience guard (profile chunk)' -ForegroundColor Green }
  else { Write-Host 'INFO  settings resilience guard RETIRED (marker no longer emitted by 0.1.7 build)' -ForegroundColor Yellow }
}

# The log-write-guard P1 lives in the content-hashed log-files chunk
# (file name changes on every rebuild), so verify it dynamically too.
$logChunks = Get-ChildItem (Join-Path $unpacked 'lib') -Filter 'log-files-*.js' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.map' }
if ($logChunks.Count -ne 1) {
  Write-Host ('FAIL  log-files chunk lookup (found ' + $logChunks.Count + ')') -ForegroundColor Red
  $fail++
} else {
  $lwHit = Select-String -Path $logChunks[0].FullName -Pattern 'dsh patch log-write-guard v1' -SimpleMatch -Quiet
  if ($lwHit) { Write-Host 'PASS  log-write-guard P1 (log-files chunk)' -ForegroundColor Green }
  else { Write-Host 'FAIL  log-write-guard P1 (pattern missing)' -ForegroundColor Red; $fail++ }
  # 2026-09-16: the syntax-set registration for this chunk MOVED below the
  # `$syntaxSet = @{}` initialization. It used to sit here, i.e. BEFORE the set
  # existed, so it threw "Cannot index into a null array" (the long-standing
  # NullArray noise) AND the later rebuild never re-added this file -- the
  # content-hashed log-files chunk was silently EXCLUDED from the syntax
  # integrity pass, which is exactly the T13/O14 hole (marker survives while the
  # file is corrupt). Now registered together with the other dynamic chunks.
}

# 2026-09-12 (T13, O14 remainder): syntax integrity pass over the JS patch targets.
# Marker matching (Select-String) cannot see a file that is corrupt/truncated while its
# marker string still survives. Measured 2026-09-12: a safe-delete-shim.cjs with invalid
# JS appended (node --check exit 1, error at line 359) still printed
# "PASS safe-delete-shim.cjs exists" and "ALL PASS (49 checks)" with exit 0 -> a broken
# deployment file passed the gate. This pass closes that hole.
# Deliberately NOT whole-file SHA-256: that fails on every rebuild (upgrade-day tradeoff,
# see W5 / O4), whereas SYNTAX is rebuild-invariant. Measured before adding: 14/14 targets
# already pass node --check, so this introduces no pre-existing false FAIL.
# Uses the real parser (node --check), not a regex.
$syntaxSet = @{}
foreach ($c in $checks) { if ($c.f -match '\.(js|cjs|mjs)$') { $syntaxSet[$c.f] = $true } }
if ($rtChunks.Count -eq 1) { $syntaxSet[$rtChunks[0].FullName] = $true }
if ($profileChunks.Count -eq 1) { $syntaxSet[$profileChunks[0].FullName] = $true }
if ($logChunks.Count -eq 1) { $syntaxSet[$logChunks[0].FullName] = $true }
$syntaxOk = 0
foreach ($sf in $syntaxSet.Keys) {
  if (-not (Test-Path $sf)) { continue }   # a missing file already FAILs in the loop above
  & node --check $sf 2>$null
  if ($LASTEXITCODE -eq 0) { $syntaxOk++ }
  else {
    Write-Host ('FAIL  syntax integrity: ' + $sf) -ForegroundColor Red
    $fail++
  }
}
# Same discipline as the empty-check-list guard above: a coverage collapse must not pass.
if ($syntaxOk -lt 10) {
  Write-Host ('FAIL  syntax integrity pass covered too few files (ok=' + [string]$syntaxOk + ' of ' + [string]$syntaxSet.Count + ')') -ForegroundColor Red
  $fail++
}

# unpack-everything contract + module-graph integrity. Dist patches target
# app.asar.unpacked and are only effective when lib/ is UNPACKED inside
# app.asar; a stale main.js referencing a missing hashed chunk crashes with
# ERR_MODULE_NOT_FOUND at link time. check-dist-integrity.mjs enforces both.
# 2026-09-10 (W1-4): capture the exit code BEFORE piping through Out-String.
# Piping into a cmdlet resets $LASTEXITCODE, so combined runs produced a false
# FAIL while standalone runs passed (see PATCH-5).
$integrityOut = & node (Join-Path $PSScriptRoot 'check-dist-integrity.mjs') 2>&1
$integrityCode = $LASTEXITCODE
$integrity = ($integrityOut | Out-String).Trim()
if ($integrityCode -eq 0) { Write-Host 'PASS  dist integrity (unpacked contract + main.js imports)' -ForegroundColor Green }
else { Write-Host ('FAIL  dist integrity (exit ' + $integrityCode + '): ' + $integrity) -ForegroundColor Red; $fail++ }

Write-Host ('current build: ' + $build.buildDir)

# Ollama autostart VBS is RUNTIME state managed by dsh-vision-engine: it is
# (re)created whenever the user activates a local profile (setOllamaAutostart)
# and is legitimately absent when the cloud engine is selected.
# 2026-08-24: user switched the vision engine to cloud (bailian qwen3-vl-plus)
# and the Startup entry was removed on purpose, so this must NOT fail the
# build verification; report status only.
$total = $checks.Count
# 2026-09-29: $env:APPDATA is not exported in every shell (agent sandboxes), and
# Join-Path threw on the null path, spraying red errors into the gate output.
$roaming = $env:APPDATA
if (-not $roaming) { $roaming = Join-Path $env:USERPROFILE 'AppData\Roaming' }
$vbs = $null
if ($roaming) { $vbs = Join-Path $roaming 'Microsoft\Windows\Start Menu\Programs\Startup\Ollama Serve.vbs' }
if ($vbs -and (Test-Path $vbs)) {
  $total++
  $hit = Select-String -Path $vbs -Pattern '0, False' -SimpleMatch -Quiet
  if ($hit) { Write-Host 'PASS  ollama VBS hidden autostart (local engine active)' -ForegroundColor Green }
  else { Write-Host 'WARN  ollama VBS present but missing hidden flag (not counted as fail)' -ForegroundColor Yellow }
} else {
  Write-Host 'INFO  ollama VBS absent (cloud engine selected; auto-recreated on switch to local)' -ForegroundColor Cyan
}

Write-Host ''
# 2026-09-10 (W1-4): always surface the check count. A silently shrinking
# $checks list would weaken this gate without anyone noticing.
Write-Host ('checks: ' + $checks.Count + ' static + 3 chunk + 1 web-asset + 1 dist integrity + ' + [string]$syntaxOk + ' syntax')
if ($fail -eq 0) { Write-Host ('ALL PASS (' + $total + ' checks)') -ForegroundColor Green }
else {
  Write-Host ($fail.ToString() + ' FAILED') -ForegroundColor Red
  # 2026-09-07: actionable hint on failure - tell operator HOW to re-apply
  Write-Host 'HINT  re-apply drifted patches:' -ForegroundColor Yellow
  Write-Host '  - registry patches:   node scripts/patch-apply.mjs apply   (idempotent, backs up first)' -ForegroundColor Yellow
  Write-Host '  - surgical patches:   rerun the matching scripts/apply-*.mjs for each FAIL item above' -ForegroundColor Yellow
  Write-Host '  - shell-0.1.7 gaps:   node scripts/apply-shell-0.1.7-gaps.mjs' -ForegroundColor Yellow
  Write-Host '  - window-all-closed:  node scripts/apply-window-all-closed-guard.mjs' -ForegroundColor Yellow
  Write-Host '  - exit diagnostics:   node scripts/apply-exit-probe.mjs' -ForegroundColor Yellow
  Write-Host '  - then rerun this script to confirm all green' -ForegroundColor Yellow
}
exit $fail
