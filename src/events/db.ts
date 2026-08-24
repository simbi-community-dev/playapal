/**
 * SQLite layer (react-native-quick-sqlite) for the data-pack model.
 *
 * Owns: schema creation, the FTS5 availability probe, seeding the two
 * built-in packs, and a tiny key/value settings table (model path, persona)
 * so we do not need an extra storage dependency.
 *
 * Schema:
 *   packs       — one row per installed data pack (enabled toggle lives here)
 *   events      — structured content from all packs (pack_id column)
 *   doc_chunks  — freeform content, chunked ~500 tokens with heading context
 *   events_fts / doc_chunks_fts — external-content FTS5 indexes (BM25)
 *
 * FTS5 is compiled in via build flags (android/gradle.properties
 * `quickSqliteFlags`, ios/Podfile post_install) but the probe below is the
 * source of truth at runtime — if the virtual tables cannot be created we run
 * on the LIKE fallback and the app still works.
 */

import { openAppDb, DbConnection as QuickSQLiteConnection } from './engine';
import type { PackRow } from '../types';
import { deletePackData, installPackFromFiles } from '../packs/installPack';
import { inTransaction } from './transaction';
import {
  refreshFactGraphSafe,
  type FactNodeRef,
} from '../facts/factGraph';
import {
  setFactNodeExcluded as updateFactNodeExclusion,
  listHiddenPeople as queryHiddenPeople,
  type HiddenPerson,
  type FactExclusionUpdate,
} from '../facts/factExclusions';
import { rebuildPersonCardIndex } from '../facts/personCardIndex';
import {
  hideItem as hideItemIn,
  unhideItem as unhideItemIn,
  listHidden as listHiddenIn,
  type HiddenItem,
  type HiddenKind,
} from '../facts/hiddenItems';
import { BUILTIN_PACKS } from '../packs/builtins';
import {
  CAMP_WRITER_ID_KEY,
  CAMP_PASSPHRASE_KEY,
  boardPackId,
  campIdFor,
  reconcileCampProjections,
  rematerializeAllBoards,
} from '../camp/campBoard';
import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  FTS_SCHEMA_VERSION,
  ADDITIVE_COLUMNS,
  DROP_FTS_SQL,
  REBUILD_FTS_SQL,
  VEC_TABLE_SQL,
  VEC_SCHEMA_VERSION,
  DROP_VEC_SQL,
} from './schema';
import { loadVecExtension } from './engine';

// DO NOT RENAME. This is the on-disk filename of every existing install's
// database -- chat log, event corpus, camp board, vector index. The app was
// renamed PocketHippo -> Playa Pal in 8128e48 and this string was deliberately
// left behind, because openAppDb() CREATES a database when it does not find
// one: renaming the constant does not move the file, it silently starts a new
// empty one and the user's history is still on disk but unreachable. Nothing
// would throw and no test would fail.
//
// It is left with the old name ON PURPOSE, and it is written down here because
// the state is indistinguishable from a rename someone forgot to finish --
// which is the shape of the bug that would delete it. If this ever must
// change, ship a migration that renames the FILE first and falls back to the
// old name when the new one is absent.
const DB_NAME = 'pocket-hippo.db';

let db: QuickSQLiteConnection | null = null;
let ftsAvailable = false;
let vecAvailable = false;

export function getDb(): QuickSQLiteConnection {
  if (!db) {
    db = openAppDb(DB_NAME);
    initSchema(db);
    seedBuiltinPacks(db);
    backfillPersonCards(db);
    refreshFactGraphSafe(db);
    try {
      // Upgrade migration (audit 2026-08-20): sweep projections a pre-
      // projection-gating camp switch may have left retrievable. Idempotent.
      reconcileCampProjections(db);
      rebuildFtsIndexes(db); // the sweep mutates doc_chunks/events
    } catch (e) {
      console.warn('[db] camp projection reconcile failed:', e);
    }
  }
  return db;
}

/** True when the FTS5 virtual tables exist and MATCH queries can be used. */
export function isFtsAvailable(): boolean {
  getDb();
  return ftsAvailable;
}

