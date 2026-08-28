#!/usr/bin/env python3
"""Turn Burning Man camp data into a searchable Playa Pal pack.

WHY THIS SHAPE. The same reasoning as tools/load_art.py: the Angel answers
from RETRIEVED, CITED passages, and the pack format already accepts markdown
as a searchable document — so a camp directory needs no new schema. One
markdown file per clock sector, one H2 section per camp, and the existing
chunker/FTS pipeline does the rest.

THE ONE DELIBERATE DIFFERENCE FROM ART. Art LOCATIONS are embargoed until
Gate opens and are stripped (tools/load_art.py FORBIDDEN). Camp locations are
NOT embargoed — Burning Man's dataset terms make CAMP locations showable to
users from Aug 23 12:01am, and this release ships Aug 27 (docs/FINAL-WEEK.md
"Lane C"). So location_string is KEPT here, as the first facts line under
each camp. Do not copy load_art's location strip onto camps.

WHAT IS DROPPED (same discipline as load_art, different field set):
  contact_email  -- personal contact data for a named human.
  images         -- remote thumbnail URLs, worthless in an offline app.
  accepting_campers -- time-sensitive and outside the keep-list; drop.
  uid            -- an internal dataset id, meaningless to a burner.

WHAT IS KEPT: name, location_string (as "**Where:**"), hometown, landmark,
description, year, and the official url — the prose a burner actually wants
when they ask "where is my friend's camp" or "what is that camp about".

GROUPING. One file per clock sector, keyed on the address's clock hour — the
FIRST clock token of location_string, which is exactly the token
src/rightnow/playaWalk.ts parsePlayaAddressParts() also reads first, so the
sector a camp lands in is the sector the map/compass will resolve. Hours
2-10 are the city's clock face and get camps-<hour>.md; everything else
(empty placement, "Airport Road", and "Center Camp Plaza @ 1/11/12" — all
off the 2:00-10:00 face) goes to camps-unplaced.md. The header of that file
says what it holds; no camp is silently mislabeled.

Usage:
  python3 tools/load_camps.py --in <bm-camp-2026.json> --out build/camps-2026
  python3 tools/load_camps.py --in <...> --out build/camps-2026 --metro
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

# Keys that must never reach a built pack. Checked again after assembly.
FORBIDDEN = ("contact_email", "images")


def clean(text: str) -> str:
    """Collapse the whitespace the source prose arrives with, keep the words."""
    return re.sub(r"\s+", " ", (text or "").replace("\r", " ")).strip()


def sector_hour(address: str) -> int | None:
    """The clock hour a placement belongs to — the FIRST clock token, matching
    parsePlayaAddressParts' own first-match convention (so "D & 7:15" -> 7,
    "Esplanade & 7:30 Portal" -> 7, "Center Camp Plaza @ 11:30" -> 11)."""
    m = re.search(r"\b(\d{1,2}):\d{2}\b", address or "")
    return int(m.group(1)) if m else None


def sector_slug(hour: int | None) -> str:
    """camps-2.md ... camps-10.md for the clock face; camps-unplaced.md off it."""
    if hour is not None and 2 <= hour <= 10:
        return f"camps-{hour}.md"
    return "camps-unplaced.md"


def sector_title(hour: int | None) -> str:
    if hour is not None and 2 <= hour <= 10:
        return f"camps on the {hour}:00–{hour + 1}:00 sector"
    return "camps off the 2:00–10:00 clock face"


def section(c: dict) -> str:
    """One camp as a markdown section. The first facts line is the placement
    ("**Where:**"), because that is the first thing a burner asks and the
    chunker/FTS weights a section's head over its body."""
    name = clean(c.get("name")) or "Untitled"
    head = f"## {name}"

    facts = []
    where = clean(c.get("location_string"))
    if where:
        facts.append(f"**Where:** {where}")
    if clean(c.get("hometown")):
        facts.append(f"**From:** {clean(c['hometown'])}")
    if clean(c.get("landmark")):
        facts.append(f"**Landmark:** {clean(c['landmark'])}")
    if c.get("year"):
        facts.append(f"**Year:** {c['year']}")

    body = [head, "", " · ".join(facts) if facts else ""]
    desc = clean(c.get("description"))
    if desc:
        body += ["", desc]
    if clean(c.get("url")):
        body += ["", f"*More: {clean(c['url'])}*"]
    return "\n".join(body).rstrip() + "\n"


