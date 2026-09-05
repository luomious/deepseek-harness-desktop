#!/usr/bin/env node
/**
 * ensure-recovery-profile.mjs
 * ---------------------------------------------------------------------------
 * 建立 / 自愈「备用钥匙」Profile：(default) recover-web
 *
 * 为什么需要它：
 *   desktop Profile 装配了大量自研 link 插件 + 补丁，万一某次装配中断，
 *   恢复助手的「启用备用配置」需要一个“最低可用、必能起 Web GUI”的干净
 *   Profile。官方模板 web = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]
 *   （dsh-app-boot / lib/index.js PROFILE_TEMPLATES.web），完全由构建产物提供，
 *   零自研插件，因此必然能带起 127.0.0.1:43120 的 Web GUI。
 *
 * 设计原则（可维护 / 可迭代 / 可扩展 / 不冲突）：
 *   - 复用官方 dsh-app-boot 的 PROFILE_TEMPLATES + initProfile，复刻桌面
 *     「Add Profile」按钮完全相同的行为，避免重复实现导致行为漂移。
 *   - 幂等：目标 Profile 已存在且 bundle 清单 == 官方 web 模板 → 视为已就绪，
 *     直接成功返回；绝不重复初始化 / 覆盖已有内容。
 *   - 原子：在同一 profiles 目录的 sibling staging 目录初始化，成功后一次
 *     rename 发布；任何失败都不留下半成品目标目录。
 *   - 登记：acquire（profiles 目录）→ 创建 → release --summary，符合
 *     task-scheduler 多会话协作铁律，改动全量可回溯。
 *   - 可回滚：新建目录可整体移回收站删除，不影响其余 Profile。
 *
 * 2026-09-04 phase1.1 新增（参考上游 v2.0.5「快速恢复/安全模式」设计）：
 *   --safe-mode [name]  创建一次性隔离 Profile（默认名 recover-safe-<时间戳>），
 *                       供“出问题时进去做恢复操作”的场景；与官方安全模式的
 *                       差异：profile 级隔离（共享 ~/.dsh 其余目录），适用
 *                       插件/装配损坏恢复，不适用 settings.yaml 本身损坏
 *                       （该场景已有 settings 防腐化双保险兜底）。
 *   --cleanup           幂等清理：删除超过 --max-age-hours（默认 24h）的
 *                       recover-safe-* Profile。默认 dry-run 只列清单；
 *                       --yes 才执行（回收站删除，可恢复）。名字不合法或
 *                       缺 package.json 的目录一律拒绝删除。
 *   生命周期约定：safe-mode Profile 名内嵌时间戳（recover-safe-<yyyymmdd>-
 *   <hhmmss>），cleanup 按名字解析年龄，零状态文件、可跨会话维护。
 * ---------------------------------------------------------------------------
 */
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = "ensure-recovery-profile";
const DESKTOP_ROOT = dirname(fileURLToPath(import.meta.url)); // scripts/ 目录本身
const DESKTOP_REPO_ROOT = join(DESKTOP_ROOT, ".."); // D:\Deepseek-Harness
const DEFAULT_PROFILE = "recover-web";
const SAFE_PREFIX = "recover-safe-";
const APP_BOOT_ENTRY = join(
  DESKTOP_REPO_ROOT,
  "vendor/deepseek-harness-desktop/dsh-plugin-desktop/dist/win-unpacked/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js",
);

function home() {
  return process.env.DSH_HOME || join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".dsh",
  );
}

/** 只读列出 ~/.dsh/profiles 下所有含 package.json 的目录名。 */
function existingProfiles(homeDir) {
  const dir = join(homeDir, "profiles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name !== "node_modules" && existsSync(join(dir, name, "package.json")));
}

async function loadAppBoot() {
  const mod = await import(/* @vite-ignore */ `file://${APP_BOOT_ENTRY.replace(/\\/g, "/")}`);
  return mod;
}

function assertProfileName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) {
    throw new Error(`${BIN}: 非法 profile 名 ${JSON.stringify(name)}（仅字母数字 . _ : - 开头非符号）`);
  }
  if (name === "node_modules" || name.includes("/") || name.includes("\\")) {
    throw new Error(`${BIN}: 非法 profile 名 ${JSON.stringify(name)}`);
  }
}

/** recover-safe-<yyyymmdd>-<hhmmss> 时间戳生成。 */
function safeStamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 从 safe-mode 名字解析年龄 ms；非本命名法返回 null（拒绝处理）。 */
function safeAgeMs(name) {
  const m = new RegExp(`^${SAFE_PREFIX}(\\d{8})-(\\d{6})$`).exec(name);
  if (!m) return null;
  const t = Date.parse(
    `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}`,
  );
  return Number.isFinite(t) ? Date.now() - t : null;
}

/**
 * 经官方 web 模板创建 Profile（ensure 与 safe-mode 共用的唯一实现）。
 * 幂等 / staging 原子发布 / 锁登记 / scan-dangling 复核，行为与桌面「Add Profile」一致。
 */
