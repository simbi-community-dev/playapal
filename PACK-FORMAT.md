# Playa Pal Pack Format

A Playa Pal pack is a small, flat set of UTF-8 files that adds offline events, searchable documents, structured facts, or any combination of those to the app. A pack does not need a server, package manager, ZIP container, or build step.

This document describes the format accepted by the app. Application code is the source of truth: `src/packs/installPack.ts` validates and installs packs, `src/packs/chunker.ts` splits documents, and `src/rightnow/playaWalk.ts` recognizes playa addresses.

## Fast path

Create a folder like this:

```text
my-camp-pack/
├── pack.json
├── events.json       # optional
├── handbook.md       # optional
├── nodes.json        # optional
├── edges.json        # optional
└── embeddings.json   # optional
```

A pack needs `pack.json` plus at least one event, document chunk, graph node, or graph edge.

Before sharing or importing it:

```sh
python3 tools/check_pack.py my-camp-pack
```

Require a final `PACK PASS` and exit status 0. Warnings identify accepted but potentially surprising data; failures must be fixed.

To import, open **Settings › Public packs**, choose the import action, and select **all files in the pack together**. The picker accepts multiple files, not a folder or ZIP archive. If a provider makes multi-selection awkward, use its Select action first and then mark every pack file.

## 1. The flat file set

The files selected in the picker are the entire pack. `pack.json` does not contain a file list, checksums, paths, or minimum-app-version field.

The app keeps each selected file's basename and discards its directory path. For portable packs:

- put every importable file at one level;
- use regular files, never symbolic links, FIFOs, sockets, or device entries;
- give every file a distinct basename;
- use UTF-8 text;
- select all files in one import operation;
- do not include unrelated JSON files.

Five basenames are reserved, case-insensitively:

```text
pack.json
nodes.json
edges.json
embeddings.json
flags.json
```

All other files are interpreted by their final extension:

| File | Interpretation |
|---|---|
| Any unreserved `*.json` | JSON event array |
| `*.csv` | CSV events |
| `*.md` or `*.txt` | Searchable document |
| Anything else | Runtime warning, then skipped; public doctor failure until removed |

This rule is intentionally simple and has one important consequence: **every unreserved JSON file is treated as events**. Do not add arbitrary JSON metadata under another name.

`flags.json` is reserved for future use. The current pack installer deliberately ignores its contents, does not store them, and does not count the file as usable content. The doctor does not invent a schema for it, but still requires UTF-8 text without non-text control characters so every selected file remains directly inspectable. This mechanical check cannot detect encoded secrets; public authors must review the actual text.

The picker first checks every selected file for the separate camp-board beam marker. Do not put a top-level `"kind": "playapal-camp-board"` property in `pack.json`, `flags.json`, or any other pack file: the picker will treat the selection as a beam and require that file to be imported alone.

### Public mobile-pack resource limits

The app reads selected files into memory during import. The public doctor therefore refuses more than 256 immediate regular files, any individual file above 32 MiB, or a combined immediate payload above 64 MiB. The built-in guide's reproducibility `src/` directory uses the same byte ceilings. These are conservative publication gates, not a promise that every pack below them fits every phone: keep packs substantially smaller where possible and exercise the exact files on the oldest supported device.

### Not a normal pack input: `guide.md.json`

The repository's bundled Survival Guide contains a generated `guide.md.json` object:

```json
{
  "file": "guide.md",
  "markdown": "..."
}
```

That is a Metro transport wrapper, not a public picker-import format. The object must contain exactly the two shown fields; extra metadata is still bundled into the application and fails built-in certification. Metro can bundle JSON but not a loose Markdown asset, so `src/packs/builtins.ts` unwraps this exact repository file into a virtual `guide.md` before installation.

Normal contributors must ship a real `.md` or `.txt` file. If a camper selects `guide.md.json` through the normal picker, the generic installer sees an unreserved JSON file and tries to parse it as events.

