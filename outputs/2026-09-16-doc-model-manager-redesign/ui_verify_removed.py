"""移除后复核：确认 dsh-model-manager 在浏览器端已彻底消失（图标 / 样式 / 面板 / bundle 请求）。

判定原则（避免假绿）：
  - 不只看「有没有图标」，还要看浏览器**是否还在请求**该插件的 client bundle；
  - 每个"没有"结论都必须配一个"有"的正向信号（页面确实渲染了、会话视图确实打开了），否则空 DOM 也会假通过。
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:43120"
errors, reqs = [], []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.on("request", lambda r: reqs.append(r.url))
    page.on("console", lambda m: None)
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(9000)

    shell = page.evaluate("""() => ({
      title: document.title,
      bodyLen: (document.body.innerText||'').length,
      hasStyle: !!document.querySelector('style[data-dsh-model-manager]'),
      hasErrBar: !!document.querySelector('[data-dsh-model-manager-error]'),
      hasIcon: !!Array.from(document.querySelectorAll('button')).find(b =>
        (b.innerText||'').includes('📶') || (b.getAttribute('title')||'').includes('可用/')),
      bootHasMM: (() => { try { return JSON.stringify(window.__DSH_BOOT__||{}).includes('model-manager') } catch(e) { return 'n/a' } })(),
    })""")
    page.screenshot(path=str(OUT / "verify-removed-shell.png"))

    # 打开一个会话（头部动作槽只在会话视图渲染）
    opened = None
    for name in ["模型连通性测试与配置", "检测dsh项目并全面自检清理", "多智能体编排状态账本计划"]:
        try:
            el = page.get_by_text(name, exact=False).first
            if el.count() > 0:
                el.click(timeout=6000)
                opened = name
                break
        except Exception:
            continue
    if not opened:
        try:
            page.locator("[class*='session']").first.click(timeout=5000)
            opened = "(首项)"
        except Exception:
            pass
    page.wait_for_timeout(7000)
    conv = page.evaluate("""() => ({
      iconTexts: Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim())
                   .filter(t => t.includes('📶')),
      headerBtns: Array.from(document.querySelectorAll('[class*="header"] button'))
                   .map(b => (b.innerText || b.getAttribute('title') || '').trim()).filter(Boolean).slice(0, 14),
      composer: !!document.querySelector('textarea, [contenteditable="true"]'),
      hasStyle: !!document.querySelector('style[data-dsh-model-manager]'),
    })""")
    page.screenshot(path=str(OUT / "verify-removed-conversation.png"))

    # 设置 → 模型
    settings = None
    try:
        page.get_by_text("设置", exact=True).first.click(timeout=6000)
        page.wait_for_timeout(2500)
        page.get_by_text("模型", exact=True).first.click(timeout=6000)
        page.wait_for_timeout(3500)
        settings = page.evaluate("""() => ({
          hasStyle: !!document.querySelector('style[data-dsh-model-manager]'),
          hasErrBar: !!document.querySelector('[data-dsh-model-manager-error]'),
          mmRows: document.querySelectorAll('.mm-row').length,
          mmCards: document.querySelectorAll('.mm-card').length,
          mmMenu: !!document.querySelector('.mm-menu'),
          buttons: document.querySelectorAll('button').length,
          hasKernelProviders: /deepseek|openrouter|groq/i.test(document.body.innerText||''),
          mentionsConnectivity: (document.body.innerText||'').includes('连接状态'),
        })""")
        page.screenshot(path=str(OUT / "verify-removed-settings-models.png"))
    except Exception as e:
        settings = {"error": str(e)[:200]}

    mmreqs = [u for u in reqs if "model-manager" in u]
    served = []
    for u in mmreqs:
        try:
            r = page.request.get(u, timeout=5000)
            served.append({"url": u[-70:], "status": r.status})
        except Exception as e:
            served.append({"url": u[-70:], "err": str(e)[:80]})

    print("=== 1) 壳层 ===")
    print(json.dumps(shell, ensure_ascii=False, indent=1))
    print("\n=== 2) 会话视图（opened=%s）===" % opened)
    print(json.dumps(conv, ensure_ascii=False, indent=1))
    print("\n=== 3) 设置→模型 ===")
    print(json.dumps(settings, ensure_ascii=False, indent=1))
    print("\n=== 4) 浏览器是否仍请求 model-manager 资源 ===")
    print("请求数:", len(mmreqs))
    for s in served[:8]:
        print(" ", s)
    print("\n=== 5) pageerror ===", errors[:5])

    verdict = {
        "shell_clean": not shell["hasStyle"] and not shell["hasErrBar"] and not shell["hasIcon"],
        "conv_clean": not conv["iconTexts"] and not conv["hasStyle"] and conv["composer"],
        "settings_clean": bool(settings) and not settings.get("hasStyle") and not settings.get("hasErrBar")
                          and settings.get("mmRows") == 0 and settings.get("mmCards") == 0
                          and settings.get("hasKernelProviders"),
        "no_bundle_request": len(mmreqs) == 0,
        "no_pageerror": len(errors) == 0,
    }
    print("\n=== 判定 ===")
    print(json.dumps(verdict, ensure_ascii=False, indent=1))
    print("ALL_PASS:", all(verdict.values()))
    browser.close()
    sys.exit(0 if all(verdict.values()) else 1)
