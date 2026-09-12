"use strict";
/**
 * safe-delete-shim.cjs
 *
 * Intercepts Node.js fs module deletion calls and redirects them to the
 * Windows Recycle Bin via PowerShell Microsoft.VisualBasic API.
 *
 * Protected paths (~/.dsh, node_modules junctions, system temp) are NOT
 * redirected — they use the original permanent-delete behavior to avoid
 * breaking DSH service startup (junction heal requires real unlink).
 *
 * SELF-2 (2026-09-07): recycle-bin FAILURE must NEVER fall back to the
 * original permanent delete for non-protected paths — that made the shim's
 * failure mode the very data loss it exists to prevent. On recycle failure we
 * now relocate the target to ~/.dsh/_quarantine/ (rename, reversible) with a
 * 30-day TTL cleanup. If quarantine also fails we THROW so the caller sees a
 * loud failure instead of a silent hard delete.
 *
 * SELF-2b (2026-09-07, startup regression fix): the interception above broke
 * DSH startup — the install-recovery stage rimrafs plugin-install-recovery/
 * including its own state.json.lock while the file handle is still in play.
 * Recycle-bin and quarantine both fail on such files → EQ_DELETE throw →
 * recovery window ERR_FAILED → startup.run.failed. Two fixes:
 *   1. TRANSIENT bypass: *.lock / *.tmp artifacts are routed straight to the
 *      original fs methods (stock semantics; they are not user data).
 *   2. RACED-AWAY delegation: when the recycle-bin attempt failed but the
 *      target no longer exists at quarantine time, delegate back to the
 *      original fs call instead of throwing — stock ENOENT semantics, and
 *      Node's rimraf treats ENOENT as success.
 *
 * SELF-2c (F13, 2026-09-10, empirically verified): the VB recycle API succeeds but
 * STILL throws FileNotFoundException afterwards, so powershell.exe always exits 1 —
 * and a caught error still leaves $? false, so `try{}catch{}` does not make it exit 0.
 * Because sendToRecycleBin() judged failure by that exit code, EVERY delete took the
 * quarantine branch (item already in the Recycle Bin) and callers saw a bogus ENOENT
 * from fs.unlinkSync/unlink. Fixed by switching to spawnSync and judging success by
 * filesystem fact (lstat) instead of exit status, while re-throwing ENOENT for paths
 * that were already absent. Genuine failures still throw, so the quarantine fallback
 * keeps working exactly as designed.
 *
 * Loaded via createRequire() at the top of main.js.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

// ── Protected-path detection ──────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, ".dsh");

const PROTECTED_PREFIXES = [
  DSH_HOME.toLowerCase(),
  path.join(os.tmpdir()).toLowerCase(),
];

// ── Quarantine fallback (SELF-2) ─────────────────────────────────────
// Lives inside ~/.dsh (protected => shim never redirects deletions there, and
// the quarantine prune below is NOT re-intercepted, avoiding recursion).
const QUARANTINE_ROOT = path.join(DSH_HOME, "_quarantine");
const QUARANTINE_TTL_MS = 30 * 24 * 3600_000;

// Test knob: make the recycle-bin path throw unconditionally so the
// quarantine fallback (and the no-silent-hard-delete guarantee) can be
// exercised deterministically in CI / manual e2e.
const FORCE_FAIL_RECYCLE = process.env.DSH_SAFE_DELETE_FAIL_RECYCLE === "1";

function isProtected(filePath) {
  if (!filePath) return false;
  try {
    const resolved = path.resolve(filePath).toLowerCase().replace(/\//g, "\\");
    if (resolved.startsWith(PROTECTED_PREFIXES[0])) return true;
    if (resolved.startsWith(PROTECTED_PREFIXES[1])) return true;
    if (resolved.includes("\\node_modules\\")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Opportunistic prune of quarantine entries older than TTL (bounded storage). */