/** True when the sqlite-vec extension is loaded and doc_chunk_vectors exists
 * — the semantic arm's hard prerequisite. Keyword-only degrade otherwise. */
export function isVecAvailable(): boolean {
  getDb();
  return vecAvailable;
}

function initSchema(conn: QuickSQLiteConnection): void {
  for (const sql of BASE_TABLES_SQL) {
    conn.execute(sql);
  }
  // Additive columns on pre-existing tables (CREATE IF NOT EXISTS is a no-op
  // there). Idempotent: only when PRAGMA table_info lacks the column.
  for (const m of ADDITIVE_COLUMNS) {
    const info = conn.execute(`PRAGMA table_info(${m.table})`);
    const cols: string[] = [];
    for (let i = 0; i < (info.rows?.length ?? 0); i++) {
      cols.push(String(info.rows!.item(i).name));
    }
    if (cols.includes(m.column)) {
      continue;
    }
    try {
      conn.execute(m.ddl);
    } catch (e) {
      // "duplicate column name" = an engine whose PRAGMA returned no rows but
      // the column exists (fresh table from BASE_TABLES_SQL). Anything else
      // is real and must surface.
      if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) {
        throw e;
      }
    }
  }
  // FTS DDL migration: when the stored version differs (e.g. the porter
  // tokenizer landed after a device already created the old tables), drop the
  // virtual tables so they are recreated below. The per-open rebuild in
  // seedBuiltinPacks() repopulates them from the content tables.
  const verRow = conn.execute('SELECT value FROM settings WHERE key = ?', [
    'fts_schema_version',
  ]);
  const storedVersion =
    verRow.rows && verRow.rows.length > 0 ? verRow.rows.item(0).value : null;
  if (storedVersion !== FTS_SCHEMA_VERSION) {
    for (const sql of DROP_FTS_SQL) {
      conn.execute(sql);
    }
  }
  // Probe FTS5: creating the virtual tables throws if FTS5 was not compiled in.
  try {
    for (const sql of FTS_TABLES_SQL) {
      conn.execute(sql);
    }
    ftsAvailable = true;
    conn.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['fts_schema_version', FTS_SCHEMA_VERSION],
    );
  } catch (e) {
    ftsAvailable = false;
    console.warn('[db] FTS5 unavailable, falling back to LIKE queries:', e);
  }
  // sqlite-vec: the semantic arm's extension. Same availability pattern as
  // FTS — absent extension (old builds, test hosts without the .so) degrades
  // the app to keyword-only, never breaks it. Version-stamped like the FTS
  // DDL so a dim change recreates the virtual table.
  try {
    loadVecExtension(conn);
    const vecVerRow = conn.execute(
      'SELECT value FROM settings WHERE key = ?',
      ['vec_schema_version'],
    );
    const storedVec =
      vecVerRow.rows && vecVerRow.rows.length > 0
        ? vecVerRow.rows.item(0).value
        : null;
    if (storedVec !== VEC_SCHEMA_VERSION) {
      for (const sql of DROP_VEC_SQL) {
        conn.execute(sql);
      }
    }
    conn.execute(VEC_TABLE_SQL);
    vecAvailable = true;
    conn.execute(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['vec_schema_version', VEC_SCHEMA_VERSION],
    );
  } catch (e) {
    vecAvailable = false;
    console.warn('[db] sqlite-vec unavailable, semantic arm inert:', e);
  }
}

/**
 * Rebuild both external-content FTS indexes from their content tables.
 * Called after any pack install/removal — 'rebuild' is simpler and safer than
 * per-row delete bookkeeping at these data sizes.
 */
export function rebuildFtsIndexes(conn: QuickSQLiteConnection): void {
  // ftsAvailable describes THE APP DB; a conn-taking function must not
  // no-op for a different conn that genuinely has the tables (the same
  // wrong-scope class as the camp-scoped remat bug). Probe when unset.
  if (!ftsAvailable) {
    try {
      conn.execute('SELECT 1 FROM doc_chunks_fts LIMIT 1');
    } catch {
      return; // this conn really has no FTS — keyword-only degrade
    }
  }
  for (const sql of REBUILD_FTS_SQL) {
    conn.execute(sql);
  }
}

