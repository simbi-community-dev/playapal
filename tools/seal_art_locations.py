#!/usr/bin/env python3
"""Build the SEALED art-locations asset for brc-art-2026.

BM ToS 6.1 requires art locations to stay hidden from USERS until Gate
opens (2026-08-30 00:01 Pacific). The events/art text packs strip locations
at the tool so an embargoed field cannot reach a user-facing surface by
accident; this tool is the deliberate, narrow exception for the gate-day
reveal — the locations ship SEALED: bundled as a raw Metro asset that the
installer never sees (it is not in any pack's file list, so nothing here
reaches doc_chunks or FTS, and the Angel cannot retrieve it), and rendered
only by PackReader's gate check at the embargo instant.

KEY SHAPE: the heading exactly as load_art.py's section() emits it, minus
the leading "## " — "<name> — by <artist>" — because PackReader joins on
the heading it renders. The heading logic is IMPORTED from load_art, never
duplicated: if the pack is rebuilt with a different heading shape, this
tool's keys move with it.

Usage:
  python3 tools/seal_art_locations.py \
      --art /path/to/bm-art-2026.json \
      --out assets/packs/brc-art-2026/locations.json
"""

import argparse
import json
import re
import sys

# Reuse the source of truth for the heading shape (and the whitespace
# collapse that feeds it) rather than transcribing it. load_art's argparse
# lives in its main(), so importing it is side-effect free.
from load_art import clean  # noqa: E402  (sys.path fix below happens first)


def heading_key(a: dict) -> str:
    """load_art.section()'s heading line, minus the '## ' marker."""
    name = clean(a.get("name")) or "Untitled"
    artist = clean(a.get("artist"))
    return f"{name}" + (f" — by {artist}" if artist else "")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--art", required=True, help="raw bm art pull (list of pieces)")
    ap.add_argument("--out", required=True, help="locations.json to write")
    args = ap.parse_args()

    rows = json.load(open(args.art))
    located = [r for r in rows if clean(r.get("location_string"))]
    out = {}
    dupes = []
    for r in located:
        k = heading_key(r)
        if k in out:
            dupes.append(k)
            continue  # first wins; a later identical heading is the same piece's dup row
        out[k] = clean(r["location_string"])

    if dupes:
        print(f"note: {len(dupes)} duplicate heading(s) collapsed: {dupes[:5]}", file=sys.stderr)
    print(f"{len(out)} sealed locations (of {len(located)} located, {len(rows)} total)")

    with open(args.out, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
