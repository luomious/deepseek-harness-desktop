// src/lib/plugin-catalog.js
// 插件目录数据层：从 npm registry 搜索 DSH 插件（keywords:dsh-plugin），
// 归一化字段 + 人气/近期排序 + 内存缓存(TTL) + 优雅降级。
//
// 设计约束（与全局安全策略一致）：
// - 网络请求只在主进程发生；渲染层 CSP default-src 'none'，通过 IPC 取结果。
// - 目录数据来自远程、不可信：本层只做字段归一化，不信任任何字段类型；
//   展示层负责 esc() 转义，安装层负责 validateArg('pkg') 白名单二次拦截。
// - 任何失败都返回 { ok:false, items:[] } 或 { ok:true, items:[] }，绝不向上抛异常。
// - 全依赖注入（fetchJson/errorLog/logger/ttlMs），裸 node 可单测。

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB 响应上限，防超大响应撑爆内存
const MAX_ITEMS = 250;                     // npm 搜索 size 上限（接口侧亦有限制）
const DEFAULT_KEYWORD = 'keywords:dsh-plugin';

function createPluginCatalog(options = {}) {
  const fetchJson = options.fetchJson || defaultFetchJson;
  const errorLog = options.errorLog; // { log(code, ev) } 可选（诊断中心）
  const logger = options.logger || (() => {});
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const cache = new Map(); // key -> { at, value }

  /** 记录目录拉取失败（错误码 PLG-004，日志即手册）；失败不影响主流程 */
  function logError(msg) {
    try { logger('[DSH Desktop] plugin-catalog: ' + msg); } catch (e) {}
    if (errorLog) {
      try { errorLog.log('PLG-004', { module: 'plugin-catalog', msg: String(msg), ctx: {} }); } catch (e) {}
    }
  }

  /** 把 npm 搜索的原始对象归一化成稳定的插件条目；字段全部做类型守卫 */
  function normalize(item) {
    try {
      const p = (item && item.package) || {};
      const name = p.name;
      if (typeof name !== 'string' || !name) return null;
      const score = (item && item.score) || {};
      const detail = score.detail || {};
      const popularity =
        typeof score.final === 'number' ? score.final :
        (typeof detail.popularity === 'number' ? detail.popularity : null);
      const links = p.links || {};
      return {
        name,
        version: typeof p.version === 'string' ? p.version : '',
        description: typeof p.description === 'string' ? p.description : '',
        date: typeof p.date === 'string' ? p.date : '',
        repository: typeof links.repository === 'string' ? links.repository : '',
        homepage: typeof links.homepage === 'string' ? links.homepage : '',
        popularity,
      };
    } catch (e) {
      return null;
    }
  }

  /** 排序：popularity（人气降序）/ recent（更新时间降序）；默认保持接口相关度顺序 */
  function sortItems(items, sort) {
    const arr = items.slice();
    if (sort === 'popularity') {
      arr.sort((a, b) => (b.popularity == null ? -1 : b.popularity) - (a.popularity == null ? -1 : a.popularity));
    } else if (sort === 'recent') {
      arr.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    }
    return arr;
  }

  /** 构造 npm 搜索文本：始终叠加 dsh-plugin 关键词；查询串截断防超长 */
  function buildText(query) {
    const q = (typeof query === 'string' ? query : '').trim();
    const text = q ? `${DEFAULT_KEYWORD} ${q}` : DEFAULT_KEYWORD;
    return text.slice(0, 200);
  }

  /** 请求 npm 搜索接口并归一化；任何异常返回 []（不抛） */
  async function _search(text, size) {
    const capped = Math.max(1, Math.min(Number(size) || 50, MAX_ITEMS));
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${capped}`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.objects)) return [];
    return data.objects.map(normalize).filter(Boolean);
  }

  /**
   * 浏览插件目录。
   * 返回 { ok, items, cached, stale?, source }；ok=false 表示拉取失败（items=[]，error 描述）。
   * 有旧缓存时网络失败自动降级为旧缓存（stale=true）。
   */
  async function browse({ query = '', size = 100, sort = 'popularity' } = {}) {
    const q = (typeof query === 'string' ? query : '').trim();
    const capped = Math.max(1, Math.min(Number(size) || 100, MAX_ITEMS));
    const key = `browse:${q}:${capped}:${sort}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      return { ok: true, items: hit.value, cached: true, source: 'cache' };
    }
    try {
      // 先按 sort 排序，再截断到 capped，保证「人气前 N」语义正确
      const items = sortItems(await _search(buildText(q), capped), sort).slice(0, capped);
      // 只缓存非空结果：空结果可能是网络瞬时失败/无匹配，不缓存以便下次重试
      if (items.length > 0) cache.set(key, { at: Date.now(), value: items });
      return { ok: true, items, cached: false, source: 'npm' };
    } catch (e) {
      logError('browse failed: ' + ((e && e.message) || e));
      if (hit) {
        return { ok: true, items: hit.value, cached: true, stale: true, source: 'cache' };
      }
      return { ok: false, items: [], error: '无法连接 npm 仓库，请检查网络后重试', source: null };
    }
  }

  /** 热点插件：人气降序的前 size 个 */
  function trending({ size = 20 } = {}) {
    return browse({ query: '', size, sort: 'popularity' });
  }

  /** 推荐：优先按用户需求 query（零 LLM 依赖），否则按已装插件做规则版推荐 */
  async function recommend(installedNames, { size = 5, query = '' } = {}) {
    const { items } = await browse({ query: '', size: 100, sort: 'popularity' });
    if (typeof query === 'string' && query.trim()) {
      return recommendByQuery(query, items, { size });
    }
    return recommendByRule(Array.isArray(installedNames) ? installedNames : [], items, { size });
  }

  return { browse, trending, recommend };
}

