// market/api.js — 市场业务 API（sources / list / install / update / uninstall）。
// 无默认选中源、显式选择、来源可见、浏览 ≠ 授权、失败关闭、绝不自动回退。

import { fetchText } from "./fetch.js";
import { validateManifest, validateIndex } from "./validate.js";
import { CACHE_TTL_MS } from "./state.js";
import {
  emptyState, marketRootOf, readState, writeState,
  readCache, writeCache
} from "./state.js";
import {
  installNew, updateExisting, uninstallSkill
} from "./install.js";

export function createMarketApi(ctx, deps) {
  const { fs, shell, sandboxPolicy, detectUserRoot, collectAll } = deps;
  const fullPolicy = sandboxPolicy.resolve({ mode: "danger-full-access" });

  let cacheRoot = null;
  async function root() {
    const userRoot = await detectUserRoot();
    if (!userRoot) throw new Error("无法定位用户 skills 根目录（~/.dsh/skills）");
    cacheRoot = marketRootOf(userRoot);
    // 确保状态/缓存目录存在（fs 无 mkdir，用 shell；幂等）
    try {
      const spec = shell.resolve({
        command: "mkdir -p -- '" + String(cacheRoot).replace(/'/g, "'\\''") + "'/cache",
        timeoutMs: 5000,
        sandboxPolicy: fullPolicy
      });
      const r = await shell.run(spec);
      if (r.exitCode !== 0) throw new Error("mkdir exit " + r.exitCode);
    } catch (e) {
      // 目录创建失败：交由写入路径给出清晰错误
      cacheRoot = marketRootOf(userRoot);
    }
    return cacheRoot;
  }
  async function state() {
    return root().then((r) => readState(fs, r));
  }

  function uid() {
    return "rec-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // ---------- 源管理 ----------
  async function sources() {
    const s = await state();
    return {
      ok: true,
      data: {
        sources: s.sources.map((r) => ({
          recordId: r.recordId,
          manifestUrl: r.manifestUrl,
          providerId: r.manifest && r.manifest.providerId,
          name: r.manifest && r.manifest.name,
          endpoint: r.manifest && r.manifest.endpoint,
          selected: !!r.selected,
          addedAt: r.addedAt || null
        })),
        installed: s.installed.map((i) => ({
          skillId: i.skillId, name: i.name, version: i.version,
          sourceRecordId: i.sourceRecordId, sha256: i.sha256, installedAt: i.installedAt
        }))
      }
    };
  }

  async function selectSource(recordId) {
    const s = await state();
    const found = s.sources.find((r) => r.recordId === recordId);
    if (!found) return { ok: false, error: "源不存在：" + recordId };
    for (const r of s.sources) r.selected = r.recordId === recordId;
    await writeState(fs, await root(), s, fullPolicy);
    return { ok: true, data: { recordId } };
  }

  async function addSource(manifestUrl) {
    const url = String(manifestUrl || "").trim();
    if (!/^https:\/\//.test(url)) return { ok: false, error: "manifest URL 必须为 HTTPS" };
    const raw = await fetchText(ctx, url);
    let manifest;
    try {
      manifest = validateManifest(raw, url);
    } catch (e) {
      return { ok: false, error: "manifest 校验失败：" + e.message };
    }
    const s = await state();
    const dup = s.sources.find((r) => r.manifestUrl === url);
    if (dup) return { ok: false, error: "该源已添加：" + url };
    s.sources.push({
      recordId: uid(),
      manifestUrl: url,
      manifest,
      addedAt: new Date().toISOString(),
      selected: false
    });
    await writeState(fs, await root(), s, fullPolicy);
    return { ok: true, data: { recordId: s.sources[s.sources.length - 1].recordId } };
  }

  async function removeSource(recordId) {
    const s = await state();
    const next = s.sources.filter((r) => r.recordId !== recordId);
    if (next.length === s.sources.length) return { ok: false, error: "源不存在：" + recordId };
    s.sources = next;
    await writeState(fs, await root(), s, fullPolicy);
    return { ok: true, data: null };
  }

  // ---------- 索引获取（缓存 24h + 离线降级） ----------
  async function loadIndex(s) {
    const selected = s.sources.find((r) => r.selected) || null;
    if (!selected) return { ok: true, data: { sources: [], selected: null } };
    const rootDir = await root();
    const meta = { recordId: selected.recordId, endpoint: selected.manifest.endpoint };

    // 1) 缓存命中且未过期 → 直接复用
    const cached = await readCache(fs, rootDir, selected.recordId);
    if (cached && cached.expiresAt && Date.now() < cached.expiresAt) {
      return {
        ok: true,
        data: {
          cacheStatus: "cached",
          stale: false,
          source: meta,
          ...cached.snapshot
        }
      };
    }

    // 2) 拉取远程
    try {
      const raw = await fetchText(ctx, selected.manifest.endpoint);
      const snapshot = validateIndex(raw, selected.manifest.endpoint);
      const payload = {
        fetchedAt: new Date().toISOString(),
        expiresAt: Date.now() + CACHE_TTL_MS,
        snapshot
      };
      await writeCache(fs, rootDir, selected.recordId, payload, fullPolicy);
      return { ok: true, data: { cacheStatus: "fresh", stale: false, source: meta, ...snapshot } };
    } catch (e) {
      // 3) 远程失败 → 有过期缓存则降级（stale），否则失败（不自动回退）
      if (cached) {
        return {
          ok: true,
          data: {
            cacheStatus: "stale-cache",
            stale: true,
            staleError: String((e && e.message) || e),
            source: meta,
            ...cached.snapshot
          }
        };
      }
      return { ok: false, error: "拉取索引失败：" + ((e && e.message) || e) };
    }
  }

  async function list(args) {
    const q = args && args.q ? String(args.q).trim().toLowerCase().slice(0, 100) : "";
    const category = args && args.category ? String(args.category).trim().slice(0, 32) : "";
    const s = await state();
    const res = await loadIndex(s);
    if (!res.ok) return res;
    if (!res.data.items) {
      return { ok: true, data: { ...res.data, items: [], selected: null } };
    }
    let items = res.data.items;
    if (category) items = items.filter((i) => i.categories && i.categories.includes(category));
    if (q) {
      const match = (i) =>
        i.id.includes(q) ||
        String(i.description || "").toLowerCase().includes(q) ||
        (i.categories || []).some((c) => c.includes(q));
      items = items.filter(match);
    }
    const categories = [...new Set(res.data.items.flatMap((i) => i.categories || []))].sort();
    // 标注已安装
    const installedSet = new Map(s.installed.map((i) => [i.skillId, i]));
    items = items.map((i) => ({
      ...i,
      installed: installedSet.has(i.id),
      installedVersion: installedSet.has(i.id) ? installedSet.get(i.id).version : null
    }));
    return { ok: true, data: { ...res.data, items, categories, total: items.length } };
  }

  // ---------- 安装 / 更新 / 卸载 ----------
  async function needIndexAndItem(skillId) {
    const s = await state();
    const selected = s.sources.find((r) => r.selected);
    if (!selected) return { ok: false, error: "请先选择一个目录源" };
    const res = await loadIndex(s);
    if (!res.ok) return res;
    const item = (res.data.items || []).find((i) => i.id === skillId);
    if (!item) return { ok: false, error: "目录中不存在该 skill：" + skillId };
    return { ok: true, s, selected, item };
  }

  async function install(args) {
    const skillId = args && args.skillId ? String(args.skillId).trim() : "";
    if (!skillId) return { ok: false, error: "缺少 skillId" };
    const prep = await needIndexAndItem(skillId);
    if (!prep.ok) return prep;

    const { s, selected, item } = prep;
    // 同名已存在（本地或系统）→ 拒绝安装（防止覆盖）
    const { items: all } = await collectAll();
    if (all.some((x) => x.name === skillId)) {
      return { ok: false, error: "同名 skill 已存在（本地或系统），可用更新或先卸载" };
    }
    const userRoot = await detectUserRoot();
    try {
      const { path, fm } = await installNew(ctx, fs, shell, fullPolicy, userRoot, item);
      s.installed.push({
        skillId, name: skillId, version: item.version,
        sourceRecordId: selected.recordId, sha256: item.download.sha256,
        installedAt: new Date().toISOString()
      });
      await writeState(fs, await root(), s, fullPolicy);
      return { ok: true, data: { path, description: fm.description, whenToUse: fm.whenToUse } };
    } catch (e) {
      return { ok: false, error: "安装失败：" + ((e && e.message) || e) };
    }
  }

  async function update(args) {
    const skillId = args && args.skillId ? String(args.skillId).trim() : "";
    if (!skillId) return { ok: false, error: "缺少 skillId" };
    const prep = await needIndexAndItem(skillId);
    if (!prep.ok) return prep;
    const { s, selected, item } = prep;

    const rec = s.installed.find((i) => i.skillId === skillId);
    if (!rec) return { ok: false, error: "该 skill 尚无安装记录（请直接安装）" };
    const userRoot = await detectUserRoot();
    try {
      const { path, fm } = await updateExisting(ctx, fs, shell, fullPolicy, userRoot, item);
      rec.version = item.version;
      rec.sourceRecordId = selected.recordId;
      rec.sha256 = item.download.sha256;
      rec.updatedAt = new Date().toISOString();
      await writeState(fs, await root(), s, fullPolicy);
      return { ok: true, data: { path, description: fm.description, whenToUse: fm.whenToUse } };
    } catch (e) {
      return { ok: false, error: "更新失败：" + ((e && e.message) || e) };
    }
  }

  async function uninstall(args) {
    const skillId = args && args.skillId ? String(args.skillId).trim() : "";
    if (!skillId) return { ok: false, error: "缺少 skillId" };
    const s = await state();
    const rec = s.installed.find((i) => i.skillId === skillId);
    if (!rec) return { ok: false, error: "该 skill 无市场安装记录" };
    const userRoot = await detectUserRoot();
    try {
      await uninstallSkill(ctx, fs, shell, fullPolicy, userRoot, skillId);
      s.installed = s.installed.filter((i) => i.skillId !== skillId);
      await writeState(fs, await root(), s, fullPolicy);
      return { ok: true, data: null };
    } catch (e) {
      return { ok: false, error: "卸载失败：" + ((e && e.message) || e) };
    }
  }

  return {
    "market.sources": sources,
    "market.selectSource": selectSource,
    "market.addSource": addSource,
    "market.removeSource": removeSource,
    "market.list": list,
    "market.install": install,
    "market.update": update,
    "market.uninstall": uninstall
  };
}