export const PERSON_CARD_INDEX_VERSION = 2;

function personCardIndexVersion(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  try {
    const stamp = JSON.parse(raw) as unknown;
    if (typeof stamp === 'number') {
      return Number.isInteger(stamp) ? stamp : null;
    }
    if (stamp && typeof stamp === 'object' && !Array.isArray(stamp)) {
      const version = (stamp as { version?: unknown }).version;
      return typeof version === 'number' && Number.isInteger(version)
        ? version
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

interface PersonCardPackReceipt {
  pack_id: string;
  graphPeople: number;
  explicitCardChunks: number;
  legacyCards: number;
  excludedLinkedPeople: number;
  indexedRows: number;
}

function personCardIndexReceipt(
  conn: QuickSQLiteConnection,
): PersonCardPackReceipt[] {
  const receipts = new Map<string, PersonCardPackReceipt>();
  const nodes = conn.execute(
    `SELECT n.pack_id, n.attrs,
            CASE WHEN x.node_id IS NULL THEN 0 ELSE 1 END AS excluded
     FROM nodes n
     LEFT JOIN fact_exclusions x
       ON x.pack_id = n.pack_id AND x.node_id = n.id
     WHERE n.type = 'person'
     ORDER BY n.pack_id, n.id`,
  ).rows?._array ?? [];
  for (const row of nodes) {
    const pack_id = String(row.pack_id);
    const receipt = receipts.get(pack_id) ?? {
      pack_id,
      graphPeople: 0,
      explicitCardChunks: 0,
      legacyCards: 0,
      excludedLinkedPeople: 0,
      indexedRows: 0,
    };
    let attrs: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(row.attrs));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        attrs = parsed as Record<string, unknown>;
      }
    } catch {
      // The graph refresh owns malformed-attrs reporting. The receipt records
      // only source shapes it can prove.
    }
    const explicit = attrs.card_chunk !== undefined;
    const legacy = !explicit && attrs.card !== undefined;
    receipt.graphPeople += 1;
    receipt.explicitCardChunks += explicit ? 1 : 0;
    receipt.legacyCards += legacy ? 1 : 0;
    receipt.excludedLinkedPeople +=
      Number(row.excluded) === 1 && (explicit || legacy) ? 1 : 0;
    receipts.set(pack_id, receipt);
  }
  const indexed = conn.execute(
    `SELECT pack_id, COUNT(*) AS count
     FROM person_card_chunks GROUP BY pack_id ORDER BY pack_id`,
  ).rows?._array ?? [];
  for (const row of indexed) {
    const pack_id = String(row.pack_id);
    const receipt = receipts.get(pack_id) ?? {
      pack_id,
      graphPeople: 0,
      explicitCardChunks: 0,
      legacyCards: 0,
      excludedLinkedPeople: 0,
      indexedRows: 0,
    };
    receipt.indexedRows = Number(row.count);
    receipts.set(pack_id, receipt);
  }
  return [...receipts.values()].sort((a, b) =>
    a.pack_id.localeCompare(b.pack_id),
  );
}

/** One-time hydration for packs installed before the direct person-card index
 * existed. The v2 stamp invalidates the poisoned bare v1 marker and carries
 * per-pack source-shape/row receipts. A pack with visible card links cannot
 * stamp a zero-row rebuild as complete. */
export function backfillPersonCards(conn: QuickSQLiteConnection): void {
  const row = conn.execute('SELECT value FROM settings WHERE key = ?', [
    'person_card_index_version',
  ]);
  const raw = row.rows?.length ? String(row.rows.item(0).value) : null;
  if (personCardIndexVersion(raw) === PERSON_CARD_INDEX_VERSION) {
    return;
  }
  const warnings = rebuildPersonCardIndex(conn);
  for (const warning of warnings) {
    console.warn('[db] person card index:', warning);
  }
  const packs = personCardIndexReceipt(conn);
  const empty = packs.find(pack =>
    pack.explicitCardChunks + pack.legacyCards > pack.excludedLinkedPeople &&
    pack.indexedRows === 0,
  );
  if (empty) {
    throw new Error(
      `Person card backfill produced zero rows for linked pack ${empty.pack_id}`,
    );
  }
  conn.execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [
      'person_card_index_version',
      JSON.stringify({ version: PERSON_CARD_INDEX_VERSION, packs }),
    ],
  );
}

