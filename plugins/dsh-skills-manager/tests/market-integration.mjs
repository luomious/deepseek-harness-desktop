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

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);