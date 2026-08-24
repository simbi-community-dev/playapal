#!/usr/bin/env python3
"""Build a personal "playa lore" data pack from YouTube transcripts you choose.

WHY THIS SHAPE (the magic lane, 2026-08-17). The measured lesson of v4.0 is
that facts belong in PACKS the Angel retrieves and cites, not drilled into
weights: the one knowledge drill we ran erased more than it taught, while a
good corpus made even the stock model truthful. Veteran-burner YouTube
(camp histories, art-car culture, how Robot Heart does sunrise) is exactly
binder material — but it is OTHER PEOPLE'S WORK, so this repository ships
the MECHANISM and never the transcripts. You run it against channels and
videos you choose; the pack it writes stays on your machine and your phone.

WHAT IT DOES
  1. yt-dlp fetches metadata + subtitles (uploaded captions when present,
     YouTube auto-captions otherwise) for each video/channel/playlist URL.
     Everything is cached under --cache-dir; re-runs fetch nothing twice.
  2. VTT is flattened to plain prose (cue timestamps and karaoke-style
     duplicate lines removed), lightly de-hedged (music tags, [Applause]).
  3. One markdown file per video, with the chunker's heading discipline:
     an H1 title, H2 sections cut at silence gaps, and a PER-FILE credit
     line carrying the uploader, exact URL, and retrieval date — the same
     attribution contract as the Burn.Life layer (docs: survivalPack tests).
  4. pack.json is written beside them; import the folder from the Packs tab
     (select all files, like any pack).

WHAT IT DOES NOT DO
  - No summarization, no fact extraction: the transcript is the source, the
    Angel quotes it through retrieval, provenance intact. Curate by editing
    the .md files — delete sections that are noise; the pack is yours.
  - No re-hosting: do not commit or publish the output. The repo's
    public-safety check treats build/ as private.

USAGE
  python3 tools/fetch_youtube_lore.py \
      --url https://www.youtube.com/watch?v=... \
      --url https://www.youtube.com/@SomeBurnerChannel/videos --limit 20 \
      --id my-playa-lore --name "My Playa Lore" \
      --cache-dir build/yt-lore-cache --out-pack build/my-playa-lore

Requires yt-dlp on PATH. Stdlib only otherwise; Python 3.9+.
"""

import argparse
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys


def run_ytdlp(args, cache_note):
    cmd = ["yt-dlp", "--ignore-errors", "--no-warnings"] + args
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode not in (0, 1):  # 1 = some entries failed; partial is fine
        sys.exit(f"yt-dlp failed ({cache_note}): {p.stderr[-400:]}")
    return p.stdout


def list_videos(url, limit):
    """Resolve a URL to [(id, title, uploader, webpage_url)] without downloading."""
    out = run_ytdlp(
        ["--flat-playlist", "--print", "%(id)s\t%(title)s\t%(uploader)s",
         "--playlist-end", str(limit), url],
        f"listing {url}")
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 1 and parts[0]:
            vid = parts[0]
            title = parts[1] if len(parts) > 1 else vid
            uploader = parts[2] if len(parts) > 2 else ""
            rows.append((vid, title, uploader, f"https://www.youtube.com/watch?v={vid}"))
    return rows


def fetch_subs(vid, cache: pathlib.Path):
    """Download subtitles (uploaded first, auto as fallback) + info json."""
    vdir = cache / vid
    vdir.mkdir(parents=True, exist_ok=True)
    done = vdir / ".done"
    if done.exists():
        return vdir
    run_ytdlp(
        ["--skip-download", "--write-info-json",
         "--write-subs", "--write-auto-subs",
         "--sub-langs", "en.*,en", "--sub-format", "vtt",
         "-o", str(vdir / "%(id)s.%(ext)s"),
         f"https://www.youtube.com/watch?v={vid}"],
        f"subs {vid}")
    done.write_text(dt.datetime.now().isoformat())
    return vdir


TAG_RE = re.compile(r"<[^>]+>")
NOISE_RE = re.compile(r"\[(?:music|applause|laughter|cheering)\]", re.I)


