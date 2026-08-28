// market grep -- 冒烟测试（纯函数层，不依赖 ctx/web/fs）
// 运行: node tests/market-smoke.mjs
import assert from "node:assert/strict";
import {
  validateManifest, validateIndex, parseSkillFrontmatter, sha256Hex
} from "../lib/market/validate.js";
import { safeSkillDir } from "../lib/market/install.js";

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("PASS  " + name); }
  catch (e) { failed++; console.error("FAIL  " + name + " → " + e.message); }
}
function throwsMsg(fn, contained) {
  try { fn(); assert.fail("expected throw"); }
  catch (e) { assert.ok(String(e.message).includes(contained), "expected msg with '" + contained + "', got: " + e.message); }
}

// ---- validateManifest ----
t("manifest 合法通过", () => {
  const m = validateManifest(JSON.stringify({
    manifestVersion: "1.0.0",
    providerId: "demo",
    name: "Demo",
    transport: { kind: "https-json", endpoint: "https://demo.example.com/v1/index.json" }
  }), "https://demo.example.com/manifest.json");
  assert.equal(m.providerId, "demo");
  assert.equal(m.endpoint, "https://demo.example.com/v1/index.json");
});
t("manifest 拒绝 http", () => throwsMsg(
  () => validateManifest('{"manifestVersion":"1.0.0","providerId":"a","name":"a","transport":{"kind":"https-json","endpoint":"http://x/y"}}', "https://a.example.com/m.json"),
  "HTTPS"));
t("manifest 拒绝跨源 endpoint", () => throwsMsg(
  () => validateManifest('{"manifestVersion":"1.0.0","providerId":"a","name":"a","transport":{"kind":"https-json","endpoint":"https://other.com/y"}}', "https://a.example.com/m.json"),
  "同源"));
t("manifest 拒绝自选中声明", () => throwsMsg(
  () => validateManifest('{"manifestVersion":"1.0.0","providerId":"a","name":"a","selected":true,"transport":{"kind":"https-json","endpoint":"https://a.example.com/y"}}', "https://a.example.com/m.json"),
  "默认"));
t("manifest 拒绝未知版本", () => throwsMsg(
  () => validateManifest('{"manifestVersion":"2.0.0","providerId":"a","name":"a","transport":{"kind":"https-json","endpoint":"https://a.example.com/y"}}', "https://a.example.com/m.json"),
  "manifestVersion"));

// ---- validateIndex ----
const idx = (items) => JSON.stringify({ schemaVersion: "1.0.0", items });
const goodItem = {
  id: "my-skill", description: "does things", version: "1.0.0",
  categories: ["utility"],
  download: { url: "https://demo.example.com/skills/my-skill/SKILL.md", sha256: "a".repeat(64) }
};
t("索引合法通过", () => {
  const r = validateIndex(idx([goodItem]), "https://demo.example.com/v1/index.json");
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, "my-skill");
});
t("索引拒绝重复 id", () => throwsMsg(
  () => validateIndex(idx([goodItem, { ...goodItem }]), "https://demo.example.com/v1/index.json"), "重复"));
t("索引拒绝坏 sha256", () => throwsMsg(
  () => validateIndex(idx([{ ...goodItem, download: { ...goodItem.download, sha256: "xyz" } }]), "https://demo.example.com/v1/index.json"), "sha256"));
t("索引拒绝跨源下载", () => throwsMsg(
  () => validateIndex(idx([{ ...goodItem, download: { ...goodItem.download, url: "https://evil.com/f" } }]), "https://demo.example.com/v1/index.json"), "同源"));
t("索引拒绝大写 id", () => throwsMsg(
  () => validateIndex(idx([{ ...goodItem, id: "Bad-Name" }]), "https://demo.example.com/v1/index.json"), "id"));
t("索引拒绝坏版本号", () => throwsMsg(
  () => validateIndex(idx([{ ...goodItem, version: "latest" }]), "https://demo.example.com/v1/index.json"), "版本"));

// ---- parseSkillFrontmatter ----
const SKILL = `---
name: my-skill
description: A clear description
whenToUse: when you need it
---
# My Skill
content here
`;
t("frontmatter 合法通过", () => {
  const fm = parseSkillFrontmatter(SKILL, "my-skill");
  assert.equal(fm.name, "my-skill");
  assert.equal(fm.description, "A clear description");
  assert.equal(fm.whenToUse, "when you need it");
});
t("frontmatter name 不匹配拒绝", () => throwsMsg(
  () => parseSkillFrontmatter(SKILL, "other-skill"), "不一致"));
t("frontmatter 缺失拒绝", () => throwsMsg(
  () => parseSkillFrontmatter("# no frontmatter", "my-skill"), "frontmatter"));
t("frontmatter 缺 description 拒绝", () => throwsMsg(
  () => parseSkillFrontmatter("---\nname: my-skill\n---\nbody", "my-skill"), "description"));

// ---- sha256 ----
t("sha256 正确", () => {
  assert.equal(
    sha256Hex("hello"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

// ---- safeSkillDir（路径白名单）----
t("合法目录通过", () => {
  assert.equal(safeSkillDir("C:/Users/x/.dsh/skills", "my-skill"), "C:/Users/x/.dsh/skills/my-skill");
});
t("非法名拒绝", () => throwsMsg(() => safeSkillDir("C:/Users/x/.dsh/skills", "Bad_Name"), "名称"));
t("跨层名拒绝", () => throwsMsg(() => safeSkillDir("C:/Users/x/.dsh/skills", "a/../../etc"), "名称"));
t("路径穿越目录拒绝", () => throwsMsg(() => safeSkillDir("C:/Users/x/.dsh/skills", "a/.."), "名称"));
t("userRoot 含 .. 拒绝", () => throwsMsg(() => safeSkillDir("C:/Users/x/.dsh/../skills", "b"), "越界"));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);