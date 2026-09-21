"""Round 2 之三：新引擎（harness 全量扫描）与既有 Python 探针结论逐模型交叉比对。

判据（诚实口径）：
  - 硬失败类（auth / quota / no_model / model_disabled / bad_request / config）两边必须一致，
    不一致就是真 bug；
  - ok ↔ 瞬时类（rate_limit / server / timeout / network）之间的差异算「上游瞬时」，
    不算引擎问题，但要逐条列出以免掩盖问题。
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = HERE.parent / "outputs" / "2026-09-16-report-model-connectivity"

harness = json.loads((HERE / "harness-scan-result.json").read_text(encoding="utf-8"))
h = {r["provider"] + "/" + r["model"]: r for r in harness["results"]}

py = {}
for name in ("probe-final.json", "probe-final-retry.json"):
    for r in json.loads((REPORT / name).read_text(encoding="utf-8")):
        k = r["provider"] + "/" + r["model"]
        prev = py.get(k)
        # 复测通过则覆盖首轮结论（与当时报告口径一致）
        if prev is None or (r["status"] == "OK" and prev["status"] != "OK"):
            py[k] = r

HARD = {"auth", "quota", "no_model", "model_disabled", "bad_request", "config"}
TRANSIENT = {"rate_limit", "server", "timeout", "network", "skipped"}


def py_cat(r):
    s = r["status"]
    if s == "OK":
        return "ok"
    if s in ("AUTH", "QUOTA", "NO_MODEL", "BAD_REQUEST", "HTTP_404", "TIMEOUT"):
        d = (r.get("detail") or "").lower()
        if s == "AUTH":
            return "auth"
        if s == "QUOTA":
            return "quota"
        if s in ("NO_MODEL", "HTTP_404"):
            return "no_model"
        if "disabled" in d or "已关闭" in d:
            return "model_disabled"
        return "bad_request"
    if s == "RATE_LIMIT":
        return "rate_limit"
    if s == "SERVER":
        return "server"
    if s == "TRANSPORT":
        return "network"
    return s.lower()


both_ok, hard_mismatch, transient_diff, only_one = [], [], [], []
for k in sorted(set(h) | set(py)):
    hh, pp = h.get(k), py.get(k)
    if hh is None or pp is None:
        only_one.append((k, "harness" if pp is None else "python"))
        continue
    hc, pc = hh["category"], py_cat(pp)
    if hc == "ok" and pc == "ok":
        both_ok.append(k)
    elif hc != "ok" and pc != "ok":
        if hc == pc:
            both_ok.append(k + " [同分类:" + hc + "]")        # 两边都失败且分类相同 = 一致
        elif hc in HARD and pc in HARD:
            hard_mismatch.append((k, hc, pc))
        elif hc in HARD or pc in HARD:
            hard_mismatch.append((k, hc, pc))                  # 一边硬失败一边瞬时 → 需要人看
        else:
            transient_diff.append((k, hc, pc))
    else:
        diff = hc if hc != "ok" else pc
        if diff in HARD:
            hard_mismatch.append((k, hc, pc))
        else:
            transient_diff.append((k, hc, pc))

print("harness: %d/%d ok, 用时 %ss, 分类 %s" % (harness["ok"], harness["total"], harness["elapsedSec"], harness["byCategory"]))
print("python : %d 条记录（含复测合并）" % len(py))
print()
print("一致: %d" % len(both_ok))
print("硬失败不一致(必须为 0): %d" % len(hard_mismatch))
for k, hc, pc in hard_mismatch:
    print("   !! %-52s harness=%-14s python=%s" % (k, hc, pc))
print("瞬时差异(上游状态变化，可接受): %d" % len(transient_diff))
for k, hc, pc in transient_diff:
    print("   ~  %-52s harness=%-14s python=%s" % (k, hc, pc))
print("只在一边出现: %d" % len(only_one))
for k, side in only_one:
    print("   ?  %-52s 仅 %s 有" % (k, side))
