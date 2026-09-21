"""判断「改动有没有真的到浏览器」：抓浏览器实际加载的 client bundle，与磁盘文件比对。"""
import hashlib
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

DISK = Path(r"D:\Deepseek-Harness\plugins\dsh-model-manager\lib\client.js").read_bytes()
print("磁盘 client.js: %d bytes  sha256=%s" % (len(DISK), hashlib.sha256(DISK).hexdigest()[:16]))

seen = []

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="msedge")
    pg = b.new_page(viewport={"width": 1440, "height": 950})

    def on_resp(r):
        u = r.url
        if "model-manager" in u or ("client" in u and u.endswith(".js")):
            try:
                body = r.body()
            except Exception:
                return
            seen.append({"url": u[:140], "bytes": len(body), "sha16": hashlib.sha256(body).hexdigest()[:16]})

    pg.on("response", on_resp)
    pg.goto("http://127.0.0.1:43120", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(7000)
    pg.get_by_text("设置", exact=True).first.click(timeout=8000); pg.wait_for_timeout(1800)
    pg.get_by_text("模型", exact=True).first.click(timeout=8000); pg.wait_for_timeout(3500)

    ours = [x for x in seen if x["bytes"] == len(DISK) or "model-manager" in x["url"]]
    print("浏览器请求到的相关资源：")
    for x in seen[-12:]:
        print("  ", x)
    print("\n匹配磁盘文件长度的请求数：", len([x for x in seen if x["bytes"] == len(DISK)]))
    print("命中同一 sha：", len([x for x in seen if x["sha16"] == hashlib.sha256(DISK).hexdigest()[:16]]))

    # 页面里实际渲染出来的标记（v3 才有的：组头浅底条 + 行内「编辑」按钮 + 中文表头）
    dom = pg.evaluate("""() => {
      const r = document.querySelector('[data-mm-root]');
      if (!r) return { panel: false };
      const row = r.querySelector('.mm-row');
      return {
        panel: true,
        rowButtons: row ? Array.from(row.querySelectorAll('button')).map(b => b.innerText.trim()) : [],
        firstGroupHeadHasBg: (() => { const g = r.querySelectorAll('div > div'); for (const d of g) { const s = getComputedStyle(d); if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && d.innerText.includes('测本组')) return s.backgroundColor } return '(无底色)' })(),
        rowIndent: row ? getComputedStyle(row).paddingLeft : '',
        titleTag: r.querySelector('h2,h3') ? r.querySelector('h2,h3').tagName : '',
      };
    }""")
    print("\n页面 DOM 实际形态：", json.dumps(dom, ensure_ascii=False))
    pg.screenshot(path=str(Path(__file__).parent / "diag-what-is-live.png"))
    b.close()
