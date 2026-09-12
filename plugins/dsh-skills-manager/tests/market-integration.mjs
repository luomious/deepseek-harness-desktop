// market 集成冒烟 —— 用内存 fake ctx 跑通 添加源 → 选择 → 列表 → 安装 → 更新 → 卸载 全链路。
// 运行: node tests/market-integration.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMarketApi } from "../lib/market/api.js";

const ROOT = "C:/Users/tester/.dsh/skills";

// ---- 内存 fake fs/shell/web/ctx ----
const files = new Map(); // path -> content

const fsStub = {
  async resolve(p) { return String(p); },
  async readText(p) {
    if (!files.has(p)) throw new Error("ENOENT " + p);
    return files.get(p);
  },
  async writeText(p, c) { files.set(p, c); return {}; }
};

let maybeFailMv = false;
const shellStub = {
  resolve(spec) { return spec; },
  async run(spec) {
    const cmd = spec.command;
    if (cmd.startsWith("mkdir")) return { exitCode: 0 };
    if (cmd.startsWith("mv")) {
      if (maybeFailMv) { maybeFailMv = false; return { exitCode: 1 }; }
      const [from, to] = extractMvPaths(cmd);
      if (files.has(from)) files.set(to, files.get(from));
      return { exitCode: 0 };
    }
    if (cmd.startsWith("rm -f") || cmd.startsWith("rm -rf")) {
      const p = extractRmPath(cmd);
      for (const k of [...files.keys()]) {
        if (k === p || k.startsWith(p + "/") || k.startsWith(p + "\\")) files.delete(k);
      }
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  }
};

function extractMvPaths(cmd) {
  const m = cmd.match(/mv -f -- '([^']+)' '([^']+)'/);
  return m ? [unq(m[1]), unq(m[2])] : ["", ""];
}
function extractRmPath(cmd) {
  const m = cmd.match(/rm -f -- '([^']+)'|rm -rf -- '([^']+)'/);
  const p = m ? (m[1] || m[2]) : "";
  return unq(p);
}
function unq(s) { return s.replace(/'/g, "").replace(/'\\''/g, "'"); }

// host 端 ctx.web 返回 provider 形状：{statusCode, body:{kind, content}, truncated}
const webContent = new Map();
const webStub = {
  async fetch(request) {
    const url = String(request.url);
    if (!webContent.has(url)) {
      return { statusCode: 404, body: { kind: "text", content: "not found" }, truncated: false };
    }
    return { statusCode: 200, body: { kind: "text", content: webContent.get(url) }, truncated: false };
  }
};
const ctxStub = {
  get(key) { return key === "web" ? webStub : undefined; }
};
const sandboxPolicyStub = { resolve: () => ({ mode: "danger-full-access" }) };
const detectUserRoot = async () => ROOT;
const collectAll = async () => ({ items: [] });

const api = createMarketApi(ctxStub, {
  fs: fsStub,
  shell: shellStub,
  sandboxPolicy: sandboxPolicyStub,
  detectUserRoot,
  collectAll
});

// ---- 测试数据 ----
const ORIGIN = "https://skills.example.com";
const manifestUrl = ORIGIN + "/manifest.json";
const manifest = JSON.stringify({
  manifestVersion: "1.0.0",
  providerId: "smoke-index",
  name: "Smoke Index",
  transport: { kind: "https-json", endpoint: ORIGIN + "/skills-index.json" }
});
webContent.set(manifestUrl, manifest);

const SKILL_V1 = `---
name: smoke-skill
description: A smoke test skill
---
# Smoke Skill
v1 body
`;
const SKILL_V2 = `---
name: smoke-skill
description: A smoke test skill v2
---
# Smoke Skill
v2 body
`;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const index = (version, body) => JSON.stringify({
  schemaVersion: "1.0.0",
  items: [{
    id: "smoke-skill",
    description: "A smoke test skill",
    categories: ["utility"],
    version,
    author: { name: "tester", url: "https://skills.example.com/u/tester" },
    download: { url: ORIGIN + "/skills/smoke-skill/SKILL.md", sha256: sha(body) }
  }]
});
webContent.set(ORIGIN + "/skills-index.json", index("1.0.0", SKILL_V1));
webContent.set(ORIGIN + "/skills/smoke-skill/SKILL.md", SKILL_V1);

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("PASS  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + " → " + e.message); }
}

// ---- 流程 ----
t("market.sources 初始为空", async () => {
  const r = await api["market.sources"]();
  assert.equal(r.ok, true);
  assert.equal(r.data.sources.length, 0);
});
t("market.addSource 添加并选中", async () => {
  const r = await api["market.addSource"]({ manifestUrl });
  assert.equal(r.ok, true);
  await api["market.selectSource"]({ recordId: r.data.recordId });
  const s = await api["market.sources"]();
  assert.equal(s.data.sources.filter((x) => x.selected).length, 1);
});
t("market.list 拉取索引并缓存", async () => {
  const r = await api["market.list"]({});
  assert.equal(r.ok, true);
  assert.equal(r.data.items.length, 1);
  assert.equal(r.data.items[0].id, "smoke-skill");
  assert.equal(r.data.cacheStatus, "fresh");
});
t("market.list 二次命中缓存", async () => {
  const r = await api["market.list"]({});
  assert.equal(r.ok, true);
  assert.equal(r.data.cacheStatus, "cached");
});
t("market.install 安装成功且落盘", async () => {
  const r = await api["market.install"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true);
  assert.ok(files.has(ROOT + "/smoke-skill/SKILL.md"));
  const s = await api["market.sources"]();
  assert.equal(s.data.installed.length, 1);
  assert.equal(s.data.installed[0].version, "1.0.0");
});
t("market.update 升级到 1.1.0", async () => {
  webContent.set(ORIGIN + "/skills-index.json", index("1.1.0", SKILL_V2));
  webContent.set(ORIGIN + "/skills/smoke-skill/SKILL.md", SKILL_V2);
  const r = await api["market.update"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true);
  assert.ok(files.get(ROOT + "/smoke-skill/SKILL.md").includes("v2 body"));
  const s = await api["market.sources"]();
  assert.equal(s.data.installed[0].version, "1.1.0");
});
t("market.update 失败自动回滚", async () => {
  webContent.set(ORIGIN + "/skills-index.json", index("1.2.0", SKILL_V2));
  webContent.set(ORIGIN + "/skills/smoke-skill/SKILL.md", SKILL_V2);
  maybeFailMv = true; // 让第二次 mv 失败，触发回滚路径
  const r = await api["market.update"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, false);
  // 回滚后仍是 1.1.0 的内容
  assert.ok(files.has(ROOT + "/smoke-skill/SKILL.md"));
  const s = await api["market.sources"]();
  assert.equal(s.data.installed[0].version, "1.1.0");
});
t("market.uninstall 卸载删除目录", async () => {
  const r = await api["market.uninstall"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true);
  assert.ok(!files.has(ROOT + "/smoke-skill/SKILL.md"));
  const s = await api["market.sources"]();
  assert.equal(s.data.installed.length, 0);
});
t("SHA-256 不匹配拒绝安装", async () => {
  // 篡改下载内容 → 校验失败
  webContent.set(ORIGIN + "/skills-index.json", index("1.0.0", SKILL_V1));
  webContent.set(ORIGIN + "/skills/smoke-skill/SKILL.md", SKILL_V1 + "\ntampered");
  const r = await api["market.install"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("SHA-256"));
  assert.ok(!files.has(ROOT + "/smoke-skill/SKILL.md"));
});

// ---- 新增：跨渠道同名冲突治理（单一事实源，锁行为防回归）----
const localCollectAll = async () => ({ items: [{ name: "smoke-skill", source: "user-dsh" }] });
const localApi = createMarketApi(ctxStub, {
  fs: fsStub,
  shell: shellStub,
  sandboxPolicy: sandboxPolicyStub,
  detectUserRoot,
  collectAll: localCollectAll,
});

t("market.list 标注本地已存在(localExists)", async () => {
  const r = await localApi["market.list"]({});
  assert.equal(r.ok, true);
  assert.equal(r.data.items[0].localExists, true);
  assert.equal(r.data.items[0].localSource, "user-dsh");
});

t("market.install 拒绝本地已存在同名(非市场渠道)", async () => {
  const r = await localApi["market.install"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("本地已存在"), "应提示本地已存在: " + r.error);
});

// ---- 新增：接管（adopt）本地已存在 skill —— 只写台账、不动文件 ----
function clearMarketFiles() {
  for (const k of [...files.keys()]) {
    if (k.includes("/.skills-market/") || k === ROOT + "/smoke-skill/SKILL.md") files.delete(k);
  }
}
async function freshLocalApi(items) {
  clearMarketFiles();
  const api2 = createMarketApi(ctxStub, {
    fs: fsStub,
    shell: shellStub,
    sandboxPolicy: sandboxPolicyStub,
    detectUserRoot,
    collectAll: async () => ({ items }),
  });
  const a = await api2["market.addSource"]({ manifestUrl });
  assert.equal(a.ok, true, "addSource: " + a.error);
  await api2["market.selectSource"]({ recordId: a.data.recordId });
  return api2;
}
const LOCAL_ITEM = { name: "smoke-skill", source: "user-dsh", resourcePath: ROOT + "/smoke-skill" };

t("market.adopt 接管本地同名（内容与目录一致）", async () => {
  webContent.set(ORIGIN + "/skills-index.json", index("1.0.0", SKILL_V1));
  webContent.set(ORIGIN + "/skills/smoke-skill/SKILL.md", SKILL_V1);
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V1);
  const api2 = await freshLocalApi([LOCAL_ITEM]);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true, String(r.error));
  assert.equal(r.data.contentMatches, true);
  assert.equal(r.data.version, "1.0.0");
  assert.equal(files.get(ROOT + "/smoke-skill/SKILL.md"), SKILL_V1, "接管不得改动本地文件");
  const s = await api2["market.sources"]();
  assert.equal(s.data.installed.length, 1);
  assert.equal(s.data.installed[0].adopted, true);
  assert.equal(s.data.installed[0].contentMatches, true);
});

