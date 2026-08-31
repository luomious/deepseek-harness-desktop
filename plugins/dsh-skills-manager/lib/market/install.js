// market/install.js — 安装 / 更新 / 卸载流程。
// 原则：下载 → SHA-256 强校验 → frontmatter 解析 → 路径白名单 → 原子落位 → watcher 确认。
// 任何一步失败不留下半成品；更新失败自动回滚。
// 2026-09-01 修复：Windows 下 ctx.shell 为 PowerShell，Unix 命令（mkdir -p / mv -f / rm -rf）
// 全部失效（-p 不幂等、-f/-rf 参数不存在）。改为 ctx.fs.writeText 原子落位（内部临时文件+rename、
// 自动建父目录，见 dsh-atomic-write），删除改用 node:fs——彻底绕开 shell 语法差异。

import nodeFs from "node:fs";
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
 * 安装新 skill：校验下载 → ctx.fs.writeText 原子落位（自动建目录）→ 等 watcher。
 * @returns {{path: string, fm: object}}
 */
export async function installNew(ctx, fs, shell, fullPolicy, userRoot, entryLike) {
  const dir = safeSkillDir(userRoot, entryLike.id);
  const { content, fm } = await downloadVerifiedSkill(ctx, entryLike);
  const target = await fs.resolve(dir + "/SKILL.md");
  // 同名已存在由调用方（collectAll 预检）拒绝安装；此处直接原子写入。
  // writeText 内部为临时文件 + rename（原子），且自动创建父目录，无需 mkdir/mv。
  await fs.writeText(target, content, undefined, undefined, fullPolicy);
  await settleMs();
  return { path: dir + "/SKILL.md", fm };
}

/**
 * 更新已安装 skill：校验下载 → 原子覆盖。writeText 失败时旧文件原样保留
 * （writeFileAtomic 失败会清理临时文件），无需显式 .bak 回滚。
 */
export async function updateExisting(ctx, fs, shell, fullPolicy, userRoot, entryLike) {
  const dir = safeSkillDir(userRoot, entryLike.id);
  const { content, fm } = await downloadVerifiedSkill(ctx, entryLike);
  const target = await fs.resolve(dir + "/SKILL.md");
  await fs.writeText(target, content, undefined, undefined, fullPolicy);
  await settleMs();
  return { path: dir + "/SKILL.md", fm };
}

/**
 * 卸载：仅删除 userRoot 内的目标目录（越界防护复用 safeSkillDir 的检查）。
 * 用 node:fs 而非 ctx.shell（Windows 下 PowerShell 的 rm 语法不兼容）。
 */
export async function uninstallSkill(ctx, fs, shell, fullPolicy, userRoot, skillName) {
  const dir = safeSkillDir(userRoot, skillName);
  nodeFs.rmSync(dir, { recursive: true, force: true });
  await settleMs();
  return dir;
}