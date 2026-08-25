import { lookup } from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

const USER_AGENT = 'deepseek-harness/0.0.1';
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

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
    if (v.startsWith('fec') || v.startsWith('fed') || v.startsWith('fee') || v.startsWith('fef')) return true; // site-local fec0::/10
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
 * Resolve every A/AAAA record and reject the target if ANY is private.
 * @returns the resolved public address list for IP-direct connection.
 */
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
 * P1-D1: connect DIRECTLY to a resolved (already validated) public IP, keeping
 * the original hostname in the Host header and TLS servername. The validation
 * and the connection share ONE DNS resolution, closing the DNS-rebinding TOCTOU
 * window between assertPublicUrl() and the fetch()'s own second resolution.
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

async function requestStream(url, signal) {
  const ips = await resolvePublicRecords(url);
  let lastError = null;
  for (const ip of ips) {
    try {
      return await requestViaIp(
        url.protocol,
        url.hostname,
        url.port,
        ip,
        { 'user-agent': USER_AGENT, 'accept': 'text/html,text/plain,application/json,*/*' },
        signal
      );
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`no reachable address for ${url.hostname}`);
}

/** 单次跟随后的重定向地址复查。 */
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

/** 流式收集响应体并在超过上限时立即截断(W2: 不再整读后截断,防内存耗尽)。 */
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
    // 默认超时(W3: 防 slowloris 无限挂起;调用方 signal 与本地超时叠加)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('request timed out')), DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    try {
      let redirects = 0;
      let res;
      for (;;) {
        res = await requestStream(url, combined);
        // 重定向：每跳对新地址重新解析+复查(同样单次解析直连),防公网→内网 302 绕过
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
          const next = resolveRedirect(url, res.headers.location);
          if (!next) throw new Error(`unsupported redirect target from ${url.href}`);
          url = next;
          redirects++;
          continue;
        }
        break;
      }
      const { buf, truncated } = await collectBody(res);
      const content = buf.subarray(0, MAX_BYTES).toString('utf8');
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      const kind = ct.includes('html') || ct.includes('text') || content.includes('<html') ? 'html' : 'text';
      return {
        url: url.href,
        statusCode: res.statusCode ?? 0,
        body: { kind, content },
        truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const name = 'dsh-web-fetch-local';
export const inject = ['web'];

export function apply(ctx) {
  ctx.web.registerFetchProvider(new LocalFetchProvider());
}