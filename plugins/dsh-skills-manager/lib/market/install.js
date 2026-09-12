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
 * 更新已安装 skill：校验下载 → **覆盖前备份本地原文** → 原子覆盖。
 * writeText 失败时旧文件原样保留（writeFileAtomic 失败会清理临时文件）。
 *
 * 2026-09-11（T3）新增覆盖前备份。动因：市场现在能「接管」本地已有 skill（可能来自 hub
 * 安装或用户自编），覆盖会丢掉本地原文；而旧版 UI 文案承诺「旧版本将备份」、代码里并无备份。
 * 备份落 <marketRoot>/backups/<id>/<ts>-SKILL.md（skills 目录之外，不污染技能扫描）。
 * 备份失败 → 抛错（fail-closed：宁可不更新，也不静默丢内容）。内容相同则跳过备份。
 *
 * @param marketRoot 市场根目录（~/.dsh/.skills-market）；缺省则不备份（保持旧调用兼容）
 */
export async function updateExisting(ctx, fs, shell, fullPolicy, userRoot, entryLike, marketRoot) {
  const dir = safeSkillDir(userRoot, entryLike.id);
  const { content, fm } = await downloadVerifiedSkill(ctx, entryLike);
  const target = await fs.resolve(dir + "/SKILL.md");
  if (marketRoot) {
    let prev = null;
    try { prev = await fs.readText(target); } catch (e) { prev = null; }
    if (prev != null && prev !== content) {
      const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
      const dest = await fs.resolve(marketRoot + "/backups/" + entryLike.id + "/" + stamp + "-SKILL.md");
      await fs.writeText(dest, prev, undefined, undefined, fullPolicy);
    }
  }
  await fs.writeText(target, content, undefined, undefined, fullPolicy);
  await settleMs();
  return { path: dir + "/SKILL.md", fm };
}

/**
 * 卸载前**整目录**备份（2026-09-11 T5）。
 *
 * 为什么必须有：市场「卸载」删的是 `~/.dsh/skills/<id>`，而该路径在 safe-delete-shim 的
 * PROTECTED_PREFIXES（= `DSH_HOME`）之内 —— shim 对受保护路径**故意不重定向**
 * （`patches/bundles/safe-delete-shim.cjs:290-299`：`isProtected` 为真时直接走 origRmSync），
 * 所以这是**永久删除、回收站救不回**。而市场现在可「接管」本地已有 skill
 * （内容可能是用户自编或从 hub 装来的），因此删除前必须留可回滚副本。
 *
 * 备份位置：`<marketRoot>/backups/uninstalled/<id>/<ts>/`（保留相对目录结构）。
 * fail-closed：源目录存在但备份过程抛错 → 向上抛，调用方**不得继续删除**。
 *
 * @returns {{path:string, files:number}|null} 备份信息；源目录不存在时返回 null（无可备份）
 */
export function backupSkillDir(userRoot, marketRoot, skillName) {
  const dir = safeSkillDir(userRoot, skillName);
  let st = null;
  try { st = nodeFs.statSync(dir); } catch (e) { return null; }
  if (!st.isDirectory()) return null;
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const base = marketRoot + "/backups/uninstalled/" + skillName + "/" + stamp;
  let files = 0;
  const walk = (src, dst) => {
    nodeFs.mkdirSync(dst, { recursive: true });
    for (const e of nodeFs.readdirSync(src, { withFileTypes: true })) {
      const s = src + "/" + e.name;
      const d = dst + "/" + e.name;
      if (e.isDirectory()) walk(s, d);
      else if (e.isFile()) { nodeFs.copyFileSync(s, d); files++; }
      // 其它类型（符号链接等）跳过：不跟随，避免把目录外的内容复制进来
    }
  };
  walk(dir, base);
  return { path: base, files };
}

/**
 * 卸载：**先整目录备份**，再删除 userRoot 内的目标目录（越界防护复用 safeSkillDir 的检查）。
 * 用 node:fs 而非 ctx.shell（Windows 下 PowerShell 的 rm 语法不兼容）。
 * 备份失败 → 抛错（fail-closed：宁可拒绝卸载，也不做不可恢复的删除）。
 *
 * @param marketRoot 市场根目录；缺省则不备份（保持旧调用兼容）
 * @returns {{dir:string, backup:string|null, files:number}}
 */
export async function uninstallSkill(ctx, fs, shell, fullPolicy, userRoot, skillName, marketRoot) {
  const dir = safeSkillDir(userRoot, skillName);
  let backup = null;
  if (marketRoot) backup = backupSkillDir(userRoot, marketRoot, skillName);
  nodeFs.rmSync(dir, { recursive: true, force: true });
  await settleMs();
  return { dir, backup: backup ? backup.path : null, files: backup ? backup.files : 0 };
}