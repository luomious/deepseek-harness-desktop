// src/lib/version.js
// 语义版本比较（从 main.js 抽出，供 main.js 与 tests 共用，消除"复制副本"假绿风险）

/**
 * 比较语义化版本号（支持 semver pre-release），返回 true 表示 remote 比 local 新
 */
function isNewer(local, remote) {
  if (!local || !remote) return false;

  const parseSemver = (v) => {
    // 防御：npm 可能返回数字类型版本号（如 1.2.3 被 JSON 解析为数字）
    if (typeof v !== 'string') {
      try { v = String(v); } catch (e) { return { parts: [0, 0, 0], pre: '' }; }
    }
    // 分离 major.minor.patch 和 pre-release 标签
    const main = v.replace(/-.*$/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pre = v.includes('-') ? v.split('-')[1] : '';
    return { parts: main, pre };
  };

  const lp = parseSemver(local);
  const rp = parseSemver(remote);

  // 比较主版本号
  for (let i = 0; i < 3; i++) {
    const l = lp.parts[i] || 0;
    const r = rp.parts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }

  // 主版本相同，按 semver 规范比较 pre-release：
  // 正式版 > 任何 pre-release；pre-release 按数字标识符数值比较
  if (!lp.pre && !rp.pre) return false;      // 完全相同
  if (!lp.pre && rp.pre) return false;       // local 正式版 > remote rc → 无更新
  if (lp.pre && !rp.pre) return true;        // local rc → remote 正式版 → 有更新

  // 都是 pre-release：按 . 分隔的标识符逐段比较（数字按数值，字母按字符串）
  const lpParts = lp.pre.split('.');
  const rpParts = rp.pre.split('.');
  const maxLen = Math.max(lpParts.length, rpParts.length);
  for (let i = 0; i < maxLen; i++) {
    const l = lpParts[i];
    const r = rpParts[i];
    if (l === undefined) return true;   // local 更短 → local 更旧 → 有更新
    if (r === undefined) return false;  // remote 更短 → remote 更旧 → 无更新
    if (l === r) continue;
    // 数字段按数值比较
    const ln = /^\d+$/.test(l) ? parseInt(l, 10) : NaN;
    const rn = /^\d+$/.test(r) ? parseInt(r, 10) : NaN;
    if (!isNaN(ln) && !isNaN(rn)) return rn > ln;
    // 字母段按字符串比较
    return r > l;
  }
  return false;  // 完全相同
}

module.exports = { isNewer };