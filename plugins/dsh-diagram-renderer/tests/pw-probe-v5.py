# -*- coding: utf-8 -*-
# Probe 13 (v5): verify adaptive viewer — no zoom controls, height hugs diagram
import json
from playwright.sync_api import sync_playwright

SESSION_ID = "session-d8623818-b2fc-854b-fb729ca98e28"
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
    # click 加载更早 to load deep history
    for i in range(6):
        clicked = pg.evaluate(r"""() => {
          const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').includes('加载更早'));
          if (btns.length) { btns[0].click(); return true }
          return false
        }""")
        if not clicked:
            break
        pg.wait_for_timeout(1500)
    # walk down to find a viewer card
    found = False
    for i in range(16):
        has = pg.evaluate(r"""() => {
          const btns = [...document.querySelectorAll('button[title*="全屏查看"]')];
          if (btns.length) { btns[btns.length-1].scrollIntoView({block: 'center'}); return true }
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
    print("FOUND_CARD:", found)
    pg.wait_for_timeout(1500)
    data = pg.evaluate(r"""() => {
      const out = {};
      out.fullBtns = document.querySelectorAll('button[title*="全屏查看"]').length;
      out.oldZoomBtns = document.querySelectorAll('button[title*="适应视图"], button[title*="铺满宽度"], button[title="放大"], button[title="缩小"]').length;
      out.adaptiveTags = [...document.querySelectorAll('span')].filter(s => (s.textContent||'').trim() === '自适应').length;
      const btn = [...document.querySelectorAll('button[title*="全屏查看"]')].pop();
      if (!btn) { out.info = { err: 'no card' }; return out }
      let el = btn, root = null;
      for (let hop = 0; el && hop < 8; hop++) {
        el = el.parentElement;
        if (!el) break;
        const fs = Object.keys(el).filter(k => k.startsWith('__reactFiber$'));
        if (fs.length) { root = el; break }
      }
      const fs = Object.keys(root).filter(k => k.startsWith('__reactFiber$'));
      let f = root[fs[0]], props = null;
      for (let hop = 0; f && hop < 8; hop++) {
        const mp = f.memoizedProps;
        if (mp && typeof mp.svg === 'string') { props = mp; break }
        f = f.return;
      }
      // body = the scroll container inside root
      const body = [...root.querySelectorAll(':scope > div')].find(d => d.style && (d.style.overflowY === 'hidden' || d.style.overflowY === 'auto'));
      const svgEl = body ? body.querySelector('svg') : null;
      out.info = {
        title: props ? props.title : null,
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
        bodyOverflowY: body ? body.style.overflowY : null,
        bodyW: body ? Math.round(body.clientWidth) : null,
        svgWidthAttr: svgEl ? svgEl.getAttribute('width') : null,
        svgHeightAttr: svgEl ? svgEl.getAttribute('height') : null,
        svgRectW: svgEl ? Math.round(svgEl.getBoundingClientRect().width) : null,
        hugsRatio: (body && svgEl) ? Math.round(body.getBoundingClientRect().height / (parseFloat(svgEl.getAttribute('height')) || 1) * 100) / 100 : null,
        rootBg: getComputedStyle(root).backgroundColor,
      };
      return out;
    }""")
    data["pageErrors"] = errors[:5]
    pg.wait_for_timeout(600)
    pg.screenshot(path="D:/Deepseek-Harness/plugins/dsh-diagram-renderer/probe-live-v5.png")
    b.close()
print("PROBE:", json.dumps(data, ensure_ascii=False, indent=1))
