"""量内核「模型」页现有行的真实样式，作为 v3 对齐基准。"""
import json

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")
    pg = b.new_page(viewport={"width": 1440, "height": 950})
    pg.goto("http://127.0.0.1:43120", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(6000)
    pg.get_by_text("设置", exact=True).first.click(timeout=8000); pg.wait_for_timeout(1800)
    pg.get_by_text("模型", exact=True).first.click(timeout=8000); pg.wait_for_timeout(3000)

    probe = pg.evaluate("""() => {
      const pick = (el) => {
        const c = getComputedStyle(el);
        return { tag: el.tagName, text: (el.innerText||'').slice(0,40),
          fontSize: c.fontSize, fontWeight: c.fontWeight, color: c.color, background: c.backgroundColor,
          padding: c.padding, margin: c.margin, borderRadius: c.borderRadius, border: c.border, gap: c.gap,
          display: c.display, height: Math.round(el.getBoundingClientRect().height),
          fontFamily: c.fontFamily.split(',')[0] };
      };
      // 内核的厂商行：找包含「编辑」文本按钮、且不含我们标记的最近容器
      const editBtns = Array.from(document.querySelectorAll('button, [role=button], a')).filter(b => (b.innerText||'').trim() === '编辑');
      const out = { editButtonCount: editBtns.length };
      if (editBtns.length) {
        const btn = editBtns[0];
        const row = btn.closest('div');
        out.editButton = pick(btn);
        out.row = row ? pick(row) : null;
        out.rowHTML = row ? row.outerHTML.slice(0, 700) : '';
        const nameEl = row ? row.querySelector('span, div') : null;
        out.name = nameEl ? pick(nameEl) : null;
      }
      // 页面标题与说明文字
      const h = Array.from(document.querySelectorAll('h1,h2,h3,h4')).find(x => (x.innerText||'').trim() === '模型');
      out.title = h ? pick(h) : null;
      const intro = Array.from(document.querySelectorAll('p,div')).find(x => /填入各提供方/.test(x.innerText||''));
      out.intro = intro ? pick(intro) : null;
      return out;
    }""")
    print(json.dumps(probe, ensure_ascii=False, indent=1)[:2600])
    b.close()
