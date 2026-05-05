#!/usr/bin/env python3
"""
Merges:
  - upstream EN (en_us.json from ars_nouveau jar) — full key list
  - upstream RU (ru_ru.json from baileyholl/Ars-Nouveau) — community-translated 1480 keys
  - my-translations.json — additions for the missing 932 keys

Produces: assets/ars_nouveau/lang/ru_ru.json with everything translated.
Stale RU keys (no longer in EN) are dropped.
Identical RU=EN entries are overridden by my translations.
"""
import json, sys, pathlib

HERE = pathlib.Path(__file__).parent
EN  = json.load(open(HERE / "en_us.json", encoding="utf-8"))
RU_UPSTREAM = json.load(open(HERE / "ru_ru_upstream.json", encoding="utf-8"))
MINE = json.load(open(HERE / "my-translations.json", encoding="utf-8"))

# Build final: every EN key gets RU translation, picking from sources in this priority:
#   1. mine (overrides everything I want to fix or fill)
#   2. upstream RU (community)
#   3. EN value (fallback — should never happen for fully translated set)
final = {}
for k, en_val in EN.items():
    if k in MINE:
        final[k] = MINE[k]
    elif k in RU_UPSTREAM and RU_UPSTREAM[k] != en_val:
        final[k] = RU_UPSTREAM[k]
    else:
        final[k] = en_val  # fallback to English; flag for translation

# Diagnostics
total = len(EN)
mine_used = sum(1 for k in EN if k in MINE)
upstream_used = sum(1 for k in EN if k not in MINE and k in RU_UPSTREAM and RU_UPSTREAM[k] != EN[k])
fallback = sum(1 for k in EN if final[k] == EN[k])
print(f"total keys:    {total}")
print(f"mine used:     {mine_used}")
print(f"upstream used: {upstream_used}")
print(f"english fallback (TODO): {fallback}")

out_dir = HERE / "assets" / "ars_nouveau" / "lang"
out_dir.mkdir(parents=True, exist_ok=True)
out_path = out_dir / "ru_ru.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(final, f, ensure_ascii=False, indent=2)
print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