async function createViaOfficialTemplate(profileName, { yes, disposable }) {
  assertProfileName(profileName);
  const homeDir = home();
  const profilesDir = join(homeDir, "profiles");
  const target = join(profilesDir, profileName);

  if (existsSync(target)) {
    const marker = join(target, "package.json");
    if (!existsSync(marker)) {
      console.error(`[${BIN}] 目标目录 ${target} 存在但缺少 package.json，拒绝自动覆盖。请人工检查后处理。`);
      process.exit(2);
    }
    const manifest = JSON.parse(readFileSync(marker, "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    const web = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
    const matched = Array.isArray(bundles) && bundles.length === web.length && web.every((b, i) => bundles[i] === b);
    if (matched) {
      console.log(`[${BIN}] ✅ Profile "${profileName}" 已存在且 bundle == 官方 web 模板，保持不动（幂等退出）。`);
      return 0;
    }
    console.error(`[${BIN}] Profile "${profileName}" 已存在但 bundles=${JSON.stringify(bundles)} 非官方 web 模板。`);
    console.error(`[${BIN}] 为避免与已有内容冲突，未做任何修改。请人工确认。`);
    process.exit(3);
  }

  // 冲突预检：官方模板 bundle 是否可解析（由构建产物提供）
  console.log(`[${BIN}] 预检官方 web 模板 bundle 可解析 ...`);
  for (const pkg of ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) {
    const bundled = join(
      DESKTOP_REPO_ROOT,
      `vendor/deepseek-harness-desktop/dsh-plugin-desktop/dist/win-unpacked/resources/app.asar.unpacked/node_modules/${pkg}`,
    );
    if (!existsSync(bundled)) {
      console.error(`[${BIN}] 缺少构建产物核心 bundle：${pkg}（${bundled}）。无法兜底。`);
      process.exit(4);
    }
  }

  if (!yes) {
    console.log(`\n将创建${disposable ? "一次性安全模式" : "全新"} Profile：${target}`);
    console.log(`  bundle: @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app（官方 web 模板）`);
    console.log(`  nodes:  无自研 link 插件，核心 bundle 由构建产物提供`);
    console.log(`  rollback: 可整目录移回收站删除，不影响其余 Profile`);
    const readline = await (await import("node:readline")).createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ans = await new Promise((r) => readline.question(`确认创建？[y/N] `, r));
    readline.close();
    if (!/^y/i.test(ans.trim())) {
      console.log(`[${BIN}] 已取消。`);
      return 0;
    }
  }

  // 登记锁
  let token = null;
  try {
    const lock = execSync(
      `node "${join(DESKTOP_ROOT, "task-scheduler.mjs")}" acquire --resources "${profilesDir}" --who "${BIN}:create-${profileName}" --priority normal`.replace(/(\r\n|\n)/g, " "),
      { encoding: "utf8", windowsHide: true },
    );
    token = JSON.parse(lock.split("\n").find((l) => l.trim().startsWith("{") && l.includes("token")) || lock)?.token ?? null;
  } catch {
    // 锁服务不可用不阻塞（保守降级），但保持登记到 stdout
  }

  try {
    const appBoot = await loadAppBoot();
    const { PROFILE_TEMPLATES, initProfile, resolveProfileDir, writeProfileManifest } = appBoot;

    mkdirSync(profilesDir, { recursive: true });
    const staging = join(profilesDir, `.${profileName}.creating-${process.pid}-${randomUUID()}`);
    try {
      const bundlesList = [...PROFILE_TEMPLATES.web];
      initProfile(staging, bundlesList);
      const manifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
      manifest.name = `dsh-profile-${profileName}`;
      writeProfileManifest(staging, manifest);
      if (existsSync(target)) throw new Error(`${BIN}: Profile "${profileName}" 竞争创建冲突，已中止`);
      renameSync(staging, target);
    } catch (cause) {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      throw cause;
    }

    console.log(`[${BIN}] ✅ 已创建${disposable ? "一次性安全模式" : "备用"} Profile "${profileName}"：`);
    console.log(`  位置:  ${target}`);
    console.log(`  bundle: ${PROFILE_TEMPLATES.web.join(", ")}`);
    console.log(`  manifest: dsh-profile-${profileName} (私有)`);
  } finally {
    if (token) {
      try {
        execSync(
          `node "${join(DESKTOP_ROOT, "task-scheduler.mjs")}" release --resources "${profilesDir}" --token ${token} --summary "created ${disposable ? "safe-mode" : "recovery"} profile ${profileName} via official web template"`.replace(/(\r\n|\n)/g, " "),
          { encoding: "utf8", windowsHide: true },
        );
      } catch { /* 忽略 */ }
    }
  }

  // 复核：scan-dangling 判定干净
  console.log(`[${BIN}] 复核 scan-dangling --strict ...`);
  try {
    const out = execSync(
      `node "${join(DESKTOP_ROOT, "scan-dangling.mjs")}" --strict`,
      { encoding: "utf8", windowsHide: true },
    );
    console.log(out.split("\n").slice(-4).join("\n"));
  } catch (e) {
    const tail = String(e.stdout || e).split("\n").slice(-5).join("\n");
    console.log(tail);
  }
  return 0;
}

/** --safe-mode：创建一次性隔离 Profile（recover-safe-<时间戳>）。 */
async function safeModeMain(profileName, { yes }) {
  assertProfileName(profileName);
  if (!profileName.startsWith(SAFE_PREFIX)) {
    throw new Error(`${BIN}: safe-mode Profile 名必须以 "${SAFE_PREFIX}" 开头（供 --cleanup 按名识别与清理）`);
  }
  console.log(`[${BIN}] 创建一次性安全模式 Profile：${profileName}`);
  console.log(`  · 隔离范围：profile 级（共享 ~/.dsh 其余目录）；适用插件/装配损坏恢复；`);
  console.log(`  · 生命周期：用完即弃，超过 24h 由 --cleanup 清理（回收站，可恢复）。`);
  return createViaOfficialTemplate(profileName, { yes, disposable: true });
}

/** --cleanup：幂等清理超龄 safe-mode Profile（默认 dry-run，--yes 回收站删除）。 */
function cleanupMain({ yes, maxAgeHours }) {
  const profilesDir = join(home(), "profiles");
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    console.log(`[${BIN}] profiles 目录不存在（${profilesDir}），无需清理。`);
    return 0;
  }
  const cutoffMs = maxAgeHours * 3600 * 1000;
  const stale = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(SAFE_PREFIX)) continue;
    const age = safeAgeMs(e.name);
    if (age === null) {
      console.log(`  skip ${e.name}（名字非 recover-safe-<时间戳> 规范，拒绝自动删除）`);
      continue;
    }
    if (!existsSync(join(profilesDir, e.name, "package.json"))) {
      console.log(`  skip ${e.name}（缺少 package.json，拒绝自动删除）`);
      continue;
    }
    if (age >= cutoffMs) stale.push({ name: e.name, ageH: (age / 3600000).toFixed(1) });
  }
  if (stale.length === 0) {
    console.log(`[${BIN}] 没有超过 ${maxAgeHours}h 的 safe-mode Profile，无需清理。`);
    return 0;
  }
  console.log(`[${BIN}] 超龄 safe-mode Profile（>= ${maxAgeHours}h）：`);
  for (const s of stale) console.log(`  - ${s.name}（已存在 ${s.ageH}h）`);
  if (!yes) {
    console.log(`[${BIN}] dry-run 默认：以上为预演，加 --yes 才移入回收站（可恢复）。`);
    return 0;
  }
  let failed = 0;
  for (const s of stale) {
    const target = join(profilesDir, s.name);
    try {
      const escaped = target.replace(/'/g, "''");
      const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}','OnlyErrorDialogs','SendToRecycleBin')`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: "ignore" });
      console.log(`[${BIN}] ♻ 已移入回收站：${s.name}`);
    } catch (cause) {
      failed += 1;
      console.error(`[${BIN}] 回收站删除失败 ${s.name}：${String(cause && cause.message ? cause.message : cause).slice(0, 200)}`);
    }
  }
  console.log(`[${BIN}] 清理完成（成功 ${stale.length - failed} / 失败 ${failed}；回收站可恢复）。`);
  return failed === 0 ? 0 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));

  if (flags.includes("--cleanup")) {
    const idx = argv.indexOf("--max-age-hours");
    let maxAgeHours = 24;
    if (idx !== -1) {
      const raw = Number(argv[idx + 1]);
      if (!(raw >= 0)) throw new Error(`${BIN}: --max-age-hours 需为 >= 0 的数字`);
      maxAgeHours = raw;
    }
    return cleanupMain({ yes, maxAgeHours });
  }

  if (flags.includes("--safe-mode")) {
    const profileName = positional[0] || `recover-safe-${safeStamp()}`;
    return safeModeMain(profileName, { yes });
  }

  // ── 默认：ensure 备用钥匙 Profile（原有行为，保持不变） ──
  const profileName = positional[0] || DEFAULT_PROFILE;
  console.log(`[${BIN}] DSH_HOME = ${home()}`);
  console.log(`[${BIN}] 目标 Profile = ${profileName}`);
  const created = await createViaOfficialTemplate(profileName, { yes, disposable: false });
  if (created !== 0) return created;
  console.log(`\n[${BIN}] 完成。要点：`);
  console.log(`  · 桌面「重启」后，恢复助手 / Profile 列表才会看到 "${profileName}"。`);
  console.log(`  · 需要真实生效 = 重启 DSH Desktop（由你执行，本脚本 / agent 不自动重启）。`);
  console.log(`  · 回滚：将 ${join(home(), "profiles", profileName)} 整目录移回收站即可（不影响 desktop / web）。`);
  return 0;
}

main().then((code) => process.exit(code)).catch((cause) => {
  console.error(`[${BIN}] 失败：`, cause instanceof Error ? cause.stack : cause);
  process.exit(1);
});
