// market/install.js — 安装 / 更新 / 卸载流程。
// 原则：下载 → SHA-256 强校验 → frontmatter 解析 → 路径白名单 → 原子替换 → watcher 确认。
// 任何一步失败不留下半成品；更新失败自动回滚。

import { fetchText, assertSameOrigin } from "./fetch.js";
import { parseSkillFrontmatter, sha256Hex } from "./validate.js";
import { ID_RE } from "./validate.js";

export function settleMs(ms) {
  return new Promise((r) => setTimeout(r, ms || 300));
}

/** 生成目标目录名（白名单 + 规范化），拒绝越界/穿越。 */
export function safeSkillDir(userRoot, skillName) {
  const root = String(userRoot).replace(/[\\/]+$/, "");
  const name = String(skillName).trim();
  if (!ID_RE.test(name) || name.length > 64) {
    throw new Error("skill 名称无效：" + name);
  }
  const dir = root + "/" + name;
  // 越界防护：目录必须落在 userRoot 内，且不允许 .. 段
  if (!dir.startsWith(root + "/") || dir.split(/[\\/]/).includes("..")) {
    throw new Error("拒绝越界路径：" + dir);
  }
  return dir;
}

/**
 * 下载并完整校验一个市场条目，返回本地文件文本（已验证 sha256 + frontmatter）。
 */
export async function downloadVerifiedSkill(ctx, entryLike) {
  const content = await fetchText(ctx, entryLike.download.url);
  const sha = sha256Hex(content);
  if (sha !== entryLike.download.sha256) {
    throw new Error("SHA-256 校验失败：" + entryLike.id);
  }
  const fm = parseSkillFrontmatter(content, entryLike.id);
  return { content, fm };
}

/**
 * 安装新 skill：写暂存 → mkdir 目标 → mv 原子落位 → 等 watcher。
 * @returns {{path: string, fm: object}}
 */
export async function installNew(ctx, fs, shell, fullPolicy, userRoot, entryLike) {
  const dir = safeSkillDir(userRoot, entryLike.id);
  const { content, fm } = await downloadVerifiedSkill(ctx, entryLike);
  const target = await fs.resolve(dir + "/SKILL.md");

  // 存在性检查由调用方完成（同名已存在 → 拒绝安装）
  await runCmd(shell, "mkdir -p -- " + shq(dir), fullPolicy);
  await fs.writeText(target, content, undefined, undefined, fullPolicy);
  await settleMs();
  return { path: dir + "/SKILL.md", fm };
}

/**
 * 更新已安装 skill：先写新内容到暂存，再旧→.bak、新→落位，成功删 .bak，失败回滚。
 */
export async function updateExisting(ctx, fs, shell, fullPolicy, userRoot, entryLike) {
  const dir = safeSkillDir(userRoot, entryLike.id);
  const target = await fs.resolve(dir + "/SKILL.md");
  const backup = await fs.resolve(dir + "/.SKILL.md.bak");
  const { content, fm } = await downloadVerifiedSkill(ctx, entryLike);

  // 旧文件必须存在（调用方已确认）
  await fs.writeText(target + ".new", content, undefined, undefined, fullPolicy);
  await runCmd(shell, "mv -f -- " + shq(target) + " " + shq(backup), fullPolicy);
  try {
    await runCmd(shell, "mv -f -- " + shq(target + ".new") + " " + shq(target), fullPolicy);
    await runCmd(shell, "rm -f -- " + shq(backup), fullPolicy);
    await settleMs();
    return { path: dir + "/SKILL.md", fm };
  } catch (e) {
    // 回滚：尽力恢复备份
    try {
      await runCmd(shell, "mv -f -- " + shq(backup) + " " + shq(target), fullPolicy);
    } catch (e2) { /* 原样保留 .bak 供人工恢复 */ }
    throw e;
  }
}

/**
 * 卸载：仅删除 userRoot 内的目标目录（越界防护复用 safeSkillDir 的检查）。
 */
export async function uninstallSkill(ctx, fs, shell, fullPolicy, userRoot, skillName) {
  const dir = safeSkillDir(userRoot, skillName);
  await runCmd(shell, "rm -rf -- " + shq(dir), fullPolicy);
  await settleMs();
  return dir;
}

async function runCmd(shell, command, fullPolicy) {
  const spec = shell.resolve({ command, timeoutMs: 8000, sandboxPolicy: fullPolicy });
  const res = await shell.run(spec);
  if (res.exitCode !== 0) {
    throw new Error("命令失败（exit " + res.exitCode + "）：" + command.slice(0, 80));
  }
  return res;
}

function shq(p) {
  return "'" + String(p).replace(/'/g, "'\\''") + "'";
}