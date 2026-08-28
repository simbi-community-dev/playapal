#!/usr/bin/env python3
"""Respectful pull of the public playaevents.burningman.org listing into the
app's generic events JSONL (feed the output to load_events.py --jsonl).

Why this exists: the preferred source is the published iBurnApp/iBurn-Data
per-year JSON (see load_events.py), but that repo only gains a year AFTER
BMorg publishes the final data (2026 was absent as of 2026-08-13). The
playa-events listing itself is public and browsable without a key; this tool
reads it the way a patient human would:

  - ONE listing request (the year's search page lists every event, grouped
    by day), then one request per event detail page.
  - Every response is cached on disk; re-runs only fetch what is missing,
    so the full post-freeze refresh costs one polite pass and iterating on
    the parser costs zero requests.
  - Sequential, throttled (default 0.4 s between uncached requests), real
    contact info in the User-Agent, no parallelism, retries with backoff.

Usage (pre-freeze snapshot and the post-Aug-22 final drop are the SAME
invocation - the cache dir keeps the raw HTML as provenance):

  python3 tools/fetch_playaevents.py --year 2026 \
      --cache-dir build/playaevents-2026-crawl \
      --out-jsonl build/playaevents-2026.jsonl

Then convert + gate + write the bundled pack with load_events.py (see its
--help; the gate flags assert real data before anything ships).

No art data is fetched at all, so the art-location gate-embargo does not
arise (events list only host camps / public venues).

Stdlib only; Python 3.9+.
"""

import argparse
import datetime as dt
import html as htmllib
import http.client
import json
import pathlib
import re
import sys
import time

HOST = "playaevents.burningman.org"
BASE = f"https://{HOST}"
# A crawler's User-Agent is sent to somebody else's server on every request
# and shows up in their logs forever, so it carries a PROJECT identifier and
# never a personal address. A repository URL is also more useful to the
# operator being crawled than a mailbox: it says what this is and who to file
# against, without publishing a person's inbox to every host we touch.
UA = (
    "PlayaPal-events/1.0 (offline Burning Man companion app; "
    "respectful cached pull; https://github.com/simbi-community-dev/playapal)"
)

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        "January February March April May June July August September "
        "October November December".split()
    )
}

# "Sunday, August 30th, 2026, 7 PM &ndash; 10 PM" (entities already unescaped,
# whitespace collapsed - so `rest` must stop before the NEXT weekday line for
# repeating events, not run greedily to the end of the cell).
WEEKDAY = r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
DATE_LINE_RE = re.compile(
    WEEKDAY + r",\s*"
    r"(?P<month>[A-Z][a-z]+)\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?,\s*(?P<year>\d{4})"
    r"(?P<rest>.*?)(?=" + WEEKDAY + r",\s*[A-Z]|$)"
)
TIME_RE = re.compile(r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>[AP]M)", re.I)


_conn: list = [None]  # persistent keep-alive connection (fewer handshakes
# for the server than one TLS setup per page; also what a browser would do)


def fetch(path: str, cache_path: pathlib.Path, delay: float, stats: dict) -> str:
    if cache_path.exists():
        stats["cached"] += 1
        return cache_path.read_text()
    last_err = None
    for attempt in range(3):
        try:
            if _conn[0] is None:
                _conn[0] = http.client.HTTPSConnection(HOST, timeout=30)
            _conn[0].request("GET", path, headers={"User-Agent": UA})
            resp = _conn[0].getresponse()
            body = resp.read().decode("utf-8", "replace")
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(body)
            stats["fetched"] += 1
            time.sleep(delay)  # throttle only real network hits
            return body
        except Exception as e:  # noqa: BLE001 - retry any transport error
            last_err = e
            if _conn[0] is not None:
                _conn[0].close()
            _conn[0] = None
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {path}: {last_err}")


def clock(match: re.Match) -> str:
    h = int(match.group("h")) % 12
    if match.group("ap").upper() == "PM":
        h += 12
    return f"{h:02d}:{int(match.group('m') or 0):02d}"


def text_of(fragment: str) -> str:
    """Strip tags, unescape entities, collapse whitespace."""
    t = re.sub(r"<[^>]+>", " ", fragment)
    t = htmllib.unescape(t)
    return re.sub(r"\s+", " ", t).strip()