/** Install/refresh the two bundled packs when missing or version-bumped. */
function seedBuiltinPacks(conn: QuickSQLiteConnection): void {
  for (const pack of BUILTIN_PACKS) {
    const row = conn.execute('SELECT version FROM packs WHERE id = ?', [
      pack.manifest.id,
    ]);
    const existing = row.rows && row.rows.length > 0 ? row.rows.item(0) : null;
    if (existing && existing.version === pack.manifest.version) {
      continue;
    }
    installPackFromFiles(conn, pack.files, {
      builtin: true,
      ...(pack.chunkMaxChars ? { chunkMaxChars: pack.chunkMaxChars } : {}),
    });
  }
  rebuildFtsIndexes(conn);
}

export function listPacks(): PackRow[] {
  const conn = getDb();
  const res = conn.execute(
    `SELECT p.*,
       (SELECT COUNT(*) FROM events e WHERE e.pack_id = p.id) AS eventCount,
       (SELECT COUNT(*) FROM doc_chunks d WHERE d.pack_id = p.id) AS chunkCount,
       (SELECT COUNT(*) FROM camp_posts cp WHERE cp.pack_id = p.id) AS postCount,
       (SELECT COUNT(*) FROM nodes n WHERE n.pack_id = p.id) AS nodeCount,
       (SELECT COUNT(*) FROM edges x WHERE x.pack_id = p.id) AS edgeCount
     FROM packs p ORDER BY p.builtin DESC, p.name`,
  );
  const rows = res.rows?._array ?? [];
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    version: r.version,
    enabled: r.enabled === 1,
    builtin: r.builtin === 1,
    eventCount: r.eventCount,
    chunkCount: r.chunkCount,
    postCount: r.postCount,
    nodeCount: r.nodeCount,
    edgeCount: r.edgeCount,
  }));
}

const PACK_IDENTITY_STOPWORDS = new Set([
  'pack', 'data', 'docs', 'lore', 'history', 'archive', 'years',
]);

/** Enabled pack labels usable as identity affiliation trailers. Full names and
 * IDs handle multi-word camps; distinctive component words preserve familiar
 * shorthand without baking any one camp into the parser. */
export function identityAffiliationTerms(
  conn: QuickSQLiteConnection = getDb(),
): string[] {
  const result = conn.execute(
    `SELECT p.id, p.name FROM packs p
     WHERE p.enabled = 1
       AND EXISTS (
         SELECT 1 FROM nodes n
         WHERE n.pack_id = p.id AND n.type = 'person'
       )
     ORDER BY p.id`,
  );
  const terms = new Set<string>();
  const hasTerm = (candidate: string) =>
    [...terms].some(term =>
      term.localeCompare(candidate, undefined, { sensitivity: 'accent' }) === 0,
    );
  for (const row of result.rows?._array ?? []) {
    const labels = [String(row.name), String(row.id)];
    for (const label of labels) {
      terms.add(label);
      for (const word of label.split(/[^\p{L}\p{N}]+/u)) {
        const normalized = word.toLocaleLowerCase();
        if (
          normalized.length >= 4 &&
          !PACK_IDENTITY_STOPWORDS.has(normalized) &&
          !/^\d+$/u.test(normalized) &&
          !hasTerm(word)
        ) {
          terms.add(word);
        }
      }
    }
  }
  return [...terms];
}

/** Distinct event dates (ISO, ascending) across ENABLED packs — feeds the
 * Right Now day-picker chips, so the chips always match the data. */
export function eventDates(): string[] {
  const res = getDb().execute(
    'SELECT DISTINCT e.date FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 ORDER BY e.date',
  );
  const rows = res.rows?._array ?? [];
  return rows.map((r: any) => r.date as string);
}