Repository maintainers can certify the statically bundled exception with explicit built-in mode:

```sh
python3 tools/check_pack.py --builtin assets/packs/survival-guide
```

Without `--builtin`, the doctor follows the normal picker path and rejects the wrapper as non-event JSON. Built-in mode also requires the exact static payload file set named by `src/packs/builtins.ts`: `pack.json` plus `events.json` for the event pack, or `pack.json` plus `guide.md.json` for the guide. Extra immediate files are not bundled and therefore fail certification. The optional guide `src/` reproducibility directory is outside that payload; when present, it must be a real directory containing regular files with the lowercase `.md` extension only, with no links, nested directories, or special entries. The canonical builder concatenates those sources in JavaScript's default UTF-16 filename order, which the doctor reproduces exactly. Never use built-in mode to certify files intended for picker import.

## 2. `pack.json`

Minimal manifest:

```json
{
  "id": "my-camp-pack",
  "name": "My Camp Pack",
  "description": "Public schedules and credited camp guidance.",
  "version": 1
}
```

Fields:

| Field | Runtime rule | Authoring guidance |
|---|---|---|
| `id` | String matching `^[a-z0-9][a-z0-9-]{1,63}$` | Use a stable, descriptive, conventional kebab-case ID. |
| `name` | Nonempty string after trimming | Use the camper-facing pack name. |
| `description` | String; otherwise normalized to empty | State the pack's purpose, broad source, scope, and limitations. |
| `version` | Any JavaScript integer | Start at 1 and increase whenever published content changes. |

Unknown manifest fields are ignored by the pack installer, except for the picker-wide camp-beam `kind` marker described above. Although the runtime accepts zero or negative versions, public packs should use positive, monotonically increasing JavaScript-safe integers. Although the ID regex technically permits repeated or trailing hyphens, conventional kebab-case is easier to read and maintain.

Do not reuse the built-in IDs `brc-events-2026` or `survival-guide`. A normal import replaces matching IDs, and an equal-version collision can suppress automatic reseeding while making trusted specialty lookups query the replacement. The doctor rejects those IDs unless repository maintainers explicitly use `--builtin`.

Do not use an ID beginning with `camp-board-`. That namespace belongs to app-internal camp-board storage, not the public pack-authoring format described here. The doctor rejects it in normal mode.

### Reimport and version behavior

A normal user import with the same `id` replaces that pack's existing events, documents, graph, and vectors **regardless of whether the new version is higher, equal, or lower**.

Replacement behavior is safe and predictable:

- every input is parsed before the existing pack is removed;
- canonical pack rows are replaced in one transaction;
- parse or canonical-write failure leaves the existing pack intact;
- derived fact and full-text indexes rebuild after that commit; if a rebuild fails, canonical content remains committed and import warns the camper to restart, but a persistent storage or database fault can also make startup repair fail and must be resolved before reimport;
- the existing enabled/disabled state survives a successful replacement.

Bundled packs follow a separate automatic-seeding rule. At app startup, a bundled pack is reinstalled when its stored version is not exactly equal to the bundled version. The version change is the update mechanism: bumping it triggers reimport, while changing bundled files without changing it leaves the installed copy untouched. Therefore, every bundled content change must increase `version`; an ordinary public author should also increase it rather than decrease or reuse it.

## 3. Event files

A pack may contain several event JSON and CSV files. They are combined during installation.

### Event JSON

An event JSON file is a top-level array:

```json
[
  {
    "title": "Pancake Gift",
    "desc": "Bring a plate.",
    "date": "2026-08-31",
    "time_start": "09:00",
    "time_end": "11:00",
    "camp": "My Camp",
    "location": "4:30 & Esplanade"
  }
]
```

Fields:

