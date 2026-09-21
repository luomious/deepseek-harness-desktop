"""Round 4：用网络拦截把「真实全量扫描结果」喂给运行中的面板，验证有数据时的 UI 数据通路。

为什么这样验：运行中的 host 是旧版（解析不出目标、扫描 0 结果），但它提供 /model-manager/state；
client 侧是新版。用 Playwright 拦截该请求并返回 harness 实跑出来的 85 条真实结果，
就能在**不重启**的前提下验证：概览计数、状态色、过滤、排序、sparkline、头部图标数字与颜色。
"""
import json
from collections import Counter
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "outputs" / "2026-09-16-doc-model-manager-connectivity-notused"
scan = json.loads((HERE / "harness-scan-result.json").read_text(encoding="utf-8"))

entries = {}
for i, r in enumerate(scan["results"]):
    hist = [{"t": r["testedAt"] - (5 - j) * 60000, "ms": max(120, (r.get("latencyMs") or 300) + (j - 2) * 90),
             "ok": r["ok"] if j % 3 else not r["ok"]} for j in range(5)]
    entries[r["provider"] + "/" + r["model"]] = {
        "status": "ok" if r["ok"] else "fail",
        "category": r["category"],
        "latencyMs": r.get("latencyMs") or 0,
        "httpStatus": r.get("httpStatus"),
        "error": r.get("error") or "",
        "testedAt": r["testedAt"] + i,
        "fails": 0 if r["ok"] else 2,
        "history": hist,
    }
state = {
    "ok": True, "version": 1, "updatedAt": scan["results"][0]["testedAt"] + len(entries),
    "lastScan": {"jobId": "harness", "startedAt": scan["results"][0]["testedAt"],
                 "finishedAt": scan["results"][0]["testedAt"] + 60000 == 0 or scan["results"][0]["testedAt"] + 60000,
                 "total": len(entries), "done": len(entries), "mode": "scan"},
    "entries": entries, "running": None,
}
expect_ok = sum(1 for r in scan["results"] if r["ok"])
expect_warn = sum(1 for r in scan["results"] if r["category"] in ("rate_limit", "server", "timeout", "network"))
expect_bad = sum(1 for r in scan["results"] if r["category"] in ("auth", "quota", "no_model", "model_disabled", "bad_request", "empty", "config"))
print(f"喂给面板的真实数据：ok={expect_ok} warn={expect_warn} bad={expect_bad} 共 {len(entries)} 条")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width": 1500, "height": 950})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:200]))
    page.route("**/model-manager/state*", lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(state)))
    page.goto("http://127.0.0.1:43120", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)

    # 头部图标（先进会话视图）
    page.get_by_text("模型连通性测试与配置", exact=False).first.click(timeout=8000)
    page.wait_for_timeout(5000)
    head = page.evaluate("""() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').includes('📶'));
      if (!b) return null;
      const dot = b.querySelector('.mm-dot');
      return { title: b.getAttribute('title'), dot: dot ? getComputedStyle(dot).backgroundColor : '' };
    }""")
    print("头部图标:", json.dumps(head, ensure_ascii=False))
    page.locator("button", has_text="📶").first.click(timeout=6000)
    page.wait_for_timeout(2000)
    pop = page.evaluate("() => { const m = document.querySelector('.mm-menu'); return m ? m.innerText.replace(/\\n/g,' | ') : '' }")
    print("图标浮层:", pop[:200])
    page.screenshot(path=str(HERE / "ui-step4-header-withdata.png"))
    page.keyboard.press("Escape")

    # 设置 → 模型 面板
    page.get_by_text("设置", exact=True).first.click(timeout=8000)
    page.wait_for_timeout(2000)
    page.get_by_text("模型", exact=True).first.click(timeout=8000)
    page.wait_for_timeout(4000)

    def panel_stats():
        return page.evaluate("""() => {
          const rows = Array.from(document.querySelectorAll('.mm-row'));
          const overview = (Array.from(document.querySelectorAll('div')).map(d=>d.innerText||'')
            .find(t => /\\d+ 厂商 · \\d+ 模型/.test(t)) || '').split('\\n')[0];
          const colors = {};
          rows.forEach(r => { const d = r.querySelector('.mm-dot'); if (d) { const c = getComputedStyle(d).backgroundColor; colors[c]=(colors[c]||0)+1; } });
          return { rowCount: rows.length, overview: overview.slice(0, 120), dotColors: colors,
                   sparklines: document.querySelectorAll('.mm-row svg').length };
        }""")
    allv = panel_stats()
    print("\n[全部] ", json.dumps(allv, ensure_ascii=False))
    page.screenshot(path=str(HERE / "ui-step4-panel-all.png"), full_page=False)

    for label, key in (("仅异常", "bad"), ("仅可用", "ok"), ("未测试", "untested")):
        page.locator("button", has_text=label).first.click(timeout=6000)
        page.wait_for_timeout(1800)
        s = panel_stats()
        print(f"[{label}] ", json.dumps(s, ensure_ascii=False))
        if key == "bad":
            page.screenshot(path=str(HERE / "ui-step4-panel-issues.png"))
    page.locator("button", has_text="全部").first.click(timeout=6000)
    page.wait_for_timeout(1200)

    # 排序切换不应炸
    for opt in ("按名称", "按状态", "按延迟"):
        page.select_option("select", label=opt)
        page.wait_for_timeout(900)
    print("排序切换后仍无 pageerror:", errs[:3] == [] or errs[:3])
    print("pageerror:", errs[:5])
    browser.close()