t("market.adopt 内容不一致 → version=null 且标记待对齐", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V2);
  const api2 = await freshLocalApi([LOCAL_ITEM]);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true, String(r.error));
  assert.equal(r.data.contentMatches, false);
  assert.equal(r.data.version, null);
  assert.equal(r.data.catalogVersion, "1.0.0");
  const l = await api2["market.list"]({});
  assert.equal(l.data.items[0].installedAdopted, true);
  assert.equal(l.data.items[0].installedContentMatches, false);
});

t("market.adopt 拒绝 hub 清单记录且内容未改动", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V1);
  files.set(ROOT + "/.hub-install-manifest.json",
    JSON.stringify({ skills: { "smoke-skill": { hash: sha(SKILL_V1) } } }));
  const api2 = await freshLocalApi([LOCAL_ITEM]);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("hub"), "应提示 hub 完整性: " + r.error);
  const s = await api2["market.sources"]();
  assert.equal(s.data.installed.length, 0, "拒绝时不得写台账");
});

t("market.list 标注 hubManaged；hub 记录但内容已改动 → 允许接管", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V2); // 内容已改，hub 哈希不再匹配
  files.set(ROOT + "/.hub-install-manifest.json",
    JSON.stringify({ skills: { "smoke-skill": { hash: sha(SKILL_V1) } } }));
  const api2 = await freshLocalApi([LOCAL_ITEM]);
  const l = await api2["market.list"]({});
  assert.equal(l.data.items[0].hubManaged, true);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true, String(r.error));
});