def field(html: str, label: str) -> str:
    """Value cell following a `label` cell in the event-display markup."""
    m = re.search(
        re.escape(label) + r":\s*</?[^>]*>?\s*</div>\s*<div class=\"col-xs-8\">(.*?)</div>\s*</div>",
        html,
        re.S,
    )
    if not m:
        # Location's value cell nests another row of divs; match lazily to
        # the row terminator instead.
        m = re.search(
            re.escape(label) + r":\s*</div>\s*<div class=\"col-xs-8\">(.*?)</div>\s*\n\s*</div>",
            html,
            re.S,
        )
    return text_of(m.group(1)) if m else ""


def parse_detail(html: str, event_id: str, errors: list) -> list:
    """One detail page -> list of app-schema JSONL rows (one per occurrence)."""
    m = re.search(r'event-display whitepage">(.*?)<footer', html, re.S)
    body = m.group(1) if m else html
    tm = re.search(r"<h2[^>]*>(.*?)</h2>", body, re.S)
    title = text_of(tm.group(1)) if tm else ""
    if not title:
        errors.append(f"event {event_id}: no title - skipped")
        return []

    etype = field(body, "Type")
    camp = field(body, "Located at Camp")
    # Location: the nested-row cell; fall back to the camp name.
    lm = re.search(
        r"Location:\s*</div>\s*<div class=\"col-xs-8\">\s*<div class=\"row\">\s*<div class=\"col-xs-12\">(.*?)</div>",
        body,
        re.S,
    )
    location = text_of(lm.group(1)) if lm else ""
    dm = re.search(r"Description:\s*</p>\s*</div>\s*<div class=\"col-xs-12\">(.*?)</div>", body, re.S)
    desc = text_of(dm.group(1)) if dm else ""
    if etype:
        desc = f"[{etype}] {desc}".strip()

    # Occurrences: every "Weekday, Month DDth, YYYY, START - END" line in the
    # Date-and-Time cell.
    cm = re.search(r"Date and Time:\s*</div>\s*<div class=\"col-xs-8\">(.*?)</div>\s*</div>", body, re.S)
    cell = text_of(cm.group(1)) if cm else text_of(body)
    rows = []
    for occ in DATE_LINE_RE.finditer(cell):
        date = dt.date(int(occ.group("year")), MONTHS[occ.group("month")], int(occ.group("day")))
        tmatches = list(TIME_RE.finditer(occ.group("rest")))
        all_day = "all day" in occ.group("rest").lower()
        rows.append(
            {
                "title": title,
                "desc": desc,
                "date": date.isoformat(),
                "time_start": "00:00" if all_day else (clock(tmatches[0]) if tmatches else ""),
                "time_end": "23:59" if all_day else (clock(tmatches[1]) if len(tmatches) > 1 else ""),
                "camp": camp,
                "location": location,
            }
        )
    if not rows:
        errors.append(f"event {event_id} ({title!r}): no parsable occurrence in {cell[:80]!r}")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--cache-dir", required=True,
                    help="raw HTML cache (kept as provenance; re-runs are free)")
    ap.add_argument("--out-jsonl", required=True)
    ap.add_argument("--delay", type=float, default=0.4,
                    help="seconds between uncached requests (default 0.4)")
    ap.add_argument("--limit", type=int, default=0,
                    help="debug: stop after N events (0 = all)")
    args = ap.parse_args()

    cache = pathlib.Path(args.cache_dir).expanduser()
    stats = {"fetched": 0, "cached": 0}
    errors: list = []

    # The year's search page with no query lists EVERY approved event,
    # grouped by day - one request for the whole index.
    listing = fetch(f"/playa_event/search/{args.year}/",
                    cache / "search.html", args.delay, stats)
    ids = sorted(set(re.findall(r"/playa_event/(\d+)/", listing)), key=int)
    if args.limit:
        ids = ids[: args.limit]
    print(f"{len(ids)} events listed for {args.year}")
    if not ids:
        print("Nothing listed - is the year live yet?", file=sys.stderr)
        return 1

    rows = []
    for n, eid in enumerate(ids, 1):
        page = fetch(f"/playa_event/{eid}/",
                     cache / "event" / f"{eid}.html", args.delay, stats)
        rows.extend(parse_detail(page, eid, errors))
        if n % 250 == 0:
            print(f"  {n}/{len(ids)} events ({stats['fetched']} network, "
                  f"{stats['cached']} cache)")

    out = pathlib.Path(args.out_jsonl)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"Wrote {len(rows)} occurrence rows from {len(ids)} events -> {out}")
    print(f"({stats['fetched']} network requests, {stats['cached']} cache hits)")
    if errors:
        print(f"{len(errors)} problems:", file=sys.stderr)
        for e in errors[:20]:
            print(" ", e, file=sys.stderr)
        if len(errors) > 20:
            print(f"  ... and {len(errors) - 20} more", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