def header_for(slug: str, hour: int | None, count: int, year: int) -> str:
    title = sector_title(hour).capitalize()
    lines = [
        f"# {count} {title} — Black Rock City {year}",
        "",
        f"Camp placements are official Burning Man Project data and may be "
        f"shown to users from Aug 23 12:01am (the dataset terms lift the "
        f"camp-location embargo then; this release ships Aug 27). Playa Pal "
        f"is not affiliated with, endorsed by, or verified by Burning Man "
        f"Project.",
        "",
    ]
    if slug == "camps-unplaced.md":
        lines += [
            "Camps here are off the 2:00–10:00 clock face (Center Camp Plaza, "
            "Airport Road) or listed without a placement.",
            "",
        ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input", required=True,
                    help="path to the pulled bm-camp-<year>.json")
    ap.add_argument("--out", required=True, help="pack folder to write")
    ap.add_argument("--metro", action="store_true",
                    help="emit a .md.json {file, markdown} beside each .md")
    ap.add_argument("--source", default="api",
                    help="provenance recorded in pack.json (the scratchpad pull is the API)")
    args = ap.parse_args()

    camps = json.loads(pathlib.Path(args.input).read_text(encoding="utf-8"))
    if not isinstance(camps, list) or not camps:
        sys.exit(f"no camp records in {args.input}")
    year = int(camps[0].get("year") or 0)

    # group by clock sector (keyed on the address's clock hour)
    groups: dict[str, list] = {}
    for c in camps:
        hour = sector_hour(c.get("location_string") or "")
        groups.setdefault(sector_slug(hour), []).append(c)

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in list(out.glob("*.md")) + list(out.glob("*.md.json")):
        f.unlink()

    written = 0
    largest = ("", 0)
    for slug in sorted(groups, key=lambda s: (s != "camps-unplaced.md",
                                              _sector_sort_key(s))):
        items = groups[slug]
        items.sort(key=lambda c: clean(c.get("name")).lower())
        hour = sector_hour(items[0].get("location_string") or "") if items else None
        # the sector hour is the slug's hour for the face files
        m = re.match(r"camps-(\d+)\.md", slug)
        hour = int(m.group(1)) if m else None
        doc = [header_for(slug, hour, len(items), year)]
        for c in items:
            doc.append(section(c))
        text = "\n".join(doc).rstrip() + "\n"

        # the PII/no-image guarantee, re-checked on the assembled text
        low = text.lower()
        for bad in ("contact_email", "thumbnail_url", "widen.net"):
            if bad in low:
                sys.exit(f"REFUSING: {bad} survived into {slug}")
        if re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text):
            sys.exit(f"REFUSING: an email address survived into {slug}")

        (out / slug).write_text(text, encoding="utf-8")
        if args.metro:
            (out / f"{slug}.json").write_text(
                json.dumps({"file": slug, "markdown": text}, indent=1) + "\n",
                encoding="utf-8",
            )
        written += len(items)
        if len(text) > largest[1]:
            largest = (slug, len(text))

    pack = {
        "id": f"brc-camps-{year}",
        "name": f"BRC Camps {year}",
        "description": (
            f"Camps of Black Rock City {year} — {written} camps with their "
            f"official placements, hometowns and their own descriptions, from "
            f"Burning Man Project's public camp dataset. Camp locations may be "
            f"shown to users from Aug 23 12:01am. Playa Pal is not affiliated "
            f"with, endorsed by, or verified by Burning Man Project."
        ),
        "version": 1,
        "source": args.source,
        "year": year,
    }
    (out / "pack.json").write_text(json.dumps(pack, indent=2) + "\n", encoding="utf-8")

    print(f"{written} camps -> {len(groups)} files in {out}")
    for slug in sorted(groups, key=lambda s: (s != "camps-unplaced.md",
                                              _sector_sort_key(s))):
        print(f"  {len(groups[slug]):4}  {slug}")
    print(f"\nlargest file: {largest[0]} ({largest[1]} bytes)")
    if args.metro:
        print(f".md.json metro wrappers written beside each .md")


def _sector_sort_key(slug: str):
    m = re.match(r"camps-(\d+)\.md", slug)
    return int(m.group(1)) if m else 10 ** 9


main()
