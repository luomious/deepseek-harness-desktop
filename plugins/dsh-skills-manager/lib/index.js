export const name = "dsh-skills-manager";

export const inject = ["skills", "fs", "shell", "sandboxPolicy", "webServer"];

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
      if (userRoot === null) {
        try {
          const spec = ctx.shell.resolve({ command: "printf '%s' \"${DSH_HOME:-$HOME/.dsh}\"", timeoutMs: 5000 });
          const res = await ctx.shell.run(spec);
          if (res.exitCode === 0 && res.stdout && res.stdout.text) {
            const home = res.stdout.text.trim();
            if (home) userRoot = home + "/skills";
          }
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
  function q(p) { return String(p).replace(/'/g, "'\\''"); }
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
        const mk = ctx.shell.resolve({ command: "mkdir -p -- '" + q(root) + "' '" + q(dir) + "'", timeoutMs: 5000, sandboxPolicy: fullPolicy });
        const mkRes = await ctx.shell.run(mk);
        if (mkRes.exitCode !== 0) return { ok: false, error: "创建目录失败（exit " + mkRes.exitCode + "）" };
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
        const spec = ctx.shell.resolve({ command: "rm -rf -- '" + q(target) + "'", timeoutMs: 5000, sandboxPolicy: fullPolicy });
        const res = await ctx.shell.run(spec);
        if (res.exitCode !== 0) return { ok: false, error: "删除失败（exit " + res.exitCode + "）" };
        await settle();
        return { ok: true, data: null };
      }
      return { ok: false, error: "未知方法：" + method };
    } catch (e) {
      return fail(e);
    }
  }

  /** 本地主机名校验（统一实现，兼容 [::1] 方括号形式）。 */
  function isLocalHostname(h) {
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  }

  /**
   * 校验本地 HTTP 请求可信度（与 file-explorer / remote-workspace 保持同一实现）。
   * 1. 对端必须为回环地址；
   * 2. Host 必须为本地主机名（统一用 URL 解析，兼容 [::1]:3080）；
   * 3. Origin 必须存在且为本地源 —— 浏览器跨站 POST 的 Origin 是攻击者站点，直接拒绝；
   *    缺失 Origin 的请求（curl/脚本）同样拒绝（现代浏览器同源 POST 必带 Origin）；
   * 4. Sec-Fetch-Site 若存在则必须为 same-origin（纵深防御）。
   */
  function trusted(req) {
    try {
      const addr = req && req.socket && req.socket.remoteAddress;
      if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
      const rawHost = String((req.headers && req.headers.host) || "");
      let hostname;
      try { hostname = new URL("http://" + rawHost).hostname; } catch { return false; }
      if (!isLocalHostname(hostname)) return false;
      const origin = String((req.headers && req.headers.origin) || "");
      if (!origin) return false;
      let o;
      try { o = new URL(origin); } catch { return false; }
      if (o.protocol !== "http:") return false;
      if (!isLocalHostname(o.hostname)) return false;
      // Origin 端口须与请求 Host 端口一致(同源);桌面版端口不固定(43120 等),不再硬编码 3080
      let hostPort = "";
      try { hostPort = String(new URL("http://" + rawHost).port || ""); } catch { return false; }
      if (o.port && hostPort && o.port !== hostPort) return false;
      const sfs = String((req.headers && req.headers["sec-fetch-site"]) || "").toLowerCase();
      if (sfs && sfs !== "same-origin") return false;
      return true;
    } catch { return false; }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/skmg",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (!trusted(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "拒绝非本机请求" }));
        return;
      }
      let body = "";
      try {
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64 * 1024) {
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "请求体过大（> 64KB）" }));
            return;
          }
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "请求读取失败" }));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "请求体不是合法 JSON" }));
        return;
      }
      const result = await handle(payload && payload.method ? String(payload.method) : "", payload && payload.args);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    }
  }), "dsh-skills-manager: /skmg/ api route");
}
