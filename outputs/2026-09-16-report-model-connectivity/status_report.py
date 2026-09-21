#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Build the per-model availability record (markdown + csv) from the post-fix probe."""
import csv
import json
import os
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
final = json.loads((HERE / "probe-final.json").read_text(encoding="utf-8"))
retry_path = Path(os.environ.get("PROBE_OUT_RETRY") or (HERE / "probe-final-retry.json"))
retry = {}
if retry_path.exists():
    retry = {r["model"] + "@" + r["provider"]: r
             for r in json.loads(retry_path.read_text(encoding="utf-8"))}

ACCOUNT = {
    "xiaomi-token-plan-cn": ("账户", "API Key 无效（/models 同样 401 invalid_key）"),
    "duoyuanx": ("账户", "上游：该分组下未配置可用的 Codex 美元预算"),
    "justdowork": ("账户", "Cloudflare 403 Attention Required（服务端拦截）"),
    "tokenrouter": ("账户", "模型 slug 已下线（上游无可用通道）＋账户余额 $0"),
}
LIMIT = {
    "RATE_LIMIT": "上游限流/额度用尽（会恢复）",
    "SERVER": "上游服务端错误（会恢复）",
    "TRANSPORT": "超时/连接异常",
}
DEAD = {
    "NO_MODEL": "上游已无此模型",
    "HTTP_404": "上游 404：模型已下线",
    "BAD_REQUEST": "上游拒绝（如 MODEL_DISABLED）",
}


def classify(r, retried):
    p, s = r["provider"], r["status"]
    detail = (r.get("detail") or "").replace("\n", " ")
    retried_ok = retried is not None and retried.get("status") == "OK"
    if retried_ok:
        return "可用", "✅", "复测通过（首轮为瞬时失败：%s）" % s
    if s == "OK":
        if "choices" in (r.get("detail") or ""):
            return "可用", "✅", ""
        return "可用", "✅", "200（响应体合法，choices 在截断之后）"
    if p in ACCOUNT and s != "OK":
        return ACCOUNT[p][0], "🟠", ACCOUNT[p][1] + ("：" + detail[:70] if detail else "")
    if s in LIMIT:
        return "限流", "🟡", LIMIT[s] + "：" + detail[:90]
    if s == "QUOTA":
        return "额度", "🟡", "上游额度/账单拒绝：" + detail[:90]
    if s in DEAD:
        return "已下线", "❌", DEAD[s] + "：" + detail[:110]
    if s == "AUTH":
        return "账户", "🟠", "未授权：" + detail[:90]
    if s == "SERVER":
        return "限流", "🟡", LIMIT[s] + "：" + detail[:110]
    return s, "❔", detail[:110]


rows = []
for r in sorted(final, key=lambda x: (x["provider"], x["model"])):
    key = r["model"] + "@" + r["provider"]
    cat, mark, note = classify(r, retry.get(key))
    rows.append({"provider": r["provider"], "model": r["model"], "status": r["status"],
                 "category": cat, "mark": mark, "note": note})

with (HERE / "model-status.csv").open("w", encoding="utf-8-sig", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=["provider", "model", "status", "category", "note"],
                       extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)

cnt = Counter(x["category"] for x in rows)
by_prov = {}
for x in rows:
    by_prov.setdefault(x["provider"], []).append(x)

lines = ["# 模型可用状态清单（修复后实测）", "",
         "数据来源：`probe-final.json`（全量 %d 个模型）+ `probe-final-retry.json`（失败项串行复测）。" % len(rows), "",
         "图例：✅ 可用　🟡 限流/上游异常（会自行恢复）　🟠 账户或 Key 问题（需你处理）　❌ 上游已下线（建议清理）", "",
         "**合计：可用 %d / %d**" % (cnt.get("可用", 0), len(rows)), "",
         "| 厂商 | 模型 | 状态 | 说明 |", "|---|---|---|---|"]
for p, items in by_prov.items():
    for x in items:
        lines.append("| %s | `%s` | %s %s | %s |" % (p, x["model"], x["mark"], x["category"], x["note"]))

lines += ["", "## 统计", ""]
for k, v in cnt.most_common():
    lines.append("- %s：%d" % (k, v))
for p, items in by_prov.items():
    ok = sum(1 for x in items if x["category"] == "可用")
    lines.append("- %s：%d/%d" % (p, ok, len(items)))

lines += ["", "## 建议清理清单（你决定删或修）", "",
          "| 厂商 | 模型数 | 上游原话 | 建议 |", "|---|---|---|---|",
          "| tokenrouter | 1 | `No available channel for model z-ai/glm-5.3-free` + `remaining credit limit: $0` | 删掉该 provider，或充值并把 slug 换成站内有效模型（如 `z-ai/glm-5.2`） |",
          "| xiaomi-token-plan-cn | 3 | `Invalid API Key`（`/models` 也是 401） | 换新 key 写入 `.credentials.yaml` 的 `XIAOMI_TOKEN_PLAN_CN_API_KEY`；不打算用就删 provider |",
          "| justdowork | 2 | Cloudflare `Attention Required` 403（cf-ray 命中 NRT 节点） | 服务端拦截，本地无法绕过；大概率站点已挂，建议删 |",
          "| duoyuanx | 5 | `该分组下未配置可用的 Codex 美元预算` | 到站点给分组配预算；不打算用就删 |",
          ""]
lines += ["", "## 需你在上游账户处理（配置改不了）", ""]
for x in [x for x in rows if x["category"] == "账户"]:
    lines.append("- `%s` / `%s` —— %s" % (x["provider"], x["model"], x["note"]))
lines += ["", "## 限流/上游异常（无需改动，等恢复）", ""]
for x in [x for x in rows if x["category"] in ("限流", "额度")]:
    lines.append("- `%s` / `%s` —— %s" % (x["provider"], x["model"], x["note"]))

(HERE / "MODEL-STATUS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

print("total %d -> %s" % (len(rows), dict(cnt)))
for cat in ("已下线", "账户", "限流", "额度"):
    print("\n-- %s --" % cat)
    for x in [x for x in rows if x["category"] == cat]:
        print("  %-22s %-44s %s" % (x["provider"], x["model"], x["note"][:90]))
print("\nwrote MODEL-STATUS.md / model-status.csv")
