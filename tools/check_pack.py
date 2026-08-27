#!/usr/bin/env python3
"""Validate a Playa Pal data-pack folder before importing it.

The doctor follows the runtime format while adding publication-quality gates:
real calendar dates/times, author-facing string types, document credits, graph
integrity guidance, and complete vectors whenever embeddings.json is present.

Usage:
    python3 tools/check_pack.py path/to/my-pack
    python3 tools/check_pack.py --builtin path/to/repository-bundled-pack

Only immediate files are inputs because Playa Pal imports a flat multi-selection.
Normal imported packs must use real .md or .txt files. --builtin enables the
repository's exact guide.md.json Metro transport exception; never use it to
certify files intended for picker import.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pathlib
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

PACK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
TIME_RE = re.compile(r"^[0-9]{2}:[0-9]{2}$")
GRAPH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
GRAPH_TYPE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
CLOCK_RE = re.compile(r"(?<![0-9])([0-9]{1,2}):([0-9]{2})(?![0-9])")
CLOCK_TOKEN_RE = re.compile(r"(?<![0-9])([0-9]+):([0-9]+)(?![0-9])")
RESERVED = {"pack.json", "nodes.json", "edges.json", "embeddings.json", "flags.json"}
EVENT_FIELDS = ("title", "desc", "day", "date", "time_start", "time_end", "camp", "location")
OPTIONAL_EVENT_FIELDS = ("desc", "time_start", "time_end", "camp", "location")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
VECTOR_DIM = 384
SEMANTIC_MODEL = "bge-small-en-v1.5-q8"
DEFAULT_MAX_CHARS = 2000
BUILTIN_GUIDE_MAX_CHARS = 700
MAX_PACK_FILES = 256
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_PACK_BYTES = 64 * 1024 * 1024
JS_SAFE_INTEGER = 9_007_199_254_740_991
CAMP_BUNDLE_KIND = "playapal-camp-board"
BUILTIN_IDS = {"brc-events-2026", "survival-guide"}
# A SECOND COPY OF src/packs/builtins.ts, AND IT DRIFTED. The app's
# BUILTIN_PACKS entry for survival-guide bundles pack.json, the guide
# document and embeddings.json; this set omitted the vectors, so the doctor
# reported the repo's own pack as carrying a file "not bundled by
# src/packs/builtins.ts" that builtins.ts plainly bundles. A validator that
# is wrong about the thing it validates is worse than no validator, because
# it is believed. __tests__/packDoctorMatchesBuiltins.test.ts now fails if
# these two sources disagree again.
BUILTIN_FILES = {
    "brc-events-2026": {"pack.json", "events.json"},
    "survival-guide": {"pack.json", "guide.md.json", "embeddings.json"},
}
INTERNAL_PACK_PREFIXES = ("camp-board-",)
PROVENANCE_TIERS = {"stated", "roster", "owner-stated", "inferred", "stated-on-playa"}
STATEMENT_TIERS = {"stated", "owner-stated", "stated-on-playa"}
TEXT_CONTROL_WHITESPACE = {0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0085}
# ECMAScript WhiteSpace + LineTerminator characters used by String.trim().
JS_TRIM_CHARS = "".join(map(chr, (
    0x0009, 0x000B, 0x000C, 0x0020, 0x00A0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F,
    0x205F, 0x3000, 0xFEFF, 0x000A, 0x000D,
)))


def js_trim(value: str) -> str:
    return value.strip(JS_TRIM_CHARS)


JS_WS_RE = f"[{re.escape(JS_TRIM_CHARS)}]"
BULLET_RE = re.compile(rf"^{JS_WS_RE}*(?:[-*•]|[0-9]+[.)]){JS_WS_RE}")
CREDIT_LINE_RE = re.compile(
    rf"^[{re.escape(JS_TRIM_CHARS)}*_>\-]*Credit: (.*?)[*_{re.escape(JS_TRIM_CHARS)}]*$"
)
CREDIT_LINE_BREAK_RE = re.compile("[\\n\\r" + chr(0x2028) + chr(0x2029) + "]")
RING_RE = re.compile(rf"(?:^|[{re.escape(JS_TRIM_CHARS)}&])([a-l])(?:$|[{re.escape(JS_TRIM_CHARS)}&])")
CAMPER_HEADING_RE = re.compile(r"^(.+?)(?: \((.+?)\))? — (.+) camper$")
WHO_IS_HEADING_RE = re.compile(r"^Who is (.+)\?$")
MONTH_RE = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
TENURE_RE = re.compile(
    rf"\b(?:from|in){JS_WS_RE}+({MONTH_RE} [0-9]{{4}})"
    rf"(?:{JS_WS_RE}+to{JS_WS_RE}+({MONTH_RE} [0-9]{{4}}))?"
)


def terminal_text(value: Any) -> str:
    output: list[str] = []
    for char in str(value):
        if char.isprintable():
            output.append(char)
            continue
        codepoint = ord(char)
        if codepoint <= 0xFF:
            output.append(f"\\x{codepoint:02x}")
        elif codepoint <= 0xFFFF:
            output.append(f"\\u{codepoint:04x}")
        else:
            output.append(f"\\U{codepoint:08x}")
    return "".join(output)


@dataclass
class Finding:
    state: str
    check: str
    detail: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=lambda: {"FAIL": 0, "WARN": 0})
    emitted: dict[tuple[str, str], int] = field(default_factory=dict)
    suppressed: dict[tuple[str, str], int] = field(default_factory=dict)
    detail_limit: int = 20

    def add(self, state: str, check: str, detail: str) -> None:
        if state in self.counts:
            self.counts[state] += 1
            key = (state, check)
            seen = self.emitted.get(key, 0)
            if seen >= self.detail_limit:
                self.suppressed[key] = self.suppressed.get(key, 0) + 1
                return
            self.emitted[key] = seen + 1
        self.findings.append(Finding(state, check, detail))

    def passed(self, check: str, detail: str) -> None:
        self.add("PASS", check, detail)

    def warn(self, check: str, detail: str) -> None:
        self.add("WARN", check, detail)

    def fail(self, check: str, detail: str) -> None:
        self.add("FAIL", check, detail)

    @property
    def failures(self) -> int:
        return self.counts["FAIL"]

    @property
    def warnings(self) -> int:
        return self.counts["WARN"]

    def emit(self, pack: pathlib.Path) -> int:
        rendered = [
            Finding(f.state, terminal_text(f.check), terminal_text(f.detail))
            for f in self.findings
        ]
        width = max((len(f.check) for f in rendered), default=1)
        for f in rendered:
            print(f"{f.state:<4} {f.check:<{width}}  {f.detail}")
        for (state, check), count in sorted(self.suppressed.items()):
            safe_check = terminal_text(check)
            print(f"NOTE {safe_check:<{width}}  {count} additional {state} detail(s) suppressed")
        print()
        if self.failures:
            print(
                f"PACK FAIL: {self.failures} failed check(s), "
                f"{self.warnings} warning(s)"
            )
            return 1
        passes = sum(f.state == "PASS" for f in self.findings)
        print(f"PACK PASS: {passes} passed check(s), {self.warnings} warning(s)")
        return 0


def read_text(path: pathlib.Path) -> str:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            return handle.read()
    except UnicodeDecodeError as exc:
        raise ValueError(f"not UTF-8 ({exc})") from exc
    except OSError as exc:
        raise ValueError(str(exc)) from exc


def first_nontext_control(text: str) -> int | None:
    for char in text:
        codepoint = ord(char)
        if unicodedata.category(char) == "Cc" and codepoint not in TEXT_CONTROL_WHITESPACE:
            return codepoint
    return None


def load_json(path: pathlib.Path) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number {value!r}")

    def parse_integer(value: str) -> int:
        try:
            finite = math.isfinite(float(value))
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("JSON integer exceeds JavaScript Number range")
        return int(value)

    def parse_float(value: str) -> float:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("JSON number exceeds JavaScript Number range")
        return number

    try:
        return json.loads(
            read_text(path),
            parse_constant=reject_constant,
            parse_int=parse_integer,
            parse_float=parse_float,
        )
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
    except RecursionError as exc:
        raise ValueError("JSON nesting is too deep") from exc


def is_int(value: Any) -> bool:
    """JavaScript Number.isInteger semantics after JSON.parse."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        number = float(value)
    except OverflowError:
        return False
    return math.isfinite(number) and number.is_integer()


