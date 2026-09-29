/**
 * 注入器 P0 修复的差异对照测试（differential verification）
 *
 * 为什么这么测：注入器是宿主侧 cordis 插件，无法脱离运行时 ctx 直接实例化，
 * 因此无法用"调用函数断言返回值"的常规单测。这里改用**可证伪的差异对照**：
 *   - 正向：新产物必须**包含**修复特征
 *   - 反向：旧产物（备份）必须**不包含** → 证明断言不是"恒真"
 * 同时做**可加载性**检查：bundle 内不得残留非 node: 的裸外部说明符
 * （tsdown.config.ts 明确警告：dsh-tools 留作外部说明符会导致"任何安装路径都无法加载"）。
 *
 * 用法：node tests/plugins/injector-p0-fixes.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NEW_BUNDLE = 'D:/Deepseek-Harness/plugins/dsh-routing-suite/injector/lib/index.js';
const OLD_BUNDLE = 'D:/Deepseek-Harness/_backups/injector-fix-20260926-234127/index.js.src-tree.orig';
const NEW_SRC = 'D:/Deepseek-Harness/plugins/dsh-routing-suite/injector/src/index.ts';

let pass = 0;
let fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass += 1; results.push(`  PASS  ${name}`); }
  else { fail += 1; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function read(p) {
  if (!existsSync(p)) throw new Error(`缺文件: ${p}`);
  return readFileSync(p, 'utf8');
}

const next = read(NEW_BUNDLE);
const prev = existsSync(OLD_BUNDLE) ? read(OLD_BUNDLE) : '';
const src = read(NEW_SRC);

// ---------- 1. 可加载性（两种独立方法，取代首版有缺陷的正则）----------
// ⚠️ 断言修正记录：首版用正则扫全文，误报 6 个"裸外部说明符"。逐行查证后确认那些行
// **在脚手架代码生成模板字符串内部**（bundle 7912-7916 行，紧邻 `${JSON.stringify(pkgName)}`
// —— 模块级语句不可能有这种插值，且 node --check 通过反证其在字符串内）。
// 正确方法（本文件采用）：
//   ① 模块序言提取：只取文件开头连续的 import 语句（真解析器看到的模块级导入）
//   ② 真·动态 import()：交给 Node 自己的模块加载器裁决
// 两种方法在 **旧可用产物** 上得到相同结论（0 个裸说明符），构成对照基线。
function modulePrologueSpecs(text) {
  const specs = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    if (/^(import|export)\s/.test(t)) {
      const m = t.match(/from\s+["']([^"']+)["']/) ?? t.match(/^import\s+["']([^"']+)["']/);
      if (m) specs.push(m[1]);
      continue;
    }
    break; // 首个非 import/注释语句 ⇒ 序言结束
  }
  return specs;
}
const isBare = (s) => !s.startsWith('node:') && !s.startsWith('.') && !s.startsWith('/');

const nextPrologue = modulePrologueSpecs(next);
const prevPrologue = modulePrologueSpecs(prev);
const nextBare = [...new Set(nextPrologue.filter(isBare))];
const prevBare = [...new Set(prevPrologue.filter(isBare))];
check(
  '可加载性：新产物模块序言无裸外部说明符',
  nextBare.length === 0,
  nextBare.length ? `残留: ${nextBare.join(', ')}` : '',
);
check(
  '可加载性对照：旧可用产物序言同样无裸说明符（基线成立）',
  prevBare.length === 0,
  prevBare.join(', '),
);
check(
  '可加载性：序言只含 node: 内置导入',
  nextPrologue.length > 0 && nextPrologue.every((s) => s.startsWith('node:')),
  `序言=${nextPrologue.join(', ')}`,
);
// 真·动态 import（交 Node 模块加载器裁决；导出面须与活跃副本一致）
let importOk = false;
let importErr = '';
let importExports = '';
try {
  const mod = await import(pathToFileURL(NEW_BUNDLE).href);
  importExports = Object.keys(mod).sort().join(',');
  importOk = true;
} catch (e) {
  importErr = `${e.code ?? ''} ${String(e.message).split('\n')[0]}`;
}
check('可加载性：真·动态 import() 成功', importOk, importErr);
check(
  '可加载性：导出面完整（Config,apply,inject,name）',
  importOk && ['Config', 'apply', 'inject', 'name'].every((k) => importExports.split(',').includes(k)),
  `实际导出=[${importExports}]`,
);

// ---------- 2. 依赖确实内联（旧产物具备的特征，新产物也必须具备）----------
check('依赖内联：含 dsh-tools 的 defineTool 实现', next.includes('function defineTool'));
check('依赖内联：旧产物同样含 defineTool（对照基线成立）', prev.includes('function defineTool'));

// ---------- 3. T2 修复：失败必带原因 ----------
// 正向：新 bundle 必须含新增的 reason 文案
check(
  'T2 修复存在：loader.create 失败会带原因',
  next.includes('loader.create 失败: '),
);
check(
  'T2 修复存在：host 未激活时给出可操作原因',
  next.includes('host 未进入 active'),
);
check(
  'T2 修复存在：reload 重建 0 fiber 给出原因',
  next.includes('重建 0 个 fiber'),
);
// 反向对照：旧产物必须不含（证明断言可证伪）
check(
  'T2 反向对照：旧产物不含 "host 未进入 active"',
  !prev.includes('host 未进入 active'),
);

// ---------- 4. T3 修复：selfHeal 统计语义不再写反 ----------
// 旧的错误谓词：recordOp('selfHeal', healed.length === 0)
check(
  'T3 反向对照：旧产物含被写反的谓词 recordOp("selfHeal", healed.length === 0)',
  /recordOp\(\s*['"]selfHeal['"]\s*,\s*healed\.length\s*===\s*0\s*\)/.test(prev),
);
check(
  'T3 修复生效：新产物不再含该被写反的谓词',
  !/recordOp\(\s*['"]selfHeal['"]\s*,\s*healed\.length\s*===\s*0\s*\)/.test(next),
);
check(
  'T3 修复存在：selfHeal 抛错时带原因上报',
  next.includes('healProfileLinks 抛错'),
);

// ---------- 4b. T1 判据收紧（第 4 轮加固）----------
// 背景：首版判据「同名即重复」在真实运行态产生 **22 组假阳性**（21 组 group 嵌套
// `include:X` vs `include:GROUP:X`，两边都 disabled；1 组 `mcp-client` 同包载入
// firecrawl/markitdown 两个不同服务）。按首版建议 keep 一条会毁掉另一个 MCP 客户端。
check(
  'T1 加固：判据要求「≥2 条 active」才有双份注册风险',
  next.includes('两条都 active 才有双份注册风险') || next.includes('只有 active 才真的双份注册'),
);
check(
  'T1 加固：判据要求「至少一条为生成式 id」',
  next.includes('无生成式 id') || next.includes('至少一条 id 是**生成式**'),
);
check(
  'T1 加固：注释中显式写明 mcp-firecrawl/markitdown 案例并标注「绝不可动」',
  next.includes('mcp-firecrawl') && next.includes('绝不可动'),
);
check(
  'T1 加固：安全闸门 —— keep 必须为 canonical，拒绝保留生成式',
  next.includes('保留生成式条目会移除 loader 树里的正版条目，拒绝执行'),
);
check(
  'T1 加固：只移除生成式 id（canonical 永不被移除）',
  next.includes('移除生成式重复 entry'),
);

// ---------- 5. T1 修复：同名重复 entry 检测 + 显式修复 ----------
check('T1 修复存在：新增 dev_dedupe_entries 工具', next.includes('dev_dedupe_entries'));
check(
  'T1 修复存在：重复 entry 常驻告警段',
  next.includes('同名重复 entry'),
);
check(
  'T1 修复存在：默认只报告（含"只报告，未做任何改动"语义）',
  next.includes('未做任何改动'),
);
check(
  'T1 修复存在：apply 时强制要求 keep 参数',
  next.includes('apply=true 时必须提供 keep='),
);
check(
  'T1 反向对照：旧产物不含 dev_dedupe_entries',
  !prev.includes('dev_dedupe_entries'),
);

// ---------- 6. 源码与产物一致（3 处修复都在 src 里）----------
check('源码含 T2 修复', src.includes('host 未进入 active'));
check('源码含 T3 修复', src.includes('healProfileLinks 抛错'));
check('源码含 T1 修复', src.includes('dev_dedupe_entries'));

// ---------- 7. 未破坏既有能力（回归护栏）----------
// R1 (2026-09-27): the inject() idempotent short-circuit was STRENGTHENED from
// `hasActiveEntry` to `hasLiveEntry` (active|loading|pending). That widening IS the fix for
// the boot-time ghost: at restore time the profile-declared entry is still `loading`, so an
// `active`-only guard reported "not mounted" and re-created the plugin under a random id.
// The invariant ("inject() short-circuits when the plugin is already mounted") is preserved
// and widened, so this guard is updated to the stronger form rather than dropped.
check('回归：inject() 幂等短路仍在（已在装配则跳过）', src.includes('跳过注入') && src.includes('hasLiveEntry(pkgName)'));
check('回归：幂等短路已强化为覆盖 loading/pending', src.includes("st === 'active' || st === 'loading' || st === 'pending'"));
check('回归：cleanupStaleEntries 仍在', src.includes('function cleanupStaleEntries'));
check('回归：hasActiveEntry 仍在', src.includes('function hasActiveEntry'));
check('回归：arbitrateOfficial 仍在（幽灵压制自愈）', src.includes('function arbitrateOfficial'));
check('回归：purgeStaleTools 仍在（未做语义改动）', src.includes('function purgeStaleTools'));
check('回归：拒绝卸载自身护栏仍在', src.includes('拒绝卸载 dsh-super-injector 自身'));

// ---------- 8. 产物完整性 ----------
check(
  '产物完整（非空、无 NUL 字节、体量合理）',
  next.length > 100_000 && !next.includes('\u0000'),
  `length=${next.length}`,
);

// ---------- 输出 ----------
console.log('===== 注入器 P0 修复 · 差异对照测试 =====');
console.log(`新产物: ${NEW_BUNDLE} (${next.length} chars)`);
console.log(`旧产物: ${OLD_BUNDLE} (${prev.length} chars)`);
console.log('');
console.log(results.join('\n'));
console.log('');
console.log(`RESULT: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log('INJECTOR_FIX_RESULT=FAIL');
  process.exit(1);
}
console.log('INJECTOR_FIX_RESULT=PASS');
