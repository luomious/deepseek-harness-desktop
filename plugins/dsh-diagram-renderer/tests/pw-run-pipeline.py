# -*- coding: utf-8 -*-
import json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, channel="chrome")
    pg = b.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
    pg.goto("file:///D:/Deepseek-Harness/plugins/dsh-diagram-renderer/pipeline-test2.html")
    pg.wait_for_timeout(1500)
    out = pg.evaluate("() => window.__testOut")
    b.close()
print(json.dumps({"errors": errors, "out": out}, ensure_ascii=False, indent=1))