def is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def decimal_safe_index(value: Any) -> int | None:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
        return None
    canonical = value.lstrip("0") or "0"
    maximum = str(JS_SAFE_INTEGER)
    if len(canonical) > len(maximum) or (
        len(canonical) == len(maximum) and canonical > maximum
    ):
        return None
    return int(canonical)


def nonnegative_safe_index(value: Any) -> int | None:
    if is_int(value) and 0 <= value <= JS_SAFE_INTEGER:
        return int(value)
    return None


def is_iso_date(value: Any) -> bool:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def js_units(text: str) -> int:
    """JavaScript String.length: UTF-16 code units, not Unicode code points."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


JS_TRIM_UNITS = {ord(char) for char in JS_TRIM_CHARS}
JS_DOT_LINE_TERMINATORS = {0x000A, 0x000D, 0x2028, 0x2029}


def raw_unit(raw: bytes, index: int) -> int:
    return raw[index * 2] | (raw[index * 2 + 1] << 8)


def trim_raw_bounds(raw: bytes, start: int, end: int) -> tuple[int, int]:
    while start < end and raw_unit(raw, start) in JS_TRIM_UNITS:
        start += 1
    while end > start and raw_unit(raw, end - 1) in JS_TRIM_UNITS:
        end -= 1
    return start, end


def decode_raw(raw: bytes, start: int, end: int) -> str:
    return raw[start * 2 : end * 2].decode("utf-16-le", errors="surrogatepass")


def split_oversized(
    text: str,
    max_chars: int,
    trim_first: bool = True,
) -> tuple[list[str], str]:
    """Split once-encoded UTF-16 without repeatedly copying the shrinking suffix."""
    raw = text.encode("utf-16-le", errors="surrogatepass")
    start, end = 0, len(raw) // 2
    if trim_first:
        start, end = trim_raw_bounds(raw, start, end)
    output: list[str] = []
    while end - start > max_chars:
        search = start + max_chars
        cut = -1
        for index in range(search, start - 1, -1):
            if raw_unit(raw, index) == 0x20:
                cut = index
                break
        at = cut if cut > start + max_chars / 2 else start + max_chars
        piece_start, piece_end = trim_raw_bounds(raw, start, at)
        output.append(decode_raw(raw, piece_start, piece_end))
        start, end = trim_raw_bounds(raw, at, end)
    start, end = trim_raw_bounds(raw, start, end)
    return output, decode_raw(raw, start, end)


def parse_heading(line: str) -> tuple[int, str] | None:
    level = 0
    while level < len(line) and line[level] == "#":
        level += 1
    if (
        not 1 <= level <= 6
        or level == len(line)
        or ord(line[level]) not in JS_TRIM_UNITS
    ):
        return None

    start = level
    while start < len(line) and ord(line[start]) in JS_TRIM_UNITS:
        start += 1
    if start == len(line):
        start -= 1
        while start > level and ord(line[start]) in JS_DOT_LINE_TERMINATORS:
            start -= 1
        if start == level:
            return None

    end = len(line)
    while end > start and ord(line[end - 1]) in JS_TRIM_UNITS:
        end -= 1
    while end > start and line[end - 1] == "#":
        end -= 1
    while end > start and ord(line[end - 1]) in JS_TRIM_UNITS:
        end -= 1
    end = max(end, start + 1)
    content = line[start:end]
    if any(ord(char) in JS_DOT_LINE_TERMINATORS for char in content):
        return None
    return level, content


def split_sections(text: str) -> list[tuple[list[str], list[str]]]:
    sections: list[tuple[list[str], list[str]]] = [([], [])]
    stack: list[tuple[int, str]] = []
    for line in text.split("\n"):
        heading = parse_heading(line)
        if heading:
            level, content = heading
            stack = [active for active in stack if active[0] < level]
            stack.append((level, content))
            sections.append(([active[1] for active in stack], []))
        else:
            sections[-1][1].append(line)
    return [section for section in sections if js_trim("\n".join(section[1]))]


def pack_paragraphs(body: str, max_chars: int) -> list[str]:
    paragraphs = [js_trim(p) for p in re.split(rf"\n{JS_WS_RE}*\n", body) if js_trim(p)]
    output: list[str] = []
    current = ""

    def flush() -> None:
        nonlocal current
        if current:
            output.append(current)
            current = ""

    for paragraph in paragraphs:
        if js_units(paragraph) > max_chars:
            flush()
            lines = paragraph.split("\n")
            if sum(bool(BULLET_RE.match(line)) for line in lines) >= 2:
                line_chunk = ""
                for line in lines:
                    if js_units(line) > max_chars:
                        if line_chunk:
                            output.append(line_chunk)
                            line_chunk = ""
                        pieces, rest = split_oversized(line, max_chars, trim_first=False)
                        output.extend(pieces)
                        line_chunk = rest
                        continue
                    joined = f"{line_chunk}\n{line}" if line_chunk else line
                    if line_chunk and js_units(joined) > max_chars:
                        output.append(line_chunk)
                        line_chunk = ""
                    line_chunk = f"{line_chunk}\n{line}" if line_chunk else line
                if js_trim(line_chunk):
                    output.append(line_chunk)
                continue
            pieces, rest = split_oversized(paragraph, max_chars)
            output.extend(pieces)
            if rest:
                current = rest
            continue
        joined = f"{current}\n\n{paragraph}" if current else paragraph
        if current and js_units(joined) > max_chars:
            flush()
        current = f"{current}\n\n{paragraph}" if current else paragraph
    flush()
    return output


# NOT the same thing as CREDIT_LINE_RE above, and it used to share its name.
# This one is the chunker's TRAILING attribution line — the markdown-italic
# form, no capture group. CREDIT_LINE_RE is the doctor's credit DETECTOR and
# carries the group that has_substantive_credit reads. Same name at module
# scope meant this definition silently won, so the doctor's credit check ran
# the wrong pattern everywhere and crashed outright — IndexError: no such
# group — on any document containing a `*Credit: ...*` line. The repo's own
# bundled survival-guide is such a document, so `python3 tools/check_pack.py
# --builtin assets/packs/survival-guide/` — the command PACK-FORMAT.md gives
# contributors — ended in a traceback.
TRAILING_CREDIT_RE = re.compile(r"^\*Credit:.*\*$")


def trailing_credit(body: str) -> str | None:
    """A section's closing attribution line — parity with src/packs/chunker.ts."""
    lines = body.rstrip().split("\n")
    last = lines[-1].strip() if lines else ""
    return last if TRAILING_CREDIT_RE.match(last) else None


