"""第一步之一：真机 UI 复核（不依赖重启的部分）。

客户端 bundle 是按请求读盘 + no-cache，所以运行中的应用已经在提供新客户端代码；
host 半仍是注入时的旧版（本构建无法热重载 host），因此这里只验证「渲染与注册」，
扫描类动作留到重启后。"""
import json
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except Exception as e:  # pragma: no cover
    print("playwright 不可用:", e)
    sys.exit(2)

OUT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:43120"
console, errors = [], []

with sync_playwright() as p:
    # 本机没装 playwright 自带的 chromium；直接用系统 Edge/Chrome（channel），避免额外下载
    browser = None
    for kwargs in ({"channel": "msedge"}, {"channel": "chrome"}, {}):
        try:
            browser = p.chromium.launch(headless=True, **kwargs)
            print("browser:", kwargs or "bundled chromium")
            break
        except Exception as e:
            print("launch 失败", kwargs, str(e)[:120])
    if browser is None:
        print("没有可用浏览器，跳过 UI 复核")
        sys.exit(3)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda m: console.append((m.type, m.text[:200])))
    page.on("pageerror", lambda e: errors.append(str(e)[:300]))
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)

    probe = page.evaluate("""() => {
      const css = !!document.querySelector('style[data-dsh-model-manager]');
      const err = !!document.querySelector('[data-dsh-model-manager-error]');
      const q = (sel) => Array.from(document.querySelectorAll(sel)).map(n => (n.innerText||n.getAttribute('title')||'').trim()).filter(Boolean).slice(0,30);
      return {
        title: document.title,
        hasCss: css, hasErrorBar: err,
        buttons: q('button').slice(0, 25),
        bodyHead: (document.body.innerText || '').slice(0, 300),
      };
    }""")
    page.screenshot(path=str(OUT / "ui-step1-shell.png"))

    print("title:", probe["title"])
    print("我们的样式已注入(组件已挂载):", probe["hasCss"])
    print("页面出现我们的错误条:", probe["hasErrorBar"])
    print("可见按钮(前 25):", json.dumps(probe["buttons"], ensure_ascii=False)[:600])
    print("正文片段:", probe["bodyHead"].replace("\n", " | ")[:300])

    # 尝试打开设置 → 模型
    opened = False
    for label in ["设置", "Settings"]:
        try:
            el = page.get_by_text(label, exact=True).first
            if el.count() > 0:
                el.click(timeout=5000)
                page.wait_for_timeout(2500)
                opened = True
                break
        except Exception:
            continue
    if opened:
        for label in ["模型", "Models"]:
            try:
                el = page.get_by_text(label, exact=True).first
                if el.count() > 0:
                    el.click(timeout=5000)
                    page.wait_for_timeout(3000)
                    break
            except Exception:
                continue
        page.screenshot(path=str(OUT / "ui-step1-settings.png"))
        after = page.evaluate("""() => ({
          hasCss: !!document.querySelector('style[data-dsh-model-manager]'),
          hasErr: !!document.querySelector('[data-dsh-model-manager-error]'),
          mmRows: document.querySelectorAll('.mm-row').length,
          mmCards: document.querySelectorAll('.mm-card').length,
          panelTitle: (Array.from(document.querySelectorAll('h3')).map(h=>h.innerText).filter(t=>t.includes('连接')).join(',')||''),
          text: (document.body.innerText||'').slice(0,400)
        })""")
        print("\n[设置→模型] 面板探测:", json.dumps(after, ensure_ascii=False)[:600])
    else:
        print("\n未能自动点到『设置』，已保存壳层截图供人工查看")

    print("\nconsole errors:", errors[:8])
    print("console 关键行:", [t for t in console if 'model-manager' in t[1].lower()][:6])
    browser.close()
