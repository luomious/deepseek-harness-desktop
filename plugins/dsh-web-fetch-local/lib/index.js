import { lookup } from 'node:dns/promises';
import net from 'node:net';

const USER_AGENT = 'deepseek-harness/0.0.1';
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

/** True for loopback, private, link-local, CGNAT, multicast, and reserved IPv4/IPv6. */
function isPrivateAddress(ip) {
  if (!net.isIP(ip)) return true;
  if (ip.includes(':')) {
    // IPv4-mapped IPv6 (::ffff:1.2.3.4)：剥离前缀后按 IPv4 规则复检，防绕过
    if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(ip)) {
      return isPrivateAddress(ip.slice('::ffff:'.length));
    }
    const v = ip.toLowerCase();
    // IPv6 保留段：未指定/回环/链路本地/ULA/站点本地/文档/组播/未来用
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;   // ULA fc00::/7
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local fe80::/10
    if (v.startsWith('fec') || v.startsWith('fed') || v.startsWith('fee') || v.startsWith('fef')) return true; // site-local fec0::/10 (deprecated)
    if (v.startsWith('2001:db8')) return true;                    // documentation 2001:db8::/32
    if (v.startsWith('64:ff9b')) return true;                     // NAT64 well-known prefix
    if (v.startsWith('ff')) return true;                          // multicast ff00::/8
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

/**
 * Reject private-network targets before any request is made.
 * 解析全部地址而非仅第一个：任一地址为私网即拒绝，
 * 避免「公网/私网混合 A 记录」或 DNS rebinding 首次解析命中公网的情形。
 */
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

/** 单次跟随后的重定向地址复查（redirect: 'manual' 时 fetch 不会自动跟随）。 */
function resolveRedirect(url, location) {
  if (!location) return null;
  try {
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
    return next;
  } catch (e) {
    return null;
  }
}

class LocalFetchProvider {
  id = 'local-fetch';

  available() {
    return true;
  }

  async fetch(request, signal) {
    let url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${url.protocol}`);
    }

    let redirects = 0;
    let response;
    for (;;) {
      await assertPublicUrl(url);
      response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,text/plain,application/json,*/*',
        },
      });
      // 重定向：每跳重新校验目标地址，防公网 → 内网 302 跳转绕过
      if (response.status >= 300 && response.status < 400) {
        await response.arrayBuffer().catch(() => null);
        if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
        const next = resolveRedirect(url, response.headers.get('location'));
        if (!next) throw new Error(`unsupported redirect target from ${url.href}`);
        url = next;
        redirects++;
        continue;
      }
      break;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const truncated = bytes.length > MAX_BYTES;
    const content = bytes.subarray(0, MAX_BYTES).toString('utf8');
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    const kind = ct.includes('html') || ct.includes('text') || content.includes('<html') ? 'html' : 'text';
    return {
      url: response.url || url.href,
      statusCode: response.status,
      body: { kind, content },
      truncated,
    };
  }
}

export const name = 'dsh-web-fetch-local';
export const inject = ['web'];

export function apply(ctx) {
  ctx.web.registerFetchProvider(new LocalFetchProvider());
}