def chunk_document(text: str, max_chars: int = DEFAULT_MAX_CHARS) -> list[tuple[str, str]]:
    """PARITY PORT of src/packs/chunker.ts chunkDocument — including the
    credit-rides-with-content rule (2026-08-24). A credited section longer
    than the budget used to split its attribution away from the technique it
    credits; every piece now carries the section's credit line, and the
    budget is reduced by the credit's length first so no chunk exceeds the
    excerpt unit. DRIFT HERE MIS-KEYS EVERY EMBEDDING — the installer's
    stale-vector guard is what catches it."""
    chunks: list[tuple[str, str]] = []
    for breadcrumb, lines in split_sections(text):
        heading = " > ".join(breadcrumb)
        body = "\n".join(lines)
        credit = trailing_credit(body)
        budget = max(200, max_chars - len(credit) - 2) if credit else max_chars
        for piece in pack_paragraphs(body, budget):
            content = piece if (credit is None or credit in piece) else f"{piece}\n\n{credit}"
            chunks.append((heading, content))
    return chunks


def parse_playa_address(address: str) -> bool:
    value = js_trim(address).lower()
    if not value:
        return False
    if "center camp" in value or "temple" in value:
        return True
    if value in {"man", "the man"}:
        return True
    match = CLOCK_RE.search(value)
    if not match:
        return False
    hour, minute = int(match.group(1)), int(match.group(2))
    if not 1 <= hour <= 12 or minute > 59:
        return False
    if "deep playa" in value or "esplanade" in value:
        return True
    return bool(RING_RE.search(value))


def check_clock_shape(location: str) -> bool:
    value = js_trim(location).lower()
    grid_context = bool(RING_RE.search(value)) or any(
        landmark in value for landmark in ("esplanade", "deep playa")
    )
    for match in CLOCK_TOKEN_RE.finditer(value):
        hour_text, minute_text = match.group(1), match.group(2)
        context = value[
            max(0, match.start() - 24) : min(len(value), match.end() + 24)
        ]
        nonclock_context = (
            (match.start() > 0 and value[match.start() - 1] == ".")
            or re.search(r"\b(?:ratio|port|server)\b", context) is not None
        )
        likely_general_time = (
            not nonclock_context
            and len(hour_text) <= 2
            and len(minute_text) == 2
            and int(minute_text) > 59
        )
        malformed_grid_time = grid_context and (
            len(hour_text) > 2
            or len(minute_text) != 2
            or not 1 <= int(hour_text) <= 12
            or int(minute_text) > 59
        )
        if likely_general_time or malformed_grid_time:
            return True
    return False


def manifest_check(path: pathlib.Path, report: Report) -> dict[str, Any] | None:
    try:
        raw = load_json(path)
    except ValueError as exc:
        report.fail("manifest", str(exc))
        return None
    if not isinstance(raw, dict):
        report.fail("manifest", "pack.json must be a JSON object")
        return None
    errors: list[str] = []
    pack_id = raw.get("id")
    name = raw.get("name")
    version = raw.get("version")
    if not isinstance(pack_id, str) or not PACK_ID_RE.fullmatch(pack_id):
        errors.append('"id" must match ^[a-z0-9][a-z0-9-]{1,63}$')
    if not isinstance(name, str) or not js_trim(name):
        errors.append('"name" must be a nonempty string')
    if not is_int(version):
        errors.append('"version" must be a finite JavaScript integer')
    elif abs(version) > JS_SAFE_INTEGER:
        errors.append('"version" must be a JavaScript safe integer')
    if errors:
        report.fail("manifest", "; ".join(errors))
        return None
    description = raw.get("description", "")
    if not isinstance(description, str):
        report.warn("manifest-description", 'non-string "description" becomes empty on the phone')
    elif not js_trim(description):
        report.warn("manifest-description", "empty description gives campers no source or purpose context")
    else:
        report.passed("manifest-description", "nonempty camper-facing description")
    if version <= 0:
        report.warn("manifest-version", f"version {version} is accepted, but public packs should start at 1")
    report.passed("manifest", f"id and name valid; version={version}")
    return raw


def event_string(row: dict[str, Any], field_name: str, file_name: str, row_number: int,
                 report: Report, required: bool = False) -> str | None:
    value = row[field_name] if field_name in row else ""
    if not isinstance(value, str):
        report.fail(
            f"events:{file_name}",
            f"row {row_number} {field_name!r} must be a string (doctor is stricter than runtime coercion)",
        )
        return None
    value = js_trim(value)
    if required and not value:
        report.fail(f"events:{file_name}", f"row {row_number} {field_name!r} is required")
        return None
    return value


