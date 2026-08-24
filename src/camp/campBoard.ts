/**
 * Camp board v0 — append-only needs/offers board with envelope-sealed beams.
 * (Design history: piloted as the camp-mesh resource map, re-scoped after a
 * cross-model design review to the append-only board + beam model here.)
 *
 * DATA MODEL — append-only statements, never mutable shared state. A row is
 * one author's statement ("offering: 3 spare bike tubes"); the only writes
 * are the author's own: new posts, edits of their own text, the author-only
 * `done` flag (retraction/completion as a SUPERSEDING statement — done rows
 * still beam), and reply rows (`ref_id`) that thread under any item without
 * writing to it. "Likely resolved" is DERIVED render state (item has
 * replies), never a write to the original. Honesty note (review finding 9):
 * user-level retraction is explicit (`done`), but the 30-day age prune IS
 * whole-snapshot deletion by omission — pruned rows vanish from the next
 * higher-seq snapshot, which is replay-safe under the monotonic high-water
 * rule and is tested as such.
 *
 * CAMP BOUNDARY (review finding 3) — posts belong to the camp they were
 * authored under. All board state is keyed by (camp_id, writer_id): pack
 * ids are `camp-board-<camp_id>-<writer_id>` ('local' before any camp is
 * joined). Changing the passphrase is a leave/join transition: pre-camp
 * drafts are ADOPTED into the first camp joined; switching camps leaves the
 * old camp's posts behind (hidden, never exported, never restamped);
 * switching back restores them. Nothing ever crosses camps.
 *
 * SYNC — per-writer snapshot replication with replay protection. Every beam
 * carries one canonical ENVELOPE per known writer: {camp_id, writer_id,
 * author_name, key_id, seq, payload_hash, posts, tag} where tag =
 * HMAC-SHA256 over the canonical serialization keyed by the camp
 * passphrase. The importer verifies everything first, then — inside ONE
 * transaction — groups envelopes BY WRITER (review finding 1: duplicates of
 * one writer inside a single beam must not bypass the rules): the
 * deterministic winner is the greatest seq (payload-hash ascending as the
 * tiebreak), lower seqs in the same bundle are stale, and every other
 * equal-max-seq variant surfaces as a FORK. Against the stored high-water
 * (seq, payload_hash) per (camp_id, writer_id): lower seq → stale, equal
 * seq + equal hash → idempotent no-op, equal seq + different hash → fork —
 * installed beside, never overwriting, recorded durably in camp_forks
 * (idempotent re-import), never re-exported, never advancing the
 * high-water. Verified envelopes are stored verbatim and re-exported, so
 * updates travel multi-hop (A reaches C through B).
 *
 * LOCAL WRITES (review finding 2) — every own-payload mutation (post, done,
 * profile, prune, migration, incarnation rotation) runs in the same single
 * transaction as its seq bump and materialization, so a crash can never
 * leave a changed payload at an old seq (the avoidable self-fork).
 *
 * WRITER INCARNATION (review finding 4) — writer_id is per-install. Android
 * closes the backup-restore clone channel with allowBackup=false. On iOS
 * the app stores an incarnation token in the Caches directory (excluded
 * from iCloud/iTunes backup by design): at startup
 * reconcileWriterIncarnation() compares it with the settings copy — a
 * restored clone (token missing/mismatched) ROTATES to a fresh writer id,
 * carrying this device's own posts, so clone-vs-original equal-seq forks
 * never happen. Residual, documented: an OS cache purge causes a benign
 * rotation; a full-filesystem clone (token included) still forks — fork
 * surfacing remains the backstop.
 *
 * TRUST LABEL — pilot: the seal proves same-passphrase origin and transit
 * integrity, NOT authorship (any passphrase holder can claim any name and
 * writer id). The UI says so. See review finding 5 for the deferred real
 * control plane (signatures, membership, revocation, KDF, AEAD).
 *
 * Every function takes the connection first (installPackFromFiles pattern)
 * so the module runs against node:sqlite in tests; callers run
 * rebuildFtsIndexes() after mutations (post-commit; index recovery is
 * non-fatal), same contract as the pack installer.
 */

import type { DbConnection as QuickSQLiteConnection } from '../events/engine';
import { inTransaction } from '../events/transaction';
import { hmacSha256Hex, sha256, utf8Bytes, digestsEqual } from './hmac';

import {
  CampNote,
  CampNoteError,
  NoteInput,
  WireNote,
  asKind,
  canonicalNotes,
  ownNoteRows,
  parseWireNotes,
  rematerializeNotes,
  replaceWriterNotes,
  notifyNotesChanged,
  validateEventWhen,
  NOTE_FIELD_MAX,
  NOTE_TEXT_MAX,
  MAX_NOTES_PER_WRITER,
  NOTE_PHOTO_BUDGET_B64,
  NOTE_PHOTO_MAX_B64,
  isJpegBase64,
} from './campNotes';

export const CAMP_PACK_PREFIX = 'camp-board-';

/** Only ids of this exact shape are app-managed notes packs; anything else
 * in the namespace is a legacy import and must never be swept. */
const MANAGED_NOTES_RE = /^camp-notes-[0-9a-f]{8}-[a-z0-9]{4,32}$/;
export const CAMP_BUNDLE_KIND = 'playapal-camp-board';
// Format 2 (2026-08-20): the sealed payload is {posts, notes} — camp notes
// ride the same envelope under the same writer seq (CAMP-NOTES-DESIGN
// ruling A). v1 beams (posts only) still verify and import; envelopes
// carry their sealed-under format so relayed v1 snapshots keep verifying
// inside v2 bundles.
export const CAMP_BUNDLE_FORMAT = 2;

export const CAMP_WRITER_ID_KEY = 'camp_writer_id';
export const CAMP_AUTHOR_NAME_KEY = 'camp_author_name';
export const CAMP_PASSPHRASE_KEY = 'camp_passphrase';
export const CAMP_OWN_SEQ_KEY = 'camp_own_seq';
export const CAMP_INCARNATION_KEY = 'camp_incarnation';

/** Default board view shows posts younger than this (display-side only). */
export const CAMP_FRESH_HOURS = 72;
/** Local prune horizon at app start — whole-snapshot deletion by omission,
 * guarded by the seq bump (see module header). */
export const CAMP_POST_MAX_AGE_DAYS = 30;

export type CampPostType = 'offer' | 'need';

export interface CampPost {
  id: string;
  writer_id: string;
  author_name: string;
  type: CampPostType;
  text: string;
  /** Set on reply rows: the id of the post this replies to. */
  ref_id: string | null;
  created_at: string;
  done: boolean;
}

/** A post as rendered: which pack it came from + fork marking. */
export interface BoardPost extends CampPost {
  pack_id: string;
  /** True when the row came from a surfaced "conflicted copy" pack. */
  fork: boolean;
}

export interface CampIdentity {
  writerId: string;
  authorName: string;
  /** '' = not set. Beaming/importing needs it; local posting never does. */
  passphrase: string;
  /** Derived from the passphrase; '' when unset. */
  campId: string;
  keyId: string;
}

/** Import/export failures the UI shows verbatim. */
export class CampBeamError extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const kvGet = (conn: QuickSQLiteConnection, key: string): string | null => {
  const res = conn.execute('SELECT value FROM settings WHERE key = ?', [key]);
  return res.rows && res.rows.length > 0 ? res.rows.item(0).value : null;
};

