// market/api.js — 市场业务 API（sources / list / install / update / uninstall）。
// 无默认选中源、显式选择、来源可见、浏览 ≠ 授权、失败关闭、绝不自动回退。

import { fetchText } from "./fetch.js";
import { validateManifest, validateIndex, parseSkillFrontmatter, sha256Hex } from "./validate.js";
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
    // 目录无需预建：writeCache/writeState 走 ctx.fs.writeText（dsh-atomic-write），自动创建父目录。
    return cacheRoot;
  }
  async function state() {
    return root().then((r) => readState(fs, r));
  }

  // 本地 hub 安装清单（<userRoot>/.hub-install-manifest.json，由 tools/dsh-skills-hub 写入）。
  // 只用于「治理可见性」：hub 记录的 skill 带 SHA-256，市场不得静默覆盖
  // （AGENTS.md：勿改 hub 安装的 skill）。清单缺失/损坏 → 视为无记录，绝不影响市场功能。
  async function hubHashes() {
    try {
      const userRoot = await detectUserRoot();
      if (!userRoot) return new Map();
      const file = await fs.resolve(userRoot + "/.hub-install-manifest.json");
      const j = JSON.parse(await fs.readText(file));
      const m = new Map();
      for (const [k, v] of Object.entries((j && j.skills) || {})) {
        const h = v && typeof v.hash === "string" ? v.hash.toLowerCase() : "";
        if (h) m.set(k, h);
      }
      return m;
    } catch (e) {
      return new Map();
    }
  }

  function uid() {
    return "rec-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // 参数归一：兼容字符串与 { key: value } 两种调用形式（client bundle 曾传对象）
  function arg(v, key) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object" && key && v[key] != null) return String(v[key]);
    return String(v);
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
          sourceRecordId: i.sourceRecordId, sha256: i.sha256, installedAt: i.installedAt,
          // T3（2026-09-11）：区分「市场安装」与「接管本地已有」。version 仅在内容与目录
          // 一致时才有确定值；contentMatches=false 表示本地内容与目录版本不同（可「更新」对齐）。
          adopted: !!i.adopted,
          contentMatches: i.adopted ? i.contentMatches !== false : null,
          catalogVersion: i.catalogVersion || null,
          // T5（2026-09-11）：本地是否「有意改造」。false = 本地带 disable-model-invocation:true
          // （SL-9 catalog 瘦身标记）→ UI 必须警示「更新会覆盖该改造」，且服务端会要求显式确认。
          localModelInvocable: i.localModelInvocable !== false
        }))
      }
    };
  }

  async function selectSource(recordId) {
    const id = arg(recordId, "recordId");
    const s = await state();
    const found = s.sources.find((r) => r.recordId === id);
    if (!found) return { ok: false, error: "源不存在：" + id };
    for (const r of s.sources) r.selected = r.recordId === id;
    await writeState(fs, await root(), s, fullPolicy);
    return { ok: true, data: { recordId: id } };
  }

  async function addSource(manifestUrl) {
    const url = String(arg(manifestUrl, "manifestUrl") || "").trim();
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
    const id = arg(recordId, "recordId");
    const s = await state();
    const next = s.sources.filter((r) => r.recordId !== id);
    if (next.length === s.sources.length) return { ok: false, error: "源不存在：" + id };
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
    // 标注已安装（市场台账）与本地已存在（全盘扫描、跨渠道），
    // 使 UI 的安装/更新/卸载与磁盘真相一致，杜绝"显示可装、点了报同名已存在"。
    const installedSet = new Map(s.installed.map((i) => [i.skillId, i]));
    const { items: localItems } = await collectAll();
    const localMap = new Map(localItems.map((x) => [x.name, x]));
    const hub = await hubHashes();
    items = items.map((i) => ({
      ...i,
      installed: installedSet.has(i.id),
      installedVersion: installedSet.has(i.id) ? installedSet.get(i.id).version : null,
      installedAdopted: installedSet.has(i.id) ? !!installedSet.get(i.id).adopted : false,
      installedContentMatches: installedSet.has(i.id) && installedSet.get(i.id).adopted
        ? installedSet.get(i.id).contentMatches !== false
        : null,
      installedCatalogVersion: installedSet.has(i.id) ? (installedSet.get(i.id).catalogVersion || null) : null,
      localExists: localMap.has(i.id),
      localSource: localMap.has(i.id) ? (localMap.get(i.id).source || null) : null,
      // T5：本地是否被「有意改造」（false = 带 disable-model-invocation:true，SL-9 catalog 瘦身标记）。
      // 取自 collectAll 的 summary.modelInvocable —— 零额外读盘，UI 与更新护栏都读它。
      localModelInvocable: localMap.has(i.id) ? localMap.get(i.id).modelInvocable !== false : null,
      // hub 管理的 skill：市场不接管（保持 hub 的 SHA-256 记录有效），UI 只展示状态
      hubManaged: hub.has(i.id)
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

    // 单一事实源：先查市场台账，再查本地全盘（跨渠道），避免"显示可装、点了报错"的漂移。
    const marketRec = s.installed.find((i) => i.skillId === skillId);
    if (marketRec) {
      return { ok: false, error: "该 skill 已在市场安装（v" + marketRec.version + "），请使用「更新」" };
    }
    const { items: all } = await collectAll();
    const local = all.find((x) => x.name === skillId);
    if (local) {
      return {
        ok: false,
        error: "本地已存在同名 skill（来源：" + (local.source || "未知") +
          "，非市场渠道）。市场不会覆盖它，以免污染现有内容；如需改由市场管理，请先在「Skills 管理器」卸载同名本地 skill 后再安装。"
      };
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

  /**
   * 接管（adopt）：把「本地已存在、但市场没有台账」的同名 skill 登记进市场台账。
   *
   * 为什么需要：两条安装通道（本地 hub 直装 / 市场安装）都写同一个目录 ~/.dsh/skills，
   * 于是出现「本地有、市场无记录」的第三态 —— 既不能「更新」也不能被市场「卸载」，
   * UI 只能显示"已存在"。接管把这类 skill 纳入台账，使更新/卸载链路可用。
   *
   * 安全边界（全部 fail-closed，任一条不满足即拒绝，且**不写入任何文件**）：
   *   1. 本地必须存在同名 skill（否则提示直接「安装」）
   *   2. 只接管来源 user-dsh（~/.dsh/skills）的 skill —— 市场只能管理该根下的目录
   *   3. 本地 SKILL.md 必须可读且 frontmatter 合法（name 与目录名一致）
   *   4. hub 清单记录且内容未改动（哈希一致）→ 拒绝：避免市场「更新」破坏 hub 的
   *      SHA-256 完整性记录（AGENTS.md：勿改 hub 安装的 skill）
   * 落库语义：sha256 = **本地实际内容哈希**；version 仅在内容与目录一致时有确定值；
   * contentMatches=false 表示与目录版本不同（UI 提示可「更新」对齐）。
   * 本操作只写 state.json 台账，**绝不触碰任何 skill 文件**（故零内容风险、可逆）。
   */
  async function adopt(args) {
    const skillId = args && args.skillId ? String(args.skillId).trim() : "";
    if (!skillId) return { ok: false, error: "缺少 skillId" };
    const prep = await needIndexAndItem(skillId);
    if (!prep.ok) return prep;
    const { s, selected, item } = prep;

    const marketRec = s.installed.find((i) => i.skillId === skillId);
    if (marketRec) {
      return { ok: false, error: "该 skill 已有市场记录（v" + (marketRec.version || "未知") + "），无需接管" };
    }

    const { items: all } = await collectAll();
    const local = all.find((x) => x.name === skillId);
    if (!local) return { ok: false, error: "本地不存在该 skill，请直接「安装」" };
    if (local.source !== "user-dsh") {
      return {
        ok: false,
        error: "该 skill 来自 " + (local.source || "未知") +
          "（非用户级 ~/.dsh/skills）。市场只能管理用户级 skill，无法接管。"
      };
    }

    const userRoot = await detectUserRoot();
    const dirPath = local.resourcePath || (userRoot ? userRoot + "/" + skillId : null);
    if (!dirPath) return { ok: false, error: "无法定位本地 skill 目录，拒绝接管" };

    let content;
    try {
      content = await fs.readText(await fs.resolve(String(dirPath).replace(/[\\/]+$/, "") + "/SKILL.md"));
    } catch (e) {
      return { ok: false, error: "读取本地 skill 失败：" + ((e && e.message) || e) };
    }
    try {
      parseSkillFrontmatter(content, skillId);
    } catch (e) {
      return { ok: false, error: "本地 skill 不合法，拒绝接管：" + e.message };
    }

    const localSha = sha256Hex(content);
    const hub = await hubHashes();
    if (hub.get(skillId) === localSha) {
      return {
        ok: false,
        error: "该 skill 由本地 hub 安装且内容未改动（hub 清单记录 SHA-256）。市场不接管，" +
          "以免破坏 hub 的完整性校验；如需市场管理，请先在「Skills 管理器」卸载后从市场重新安装。"
      };
    }

    const contentMatches = localSha === item.download.sha256;
    const now = new Date().toISOString();
    s.installed.push({
      skillId,
      name: skillId,
      version: contentMatches ? item.version : null,
      catalogVersion: item.version,
      sourceRecordId: selected.recordId,
      sha256: localSha,
      adopted: true,
      contentMatches,
      // T5：记录本地是否为「有意改造」（SL-9 的 disable-model-invocation:true）。
      // 取自 collectAll 的 summary.modelInvocable，无需额外读盘。
      localModelInvocable: local.modelInvocable !== false,
      adoptedAt: now,
      installedAt: now
    });
    await writeState(fs, await root(), s, fullPolicy);
    return {
      ok: true,
      data: {
        skillId,
        adopted: true,
        contentMatches,
        version: contentMatches ? item.version : null,
        catalogVersion: item.version,
        localModelInvocable: local.modelInvocable !== false
      }
    };
  }

  /** 本地 skill 的关键标志（取 collectAll 的 summary，不额外读盘）；不存在返回 null。 */
  async function localFlags(skillId) {
    try {
      const { items } = await collectAll();
      const hit = items.find((x) => x.name === skillId);
      if (!hit) return null;
      return {
        modelInvocable: hit.modelInvocable !== false,
        source: hit.source || null,
        resourcePath: hit.resourcePath || null
      };
    } catch (e) {
      return null;
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

    // T5 护栏（**服务端** fail-closed，不依赖 UI 文案）：本地被有意改造（SL-9 的
    // disable-model-invocation:true）时，更新会用目录内容覆盖该改造 —— 模型 catalog 会重新变大，
    // 而「catalog 超 9KB 使锚定率 81%→0%」是本项目实测过的静默降级。故必须显式确认。
    const flags = await localFlags(skillId);
    if (flags && flags.modelInvocable === false && !(args && args.confirmLocalMods === true)) {
      return {
        ok: false,
        code: "LOCAL_MODIFIED",
        error: "本地 skill 带 disable-model-invocation:true（有意屏蔽，SL-9 catalog 瘦身用）；" +
          "更新会覆盖该改造并使模型 catalog 重新变大。确需对齐目录版本请显式确认（confirmLocalMods=true）。"
      };
    }

    const userRoot = await detectUserRoot();
    try {
      const { path, fm } = await updateExisting(ctx, fs, shell, fullPolicy, userRoot, item, await root());
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
      // T5：卸载前**整目录备份**（fail-closed）——`~/.dsh/skills/<id>` 属 safe-delete-shim 的
      // 受保护前缀，删除是永久的、回收站救不回（见 install.js backupSkillDir 注释）。
      const res = await uninstallSkill(ctx, fs, shell, fullPolicy, userRoot, skillId, await root());
      s.installed = s.installed.filter((i) => i.skillId !== skillId);
      await writeState(fs, await root(), s, fullPolicy);
      return { ok: true, data: { backup: (res && res.backup) || null, files: (res && res.files) || 0 } };
    } catch (e) {
      return { ok: false, error: "卸载失败（未删除任何内容）：" + ((e && e.message) || e) };
    }
  }

  return {
    "market.sources": sources,
    "market.selectSource": selectSource,
    "market.addSource": addSource,
    "market.removeSource": removeSource,
    "market.list": list,
    "market.install": install,
    "market.adopt": adopt,
    "market.update": update,
    "market.uninstall": uninstall
  };
}