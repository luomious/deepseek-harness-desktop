"""Round 2 之二：进会话视图，目视复核会话头部 📶 网络图标（客户端 bundle 已是新版）。"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:43120"
errs = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)

    # 点侧栏里第一个会话，进入 conversation 视图（头部动作槽只在那里渲染）
    clicked = None
    for name in ["模型连通性测试与配置", "检测dsh项目并全面自检清理", "多智能体编排状态账本计划"]:
        try:
            el = page.get_by_text(name, exact=False).first
            if el.count() > 0:
                el.click(timeout=6000)
                clicked = name
                break
        except Exception:
            continue
    print("打开会话:", clicked or "(未找到，尝试点击会话列表首项)")
    if not clicked:
        try:
            page.locator("text=进行中").first.click(timeout=5000)
        except Exception:
            pass
    page.wait_for_timeout(7000)

    probe = page.evaluate("""() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const icon = btns.find(b => (b.innerText||'').includes('📶') || (b.getAttribute('title')||'').includes('可用'));
      const style = !!document.querySelector('style[data-dsh-model-manager]');
      return {
        iconFound: !!icon,
        iconText: icon ? (icon.innerText||'').trim().slice(0,40) : '',
        iconTitle: icon ? (icon.getAttribute('title')||'').slice(0,80) : '',
        dotColor: icon ? (icon.querySelector('.mm-dot') ? getComputedStyle(icon.querySelector('.mm-dot')).backgroundColor : '') : '',
        hasErr: !!document.querySelector('[data-dsh-model-manager-error]'),
        hasStyle: style,
        headers: Array.from(document.querySelectorAll('[class*="header"] button')).map(b=>(b.innerText||b.getAttribute('title')||'').trim()).filter(Boolean).slice(0,12),
      };
    }""")
    print(json.dumps(probe, ensure_ascii=False, indent=1)[:900])
    page.screenshot(path=str(OUT / "ui-step2-header.png"))

    # 点一下图标（旧 host 下扫描会以 0 目标启动/返回，重点验证点击不炸、弹层能开）
    if probe["iconFound"]:
        try:
            page.locator("button", has_text="📶").first.click(timeout=5000)
            page.wait_for_timeout(3500)
            after = page.evaluate("""() => ({
              popover: !!document.querySelector('.mm-menu'),
              popoverText: (document.querySelector('.mm-menu') ? document.querySelector('.mm-menu').innerText : '').slice(0,200),
              err: !!document.querySelector('[data-dsh-model-manager-error]'),
            })""")
            print("点击后:", json.dumps(after, ensure_ascii=False)[:400])
            page.screenshot(path=str(OUT / "ui-step2-icon-clicked.png"))
        except Exception as e:
            print("点击图标异常:", str(e)[:200])
    else:
        print("未在头部找到图标（可能当前视图不是会话视图）")
    print("pageerror:", errs[:5])
    browser.close()
    sys.exit(0 if probe["iconFound"] and not probe["hasErr"] else 1)