| Field | Required | Meaning |
|---|---:|---|
| `title` | yes | Nonempty event title. |
| `date` | yes | Calendar date in `YYYY-MM-DD`. |
| `desc` | no | Description. |
| `time_start` | no | 24-hour `HH:MM`, or empty for an untimed start. |
| `time_end` | no | 24-hour `HH:MM`, or empty. |
| `camp` | no | Hosting camp or organization. |
| `location` | no | Playa address, venue name, meeting description, or empty. |

Use strings for every author-facing field. Unknown fields are ignored. An input `id` is ignored because the app assigns its own event ID. An input `day` is also ignored: the app derives the English weekday from `date` so a pack cannot intentionally preserve a mismatched pair.

One invalid event aborts the entire app import. The doctor deliberately catches two classes that the current runtime only checks loosely:

- it requires a real calendar date, not merely a string shaped like one;
- it rejects years `0000` through `0099`, which JavaScript's component-date constructor remaps into the twentieth century when deriving the weekday;
- it requires real `00:00` through `23:59` times, not merely two digit pairs.

The runtime currently string-coerces event values and silently empties malformed time strings. Do not rely on that normalization. It can turn an object into unhelpful text or hide a source-data error.

An end clock earlier than its start clock is valid and common for overnight events. The doctor does not reject it.

### Event CSV

Equivalent CSV:

```csv
title,desc,date,time_start,time_end,camp,location
Pancake Gift,Bring a plate.,2026-08-31,09:00,11:00,My Camp,4:30 & Esplanade
```

CSV rules:

- the first nonempty row is the header;
- header names are trimmed and lowercased;
- `title` and `date` headers are required;
- at least one data row is required;
- quoted fields, escaped double quotes, embedded commas, and embedded newlines are supported;
- close every quoted field; the runtime currently accepts an end-of-file inside a quote, but the public doctor rejects that ambiguous source as an additional publication gate;
- missing cells become empty strings;
- extra cells beyond the header are ignored;
- unknown headers are ignored after parsing;
- duplicate header names are accepted, but the later column overwrites the earlier one;
- unquoted carriage returns are discarded, while carriage returns inside quoted fields are preserved;
- blank physical rows are skipped (a comma-only row is still a data row).

Prefer unique canonical headers. A file that depends on duplicate-header overwrite behavior is hard for people and spreadsheet tools to audit.

### Playa address behavior

`location` does not have to be a grid address. Venue names and instructions such as `Main Gate / Gate Road` remain valid event locations.

The walk-time parser recognizes, among other forms:

```text
7:30 & G
G & 7:30
6:00 & Esplanade
Esplanade at 6:00
Center Camp
Temple
The Man
Man
12:00 deep playa
```

A clock address uses an hour from 1 through 12 and a minute from 00 through 59. Ring letters A through L are recognized when separated by a boundary, whitespace, or `&`. Landmark matching is intentionally loose: text containing `center camp` or `temple` is recognized as that landmark.

An unrecognized nonempty location is not an invalid event. It remains visible but does not receive an approximate coordinate or walk-time estimate. The doctor reports recognized/free-text counts but redacts location values from diagnostics. It rejects a likely general time with impossible minutes, such as `13:75`, and rejects malformed clock-like tokens in grid-address context, such as `7:3 & G` or `7:300 & G`. Numeric-colon prose such as an aspect ratio or network port remains valid free text when it has no grid-address marker. A valid 24-hour time in meeting prose, such as `13:30`, also remains accepted as free text even though it is not a playa grid clock. This stricter contextual boundary prevents the current runtime parser from turning the `7:30` prefix of `7:300 & G` into a tappable coordinate without rejecting unrelated notation.

Recognition is syntactic, not proof that the coordinate is semantically right. A standalone article `a` near a clock can look like ring A, and a sentence containing `Temple` or `Center Camp` takes landmark priority over another address in the same string. Review address-like prose on a device because recognized locations become tappable compass targets.

## 4. Building event packs with `tools/load_events.py`

`tools/load_events.py` is a Python-standard-library builder for larger event sources. It writes `pack.json` and `events.json`; after doctor validation, those two files form an import-ready event pack.