def validate_event(row: Any, file_name: str, row_number: int, report: Report) -> dict[str, str] | None:
    if not isinstance(row, dict):
        report.fail(f"events:{file_name}", f"row {row_number} must be a JSON object")
        return None
    title = event_string(row, "title", file_name, row_number, report, required=True)
    date_text = event_string(row, "date", file_name, row_number, report, required=True)
    if title is None or date_text is None:
        return None
    if not DATE_RE.fullmatch(date_text):
        report.fail(f"events:{file_name}", f"row {row_number} date must be YYYY-MM-DD, got {date_text!r}")
        return None
    try:
        date_value = dt.date.fromisoformat(date_text)
    except ValueError:
        report.fail(f"events:{file_name}", f"row {row_number} has impossible calendar date {date_text!r}")
        return None
    if date_value.year < 100:
        report.fail(
            f"events:{file_name}",
            f"row {row_number} year must be 0100 or later; JavaScript remaps years 0000..0099",
        )
        return None
    normalized: dict[str, str] = {"title": title, "date": date_text}
    for field_name in OPTIONAL_EVENT_FIELDS:
        value = event_string(row, field_name, file_name, row_number, report)
        if value is None:
            return None
        normalized[field_name] = value
    if check_clock_shape(normalized["location"]):
        report.fail(
            f"events:{file_name}",
            f"row {row_number} location contains a malformed clock-like grid token",
        )
        return None
    for field_name in ("time_start", "time_end"):
        value = normalized[field_name]
        if not value:
            continue
        if not TIME_RE.fullmatch(value):
            report.fail(f"events:{file_name}", f"row {row_number} {field_name} must be HH:MM or empty")
            return None
        hour, minute = (int(part) for part in value.split(":"))
        if hour > 23 or minute > 59:
            report.fail(f"events:{file_name}", f"row {row_number} has impossible {field_name} {value!r}")
            return None
    supplied_day = row.get("day")
    actual_day = WEEKDAYS[date_value.weekday()]
    if supplied_day is not None and not isinstance(supplied_day, str):
        report.warn(
            f"events:{file_name}:day",
            f"row {row_number} has a non-string day; phone ignores it and derives {actual_day!r}",
        )
    elif isinstance(supplied_day, str) and js_trim(supplied_day) and js_trim(supplied_day) != actual_day:
        report.warn(
            f"events:{file_name}:day",
            f"row {row_number} says {js_trim(supplied_day)!r}; phone ignores it and derives {actual_day!r}",
        )
    return normalized


def json_events(path: pathlib.Path, report: Report) -> list[dict[str, str]]:
    label = f"events:{path.name}"
    try:
        raw = load_json(path)
    except ValueError as exc:
        report.fail(label, str(exc))
        return []
    if not isinstance(raw, list):
        report.fail(label, "expected a top-level JSON array of event objects")
        return []
    before = report.failures
    events = [event for i, row in enumerate(raw, 1) if (event := validate_event(row, path.name, i, report))]
    if report.failures == before:
        report.passed(label, f"{len(events)} valid event row(s)")
    return events


def parse_csv(text: str) -> list[list[str]]:
    """Port installPack.ts parseCsv, with a publication-only unclosed-quote gate."""
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    in_quotes = False
    i = 0

    def push_field() -> None:
        nonlocal field
        row.append("".join(field))
        field = []

    def push_row() -> None:
        nonlocal row
        push_field()
        if len(row) > 1 or js_trim(row[0]):
            rows.append(row)
        row = []

    while i < len(text):
        char = text[i]
        if in_quotes:
            if char == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                in_quotes = False
                i += 1
                continue
            field.append(char)
            i += 1
            continue
        if char == '"':
            in_quotes = True
        elif char == ",":
            push_field()
        elif char == "\n":
            push_row()
        elif char != "\r":
            field.append(char)
        i += 1
    if in_quotes:
        raise ValueError("CSV ends inside a quoted field")
    if field or row:
        push_row()
    return rows


def csv_events(path: pathlib.Path, report: Report) -> list[dict[str, str]]:
    label = f"events:{path.name}"
    try:
        rows = parse_csv(read_text(path))
    except ValueError as exc:
        report.fail(label, str(exc))
        return []
    if len(rows) < 2:
        report.fail(label, "CSV needs a header row plus at least one event")
        return []
    headers = [js_trim(cell).lower() for cell in rows[0]]
    if "title" not in headers or "date" not in headers:
        report.fail(label, 'CSV header must include "title" and "date"')
        return []
    if len(set(headers)) != len(headers):
        report.warn(f"{label}:header", "duplicate header names overwrite earlier values on the phone")
    before = report.failures
    events: list[dict[str, str]] = []
    for i, cells in enumerate(rows[1:], 1):
        raw = {header: cells[column] if column < len(cells) else "" for column, header in enumerate(headers)}
        event = validate_event(raw, path.name, i, report)
        if event:
            events.append(event)
    if report.failures == before:
        report.passed(label, f"{len(events)} valid event row(s)")
    return events


def check_addresses(events: list[dict[str, str]], report: Report) -> None:
    locations = 0
    recognized = 0
    for event in events:
        value = event["location"]
        if not value:
            continue
        locations += 1
        if parse_playa_address(value):
            recognized += 1
    unrecognized = locations - recognized
    report.passed(
        "addresses",
        f"{recognized}/{locations} nonblank locations match the walk-time parser; "
        f"{unrecognized} venue/free-text location(s) remain valid but get no walk estimate",
    )
    if unrecognized:
        report.warn(
            "address-coverage",
            f"{unrecognized} location(s) are free text; values are redacted from diagnostics",
        )