function pruneQuarantine() {
  let entries;
  try {
    entries = fs.readdirSync(QUARANTINE_ROOT, { withFileTypes: true });
  } catch {
    return; // root not created yet / unreadable: nothing to prune
  }
  const cutoff = Date.now() - QUARANTINE_TTL_MS;
  for (const entry of entries) {
    try {
      const p = path.join(QUARANTINE_ROOT, entry.name);
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) {
        // fs.rmSync here is safe: the target lives under DSH_HOME so the
        // patched rmSync routes it straight to the original delete.
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {
      /* per-entry prune failure is best-effort */
    }
  }
}

/** SELF-2b: transient artifacts (locks / temp files) bypass the interception
 * entirely — they are not user data and stock semantics are required for
 * correct startup (install-recovery rimraf of its own lock files). */
const TRANSIENT_BASENAME_RE = /\.(?:lock|tmp)$/i;
const TRANSIENT_TMP_INFIX_RE = /\.tmp-\d/;

function isTransient(filePath) {
  if (!filePath) return false;
  try {
    const base = path.basename(String(filePath));
    return TRANSIENT_BASENAME_RE.test(base) || TRANSIENT_TMP_INFIX_RE.test(base);
  } catch {
    return false;
  }
}

/** SELF-2b: shared post-recycle-failure path. Throws EQ_QUARANTINE when
 * quarantine fails; returns "quarantined" | "missing". Callers delegate
 * "missing" back to the original fs call (stock ENOENT semantics). */
function quarantineOutcome(filePath) {
  return quarantinePath(filePath);
}

/**
 * Move a path into the quarantine dir (reversible, same-volume rename).
 * Returns "quarantined" | "missing". Throws if relocation fails.
 */
function quarantinePath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    const st = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!st) return "missing";
    fs.mkdirSync(QUARANTINE_ROOT, { recursive: true });
    pruneQuarantine();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(
      QUARANTINE_ROOT,
      `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 6)}-${path.basename(resolved)}`
    );
    fs.renameSync(resolved, dest);
    return "quarantined";
  } catch (e) {
    const err = new Error(
      `safe-delete: quarantine fallback failed for ${resolved}: ${e && e.message ? e.message : e}`
    );
    err.code = "EQ_QUARANTINE";
    err.cause = e;
    throw err;
  }
}

/** SELF-2: quarantine-or-throw used after a recycle-bin failure. */
function quarantineOrThrow(filePath, options) {
  const force = !!(options && options.force);
  let res;
  try {
    res = quarantinePath(filePath);
  } catch (e) {
    throw e; // quarantine failed -> loud failure, never a silent hard delete
  }
  if (res === "quarantined") return;
  if (res === "missing" && force) return; // rm force semantics: missing is OK
  const err = new Error(
    `safe-delete: recycle-bin and quarantine both failed for ${path.resolve(filePath)}`
  );
  err.code = "EQ_DELETE";
  throw err;
}

// ── Windows Recycle Bin via PowerShell ────────────────────────────────

let sendToRecycleBin = null;

if (process.platform === "win32") {
  sendToRecycleBin = function sendToRecycleBinPs(filePath) {
    if (FORCE_FAIL_RECYCLE) {
      throw new Error("recycle-bin disabled by DSH_SAFE_DELETE_FAIL_RECYCLE=1 (test knob)");
    }
    const resolved = path.resolve(filePath);
    // Escape single quotes for PowerShell
    const safe = resolved.replace(/'/g, "''");
    // Detect directory so we use the correct VB API (DeleteFile only works on
    // files; directories need DeleteDirectory, which is recursive). Existence is
    // judged with lstat, NOT stat: stat follows links, so a dangling junction
    // would look "absent" and we would wrongly re-throw ENOENT after removing it.
    let isDir = false;
    let existedBefore = false;
    try {
      fs.lstatSync(resolved);
      existedBefore = true;
    } catch {
      existedBefore = false;
    }
    try {
      const st = fs.statSync(resolved);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    const method = isDir ? "DeleteDirectory" : "DeleteFile";
    // SELF-2c (F13, 2026-09-10, empirically verified): the VB DeleteFile/DeleteDirectory
    // API performs the recycle-bin move SUCCESSFULLY but then still throws
    // FileNotFoundException (a post-operation re-check of the now-moved source path),
    // so powershell.exe ALWAYS exits 1. An empty `catch {}` does not help either: a
    // caught error still leaves $? false, so the process still exits 1. The exit code
    // must therefore never be trusted here. Two consequences:
    //   1. spawnSync instead of execFileSync — a non-zero exit must not throw by itself.
    //   2. success is judged immediately below by filesystem fact, not by exit status.
    // Previously the exit code was read, so EVERY delete fell through to the quarantine
    // branch (and leaked a bogus ENOENT at the call site) even though the item had
    // already reached the Recycle Bin.
    const cmd =
      "Add-Type -AssemblyName Microsoft.VisualBasic; " +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${safe}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      windowsHide: true,
      timeout: 10000,
      stdio: "ignore",
    });
    // Fact check via lstat (not existsSync): a leftover junction whose target has been
    // deleted resolves as "missing" under existsSync and would be a false pass. The shim
    // only patches fs deletion methods, so this lstat call is not re-entrant.
    let stillPresent = true;
    try {
      fs.lstatSync(resolved);
    } catch {
      stillPresent = false;
    }
    if (stillPresent) {
      throw new Error(`safe-delete: recycle-bin did not remove ${resolved}`);
    }
    if (!existedBefore) {
      // Stock fs semantics: removing a path that was already gone surfaces ENOENT.
      const enoent = new Error(`ENOENT: no such file or directory, unlink '${resolved}'`);
      enoent.code = "ENOENT";
      enoent.errno = -4058;
      enoent.syscall = "unlink";
      enoent.path = resolved;
      throw enoent;
    }
  };
  console.log("[safe-delete-shim] recycle-bin via PowerShell Microsoft.VisualBasic ready");
}