### iBurn data

```sh
python3 tools/load_events.py \
  --iburn-events event.json \
  --iburn-camps camp.json \
  --id brc-events-2026 \
  --name "BRC Events 2026" \
  --description "Event listings from the credited source." \
  --version 1 \
  --out-pack build/brc-events-2026
```

`--iburn-camps` is optional but allows the builder to resolve camp names and locations. Repeated occurrences become separate event rows.

### Generic JSONL

JSONL is a builder input, not a pack input. Put one event object on each line:

```sh
python3 tools/load_events.py \
  --jsonl scraped.jsonl \
  --id my-events \
  --name "My Events" \
  --out-pack build/my-events
```

Use repeatable `--extra-jsonl FILE` options to append rows such as city milestones that the main feed does not contain.

The builder sorts output by date, start time, and title. It skips and reports several malformed-source cases, including missing titles, bad date shapes, malformed JSONL, and short iBurn occurrence timestamps. A shape-valid impossible calendar date or a non-object JSONL row can still abort the builder rather than becoming a skipped-row report. The app importer differs again: one invalid event aborts the whole pack. Always inspect builder output and then run `tools/check_pack.py` against the generated folder.

Use a new or deliberately emptied `--out-pack` directory. The builder overwrites `pack.json` and `events.json` but does not remove stale documents, graph files, embeddings, or other event JSON left by an earlier build; the picker and doctor will include those immediate files in the pack.

Optional generation gates fail before writing a thin or poisoned output:

```text
--expect-min N
--expect-dates YYYY-MM-DD:YYYY-MM-DD
--forbid-title TEXT             # repeatable
--require-addresses FRACTION
```

`--require-addresses` measures the builder's narrower clock-and-ring shape and is most useful after a source's placement data is expected to be final. Do not use it to reject a legitimate pre-placement or venue-name corpus.

`--db inspection.sqlite` emits an optional local SQLite database for inspection. It is not an import file and does not reproduce the app's entire schema, ranking, or tokenizer behavior. Do not select it with the pack.

## 5. Documents and exact chunking

Every immediate `.md` or `.txt` file becomes a searchable document. The app chunks it during installation; authors do not provide a separate chunks file.

### Headings

A Markdown heading is recognized only when a whole line matches:

```text
^(#{1,6})\s+(.+?)\s*#*\s*$
```

Heading lines are removed from chunk content. Active headings become a breadcrumb joined with ` > `:

```text
Survival Guide > Water > Daily amount
```

Sibling or shallower headings pop the previous breadcrumb stack. Headingless text is valid and receives an empty breadcrumb. Empty and heading-only sections produce no chunks.

### The 2,000-character imported-pack budget

Normal imported documents use a maximum of 2,000 JavaScript UTF-16 code units per chunk:

1. split a section into paragraphs at blank lines;
2. greedily pack whole paragraphs while they fit;
3. split oversized prose near the last space before the limit;
4. when an oversized multi-line paragraph contains at least two list-item lines, pack whole lines where possible;
5. hard-split an individually overlong line when necessary.

Chunk ordinals are zero-based and continue through the document in source order.

### Why the bundled guide uses 700

The query-focused excerpt body uses a 700-character budget. The bundled Survival Guide is therefore installed with a special 700-character chunk budget so each retrieved built-in passage can fit without slicing. When the runtime appends a same-chunk credit line, it may add up to 200 more characters beyond that body budget.

That special budget is configured by `src/packs/builtins.ts`; it is not a field in `pack.json`. Normal imported documents stay at 2,000. Changing their chunker would invalidate existing embedding keys and contributor-built vectors.

### Credit lines

Every imported document file must contain at least one capitalized, physical `Credit:` line. For a public source, use an exact source or article URL, preserve the upstream credit chain, and record retrieval date:

```markdown
## Topic

Facts restated in the pack author's own words.

*Credit: [Source — Article title](https://exact.example/article) (Author and any upstream credit chain). Retrieved 2026-08-19.*
```

