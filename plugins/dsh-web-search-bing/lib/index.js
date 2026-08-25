import { lookup } from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const BING_SEARCH_URL = 'https://www.bing.com/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

/** 与 dsh-web-fetch-local 同源的 SSRF 地址校验（内联复制，避免跨包依赖）。 */
function isPrivateAddress(ip) {
  if (!net.isIP(ip)) return true;
  if (ip.includes(':')) {
    if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(ip)) {
      return isPrivateAddress(ip.slice('::ffff:'.length));
    }
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    if (v.startsWith('fec') || v.startsWith('fed') || v.startsWith('fee') || v.startsWith('fef')) return true;
    if (v.startsWith('2001:db8')) return true;
    if (v.startsWith('64:ff9b')) return true;
    if (v.startsWith('ff')) return true;
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p[0] === 0) return true;
  if (p[0] === 10) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] >= 224) return true;
  return false;
}

async function resolvePublicRecords(url) {
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`blocked private-network target: ${host}`);
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`blocked: no address records for ${host}`);
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(`blocked private-network target: ${host} -> ${address}`);
    }
  }
  return records.map((r) => r.address);
}

/**
 * P1-D1: 连接与校验共用同一次解析(IP 直连,Host/servername 保留原域名),
 * 消除 DNS rebinding TOCTOU(与 dsh-web-fetch-local 同款修复)。
 */
function requestViaIp(proto, host, port, ip, headers, signal) {
  const mod = proto === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        host: ip,
        port: port || (proto === 'https:' ? 443 : 80),
        servername: proto === 'https:' ? host : undefined,
        method: 'GET',
        headers: { ...headers, Host: `${host}${port ? ':' + port : ''}` },
        signal,
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    req.end();
  });
}

async function requestStream(url, signal, headers) {
  const ips = await resolvePublicRecords(url);
  let lastError = null;
  for (const ip of ips) {
    try {
      return await requestViaIp(url.protocol, url.hostname, url.port, ip, headers, signal);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`no reachable address for ${url.hostname}`);
}

/** 流式收集响应体,超过上限立即截断。 */
async function collectBody(res) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      truncated = true;
      res.destroy();
      break;
    }
    chunks.push(chunk);
  }
  return { buf: Buffer.concat(chunks), truncated };
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&#\d+;/g, '');
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, '');
}

function parseBing(html) {
  const sources = [];
  const parts = html.split('<li class="b_algo"');
  for (let i = 1; i < parts.length && sources.length < 10; i++) {
    const block = parts[i];
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (link === null) continue;
    const url = decodeHtml(link[1]);
    const title = decodeHtml(stripTags(link[2])).trim();
    if (url === '' || title === '') continue;
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const snippet = snippetMatch === null ? '' : decodeHtml(stripTags(snippetMatch[1])).trim();
    sources.push({ url, title, ...(snippet === '' ? {} : { snippet }) });
  }
  return sources;
}

class BingSearchProvider {
  id = 'bing';

  available() {
    return true;
  }

  async search(request, signal) {
    const query = String(request.query ?? '').trim();
    if (query === '') throw new Error('bing search needs a non-empty query');
    const url = new URL(`${BING_SEARCH_URL}?q=${encodeURIComponent(query)}&count=10&setlang=zh-hans`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('request timed out')), DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      const res = await requestStream(
        url,
        combined,
        { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        throw new Error(`Bing search failed (HTTP ${res.statusCode})`);
      }
      const { buf, truncated } = await collectBody(res);
      const html = buf.toString('utf8');
      const sources = parseBing(html);
      if (sources.length === 0) {
        throw new Error('Bing returned no parseable results (the page structure may have changed)');
      }
      return { sources, truncated };
    } finally {
      clearTimeout(timer);
    }
  }
}

class BingFetchProvider {
  id = 'bing-fetch';

  available() {
    return true;
  }

  async fetch(request, signal) {
    const urlStr = String(request.url ?? '').trim();
    if (urlStr === '') throw new Error('bing-fetch needs a non-empty url');
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      throw new Error('bing-fetch needs a valid url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${url.protocol}`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('request timed out')), DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      let redirects = 0;
      let res;
      for (;;) {
        res = await requestStream(
          url,
          combined,
          { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
        );
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
          const location = res.headers.location;
          if (!location) break;
          let next;
          try {
            next = new URL(location, url);
          } catch (e) {
            break;
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') break;
          url = next;
          redirects++;
          continue;
        }
        break;
      }

      const statusCode = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      const { buf, truncated } = await collectBody(res);
      const text = buf.toString('utf8');
      let kind = 'text';
      let content;
      if (contentType.includes('text/html')) {
        kind = 'html';
        content = text;
      } else if (/text\/|json|xml|javascript/.test(contentType)) {
        kind = 'text';
        content = text;
      } else {
        kind = 'text';
        const length = res.headers['content-length'];
        content = `[binary content: ${contentType}${length === undefined ? '' : `, ${length} bytes`}]`;
      }
      if (truncated) content = content.slice(0, MAX_BYTES);
      return { statusCode, url: url.href, body: { kind, content }, truncated };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const name = 'dsh-web-search-bing';
export const inject = ['web'];

export function apply(ctx) {
  ctx.web.registerSearchProvider(new BingSearchProvider());
  ctx.web.registerFetchProvider(new BingFetchProvider());
}