t("market.adopt 拒绝非 user-dsh 来源", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V1);
  const api2 = await freshLocalApi([
    { name: "smoke-skill", source: "project-dsh", resourcePath: "D:/proj/.dsh/skills/smoke-skill" },
  ]);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("无法接管"), "应说明来源限制: " + r.error);
});

t("market.adopt 拒绝本地不存在（提示直接安装）", async () => {
  const api2 = await freshLocalApi([]);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("安装"), "应提示直接安装: " + r.error);
});

t("market.update 覆盖前备份本地原文（并把台账升到目录版本）", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V1);
  const api2 = await freshLocalApi([LOCAL_ITEM]);
  const a = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(a.ok, true, String(a.error));
  files.set(ROOT + "/smoke-skill/SKILL.md", "# locally edited by user\n");
  const r = await api2["market.update"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true, String(r.error));
  const backups = [...files.keys()].filter((k) => k.includes("/.skills-market/backups/smoke-skill/"));
  assert.equal(backups.length, 1, "应恰好写 1 个备份：" + JSON.stringify(backups));
  assert.equal(files.get(backups[0]), "# locally edited by user\n", "备份内容必须是覆盖前的原文");
  assert.equal(files.get(ROOT + "/smoke-skill/SKILL.md"), SKILL_V1, "目标已更新为目录内容");
});

