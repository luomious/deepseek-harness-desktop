// market/fetch.js — 复用宿主 ctx.web 受限 HTTP 信道下载目录 JSON / SKILL.md。
// 不自行实现网络层（避免重复造轮子）：SSRF、大小、超时、重定向全部由 provider 负责。

import { INDEX_MAX_BYTES } from "./state.js";

/**
 * 经 ctx.web.fetch 拉取一个 HTTPS URL 的文本内容。
 * @returns {Promise<string>}
 */
export async function fetchText(ctx, url) {
  const web = ctx.get("web");
  if (!web || typeof web.fetch !== "function") {
    throw new Error("web 服务不可用（缺少 fetch provider）");
  }
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("仅支持 HTTPS 源");
  if (u.username || u.password) throw new Error("URL 不得携带凭证");

  const res = await web.fetch({ url: u.href });
  if (!res || typeof res.statusCode !== "number") {
    throw new Error("fetch 无有效响应");
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error("HTTP " + res.statusCode + " 获取失败");
  }
  if (res.truncated) {
    throw new Error("响应超过大小上限，已截断");
  }
  const content = res.body && typeof res.body.content === "string" ? res.body.content : "";
  if (!content || !content.trim()) throw new Error("响应为空");

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > INDEX_MAX_BYTES) {
    throw new Error("响应超过 " + (INDEX_MAX_BYTES / 1024) + " KiB 上限");
  }
  return content;
}

/** 校验一个 URL 与索引 endpoint 是否同源（v1 安全模型：下载必须同源）。 */
export function assertSameOrigin(endpoint, url) {
  let a, b;
  try {
    a = new URL(endpoint);
    b = new URL(url);
  } catch (e) {
    throw new Error("URL 无法解析");
  }
  if (a.origin !== b.origin) {
    throw new Error("下载地址必须与索引源同源：" + b.origin + " ≠ " + a.origin);
  }
}