#!/usr/bin/env python3
"""Derive camps-index.json from the camps pack's own markdown.

WHY. The onboarding camp picker (0.7.3) drew its directory from the EVENTS
table — so a placed, registered camp that hosts no public events simply did
not exist in the picker (owner field test, Aug 24: a camp in the official
dataset, visible in iBurn, was invisible here). The full roster
already ships in assets/packs/camps-2026 as markdown; this tool parses that
shipped pack into a static index the app bundles via metro — the exact
pattern brc-art-2026/locations.json established.

WHY PARSE THE PACK, NOT THE API PULL. The raw bm-camp-<year>.json is a
build-time scratch file that does not live in the repo; the pack does. Parsing
the pack means this tool can always regenerate the index from what actually
ships, with no network and no data drift between the docs a burner reads and
the roster the picker offers. Re-run it after any load_camps.py refresh:

  python3 tools/build_camps_index.py assets/packs/camps-2026

FORMAT PARSED (load_camps.py section()): each camp is an H2 heading, and the
facts line under it starts with "**Where:** <placement>" when placed. Camps
without a placement (camps-unplaced.md) index with location "" — they belong
in the picker by name; a location the dataset does not have is not invented.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

CAMP_RE = re.compile(
    r"^## (?P<name>.+?)\n\n(?:\*\*Where:\*\* (?P<where>[^·\n]+?)(?: ·|\n))?",
    re.MULTILINE,
)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: build_camps_index.py <pack-dir>")
    pack = pathlib.Path(sys.argv[1])
    wrappers = sorted(pack.glob("*.md.json"))
    if not wrappers:
        sys.exit(f"no .md.json wrappers in {pack}")

    seen: dict[str, dict] = {}
    for w in wrappers:
        md = json.loads(w.read_text(encoding="utf-8"))["markdown"]
        for m in CAMP_RE.finditer(md):
            name = m.group("name").strip()
            where = (m.group("where") or "").strip()
            key = name.lower()
            row = seen.get(key)
            if row is None:
                seen[key] = {"camp": name, "location": where}
            elif row["location"] == "" and where:
                row["location"] = where

    rows = sorted(seen.values(), key=lambda r: r["camp"].lower())
    if len(rows) < 500:
        sys.exit(f"REFUSING: only {len(rows)} camps parsed — format drift?")
    out = pack / "camps-index.json"
    out.write_text(json.dumps(rows, indent=0, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    placed = sum(1 for r in rows if r["location"])
    print(f"{len(rows)} camps ({placed} placed) -> {out}")


main()