const kvSet = (conn: QuickSQLiteConnection, key: string, value: string): void => {
  conn.execute(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
};

const randHex = (chars: number): string => {
  let s = '';
  while (s.length < chars) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
};

const sha256Hex = (s: string): string =>
  Array.from(sha256(utf8Bytes(s)), b => b.toString(16).padStart(2, '0')).join('');

/**
 * Strip control characters from typed text: keeps the canonical envelope
 * serialization unambiguous (separators are \n and \u001f) and keeps pasted
 * junk from breaking one-line rows.
 */
const clean = (raw: string): string =>
  // eslint-disable-next-line no-control-regex -- stripping controls IS the point
  raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

const displayName = (name: string): string =>
  name.length > 0 ? name : 'this phone';

/** Trim + collapse + casefold, so "Dusty  Mary " matches "dusty mary". */
export const normalizePassphrase = (raw: string): string =>
  raw.trim().replace(/\s+/g, ' ').toLowerCase();

const sealKey = (passphrase: string): string =>
  `playapal-camp-v0:${normalizePassphrase(passphrase)}`;

/** Camp identity derived from the passphrase — 8 hex, no secret leaked. */
export const campIdFor = (passphrase: string): string =>
  sha256Hex(`playapal-camp-id:${normalizePassphrase(passphrase)}`).slice(0, 8);

/** Key fingerprint — lets a wrong-passphrase import fail with a clear message. */
export const keyIdFor = (passphrase: string): string =>
  sha256Hex(`playapal-camp-key:${normalizePassphrase(passphrase)}`).slice(0, 8);

// ---------------------------------------------------------------------------
// Pack identity — keyed by (camp, writer), review finding 3
// ---------------------------------------------------------------------------

const campKey = (campId: string): string => (campId.length > 0 ? campId : 'local');

/** Physical pack id for one writer's board in one camp. */
export const boardPackId = (campId: string, writerId: string): string =>
  `${CAMP_PACK_PREFIX}${campKey(campId)}-${writerId}`;

/** Fork pack id — 16 hex of payload_hash (the durable record in camp_forks
 * carries the FULL hash; review finding 6). */
const forkPackIdFor = (campId: string, writerId: string, payloadHash: string): string =>
  `${boardPackId(campId, writerId)}-fork-${payloadHash.slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function getCampIdentity(conn: QuickSQLiteConnection): CampIdentity {
  let writerId = kvGet(conn, CAMP_WRITER_ID_KEY);
  if (!writerId) {
    writerId = randHex(8);
    kvSet(conn, CAMP_WRITER_ID_KEY, writerId);
  }
  const passphrase = kvGet(conn, CAMP_PASSPHRASE_KEY) ?? '';
  return {
    writerId,
    authorName: kvGet(conn, CAMP_AUTHOR_NAME_KEY) ?? '',
    passphrase,
    campId: passphrase ? campIdFor(passphrase) : '',
    keyId: passphrase ? keyIdFor(passphrase) : '',
  };
}

/** This phone's CURRENT-camp board pack. */
export const ownBoardPackId = (conn: QuickSQLiteConnection): string => {
  const identity = getCampIdentity(conn);
  return boardPackId(identity.campId, identity.writerId);
};

/**
 * Save name + passphrase. A passphrase change is a leave/join transition
 * (review finding 3): pre-camp drafts ('' camp) are adopted into the first
 * camp joined; switching between camps leaves the old camp's posts behind
 * untouched — they are never restamped or exported into the new camp.
 */
export function saveCampProfile(
  conn: QuickSQLiteConnection,
  profile: { authorName: string; passphrase: string },
): CampIdentity {
  const before = getCampIdentity(conn);
  const authorName = clean(profile.authorName).slice(0, 24);
  const passphrase = normalizePassphrase(profile.passphrase);
  const nextCampId = passphrase ? campIdFor(passphrase) : '';
  return inTransaction(conn, () => {
    kvSet(conn, CAMP_AUTHOR_NAME_KEY, authorName);
    kvSet(conn, CAMP_PASSPHRASE_KEY, passphrase);
    const oldPack = boardPackId(before.campId, before.writerId);
    const newPack = boardPackId(nextCampId, before.writerId);
    if (oldPack !== newPack && before.campId === '') {
      // First join: adopt the pre-camp drafts into this camp.
      conn.execute(
        'UPDATE camp_posts SET pack_id = ?, camp_id = ? WHERE pack_id = ?',
        [newPack, nextCampId, oldPack],
      );
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [oldPack]);
      conn.execute('DELETE FROM packs WHERE id = ?', [oldPack]);
      // Durable board-section hides ride the pack id — carry them across
      // the first-join rename or the hide silently unbinds (audit round 4).
      conn.execute(
        "UPDATE hidden_items SET key = replace(key, ?, ?) WHERE kind = 'passage' AND key LIKE ?",
        [`boardsec:${oldPack}:`, `boardsec:${newPack}:`, `boardsec:${oldPack}:%`],
      );
    }
    // The name labels this writer's statements in the CURRENT context only.
    conn.execute('UPDATE camp_posts SET author_name = ? WHERE pack_id = ?', [
      authorName,
      newPack,
    ]);
    // ...and this writer's NOTES: receivers stamp notes with the envelope
    // author, so leaving the local rows unrenamed made the same note read
    // "recorded by Old" here and "recorded by New" on campmates' phones.
    conn.execute(
      'UPDATE camp_notes SET author_name = ? WHERE camp_id = ? AND writer_id = ?',
      [authorName, nextCampId, before.writerId],
    );
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
    // The camp-change dialog promises notes are set aside with the boards:
    // retire OTHER camps' note packs/projections (canonical camp_notes rows
    // stay — switching back rematerializes them) and rebuild this camp's.
    const noteRows = conn.execute('SELECT id FROM packs WHERE id LIKE ?', [
      'camp-notes-%',
    ]);
    for (const r of (noteRows.rows?._array ?? []) as { id: string }[]) {
      if (!MANAGED_NOTES_RE.test(r.id)) {
        continue; // legacy import that merely shares the prefix — not ours
      }
      if (nextCampId && r.id.startsWith(`camp-notes-${nextCampId}-`)) {
        continue;
      }
      // Projections only: the pack row (and its enabled toggle) persists,
      // so a campmate the user muted stays muted across a switch-and-back.
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [r.id]);
      conn.execute(
        "DELETE FROM events WHERE pack_id = ? AND source_kind = 'camp_note'",
        [r.id],
      );
    }
    if (nextCampId) {
      rematerializeNotes(conn, nextCampId);
    }
    return getCampIdentity(conn);
  });
}

// ---------------------------------------------------------------------------
// Own-board mutations (value at N=1: zero setup required to post).
// Every mutation = payload write + seq bump + pack row + materialization in
// ONE transaction (review finding 2).
// ---------------------------------------------------------------------------

const getOwnSeq = (conn: QuickSQLiteConnection): number =>
  Number(kvGet(conn, CAMP_OWN_SEQ_KEY) ?? '0');

/** Every own-payload change advances the writer's monotonic sequence. */
const bumpOwnSeq = (conn: QuickSQLiteConnection): number => {
  const next = getOwnSeq(conn) + 1;
  kvSet(conn, CAMP_OWN_SEQ_KEY, String(next));
  return next;
};

export interface CampPostInput {
  /** Present = edit that own row; absent = new post. */
  id?: string;
  type: CampPostType;
  text: string;
  /** Present = this is a reply to that item. */
  ref_id?: string | null;
}

const asType = (raw: unknown): CampPostType => (raw === 'need' ? 'need' : 'offer');

/** Add or edit one of THIS writer's statements in the current camp. */
export function upsertCampPost(
  conn: QuickSQLiteConnection,
  input: CampPostInput,
): CampPost {
  const text = clean(input.text);
  if (text.length === 0) {
    throw new CampBeamError('A post needs some text.');
  }
  if (text.length > POST_TEXT_MAX) {
    throw new CampBeamError(
      `That post is over the board limit (${POST_TEXT_MAX} characters) — long-form belongs in a camp note.`,
    );
  }
  const identity = getCampIdentity(conn);
  const packId = boardPackId(identity.campId, identity.writerId);
  const existing = input.id
    ? conn.execute('SELECT * FROM camp_posts WHERE pack_id = ? AND id = ?', [
        packId,
        input.id,
      ])
    : null;
  const prev =
    existing && existing.rows && existing.rows.length > 0
      ? existing.rows.item(0)
      : null;
  // The gate keys on "is this a CREATE" — no existing row — not on whether
  // an id was supplied: INSERT OR REPLACE happily creates under a novel id,
  // which made a supplied id a cap bypass (codex final sweep, addendum 3).
  if (!prev) {
    const count = conn.execute(
      'SELECT COUNT(*) AS n FROM camp_posts WHERE pack_id = ?',
      [packId],
    );
    if (((count.rows?.item(0)?.n as number) ?? 0) >= MAX_POSTS_PER_WRITER) {
      throw new CampBeamError(
        `This phone already holds ${MAX_POSTS_PER_WRITER} board posts — mark some done and remove them before adding more.`,
      );
    }
  }
  const row: CampPost = {
    id: input.id ?? `p-${Date.now().toString(36)}-${randHex(4)}`,
    writer_id: identity.writerId,
    author_name: identity.authorName,
    type: asType(input.type),
    text,
    ref_id: input.ref_id ? String(input.ref_id) : prev ? prev.ref_id : null,
    // Edits keep the original timestamp: age reflects when the statement
    // entered the board, and the fresh-window is not resettable by editing.
    created_at: prev ? prev.created_at : new Date().toISOString(),
    done: prev ? prev.done === 1 : false,
  };
  inTransaction(conn, () => {
    conn.execute(
      `INSERT OR REPLACE INTO camp_posts
         (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, created_at, done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        packId,
        identity.campId,
        row.writer_id,
        row.author_name,
        row.type,
        row.text,
        row.ref_id,
        row.created_at,
        row.done ? 1 : 0,
      ],
    );
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
  });
  return row;
}