For original or private camp material, identify its author and sharing basis rather than inventing a web URL:

```markdown
*Credit: Original material by Camp Example, shared with permission.*
```

Also name the broad source and limitations in `pack.json.description`.

The runtime can append the first physical line beginning with the literal form `Credit: `—optionally behind Markdown emphasis or bullet characters—from the **same chunk**. It cannot pull a credit from a sibling chunk, and it appends at most the first 200 characters of that line. For reliable attribution:

- keep a credited section within the normal 2,000-character budget including its credit;
- repeat the credit in every independently meaningful piece that may split into another chunk; and
- put the source name, exact URL, and other load-bearing attribution early enough to survive the 200-character excerpt cap.

A single credit at the end of a very long section may satisfy the per-file doctor check while leaving earlier chunks without an immediately visible credit. The public contract is at least one credit per document; robust authors should design for chunk-local credit as well.

The bundled Survival Guide has a transitional exception: its Burn.Life source sections are credit-complete at the normal 2,000-character authoring boundary, but the 700-character built-in split creates sibling subchunks that do not each repeat the line. Do not use that exception as a template for new packs.

## 6. Graph facts

A pack may add structured nodes and relationships alongside its documents. Both files are top-level JSON arrays. Graph identifiers and edge endpoints are local to one pack; an edge cannot point into another pack.

### `nodes.json`

```json
[
  {
    "id": "person.alex",
    "type": "person",
    "name": "Alex",
    "attrs": {
      "aliases": ["A"],
      "card_chunk": "people-example.md:3"
    }
  }
]
```

Rules:

| Field | Rule |
|---|---|
| `id` | Required, unique, matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |
| `type` | Required, matching `^[a-z][a-z0-9_-]{0,63}$` |
| `name` | Required nonempty string |
| `attrs` | Optional object; absent or `null` becomes `{}` |

Types are open-ended. Current conventions include `person`, `year`, and `project`.

A person card can point to a generated document chunk with either form:

```json
"card_chunk": "people-example.md:3"
```

```json
"card_chunk": {
  "source_file": "people-example.md",
  "index": 3
}
```

The filename and zero-based JavaScript-safe integer index must refer to this pack's exact generated chunk, and one chunk may belong to only one person. For deterministic structured-card rendering, the linked source must start with `people-` and its breadcrumb must have exactly three segments. For example:

```text
Campers > Alex — Example camper > Who is Alex?
```

The first segment is normally the source document's H1, may use another label, and is not otherwise pinned. The app structurally pins the middle `<name> — <camp> camper` segment and the `Who is <name>?` leaf. Those two names must agree with each other and with the node's `name`. The chunk's first paragraph must open with that name and include an activity window such as `from Jan 2020 to Aug 2026` or `in Sep 2015`.

At index-rebuild time, a missing chunk, mismatched heading/name, duplicate assignment, or ambiguous legacy link warns and remains unindexed. Source-prefix, lead, and activity-window checks happen later when the structured card is materialized; a link can therefore be indexed yet still fall back to ordinary prose without another warning. The public doctor checks the complete renderable shape and treats a broken explicit `card_chunk` as a failure so `PACK PASS` promises the card is usable.

A legacy `attrs.card` filename is supported by the app but is less precise. Its value must be the exact source filename with no surrounding whitespace. It indexes only when the person's normalized name is unique and exactly one chunk in that source has the matching person-card heading; reused, missing, or ambiguous matches remain unindexed. The public doctor warns when a legacy link would remain unindexed or would later fall back to prose.

### `edges.json`

```json
[
  {
    "src": "person.alina",
    "dst": "person.ira",
    "type": "sponsored_by",
    "year": 2017,
    "evidence_ref": "stated 2017-05-30 thread#3",
    "attrs": {
      "tier": "stated",
      "stated_on": "2017-05-30",
      "year_source": "explicit",
      "said_names": ["Alina", "Ira"]
    }
  }
]
```

