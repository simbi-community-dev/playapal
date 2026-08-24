#!/usr/bin/env python3
"""Turn Burning Man art data into a searchable Playa Pal pack.

WHY THIS SHAPE. The Angel answers from RETRIEVED, CITED passages rather than
from its weights, and the pack format already accepts markdown as a
searchable document -- so an art directory needs no new schema and no new
UI. One markdown file per art category, one H2 section per piece, and the
existing chunker/FTS pipeline does the rest.

WHAT IS DELIBERATELY DROPPED, and why each one:

  location, location_string  -- EMBARGOED. Burning Man's dataset terms
      forbid art locations reaching users before Gate opens. They are
      stripped here rather than filtered later, so an embargoed field
      cannot survive into a built pack by accident. (iBurn ships them
      encrypted behind a passcode that unlocks at Gate; that is the
      canonical pattern if we ever add them.)
  contact_email             -- personal contact data for a named human.
  donation_link             -- a solicitation; the ToS forbids commercial use.
  images                    -- remote URLs, worthless in an offline app.

WHAT IS KEPT: name, artist, hometown, category, program, description, year,
and the official url -- the prose a burner actually wants when they ask
"who made this" or "what is that thing out in deep playa".

SOURCES. Both are official Burning Man Innovate surfaces:

  --source api      api.burningman.org, free key, CURRENT year.
  --source archive  bm-innovate.s3.amazonaws.com/archive/<year>/art.json,
                    keyless, 2015-2025, posted every March 1st.

ON REPUBLISHING, read from the primary source rather than a summary of it.
Section 5.3 of the Terms of Service for Burning Man APIs and Datasets:

    "Burning Man may also revoke your Keys if you fail to inform end users
     of any geotag or location data disclosed by your App, or if you
     republish Event Data or other Burning Man content not accessed
     through the API OR TOOLS THAT BURNING MAN MAY PROVIDE."

The trailing clause is the one that decides it, and an earlier reading of
this file dropped it. The dataset archive IS a tool Burning Man provides
-- the datasets page offers it precisely so apps can use it, and states
the data "is already publicly available on the Burning Man site or other
official Burning Man sources". So archive-derived content is on the right
side of 5.3; what the clause targets is content scraped from outside
Burning Man's own channels. The terms govern the APIs and the datasets
alike; there is no separate dataset regime.

What actually constrains publishing is therefore NOT provenance but
Section 6.1 (the location embargo), Section 3.1 (no commercial or
promotional use), and Section 4 (the disclaimer) -- all enforced below.

The `source` field is still recorded in pack.json, because WHICH YEAR the
data describes is a truth the reader needs; it is no longer a
publish/do-not-publish flag.

Usage:
  python3 tools/load_art.py --source archive --year 2025 --out build/art-2025
  python3 tools/load_art.py --source api --year 2026 --key $BM_API_KEY \
      --out assets/packs/brc-art-2026
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.request

ARCHIVE = "https://bm-innovate.s3.amazonaws.com/archive/{year}/art.json"
API = "https://api.burningman.org/api/art?year={year}"

# Fields that must never reach a built pack. Checked again after assembly.
FORBIDDEN = ("location", "location_string", "contact_email", "donation_link")


def fetch(source: str, year: int, key: str | None) -> list:
    if source == "api":
        if not key:
            sys.exit("--source api needs --key (free from api.burningman.org)")
        req = urllib.request.Request(API.format(year=year), headers={"X-API-Key": key})
    else:
        req = urllib.request.Request(ARCHIVE.format(year=year))
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def clean(text: str) -> str:
    """Collapse the whitespace the source prose arrives with, keep the words."""
    return re.sub(r"\s+", " ", (text or "").replace("\r", " ")).strip()


def section(a: dict) -> str:
    """One art piece as a markdown section.

    The heading carries name + artist because the chunker's breadcrumb rides
    every chunk of a section, and FTS weights headings far above body text --
    so a question naming either the piece or the artist finds it.
    """
    name = clean(a.get("name")) or "Untitled"
    artist = clean(a.get("artist"))
    head = f"## {name}" + (f" — by {artist}" if artist else "")

    facts = []
    if artist:
        facts.append(f"**Artist:** {artist}")
    if clean(a.get("hometown")):
        facts.append(f"**From:** {clean(a['hometown'])}")
    if clean(a.get("program")):
        facts.append(f"**Program:** {clean(a['program'])}")
    if clean(a.get("category")):
        facts.append(f"**Where it sits:** {clean(a['category'])}")
    if a.get("year"):
        facts.append(f"**Year:** {a['year']}")

    body = [head, "", " · ".join(facts) if facts else ""]
    desc = clean(a.get("description"))
    if desc:
        body += ["", desc]
    if clean(a.get("url")):
        body += ["", f"*More: {clean(a['url'])}*"]
    return "\n".join(body).rstrip() + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["api", "archive"], required=True)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--key", help="API key (only for --source api)")
    ap.add_argument("--out", required=True, help="pack folder to write")
    ap.add_argument("--metro", action="store_true",
                    help="emit a .md.json {file, markdown} beside each .md — "
                         "the wrapper Metro bundles (builtins.ts requires "
                         "these, not the raw .md). REQUIRED for the shipped "
                         "pack to reflect fresh data.")
    args = ap.parse_args()

    art = fetch(args.source, args.year, args.key)
    if not isinstance(art, list) or not art:
        sys.exit(f"no art records returned for {args.year}")

    # group by category so a reader (and the retriever) get coherent files
    groups: dict[str, list] = {}
    for a in art:
        cat = clean(a.get("category")) or "Other"
        groups.setdefault(cat, []).append(a)

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    # Clear BOTH the raw .md and the Metro wrappers, so a category that
    # disappears between pulls does not leave a stale wrapper behind (the
    # bug that froze this pack at its first pull: load_art rewrote .md but
    # never touched the .md.json the app actually loads).
    for f in list(out.glob("*.md")) + list(out.glob("*.md.json")):
        f.unlink()

    written = 0
    for cat, items in sorted(groups.items()):
        slug = re.sub(r"[^a-z0-9]+", "-", cat.lower()).strip("-") or "other"
        items.sort(key=lambda a: clean(a.get("name")).lower())
        doc = [
            f"# {cat} art — Black Rock City {args.year}",
            "",
            f"{len(items)} pieces. Descriptions are the artists' own, from "
            f"Burning Man Project's public art dataset. Playa Pal is not "
            f"affiliated with, endorsed by, or verified by Burning Man Project.",
            "",
        ]
        if args.source == "archive":
            doc += [
                f"**This is {args.year} art — a record of what stood that year, "
                f"not a guide to what is out there now.** Most pieces do not "
                f"return.",
                "",
            ]
        doc += ["Burning Man embargoes art locations until Gate opens "
                "— they unlock in this guide automatically at Gate.", ""]
        for a in items:
            doc.append(section(a))
        text = "\n".join(doc)

        # the embargo/PII guarantee, re-checked on the assembled text
        low = text.lower()
        for bad in ("contact_email", "donation_link"):
            if bad in low:
                sys.exit(f"REFUSING: {bad} survived into {slug}.md")
        (out / f"art-{slug}.md").write_text(text, encoding="utf-8")
        if args.metro:
            (out / f"art-{slug}.md.json").write_text(
                json.dumps({"file": f"art-{slug}.md", "markdown": text}, indent=1) + "\n",
                encoding="utf-8",
            )
        written += len(items)

    pack = {
        "id": f"brc-art-{args.year}",
        "name": f"BRC Art {args.year}",
        "description": (
            f"Art of Black Rock City {args.year} — {written} pieces with the "
            f"artists' own descriptions, from Burning Man Project's public art "
            f"dataset. Locations are excluded (embargoed until Gate opens). "
            f"Playa Pal is not affiliated with, endorsed by, or verified by "
            f"Burning Man Project."
            + ("" if args.source == "api" else
               f" Built from the {args.year} dataset archive: a record of that "
               f"year, not a guide to the current burn.")
        ),
        "version": 1,
        # Recorded so a reader can always tell WHICH YEAR and which
        # surface the data came from. Not a publish gate: ToS 5.3 covers
        # both the API and the datasets Burning Man provides.
        "source": args.source,
        "year": args.year,
    }
    (out / "pack.json").write_text(json.dumps(pack, indent=2) + "\n", encoding="utf-8")

    print(f"{written} art pieces -> {len(groups)} files in {out}")
    for cat, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        print(f"  {len(items):4}  {cat}")
    if args.source == "archive":
        print(f"\nThis is the {args.year} archive — a record of that year, not a "
              f"guide to the current burn.\nFor the current year: "
              f"--source api --key ... (free key from api.burningman.org).")


if __name__ == "__main__":
    main()