/** Author-only done/reopen — the superseding statement, still beamed. */
export function setPostDone(
  conn: QuickSQLiteConnection,
  id: string,
  done: boolean,
): void {
  inTransaction(conn, () => {
    conn.execute('UPDATE camp_posts SET done = ? WHERE pack_id = ? AND id = ?', [
      done ? 1 : 0,
      ownBoardPackId(conn),
      id,
    ]);
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
  });
}

/**
 * 30-day LOCAL prune (call at app start; never throws — but also never
 * leaves partial state: the whole prune is one transaction). This IS
 * whole-snapshot deletion by omission for aged rows (review finding 9),
 * made replay-safe by bumping the own seq whenever own rows were pruned —
 * the next beam supersedes cleanly instead of reading as an equal-seq
 * fork. Caller rebuilds FTS afterwards.
 */
export function pruneCampPosts(
  conn: QuickSQLiteConnection,
  now: Date = new Date(),
): void {
  try {
    inTransaction(conn, () => {
      const cutoff = new Date(
        now.getTime() - CAMP_POST_MAX_AGE_DAYS * 86400_000,
      ).toISOString();
      const writerId = getCampIdentity(conn).writerId;
      // Own live rows may exist under several camp contexts; any pruned own
      // row changes a payload this writer could still export.
      const ownOld = conn.execute(
        `SELECT COUNT(*) AS n FROM camp_posts
         WHERE writer_id = ? AND pack_id NOT LIKE '%-fork-%' AND created_at < ?`,
        [writerId, cutoff],
      );
      const ownPruned =
        ownOld.rows && ownOld.rows.length > 0 ? Number(ownOld.rows.item(0).n) : 0;
      conn.execute('DELETE FROM camp_posts WHERE created_at < ?', [cutoff]);
      if (ownPruned > 0) {
        bumpOwnSeq(conn);
      }
      refreshOwnPackRowOnly(conn);
      rematerializeAllBoards(conn);
    });
  } catch (e) {
    console.warn('[camp] prune skipped (rolled back):', e);
  }
}

function refreshOwnPackRowOnly(conn: QuickSQLiteConnection): void {
  const identity = getCampIdentity(conn);
  // '(this phone)' marks the own board apart from imported ones — but the
  // unnamed fallback IS 'this phone', so the suffix would say it twice.
  upsertBoardPackRow(conn, {
    packId: boardPackId(identity.campId, identity.writerId),
    name: identity.authorName
      ? `Camp board — ${identity.authorName} (this phone)`
      : 'Camp board — this phone',
    description: 'This phone’s own board posts. Managed in the Camp tab.',
    version: getOwnSeq(conn),
  });
}

/** Insert/update a board pack row, preserving the enabled toggle. */
function upsertBoardPackRow(
  conn: QuickSQLiteConnection,
  p: { packId: string; name: string; description: string; version: number },
): void {
  conn.execute(
    `INSERT INTO packs (id, name, description, version, enabled, builtin)
     VALUES (?, ?, ?, ?, 1, 0)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       version = excluded.version`,
    [p.packId, p.name, p.description, p.version],
  );
}

// ---------------------------------------------------------------------------
// Startup reconciliation: legacy pack-id migration + writer incarnation
// ---------------------------------------------------------------------------

/**
 * One-time migration from the r9 pack-id format (`camp-board-<writer>`) to
 * camp-scoped ids. The r9 bench build authored rows before ids carried the
 * camp; they belong to whatever camp this phone is currently in (that is
 * the camp they were beamed for). Never throws.
 */
export function migrateLegacyOwnPack(conn: QuickSQLiteConnection): void {
  try {
    const identity = getCampIdentity(conn);
    const legacy = CAMP_PACK_PREFIX + identity.writerId;
    const target = boardPackId(identity.campId, identity.writerId);
    const has = conn.execute(
      'SELECT COUNT(*) AS n FROM camp_posts WHERE pack_id = ?',
      [legacy],
    );
    if (!has.rows || Number(has.rows.item(0).n) === 0) {
      return;
    }
    inTransaction(conn, () => {
      conn.execute(
        'UPDATE camp_posts SET pack_id = ?, camp_id = ? WHERE pack_id = ?',
        [target, identity.campId, legacy],
      );
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [legacy]);
      conn.execute('DELETE FROM packs WHERE id = ?', [legacy]);
      bumpOwnSeq(conn);
      refreshOwnPackRowOnly(conn);
      rematerializeAllBoards(conn);
    });
  } catch (e) {
    console.warn('[camp] legacy migration skipped:', e);
  }
}

export interface IncarnationOutcome {
  /** Token the caller must persist to NON-BACKED-UP storage (iOS Caches). */
  token: string;
  rotated: boolean;
}

/**
 * Writer-incarnation reconciliation (review finding 4). `fileToken` is read
 * from storage that backup/restore does NOT carry (iOS Caches dir; Android
 * is already covered by allowBackup=false). A restored clone arrives with
 * settings intact but no token → we ROTATE to a fresh writer id, carrying
 * this device's own posts, so the clone and the original can never emit
 * equal-seq/different-hash envelopes for one writer. An OS cache purge
 * looks the same and causes a benign rotation. Returns the token to write
 * back to the file.
 */
