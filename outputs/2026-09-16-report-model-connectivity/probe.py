#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""DSH model connectivity probe.

Reads every provider/model from <DSH_HOME>/settings.yaml (llm-pi-ai.providers),
resolves API keys from <DSH_HOME>/.credentials.yaml, then probes each model with a
minimal /chat/completions request. Emits JSON + a human readable table.

Read-only: performs no writes to DSH config.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
SETTINGS = Path(os.environ.get("PROBE_SETTINGS") or (DSH_HOME / "settings.yaml"))
CREDS = DSH_HOME / ".credentials.yaml"
OUT = Path(__file__).resolve().parent / "probe-result.json"

TIMEOUT = 60
CONCURRENCY = int(os.environ.get("PROBE_CONCURRENCY", "6"))
ONLY = os.environ.get("PROBE_ONLY", "").strip()


def load_creds():
    if not CREDS.exists():
        return {}
    data = yaml.safe_load(CREDS.read_text(encoding="utf-8")) or {}
    return data.get("refs") or {}


def load_providers():
    data = yaml.safe_load(SETTINGS.read_text(encoding="utf-8")) or {}
    block = data.get("llm-pi-ai") or {}
    return block.get("providers") or {}


def chat_url(base):
    b = (base or "").strip().rstrip("/")
    if b.endswith("/chat/completions"):
        return b
    return b + "/chat/completions"


def classify(status, body):
    text = (body or "").lower()
    if status == 200:
        return "OK"
    if status in (401, 403):
        return "AUTH"
    if status == 402:
        return "QUOTA"
    if status == 404:
        if "model" in text and ("not found" in text or "not exist" in text or "no such" in text):
            return "NO_MODEL"
        return "HTTP_404"
    if status == 429:
        return "RATE_LIMIT"
    if status >= 500:
        return "SERVER"
    if status == 400:
        if any(k in text for k in ("insufficient", "balance", "quota", "credit", "欠费", "余额")):
            return "QUOTA"
        if "model" in text and ("not found" in text or "invalid" in text or "unsupported" in text):
            return "NO_MODEL"
        return "BAD_REQUEST"
    return "HTTP_%d" % status


def probe_model(provider, cfg, model, key):
    base = (cfg.get("baseURL") or "").strip()
    mid = model.get("id") if isinstance(model, dict) else str(model)
    rec = {
        "provider": provider,
        "model": mid,
        "baseURL": base,
        "apiKeyEnv": cfg.get("apiKeyEnv"),
        "hasKey": bool(key),
        "url": chat_url(base) if base else None,
    }
    if not base:
        rec.update(status="NO_BASEURL", detail="provider has no baseURL", msec=0)
        return rec
    if not key:
        rec.update(status="NO_KEY", detail="api key env not found in .credentials.yaml", msec=0)
        return rec

    body = json.dumps({
        "model": mid,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        rec["url"],
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "dsh-model-probe/1.0",
        },
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read(4000).decode("utf-8", "replace")
            rec.update(status="OK", http=resp.status, msec=int((time.time() - t0) * 1000),
                       detail=(raw[:200] if raw else ""))
    except urllib.error.HTTPError as e:
        raw = ""
        try:
            raw = e.read(2000).decode("utf-8", "replace")
        except Exception:
            pass
        rec.update(status=classify(e.code, raw), http=e.code,
                   msec=int((time.time() - t0) * 1000), detail=raw[:300])
    except Exception as e:  # transport
        rec.update(status="TRANSPORT", detail="%s: %s" % (type(e).__name__, str(e)[:200]),
                   msec=int((time.time() - t0) * 1000))
    return rec


def main():
    creds = load_creds()
    providers = load_providers()
    tasks = []
    only = [x.strip() for x in ONLY.split(",") if x.strip()]
    for pname, cfg in providers.items():
        if only and pname not in only:
            continue
        key = creds.get(cfg.get("apiKeyEnv") or "")
        for m in cfg.get("models") or []:
            tasks.append((pname, cfg, m, key))

    print("providers=%d models=%d concurrency=%d" % (len(providers), len(tasks), CONCURRENCY))
    results = []
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = [ex.submit(probe_model, *t) for t in tasks]
        for i, f in enumerate(futs, 1):
            r = f.result()
            results.append(r)
            print("[%2d/%2d] %-22s %-42s %s" % (i, len(futs), r["provider"], r["model"], r["status"]),
                  flush=True)

    results.sort(key=lambda r: (r["provider"], r["model"]))
    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\nwrote", OUT)

    from collections import Counter
    print("\n== status summary ==")
    for k, v in Counter(r["status"] for r in results).most_common():
        print("  %-12s %d" % (k, v))

    bad = [r for r in results if r["status"] != "OK"]
    if bad:
        print("\n== failures ==")
        for r in bad:
            print("  %-22s %-42s %-12s %s" % (r["provider"], r["model"], r["status"],
                                              (r.get("detail") or "").replace("\n", " ")[:150]))


if __name__ == "__main__":
    sys.exit(main())
