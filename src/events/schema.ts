/**
 * The SQLite DDL, in one importable place. db.ts executes these at open;
 * the retrieval integration test (searchDocsRetrieval.test.ts) executes the
 * SAME strings against an in-memory node:sqlite database, so the tested FTS
 * semantics (tokenizer included) cannot drift from the shipped schema.
 */

/** Base (non-virtual) tables + indexes. Safe on any SQLite build. */
export const BASE_TABLES_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS packs (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     version     INTEGER NOT NULL DEFAULT 1,
     enabled     INTEGER NOT NULL DEFAULT 1,
     builtin     INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id         INTEGER PRIMARY KEY,
     pack_id    TEXT NOT NULL,
     title      TEXT NOT NULL,
     desc       TEXT NOT NULL DEFAULT '',
     day        TEXT NOT NULL,
     date       TEXT NOT NULL,
     time_start TEXT NOT NULL,
     time_end   TEXT NOT NULL DEFAULT '',
     camp       TEXT NOT NULL DEFAULT '',
     location   TEXT NOT NULL DEFAULT '',
     source_kind TEXT NOT NULL DEFAULT '',
     note_key    TEXT NOT NULL DEFAULT ''
   )`,
  'CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)',
  'CREATE INDEX IF NOT EXISTS idx_events_pack ON events(pack_id)',
  `CREATE TABLE IF NOT EXISTS doc_chunks (
     id          INTEGER PRIMARY KEY,
     pack_id     TEXT NOT NULL,
     source_file TEXT NOT NULL,
     heading     TEXT NOT NULL DEFAULT '',
     content     TEXT NOT NULL,
     note_key    TEXT NOT NULL DEFAULT ''
   )`,
  'CREATE INDEX IF NOT EXISTS idx_chunks_pack ON doc_chunks(pack_id)',
  // Derived, deterministic identity index: graph person IDs point straight to
  // their app-owned card chunk. Search rank never decides who a person is.
  `CREATE TABLE IF NOT EXISTS person_card_chunks (
     pack_id   TEXT NOT NULL,
     person_id TEXT NOT NULL,
     chunk_id  INTEGER NOT NULL,
     PRIMARY KEY (pack_id, person_id),
     UNIQUE (pack_id, chunk_id)
   )`,
  // One revocable, pack-generic EXCLUDE list. Excluded graph nodes never enter
  // the person-card index or the runtime graph, so they are invisible at
  // resolve time rather than filtered after authoritative evidence is built.
  `CREATE TABLE IF NOT EXISTS fact_exclusions (
     pack_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     PRIMARY KEY (pack_id, node_id)
   )`,
  // "Don't use this" for anything that is NOT a person: a passage the Angel
  // stood on, an event it surfaced. One table, one gesture, one Settings list.
  // People stay in fact_exclusions because a person is a GRAPH node and hiding
  // one rebuilds the derived index (factExclusions.ts); a passage or event is
  // a plain row and hiding it is a filter. Same user-facing verb, right
  // mechanism underneath each. Keys: passage = 'pack_id:chunk_id' (the same
  // id a SourceRef carries), event = the events.id.
  `CREATE TABLE IF NOT EXISTS hidden_items (
     kind  TEXT NOT NULL,
     key   TEXT NOT NULL,
     label TEXT NOT NULL,
     ts    TEXT NOT NULL,
     PRIMARY KEY (kind, key)
   )`,
  // Generic relational facts graph. SQLite is storage-of-record and keeps
  // pack provenance/evidence; Graphology owns every traversal in memory.
  `CREATE TABLE IF NOT EXISTS nodes (
     pack_id TEXT NOT NULL,
     id      TEXT NOT NULL,
     type    TEXT NOT NULL,
     name    TEXT NOT NULL,
     attrs   TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (pack_id, id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_nodes_pack_type ON nodes(pack_id, type)',
  `CREATE TABLE IF NOT EXISTS edges (
     id           INTEGER PRIMARY KEY,
     pack_id      TEXT NOT NULL,
     src          TEXT NOT NULL,
     dst          TEXT NOT NULL,
     type         TEXT NOT NULL,
     year         INTEGER,
     evidence_ref TEXT NOT NULL,
     attrs        TEXT NOT NULL DEFAULT '{}'
   )`,
  'CREATE INDEX IF NOT EXISTS idx_edges_src_type ON edges(pack_id, src, type)',
  'CREATE INDEX IF NOT EXISTS idx_edges_dst_type ON edges(pack_id, dst, type)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
     ON edges(pack_id, src, dst, type, COALESCE(year, -1), evidence_ref)`,
  // THE SEMANTIC ARM (RAG-ARCHITECTURE-RESEARCH lane B, Ember design ruling):
  // pack-build-PRECOMPUTED chunk vectors, one row per doc_chunk, stored in a
  // sqlite-vec virtual table (C-side vec_distance_cosine — NO hand-rolled
  // vector math; the ruling that superseded the original plain-table+JS
  // cosine). At 8.6K×384-dim, sqlite-vec's brute-force KNN is single-digit
  // ms on a phone — no ANN. The metadata table stamps the embedder model id
  // (the research's one hard rule: index and query must share model +
  // normalization — a mismatch makes the arm INERT, never wrong).
  `CREATE TABLE IF NOT EXISTS doc_chunk_vectors_meta (
     chunk_id INTEGER PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE,
     model    TEXT NOT NULL
   )`,
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  // Favorited events (Karl's iBurn-style itinerary ask, 2026-08-23). Keyed
  // by the event's NATURAL identity (title+date+time_start), never events.id:
  // pack reinstalls re-mint ids, and a heart must survive the yearly data
  // updates. The identity columns are stored (not just the key) so the row
  // is self-describing; an event edited out of a newer pack simply stops
  // joining — no tombstone UI, by design (hearts predating a data update
  // on a changed event are the rare case, and silence beats clutter).
  `CREATE TABLE IF NOT EXISTS event_favorites (
     fav_key    TEXT PRIMARY KEY,
     title      TEXT NOT NULL,
     date       TEXT NOT NULL,
     time_start TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  // Field conversation log (src/log/chatLog.ts): every chat turn, tool
  // round-trip, persona switch, pack install, and failure — LOCAL-ONLY
  // forensics, pulled over adb or shared from Settings. Metrics columns are
  // nullable: only assistant rows carry them. thinking_chars, not
  // thinking_tokens — llama.rn reports the reasoning TEXT (never logged),
  // not a thinking-token count; its length is what is actually measurable.
  `CREATE TABLE IF NOT EXISTS chat_log (
     id                INTEGER PRIMARY KEY,
     ts                TEXT NOT NULL,
     session_id        TEXT NOT NULL,
     persona           TEXT NOT NULL,
     role              TEXT NOT NULL,
     text              TEXT NOT NULL,
     model_file        TEXT,
     sampler_json      TEXT,
     ttft_ms           INTEGER,
     total_ms          INTEGER,
     prompt_tokens     INTEGER,
     completion_tokens INTEGER,
     thinking_chars    INTEGER,
     timings_json      TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_chat_log_session ON chat_log(session_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_chat_log_ts ON chat_log(ts)',
  // Camp board v0 (doc 30 pilot as re-scoped by the codex refutation,
  // src/camp/campBoard.ts): an APPEND-ONLY needs/offers board — rows are
  // statements by one author ("offering: 3 spare bike tubes"), never mutable
  // shared state. Each writer's posts live under its own pack
  // (pack_id = camp-board-<writer_id>); imports are per-writer snapshot
  // replication guarded by the camp_writers high-water mark below. `done` is
  // the author-only retraction/completion flag — done rows still beam
  // (explicit superseding statement, never deletion-by-omission). camp_id ''
  // marks THIS phone's own rows (stamped with the real camp id at export).
  // Retrieval does not read this table directly: open posts materialize into
  // doc_chunks under the same pack_id, so search_docs/lookup_facts, pack
  // enable/disable, and the FTS rebuild all compose unchanged.
  // Friends on playa (2026-08-19): one row per friend CARD (playa name,
  // camp, address, note), keyed by the author's per-install id. seq is the
  // author's own edit counter — imports keep the greatest (friendCard.ts).
  `CREATE TABLE IF NOT EXISTS friend_cards (
     id          TEXT PRIMARY KEY,
     seq         INTEGER NOT NULL,
     name        TEXT NOT NULL,
     camp        TEXT NOT NULL DEFAULT '',
     address     TEXT NOT NULL DEFAULT '',
     note        TEXT NOT NULL DEFAULT '',
     updated_at  TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS camp_posts (
     id          TEXT NOT NULL,
     pack_id     TEXT NOT NULL,
     camp_id     TEXT NOT NULL DEFAULT '',
     writer_id   TEXT NOT NULL,
     author_name TEXT NOT NULL DEFAULT '',
     type        TEXT NOT NULL DEFAULT 'offer',
     text        TEXT NOT NULL,
     ref_id      TEXT,
     created_at  TEXT NOT NULL,
     done        INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (pack_id, id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_camp_posts_pack ON camp_posts(pack_id)',
  // Per-writer sync state (refutation Blocker 1's concrete fix at pilot
  // scale): the durable high-water (seq, payload_hash) per (camp_id,
  // writer_id) — imports reject lower seq, treat equal seq + equal hash as
  // a no-op, and surface equal seq + different hash as a FORK (installed
  // beside, never overwriting). envelope_json keeps the last verified
  // envelope VERBATIM so beams re-export every known writer (multi-hop:
  // A reaches C through B without A and C ever meeting).
  `CREATE TABLE IF NOT EXISTS camp_writers (
     camp_id       TEXT NOT NULL,
     writer_id     TEXT NOT NULL,
     author_name   TEXT NOT NULL DEFAULT '',
     seq           INTEGER NOT NULL,
     payload_hash  TEXT NOT NULL,
     envelope_json TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     PRIMARY KEY (camp_id, writer_id)
   )`,
  // Camp notes: the HUMAN overlay over mecha-packs (docs/CAMP-NOTES-DESIGN.md,
  // rulings A-G). This table is CANONICAL; doc_chunks/events rows derived
  // from it are disposable projections and never carry identity. note id is
  // globally stable: '<origin_writer_id>:<local id>' — rotation never
  // transfers ownership (a change after rotation is a NEW note with
  // supersedes pointing here).
  `CREATE TABLE IF NOT EXISTS camp_notes (
     id           TEXT PRIMARY KEY,
     camp_id      TEXT NOT NULL,
     writer_id    TEXT NOT NULL,
     author_name  TEXT NOT NULL,
     kind         TEXT NOT NULL,
     title        TEXT NOT NULL DEFAULT '',
     when_date    TEXT NOT NULL DEFAULT '',
     time_start   TEXT NOT NULL DEFAULT '',
     time_end     TEXT NOT NULL DEFAULT '',
     where_addr   TEXT NOT NULL DEFAULT '',
     text         TEXT NOT NULL,
     subject_type TEXT NOT NULL DEFAULT '',
     subject_key  TEXT NOT NULL DEFAULT '',
     year         TEXT NOT NULL DEFAULT '',
     supersedes   TEXT NOT NULL DEFAULT '',
     created_at   TEXT NOT NULL,
     revised_at   TEXT NOT NULL DEFAULT '',
     photo        TEXT NOT NULL DEFAULT ''
   )`,
  'CREATE INDEX IF NOT EXISTS idx_notes_camp ON camp_notes(camp_id, writer_id)',
  'CREATE INDEX IF NOT EXISTS idx_notes_subject ON camp_notes(subject_type, subject_key)',
  // Durable fork records (implementation-review finding 6): every surfaced
  // "conflicted copy" is keyed by its FULL identity tuple, so re-importing
  // the same fork is an idempotent no-op and two forks can never collide on
  // a short hash prefix. Forks are LOCAL-ONLY: they never advance the
  // high-water and never re-export.
  `CREATE TABLE IF NOT EXISTS camp_forks (
     camp_id      TEXT NOT NULL,
     writer_id    TEXT NOT NULL,
     seq          INTEGER NOT NULL,
     payload_hash TEXT NOT NULL,
     pack_id      TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     PRIMARY KEY (camp_id, writer_id, seq, payload_hash)
   )`,
  // The answering machine (docs/CREW-DESIGN.md §6b/§6a): async crew texts +
  // voice notes, carried store-and-forward — a message is minted ONCE by its
  // sender and then COPIED phone to phone whenever radios meet, until it
  // expires. id is sender-minted (sender's memberHash hex + '-' + created_min
  // + '-' + 4 random hex), so the very same id arrives over every gossip path
  // and INSERT OR IGNORE is the whole dedupe story. from_hash/to_hash are
  // hash32 of FriendCard.id (src/crews/beacon.ts) — the wire never carries a
  // name; to_hash NULL = the whole crew. kind 'text' carries plain text in
  // body; kind 'voice' carries base64 audio (mime says which codec).
  // created_min is epoch MINUTES on the AUTHOR'S clock, relayed verbatim so
  // "left you a note 20 minutes ago" survives every hop. expires_min is on
  // THIS PHONE'S clock for 'heard' rows — written at arrival as
  // now + the length the author asked for, because two playa phones have no
  // cell, no NTP and therefore no shared clock, and believing a foreign
  // deadline is what silently emptied pods one-way. THE TWO COLUMNS ARE
  // THEREFORE ON DIFFERENT CLOCKS FOR A HEARD ROW, and anything computing a
  // difference between them must not assume otherwise — serveMessages
  // re-stamps the expiry into the author's frame before it goes back on the
  // wire, so what a PEER receives is always a coherent pair. Minute grain is
  // plenty for "left you a note" and matches the beacon's epochMin
  // vocabulary. origin 'mine' = composed here; 'heard' = accepted off a peer.
  // read_at is LOCAL-ONLY state (never synced): epoch minutes when THIS phone
  // opened it, NULL = unread.
  //
  // RETENTION (src/crews/messages.ts owns the policy): every message expires
  // — default TTL one playa day (24 h); pruneExpired() deletes past
  // expires_min, and 'heard' rows are additionally capped at 2000 total,
  // oldest-expiring evicted first, because a base-station phone relaying a
  // whole camp must never grow unbounded. Nothing in this table outlives the
  // week by construction.
  `CREATE TABLE IF NOT EXISTS crew_messages (
     id          TEXT PRIMARY KEY,
     crew_code   TEXT NOT NULL,
     from_hash   INTEGER NOT NULL,
     to_hash     INTEGER,
     kind        TEXT NOT NULL,
     body        TEXT NOT NULL,
     mime        TEXT NOT NULL DEFAULT '',
     created_min INTEGER NOT NULL,
     expires_min INTEGER NOT NULL,
     hops        INTEGER NOT NULL DEFAULT 0,
     origin      TEXT NOT NULL,
     read_at     INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_crew_msgs_crew ON crew_messages(crew_code, created_min)',
  'CREATE INDEX IF NOT EXISTS idx_crew_msgs_expires ON crew_messages(expires_min)',

  // THE WANT LEDGER — what we have ASKED FOR and not received.
  //
  // Without it, a camp-scale pod starves on ordinary use, no attacker
  // required. wantsFrom() skips ids we already HOLD, but the accept gate
  // refuses ids for four more reasons it knows nothing about: past the hop
  // horizon, over the per-kind byte cap, an unknown kind, an unknown crew.
  // An id refused for any of those is never held, never expires out of the
  // peer's digest, and is therefore re-requested EVERY sighting forever —
  // permanently occupying one of the MAX_FETCH_IDS slots. Enough of them at
  // the head of a digest and the tail is never reached. (messages.ts already
  // confessed the hops case in a comment; this is the cure for all four.)
  //
  // KEYED ON THE MESSAGE ID, DELIBERATELY NOT ON THE PEER. Ids are
  // sender-minted and identical over every gossip path, so "I asked for X and
  // never got it" is peer-independent knowledge that survives a disconnect, a
  // restart, and — the one that matters — Android's rotating Resolvable
  // Private Address. A peer-keyed cursor would reset roughly every 15 minutes
  // on Android while working perfectly on iOS, which is the worst shape a
  // bug can have: correct on the platform you test, silent on the other.
  //
  // retry_min is what stops the cure from becoming a new starvation: an id is
  // backed off, not banished, because it may be legitimately fresh from a
  // different carrier later.
  `CREATE TABLE IF NOT EXISTS crew_sync_wants (
     id        TEXT PRIMARY KEY,
     asked_min INTEGER NOT NULL,
     tries     INTEGER NOT NULL DEFAULT 0,
     retry_min INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_crew_wants_retry ON crew_sync_wants(retry_min)',
];

/**
 * FTS5 virtual tables. `porter unicode61` stems both the index and query
 * terms, so "gifts" reaches "Gifting" and "principles" reaches "principle"
 * (EVAL-v11-TOOLS retrieval-brittleness fix). Bump FTS_SCHEMA_VERSION on any
 * change here — db.ts drops and recreates the virtual tables when the stored
 * version differs, then the per-open rebuild repopulates them.
 */
export const FTS_TABLES_SQL: string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
     title, desc, camp, location,
     content='events', content_rowid='id',
     tokenize='porter unicode61'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
     heading, content,
     content='doc_chunks', content_rowid='id',
     tokenize='porter unicode61'
   )`,
];

/**
 * The sqlite-vec virtual table (384-dim float32, keyed to doc_chunks.id).
 * Separate from FTS_TABLES_SQL because it needs the sqlite-vec EXTENSION
 * loaded: db.ts attempts it after the FTS probe and records availability
 * (vecAvailable()), exactly like ftsAvailable — when the extension is
 * absent (old build, or tests without the .so), the arm degrades to
 * keyword-only, and a leftover plain-table DB just never joins.
 */
export const VEC_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunk_vectors USING vec0(
  embedding float[384]
)`;

/** The vec DDL version — bump on dim/shape change (settings key
 * `vec_schema_version`); db.ts drops+recreates like the FTS migration. */
export const VEC_SCHEMA_VERSION = '1';

export const DROP_VEC_SQL = ['DROP TABLE IF EXISTS doc_chunk_vectors'];

/** Version stamp for the FTS DDL above (settings key `fts_schema_version`). */
export const FTS_SCHEMA_VERSION = '2';

export const DROP_FTS_SQL: string[] = [
  'DROP TABLE IF EXISTS events_fts',
  'DROP TABLE IF EXISTS doc_chunks_fts',
];

/** Rebuild both external-content indexes from their content tables. */
export const REBUILD_FTS_SQL: string[] = [
  "INSERT INTO events_fts(events_fts) VALUES('rebuild')",
  "INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('rebuild')",
];

/** Additive column migrations for tables that already exist on a device
 * (CREATE TABLE IF NOT EXISTS never alters). db.ts applies each when
 * PRAGMA table_info lacks the column. Keep entries forever — a phone may
 * skip versions. */
export const ADDITIVE_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // 2026-08-21: art-note thumbnail (ruling H, docs/CAMP-NOTES-DESIGN.md) —
  // base64 JPEG, '' = none; sealed into the wire payload only when present.
  { table: 'camp_notes', column: 'photo', ddl: "ALTER TABLE camp_notes ADD COLUMN photo TEXT NOT NULL DEFAULT ''" },
  // 2026-08-17: edge provenance attrs (tier, stated_on, year_source, said_names)
  // — CAMP-PACK-GRAPH-SPEC.md; before this every pack's edge attrs were dropped
  // at install and the Lineage view had to infer tier from the evidence_ref.
  { table: 'edges', column: 'attrs', ddl: "ALTER TABLE edges ADD COLUMN attrs TEXT NOT NULL DEFAULT '{}'" },
  // 2026-08-19: friend-card share scope ('crew' = pass it on, 'direct' = just
  // for the recipient). Default 'crew' IS the migration: pre-scope cards keep
  // today's gossip behavior — consent must be opted INTO, never retroactively
  // restricted in a way the author never saw.
  { table: 'friend_cards', column: 'scope', ddl: "ALTER TABLE friend_cards ADD COLUMN scope TEXT NOT NULL DEFAULT 'crew'" },
  // 2026-08-20: camp-note event projections carry their provenance and the
  // ONE stable hide key (ruling D) — a projected row is never identity.
  { table: 'events', column: 'source_kind', ddl: "ALTER TABLE events ADD COLUMN source_kind TEXT NOT NULL DEFAULT ''" },
  { table: 'events', column: 'note_key', ddl: "ALTER TABLE events ADD COLUMN note_key TEXT NOT NULL DEFAULT ''" },
  { table: 'doc_chunks', column: 'note_key', ddl: "ALTER TABLE doc_chunks ADD COLUMN note_key TEXT NOT NULL DEFAULT ''" },
];
