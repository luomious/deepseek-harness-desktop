// market/validate.js — manifest / 索引 / SKILL.md frontmatter / sha256 严格校验。
// 全部 fail-closed：任何不满足即拒绝，绝不宽松放行。

import { createHash } from "node:crypto";

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CATEGORY_RE = /^[a-z0-9-]{1,32}$/;

/** 校验并归一化目录源 manifest。 */
export function validateManifest(raw, manifestUrl) {
  let m;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error("manifest 不是合法 JSON");
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("manifest 结构无效");
  if (m.manifestVersion !== "1.0.0") throw new Error("不支持的 manifestVersion：" + String(m.manifestVersion));
  if (m.selected === true || m.default === true || m.fallback === true) {
    throw new Error("manifest 不得声明自己为选中/默认/回退");
  }

  const providerId = String(m.providerId || "").trim();
  const name = String(m.name || "").trim();
  if (!providerId || providerId.length > 64) throw new Error("providerId 缺失或超长");
  if (!name || name.length > 100) throw new Error("name 缺失或超长");

  const t = m.transport;
  if (!t || t.kind !== "https-json") throw new Error("transport.kind 必须为 https-json");
  const endpoint = String(t.endpoint || "").trim();
  if (!/^https:\/\//.test(endpoint)) throw new Error("endpoint 必须为 HTTPS");
  // 防凭证 & 带 query/fragment 的端点
  const ep = new URL(endpoint);
  if (ep.username || ep.password) throw new Error("endpoint 不得携带凭证");
  if (ep.search || ep.hash) throw new Error("endpoint 不得携带 query/fragment");
  const mu = new URL(manifestUrl);
  if (mu.origin !== ep.origin) throw new Error("endpoint 必须与 manifest URL 同源（当前: " + ep.origin + "）");

  const attribution = m.attribution && typeof m.attribution === "object"
    ? { name: String(m.attribution.name || "").slice(0, 100), url: String(m.attribution.url || "").slice(0, 500) }
    : null;

  return { providerId, name, endpoint, attribution, manifestUrl };
}

/** 校验并归一化索引 JSON（provider page → 归一化快照）。 */
export function validateIndex(raw, endpoint) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error("索引不是合法 JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("索引结构无效");
  if (data.schemaVersion !== "1.0.0") throw new Error("不支持的 schemaVersion：" + String(data.schemaVersion));
  if (!Array.isArray(data.items)) throw new Error("items 必须为数组");
  if (data.items.length > 2000) throw new Error("索引条目超过上限 2000");

  const ids = new Set();
  const items = [];
  for (const it of data.items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw new Error("条目结构无效");
    const id = String(it.id || "").trim();
    if (!ID_RE.test(id) || id.length > 64) throw new Error("条目 id 无效：" + id);
    if (ids.has(id)) throw new Error("条目 id 重复：" + id);
    ids.add(id);

    const description = String(it.description || "").trim();
    if (!description || description.length > 500) throw new Error("条目描述缺失或超长：" + id);
    const version = String(it.version || "").trim();
    if (!VERSION_RE.test(version)) throw new Error("条目版本无效：" + id + " → " + version);

    const categories = Array.isArray(it.categories)
      ? it.categories.map((c) => String(c).trim()).filter(Boolean).slice(0, 8)
      : [];
    for (const c of categories) {
      if (!CATEGORY_RE.test(c)) throw new Error("条目分类无效：" + id + " → " + c);
    }

    const dl = it.download;
    if (!dl || typeof dl !== "object" || Array.isArray(dl)) throw new Error("条目缺少 download：" + id);
    const downloadUrl = String(dl.url || "").trim();
    if (!/^https:\/\//.test(downloadUrl)) throw new Error("条目 download.url 必须为 HTTPS：" + id);
    const sha256 = String(dl.sha256 || "").toLowerCase();
    if (!SHA256_RE.test(sha256)) throw new Error("条目 sha256 无效：" + id);

    // 同源校验（v1 安全模型）
    let dOrigin;
    try {
      dOrigin = new URL(downloadUrl).origin;
    } catch (e) {
      throw new Error("条目 download.url 无法解析：" + id);
    }
    if (dOrigin !== new URL(endpoint).origin) {
      throw new Error("条目下载必须与索引同源：" + id);
    }

    const author = it.author && typeof it.author === "object" && !Array.isArray(it.author)
      ? {
          name: String(it.author.name || "").slice(0, 100),
          url: String(it.author.url || "").slice(0, 500)
        }
      : null;
    const updatedAt = typeof it.updatedAt === "string" ? it.updatedAt.slice(0, 64) : null;

    items.push({
      id,
      description,
      categories,
      version,
      author,
      updatedAt,
      download: { url: downloadUrl, sha256 }
    });
  }

  return {
    schemaVersion: "1.0.0",
    providerRevision: typeof data.revision === "string" ? data.revision.slice(0, 128) : null,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt.slice(0, 64) : null,
    items
  };
}

/**
 * 解析 SKILL.md frontmatter（最简 YAML key: value，值可为带引号或裸文本）。
 * 要求首块 frontmatter 存在且含 name / description。
 */
export function parseSkillFrontmatter(content, expectedName) {
  const stripped = String(content).replace(/^\uFEFF/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(stripped);
  if (!m) throw new Error("SKILL.md 缺少 frontmatter");
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const rawVal = line.slice(idx + 1).trim();
    let val = rawVal;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) fields[key] = val.replace(/\s+$/, "");
  }
  const name = String(fields.name || "").trim();
  const description = String(fields.description || "").trim();
  if (!name) throw new Error("frontmatter 缺少 name");
  if (!ID_RE.test(name) || name.length > 64) throw new Error("frontmatter name 无效：" + name);
  if (expectedName != null && name !== expectedName) {
    throw new Error("frontmatter name 与目录不一致：" + name + " ≠ " + expectedName);
  }
  if (!description || description.length > 500) throw new Error("frontmatter description 缺失或超长");
  return {
    name,
    description,
    whenToUse: String(fields.whenToUse || "").trim().slice(0, 500) || null,
    raw: m[0]
  };
}

/** 计算文本 SHA-256（hex）。 */
export function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export { ID_RE }; // 供路径白名单复用