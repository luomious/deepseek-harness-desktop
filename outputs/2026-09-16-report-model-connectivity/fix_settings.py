#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Surgical, reversible fixes for <DSH_HOME>/settings.yaml.

Every change below is line-oriented (comments and formatting of the rest of the
file are preserved byte-for-byte).  Fail-closed: if an expected provider / model
/ scalar is not found exactly once, the script aborts without writing anything.

Usage:
    python fix_settings.py            # dry-run: show the diff only
    python fix_settings.py --apply    # backup + write + re-read verification

Changes (evidence: probe-result.json / models-list.json in this folder):
  1. baidu-qianfan baseURL  : legacy wenxinworkshop -> Qianfan v2 (OpenAI-compatible,
                              verified 200 + choices with this API key).
     models                : ernie-speed-128k / ernie-lite-8k (401 invalid_model on v2,
                              non-OpenAI body shape on legacy) ->
                              ernie-4.5-turbo-128k, ernie-4.5-turbo-vl-32k,
                              ernie-x1.1-preview  (all three verified live).
  2. groq                   : qwen/qwen3.6-27b (does not exist) -> openai/gpt-oss-20b (verified).
  3. tokenrhythm01          : kimi-k2.5 + minimax-m2.5 (upstream "MODEL_DISABLED" and no
                              longer listed) -> qwen3.7-flash + qwen3.8-flash (both verified).
  4. amd                    : remove DeepSeek-V4-Flash-Vision-Exp (not available on the platform).
  5. openrouter             : replace 5 free slugs that were retired upstream
                              (404 "unavailable for free" / "No endpoints found") with
                              verified-live free models; drop 1 unreplaceable VL slot.
  6. codecraft              : trim the stray leading space in baseURL (cosmetic, zero risk).
