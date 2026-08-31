import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createMarketApi } from "./market/api.js";

export const name = "dsh-skills-manager";

export const inject = ["skills", "fs", "shell", "sandboxPolicy", "webServer", "hostServices"];

const SYSTEM_SOURCES = ["bundled", "runtime", "custom"];

export function apply(ctx) {
  const fullPolicy = ctx.sandboxPolicy.resolve({ mode: "danger-full-access" });
  let userRoot = null;
  let rootResolved = false;
  let layersCache = null;

  async function collectScopes() {
    if (layersCache) return layersCache;
    const layers = [{ scope: undefined, label: "global" }];
    try {
      const ap = ctx.get("agentPresets");
      if (ap && typeof ap.list === "function" && typeof ap.standingKeyFor === "function") {
        const presets = await ap.list();
        for (const p of presets) {
          try {
            const key = await ap.standingKeyFor(p.id);
            layers.push({ scope: key, label: p.id });
          } catch (e) { /* 该 preset 不可挂载则跳过 */ }
        }
      }
    } catch (e) { /* 仅保留全局层 */ }
    layersCache = layers;
    return layers;
  }

  async function collectAll() {
    const layers = await collectScopes();
    const merged = new Map();
    for (const layer of layers) {
      const items = await ctx.skills.list(layer.scope === undefined ? {} : { scope: layer.scope });
      for (const s of items) {
        if (!merged.has(s.name)) merged.set(s.name, summary(s));
      }
    }
    return { layers, items: [...merged.values()] };
  }

  async function detectUserRoot() {
    if (!rootResolved) {
      rootResolved = true;
      try {
        const { items } = await collectAll();
        const hit = items.find((i) => (i.source === "user-dsh" || i.source === "user-agents") && i.resourcePath);
        if (hit) userRoot = String(hit.resourcePath).replace(/[\\/][^\\/]+$/, "");
      } catch (e) { userRoot = null; }
      // 2026-09-01 修复：用纯 JS 替代 bash printf（PowerShell 不支持 printf 语法）
      if (userRoot === null) {
        try {
          const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
          if (home) userRoot = home + "/skills";
        } catch (e) { userRoot = null; }
      }
    }
    return userRoot;
  }

  function yamlScalar(v) {
    const s = String(v == null ? "" : v).replace(/\r?\n/g, " ").trim();
    if (s.length === 0) return '""';
    if (!/[:#]/.test(s) && !/^[\s\-?:,.[\]{}#&*!|>'"%@`]/.test(s)) return s;
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function buildFile(skillName, description, whenToUse, enabled, content) {
    const lines = ["---", "name: " + yamlScalar(skillName), "description: " + yamlScalar(description)];
    if (whenToUse && String(whenToUse).trim()) lines.push("whenToUse: " + yamlScalar(whenToUse));
    if (!enabled) {
      lines.push("disable-model-invocation: true");
      lines.push("user-invocable: false");
    }
    lines.push("---", "");
    let body = String(content == null ? "" : content);
    if (!body.endsWith("\n")) body += "\n";
    return lines.join("\n") + body;
  }

  function summary(s) {
    return {
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse != null ? s.whenToUse : null,
      source: s.source,
      provider: s.provider,
      modelInvocable: !s.invocation || s.invocation.modelInvocable !== false,
      userInvocable: !s.invocation || s.invocation.userInvocable !== false,
      resourcePath: s.resourceBase && s.resourceBase.kind === "directory" ? s.resourceBase.path : null
    };
  }

  function isSystem(source) { return SYSTEM_SOURCES.indexOf(source) !== -1; }

  async function findSkill(skillName) {
    const layers = await collectScopes();
    for (const layer of layers) {
      const d = await ctx.skills.get(String(skillName), layer.scope === undefined ? {} : { scope: layer.scope });
      if (d) return d;
    }
    return undefined;
  }

  function fail(e) { return { ok: false, error: String((e && e.message) || e) }; }
  function settle() { return new Promise((r) => setTimeout(r, 300)); }

  async function handle(method, args) {
    try {
      if (method === "list") {
        const { layers, items } = await collectAll();
        return {
          ok: true,
          data: {
            system: items.filter((i) => isSystem(i.source)),
            user: items.filter((i) => !isSystem(i.source)),
            userRoot: await detectUserRoot(),
            debug: { layers: layers.map((l) => l.label), total: items.length }
          }
        };
      }
      if (method === "get") {
        const skillName = args && args.name ? String(args.name) : "";
        const d = await findSkill(skillName);
        if (!d) return { ok: true, data: null };
        return {
          ok: true,
          data: {
            name: d.name,
            description: d.description,
            whenToUse: d.whenToUse != null ? d.whenToUse : null,
            source: d.source,
            provider: d.provider,
            modelInvocable: !d.invocation || d.invocation.modelInvocable !== false,
            userInvocable: !d.invocation || d.invocation.userInvocable !== false,
            path: d.path != null ? d.path : null,
            content: d.content
          }
        };
      }
      if (method === "create") {
        const skillName = String(args && args.name ? args.name : "").trim();
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) return { ok: false, error: "名称必须为 kebab-case（小写字母/数字，连字符分隔）" };
        const description = String(args && args.description ? args.description : "").trim();
        if (!description) return { ok: false, error: "描述不能为空" };
        const whenToUse = args && args.whenToUse ? String(args.whenToUse).trim() : "";
        const content = String(args && args.content != null ? args.content : "");
        const root = await detectUserRoot();
        if (!root) return { ok: false, error: "无法定位用户 skills 根目录（~/.dsh/skills）" };
        const { items } = await collectAll();
        if (items.some((i) => i.name === skillName)) return { ok: false, error: "同名 skill 已存在：" + skillName };
        const dir = root + "/" + skillName;
        // 无需 mkdir：ctx.fs.writeText 原子写自动创建父目录（Windows PowerShell 的 mkdir 不幂等，弃用 shell）
        const target = await ctx.fs.resolve(dir + "/SKILL.md");
        await ctx.fs.writeText(target, buildFile(skillName, description, whenToUse, true, content), undefined, undefined, fullPolicy);
        await settle();
        return { ok: true, data: { path: dir + "/SKILL.md" } };
      }
      if (method === "update") {
        const skillName = args && args.name ? String(args.name) : "";
        const d = await findSkill(skillName);
        if (!d) return { ok: false, error: "skill 不存在：" + skillName };
        if (d.source !== "user-dsh") return { ok: false, error: "仅用户级（~/.dsh/skills）skill 可操作：" + skillName };
        const description = String(args && args.description ? args.description : "").trim();
        if (!description) return { ok: false, error: "描述不能为空" };
        const whenToUse = args && args.whenToUse ? String(args.whenToUse).trim() : "";
        const content = String(args && args.content != null ? args.content : "");
        const enabled = !d.invocation || (d.invocation.modelInvocable !== false && d.invocation.userInvocable !== false);
        if (!d.path) return { ok: false, error: "无法定位 skill 文件" };
        const target = await ctx.fs.resolve(d.path);
        await ctx.fs.writeText(target, buildFile(skillName, description, whenToUse, enabled, content), undefined, undefined, fullPolicy);
        await settle();
        return { ok: true, data: { path: d.path } };
      }
      if (method === "setEnabled") {
        const skillName = args && args.name ? String(args.name) : "";
        const enabled = !!(args && args.enabled);
        const d = await findSkill(skillName);
        if (!d) return { ok: false, error: "skill 不存在：" + skillName };
        if (d.source !== "user-dsh") return { ok: false, error: "仅用户级（~/.dsh/skills）skill 可操作：" + skillName };
        if (!d.path) return { ok: false, error: "无法定位 skill 文件" };
        const target = await ctx.fs.resolve(d.path);
        await ctx.fs.writeText(target, buildFile(d.name, d.description, d.whenToUse || "", enabled, d.content), undefined, undefined, fullPolicy);
        await settle();
        return { ok: true, data: { path: d.path } };
      }
      if (method === "delete") {
        const skillName = args && args.name ? String(args.name) : "";
        const d = await findSkill(skillName);
        if (!d) return { ok: false, error: "skill 不存在：" + skillName };
        if (d.source !== "user-dsh") return { ok: false, error: "仅用户级（~/.dsh/skills）skill 可操作：" + skillName };
        if (!d.path) return { ok: false, error: "无法定位 skill 文件" };
        const target = d.path.replace(/\/SKILL\.md$/, "");
        // 越界防护：目标必须以用户 skills 根目录开头，且不允许包含 .. 段，
        // 防止恶意注册的 path（如含 ../../）把删除引到 userRoot 之外
        const root = await detectUserRoot();
        const targetNorm = target.replace(/[\\/]+$/, "");
        if (!root || !targetNorm.startsWith(root)) {
          return { ok: false, error: "拒绝删除越界路径：" + targetNorm };
        }
        if (targetNorm.split(/[\\/]/).includes("..")) {
          return { ok: false, error: "拒绝删除含 .. 的路径：" + targetNorm };
        }
        // 用 node:fs 而非 ctx.shell（Windows PowerShell 的 rm -rf 语法不兼容）
        fs.rmSync(targetNorm, { recursive: true, force: true });
        await settle();
        return { ok: true, data: null };
      }
      // 导入文件夹：扫描 path（或其一层子目录）中的 SKILL.md，原样复制到用户 skills 根目录
      // 2026-08-31 修复：遍历/读取改用 node:fs（跨平台）——ctx.shell 在 Windows 为 pwsh，find/cat 不可用
      if (method === "importFolder") {
        const folder = args && args.path ? String(args.path).trim() : "";
        if (!folder) return { ok: false, error: "请提供要导入的文件夹路径" };
        const root = await detectUserRoot();
        if (!root) return { ok: false, error: "无法定位用户 skills 根目录（~/.dsh/skills）" };
        let files = [];
        try {
          const stat = fs.statSync(folder);
          if (!stat.isDirectory()) return { ok: false, error: "路径不是文件夹：" + folder };
          const direct = path.join(folder, "SKILL.md");
          if (fs.existsSync(direct)) files.push(direct);
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const nested = path.join(folder, entry.name, "SKILL.md");
              if (fs.existsSync(nested)) files.push(nested);
            }
          }
        } catch (e) {
          return { ok: false, error: "无法读取文件夹：" + String((e && e.message) || e) };
        }
        if (files.length === 0) return { ok: false, error: "未找到 SKILL.md（文件夹或其一层子目录内）" };
        const { items } = await collectAll();
        const imported = [], skipped = [], errors = [];
        for (const file of files) {
          try {
            const text = fs.readFileSync(file, "utf8");
            const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
            const fmName = fm ? /(?:^|\n)name:\s*["']?([a-z0-9]+(-[a-z0-9]+)*)["']?/.exec(fm[1]) : null;
            let name = fmName ? fmName[1] : null;
            if (!name) {
              const dir = path.basename(path.dirname(file));
              if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(dir)) name = dir;
            }
            if (!name) { errors.push(file + ": 无法解析 name（需 kebab-case）"); continue; }
            if (items.some((i) => i.name === name)) { skipped.push(name + "（已存在）"); continue; }
            const dir2 = path.join(root, name);
            fs.mkdirSync(dir2, { recursive: true });
            await ctx.fs.writeText(await ctx.fs.resolve(path.join(dir2, "SKILL.md")), text, undefined, undefined, fullPolicy);
            imported.push(name);
          } catch (e) {
            errors.push(file + ": " + String((e && e.message) || e));
          }
        }
        await settle();
        return { ok: true, data: { imported, skipped, errors } };
      }
      // 市场 API（静态目录源 + 校验安装），实现见 lib/market/*
      if (method.startsWith("market.")) {
        const marketApi = getMarketApi();
        const fn = marketApi[method];
        if (typeof fn !== "function") return { ok: false, error: "未知方法：" + method };
        return await fn(args || {});
      }
      return { ok: false, error: "未知方法：" + method };
    } catch (e) {
      return fail(e);
    }
  }

  // 惰性创建市场 API（依赖 web 服务，缺省可用时 market 调用会返回明确错误，不影响本地管理）
  let marketApiCache = null;
  function getMarketApi() {
    if (!marketApiCache) {
      marketApiCache = createMarketApi(ctx, {
        fs: ctx.fs,
        shell: ctx.shell,
        sandboxPolicy: ctx.sandboxPolicy,
        detectUserRoot,
        collectAll
      });
    }
    return marketApiCache;
  }

  const hs = ctx.hostServices;
  if (!hs || typeof hs.registerLocalApi !== "function") {
    try { ctx.logger?.warn?.("[skills-manager] host-services 未加载，跳过本地 API 注册"); } catch { /* ignore */ }
    return;
  }
  hs.registerLocalApi(ctx, {
    path: "/skmg",
    handler: async (_req, _res, body) => {
      const method = body && body.method ? String(body.method) : "";
      return await handle(method, body && body.args);
    },
  });
}