// ── fs module monkey-patch ─────────────────────────────────────────────

if (sendToRecycleBin) {
  const origUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function safeDeleteUnlinkSync(filePath, ...rest) {
    if (!isProtected(filePath) && !isTransient(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch {
        if (quarantineOutcome(filePath) === "quarantined") return;
        return origUnlinkSync.call(this, filePath, ...rest); // raced away: stock ENOENT
      }
    }
    return origUnlinkSync.call(this, filePath, ...rest);
  };

  const origUnlink = fs.unlink;
  fs.unlink = function safeDeleteUnlink(filePath, callback, ...rest) {
    if (!isProtected(filePath) && !isTransient(filePath)) {
      try {
        sendToRecycleBin(filePath);
        if (typeof callback === "function") { callback(null); }
        return;
      } catch (e) {
        // SELF-2: async callback form must NOT hard-delete on recycle failure.
        let res;
        try { res = quarantineOutcome(filePath); } catch (qe) {
          if (typeof callback === "function") { callback(qe); return; }
          throw qe; // callback-less unlink: loud failure beats silent hard delete
        }
        if (res === "quarantined") {
          if (typeof callback === "function") { callback(null); }
          return;
        }
        // SELF-2b: raced away — delegate to original fs (single callback, ENOENT)
        return origUnlink.call(this, filePath, callback, ...rest);
      }
    }
    return origUnlink.call(this, filePath, callback, ...rest);
  };

  const origRmSync = fs.rmSync;
  fs.rmSync = function safeDeleteRmSync(filePath, options, ...rest) {
    if (!isProtected(filePath) && !isTransient(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch {
        if (quarantineOutcome(filePath) === "quarantined") return;
        return origRmSync.call(this, filePath, options, ...rest); // raced away
      }
    }
    return origRmSync.call(this, filePath, options, ...rest);
  };

  const origRm = fs.rm;
  fs.rm = function safeDeleteRm(filePath, options, callback, ...rest) {
    if (!isProtected(filePath) && !isTransient(filePath)) {
      if (typeof options === "function") { callback = options; options = {}; }
      try {
        sendToRecycleBin(filePath);
        if (typeof callback === "function") { callback(null); }
        return;
      } catch (e) {
        let res;
        try { res = quarantineOutcome(filePath); } catch (qe) {
          if (typeof callback === "function") { callback(qe); return; }
          throw qe; // callback-less rm: loud failure beats silent hard delete
        }
        if (res === "quarantined") {
          if (typeof callback === "function") { callback(null); }
          return;
        }
        return origRm.call(this, filePath, options, callback, ...rest); // raced away
      }
    }
    return origRm.call(this, filePath, options, callback, ...rest);
  };

  const origPromisesUnlink = fs.promises.unlink;
  fs.promises.unlink = async function safeDeletePromisesUnlink(filePath, ...rest) {
    if (!isProtected(filePath) && !isTransient(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch {
        if (quarantineOutcome(filePath) === "quarantined") return;
        return origPromisesUnlink.call(this, filePath, ...rest); // raced away
      }
    }
    return origPromisesUnlink.call(this, filePath, ...rest);
  };

  const origPromisesRm = fs.promises.rm;
  fs.promises.rm = async function safeDeletePromisesRm(filePath, options, ...rest) {
    if (!isProtected(filePath) && !isTransient(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch {
        if (quarantineOutcome(filePath) === "quarantined") return;
        return origPromisesRm.call(this, filePath, options, ...rest); // raced away
      }
    }
    return origPromisesRm.call(this, filePath, options, ...rest);
  };

  console.log("[safe-delete-shim] fs deletion methods patched → Windows Recycle Bin (quarantine fallback armed)");
} else {
  console.log("[safe-delete-shim] Recycle-bin unavailable, fs methods NOT patched");
}

// Export helpers so CI/manual harnesses can exercise quarantine logic without
// running the whole Electron app. Requiring this file still applies the fs
// monkey-patch in the requiring process (side effect) — acceptable for tests.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { isProtected, isTransient, quarantinePath, quarantineOrThrow, quarantineOutcome, getQuarantineRoot: () => QUARANTINE_ROOT };
}
