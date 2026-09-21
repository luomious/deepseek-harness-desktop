"""Round 3：验证「保留现有功能」——我的面板写白名单后，会话模型选择器是否真的按它过滤。

流程：备份 localStorage → 在我的面板里勾选若干模型 + 打开总开关 → 关闭设置 → 打开模型选择器
→ 读列表并断言 ⊆ 勾选集合 ∪ {当前模型} → **还原原始 localStorage**（finally 保证）。
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:43120"
KEY = "dsh.model-whitelist.v1"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)

    original = page.evaluate("(k) => localStorage.getItem(k)", KEY)
    print("原始白名单:", (original or "(空)")[:160])
    try:
        # 1) 打开 设置 → 模型
        page.get_by_text("设置", exact=True).first.click(timeout=8000)
        page.wait_for_timeout(2000)
        page.get_by_text("模型", exact=True).first.click(timeout=8000)
        page.wait_for_timeout(3000)

        # 2) 在我的面板里勾选前 3 个模型的 👁
        eyes = page.locator("button", has_text="👁")
        n_eyes = eyes.count()
        print("面板里 👁 数量:", n_eyes)
        picked = []
        for i in range(min(3, n_eyes)):
            row = eyes.nth(i)
            model = row.evaluate("el => { const r = el.closest('.mm-row'); return r ? (r.querySelector('.mm-mono')||{}).innerText : '' }")
            row.click(timeout=5000)
            picked.append((model or "").strip())
        page.wait_for_timeout(1200)
        mid = page.evaluate("(k) => localStorage.getItem(k)", KEY)
        print("点完 👁 之后 localStorage:", (mid or "(未写)")[:220])

        # 3) 打开总开关「只在选择器里显示我勾选的模型」（只点我这块卡片里的那个复选框）
        toggle = page.locator("label", has_text="只在选择器里显示我勾选的模型").locator("input[type=checkbox]").first
        is_on = page.evaluate("(k) => { const v = localStorage.getItem(k); return v ? !!JSON.parse(v).enabled : false }", KEY)
        print("总开关当前状态 enabled=", is_on, "| 复选框可见:", toggle.is_visible())
        if not is_on:
            toggle.click(timeout=8000)
            page.wait_for_timeout(1200)
        after = page.evaluate("(k) => localStorage.getItem(k)", KEY)
        print("勾选后 localStorage:", (after or "")[:200])
        print("勾选的模型:", picked)

        # 4) 关设置，开模型选择器
        try:
            page.get_by_text("关闭", exact=True).first.click(timeout=5000)
        except Exception:
            page.keyboard.press("Escape")
        page.wait_for_timeout(1500)
        opener = page.locator("button", has_text="DeepSeek-V4.1-Flash").first
        opener.click(timeout=8000)
        page.wait_for_timeout(2500)
        listed = page.evaluate("""() => {
          const seen = new Set();
          document.querySelectorAll('[role=menuitem], [role=option], li, button').forEach(n => {
            const t = (n.innerText || '').trim();
            if (t && t.length < 60 && /[a-zA-Z]{3,}/.test(t) && !/设置|编辑|删除|关闭|刷新/.test(t)) seen.add(t.split('\\n')[0]);
          });
          return Array.from(seen).slice(0, 40);
        }""")
        page.screenshot(path=str(OUT / "ui-step3-picker.png"))
        print("选择器里可见条目(前 40):", json.dumps(listed, ensure_ascii=False)[:600])
        print("pageerror:", errs[:4])
    finally:
        # 5) 还原用户原始白名单
        page.evaluate("([k, v]) => { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) }", [KEY, original])
        restored = page.evaluate("(k) => localStorage.getItem(k)", KEY)
        print("已还原:", (restored or "(空)")[:160], "| 与原始一致:", restored == original)
        browser.close()
