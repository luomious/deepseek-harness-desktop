import re
from pathlib import Path

s = Path(r"D:\Deepseek-Harness\plugins\dsh-model-manager\lib\client.js").read_text(encoding="utf-8")
i = s.find("var zh = {")
j = s.find("var en = {")
zh = s[i:j]
en = s[j:j + 5000]
keys = sorted(set(re.findall(r"t\('([a-zA-Z_]+)'", s)))
missing_zh = [k for k in keys if not re.search(r"\b%s: '" % k, zh)]
missing_en = [k for k in keys if not re.search(r"\b%s: '" % k, en)]
print("t() 使用的 key 共 %d 个" % len(keys))
print("zh 缺失:", missing_zh)
print("en 缺失:", missing_en)
