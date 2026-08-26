#!/usr/bin/env python3
"""Convert real event data into a Playa Angel data pack.

Two input formats:

1. iBurn-Data APIData (RECOMMENDED - per BMorg API TOS we consume the
   published iBurnApp/iBurn-Data per-year JSON instead of scraping):

     python3 tools/load_events.py \
       --iburn-events event.json --iburn-camps camp.json \
       --id brc-events-2026 --name "BRC Events 2026" \
       --out-pack build/brc-events-2026

   Get the inputs from https://github.com/iBurnApp/iBurn-Data at
   data/<year>/APIData/APIData.bundle/{event,camp}.json (2015-2025 history
   available today; 2026 lands when BMorg publishes).

2. Generic JSONL - one JSON object per line with the app's own event keys
   (title, date [YYYY-MM-DD], time_start [HH:MM], time_end, desc, camp,
   location):

     python3 tools/load_events.py --jsonl scraped.jsonl \
       --id my-events --name "My Events" --out-pack build/my-events

Output: a data-pack folder (pack.json + events.json) ready to import in the
app's Packs screen, or to replace assets/packs/brc-events-2026/ as the
built-in pack (bump the version in pack.json to force a reseed).

Optionally --db emits a SQLite database with the same events table + an FTS5
index for local inspection of what the app-side search will see.

Stdlib only; requires Python 3.9+.
"""

import argparse
import datetime as dt
import json
import pathlib
import re
import sqlite3
import sys

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")
WEEKDAYS = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]


def weekday_name(date_iso: str) -> str:
    y, m, d = (int(x) for x in date_iso.split("-"))
    return WEEKDAYS[dt.date(y, m, d).weekday()]


def clean_time(value) -> str:
    s = str(value or "").strip()
    return s if TIME_RE.match(s) else ""


def normalize(raw: dict, source: str, index: int, errors: list) -> dict | None:
    """Validate/coerce one event into the app schema. Mirrors the checks in
    src/packs/installPack.ts - keep the two in sync."""
    title = str(raw.get("title") or "").strip()
    date = str(raw.get("date") or "").strip()
    if not title:
        errors.append(f"{source} #{index}: missing title - skipped")
        return None
    if not DATE_RE.match(date):
        errors.append(f"{source} #{index} ({title!r}): bad date {date!r} - skipped")
        return None
    return {
        "title": title,
        "desc": str(raw.get("desc") or "").strip(),
        "day": weekday_name(date),  # always derived from date
        "date": date,
        "time_start": clean_time(raw.get("time_start")),
        "time_end": clean_time(raw.get("time_end")),
        "camp": str(raw.get("camp") or "").strip(),
        "location": str(raw.get("location") or "").strip(),
    }


def camp_location_string(camp: dict) -> str:
    """Best human-readable address for an iBurn camp record."""
    loc = camp.get("location_string")
    if loc:
        return str(loc)
    location = camp.get("location") or {}
    inter = location.get("intersection")
    front = location.get("frontage")
    if inter and front:
        return f"{inter} & {front}"
    return str(front or inter or "")


def load_iburn(events_path: str, camps_path: str | None, errors: list) -> list:
    events = json.load(open(events_path))
    camps = {}
    if camps_path:
        camps = {c["uid"]: c for c in json.load(open(camps_path))}
    out = []
    for i, ev in enumerate(events):
        camp = camps.get(ev.get("hosted_by_camp") or "", {})
        location = str(ev.get("other_location") or "") or camp_location_string(camp)
        etype = (ev.get("event_type") or {}).get("label") or ""
        desc = str(ev.get("description") or "").strip()
        if etype:
            desc = f"[{etype}] {desc}"
        for occ in ev.get("occurrence_set") or []:
            start = str(occ.get("start_time") or "")  # 2025-08-27T12:00:00-07:00
            end = str(occ.get("end_time") or "")
            if len(start) < 16:
                errors.append(f"event.json #{i}: bad start_time {start!r} - skipped")
                continue
            row = {
                "title": ev.get("title"),
                "desc": desc,
                "date": start[:10],
                "time_start": "00:00" if ev.get("all_day") else start[11:16],
                "time_end": "23:59" if ev.get("all_day") else (end[11:16] if len(end) >= 16 else ""),
                "camp": camp.get("name") or "",
                "location": location,
            }
            norm = normalize(row, "event.json", i, errors)
            if norm:
                out.append(norm)
    return out