def vtt_to_sections(path: pathlib.Path, gap_seconds=25):
    """Flatten a VTT to [(start_seconds, text)] sections split at silence gaps.

    Auto-captions repeat each line across overlapping cues (karaoke style);
    consecutive duplicate lines are collapsed.
    """
    def ts(s):
        h, m, rest = s.split(":")
        return int(h) * 3600 + int(m) * 60 + float(rest)

    cues = []
    cur_start = None
    for raw in path.read_text(errors="replace").splitlines():
        line = raw.strip()
        m = re.match(r"(\d+:\d+:\d+\.\d+)\s+-->\s+(\d+:\d+:\d+\.\d+)", line)
        if m:
            cur_start = ts(m.group(1))
            continue
        if not line or line == "WEBVTT" or line.startswith(("Kind:", "Language:", "NOTE")):
            continue
        if cur_start is None:
            continue
        text = NOISE_RE.sub("", TAG_RE.sub("", line)).strip()
        if not text:
            continue
        if cues and cues[-1][1] == text:
            continue
        cues.append((cur_start, text))

    sections = []
    sec_start, sec_lines, last_t = None, [], None
    for t, text in cues:
        if sec_start is None:
            sec_start, sec_lines = t, [text]
        elif last_t is not None and t - last_t > gap_seconds:
            sections.append((sec_start, " ".join(sec_lines)))
            sec_start, sec_lines = t, [text]
        else:
            sec_lines.append(text)
        last_t = t
    if sec_lines:
        sections.append((sec_start, " ".join(sec_lines)))
    # Merge short sections forward (min 600 chars). A silence gap in the
    # captions is not a content boundary: fragment sections become tiny
    # chunks whose per-section credit line pads them past naive length
    # floors, and FTS bm25 loves a short chunk whose heading carries the
    # subject — measured 2026-08-17: a chunk whose entire body was the word
    # "you" outranked the file's own distilled section for "Robot Heart".
    merged = []
    for start, text in sections:
        if merged and len(merged[-1][1]) < 600:
            merged[-1] = (merged[-1][0], merged[-1][1] + " " + text)
        else:
            merged.append((start, text))
    if len(merged) > 1 and len(merged[-1][1]) < 600:
        tail = merged.pop()
        merged[-1] = (merged[-1][0], merged[-1][1] + " " + tail[1])
    return merged


def hms(seconds):
    seconds = int(seconds)
    return f"{seconds // 3600}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


def slug(text, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]
    return s or fallback


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", action="append", required=True,
                    help="video / channel / playlist URL (repeatable)")
    ap.add_argument("--limit", type=int, default=10,
                    help="max videos per channel/playlist URL (default 10)")
    ap.add_argument("--id", required=True, help="pack id (lowercase kebab-case)")
    ap.add_argument("--name", required=True, help="pack display name")
    ap.add_argument("--description",
                    default="Personal playa-lore pack built from YouTube transcripts. Not for redistribution.")
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--cache-dir", default="build/yt-lore-cache")
    ap.add_argument("--out-pack", required=True)
    a = ap.parse_args()
    if not re.match(r"^[a-z0-9][a-z0-9-]{1,63}$", a.id):
        ap.error("--id must be lowercase kebab-case")

    cache = pathlib.Path(a.cache_dir)
    out = pathlib.Path(a.out_pack)
    out.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()

    videos = []
    for url in a.url:
        rows = list_videos(url, a.limit)
        print(f"{url}: {len(rows)} video(s)")
        videos.extend(rows)

    written = 0
    for vid, title, uploader, wurl in videos:
        vdir = fetch_subs(vid, cache)
        vtts = sorted(vdir.glob("*.vtt"))
        if not vtts:
            print(f"  {vid}: no English subtitles — skipped ({title[:60]})")
            continue
        info = {}
        ij = vdir / f"{vid}.info.json"
        if ij.exists():
            info = json.loads(ij.read_text())
        title = info.get("title") or title
        uploader = info.get("uploader") or uploader or "unknown uploader"
        upload_date = info.get("upload_date", "")
        upload_date = (f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"
                       if len(upload_date) == 8 else "")
        sections = vtt_to_sections(vtts[0])
        if not sections:
            print(f"  {vid}: empty transcript — skipped")
            continue
        credit = (f"*Credit: [{uploader} — {title}]({wurl}) (YouTube"
                  + (f", published {upload_date}" if upload_date else "")
                  + f"). Transcript retrieved {today}. Personal use; do not redistribute.*")
        # No standalone credit under the title: every section carries the
        # credit, and a credit-only preamble becomes its own tiny chunk that
        # bm25 ranks ABOVE the real sections (subject in heading + short
        # body — the same bait class as the fragment sections above).
        lines = [f"# {title} [playa lore — YouTube transcript]", ""]
        for start, text in sections:
            lines.append(f"## {title} — from {hms(start)}")
            lines.append("")
            lines.append(text)
            lines.append("")
            lines.append(credit)
            lines.append("")
        fname = f"lore-yt-{slug(title, vid)}.md"
        (out / fname).write_text("\n".join(lines))
        written += 1
        print(f"  {vid}: {len(sections)} section(s) -> {fname}")

    if written == 0:
        sys.exit("no transcripts written — nothing to pack")
    (out / "pack.json").write_text(json.dumps({
        "id": a.id, "name": a.name, "description": a.description,
        "version": a.version,
    }, indent=1) + "\n")
    print(f"\nWrote {written} transcript file(s) + pack.json -> {out}/")
    print("Import from the Packs tab (select ALL files together). Curate by "
          "editing the .md files and re-importing with a bumped version.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