Rules:

| Field | Rule |
|---|---|
| `src` | Required graph node ID |
| `dst` | Required graph node ID |
| `type` | Required graph type matching the node-type regex |
| `evidence_ref` | Required nonempty string |
| `year` | Optional/`null`, or integer from 1 through 9999 |
| `attrs` | Optional object; absent or `null` becomes `{}` |

Every `src` and `dst` must exist in this pack's `nodes.json`. Node IDs must be unique.

An edge is a duplicate when these five normalized values are equal:

```text
[src, dst, type, year, evidence_ref]
```

`attrs` does not make an otherwise identical edge distinct.

Edge types are open-ended. Current conventions include `sponsored_by`, `attended`, `absent`, and `worked_on`. For `sponsored_by`, direction is load-bearing:

```text
src = person who was sponsored
dst = sponsoring person
```

The installer structurally accepts edges without semantic provenance attributes. Public authors should nevertheless include:

- `tier` — one of the five values the current lineage UI recognizes, case-insensitively and with no surrounding whitespace: `stated`, `roster`, `owner-stated`, `stated-on-playa`, or `inferred`;
- `stated_on` — a real ISO date for `stated`, `owner-stated`, and `stated-on-playa` evidence; omit it for `roster` or `inferred` evidence when no statement date applies;
- statement-style `evidence_ref` — use the UI-recognized shape (`stated <date>`, `stated <date> <source>#<row>`, `owner-stated <date>`, or `said <date> by <names>`), put a real ISO date in its displayed date slot, and make it exactly equal `stated_on`; the UI displays the date from `evidence_ref`, not from `attrs`;
- `year_source` — for example `stated_on`, `explicit`, or `roster`;
- `said_names` — exact names used in the source.

The checker warns about missing, unrecognized, or contradictory provenance rather than inventing a hard installer rule. A recognized stored `tier` wins; an unrecognized stored value falls back to a recognized leading token in `evidence_ref`, and renders as unknown only when neither source is recognized. Keep the two sources consistent because the UI derives its provenance label from the winning tier but its human-readable date/source phrase from `evidence_ref`. The installer's actual internal table names are `nodes` and `edges`; older documents that refer to `graph_nodes` or `graph_edges` are stale.

## 7. Optional `embeddings.json`

Documents always work through keyword search. An optional embedding payload can arm semantic retrieval when the device build has sqlite-vec available **and** the matching query embedder is installed locally at the app's expected `files/embedder.gguf` path:

```json
{
  "model": "bge-small-en-v1.5-q8",
  "dim": 384,
  "vectors": {
    "handbook.md:0": [0.012, -0.034],
    "handbook.md:1": [0.056, 0.078]
  }
}
```

The example vectors are abbreviated; every real vector must contain exactly 384 finite numbers.

Rules:

- `model` is a nonempty string;
- `dim` is exactly `384`;
- `vectors` is an object;
- every key is `<exact source filename>:<zero-based chunk ordinal>`;
- every key corresponds to a chunk generated by the app's 2,000-character imported-document chunker;
- every vector has exactly 384 finite numeric values;
- booleans, `NaN`, and infinities are invalid;
- orphan or stale keys fail installation.

The runtime parser technically permits a partial or empty vector map and silently leaves missing chunks keyword-only. The public reproducibility contract is stricter: when `embeddings.json` is present, provide **exactly one vector for every generated document chunk**, with no missing or extra keys. `tools/check_pack.py` enforces exact key-set equality.

The active query model is:

```text
bge-small-en-v1.5-q8
```

Another nonempty model ID can be stored, but current semantic-search SQL will not query those rows. The doctor surfaces that mismatch prominently. Even a complete matching payload remains keyword-only when sqlite-vec or the side-loaded query embedder is unavailable; without the vector table, import does not persist the vectors for later recovery, so reimport after the prerequisite is available. Vectors are not encryption, do not conceal their source corpus, and do not replace permission to distribute the underlying material.