def load_jsonl(path: str, errors: list) -> list:
    out = []
    for i, line in enumerate(open(path)):
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"line {i + 1}: invalid JSON ({e}) - skipped")
            continue
        norm = normalize(raw, "jsonl", i + 1, errors)
        if norm:
            out.append(norm)
    return out


def write_pack(out_dir: pathlib.Path, pack_id: str, name: str, description: str,
               version: int, events: list) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "pack.json").write_text(json.dumps({
        "id": pack_id,
        "name": name,
        "description": description,
        "version": version,
    }, indent=1) + "\n")
    (out_dir / "events.json").write_text(json.dumps(events, indent=1) + "\n")


def write_db(db_path: str, events: list) -> bool:
    """Inspection DB mirroring the app's events table + FTS5. Returns whether
    FTS5 was available in this Python's SQLite."""
    con = sqlite3.connect(db_path)
    con.execute("DROP TABLE IF EXISTS events")
    con.execute(
        """CREATE TABLE events (
             id INTEGER PRIMARY KEY, title TEXT NOT NULL, desc TEXT NOT NULL,
             day TEXT NOT NULL, date TEXT NOT NULL, time_start TEXT NOT NULL,
             time_end TEXT NOT NULL, camp TEXT NOT NULL, location TEXT NOT NULL)""")
    con.executemany(
        """INSERT INTO events (title, desc, day, date, time_start, time_end, camp, location)
           VALUES (:title, :desc, :day, :date, :time_start, :time_end, :camp, :location)""",
        events)
    fts = True
    try:
        con.execute("DROP TABLE IF EXISTS events_fts")
        con.execute(
            """CREATE VIRTUAL TABLE events_fts USING fts5(
                 title, desc, camp, location, content='events', content_rowid='id')""")
        con.execute(
            """INSERT INTO events_fts (rowid, title, desc, camp, location)
               SELECT id, title, desc, camp, location FROM events""")
    except sqlite3.OperationalError:
        fts = False
    con.commit()
    con.close()
    return fts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--iburn-events", help="iBurn-Data APIData event.json")
    src.add_argument("--jsonl", help="generic JSONL, one event per line")
    ap.add_argument("--iburn-camps", help="iBurn-Data camp.json (resolves camp names/addresses)")
    ap.add_argument("--extra-jsonl", action="append", default=[], metavar="FILE",
                    help="additional generic-JSONL rows APPENDED to the main "
                         "source before the gates (repeatable). Used for the "
                         "city milestones the Playa Events listing never "
                         "carries -- Gate opens, Man Burn, Temple Burn, Box "
                         "Office closes, event end, Exodus support end -- so "
                         "'when does the Man burn?' answers through the same "
                         "search_events path every other 'when' question "
                         "takes (tools/data/brc-2026-city-milestones.jsonl).")
    ap.add_argument("--id", required=True, help="pack id (lowercase kebab-case)")
    ap.add_argument("--name", required=True, help="pack display name")
    ap.add_argument("--description", default="Event listings.")
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--out-pack", required=True, help="output pack folder")
    ap.add_argument("--db", help="optional: also write an inspection SQLite db")
    gate = ap.add_argument_group(
        "build gates (like tools/build_survival_pack.js: fail loudly BEFORE "
        "writing, so a thin or placeholder-poisoned pack can't ship silently)")
    gate.add_argument("--expect-min", type=int, default=0,
                      help="fail unless at least N event rows survived")
    gate.add_argument("--expect-dates", metavar="FROM:TO",
                      help="fail if any date falls outside YYYY-MM-DD:YYYY-MM-DD")
    gate.add_argument("--forbid-title", action="append", default=[],
                      help="fail if any title contains this substring "
                           "(repeatable; use for known placeholder strings)")
    gate.add_argument("--require-addresses", type=float, metavar="FRACTION",
                      help="fail unless at least this fraction of events "
                           "carry a clock address (e.g. '7:30 & C'). Use on "
                           "the FINAL post-placement regen: before BMorg "
                           "publishes placement every location is a venue "
                           "name, and a final pack that still looks like "
                           "that means the drop was missed or the parser "
                           "stopped capturing it (live dogfood 2026-08-18: "
                           "food-finding cards carried no addresses).")
    args = ap.parse_args()

    if not re.match(r"^[a-z0-9][a-z0-9-]{1,63}$", args.id):
        ap.error("--id must be lowercase kebab-case")

    errors: list = []
    if args.iburn_events:
        events = load_iburn(args.iburn_events, args.iburn_camps, errors)
    else:
        events = load_jsonl(args.jsonl, errors)
    for extra in args.extra_jsonl:
        events.extend(load_jsonl(extra, errors))

    if not events:
        print("No valid events - nothing written.", file=sys.stderr)
        for e in errors[:20]:
            print(" ", e, file=sys.stderr)
        return 1

    events.sort(key=lambda e: (e["date"], e["time_start"], e["title"]))

    gate_failures = []
    if args.expect_min and len(events) < args.expect_min:
        gate_failures.append(
            f"only {len(events)} events, expected >= {args.expect_min}")
    if args.expect_dates:
        lo, hi = args.expect_dates.split(":")
        if not (DATE_RE.match(lo) and DATE_RE.match(hi)):
            ap.error("--expect-dates must be YYYY-MM-DD:YYYY-MM-DD")
        bad = sorted({e["date"] for e in events if not lo <= e["date"] <= hi})
        if bad:
            gate_failures.append(
                f"dates outside {lo}..{hi}: {', '.join(bad[:5])}"
                + (f" (+{len(bad) - 5} more)" if len(bad) > 5 else ""))
    for needle in args.forbid_title:
        hits = [e["title"] for e in events if needle.lower() in e["title"].lower()]
        if hits:
            gate_failures.append(
                f"forbidden title substring {needle!r} present ({hits[0]!r})")
    addr_re = re.compile(r"\b[0-9]{1,2}:[0-9]{2}\s*&\s*[A-La-l]\b")
    with_addr = sum(1 for e in events if addr_re.search(e.get("location") or ""))
    frac = with_addr / len(events) if events else 0.0
    print(f"ADDRESS-COVERAGE {with_addr}/{len(events)} ({frac:.1%}) locations "
          f"carry a clock address", file=sys.stderr)
    if args.require_addresses is not None and frac < args.require_addresses:
        gate_failures.append(
            f"address coverage {frac:.1%} < required "
            f"{args.require_addresses:.1%} — placement data missing from "
            f"this build (pre-placement source, or the detail-page parser "
            f"no longer captures the address cell)")

    if gate_failures:
        print("GATE FAIL - nothing written:", file=sys.stderr)
        for g in gate_failures:
            print(" ", g, file=sys.stderr)
        return 1

    write_pack(pathlib.Path(args.out_pack), args.id, args.name,
               args.description, args.version, events)
    print(f"Wrote {len(events)} events -> {args.out_pack}/ (pack.json + events.json)")
    if args.db:
        fts = write_db(args.db, events)
        print(f"Wrote inspection db -> {args.db} (FTS5 {'ok' if fts else 'UNAVAILABLE'})")
    if errors:
        print(f"{len(errors)} rows skipped:", file=sys.stderr)
        for e in errors[:20]:
            print(" ", e, file=sys.stderr)
        if len(errors) > 20:
            print(f"  ... and {len(errors) - 20} more", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
