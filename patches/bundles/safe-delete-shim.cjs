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
 * Loaded via createRequire() at the top of main.js.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// ── Protected-path detection ──────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const DSH_HOME = path.join(HOME, ".dsh");

const PROTECTED_PREFIXES = [
  DSH_HOME.toLowerCase(),
  path.join(os.tmpdir()).toLowerCase(),
];

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

// ── Windows Recycle Bin via PowerShell ────────────────────────────────

let sendToRecycleBin = null;

if (process.platform === "win32") {
  sendToRecycleBin = function sendToRecycleBinPs(filePath) {
    const resolved = path.resolve(filePath);
    // Escape single quotes for PowerShell
    const safe = resolved.replace(/'/g, "''");
    // Detect directory so we use the correct VB API (DeleteFile only works
    // on files; directories need DeleteDirectory, which is recursive).
    let isDir = false;
    try {
      const st = fs.statSync(resolved);
      isDir = st.isDirectory();
    } catch {
      // target missing: fall back to file API (will no-op/throw → original fs)
      isDir = false;
    }
    const method = isDir ? "DeleteDirectory" : "DeleteFile";
    const cmd =
      "Add-Type -AssemblyName Microsoft.VisualBasic; " +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${safe}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      windowsHide: true,
      timeout: 10000,
      stdio: "ignore",
    });
  };
  console.log("[safe-delete-shim] recycle-bin via PowerShell Microsoft.VisualBasic ready");
}

// ── fs module monkey-patch ─────────────────────────────────────────────

if (sendToRecycleBin) {
  const origUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function safeDeleteUnlinkSync(filePath, ...rest) {
    if (!isProtected(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch { /* fall through */ }
    }
    return origUnlinkSync.call(this, filePath, ...rest);
  };

  const origUnlink = fs.unlink;
  fs.unlink = function safeDeleteUnlink(filePath, callback, ...rest) {
    if (!isProtected(filePath)) {
      try {
        sendToRecycleBin(filePath);
        if (typeof callback === "function") { callback(null); }
        return;
      } catch (e) {
        if (typeof callback === "function") { callback(e); return; }
        // no callback: fall through to original
      }
    }
    return origUnlink.call(this, filePath, callback, ...rest);
  };

  const origRmSync = fs.rmSync;
  fs.rmSync = function safeDeleteRmSync(filePath, options, ...rest) {
    if (!isProtected(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch { /* fall through */ }
    }
    return origRmSync.call(this, filePath, options, ...rest);
  };

  const origRm = fs.rm;
  fs.rm = function safeDeleteRm(filePath, options, callback, ...rest) {
    if (!isProtected(filePath)) {
      if (typeof options === "function") { callback = options; options = {}; }
      try {
        sendToRecycleBin(filePath);
        if (typeof callback === "function") { callback(null); }
        return;
      } catch (e) {
        if (typeof callback === "function") { callback(e); return; }
        // no callback: fall through to original
      }
    }
    return origRm.call(this, filePath, options, callback, ...rest);
  };

  const origPromisesUnlink = fs.promises.unlink;
  fs.promises.unlink = async function safeDeletePromisesUnlink(filePath, ...rest) {
    if (!isProtected(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch { /* fall through */ }
    }
    return origPromisesUnlink.call(this, filePath, ...rest);
  };

  const origPromisesRm = fs.promises.rm;
  fs.promises.rm = async function safeDeletePromisesRm(filePath, options, ...rest) {
    if (!isProtected(filePath)) {
      try { sendToRecycleBin(filePath); return; } catch { /* fall through */ }
    }
    return origPromisesRm.call(this, filePath, options, ...rest);
  };

  console.log("[safe-delete-shim] fs deletion methods patched → Windows Recycle Bin");
} else {
  console.log("[safe-delete-shim] Recycle-bin unavailable, fs methods NOT patched");
}