## 8. Validate before import or publication

Run the zero-dependency doctor on the folder whose immediate files a camper will select:

```sh
python3 tools/check_pack.py path/to/my-camp-pack
```

It validates:

- flat file-set and reserved names;
- public mobile-pack ceilings: at most 256 immediate regular files, 32 MiB per file, and 64 MiB combined;
- manifest fields;
- JSON and CSV events;
- real dates and times;
- weekday replacement warnings;
- playa address recognition and free-text coverage;
- document chunk generation;
- per-file credit lines;
- graph IDs, duplicates, endpoint integrity, and provenance advisories;
- optional embedding dimension, values, model, and exact chunk-key set;
- the requirement for at least one usable event, chunk, node, or edge.

Typical success:

```text
PASS file-set            3 immediate file(s); flat picker-compatible names
PASS resource-limits     3 file(s), 18420 byte(s) within public mobile-pack limits
PASS manifest            id and name valid; version=1
PASS events:events.json  42 valid event row(s)
PASS document:guide.md   nonempty; 3 chunk(s) at 2000 UTF-16 code units
PASS usable-content      42 event(s), 3 chunk(s), 0 node(s), 0 edge(s)

PACK PASS: ...
```

A hard failure prints a `FAIL` line, finishes with `PACK FAIL`, and exits nonzero. Treat warnings as review items even though they do not change the exit status. The summary omits the absolute pack path, and sensitive graph/vector identifiers are summarized by row or count. Terminal control characters in filenames, paths, or source-derived details are escaped so data cannot forge or conceal diagnostic lines.

After validation, test the actual import on a supported device. The doctor proves the data format and relationships; it does not prove picker-provider behavior, visual rendering, retrieval quality, speech behavior, or device performance.

## 9. What may remain local, and what may ship

A pack is ordinary readable data. It is not encrypted, access-controlled, or made private by being imported into an offline app. Anyone who receives the files can inspect, copy, modify, and re-import them.

### Keep local or share only with an explicitly trusted group

- private camp rosters and histories;
- personal contact details or other PII;
- unannounced schedules, locations, needs, or safety information;
- material whose author did not consent to redistribution;
- third-party confidential information;
- credentials, API keys, private links, tokens, or operational secrets;
- inferred relationships that people have not agreed may be shared.

Camp-board beam files are a separate one-file sharing format. Import a beam by itself; do not mix it into a pack selection and do not treat its shared passphrase as encryption or writer identity.

### Suitable for a public pack

Public files should contain only material that may be redistributed to anyone, with:

- the source author's permission or an applicable license/terms basis;
- exact credit lines and retrieval dates for external web material;
- no private personal data or secrets;
- camper-facing descriptions of scope and limitations;
- reproducible transformations and generation commands where applicable;
- a version bump for every published content change;
- a clean `tools/check_pack.py` result;
- human review of the final exact files.

Restating facts in new prose does not automatically create redistribution permission. Attribution documents what was used; it does not replace the owner or publisher's rights determination.

## Final author checklist

- [ ] `pack.json` has a stable ID, clear name/description, and new positive version.
- [ ] Every intended file is at one level and will be selected together.
- [ ] No unrelated unreserved JSON file is present.
- [ ] Event dates and times are real; overnight clocks are intentional.
- [ ] Free-text locations are intentional; address-looking strings were reviewed.
- [ ] Every document has a capitalized `Credit:` line and chunk-local attribution where practical.
- [ ] Graph node IDs are unique and every edge endpoint resolves locally.
- [ ] If embeddings are present, model, dimension, and exact chunk keys match.
- [ ] Private data, PII, credentials, and unlicensed material are absent from public files.
- [ ] `python3 tools/check_pack.py <folder>` ends in `PACK PASS`.
- [ ] The exact validated files were imported together and exercised on a device.