def normalize_entity(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    plain = "".join(char for char in decomposed if not unicodedata.category(char).startswith("M")).lower()
    words: list[str] = []
    current: list[str] = []
    for char in plain:
        if unicodedata.category(char)[0] in {"L", "N"}:
            current.append(char)
        elif current:
            words.append("".join(current))
            current = []
    if current:
        words.append("".join(current))
    return " ".join(words)


def person_card_heading_name(heading: str) -> str | None:
    parts = [js_trim(part) for part in heading.split(">") if js_trim(part)]
    if len(parts) != 3:
        return None
    card = CAMPER_HEADING_RE.fullmatch(parts[1])
    leaf = WHO_IS_HEADING_RE.fullmatch(parts[2])
    if not card or not leaf or card.group(1) != leaf.group(1):
        return None
    return card.group(1)


def person_card_problem(name: str, source: str, heading: str, content: str) -> str | None:
    if not source.startswith("people-"):
        return "source filename must start with 'people-'"
    heading_name = person_card_heading_name(heading)
    if heading_name is None:
        return "heading must have three segments ending '<name> — <camp> camper > Who is <name>?'"
    if normalize_entity(heading_name) != normalize_entity(name):
        return "linked chunk names another person"
    paragraphs = [js_trim(part) for part in re.split(rf"\n{JS_WS_RE}*\n", content) if js_trim(part)]
    lead = paragraphs[0] if paragraphs else ""
    lead_name = normalize_entity(lead)
    expected_name = normalize_entity(name)
    if lead_name != expected_name and not lead_name.startswith(expected_name + " "):
        return "first paragraph must open with the person's name"
    if not TENURE_RE.search(lead):
        return "first paragraph needs an activity window such as 'from Jan 2020 to Aug 2026'"
    return None


def graph_array(path: pathlib.Path, report: Report) -> list[Any] | None:
    try:
        raw = load_json(path)
    except ValueError as exc:
        report.fail(f"graph:{path.name}", str(exc))
        return None
    if not isinstance(raw, list):
        report.fail(f"graph:{path.name}", "expected a top-level JSON array")
        return None
    return raw


def graph_string(row: dict[str, Any], field_name: str) -> str | None:
    value = row.get(field_name)
    return js_trim(value) if isinstance(value, str) and js_trim(value) else None


def effective_provenance_tier(evidence: str | None, tier: Any) -> str | None:
    if isinstance(tier, str) and tier.lower() in PROVENANCE_TIERS:
        return tier.lower()
    head = re.split(rf"{JS_WS_RE}+", js_trim(evidence or ""), maxsplit=1)[0].lower()
    if head in {"stated", "roster", "inferred", "owner-stated"}:
        return head
    if head == "said":
        return "stated-on-playa"
    return None


def displayed_statement_date(evidence: str | None) -> str | None:
    ref = js_trim(evidence or "")
    patterns = (
        r"^stated\s+(\S+)\s+[A-Za-z0-9_-]+#[0-9]+$",
        r"^stated\s+(\S+)$",
        r"^owner-stated\s+(\S+)$",
        r"^said\s+(\S+)\s+by\s+.+$",
    )
    for pattern in patterns:
        if match := re.fullmatch(pattern, ref, flags=re.IGNORECASE):
            return match.group(1)
    return None


def check_graph(
    nodes_path: pathlib.Path | None,
    edges_path: pathlib.Path | None,
    chunk_meta: dict[str, tuple[str, str]],
    report: Report,
) -> tuple[int, int]:
    nodes: list[Any] = []
    node_ids: set[str] = set()
    used_card_keys: set[str] = set()
    chunks_by_source: dict[str, list[tuple[str, str, str]]] = {}
    card_chunks: dict[tuple[str, str], list[tuple[str, str, str]]] = {}
    for key, (heading, content) in chunk_meta.items():
        source = key.rsplit(":", 1)[0]
        item = (key, heading, content)
        chunks_by_source.setdefault(source, []).append(item)
        heading_name = person_card_heading_name(heading)
        if heading_name is not None:
            card_chunks.setdefault((source, normalize_entity(heading_name)), []).append(item)
    if nodes_path:
        raw_nodes = graph_array(nodes_path, report)
        if raw_nodes is not None:
            nodes = raw_nodes
            person_name_counts: dict[str, int] = {}
            for row in nodes:
                if not isinstance(row, dict) or graph_string(row, "type") != "person":
                    continue
                person_name = graph_string(row, "name")
                if person_name:
                    key = normalize_entity(person_name)
                    person_name_counts[key] = person_name_counts.get(key, 0) + 1
            before = report.failures
            for i, row in enumerate(nodes, 1):
                if not isinstance(row, dict):
                    report.fail("graph:nodes.json", f"row {i} must be an object")
                    continue
                node_id = graph_string(row, "id")
                node_type = graph_string(row, "type")
                name = graph_string(row, "name")
                if not node_id or not GRAPH_ID_RE.fullmatch(node_id):
                    report.fail("graph:nodes.json", f"row {i} has invalid or missing id")
                elif node_id in node_ids:
                    report.fail("graph:nodes.json", f"row {i} duplicates an earlier node id")
                else:
                    node_ids.add(node_id)
                if not node_type or not GRAPH_TYPE_RE.fullmatch(node_type):
                    report.fail("graph:nodes.json", f"row {i} has invalid or missing type")
                if not name:
                    report.fail("graph:nodes.json", f"row {i} name is required")
                attrs = row.get("attrs")
                if attrs is not None and not isinstance(attrs, dict):
                    report.fail("graph:nodes.json", f"row {i} attrs must be an object or null")
                    continue
                if node_type == "person" and isinstance(attrs, dict):
                    pointer = attrs.get("card_chunk")
                    card_key: str | None = None
                    if isinstance(pointer, str):
                        match = re.fullmatch(r"(.*):([0-9]+)", js_trim(pointer))
                        if match and match.group(1):
                            index = decimal_safe_index(match.group(2))
                            if index is not None:
                                card_key = f"{match.group(1)}:{index}"
                    elif isinstance(pointer, dict):
                        source = pointer.get("source_file")
                        index = nonnegative_safe_index(pointer.get("index"))
                        if isinstance(source, str) and source and index is not None:
                            card_key = f"{source}:{index}"
                    if pointer is not None and card_key is None:
                        report.fail("graph:card-chunk", f"row {i} card_chunk has an invalid shape")
                    elif card_key is not None:
                        if card_key not in chunk_meta:
                            report.fail("graph:card-chunk", f"row {i} points to an unavailable chunk")
                        elif card_key in used_card_keys:
                            report.fail("graph:card-chunk", f"row {i} reuses an already assigned chunk")
                        else:
                            heading, content = chunk_meta[card_key]
                            source = card_key.rsplit(":", 1)[0]
                            problem = person_card_problem(name, source, heading, content) if name else None
                            if problem:
                                report.fail("graph:card-chunk", f"row {i} {problem}")
                            elif name:
                                used_card_keys.add(card_key)
                    legacy = attrs.get("card")
                    if card_key is None and legacy is not None:
                        if not isinstance(legacy, str) or not js_trim(legacy):
                            report.warn("graph:legacy-card", f"row {i} attrs.card must name a source file")
                            continue
                        source_chunks = chunks_by_source.get(legacy, [])
                        if not source_chunks:
                            report.warn("graph:legacy-card", f"row {i} named source has no generated chunks")
                            continue
                        if not name or person_name_counts.get(normalize_entity(name)) != 1:
                            report.warn(
                                "graph:legacy-card",
                                f"row {i} person name is not unique; legacy card remains unindexed",
                            )
                            continue
                        matches = card_chunks.get((legacy, normalize_entity(name)), [])
                        if len(matches) != 1:
                            report.warn(
                                "graph:legacy-card",
                                f"row {i} has {len(matches)} matching heading(s); legacy card remains unindexed",
                            )
                            continue
                        legacy_key, heading, content = matches[0]
                        if legacy_key in used_card_keys:
                            report.warn(
                                "graph:legacy-card",
                                f"row {i} matching chunk is already assigned; legacy card remains unindexed",
                            )
                            continue
                        used_card_keys.add(legacy_key)
                        if problem := person_card_problem(name, legacy, heading, content):
                            report.warn("graph:legacy-card", f"row {i} {problem}; card falls back to prose")
            if report.failures == before:
                report.passed("graph:nodes.json", f"{len(nodes)} node(s), all ids unique")
    else:
        report.passed("graph:nodes.json", "not present")

    edges: list[Any] = []
    if edges_path:
        raw_edges = graph_array(edges_path, report)
        if raw_edges is not None:
            edges = raw_edges
            before = report.failures
            seen: set[tuple[Any, ...]] = set()
            provenance_issues = {
                "tier": 0,
                "tier/evidence mismatch": 0,
                "stated_on": 0,
                "evidence date": 0,
                "stated_on/evidence date mismatch": 0,
                "year_source": 0,
                "said_names": 0,
            }
            for i, row in enumerate(edges, 1):
                if not isinstance(row, dict):
                    report.fail("graph:edges.json", f"row {i} must be an object")
                    continue
                src = graph_string(row, "src")
                dst = graph_string(row, "dst")
                edge_type = graph_string(row, "type")
                evidence = graph_string(row, "evidence_ref")
                if not src or not GRAPH_ID_RE.fullmatch(src):
                    report.fail("graph:edges.json", f"row {i} has invalid or missing src")
                if not dst or not GRAPH_ID_RE.fullmatch(dst):
                    report.fail("graph:edges.json", f"row {i} has invalid or missing dst")
                if not edge_type or not GRAPH_TYPE_RE.fullmatch(edge_type):
                    report.fail("graph:edges.json", f"row {i} has invalid or missing type")
                if not evidence:
                    report.fail("graph:edges.json", f"row {i} evidence_ref is required")
                year = row.get("year")
                valid_year = year is None or (is_int(year) and 1 <= year <= 9999)
                if not valid_year:
                    report.fail("graph:edges.json", f"row {i} year must be null or an integer 1..9999")
                attrs = row.get("attrs")
                if attrs is not None and not isinstance(attrs, dict):
                    report.fail("graph:edges.json", f"row {i} attrs must be an object or null")
                if not isinstance(attrs, dict):
                    provenance_issues["tier"] += 1
                    provenance_issues["year_source"] += 1
                    provenance_issues["said_names"] += 1
                    if effective_provenance_tier(evidence, None) in STATEMENT_TIERS:
                        provenance_issues["stated_on"] += 1
                else:
                    tier = attrs.get("tier")
                    effective_tier = effective_provenance_tier(evidence, tier)
                    evidence_tier = effective_provenance_tier(evidence, None)
                    if not isinstance(tier, str) or tier.lower() not in PROVENANCE_TIERS:
                        provenance_issues["tier"] += 1
                    elif evidence_tier is not None and tier.lower() != evidence_tier:
                        provenance_issues["tier/evidence mismatch"] += 1
                    stated_on = attrs.get("stated_on")
                    statement_evidence = (
                        effective_tier in STATEMENT_TIERS
                        or evidence_tier in STATEMENT_TIERS
                    )
                    if stated_on is not None:
                        if not is_iso_date(stated_on):
                            provenance_issues["stated_on"] += 1
                    elif statement_evidence:
                        provenance_issues["stated_on"] += 1
                    if statement_evidence:
                        evidence_date = displayed_statement_date(evidence)
                        if not is_iso_date(evidence_date):
                            provenance_issues["evidence date"] += 1
                        elif is_iso_date(stated_on) and evidence_date != stated_on:
                            provenance_issues["stated_on/evidence date mismatch"] += 1
                    if not isinstance(attrs.get("year_source"), str) or not js_trim(attrs["year_source"]):
                        provenance_issues["year_source"] += 1
                    said_names = attrs.get("said_names")
                    if (
                        not isinstance(said_names, list)
                        or not said_names
                        or any(not isinstance(value, str) or not js_trim(value) for value in said_names)
                    ):
                        provenance_issues["said_names"] += 1
                if src and src not in node_ids:
                    report.fail("graph:integrity", f"row {i} src is missing from nodes.json")
                if dst and dst not in node_ids:
                    report.fail("graph:integrity", f"row {i} dst is missing from nodes.json")
                key = (src, dst, edge_type, year if valid_year else "<invalid-year>", evidence)
                if key in seen:
                    report.fail("graph:edges.json", f"duplicate edge identity at row {i}")
                seen.add(key)
            if report.failures == before:
                report.passed("graph:edges.json", f"{len(edges)} edge(s), endpoints resolve")
            issues = [f"{count} invalid/missing {field_name}" for field_name, count in provenance_issues.items() if count]
            if issues:
                report.warn(
                    "graph:provenance",
                    "; ".join(issues) + "; accepted by installer but less auditable",
                )
    else:
        report.passed("graph:edges.json", "not present")
    return len(nodes), len(edges)


def has_substantive_credit(text: str) -> bool:
    for line in CREDIT_LINE_BREAK_RE.split(text):
        match = CREDIT_LINE_RE.fullmatch(line)
        if match and js_trim(match.group(1)):
            return True
    return False


def check_credits(documents: list[tuple[str, str, int]], report: Report) -> None:
    if not documents:
        report.passed("document-credits", "not applicable (no document files)")
        return
    missing = [
        name
        for name, text, _ in documents
        if not has_substantive_credit(text)
    ]
    if missing:
        report.fail(
            "document-credits",
            "each document needs a capitalized Credit: line; missing in " + ", ".join(missing),
        )
    else:
        report.passed("document-credits", f"credit line present in all {len(documents)} document(s)")


def check_embeddings(path: pathlib.Path | None, chunk_keys: Iterable[str], report: Report) -> None:
    if not path:
        report.passed("embeddings", "not present; keyword search remains available")
        return
    try:
        raw = load_json(path)
    except ValueError as exc:
        report.fail("embeddings", str(exc))
        return
    if not isinstance(raw, dict):
        report.fail("embeddings", "embeddings.json must be an object")
        return
    model = raw.get("model")
    dim = raw.get("dim")
    vectors = raw.get("vectors")
    if not isinstance(model, str) or not js_trim(model):
        report.fail("embeddings", '"model" must be a nonempty string')
        return
    if dim != VECTOR_DIM or isinstance(dim, bool):
        report.fail("embeddings", f'"dim" must be exactly {VECTOR_DIM}')
        return
    if not isinstance(vectors, dict):
        report.fail("embeddings", '"vectors" must be an object')
        return
    expected = set(chunk_keys)
    actual = set(vectors)
    orphan = sorted(actual - expected)
    missing = sorted(expected - actual)
    if orphan:
        report.fail("embeddings", f"{len(orphan)} orphan/stale vector key(s)")
    if missing:
        report.fail(
            "embeddings",
            f"missing {len(missing)} of {len(expected)} chunk vector(s)",
        )
    bad_vector: str | None = None
    for key, vector in vectors.items():
        if not isinstance(vector, list) or len(vector) != VECTOR_DIM:
            bad_vector = f"a vector must contain exactly {VECTOR_DIM} numbers"
            break
        if any(not is_finite_number(value) for value in vector):
            bad_vector = "a vector contains a non-finite or non-numeric value"
            break
    if bad_vector:
        report.fail("embeddings", bad_vector)
    if js_trim(model) != SEMANTIC_MODEL:
        report.warn(
            "embedding-model",
            f"{js_trim(model)!r} installs but runtime semantic search only queries {SEMANTIC_MODEL!r}",
        )
    else:
        report.passed("embedding-model", js_trim(model))
    if not orphan and not missing and not bad_vector:
        report.passed("embeddings", f"{len(actual)}/{len(expected)} chunk vector(s), dim={VECTOR_DIM}")


def wrapper_document(
    path: pathlib.Path,
    manifest: dict[str, Any] | None,
    builtin: bool,
) -> tuple[str, str] | None:
    """Recognize only the app's exact built-in Metro transport exception."""
    if (
        not builtin
        or manifest is None
        or manifest.get("id") != "survival-guide"
        or path.name.lower() != "guide.md.json"
    ):
        return None
    try:
        raw = load_json(path)
    except ValueError:
        return None
    if not isinstance(raw, dict) or set(raw) != {"file", "markdown"}:
        return None
    name = raw.get("file")
    markdown = raw.get("markdown")
    if name != "guide.md" or not isinstance(markdown, str):
        return None
    return name, markdown


def check_builtin_sources(pack_dir: pathlib.Path, markdown: str, report: Report) -> None:
    source_dir = pack_dir / "src"
    if source_dir.is_symlink():
        report.fail("builtin-sources", "src/ must be a real directory, not a symbolic link")
        return
    if not source_dir.is_dir():
        report.warn("builtin-sources", "src/ is absent, so generated guide.md cannot be reproduced here")
        return
    try:
        entries = sorted(
            source_dir.iterdir(),
            key=lambda path: path.name.encode("utf-16-be", errors="surrogatepass"),
        )
    except OSError as exc:
        report.fail("builtin-sources", f"cannot list src/: {exc}")
        return
    unsafe = [path for path in entries if path.is_symlink() or not path.is_file()]
    if unsafe:
        report.fail(
            "builtin-sources",
            "src/ may contain regular files only: " + ", ".join(path.name for path in unsafe),
        )
        return
    unexpected = [path for path in entries if path.suffix != ".md"]
    if unexpected:
        report.fail(
            "builtin-sources",
            "src/ contains non-Markdown file(s): " + ", ".join(path.name for path in unexpected),
        )
        return
    try:
        sizes = [path.stat().st_size for path in entries]
    except OSError as exc:
        report.fail("builtin-sources", f"cannot inspect src/ file sizes: {exc}")
        return
    if any(size > MAX_FILE_BYTES for size in sizes) or sum(sizes) > MAX_PACK_BYTES:
        report.fail("builtin-sources", "src/ exceeds public mobile-pack size limits")
        return
    sources = [path for path in entries if path.name != "SOURCES.md"]
    try:
        expected = "\n\n".join(js_trim(read_text(path)) for path in sources)
    except ValueError as exc:
        report.fail("builtin-sources", str(exc))
        return
    if not sources:
        report.fail("builtin-sources", "src/ contains no input Markdown files")
    elif markdown != expected:
        report.fail(
            "builtin-sources",
            "guide.md.json is stale; markdown does not equal sorted src/*.md excluding SOURCES.md",
        )
    else:
        report.passed("builtin-sources", f"wrapper exactly reproduces {len(sources)} sorted source file(s)")


def doctor(pack_dir: pathlib.Path, builtin: bool = False) -> Report:
    report = Report()
    if pack_dir.is_symlink():
        report.fail("file-set", "pack path must be a real directory, not a symbolic link")
        return report
    if not pack_dir.is_dir():
        report.fail("file-set", "path is not a directory")
        return report

    try:
        entries = sorted(pack_dir.iterdir(), key=lambda path: path.name.lower())
    except OSError as exc:
        report.fail("file-set", f"cannot list directory: {exc}")
        return report
    symlinks = [path for path in entries if path.is_symlink()]
    files = [path for path in entries if not path.is_symlink() and path.is_file()]
    directories = [path for path in entries if not path.is_symlink() and path.is_dir()]
    classified = set(symlinks + files + directories)
    special = [path for path in entries if path not in classified]
    if symlinks:
        report.fail(
            "file-set",
            "symbolic links are not pack files: " + ", ".join(path.name for path in symlinks),
        )
    if special:
        report.fail(
            "file-set",
            "non-regular filesystem entries are not pack files: "
            + ", ".join(path.name for path in special),
        )
    by_lower: dict[str, list[pathlib.Path]] = {}
    for path in files:
        by_lower.setdefault(path.name.lower(), []).append(path)
    duplicates = [name for name, paths in by_lower.items() if name in RESERVED and len(paths) > 1]
    if duplicates:
        report.fail("file-set", "case-insensitive duplicate reserved name(s): " + ", ".join(duplicates))
    if not symlinks and not special and not duplicates:
        report.passed("file-set", f"{len(files)} immediate file(s); flat picker-compatible names")
    if len(files) > MAX_PACK_FILES:
        report.fail(
            "resource-limits",
            f"{len(files)} files exceed the public-pack limit of {MAX_PACK_FILES}",
        )
        return report
    try:
        sizes = {path: path.stat().st_size for path in files}
    except OSError as exc:
        report.fail("resource-limits", f"cannot inspect file sizes: {exc}")
        return report
    oversized = sum(size > MAX_FILE_BYTES for size in sizes.values())
    total_bytes = sum(sizes.values())
    if oversized:
        report.fail(
            "resource-limits",
            f"{oversized} file(s) exceed the {MAX_FILE_BYTES // (1024 * 1024)} MiB per-file limit",
        )
    if total_bytes > MAX_PACK_BYTES:
        report.fail(
            "resource-limits",
            f"{total_bytes} bytes exceed the {MAX_PACK_BYTES // (1024 * 1024)} MiB total-pack limit",
        )
    if oversized or total_bytes > MAX_PACK_BYTES:
        return report
    report.passed(
        "resource-limits",
        f"{len(files)} file(s), {total_bytes} byte(s) within public mobile-pack limits",
    )
    ordinary_case_variants = [
        name for name, paths in by_lower.items() if name not in RESERVED and len(paths) > 1
    ]
    if ordinary_case_variants:
        report.warn(
            "file-name-case",
            "case-only content-name variants are accepted but fragile: " + ", ".join(ordinary_case_variants),
        )
    if directories:
        names = ", ".join(path.name for path in directories)
        if builtin and {path.name for path in directories} == {"src"}:
            report.passed(
                "file-set-directories",
                "src/ is reproducibility input only and is not part of the installed payload",
            )
        else:
            report.warn(
                "file-set-directories",
                "subdirectories are not imported and were ignored: " + names,
            )

    camp_beams: list[str] = []
    for path in files:
        try:
            raw = load_json(path)
        except ValueError:
            continue
        if isinstance(raw, dict) and raw.get("kind") == CAMP_BUNDLE_KIND:
            camp_beams.append(path.name)
    if camp_beams:
        report.fail(
            "file-set",
            "camp-board beam content must be imported by itself, not as a pack: " + ", ".join(camp_beams),
        )

    manifest_files = by_lower.get("pack.json", [])
    if len(manifest_files) != 1:
        report.fail("manifest", f"expected exactly one pack.json, found {len(manifest_files)}")
        manifest = None
    else:
        manifest = manifest_check(manifest_files[0], report)
    if manifest is not None:
        pack_id = manifest.get("id")
        if builtin and pack_id not in BUILTIN_IDS:
            report.fail("builtin-id", f"--builtin only accepts repository IDs: {', '.join(sorted(BUILTIN_IDS))}")
        elif builtin:
            expected_files = BUILTIN_FILES[pack_id]
            actual_files = {path.name for path in files}
            missing = sorted(expected_files - actual_files)
            extra = sorted(actual_files - expected_files)
            if missing or extra:
                details = []
                if missing:
                    details.append("missing " + ", ".join(missing))
                if extra:
                    details.append("not bundled by src/packs/builtins.ts: " + ", ".join(extra))
                report.fail("builtin-layout", "; ".join(details))
            else:
                report.passed("builtin-layout", "exact static payload file set")
        elif pack_id in BUILTIN_IDS:
            report.fail(
                "manifest-id",
                f"{pack_id!r} is reserved by a bundled pack; a same-version import can replace trusted content",
            )
        elif any(pack_id.startswith(prefix) for prefix in INTERNAL_PACK_PREFIXES):
            report.fail(
                "manifest-id",
                f"{pack_id!r} uses an app-internal camp-board namespace; choose a contributor-owned id",
            )

    nodes_path = (by_lower.get("nodes.json") or [None])[0]
    edges_path = (by_lower.get("edges.json") or [None])[0]
    embeddings_path = (by_lower.get("embeddings.json") or [None])[0]
    flags_path = (by_lower.get("flags.json") or [None])[0]

    if flags_path:
        try:
            flags_text = read_text(flags_path)
        except ValueError as exc:
            report.fail("flags.json", f"reserved file must still be UTF-8: {exc}")
        else:
            control = first_nontext_control(flags_text)
            if control is not None:
                report.fail(
                    "flags.json",
                    f"reserved file contains non-text control U+{control:04X}",
                )
            else:
                report.passed(
                    "flags.json",
                    "UTF-8 text; reserved, installer-inert, and intentionally not parsed",
                )
    else:
        report.passed("flags.json", "not present")

    events: list[dict[str, str]] = []
    documents: list[tuple[str, str, int]] = []
    unsupported: list[str] = []
    for path in files:
        lower = path.name.lower()
        if lower in RESERVED:
            continue
        wrapper = wrapper_document(path, manifest, builtin)
        if wrapper:
            source_name, markdown = wrapper
            documents.append((source_name, markdown, BUILTIN_GUIDE_MAX_CHARS))
            report.passed(
                f"document:{path.name}",
                f"bundled Metro wrapper -> {source_name} ({BUILTIN_GUIDE_MAX_CHARS}-character chunks); "
                "do not select this wrapper for a normal picker import",
            )
            check_builtin_sources(pack_dir, markdown, report)
            continue
        if builtin and lower == "guide.md.json" and manifest is not None and manifest.get("id") == "survival-guide":
            report.fail(
                f"document:{path.name}",
                'built-in wrapper must be exactly {"file":"guide.md","markdown":"..."}',
            )
            continue
        suffix = path.name[path.name.rfind(".") + 1 :].lower()
        if suffix == "json":
            events.extend(json_events(path, report))
        elif suffix == "csv":
            events.extend(csv_events(path, report))
        elif suffix in {"md", "txt"}:
            try:
                text = read_text(path)
            except ValueError as exc:
                report.fail(f"document:{path.name}", str(exc))
                continue
            if not js_trim(text):
                report.fail(f"document:{path.name}", "document is empty")
                continue
            documents.append((path.name, text, DEFAULT_MAX_CHARS))
        else:
            unsupported.append(path.name)

    if events:
        report.passed("events-total", f"{len(events)} valid event row(s) across the pack")
        check_addresses(events, report)
        identities: set[tuple[str, ...]] = set()
        duplicates_count = 0
        for event in events:
            identity = tuple(event.get(field_name, "") for field_name in EVENT_FIELDS)
            if identity in identities:
                duplicates_count += 1
            else:
                identities.add(identity)
        if duplicates_count:
            report.warn("event-duplicates", f"{duplicates_count} exact duplicate row(s); accepted by installer")
    else:
        report.passed("events-total", "no event rows")
        report.passed("addresses", "not applicable (no event rows)")

    chunk_meta: dict[str, tuple[str, str]] = {}
    document_chunks = 0
    for source_name, text, max_chars in documents:
        chunks = chunk_document(text, max_chars)
        if not chunks:
            report.fail(f"document:{source_name}", "document yields zero nonempty chunks")
            continue
        for index, (heading, content) in enumerate(chunks):
            chunk_meta[f"{source_name}:{index}"] = (heading, content)
        document_chunks += len(chunks)
        report.passed(
            f"document:{source_name}",
            f"nonempty; {len(chunks)} chunk(s) at {max_chars} UTF-16 code units",
        )
    if not documents:
        report.passed("documents-total", "no document files")
    else:
        report.passed("documents-total", f"{len(documents)} document(s), {document_chunks} chunk(s)")
    check_credits(documents, report)

    node_count, edge_count = check_graph(nodes_path, edges_path, chunk_meta, report)
    check_embeddings(embeddings_path, chunk_meta, report)

    if unsupported:
        report.fail(
            "unsupported-files",
            "remove files the phone would skip before sharing/importing: " + ", ".join(unsupported),
        )
    else:
        report.passed("unsupported-files", "none")

    usable = len(events) + document_chunks + node_count + edge_count
    if usable:
        report.passed(
            "usable-content",
            f"{len(events)} event(s), {document_chunks} chunk(s), {node_count} node(s), {edge_count} edge(s)",
        )
    else:
        report.fail("usable-content", "pack needs at least one event, document chunk, node, or edge")

    if builtin and manifest is not None and manifest.get("id") == "survival-guide":
        if not any(path.name.lower() == "guide.md.json" for path in files):
            report.warn("builtin-layout", "survival-guide source lacks the bundled guide.md.json wrapper")
    return report


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--builtin",
        action="store_true",
        help="validate a repository-bundled pack; enables the exact Survival Guide Metro wrapper",
    )
    parser.add_argument("pack_dir", type=pathlib.Path, help="folder whose immediate files form one pack")
    args = parser.parse_args(list(argv) if argv is not None else None)
    pack = args.pack_dir.expanduser().absolute()
    try:
        return doctor(pack, builtin=args.builtin).emit(pack)
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
