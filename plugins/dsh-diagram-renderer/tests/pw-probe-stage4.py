# -*- coding: utf-8 -*-
# Probe stage4: click a diagram node -> detail popover appears
import json
from playwright.sync_api import sync_playwright

SESSION_ID = "session-d8623818-b2cb-4cfc-854b-fb729ca98e28"

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
    for i in range(6):
        clicked2 = pg.evaluate(r"""() => {
          const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('加载更早'));
          if (btns.length) { btns[0].click(); return true }
          return false
        }""")
        if not clicked2:
            break
        pg.wait_for_timeout(1500)
    # find first viewer card and click a node inside its svg
    clicked = False
    for i in range(16):
        done = pg.evaluate(r"""() => {
          const roots = [...document.querySelectorAll('div[style*="margin: 6px -64px"]')];
          if (!roots.length) return false;
          const root = roots[0];
          root.scrollIntoView({block: 'center'});
          const svg = root.querySelector('svg');
          const g = svg && (svg.querySelector('g[data-name]') || svg.querySelector('g[id]'));
          if (!g) return false;
          const r = g.getBoundingClientRect();
          if (r.width < 2) return false;
          window.__dshClickAt = [r.left + r.width / 2, r.top + Math.min(r.height / 2, 12)];
          return true;
        }""")
        if done:
            clicked = True
            break
        pg.evaluate(r"""() => {
          const cands = [...document.querySelectorAll('div')].filter(d => {
            const s = getComputedStyle(d);
            return /(auto|scroll)/.test(s.overflowY) && d.scrollHeight > d.clientHeight * 1.2 && d.clientHeight > 300;
          });
          cands.sort((a, b) => b.scrollHeight - a.scrollHeight);
          if (cands[0]) cands[0].scrollTop = cands[0].scrollTop + 900;
        }""")
        pg.wait_for_timeout(400)
    print("NODE_FOUND:", clicked)
    if clicked:
        at = pg.evaluate("() => window.__dshClickAt")
        pg.mouse.click(at[0], at[1])
        pg.wait_for_timeout(600)
    data = pg.evaluate(r"""() => {
      const pops = [...document.querySelectorAll('div')].filter(d => (d.textContent||'').includes('点击空白处关闭') && d.style.position === 'absolute');
      return {
        popoverCount: pops.length,
        popoverText: pops.length ? pops[0].textContent.slice(0, 80) : null,
      };
    }""")
    data["pageErrors"] = errors[:5]
    b.close()
print("PROBE:", json.dumps(data, ensure_ascii=False, indent=1))
