#!/usr/bin/env python3
"""Join camp placement addresses onto the events pack, BY CAMP NAME.

WHY THIS EXISTS (owner ruling 2026-08-19): the Playa Events listing publishes
WHAT is happening weeks early, but WHERE camps sit is embargoed until days
before gate (2026: public Aug 23, 12am PDT). Until then, a prior-year
placement join gives the app the real intended experience — event cards with
clock addresses feeding the compass — as long as every joined address is
CLEARLY LABELED as last year's. Rerun with the real camp file the moment it
publishes and the label drops automatically (year matches the pack).

TEST-ONLY DATA NEVER SHIPS PUBLICLY: run this against a build/test copy for
phone builds, or against the real pack ONLY with current-year camp data.

Usage:
  python3 tools/join_camp_addresses.py \
      --events assets/packs/brc-events-2026/events.json \
      --camps iburn-camp-2025.json --camp-year 2025 --event-year 2026 \
      [--out events.json]        # default: in place

Address normalization: iBurn location_strings come letter-first ("C & 5:45")
or clock-first; output is clock-first ("5:45 & C") to match the app's idiom.
A prior-year join appends " ('YY)" — the app's parser ignores the suffix.
"""
import argparse, json, re, sys

def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())

CLOCK = re.compile(r"\b(\d{1,2}:\d{2})\b")
RING = re.compile(r"(?:^|[\s&])([A-La-l])(?:$|[\s&])")

def normalize_address(loc: str) -> str | None:
    loc = loc.strip()
    if not loc:
        return None
    m = CLOCK.search(loc)
    if not m:
        return None
    clock = m.group(1)
    if "esplanade" in loc.lower():
        return f"{clock} & Esplanade"
    r = RING.search(loc)
    if r:
        return f"{clock} & {r.group(1).upper()}"
    return None  # portals/odd shapes: skip rather than guess

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--camps", required=True)
    ap.add_argument("--camp-year", type=int, required=True)
    ap.add_argument("--event-year", type=int, required=True)
    ap.add_argument("--out")
    ap.add_argument("--no-version-bump", action="store_true")
    a = ap.parse_args()

    events = json.load(open(a.events))
    rows = events if isinstance(events, list) else events["events"]
    camps = json.load(open(a.camps))
    cmap = {}
    for c in camps:
        addr = c.get("location_string") or ""
        n = normalize_address(addr)
        if c.get("name") and n:
            cmap[norm(c["name"])] = n
    label = "" if a.camp_year == a.event_year else f" ('{a.camp_year % 100:02d})"

    joined = skipped = 0
    for e in rows:
        camp = (e.get("camp") or "").strip() or (e.get("location") or "").strip()
        cur = (e.get("location") or "").strip()
        if CLOCK.search(cur):
            skipped += 1  # already addressed — never overwrite real data
            continue
        addr = cmap.get(norm(camp)) if camp else None
        if addr:
            e["location"] = f"{addr}{label}"
            joined += 1
    out = a.out or a.events
    json.dump(events, open(out, "w"), indent=1, ensure_ascii=False)
    # The app reimports a builtin pack ONLY on a manifest version bump
    # (src/events/db.ts seedBuiltinPacks) — joined data without a bump is
    # invisible on any phone that already imported the pack. Bump by default.
    import os
    mp = os.path.join(os.path.dirname(a.events), "pack.json")
    if os.path.exists(mp) and not a.no_version_bump:
        m = json.load(open(mp))
        m["version"] = int(m.get("version", 0)) + 1
        json.dump(m, open(mp, "w"), indent=2, ensure_ascii=False)
        print(f"pack version bumped -> {m['version']}")
    print(f"joined {joined} events to {a.camp_year} placements"
          f" ({label.strip() or 'no label — current year'});"
          f" {skipped} already addressed; {len(rows)-joined-skipped} unmatched")
    return 0

if __name__ == "__main__":
    sys.exit(main())
