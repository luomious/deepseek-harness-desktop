# -*- coding: utf-8 -*-
# Probe 14 (v5): precise card metrics via unique root anchor
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
        clicked = pg.evaluate(r"""() => {
          const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('加载更早'));
          if (btns.length) { btns[0].click(); return true }
          return false
        }""")
        if not clicked:
            break
        pg.wait_for_timeout(1500)
    found = False
    for i in range(16):
        has = pg.evaluate(r"""() => {
          const roots = [...document.querySelectorAll('div[style*="margin: 6px -64px"]')];
          if (roots.length) { roots[roots.length-1].scrollIntoView({block: 'center'}); return true }
          return false
        }""")
        if has:
            found = True
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
    print("FOUND:", found)
    pg.wait_for_timeout(1200)
    data = pg.evaluate(r"""() => {
      const out = { cards: 0, samples: [] };
      const roots = [...document.querySelectorAll('div[style*="margin: 6px -64px"]')];
      out.cards = roots.length;
      roots.slice(-3).forEach((root, i) => {
        const kids = [...root.querySelectorAll(':scope > div')];
        const body = kids.find(d => d.style && (d.style.overflowY === 'hidden' || d.style.overflowY === 'auto'));
        const svgEl = body ? body.querySelector('svg') : null;
        const titleSpan = root.querySelector('span[style*="font-weight: 700"]');
        out.samples.push({
          i,
          title: titleSpan ? titleSpan.textContent.slice(0, 30) : null,
          bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
          overflowY: body ? body.style.overflowY : null,
          bodyW: body ? Math.round(body.clientWidth) : null,
          svgW: svgEl ? svgEl.getAttribute('width') : null,
          svgH: svgEl ? svgEl.getAttribute('height') : null,
          svgRectH: svgEl ? Math.round(svgEl.getBoundingClientRect().height) : null,
          bg: body ? getComputedStyle(body).backgroundColor : null,
        });
      });
      return out;
    }""")
    data["pageErrors"] = errors[:5]
    pg.wait_for_timeout(500)
    pg.screenshot(path="D:/Deepseek-Harness/plugins/dsh-diagram-renderer/probe-live-v5b.png")
    b.close()
print("PROBE:", json.dumps(data, ensure_ascii=False, indent=1))