export function reconcileWriterIncarnation(
  conn: QuickSQLiteConnection,
  fileToken: string | null,
): IncarnationOutcome {
  const stored = kvGet(conn, CAMP_INCARNATION_KEY);
  if (!stored) {
    // Fresh install, or the pre-incarnation upgrade: adopt/mint the token.
    const token = fileToken ?? randHex(16);
    kvSet(conn, CAMP_INCARNATION_KEY, token);
    return { token, rotated: false };
  }
  if (fileToken === stored) {
    return { token: stored, rotated: false };
  }
  // Settings restored without their incarnation token: rotate the writer.
  return inTransaction(conn, () => {
    const oldWriter = getCampIdentity(conn).writerId;
    const newWriter = randHex(8);
    const token = randHex(16);
    const packs = conn.execute(
      `SELECT DISTINCT pack_id FROM camp_posts
       WHERE writer_id = ? AND pack_id NOT LIKE '%-fork-%'`,
      [oldWriter],
    );
    const rows = (packs.rows?._array ?? []) as { pack_id: string }[];
    for (const r of rows) {
      const suffix = `-${oldWriter}`;
      if (!r.pack_id.endsWith(suffix)) {
        continue;
      }
      const newPack = r.pack_id.slice(0, -suffix.length) + `-${newWriter}`;
      conn.execute(
        'UPDATE camp_posts SET pack_id = ?, writer_id = ? WHERE pack_id = ?',
        [newPack, newWriter, r.pack_id],
      );
      conn.execute('UPDATE packs SET id = ? WHERE id = ?', [newPack, r.pack_id]);
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [r.pack_id]);
      conn.execute(
        "UPDATE hidden_items SET key = replace(key, ?, ?) WHERE kind = 'passage' AND key LIKE ?",
        [`boardsec:${r.pack_id}:`, `boardsec:${newPack}:`, `boardsec:${r.pack_id}:%`],
      );
    }
    kvSet(conn, CAMP_WRITER_ID_KEY, newWriter);
    kvSet(conn, CAMP_INCARNATION_KEY, token);
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
    return { token, rotated: true };
  });
}

// ---------------------------------------------------------------------------
// Materialization (what the Angel reads) — open, non-reply statements with
// their replies inlined. Replies live in the REPLIER's pack, so any board
// change rematerializes all board packs (cheap at camp scale) to keep every
// pack's chunks consistent with cross-pack threads.
// ---------------------------------------------------------------------------

interface PostRow extends Omit<CampPost, 'done'> {
  pack_id: string;
  camp_id: string;
  done: number;
}

const allBoardRows = (conn: QuickSQLiteConnection): PostRow[] =>
  (conn.execute(
    `SELECT * FROM camp_posts WHERE pack_id LIKE '${CAMP_PACK_PREFIX}%' ORDER BY created_at, id`,
  ).rows?._array ?? []) as PostRow[];


/**
 * Idempotent startup reconciliation (upgrade migration, audit 2026-08-20):
 * a phone that switched camps BEFORE projection-gating shipped may still
 * hold enabled old-camp note projections and board chunks. Run the same
 * sweep saveCampProfile now performs, against the current identity.
 */
export function reconcileCampProjections(conn: QuickSQLiteConnection): void {
  const campId = getCampIdentity(conn).campId;
  inTransaction(conn, () => {
    const noteRows = conn.execute('SELECT id FROM packs WHERE id LIKE ?', [
      'camp-notes-%',
    ]);
    for (const r of (noteRows.rows?._array ?? []) as { id: string }[]) {
      if (!MANAGED_NOTES_RE.test(r.id)) {
        continue; // legacy import that merely shares the prefix — not ours
      }
      if (campId && r.id.startsWith(`camp-notes-${campId}-`)) {
        continue;
      }
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [r.id]);
      conn.execute(
        "DELETE FROM events WHERE pack_id = ? AND source_kind = 'camp_note'",
        [r.id],
      );
    }
    rematerializeAllBoards(conn); // camp-scoped: sweeps other camps' chunks
    if (campId) {
      rematerializeNotes(conn, campId);
    }
  });
}