/** 常见中文需求词 → 英文 token 映射（让中文需求描述也能匹配英文插件名） */
const ZH_EN = {
  '搜索': 'search', '检索': 'search', '网页': 'web', '网络': 'web', '联网': 'web', '在线': 'web',
  '记忆': 'memory', '记住': 'memory', '长期记忆': 'memory', '会话': 'session', '历史': 'history',
  '主题': 'theme', '皮肤': 'skin', '换肤': 'skin', '美化': 'theme', '背景': 'background',
  '通知': 'notify', '提醒': 'notify', '语音': 'voice', '声音': 'voice', '朗读': 'tts',
  '图片': 'image', '图像': 'image', '看图': 'vision', '视觉': 'vision', '识图': 'vision',
  '文件': 'file', '终端': 'terminal', '模型': 'model', '路由': 'router', '浏览器': 'browser',
  '翻译': 'translate', '音乐': 'music', '定时': 'cron', '计划': 'plan', '任务': 'task',
};

/** 把插件名/描述拆成语义 token：去 @scope/ 与 dsh- 前缀，按 - _ . 分词，小写去重，过滤停用词 */
function tokenize(name) {
  const s = String(name == null ? '' : name)
    .replace(/^@[^/]+\//, '')
    .replace(/^dsh-/, '')
    .toLowerCase();
  const stop = new Set(['plugin', 'dsh', 'the', 'and', 'for', 'with', 'this', 'that', 'of', 'to']);
  const seen = new Set();
  const out = [];
  for (const t of s.split(/[\s\-_.]+/)) {
    if (!t || t.length < 3 || stop.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 通用关键词打分（纯函数，可单测）：
 * - 统计每个目录条目的 name+description token 与参考 token 的重合数作为得分；
 * - 得分>0 的按「得分降序 → 人气降序」排序，取前 size；
 * - exclude 用于排除（如已装插件）。
 */
function scoreByTokens(refTokens, catalogItems, { size = 5, exclude = null } = {}) {
  if (!(refTokens instanceof Set) || refTokens.size === 0) return [];
  const excludeSet = exclude instanceof Set ? exclude : new Set();
  const scored = [];
  for (const item of Array.isArray(catalogItems) ? catalogItems : []) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    if (excludeSet.has(item.name)) continue;
    const itemTokens = new Set();
    for (const t of tokenize(item.name)) itemTokens.add(t);
    for (const t of tokenize(item.description)) itemTokens.add(t);
    let score = 0;
    for (const t of itemTokens) if (refTokens.has(t)) score++;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) =>
    (b.score - a.score) ||
    ((b.item.popularity == null ? -1 : b.item.popularity) - (a.item.popularity == null ? -1 : a.item.popularity))
  );
  return scored.slice(0, Math.max(0, Number(size) || 5)).map((s) => s.item);
}

/** 规则版推荐：基于已装插件名的 token 集合，推荐未安装的同类别插件 */
function recommendByRule(installedNames, catalogItems, { size = 5 } = {}) {
  const installed = Array.isArray(installedNames) ? installedNames.map((n) => String(n)) : [];
  const installedTokens = new Set();
  for (const n of installed) for (const t of tokenize(n)) installedTokens.add(t);
  if (installedTokens.size === 0) return [];
  return scoreByTokens(installedTokens, catalogItems, { size, exclude: new Set(installed) });
}

/** 需求式推荐：基于用户需求描述的关键词推荐（零 LLM 依赖，不调外部 API、不消耗额度） */
function recommendByQuery(query, catalogItems, { size = 5 } = {}) {
  let q = String(query == null ? '' : query);
  for (const [zh, en] of Object.entries(ZH_EN)) {
    q = q.split(zh).join(' ' + en + ' ');
  }
  return scoreByTokens(new Set(tokenize(q)), catalogItems, { size });
}

/**
 * 默认 HTTPS JSON 拉取实现（生产用）。与 update-check.js 同款模式：
 * - 重定向最多 5 次，且只跟随 HTTPS（拒绝降级到 http 防 MITM）
 * - 15s 超时 + 响应体 2MB 上限 + JSON 解析守卫
 * - 任何失败 resolve(null)，不 reject（调用方据此降级）
 */
function defaultFetchJson(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let redirects = 0;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const request = (u) => {
      if (redirects > 5) { done(null); return; }
      const mod = u.startsWith('https') ? require('https') : require('http');
      let req;
      try {
        req = mod.get(u, (res) => {
          // 重定向：只跟 HTTPS
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            redirects++;
            try {
              const next = new URL(res.headers.location, u);
              if (next.protocol !== 'https:') { done(null); return; }
              request(next.href);
            } catch (e) { done(null); }
            return;
          }
          if (res.statusCode !== 200) { res.resume(); done(null); return; }
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > MAX_RESPONSE_BYTES) { req.destroy(); done(null); }
          });
          res.on('end', () => {
            try { done(JSON.parse(data)); } catch (e) { done(null); }
          });
        });
      } catch (e) { done(null); return; }
      req.on('error', () => done(null));
      req.setTimeout(timeoutMs, () => { req.destroy(); done(null); });
    };

    request(url);
  });
}

module.exports = { createPluginCatalog, defaultFetchJson, scoreByTokens, recommendByRule, recommendByQuery, tokenize, DEFAULT_KEYWORD, MAX_ITEMS, MAX_RESPONSE_BYTES };
