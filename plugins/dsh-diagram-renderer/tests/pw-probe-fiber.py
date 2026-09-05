# -*- coding: utf-8 -*-
# Probe 12: fiber-tree inspection of DiagramTurnTail + history replay check
import json
from playwright.sync_api import sync_playwright

SESSION_ID = "session-d8623818-b2cb-4cfc-854b-fb729ca98e28"

FIBER_JS = r"""() => {
  const out = { tails: [], viewers: [], mermaidWidgets: 0, minis: 0 };
  let hostRoot = null;
  const cands = [document.getElementById('root'), document.body.firstElementChild, document.body];
  for (const el of cands) {
    if (!el) continue;
    const k = Object.keys(el).find(k => k.startsWith('__reactContainer$'));
    if (k) { hostRoot = el[k]; break }
  }
  if (!hostRoot) {
    const anyEl = document.querySelector('div');
    if (anyEl) {
      const k = Object.keys(anyEl).find(k => k.startsWith('__reactFiber$'));
      if (k) { let f = anyEl[k]; while (f && f.return) f = f.return; hostRoot = f.stateNode; }
    }
  }
  if (!hostRoot) return { err: 'no fiber root' };
  const top = hostRoot.current || hostRoot;
  const seen = new Set();
  const stack = [top];
  let guard = 0;
  while (stack.length && guard < 300000) {
    guard++;
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    const t = f.type;
    if (typeof t === 'function') {
      const name = t.displayName || t.name || '';
      if (name === 'DiagramTurnTail') {
        const mp = f.memoizedProps || {};
        out.tails.push({ matchedLen: Array.isArray(mp.matched) ? mp.matched.length : -1, titles: Array.isArray(mp.matched) ? mp.matched.map(d => d.title || '(untitled)') : null });
      } else if (name === 'DiagramViewer') {
        out.viewers.push({ title: (f.memoizedProps || {}).title, svgLen: ((f.memoizedProps || {}).svg || '').length });
      } else if (name === 'MermaidWidget') {
        out.mermaidWidgets++;
      } else if (name === 'MiniCard') {
        out.minis++;
      }
    }
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }
  out.scanned = seen.size;
  return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="chrome")
    ctx = b.new_context(viewport={"width": 1600, "height": 1000})
    pg = ctx.new_page()
    pg.add_init_script(
        "try { localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId: '" + SESSION_ID + "'})) } catch (e) {}"
    )
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
    pg.goto("http://127.0.0.1:43120", wait_until="domcontentloaded")
    pg.wait_for_timeout(6000)
    for attempt in range(5):
        ok = pg.evaluate(r"""() => {
          const els = [...document.querySelectorAll('[class*="sessionRow"]')];
          const el = els.find(e => (e.textContent||'').includes('绘制系统架构图'));
          if (el) { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 100, clientY: r.top})); return true }
          return false
        }""")
        if ok:
            break
        pg.wait_for_timeout(2000)
    pg.wait_for_timeout(4000)
    data = pg.evaluate(FIBER_JS)
    print("BEFORE_LOADMORE:", json.dumps(data, ensure_ascii=False))
    # click 加载更早 a few times
    for i in range(6):
        clicked = pg.evaluate(r"""() => {
          const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('加载更早'));
          if (btns.length) { btns[0].click(); return true }
          return false
        }""")
        if not clicked:
            break
        pg.wait_for_timeout(1500)
    data2 = pg.evaluate(FIBER_JS)
    data2["pageErrors"] = errors[:5]
    b.close()
print("AFTER_LOADMORE:", json.dumps(data2, ensure_ascii=False, indent=1))