export function rematerializeAllBoards(conn: QuickSQLiteConnection): void {
  // Camp-scoped rebuild: chunks materialize ONLY for the active camp.
  // Every camp's stale chunks are deleted below, so a set-aside camp's
  // board text leaves Angel retrieval entirely; pack rows and their
  // enabled toggles persist untouched and switching back rebuilds.
  const activeCamp = getCampIdentity(conn).campId;
  const activePrefix = `${CAMP_PACK_PREFIX}${activeCamp || 'local'}-`;
  const rows = allBoardRows(conn).filter(r =>
    r.pack_id.startsWith(activePrefix),
  );
  const packIdsRes = conn.execute(
    `SELECT id FROM packs WHERE id LIKE '${CAMP_PACK_PREFIX}%'`,
  );
  const packIds = new Set<string>(
    ((packIdsRes.rows?._array ?? []) as { id: string }[]).map(r => r.id),
  );
  for (const r of rows) {
    packIds.add(r.pack_id);
  }
  const disabledRes = conn.execute(
    "SELECT id FROM packs WHERE id LIKE 'camp-board-%' AND enabled = 0",
  );
  const disabledPacks = new Set<string>(
    ((disabledRes.rows?._array ?? []) as { id: string }[]).map(r => r.id),
  );
  // A muted writer's replies must not ride into an ENABLED writer's chunk
  // (audit 2026-08-20) — the thread renders without them until unmuted.
  const replies = rows.filter(r => r.ref_id && !disabledPacks.has(r.pack_id));
  const typeWord: Record<CampPostType, string> = {
    offer: 'offering',
    need: 'need',
  };
  for (const packId of packIds) {
    conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [packId]);
    const own = rows.filter(r => r.pack_id === packId && !r.ref_id && r.done === 0);
    const byType = new Map<CampPostType, string[]>();
    let author = '';
    for (const post of own) {
      author = post.author_name;
      const thread = [
        `${typeWord[asType(post.type)]}: ${post.text} (${displayName(post.author_name)})`,
        ...replies
          .filter(rp => rp.ref_id === post.id)
          .map(rp => `  reply: ${rp.text} (${displayName(rp.author_name)})`),
      ];
      const t = asType(post.type);
      byType.set(t, [...(byType.get(t) ?? []), thread.join('\n')]);
    }
    for (const t of ['offer', 'need'] as CampPostType[]) {
      const entries = byType.get(t);
      if (!entries) {
        continue;
      }
      conn.execute(
        // note_key carries a DURABLE section identity: chunk ids regenerate
        // on every rematerialization (now every cold launch), so a passage
        // hide keyed on the generated id died by morning (audit 2026-08-20).
        'INSERT INTO doc_chunks (pack_id, source_file, heading, content, note_key) VALUES (?, ?, ?, ?, ?)',
        [
          packId,
          'camp-board',
          `Camp board — ${t === 'offer' ? 'offers' : 'needs'} (${displayName(author)})`,
          entries.join('\n'),
          `boardsec:${packId}:${t}`,
        ],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Board reads + derived render state
// ---------------------------------------------------------------------------

/** Every visible post of the CURRENT camp context (forks included). Posts
 * from other camps this phone visited stay behind their camp boundary. */
export function listCampBoard(conn: QuickSQLiteConnection): BoardPost[] {
  const identity = getCampIdentity(conn);
  const res = conn.execute(
    `SELECT cp.* FROM camp_posts cp
     JOIN packs p ON p.id = cp.pack_id AND p.enabled = 1
     WHERE cp.camp_id = ?
     ORDER BY cp.created_at DESC, cp.id`,
    [identity.campId],
  );
  const rows = (res.rows?._array ?? []) as PostRow[];
  return rows.map(r => ({
    id: r.id,
    writer_id: r.writer_id,
    author_name: r.author_name,
    type: asType(r.type),
    text: r.text,
    ref_id: r.ref_id ?? null,
    created_at: r.created_at,
    done: r.done === 1,
    pack_id: r.pack_id,
    fork: r.pack_id.includes('-fork-'),
  }));
}

export interface BoardThread {
  post: BoardPost;
  replies: BoardPost[];
  /** Derived: item has replies and is not done — render as likely resolved. */
  likelyResolved: boolean;
}

export interface BoardSection {
  type: CampPostType;
  threads: BoardThread[];
}

/** "3m" / "5h" / "2d" — every row displays its age (decay is display-side). */
export function ageLabel(createdAt: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - new Date(createdAt).getTime());
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) {
    return `${Math.max(1, mins)}m`;
  }
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export const isFresh = (createdAt: string, now: Date = new Date()): boolean =>
  now.getTime() - new Date(createdAt).getTime() <= CAMP_FRESH_HOURS * 3600_000;

/**
 * Threaded board sections: offers then needs; open items newest-first, done
 * items after them. `freshOnly` filters ITEMS by the 72h window (replies
 * ride with their parent). Orphan replies (pruned/unknown parent) drop out.
 */
export function deriveBoard(
  posts: BoardPost[],
  opts: { freshOnly: boolean; now?: Date } = { freshOnly: true },
): BoardSection[] {
  const now = opts.now ?? new Date();
  const replies = posts.filter(p => p.ref_id);
  const items = posts.filter(
    p => !p.ref_id && (!opts.freshOnly || isFresh(p.created_at, now)),
  );
  const sections: BoardSection[] = [];
  for (const t of ['offer', 'need'] as CampPostType[]) {
    const mine = items.filter(i => i.type === t);
    const open = mine.filter(i => !i.done);
    const done = mine.filter(i => i.done);
    const threads = [...open, ...done].map(post => {
      const thread = replies
        .filter(r => r.ref_id === post.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        post,
        replies: thread,
        likelyResolved: !post.done && thread.length > 0,
      };
    });
    if (threads.length > 0) {
      sections.push({ type: t, threads });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Envelope: canonical serialization + seal
// ---------------------------------------------------------------------------

export interface CampEnvelope {
  /** The format this envelope was SEALED under (1 = posts only). */
  format: number;
  camp_id: string;
  writer_id: string;
  author_name: string;
  key_id: string;
  seq: number;
  payload_hash: string;
  posts: CampPost[];
  /** Foreign notes ride AS SENT (WireNote): the seal is re-derived
   * from them, and a kind this build cannot name must still hash and
   * relay byte-identically. Reads coerce; the wire does not. */
  notes: WireNote[];
  tag: string;
}

interface CampBundle {
  kind: typeof CAMP_BUNDLE_KIND;
  format: number;
  camp_id: string;
  envelopes: CampEnvelope[];
}

/** Field-ordered, id-sorted, unit-separated — deterministic under any JSON
 * formatting/key order; any content change breaks the seal. */
const canonicalPosts = (posts: CampPost[]): string =>
  posts
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(p =>
      [
        p.id,
        p.ref_id ?? '',
        p.type,
        p.text,
        p.author_name,
        p.created_at,
        p.done ? '1' : '0',
      ].join('\u001f'),
    )
    .join('\n');

/** v2 payload: posts and notes under ONE hash; a record separator keeps
 * the halves from bleeding into each other. v1 payload is posts alone —
 * byte-identical to what format-1 clients sealed. */
const canonicalPayload = (
  format: number,
  posts: CampPost[],
  notes: readonly WireNote[],
): string =>
  format >= 2
    ? `${canonicalPosts(posts)}\u001e\n${canonicalNotes(notes)}`
    : canonicalPosts(posts);

const macMessage = (
  env: Omit<CampEnvelope, 'tag' | 'posts' | 'notes'>,
  canonical: string,
): string =>
  [
    CAMP_BUNDLE_KIND,
    String(env.format),
    env.camp_id,
    env.writer_id,
    env.author_name,
    env.key_id,
    String(env.seq),
    env.payload_hash,
    canonical,
  ].join('\n');

const ownPostRows = (conn: QuickSQLiteConnection): CampPost[] => {
  const res = conn.execute(
    'SELECT * FROM camp_posts WHERE pack_id = ? ORDER BY id',
    [ownBoardPackId(conn)],
  );
  return ((res.rows?._array ?? []) as PostRow[]).map(r => ({
    id: r.id,
    writer_id: r.writer_id,
    author_name: r.author_name,
    type: asType(r.type),
    text: r.text,
    ref_id: r.ref_id ?? null,
    created_at: r.created_at,
    done: r.done === 1,
  }));
};

function buildOwnEnvelope(conn: QuickSQLiteConnection): CampEnvelope {
  const identity = getCampIdentity(conn);
  const posts = ownPostRows(conn);
  const notes = ownNoteRows(conn, identity.campId, identity.writerId);
  const canonical = canonicalPayload(CAMP_BUNDLE_FORMAT, posts, notes);
  const head = {
    format: CAMP_BUNDLE_FORMAT,
    camp_id: identity.campId,
    writer_id: identity.writerId,
    author_name: identity.authorName,
    key_id: identity.keyId,
    seq: getOwnSeq(conn),
    payload_hash: sha256Hex(canonical),
  };
  return {
    ...head,
    posts,
    notes,
    tag: hmacSha256Hex(sealKey(identity.passphrase), macMessage(head, canonical)),
  };
}

/**
 * The beam: this writer's CURRENT-camp envelope PLUS every stored verified
 * envelope of the current camp, verbatim — one beam carries the whole known
 * board and updates travel multi-hop. Forks never re-export; other camps'
 * data never leaves its camp.
 */
export function exportCampBundle(conn: QuickSQLiteConnection): string {
  return exportCampBeam(conn).bundle;
}

/**
 * The beam with its admission receipt. The sender's OWN envelope rides
 * whenever it fits; legal aggregate state CAN exceed the ceiling (the
 * caps are independent — codex P1.6) and then export refuses with words.
 * Foreign envelopes are carried verbatim for multi-hop — but when the
 * whole bundle would be refused at import, they are SHED, largest first,
 * until it fits. Shedding degrades multi-hop relay: a shed board still
 * exports from its own phone whenever it passes its own admission (which
 * legal aggregate state can fail — the refusal-with-words case), and the
 * receipt names whose boards stayed behind so the sender can say so.
 * (Cross-family review, codex blocker 7: the per-writer photo budget alone
 * never bounded the BUNDLE — two 2.5 MB writers already exceed 4 MiB.)
 */
export function exportCampBeam(conn: QuickSQLiteConnection): {
  bundle: string;
  shedAuthors: string[];
} {
  const identity = getCampIdentity(conn);
  if (identity.passphrase.length === 0) {
    throw new CampBeamError(
      'Set your camp passphrase first (Camp tab → Camp sync) so campmates can verify this beam came from your camp.',
    );
  }
  // Metadata first, ONE envelope in memory at a time (codex P1.5: up to 63
  // stored envelopes can total hundreds of MB — parsing them all up front
  // to decide what fits is itself the exhaustion). SQL orders by stored
  // size, smallest first, so the ones that fit are kept greedily and the
  // largest are the first to stay behind; author_name rides the writers
  // row, so a shed needs no parse at all.
  const metas = (conn.execute(
    `SELECT writer_id, author_name, LENGTH(envelope_json) AS len
     FROM camp_writers WHERE camp_id = ? AND writer_id != ? ORDER BY len`,
    [identity.campId, identity.writerId],
  ).rows?._array ?? []) as { writer_id: string; author_name: string; len: number }[];

  const render = (envs: CampEnvelope[]): string =>
    JSON.stringify(
      {
        kind: CAMP_BUNDLE_KIND,
        format: CAMP_BUNDLE_FORMAT,
        camp_id: identity.campId,
        envelopes: envs,
      } satisfies CampBundle,
      null,
      1,
    );

  const own = buildOwnEnvelope(conn);
  const kept: CampEnvelope[] = [own];
  const shedAuthors: string[] = [];
  let out = render(kept);
  // The own-only case admits itself too (codex B13 reverify). This refusal
  // IS reachable through legal authoring: the note, post and photo caps are
  // independent, and their aggregate can exceed the ceiling (codex P1.6).
  // The contract is the honest refusal with words — the camper is told to
  // trim — never a beam every receiver refuses in silence.
  if (utf8Bytes(out).length > EXPORT_CEILING_BYTES) {
    throw new CampBeamError(
      'Your own board has grown past what one beam can carry — remove some photos or notes and beam again.',
    );
  }
  for (const m of metas) {
    // The receiver's REAL capacity bounds the export: a phone holds own +
    // (MAX_BEAM_ENVELOPES - 1) foreign writers, and to a FRESH receiver
    // every envelope in this bundle is foreign — so a bundle of 64 is
    // un-importable by exactly the campmate who needs it most (measured:
    // the definitive batch's B15 test failed on this before the cap was
    // corrected to 63). Shed beyond MAX_BEAM_ENVELOPES - 1.
    if (kept.length >= MAX_BEAM_ENVELOPES - 1) {
      shedAuthors.push(m.author_name || m.writer_id);
      continue;
    }
    // A stored envelope at least as large as the remaining budget cannot
    // fit once rendered (indentation only adds bytes) — shed without even
    // fetching it.
    if (m.len >= EXPORT_CEILING_BYTES) {
      shedAuthors.push(m.author_name || m.writer_id);
      continue;
    }
    const row = conn.execute(
      'SELECT envelope_json FROM camp_writers WHERE camp_id = ? AND writer_id = ?',
      [identity.campId, m.writer_id],
    );
    const envJson = row.rows?.item(0)?.envelope_json as string | undefined;
    if (!envJson) {
      continue; // pruned between the metadata read and now — nothing to carry
    }
    const env = JSON.parse(envJson) as CampEnvelope;
    // UTF-8 BYTES, not string .length: the receiver's hard cap counts
    // bytes and .length counts UTF-16 units (codex B13/B16).
    const candidate = render([...kept, env]);
    if (utf8Bytes(candidate).length <= EXPORT_CEILING_BYTES) {
      kept.push(env);
      out = candidate;
    } else {
      shedAuthors.push(m.author_name || m.writer_id);
    }
  }
  return { bundle: out, shedAuthors };
}

/** Cheap detection: does this file content look like a camp-board beam? */
export function parseCampBundle(text: string): CampBundle | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.kind !== CAMP_BUNDLE_KIND) {
    return null;
  }
  return raw as CampBundle;
}

// ---------------------------------------------------------------------------
// Beam in: verify → group by writer → compare + replace/fork + advance,
// all dispositions and writes inside ONE transaction (findings 1, 6, 7)
// ---------------------------------------------------------------------------

export interface CampInstallResult {
  campId: string;
  /** Author names whose boards were installed/updated. */
  installed: string[];
  /** Author names surfaced as NEW conflicted copies this import. */
  forks: string[];
  unchanged: number;
  stale: number;
  /** Live (non-done, non-reply) posts newly installed across writers. */
  posts: number;
  /** Notes carried by installed writer snapshots. */
  notes: number;
}

// 'boardsec' is reserved: durable board-section hide keys live in that
// namespace, and a writer with that literal id could mint note ids that
// masquerade as section keys (audit round 5).
const WRITER_ID_RE = /^(?!boardsec$)[a-z0-9]{4,32}$/;

interface VerifiedEnvelope {
  env: CampEnvelope;
  posts: CampPost[];
  notes: WireNote[];
}

/** Whole-file and whole-bundle admission bounds (audit 2026-08-20): each
 * writer is capped, but a valid-passphrase beam could otherwise carry
 * unbounded envelopes/bytes into parse and one transaction. */
export const MAX_BEAM_BYTES = 4 * 1024 * 1024;
export const MAX_BEAM_ENVELOPES = 64;
/** Authoring bounds for board posts — the same principle as the note caps:
 * the receiver's wire gate (2000 posts per envelope) and the export
 * ceiling both exist, so authoring refuses FIRST, with words, instead of
 * letting one giant paste build a board no beam can carry (codex, B13
 * reachability: posts were the one uncapped writer surface). */
export const POST_TEXT_MAX = 2000;
export const MAX_POSTS_PER_WRITER = 500;

/** Receivers refuse a beam over MAX_BEAM_BYTES, so the EXPORT admits
 * itself (exportCampBeam): producing an un-importable file would fail
 * silently on every campmate's phone at once. Slack covers the size
 * gate's UTF-16 floor and transport padding. */
export const EXPORT_CEILING_BYTES = MAX_BEAM_BYTES - 256 * 1024;

/** The beam FILE identity (docs/BEAM-INGRESS-CONTRACT.md §1). The content is
 * the JSON above, unchanged; the extension and MIME are what let a receiving
 * phone open the file in Playa Pal with one tap. Legacy .json beams still
 * import through the picker — the sniffer reads content, never names. */
export const BEAM_FILE_EXT = 'playapal';
export const BEAM_MIME = 'application/vnd.playapal.beam+json';

export function installCampBundle(
  conn: QuickSQLiteConnection,
  text: string,
): CampInstallResult {
  // .length (UTF-16 units) is a free FLOOR on bytes — a cheap first gate —
  // but the receiver's contract is BYTES, and a multibyte beam can fit the
  // units while exceeding the bytes (codex final sweep, P1.3). Both checks.
  if (text.length > MAX_BEAM_BYTES || utf8Bytes(text).length > MAX_BEAM_BYTES) {
    throw new CampBeamError(
      'This beam file is far larger than any camp board — refusing to import it.',
    );
  }
  const bundle = parseCampBundle(text);
  if (!bundle) {
    throw new CampBeamError('This file is not a camp-board beam.');
  }
  if (!Number.isInteger(bundle.format) || bundle.format < 1) {
    throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
  }
  if (bundle.format > CAMP_BUNDLE_FORMAT) {
    throw new CampBeamError(
      'This beam came from a newer version of Playa Pal — update this phone’s app first.',
    );
  }
  const identity = getCampIdentity(conn);
  if (identity.passphrase.length === 0) {
    throw new CampBeamError(
      'Set your camp passphrase first (Camp tab → Camp sync), then import this beam again.',
    );
  }
  if (
    !Array.isArray(bundle.envelopes) ||
    bundle.envelopes.length > MAX_BEAM_ENVELOPES
  ) {
    throw new CampBeamError(
      'This beam carries more campmate boards than one camp can hold — refusing to import it.',
    );
  }
  {
    // The durable camp-capacity contract: a phone holds its own board plus
    // at most MAX_BEAM_ENVELOPES - 1 campmates' — refusing here keeps the
    // stored camp bounded at the source. (Export independently sheds to a
    // fresh receiver's capacity, so an overfull legacy store would still
    // emit an importable beam with named shedding — this gate is about the
    // camp's size, not about rescuing export. Both sites spell the 63 as
    // MAX_BEAM_ENVELOPES - 1; if a third appears, derive a shared constant.)
    const stored = conn.execute(
      'SELECT writer_id FROM camp_writers WHERE camp_id = ?',
      [bundle.camp_id],
    );
    const known = new Set(
      ((stored.rows?._array ?? []) as { writer_id: string }[]).map(
        r => r.writer_id,
      ),
    );
    const fresh = new Set(
      bundle.envelopes
        .map((e: any) => String(e?.writer_id ?? ''))
        // own writer never stores (the installer skips own snapshots), so
        // it must not count toward closure (audit round 3, false refusal)
        .filter(
          (w: string) => w && w !== identity.writerId && !known.has(w),
        ),
    ).size;
    if (known.size + fresh > MAX_BEAM_ENVELOPES - 1) {
      throw new CampBeamError(
        'This phone already carries as many campmate boards as one beam can hold — remove a campmate you no longer need first.',
      );
    }
  }
  if (bundle.camp_id !== identity.campId) {
    throw new CampBeamError(
      'This beam is from a different camp (its passphrase does not match yours) — nothing was imported.',
    );
  }
  if (!Array.isArray(bundle.envelopes) || bundle.envelopes.length === 0) {
    throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
  }

  // ---- Verify every envelope BEFORE any write. --------------------------
  const key = sealKey(identity.passphrase);
  const byWriter = new Map<string, VerifiedEnvelope[]>();
  for (const raw of bundle.envelopes) {
    const writerId = String(raw?.writer_id ?? '');
    const seq = Number(raw?.seq);
    if (
      !WRITER_ID_RE.test(writerId) ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      raw.camp_id !== bundle.camp_id ||
      typeof raw.tag !== 'string' ||
      typeof raw.payload_hash !== 'string' ||
      !Array.isArray(raw.posts)
    ) {
      throw new CampBeamError(
        'This camp beam looks damaged and cannot be imported.',
      );
    }
    if (raw.key_id !== identity.keyId) {
      throw new CampBeamError(
        'This beam was sealed with a different camp passphrase — nothing was imported.',
      );
    }
    const authorName = clean(String(raw.author_name ?? '')).slice(0, 24);
    // Sealed-under format: absent means a format-1 snapshot (possibly
    // relayed verbatim inside a newer bundle). A v2 envelope missing its
    // notes array is damage, not emptiness.
    const envFormat = raw.format == null ? 1 : Number(raw.format);
    if (!Number.isInteger(envFormat) || envFormat < 1 || envFormat > CAMP_BUNDLE_FORMAT) {
      throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
    }
    if (envFormat >= 2 && !Array.isArray(raw.notes)) {
      throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
    }
    if (raw.posts.length > 2000) {
      throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
    }
    const posts: CampPost[] = raw.posts.map((p: any) => ({
      id: String(p?.id ?? ''),
      writer_id: writerId,
      author_name: authorName,
      type: asType(p?.type),
      text: String(p?.text ?? ''),
      ref_id: p?.ref_id ? String(p.ref_id) : null,
      created_at: String(p?.created_at ?? ''),
      done: p?.done === true || p?.done === 1,
    }));
    let notes: WireNote[] = [];
    if (envFormat >= 2) {
      try {
        notes = parseWireNotes(raw.notes, writerId, authorName);
      } catch {
        throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
      }
    }
    const canonical = canonicalPayload(envFormat, posts, notes);
    const head = {
      format: envFormat,
      camp_id: bundle.camp_id,
      writer_id: writerId,
      author_name: authorName,
      key_id: String(raw.key_id),
      seq,
      payload_hash: sha256Hex(canonical),
    };
    if (
      head.payload_hash !== raw.payload_hash ||
      !digestsEqual(hmacSha256Hex(key, macMessage(head, canonical)), raw.tag)
    ) {
      throw new CampBeamError(
        'This beam failed its integrity check (modified in transit, or a passphrase mismatch) — nothing was imported.',
      );
    }
    const list = byWriter.get(writerId) ?? [];
    list.push({ env: { ...head, posts, notes, tag: raw.tag }, posts, notes });
    byWriter.set(writerId, list);
  }

  // ---- Compare + write, per writer, in ONE transaction. -----------------
  const result: CampInstallResult = {
    campId: bundle.camp_id,
    installed: [],
    forks: [],
    unchanged: 0,
    stale: 0,
    posts: 0,
    notes: 0,
  };

  const installWriter = (v: VerifiedEnvelope): void => {
    const packId = boardPackId(bundle.camp_id, v.env.writer_id);
    conn.execute('DELETE FROM camp_posts WHERE pack_id = ?', [packId]);
    for (const p of v.posts) {
      conn.execute(
        `INSERT OR REPLACE INTO camp_posts
           (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, created_at, done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          packId,
          bundle.camp_id,
          p.writer_id,
          p.author_name,
          p.type,
          p.text,
          p.ref_id,
          p.created_at,
          p.done ? 1 : 0,
        ],
      );
    }
    const author = displayName(v.env.author_name);
    upsertBoardPackRow(conn, {
      packId,
      name: `Camp board — ${author}`,
      description: `Beamed board posts from ${author}. Re-import a newer beam any time.`,
      version: v.env.seq,
    });
    conn.execute(
      `INSERT INTO camp_writers (camp_id, writer_id, author_name, seq, payload_hash, envelope_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(camp_id, writer_id) DO UPDATE SET
         author_name = excluded.author_name, seq = excluded.seq,
         payload_hash = excluded.payload_hash,
         envelope_json = excluded.envelope_json, updated_at = excluded.updated_at`,
      [
        bundle.camp_id,
        v.env.writer_id,
        v.env.author_name,
        v.env.seq,
        v.env.payload_hash,
        JSON.stringify(v.env),
        new Date().toISOString(),
      ],
    );
    // The writer's canonical notes replace wholesale with the snapshot —
    // same all-or-nothing shape as posts. Fork envelopes never install
    // notes: a conflicted copy surfaces through its board pack only.
    replaceWriterNotes(conn, bundle.camp_id, v.env.writer_id, v.notes);
    result.installed.push(author);
    result.posts += v.posts.filter(p => !p.done && !p.ref_id).length;
    result.notes += v.notes.length;
  };

  /** Durable, idempotent fork surfacing (finding 6): keyed by the FULL
   * (camp, writer, seq, payload_hash); re-importing a recorded fork is a
   * no-op. Forks never touch camp_writers and never re-export. */
  const installFork = (v: VerifiedEnvelope): void => {
    const prior = conn.execute(
      'SELECT pack_id FROM camp_forks WHERE camp_id = ? AND writer_id = ? AND seq = ? AND payload_hash = ?',
      [bundle.camp_id, v.env.writer_id, v.env.seq, v.env.payload_hash],
    );
    if (prior.rows && prior.rows.length > 0) {
      result.unchanged += 1;
      return;
    }
    const packId = forkPackIdFor(bundle.camp_id, v.env.writer_id, v.env.payload_hash);
    const author = displayName(v.env.author_name);
    conn.execute('DELETE FROM camp_posts WHERE pack_id = ?', [packId]);
    for (const p of v.posts) {
      conn.execute(
        `INSERT OR REPLACE INTO camp_posts
           (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, created_at, done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          packId,
          bundle.camp_id,
          p.writer_id,
          p.author_name,
          p.type,
          p.text,
          p.ref_id,
          p.created_at,
          p.done ? 1 : 0,
        ],
      );
    }
    upsertBoardPackRow(conn, {
      packId,
      name: `Camp board — ${author} (conflicted copy)`,
      description: `Two versions of ${author}'s board carry revision ${v.env.seq} with different contents. Both are shown; remove the stale one under Camp > Boards once resolved.`,
      version: v.env.seq,
    });
    conn.execute(
      'INSERT INTO camp_forks (camp_id, writer_id, seq, payload_hash, pack_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        bundle.camp_id,
        v.env.writer_id,
        v.env.seq,
        v.env.payload_hash,
        packId,
        new Date().toISOString(),
      ],
    );
    result.forks.push(author);
  };

  inTransaction(conn, () => {
    for (const [writerId, group] of byWriter) {
      // Deterministic order: seq DESC, then payload_hash ASC — the winner
      // among equal-max-seq variants is the same on every phone regardless
      // of the order envelopes appeared in the bundle (finding 1).
      group.sort(
        (a, b) =>
          b.env.seq - a.env.seq ||
          (a.env.payload_hash < b.env.payload_hash ? -1 : 1),
      );
      // Identical (seq, hash) duplicates inside the bundle collapse to one.
      const seen = new Set<string>();
      const distinct = group.filter(v => {
        const k = `${v.env.seq}:${v.env.payload_hash}`;
        if (seen.has(k)) {
          result.unchanged += 1;
          return false;
        }
        seen.add(k);
        return true;
      });
      const maxSeq = distinct[0].env.seq;
      const top = distinct.filter(v => v.env.seq === maxSeq);
      // Lower seqs in the SAME bundle are superseded by the bundle's own
      // winner — in-bundle stale, applied to nothing.
      result.stale += distinct.length - top.length;

      if (writerId === identity.writerId) {
        // A copy of THIS writer. Never installable: older/equal-same is
        // noise; anything else is a cloned/forked "me" — surface it, never
        // touch the live board.
        const ownSeq = getOwnSeq(conn);
        const ownHash = sha256Hex(
          canonicalPayload(
            CAMP_BUNDLE_FORMAT,
            ownPostRows(conn),
            ownNoteRows(conn, identity.campId, identity.writerId),
          ),
        );
        for (const v of top) {
          if (v.env.seq < ownSeq) {
            result.stale += 1;
          } else if (v.env.seq === ownSeq && v.env.payload_hash === ownHash) {
            result.unchanged += 1;
          } else {
            installFork(v);
          }
        }
        continue;
      }

      const hwRes = conn.execute(
        'SELECT seq, payload_hash FROM camp_writers WHERE camp_id = ? AND writer_id = ?',
        [bundle.camp_id, writerId],
      );
      const hw =
        hwRes.rows && hwRes.rows.length > 0
          ? {
              seq: Number(hwRes.rows.item(0).seq),
              hash: String(hwRes.rows.item(0).payload_hash),
            }
          : null;
      if (!hw || maxSeq > hw.seq) {
        installWriter(top[0]);
        for (const v of top.slice(1)) {
          installFork(v);
        }
      } else if (maxSeq === hw.seq) {
        for (const v of top) {
          if (v.env.payload_hash === hw.hash) {
            result.unchanged += 1;
          } else {
            installFork(v);
          }
        }
      } else {
        result.stale += top.length;
      }
    }
    if (result.installed.length + result.forks.length > 0) {
      rematerializeAllBoards(conn);
      rematerializeNotes(conn, bundle.camp_id);
    }
  });
  // installed>0, not notes>0: an install that DELETES a writer's last note
  // carries zero notes but still replaced them — the reader must hear it.
  if (result.installed.length > 0) {
    notifyNotesChanged();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Camp notes: authoring (canonical write + seq bump + projections)
// ---------------------------------------------------------------------------

/**
 * Author or revise one of MY notes. Requires a camp passphrase first
 * (ruling F: no ambiguous pre-camp drafts). Any mutation bumps the ONE
 * writer seq — the next beam carries the whole snapshot.
 */
export function upsertCampNote(
  conn: QuickSQLiteConnection,
  input: NoteInput,
): CampNote {
  const identity = getCampIdentity(conn);
  if (identity.passphrase.length === 0) {
    throw new CampNoteError(
      'Set your camp passphrase first (Camp tab → Camp sync) — notes belong to a camp.',
    );
  }
  const text = clean(input.text ?? '').slice(0, NOTE_TEXT_MAX);
  if (text.length === 0) {
    throw new CampNoteError('A note needs some words.');
  }
  const kind = asKind(input.kind);
  const when_date = clean(input.when_date ?? '').slice(0, 10);
  const time_start = clean(input.time_start ?? '').slice(0, 5);
  const time_end = clean(input.time_end ?? '').slice(0, 5);
  if (kind === 'event') {
    const err = validateEventWhen(when_date, time_start, time_end);
    if (err) {
      throw new CampNoteError(err);
    }
  }
  // Receivers refuse >MAX_NOTES_PER_WRITER per envelope — refusing note
  // N+1 at authoring closes that per-envelope gate at the source (byte
  // pressure is export self-admission's job; the caps are independent).
  if (!input.id) {
    const count = conn.execute(
      'SELECT COUNT(*) AS n FROM camp_notes WHERE camp_id = ? AND writer_id = ?',
      [identity.campId, identity.writerId],
    );
    if (((count.rows?.item(0)?.n as number) ?? 0) >= MAX_NOTES_PER_WRITER) {
      throw new CampNoteError(
        `This phone already holds ${MAX_NOTES_PER_WRITER} notes — remove one before adding another.`,
      );
    }
  }
  const existing = input.id
    ? conn.execute(
        'SELECT * FROM camp_notes WHERE id = ? AND camp_id = ? AND writer_id = ?',
        [input.id, identity.campId, identity.writerId],
      )
    : null;
  const prev =
    existing && existing.rows && existing.rows.length > 0
      ? existing.rows.item(0)
      : null;
  if (input.id && !prev) {
    // Not mine (or not here): after writer rotation an old note is
    // read-only — the change becomes a NEW note pointing at it (ruling F).
    throw new CampNoteError(
      'That note belongs to an earlier install — add a new note with the correction instead.',
    );
  }
  // Art photo (ruling H): bounded at authoring, budgeted per writer to
  // bound the beam pressure photos add (export self-admission owns the
  // actual ceiling — the caps are independent, codex P1.6).
  // undefined = "not touched": an edit that never opened the photo keeps
  // the one already on the note. '' = an explicit removal. And ONLY art
  // carries a photo: an art→memory edit must not smuggle a hidden thumb
  // into the wire under a kind that never shows it (codex final sweep,
  // P1.4) — the owner layer zeroes it on any non-art kind.
  const photo =
    kind !== 'art'
      ? ''
      : input.photo === undefined
      ? String((prev as any)?.photo ?? '')
      : String(input.photo);
  if (photo && !isJpegBase64(photo)) {
    throw new CampNoteError('That photo did not encode cleanly — try snapping it again.');
  }
  if (photo.length > NOTE_PHOTO_MAX_B64) {
    throw new CampNoteError(
      'That photo is too big for a note — snap it again (the app takes a small thumbnail).',
    );
  }
  if (photo) {
    const used = conn.execute(
      'SELECT COALESCE(SUM(LENGTH(photo)), 0) AS b FROM camp_notes WHERE camp_id = ? AND writer_id = ? AND id != ?',
      [identity.campId, identity.writerId, input.id ?? ''],
    );
    if (((used.rows?.item(0)?.b as number) ?? 0) + photo.length > NOTE_PHOTO_BUDGET_B64) {
      throw new CampNoteError(
        'This phone already carries its full load of photos — remove an old art photo before adding another to keep your beams light.',
      );
    }
  }
  const note: CampNote = {
    id: prev ? prev.id : `${identity.writerId}:n-${Date.now().toString(36)}-${randHex(4)}`,
    writer_id: identity.writerId,
    author_name: identity.authorName,
    kind,
    title: clean(input.title ?? '').slice(0, NOTE_FIELD_MAX),
    when_date,
    time_start,
    time_end,
    where_addr: clean(input.where_addr ?? '').slice(0, NOTE_FIELD_MAX),
    text,
    subject_type: input.subject_type === 'person' ? 'person' : '',
    subject_key: clean(input.subject_key ?? '').slice(0, NOTE_FIELD_MAX),
    year: clean(input.year ?? '').slice(0, 4),
    supersedes: prev ? prev.supersedes : '',
    created_at: prev ? prev.created_at : new Date().toISOString(),
    revised_at: prev ? new Date().toISOString() : '',
    photo,
  };
  inTransaction(conn, () => {
    conn.execute(
      `INSERT OR REPLACE INTO camp_notes
         (id, camp_id, writer_id, author_name, kind, title, when_date,
          time_start, time_end, where_addr, text, subject_type, subject_key,
          year, supersedes, created_at, revised_at, photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        note.id, identity.campId, note.writer_id, note.author_name,
        note.kind, note.title, note.when_date, note.time_start,
        note.time_end, note.where_addr, note.text, note.subject_type,
        note.subject_key, note.year, note.supersedes, note.created_at,
        note.revised_at, note.photo,
      ],
    );
    bumpOwnSeq(conn);
    rematerializeNotes(conn, identity.campId);
  });
  notifyNotesChanged();
  return note;
}

/** Remove one of MY notes. Higher-seq omission IS propagated deletion
 * under the snapshot protocol — no tombstones needed. */
export function removeCampNote(conn: QuickSQLiteConnection, id: string): void {
  const identity = getCampIdentity(conn);
  inTransaction(conn, () => {
    conn.execute(
      'DELETE FROM camp_notes WHERE id = ? AND camp_id = ? AND writer_id = ?',
      [id, identity.campId, identity.writerId],
    );
    bumpOwnSeq(conn);
    rematerializeNotes(conn, identity.campId);
  });
  notifyNotesChanged();
}
