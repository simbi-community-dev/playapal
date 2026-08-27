#!/usr/bin/env python3
"""Build the events pack rows straight from the Burning Man API pulls.

Supersedes the playaevents HTML crawl (tools/fetch_playaevents.py) now that
the key exists: one JSON per endpoint, no scraping, and the camp join is by
UID — exact — instead of the name-normalized join the pre-key era needed.

INPUTS (raw API JSON, pulled with the key; the raw files stay OUT of the
repo — they carry contact_email and other fields we never ship):
  --events bm-event-2026.json   (occurrence_set expands to one row each)
  --camps  bm-camp-2026.json    (uid -> name + location_string)

EMBARGO RULES, enforced here so a violating row cannot exist in the pack:
  - hosted_by_camp   -> camp NAME + camp ADDRESS. Camp locations may be
    shown to users from the first Sunday of build week 12:01am (2026:
    Aug 23). The pack is built for the Aug 27 release, after that line;
    building earlier is developer use, which the ToS allows. --no-addresses
    strips them for any earlier public artifact.
  - located_at_art   -> the art piece's NAME ONLY ("at <name>"), never its
    address: art locations stay hidden until Gate opens (Aug 30), after the
    owner is on playa. The sealed-locations feature handles gate-day reveal
    separately; the EVENTS pack never carries an art address at all.
  - other_location   -> free text as published (public venues).

Output: the same row shape the app's pack already uses
  {title, date, day, desc, camp, location, time_start, time_end}
written as events.json (a list), plus a summary to stdout. Feed the result
into the existing pack folder and bump pack.json's version by hand or with
--pack-dir which does both.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
             "Saturday", "Sunday"]


def clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").replace("\r", " ")).strip()


def norm_addr(loc: str) -> str:
    """Clock-first ('5:45 & C') to match the app's idiom; pass through
    shapes we do not recognise (portals, plazas) rather than guess."""
    loc = clean(loc)
    m = re.search(r"\b(\d{1,2}:\d{2})\b", loc)
    if not m:
        return loc
    clock = m.group(1)
    if "esplanade" in loc.lower():
        return f"{clock} & Esplanade"
    r = re.search(r"(?:^|[\s&])([A-La-l])(?:$|[\s&])", loc)
    if r:
        return f"{clock} & {r.group(1).upper()}"
    return loc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", required=True)
    ap.add_argument("--camps", required=True)
    ap.add_argument("--art", help="optional: resolves located_at_art uids to names")
    ap.add_argument("--out", required=True, help="events.json to write")
    ap.add_argument("--no-addresses", action="store_true",
                    help="strip camp addresses (for any pre-Aug-23 public artifact)")
    a = ap.parse_args()

    events = json.load(open(a.events))
    camps = {c["uid"]: c for c in json.load(open(a.camps))}
    art_names: dict[str, str] = {}
    if a.art:
        art_names = {x["uid"]: clean(x.get("name")) for x in json.load(open(a.art))}

    rows = []
    skipped_no_time = 0
    art_located = 0
    for e in events:
        title = clean(e.get("title"))
        desc = clean(e.get("print_description") or e.get("description"))
        camp_name = ""
        location = ""
        if e.get("hosted_by_camp"):
            c = camps.get(e["hosted_by_camp"])
            if c:
                camp_name = clean(c.get("name"))
                if not a.no_addresses:
                    location = norm_addr(c.get("location_string") or "")
        elif e.get("located_at_art"):
            # NAME only — the address is embargoed until Gate (see header).
            name = art_names.get(e["located_at_art"], "")
            location = f"at {name}" if name else ""
            art_located += 1
        elif e.get("other_location"):
            location = clean(e.get("other_location"))

        for occ in e.get("occurrence_set") or []:
            try:
                start = dt.datetime.fromisoformat(occ["start_time"])
                end = dt.datetime.fromisoformat(occ["end_time"])
            except (KeyError, ValueError):
                skipped_no_time += 1
                continue
            rows.append({
                "title": title,
                "date": start.date().isoformat(),
                "day": DAY_NAMES[start.weekday()],
                "desc": desc,
                "camp": camp_name,
                "location": location,
                "time_start": start.strftime("%H:%M"),
                "time_end": end.strftime("%H:%M"),
            })

    rows.sort(key=lambda r: (r["date"], r["time_start"], r["title"]))
    pathlib.Path(a.out).write_text(json.dumps(rows, indent=1) + "\n", encoding="utf-8")

    with_addr = sum(1 for r in rows if r["location"] and "&" in r["location"])
    print(f"{len(rows)} occurrence rows from {len(events)} events "
          f"-> {a.out}")
    print(f"  with a clock address: {with_addr}")
    print(f"  at an art piece (name only, address embargoed): {art_located}")
    print(f"  occurrences skipped for unparseable times: {skipped_no_time}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
