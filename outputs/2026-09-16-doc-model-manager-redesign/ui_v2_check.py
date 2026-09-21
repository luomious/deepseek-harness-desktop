"""v2 排版复核：刷新页面 → 设置 → 模型 → 量测元素数/可见行数/旧面板是否收起，并截图。"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")
    pg = b.new_page(viewport={"width": 1440, "height": 950})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto("http://127.0.0.1:43120", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(6000)
    pg.get_by_text("设置", exact=True).first.click(timeout=8000); pg.wait_for_timeout(1800)
    pg.get_by_text("模型", exact=True).first.click(timeout=8000); pg.wait_for_timeout(3500)

    root = pg.locator("[data-mm-root]").first
    root.scroll_into_view_if_needed(timeout=8000)
    pg.wait_for_timeout(1200)

    def stats(tag):
        s = pg.evaluate("""() => {
          const r = document.querySelector('[data-mm-root]');
          const vis = (el) => el && el.offsetParent !== null;
          const rows = Array.from(r.querySelectorAll('.mm-row')).filter(vis);
          const leg = document.querySelector('.mw-group');
          return {
            panelH: Math.round(r.getBoundingClientRect().height),
            visibleRows: rows.length,
            totalRows: r.querySelectorAll('.mm-row').length,
            buttons: r.querySelectorAll('button').length,
            svgs: r.querySelectorAll('svg').length,
            selects: r.querySelectorAll('select').length,
            toolbars: r.querySelectorAll('input').length,
            groupHeads: r.querySelectorAll('[data-mm-root] > div').length,
            legacyVisible: vis(leg),
            top: r.innerText.split('\\n').slice(0, 6),
          };
        }""")
        print(f"[{tag}]", json.dumps(s, ensure_ascii=False)[:420])
        return s

    collapsed = stats("默认（只展开有异常的组）")
    pg.screenshot(path=str(OUT / "ui-v2-panel-default.png"))

    # 展开全部（按钮文案已改为「展开全部/折叠全部」）
    try:
        pg.locator("[data-mm-root] button", has_text="展开全部").first.click(timeout=5000)
        pg.wait_for_timeout(1500)
        expanded = stats("展开全部")
        pg.screenshot(path=str(OUT / "ui-v2-panel-expanded.png"))
    except Exception as e:
        print("展开按钮点击失败:", str(e)[:120])
        expanded = None

    # 仅异常
    try:
        pg.locator("[data-mm-root] button", has_text="仅异常").first.click(timeout=5000)
        pg.wait_for_timeout(1500)
        stats("仅异常")
        pg.screenshot(path=str(OUT / "ui-v2-panel-issues.png"))
    except Exception as e:
        print("仅异常点击失败:", str(e)[:120])

    print("pageerror:", errs[:4])
    b.close()
