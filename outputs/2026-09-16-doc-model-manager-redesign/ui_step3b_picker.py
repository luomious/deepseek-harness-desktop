"""Round 3 之续：直接注入与面板完全一致的白名单值，确认模型选择器确实按它过滤。

用的是面板实测写出的同一 schema（{"enabled":true,"models":["<provider>/<model>"]}），
测完还原用户原始值。
"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:43120"
KEY = "dsh.model-whitelist.v1"
MODELS = ["deepseek-official/deepseek-v4-flash", "deepseek-official/deepseek-v4-pro"]

def dump_picker(page):
    return page.evaluate("""() => {
      const body = (document.body.innerText || '');
      // 优先取「浮层类」容器（非 static 定位、足够大的），取文本最长者；拿不到就退回整页文本
      const cands = Array.from(document.querySelectorAll('div,[role=listbox],[role=menu]')).filter(d => {
        const r = d.getBoundingClientRect();
        return r.width > 180 && r.height > 150 && r.top > 80;
      });
      let best = null, bestLen = 0;
      for (const c of cands) {
        const t = (c.innerText || '').trim();
        if (t.length > bestLen && t.length < body.length) { best = t; bestLen = t.length; }
      }
      return best || body;
    }""")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)
    original = page.evaluate("(k) => localStorage.getItem(k)", KEY)
    try:
        # 基线：先看未过滤的选择器里有哪些模型
        page.locator("button", has_text="DeepSeek-V4.1-Flash").first.click(timeout=8000)
        page.wait_for_timeout(2000)
        base = dump_picker(page)
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT / "ui-step3-picker-unfiltered.png"))

        # 注入 = 面板写出的同一 schema，然后重载页面
        page.evaluate("([k, v]) => localStorage.setItem(k, v)", [KEY, json.dumps({"enabled": True, "models": MODELS})])
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(6000)
        page.locator("button", has_text="DeepSeek-V4.1-Flash").first.click(timeout=8000)
        page.wait_for_timeout(2500)
        filtered = dump_picker(page)
        page.screenshot(path=str(OUT / "ui-step3-picker-filtered.png"))

        base_models = [l for l in base.split("\n") if "/" in l]
        filt_models = [l for l in filtered.split("\n") if "/" in l]
        print("未过滤时出现的模型行(%d):" % len(base_models), json.dumps(base_models[:12], ensure_ascii=False))
        print("过滤后出现的模型行(%d):" % len(filt_models), json.dumps(filt_models[:12], ensure_ascii=False))
        allowed = set(MODELS)
        leaked = [m for m in filt_models if m.strip() not in allowed and "V4.1-Flash" not in m]
        print("白名单之外的泄漏项:", json.dumps(leaked, ensure_ascii=False))
        # 兜底判据：整页文本里几个「应被过滤掉」的特征模型名是否还在
        probe_names = ["GLM-5.3", "glm-5.3", "Kimi", "ERNIE", "V4-Flash", "MiMo"]
        base_hits = {n: base.count(n) for n in probe_names}
        filt_hits = {n: filtered.count(n) for n in probe_names}
        print("未过滤文本特征:", json.dumps(base_hits, ensure_ascii=False))
        print("过滤后文本特征:", json.dumps(filt_hits, ensure_ascii=False))
        print("结论:", "过滤生效" if sum(filt_hits.values()) < sum(base_hits.values()) and not leaked else "需要人工看图确认")
        print("--- 过滤后浮层文本(前 400) ---")
        print(filtered[:400].replace("\n", " | "))
    finally:
        page.evaluate("([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) }", [KEY, original])
        print("已还原原始白名单:", (page.evaluate("(k) => localStorage.getItem(k)", KEY) or "(空)")[:80])
        browser.close()