/** THE conn-taking toggle — deliberately the only one, so no caller can
 * reach a partial path (audit round 6e: a wrapper quietly downgrading to a
 * remat-only variant survived mutation while every suite stayed green).
 * Atomic flip+remat in one transaction; the derived FTS reindex after
 * commit. Search correctness must come from THIS path, never from a
 * test-side rebuild. */
export function setPackEnabledFull(
  conn: QuickSQLiteConnection,
  packId: string,
  enabled: boolean,
): void {
  inTransaction(conn, () => {
    conn.execute('UPDATE packs SET enabled = ? WHERE id = ?', [
      enabled ? 1 : 0,
      packId,
    ]);
    if (packId.startsWith('camp-board-')) {
      rematerializeAllBoards(conn);
    }
  });
  if (packId.startsWith('camp-board-')) {
    rebuildFtsIndexes(conn);
  }
}

export function setPackEnabled(packId: string, enabled: boolean): void {
  const conn = getDb();
  setPackEnabledFull(conn, packId, enabled);
  refreshFactGraphSafe(conn);
}

/** Revocably hide one structured fact node at resolve time. The stored pack is
 * unchanged, so a later restore can rebuild the same exact identity. */
export function setFactNodeExcluded(
  ref: FactNodeRef,
  excluded: boolean,
): FactExclusionUpdate {
  return updateFactNodeExclusion(getDb(), ref, excluded);
}

/** The undo surface for setFactNodeExcluded: who is hidden right now. */
export function listHiddenPeople(): HiddenPerson[] {
  return queryHiddenPeople(getDb());
}
export type { HiddenPerson };

// "Don't use this" -- one verb over people, passages and events. See
// facts/hiddenItems.ts for why people route through fact_exclusions and the
// rest through hidden_items under the same word.
export function hideItem(item: Omit<HiddenItem, 'ts'>): void {
  const conn = getDb();
  hideItemIn(conn, item);
  rebuildFtsIndexes(conn); // note hides rematerialize chunks — reindex
}
export function unhideItem(kind: HiddenKind, key: string): void {
  const conn = getDb();
  unhideItemIn(conn, kind, key);
  rebuildFtsIndexes(conn); // restoring a hidden note must reappear in search
}
export function listHidden(): HiddenItem[] {
  return listHiddenIn(getDb());
}
export type { HiddenItem, HiddenKind };

