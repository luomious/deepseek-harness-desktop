// market/state.js — 市场本地状态与目录索引缓存读写（~/.dsh/.skills-market/）
// 独立于 ~/.dsh/skills 存放，避免被技能扫描器误当成 skill。

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const INDEX_MAX_BYTES = 900 * 1024; // 受限信道 1 MiB 内留余量

/** userRoot 形如 ~/.dsh/skills，市场根目录放其上一级（~/.dsh/.skills-market）。 */
export function marketRootOf(userRoot) {
  const norm = String(userRoot).replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx <= 0) return norm + "/.skills-market";
  return norm.slice(0, idx) + "/.skills-market";
}

export function emptyState() {
  return { version: 1, sources: [], installed: [] };
}

export async function readState(fs, root) {
  const file = await fs.resolve(root + "/state.json");
  try {
    const text = await fs.readText(file);
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return emptyState();
    return {
      version: data.version === 1 ? 1 : 1,
      sources: Array.isArray(data.sources) ? data.sources : [],
      installed: Array.isArray(data.installed) ? data.installed : []
    };
  } catch (e) {
    return emptyState();
  }
}

export async function writeState(fs, root, state, policy) {
  const file = await fs.resolve(root + "/state.json");
  await fs.writeText(file, JSON.stringify(state, null, 2), undefined, undefined, policy);
}

export function cachePathOf(root, recordId) {
  return root + "/cache/" + String(recordId).replace(/[^A-Za-z0-9_-]/g, "_") + ".json";
}

export async function readCache(fs, root, recordId) {
  try {
    const file = await fs.resolve(cachePathOf(root, recordId));
    const data = JSON.parse(await fs.readText(file));
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (e) {
    return null;
  }
}

export async function writeCache(fs, root, recordId, snapshot, policy) {
  const dir = root + "/cache";
  try {
    const file = await fs.resolve(cachePathOf(root, recordId));
    await fs.writeText(file, JSON.stringify(snapshot, null, 2), undefined, undefined, policy);
    return dir;
  } catch (e) {
    return null;
  }
}