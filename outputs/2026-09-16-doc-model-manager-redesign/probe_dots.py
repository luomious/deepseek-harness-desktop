"""证伪：设置→模型 页里的「绿色小圆点」到底是谁的？

判定：抓所有小尺寸圆形元素的 class / 所在容器文本 / 颜色，
再对照我们插件的标记（style[data-dsh-model-manager] 与 .mm-* / dsh-model-manager 相关 class）。
"""
import json

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:43120"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(9000)
    page.get_by_text("设置", exact=True).first.click(timeout=6000)
    page.wait_for_timeout(2500)
    page.get_by_text("模型", exact=True).first.click(timeout=6000)
    page.wait_for_timeout(3500)

    out = page.evaluate("""() => {
      const all = Array.from(document.querySelectorAll('*'));
      const dots = [];
      for (const el of all) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.width > 16 || r.height > 16) continue;
        const bg = cs.backgroundColor || '';
        const br = parseFloat(cs.borderRadius) || 0;
        if (!bg || bg === 'rgba(0, 0, 0, 0)') continue;
        if (br < r.width / 2 - 0.5 && br < 4) continue;   // 只留圆/近圆
        dots.push({
          cls: el.className && el.className.toString ? el.className.toString().slice(0, 90) : '',
          tag: el.tagName,
          bg,
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          row: (el.closest('li,tr,div[class*="row"],div[class*="item"]')?.innerText || '').replace(/\\n/g,' | ').slice(0, 60),
          isOurs: !!(el.closest('[class*="mm-"],[data-dsh-model-manager],[class*="model-manager"]')),
        });
      }
      const ours = all.filter(el => {
        const c = (el.className && el.className.toString) ? el.className.toString() : '';
        return /model-manager/i.test(c) || /(^|\\s)mm-/.test(c);
      }).length;
      return {
        dotCount: dots.length,
        dotsSample: dots.slice(0, 12),
        anyOursNodes: ours,
        styleTag: !!document.querySelector('style[data-dsh-model-manager]'),
        bodyMaybeOurText: /连接状态|可用\\/|硬失败/.test(document.body.innerText || ''),
      };
    }""")
    print(json.dumps(out, ensure_ascii=False, indent=1)[:2600])
    browser.close()
