#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Fetch each provider's authoritative /models list (read-only)."""
import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
settings = yaml.safe_load((DSH_HOME / "settings.yaml").read_text(encoding="utf-8"))
creds = (yaml.safe_load((DSH_HOME / ".credentials.yaml").read_text(encoding="utf-8")) or {}).get("refs") or {}
providers = settings["llm-pi-ai"]["providers"]


def url_for(base):
    b = (base or "").strip().rstrip("/")
    if b.endswith("/chat/completions"):
        b = b[: -len("/chat/completions")]
    return b + "/models"


def one(item):
    name, cfg = item
    base = (cfg.get("baseURL") or "").strip()
    key = creds.get(cfg.get("apiKeyEnv") or "") or ""
    out = {"provider": name, "url": url_for(base), "status": None, "ids": [], "raw": ""}
    req = urllib.request.Request(out["url"], headers={
        "Authorization": "Bearer " + key, "Accept": "application/json",
        "User-Agent": "dsh-model-probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body = r.read().decode("utf-8", "replace")
            out["status"] = r.status
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        body = ""
        try:
            body = e.read(1500).decode("utf-8", "replace")
        except Exception:
            pass
        out["raw"] = body[:300]
        return out
    except Exception as e:
        out["status"] = "ERR"
        out["raw"] = "%s: %s" % (type(e).__name__, str(e)[:200])
        return out
    try:
        data = json.loads(body)
        items = data.get("data") if isinstance(data, dict) else data
        for m in items or []:
            if isinstance(m, dict):
                out["ids"].append(m.get("id") or m.get("model") or m.get("name"))
            else:
                out["ids"].append(str(m))
    except Exception as e:
        out["raw"] = "parse:%s %s" % (type(e).__name__, body[:200])
    return out


with ThreadPoolExecutor(max_workers=6) as ex:
    res = list(ex.map(one, providers.items()))

res.sort(key=lambda r: r["provider"])
out_path = Path(__file__).resolve().parent / "models-list.json"
out_path.write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")

for r in res:
    cfg = providers[r["provider"]]
    configured = [(m.get("id") if isinstance(m, dict) else str(m)) for m in (cfg.get("models") or [])]
    avail = [i for i in r["ids"] if i]
    missing = [c for c in configured if c not in avail]
    print("\n=== %s  (%s)  status=%s  available=%d" % (r["provider"], r["url"], r["status"], len(avail)))
    if r["raw"]:
        print("   raw:", r["raw"].replace("\n", " ")[:200])
    if missing and avail:
        print("   CONFIGURED-BUT-NOT-LISTED: %s" % ", ".join(missing))
    if avail:
        sample = avail[:60]
        print("   ids:", ", ".join(sample) + (" ..." if len(avail) > 60 else ""))
print("\nwrote", out_path)