export function removePack(packId: string): void {
  const conn = getDb();
  // Camp guard: this phone's OWN current-camp board pack is the live editing
  // surface, not an installed copy — removing it here would be two-tap data
  // loss. Beamed board packs from OTHER writers remove normally (that is how
  // you drop a campmate who left, or clear a resolved conflicted copy), and
  // so do this writer's packs from camps it has LEFT (archived contexts).
  // The read-only-packs invariant thus extends to "read-only except camp
  // packs, own current board pack undeletable" (doc 30 Axis 5A).
  const ownWriter = getSetting(CAMP_WRITER_ID_KEY);
  const passphrase = getSetting(CAMP_PASSPHRASE_KEY) ?? '';
  const ownCampId = passphrase ? campIdFor(passphrase) : '';
  if (ownWriter && packId === boardPackId(ownCampId, ownWriter)) {
    throw new Error(
      "This phone's own board posts — manage them in the Camp tab instead.",
    );
  }
  if (ownWriter && packId === `camp-notes-${ownCampId}-${ownWriter}`) {
    throw new Error(
      "This phone's own camp notes — manage them in Add to camp knowledge → My notes.",
    );
  }
  const target = conn.execute('SELECT builtin FROM packs WHERE id = ?', [packId]);
  if (!target.rows?.length) {
    return;
  }
  if (target.rows.item(0).builtin === 1) {
    throw new Error('Built-in packs can be disabled, but not removed.');
  }
  inTransaction(conn, () => {
    deletePackData(conn, packId);
    conn.execute('DELETE FROM camp_posts WHERE pack_id = ?', [packId]);
    // A fork pack retires its durable fork record (so a re-import can surface
    // it again deliberately); a real board pack retires its camp-scoped
    // high-water/envelope row so the writer's data is truly gone and no longer
    // re-exported.
    conn.execute('DELETE FROM camp_forks WHERE pack_id = ?', [packId]);
    const writerMatch = packId.match(
      /^camp-board-([a-z0-9]{4,32})-([a-z0-9]{4,32})$/,
    );
    if (writerMatch) {
      const campId = writerMatch[1] === 'local' ? '' : writerMatch[1];
      conn.execute(
        'DELETE FROM camp_writers WHERE camp_id = ? AND writer_id = ?',
        [campId, writerMatch[2]],
      );
      // Removing a campmate's board removes the WRITER — their notes and
      // notes pack go with the envelope, or "removed" leaves them surfaced.
      conn.execute(
        'DELETE FROM camp_notes WHERE camp_id = ? AND writer_id = ?',
        [campId, writerMatch[2]],
      );
      const notesPack = `camp-notes-${campId}-${writerMatch[2]}`;
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [notesPack]);
      conn.execute('DELETE FROM events WHERE pack_id = ?', [notesPack]);
      conn.execute('DELETE FROM packs WHERE id = ?', [notesPack]);
    }
    // Removing a notes pack removes the WRITER as a unit — envelope, board
    // and posts go too. Anything less is false deletion: the stored
    // envelope re-exports the "removed" notes to campmates while equal-seq
    // re-imports can't restore them locally (audit 2026-08-20). Their next
    // beam brings the campmate back whole.
    const notesMatch = packId.match(
      /^camp-notes-([0-9a-f]{8})-([a-z0-9]{4,32})$/,
    );
    if (notesMatch) {
      conn.execute(
        'DELETE FROM camp_notes WHERE camp_id = ? AND writer_id = ?',
        [notesMatch[1], notesMatch[2]],
      );
      conn.execute(
        'DELETE FROM camp_writers WHERE camp_id = ? AND writer_id = ?',
        [notesMatch[1], notesMatch[2]],
      );
      const boardPack = `camp-board-${notesMatch[1] || 'local'}-${notesMatch[2]}`;
      conn.execute('DELETE FROM camp_posts WHERE pack_id = ?', [boardPack]);
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [boardPack]);
      conn.execute('DELETE FROM packs WHERE id = ?', [boardPack]);
      conn.execute(
        'DELETE FROM camp_writers WHERE camp_id = ? AND writer_id = ?',
        [notesMatch[1], notesMatch[2]],
      );
    }
    const removedWriter = writerMatch ?? notesMatch;
    if (removedWriter) {
      // The writer's FORK copies go with them (a conflicted snapshot is
      // still their content), and the surviving boards rematerialize so
      // replies this writer left inside OTHER writers' chunks disappear
      // (audit 2026-08-20). removePack's FTS rebuild below reindexes.
      const forkCamp = removedWriter[1] === 'local' ? '' : removedWriter[1];
      const forks = conn.execute(
        'SELECT pack_id FROM camp_forks WHERE camp_id = ? AND writer_id = ?',
        [forkCamp, removedWriter[2]],
      );
      for (const f of (forks.rows?._array ?? []) as { pack_id: string }[]) {
        conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [f.pack_id]);
        conn.execute('DELETE FROM packs WHERE id = ?', [f.pack_id]);
      }
      conn.execute(
        'DELETE FROM camp_forks WHERE camp_id = ? AND writer_id = ?',
        [forkCamp, removedWriter[2]],
      );
      conn.execute('DELETE FROM camp_posts WHERE writer_id = ? AND camp_id = ?', [
        removedWriter[2],
        forkCamp,
      ]);
      rematerializeAllBoards(conn);
    }
    conn.execute('DELETE FROM packs WHERE id = ?', [packId]);
  });
  refreshFactGraphSafe(conn);
  rebuildFtsIndexes(conn);
}

export function getSetting(key: string): string | null {
  const res = getDb().execute('SELECT value FROM settings WHERE key = ?', [key]);
  return res.rows && res.rows.length > 0 ? res.rows.item(0).value : null;
}

export function setSetting(key: string, value: string): void {
  getDb().execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}
