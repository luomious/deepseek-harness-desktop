import { lookup } from 'node:dns/promises';
import net from 'node:net';

const BING_SEARCH_URL = 'https://www.bing.com/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

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

async function assertPublicUrl(url) {
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
    const url = `${BING_SEARCH_URL}?q=${encodeURIComponent(query)}&count=10&setlang=zh-hans`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal,
    });
    if (!response.ok) throw new Error(`Bing search failed (HTTP ${response.status})`);
    const html = await response.text();
    const sources = parseBing(html);
    if (sources.length === 0) {
      throw new Error('Bing returned no parseable results (the page structure may have changed)');
    }
    return { sources, truncated: false };
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

    let redirects = 0;
    let response;
    for (;;) {
      await assertPublicUrl(url);
      response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.arrayBuffer().catch(() => null);
        if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
        const location = response.headers.get('location');
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

    const statusCode = response.status;
    const contentType = response.headers.get('content-type') ?? '';
    let kind = 'text';
    let content;
    if (contentType.includes('text/html')) {
      kind = 'html';
      content = await response.text();
    } else if (/text\/|json|xml|javascript/.test(contentType)) {
      kind = 'text';
      content = await response.text();
    } else {
      kind = 'text';
      const length = response.headers.get('content-length');
      content = `[binary content: ${contentType}${length === null ? '' : `, ${length} bytes`}]`;
    }
    if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES);
    return { statusCode, url: response.url || url.href, body: { kind, content } };
  }
}

export const name = 'dsh-web-search-bing';
export const inject = ['web'];

export function apply(ctx) {
  ctx.web.registerSearchProvider(new BingSearchProvider());
  ctx.web.registerFetchProvider(new BingFetchProvider());
}