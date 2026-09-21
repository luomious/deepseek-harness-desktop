#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Re-probe the round-1 non-OK models, serially with spacing, to separate
transient rate limits from hard failures."""
import json
import time
from pathlib import Path

import probe

HERE = Path(__file__).resolve().parent
prev = json.loads((HERE / "probe-result.json").read_text(encoding="utf-8"))
targets = [r for r in prev if r["status"] != "OK"]

creds = probe.load_creds()
providers = probe.load_providers()

out = []
for r in targets:
    cfg = providers[r["provider"]]
    key = creds.get(cfg.get("apiKeyEnv") or "")
    model = {"id": r["model"]}
    res = probe.probe_model(r["provider"], cfg, model, key)
    res["first_status"] = r["status"]
    out.append(res)
    print("%-22s %-42s %-12s -> %-12s %s" % (r["provider"], r["model"], r["status"], res["status"],
                                             (res.get("detail") or "").replace("\n", " ")[:110]), flush=True)
    time.sleep(1.2)

(HERE / "probe-retry.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

from collections import Counter
print("\n== retry summary ==")
for k, v in Counter(x["status"] for x in out).most_common():
    print("  %-12s %d" % (k, v))
still = [x for x in out if x["status"] != "OK"]
print("\nstill failing: %d" % len(still))