// ---- 新增（T5）：本地「有意改造」（SL-9 屏蔽）与破坏性动作护栏 ----
const SLIMMED_ITEM = { ...LOCAL_ITEM, modelInvocable: false };

t("market.adopt 记录本地改造标记 localModelInvocable=false", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V1);
  const api2 = await freshLocalApi([SLIMMED_ITEM]);
  const r = await api2["market.adopt"]({ skillId: "smoke-skill" });
  assert.equal(r.ok, true, String(r.error));
  assert.equal(r.data.localModelInvocable, false);
  const s = await api2["market.sources"]();
  assert.equal(s.data.installed[0].localModelInvocable, false);
  const l = await api2["market.list"]({});
  assert.equal(l.data.items[0].localModelInvocable, false);
});

t("market.update 对「本地已屏蔽」需显式确认（服务端 fail-closed）", async () => {
  files.set(ROOT + "/smoke-skill/SKILL.md", SKILL_V1);
  const api2 = await freshLocalApi([SLIMMED_ITEM]);
  await api2["market.adopt"]({ skillId: "smoke-skill" });
  const denied = await api2["market.update"]({ skillId: "smoke-skill" });
  assert.equal(denied.ok, false, "未确认时必须拒绝");
  assert.equal(denied.code, "LOCAL_MODIFIED");
  assert.ok(String(denied.error).includes("disable-model-invocation"), String(denied.error));
  const ok = await api2["market.update"]({ skillId: "smoke-skill", confirmLocalMods: true });
  assert.equal(ok.ok, true, String(ok.error));
});

t("uninstallSkill 删除前整目录备份（真实 FS：~/.dsh 下删除是永久的）", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } =
    await import("node:fs");
  const { join } = await import("node:path");
  const { uninstallSkill } = await import("../lib/market/install.js");
  const tmp = mkdtempSync(join(process.cwd(), "_tmp-uninstall-"));
  try {
    const skillsRoot = join(tmp, "skills");
    const marketRoot = join(tmp, "market");
    const dir = join(skillsRoot, "probe-skill");
    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: probe-skill\ndescription: probe\n---\nbody\n");
    writeFileSync(join(dir, "templates", "x.html"), "<p>kept</p>");
    const realFsStub = {
      async resolve(p) { return p; },
      async readText(p) { return readFileSync(p, "utf8"); },
      async writeText(p, c) { writeFileSync(p, c); },
    };
    const res = await uninstallSkill({}, realFsStub, shellStub, sandboxPolicyStub.resolve({}),
      skillsRoot, "probe-skill", marketRoot);
    assert.equal(existsSync(dir), false, "删除后原目录应消失");
    assert.ok(res.backup && existsSync(join(res.backup, "SKILL.md")), "备份应含 SKILL.md：" + res.backup);
    assert.ok(existsSync(join(res.backup, "templates", "x.html")), "备份应保留子目录结构");
    assert.equal(res.files, 2, "应备份 2 个文件，实际 " + res.files);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);