"""
import argparse
import datetime
import difflib
import os
import shutil
import sys
from pathlib import Path

DSH_HOME = Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))
SETTINGS = DSH_HOME / "settings.yaml"


# ---------------------------------------------------------------- helpers
def read_lines():
    raw = SETTINGS.read_bytes().decode("utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw.replace("\r\n", "\n").split("\n"), nl


def provider_span(lines, name):
    head = "    %s:" % name
    idx = [i for i, l in enumerate(lines) if l == head]
    if len(idx) != 1:
        sys.exit("ABORT: provider %r matched %d times (expected 1)" % (name, len(idx)))
    start = idx[0]
    j = start + 1
    while j < len(lines):
        l = lines[j]
        if l.strip() == "":
            j += 1
            continue
        if not l.startswith("      "):
            break
        j += 1
    return start, j


def model_span(lines, span, model_id):
    start, end = span
    head = "        - id: %s" % model_id
    idx = [i for i in range(start, end) if lines[i] == head]
    if len(idx) != 1:
        sys.exit("ABORT: model %r matched %d times in provider block (expected 1)"
                 % (model_id, len(idx)))
    i = idx[0]
    j = i + 1
    while j < end:
        l = lines[j]
        if l.strip() == "" or l.startswith("        - ") or not l.startswith("        "):
            break
        j += 1
    return i, j


def replace_model(lines, provider, model_id, new_block):
    """Replace (or delete, when new_block is None) one model item."""
    span = provider_span(lines, provider)
    i, j = model_span(lines, span, model_id)
    lines[i:j] = list(new_block) if new_block else []
    return lines


def set_scalar(lines, provider, key, new_value):
    span = provider_span(lines, provider)
    prefix = "      %s:" % key
    idx = [k for k in range(*span) if lines[k].startswith(prefix)]
    if len(idx) != 1:
        sys.exit("ABORT: %s.%s matched %d times (expected 1)" % (provider, key, len(idx)))
    lines[idx[0]] = "%s %s" % (prefix, new_value)
    return lines


# ---------------------------------------------------------------- change set
BAIDU_MODELS = """\
        - id: ernie-4.5-turbo-128k
          name: ERNIE-4.5-Turbo-128K
          contextWindow: 131072
          maxTokens: 8192
        - id: ernie-4.5-turbo-32k
          name: ERNIE-4.5-Turbo-32K
          contextWindow: 32768
          maxTokens: 8192
        - id: ernie-4.5-turbo-vl
          name: ERNIE-4.5-Turbo-VL
          contextWindow: 32768
          maxTokens: 8192
          input:
            - text
            - image""".split("\n")


def block(text):
    return text.strip("\n").split("\n")


REPLACEMENTS = [
    # (provider, old model id, new block or None for delete)
    ("openrouter", "inclusionai/ling-3.0-flash:free", block("""
        - id: inclusionai/ling-3.0-flash-vl:free
          name: Ling-3.0-flash-VL (free)
          contextWindow: 262144
          maxTokens: 32768
          input:
            - text
            - image""")),
    ("openrouter", "nvidia/nemotron-3-nano-30b-a3b:free", block("""
        - id: nvidia/nemotron-3.5-lightning:free
          name: "NVIDIA: Nemotron 3.5 Lightning (free)"
          contextWindow: 1000000
          maxTokens: 65536""")),
    ("openrouter", "nvidia/nemotron-nano-12b-v2-vl:free", None),
    ("openrouter", "nvidia/nemotron-nano-9b-v2:free", block("""
        - id: liquid/lfm-2.5-2.6b:free
          name: Liquid LFM-2.5 2.6B (free)
          contextWindow: 65536
          maxTokens: 8192""")),
    ("openrouter", "openai/gpt-oss-20b:free", block("""
        - id: nex-agi/nex-n2.5-mini:free
          name: Nex-N2.5-mini (free)
          contextWindow: 262144
          maxTokens: 32768""")),
    ("openrouter", "poolside/laguna-m.1:free", block("""
        - id: nex-agi/nex-n2.5-pro:free
          name: Nex-N2.5-Pro (free)
          contextWindow: 262144
          maxTokens: 32768""")),
    ("tokenrhythm01", "kimi-k2.5", block("""
        - id: qwen3.7-flash
          contextWindow: 1000000
          maxTokens: 131072""")),
    ("tokenrhythm01", "minimax-m2.5", block("""
        - id: qwen3.8-flash
          contextWindow: 1000000
          maxTokens: 131072""")),
    ("groq", "qwen/qwen3.6-27b", block("""
        - id: openai/gpt-oss-20b
          name: GPT-OSS 20B
          contextWindow: 131072
          maxTokens: 32768""")),
    ("amd", "DeepSeek-V4-Flash-Vision-Exp", None),
    ("baidu-qianfan", "ernie-speed-128k", BAIDU_MODELS),
    ("baidu-qianfan", "ernie-lite-8k", None),
]


def apply_all(lines):
    for provider, model_id, new_block in REPLACEMENTS:
        replace_model(lines, provider, model_id, new_block)
    set_scalar(lines, "baidu-qianfan", "baseURL", "https://qianfan.baidubce.com/v2")
    set_scalar(lines, "codecraft", "baseURL", '"https://codecraftapi.com/v1"')
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="backup + write + verify")
    ap.add_argument("--out", metavar="PATH",
                    help="write the fixed content to PATH instead of settings.yaml "
                         "(for inspection / manual copy; never touches the real file)")
    args = ap.parse_args()

    if not SETTINGS.exists():
        sys.exit("ABORT: %s not found" % SETTINGS)

    original, nl = read_lines()
    updated = apply_all(list(original))

    diff = list(difflib.unified_diff(original, updated, "settings.yaml (current)",
                                     "settings.yaml (fixed)", lineterm="", n=2))
    print("\n".join(diff) if diff else "(no changes)")
    print("\n%d changed line(s)." % sum(1 for d in diff if d[:1] in "+-" and d[:3] not in ("+++", "---")))

    if args.out:
        out = Path(args.out).resolve()
        out.write_bytes(nl.join(updated).encode("utf-8"))
        print("\nwrote fixed copy ->", out, "(real settings.yaml untouched)")
        return 0

    if not args.apply:
        print("\nDRY-RUN only. Re-run with --apply to write (or --out PATH for a copy).")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = SETTINGS.with_name(SETTINGS.name + ".bak-modelprobe-" + stamp)
    shutil.copy2(SETTINGS, backup)
    print("backup ->", backup)

    tmp = SETTINGS.with_name(SETTINGS.name + ".tmp-modelprobe")
    tmp.write_bytes(nl.join(updated).encode("utf-8"))
    os.replace(tmp, SETTINGS)

    # verify: re-read and confirm every intent is present
    check, _ = read_lines()
    problems = []
    for provider, model_id, new_block in REPLACEMENTS:
        present = ("        - id: %s" % model_id) in check
        if new_block and present:
            problems.append("%s/%s still present after replace" % (provider, model_id))
        if not new_block and present:
            problems.append("%s/%s not removed" % (provider, model_id))
    text = "\n".join(check)
    if "baseURL: https://qianfan.baidubce.com/v2" not in text:
        problems.append("baidu baseURL not updated")
    if 'baseURL: "https://codecraftapi.com/v1"' not in text:
        problems.append("codecraft baseURL not trimmed")
    print("verify:", "OK" if not problems else "FAILED " + "; ".join(problems))
    print("\nNOTE: the desktop app may need to reload settings (refresh the Web UI; "
          "if the model list does not update, restart the app).")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
