"""清掉被移除插件留在浏览器里的 flag（只动它自己的两个键，绝不碰白名单键）。"""
import json

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:43120"
MM_KEYS = ["dsh.model-manager.showPanel", "dsh.model-manager.hideLegacyPanel"]
KEEP = "dsh.model-whitelist.v1"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)
    before = page.evaluate("([mm, keep]) => ({ mm: mm.map(k => [k, localStorage.getItem(k)]), keep: localStorage.getItem(keep) })",
                           [MM_KEYS, KEEP])
    page.evaluate("(mm) => mm.forEach(k => localStorage.removeItem(k))", MM_KEYS)
    after = page.evaluate("([mm, keep]) => ({ mm: mm.map(k => [k, localStorage.getItem(k)]), keep: localStorage.getItem(keep), allKeys: Object.keys(localStorage).filter(k => /model/.test(k)) })",
                          [MM_KEYS, KEEP])
    print("清理前:", json.dumps(before, ensure_ascii=False))
    print("清理后:", json.dumps(after, ensure_ascii=False))
    print("白名单键是否保住:", before["keep"] is not None and before["keep"] == after["keep"])
    browser.close()
