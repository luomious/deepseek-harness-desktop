// 回归测试：插件目录数据层（src/lib/plugin-catalog.js）
// 覆盖：正常归一化、人气/近期排序、缓存命中、旧缓存降级、异常过滤、
//       网络异常降级为空、fetchJson reject 不向上抛、size 上限、查询编码、trending。
// 全依赖注入（fetchJson/logger/ttlMs），裸 node 可跑，不触发真实网络。

const { createPluginCatalog, recommendByRule, recommendByQuery, MAX_ITEMS } = require('../src/lib/plugin-catalog.js');

let pass = 0, fail = 0;
function t(name, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK', name); }
  else { fail++; console.log('  FAIL', name, '-> got', JSON.stringify(actual), 'expected', JSON.stringify(expected)); }
}

function fakeSearchResult(names) {
  return {
    objects: names.map((n, i) => ({
      package: {
        name: n,
        version: '1.0.' + i,
        description: 'desc ' + n,
        date: '2026-08-1' + i + 'T00:00:00Z',
        links: { repository: 'https://github.com/x/' + n, homepage: 'https://x/' + n },
      },
      score: { final: 0.1 * (i + 1), detail: { popularity: 0.1 * (i + 1) } },
    })),
  };
}

(async () => {
  console.log('== browse: 正常归一化 + 人气排序 ==');
  {
    const seen = [];
    const cat = createPluginCatalog({
      fetchJson: async (url) => { seen.push(url); return fakeSearchResult(['a-plugin', 'b-plugin', 'c-plugin']); },
      logger: () => {},
    });
    const r = await cat.browse({});
    t('ok=true', r.ok, true);
    t('items 数量', r.items.length, 3);
    t('人气降序第一个是 c-plugin', r.items[0].name, 'c-plugin');
    t('版本归一化', r.items[0].version, '1.0.2');
    t('url 含 dsh-plugin 关键词', decodeURIComponent(seen[0]).includes('keywords:dsh-plugin'), true);
    t('source=npm', r.source, 'npm');
    t('cached=false', r.cached, false);
  }

  console.log('== browse: fetchJson 返回 null（网络失败）→ 降级为空列表，不抛 ==');
  {
    const cat = createPluginCatalog({ fetchJson: async () => null, logger: () => {} });
    let threw = false, r;
    try { r = await cat.browse({}); } catch (e) { threw = true; }
    t('不向上抛', threw, false);
    t('ok=true（空结果，非崩溃）', r.ok, true);
    t('items=[]', r.items.length, 0);
  }

  console.log('== browse: fetchJson reject → 被捕获，ok=false，不抛 ==');
  {
    const cat = createPluginCatalog({ fetchJson: async () => { throw new Error('boom'); }, logger: () => {} });
    let threw = false, r;
    try { r = await cat.browse({}); } catch (e) { threw = true; }
    t('reject 不向上抛', threw, false);
    t('reject ok=false', r.ok, false);
    t('reject 有 error 文案', typeof r.error, 'string');
  }

  console.log('== 缓存命中：第二次不重复请求 ==');
  {
    let count = 0;
    const cat = createPluginCatalog({ fetchJson: async () => { count++; return fakeSearchResult(['x']); }, logger: () => {}, ttlMs: 60000 });
    await cat.browse({});
    const r2 = await cat.browse({});
    t('第二次 cached=true', r2.cached, true);
    t('只请求了一次', count, 1);
  }

  console.log('== 旧缓存降级：请求失败时回退旧缓存 ==');
  {
    let failNow = false;
    const cat = createPluginCatalog({
      fetchJson: async () => { if (failNow) throw new Error('net down'); return fakeSearchResult(['cached-plugin']); },
      logger: () => {},
      ttlMs: 0, // 让缓存立即过期，第二次走「请求失败 → 回退旧缓存」分支
    });
    await cat.browse({});
    failNow = true;
    const r = await cat.browse({});
    t('降级 ok=true', r.ok, true);
    t('降级 stale=true', r.stale, true);
    t('降级 source=cache', r.source, 'cache');
    t('降级返回旧缓存内容', r.items[0].name, 'cached-plugin');
  }

  console.log('== 异常条目过滤 + 字段类型守卫 ==');
  {
    const bad = { objects: [
      { package: { name: 'ok-one', version: '1.0.0' }, score: { final: 0.5 } },
      { package: { name: 123 } }, // 非字符串 name → 过滤
      { package: { name: 'ok-two', description: 42, version: 7 } }, // 非字符串字段 → 归一化为 ''
      null,
      'garbage',
    ]};
    const cat = createPluginCatalog({ fetchJson: async () => bad, logger: () => {} });
    const r = await cat.browse({ sort: 'popularity' });
    t('过滤后数量', r.items.length, 2);
    t('description 非字符串归一化为空', r.items.find((i) => i.name === 'ok-two').description, '');
    t('version 非字符串归一化为空', r.items.find((i) => i.name === 'ok-two').version, '');
  }

  console.log('== recent 排序 ==');
  {
    const data = { objects: [
      { package: { name: 'old', date: '2026-01-01T00:00:00Z' }, score: {} },
      { package: { name: 'new', date: '2026-08-20T00:00:00Z' }, score: {} },
    ]};
    const cat = createPluginCatalog({ fetchJson: async () => data, logger: () => {} });
    const r = await cat.browse({ sort: 'recent' });
    t('recent 第一个是 new', r.items[0].name, 'new');
  }

  console.log('== size 上限 + 查询串 URL 编码 ==');
  {
    const seen = [];
    const cat = createPluginCatalog({ fetchJson: async (url) => { seen.push(url); return fakeSearchResult([]); }, logger: () => {} });
    await cat.browse({ query: 'web search & more', size: 9999 });
    t('size 被限制到 MAX_ITEMS', seen[0].includes('size=' + MAX_ITEMS), true);
    t('查询串被 URL 编码', seen[0].includes(encodeURIComponent('web search & more')), true);
  }

  console.log('== trending: 人气降序前 N 个 ==');
  {
    const cat = createPluginCatalog({ fetchJson: async () => fakeSearchResult(['low', 'mid', 'high']), logger: () => {}, ttlMs: 60000 });
    const r = await cat.trending({ size: 2 });
    t('trending 数量', r.items.length, 2);
    t('trending 第一 high', r.items[0].name, 'high');
  }

  console.log('== recommendByRule: 规则版推荐 ==');
  function rec(name, desc, popularity) {
    return { name, description: desc || '', popularity: popularity == null ? null : popularity, version: '1.0.0', date: '', repository: '', homepage: '' };
  }
  {
    const catalog = [
      rec('dsh-web-fetch-local', 'web fetch for dsh', 0.8),
      rec('dsh-web-search-pro', 'web search pro', 0.9),
      rec('dsh-memory', 'long term memory', 0.7),
      rec('dsh-web-search-bing', 'bing web search', 0.5),
    ];
    const r = recommendByRule(['dsh-web-search-bing'], catalog, { size: 5 });
    t('推荐数量（排除已装+无匹配）', r.length, 2);
    t('推荐第一 web-search-pro', r[0].name, 'dsh-web-search-pro');
    t('推荐第二 web-fetch-local', r[1].name, 'dsh-web-fetch-local');
  }
  {
    const r = recommendByRule([], [rec('x-web-y', 'web')], { size: 5 });
    t('空 installed 返回空', r.length, 0);
  }
  {
    const r = recommendByRule(['dsh-memory'], [rec('dsh-theme', 'theme skin')], { size: 5 });
    t('无匹配返回空', r.length, 0);
  }
  {
    const catalog = [rec('a-web-1', 'web', 0.1), rec('a-web-2', 'web', 0.2), rec('a-web-3', 'web', 0.3)];
    const r = recommendByRule(['dsh-web-x'], catalog, { size: 2 });
    t('size 限制为 2', r.length, 2);
  }
  {
    const r = recommendByRule(['dsh-web-x'], [null, 'garbage', { name: 123 }, rec('a-web-ok', 'web', 0.5)], { size: 5 });
    t('非法条目过滤', r.length, 1);
  }

  console.log('== recommendByQuery: 需求式推荐 ==');
  {
    const catalog = [
      rec('dsh-web-fetch-local', 'web fetch', 0.8),
      rec('dsh-web-search-pro', 'web search pro', 0.9),
      rec('dsh-memory', 'memory', 0.7),
    ];
    const r = recommendByQuery('web search', catalog, { size: 5 });
    t('英文需求命中', r.length, 2);
    t('英文需求第一 search-pro', r[0].name, 'dsh-web-search-pro');
  }
  {
    const catalog = [
      rec('dsh-web-search', 'web search', 0.9),
      rec('dsh-memory', 'memory', 0.7),
    ];
    const r = recommendByQuery('能搜索网页', catalog, { size: 5 });
    t('中文需求命中（映射）', r.length, 1);
    t('中文需求返回 web-search', r[0].name, 'dsh-web-search');
  }
  {
    const r = recommendByQuery('', [rec('dsh-web', 'web')], { size: 5 });
    t('空需求返回空', r.length, 0);
  }
  {
    const r = recommendByQuery('xyz', [rec('dsh-web', 'web')], { size: 5 });
    t('无匹配需求返回空', r.length, 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
