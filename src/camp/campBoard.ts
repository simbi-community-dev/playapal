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
// kvGet/kvSet were a private copy of db.ts's settings SQL; the shared
// conn-taking pair lives in engine.ts (db.ts imports campBoard, so it
// cannot be the home without closing a cycle).
import { getSettingOn as kvGet, setSettingOn as kvSet } from '../events/engine';
import { inTransaction } from '../events/transaction';
import { hmacSha256Hex, sha256Hex, utf8Bytes, digestsEqual } from './hmac';
import {
  CampNote,
  CampNoteError,
  NoteInput,
  WireNote,
  asKind,
  canonicalNotes,
  ownWireNoteRows,
  parseWireNotes,
  projectForkNotes,
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
import { randHex } from '../util/random';
import { cleanText as clean } from '../util/text';

export const CAMP_PACK_PREFIX = 'camp-board-';

/** Only ids of this exact shape are app-managed notes packs; anything else
 * in the namespace is a legacy import and must never be swept. */
const MANAGED_NOTES_RE = /^camp-notes-[0-9a-f]{8}-[a-z0-9]{4,32}$/;
export const CAMP_BUNDLE_KIND = 'playapal-camp-board';
// Format 2 belongs to the posts+notes envelope on the integration branch.
// Format 3 adds qualified reply identity (`ref_writer_id`) without guessing
// between two incompatible format-2 MAC layouts.
export const CAMP_BUNDLE_FORMAT = 3;
const SUPPORTED_CAMP_BUNDLE_FORMATS = new Set([1, 2, CAMP_BUNDLE_FORMAT]);

export const CAMP_WRITER_ID_KEY = 'camp_writer_id';
export const CAMP_AUTHOR_NAME_KEY = 'camp_author_name';
export const CAMP_PASSPHRASE_KEY = 'camp_passphrase';
export const CAMP_OWN_SEQ_KEY = 'camp_own_seq';
export const CAMP_INCARNATION_KEY = 'camp_incarnation';
const CAMP_BUNDLE_FORMAT_KEY = 'camp_bundle_format';

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
  /** Qualified reply target. Null only for roots and legacy unqualified beams. */
  ref_writer_id: string | null;
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

/**
 * Strip control characters from typed text: keeps the canonical envelope
 * serialization unambiguous (separators are \n and \u001f) and keeps pasted
 * junk from breaking one-line rows.
 */

const validWireScalar = (
  value: string,
  max: number,
  allowEmpty = false,
): boolean =>
  (allowEmpty || value.length > 0) &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex -- separators make canonical rows ambiguous
  !/[\u0000-\u001f\u007f]/.test(value);

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

/** Data-backed board provenance. A manifest id merely beginning with the board
 * prefix is not authoritative and must retain its ordinary document chunks. */
export function isCampBoardPack(
  conn: QuickSQLiteConnection,
  packId: string,
): boolean {
  const rows = conn.execute(
    `SELECT pack_id FROM camp_posts WHERE pack_id = ?
     UNION ALL SELECT pack_id FROM camp_forks WHERE pack_id = ? LIMIT 1`,
    [packId, packId],
  );
  const ownWriter = kvGet(conn, CAMP_WRITER_ID_KEY);
  const passphrase = kvGet(conn, CAMP_PASSPHRASE_KEY) ?? '';
  if (
    rows.rows?.length ||
    (ownWriter &&
      packId === boardPackId(passphrase ? campIdFor(passphrase) : '', ownWriter))
  ) {
    return true;
  }
  const writers = (conn.execute(
    'SELECT camp_id, writer_id FROM camp_writers',
  ).rows?._array ?? []) as { camp_id: string; writer_id: string }[];
  return writers.some(w => boardPackId(w.camp_id, w.writer_id) === packId);
}

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

/**
 * A sealed-payload format change is an own-payload mutation. Advance the
 * writer sequence exactly once so peers never see equal-seq/different-hash as
 * a fork merely because this phone upgraded.
 */
export function migrateCampBundleFormat(conn: QuickSQLiteConnection): void {
  const stored = Number(kvGet(conn, CAMP_BUNDLE_FORMAT_KEY) ?? 1);
  if (stored >= CAMP_BUNDLE_FORMAT) {
    return;
  }
  inTransaction(conn, () => {
    const writerId = kvGet(conn, CAMP_WRITER_ID_KEY);
    if (writerId) {
      // Formats 1/2 identified a reply only by root id. Qualify every OWN
      // legacy reply before this phone starts sealing format 3; foreign rows
      // remain byte-for-byte governed by their stored legacy envelopes.
      const replies = conn.execute(
        `SELECT pack_id, id, camp_id, ref_id FROM camp_posts
         WHERE writer_id = ? AND ref_id IS NOT NULL AND ref_writer_id IS NULL`,
        [writerId],
      ).rows?._array ?? [];
      for (const reply of replies as {
        pack_id: string;
        id: string;
        camp_id: string;
        ref_id: string;
      }[]) {
        const roots = conn.execute(
          `SELECT DISTINCT writer_id FROM camp_posts
           WHERE camp_id = ? AND id = ? AND ref_id IS NULL`,
          [reply.camp_id, reply.ref_id],
        );
        if (roots.rows?.length === 1) {
          conn.execute(
            'UPDATE camp_posts SET ref_writer_id = ? WHERE pack_id = ? AND id = ?',
            [String(roots.rows.item(0).writer_id), reply.pack_id, reply.id],
          );
        } else {
          // A dangling/ambiguous legacy reply has no truthful format-3 target
          // and was already unrenderable. Retire it rather than emit a beam
          // every format-3 receiver must reject in full.
          conn.execute('DELETE FROM camp_posts WHERE pack_id = ? AND id = ?', [
            reply.pack_id,
            reply.id,
          ]);
        }
      }
      bumpOwnSeq(conn);
    }
    kvSet(conn, CAMP_BUNDLE_FORMAT_KEY, String(CAMP_BUNDLE_FORMAT));
  });
}

export interface CampPostInput {
  /** Present = edit that own row; absent = new post. */
  id?: string;
  type: CampPostType;
  text: string;
  /** Present = this is a reply to that item. */
  ref_id?: string | null;
  /** Required with ref_id for new replies: the target root's writer. */
  ref_writer_id?: string | null;
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
  if (input.id && !prev) {
    throw new CampBeamError('That post is no longer on this board.');
  }
  if (!prev) {
    const count = conn.execute(
      'SELECT COUNT(*) AS n FROM camp_posts WHERE pack_id = ?',
      [packId],
    );
    if (Number(count.rows?.item(0).n ?? 0) >= MAX_POSTS_PER_WRITER) {
      throw new CampBeamError(
        `This phone already holds ${MAX_POSTS_PER_WRITER} board posts — mark some done and remove them before adding more.`,
      );
    }
  }
  const refId = input.ref_id ? String(input.ref_id) : prev ? prev.ref_id : null;
  let refWriterId = input.ref_writer_id
    ? String(input.ref_writer_id)
    : prev
    ? prev.ref_writer_id
    : null;
  if (!refId && refWriterId) {
    throw new CampBeamError('A root post cannot carry reply target identity.');
  }
  if (refId && !refWriterId) {
    const targets = conn.execute(
      `SELECT DISTINCT writer_id FROM camp_posts
       WHERE camp_id = ? AND id = ? AND ref_id IS NULL`,
      [identity.campId, refId],
    );
    if (targets.rows?.length !== 1) {
      throw new CampBeamError('That reply target is missing or ambiguous.');
    }
    refWriterId = String(targets.rows.item(0).writer_id);
  }
  if (refId) {
    const target = conn.execute(
      `SELECT 1 FROM camp_posts WHERE camp_id = ? AND writer_id = ?
       AND id = ? AND ref_id IS NULL LIMIT 1`,
      [identity.campId, refWriterId, refId],
    );
    if (!target.rows?.length) {
      throw new CampBeamError('That reply target is no longer in this camp.');
    }
  }
  const row: CampPost = {
    id: input.id ?? `p-${Date.now().toString(36)}-${randHex(4)}`,
    writer_id: identity.writerId,
    author_name: identity.authorName,
    type: asType(input.type),
    text,
    ref_id: refId,
    ref_writer_id: refWriterId,
    // Edits keep the original timestamp: age reflects when the statement
    // entered the board, and the fresh-window is not resettable by editing.
    created_at: prev ? prev.created_at : new Date().toISOString(),
    done: prev ? prev.done === 1 : false,
  };
  inTransaction(conn, () => {
    const values = [
      row.id,
      packId,
      identity.campId,
      row.writer_id,
      row.author_name,
      row.type,
      row.text,
      row.ref_id,
      row.ref_writer_id,
      row.created_at,
      row.done ? 1 : 0,
    ];
    conn.execute(
      prev
        ? `UPDATE camp_posts SET pack_id = ?, camp_id = ?, writer_id = ?,
             author_name = ?, type = ?, text = ?, ref_id = ?, ref_writer_id = ?,
             created_at = ?, done = ? WHERE id = ? AND pack_id = ?`
        : `INSERT INTO camp_posts
             (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id,
              ref_writer_id, created_at, done)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      prev ? [...values.slice(1), row.id, packId] : values,
    );
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
    if (identity.passphrase) {
      exportCampBundle(conn);
    }
  });
  return row;
}

/** Author-only done/reopen — the superseding statement, still beamed. */
export function setPostDone(
  conn: QuickSQLiteConnection,
  id: string,
  done: boolean,
): void {
  const packId = ownBoardPackId(conn);
  const row = conn.execute(
    'SELECT 1 FROM camp_posts WHERE pack_id = ? AND id = ? LIMIT 1',
    [packId, id],
  );
  if (!row.rows?.length) {
    throw new CampBeamError('That post is no longer on this board.');
  }
  inTransaction(conn, () => {
    conn.execute('UPDATE camp_posts SET done = ? WHERE pack_id = ? AND id = ?', [
      done ? 1 : 0,
      packId,
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
      // Age is local storage policy, not writer ownership: prune every aged
      // row. Only own-row deletion changes a payload this phone can seal, so
      // only that subset advances the local writer sequence.
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
    // Reply identity is qualified by writer — but ONLY THIS INSTALLATION'S
    // OWN replies retarget. A foreign campmate's reply naming our old
    // writer rides inside THEIR sealed envelope: rewriting our stored copy
    // makes local materialization disagree with what we relay onward, and
    // a later equal-seq beam of their envelope cannot heal the fork
    // (review batch 4.2). The old->new aliasing for foreign replies is a
    // PROJECTION concern (aliasReplyTarget), never a mutation of canonical
    // rows we do not author. MUST run before the pack loop rewrites own
    // rows' writer_id, or the own-rows predicate matches nothing.
    conn.execute(
      'UPDATE camp_posts SET ref_writer_id = ? WHERE ref_writer_id = ? AND writer_id = ?',
      [newWriter, oldWriter, oldWriter],
    );
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
    kvSet(conn, `camp_writer_alias_${oldWriter}`, newWriter);
    // THE HIGH-WATER OF MY OWN PAST (binding re-review): the alias alone
    // cannot tell "my pre-rotation envelope relayed back to me" from "the
    // ORIGINAL phone, still alive, still holding that writer id" — and
    // this rotation exists precisely because BOTH devices are real. Left
    // undistinguished, my C6 own-copy check silently dropped or forked
    // every beam the living original ever sent, forever. The seq I held
    // when I rotated is the line: at or below it is my past, above it is
    // the other phone moving on without me, which is an ordinary
    // campmate. Written BEFORE the bump so it names the last seq that was
    // genuinely mine.
    kvSet(
      conn,
      `camp_writer_alias_seq_${oldWriter}`,
      String(getOwnSeq(conn)),
    );
    // NOTES DO NOT ROTATE. The note id is a global PK carrying its origin
    // prefix, and both the original phone and a restored clone can hold
    // the same ids: rewriting writer_id here made the pair beam the SAME
    // note id under DIFFERENT writers, and the second import died on the
    // PK and rolled the whole beam back (review batch 2.4). Inherited
    // notes stay under the origin writer — read-only history; corrections
    // mint a NEW id under the new writer with `supersedes` pointing back.
    kvSet(conn, CAMP_WRITER_ID_KEY, newWriter);
    kvSet(conn, CAMP_INCARNATION_KEY, token);
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
    return { token, rotated: true };
  });
}

// ---------------------------------------------------------------------------
// Materialization (what the Angel reads) — open roots from enabled packs with
// open replies from enabled replier packs inlined. Replies live in the
// REPLIER's pack, so any board mutation, toggle, or removal rematerializes all
// board packs (cheap at camp scale) to keep cross-pack threads retractable.
// ---------------------------------------------------------------------------

interface PostRow extends Omit<CampPost, 'done'> {
  pack_id: string;
  camp_id: string;
  done: number;
}

/**
 * EVERY writer this phone carries for a camp, from BOTH stores (review
 * batches 2.5 + 4.4): sealed envelopes (camp_writers) and mesh-gossiped
 * posts (camp_posts) each admit writers the other cannot see, so a door
 * that counts only its own store lets the union grow past the
 * 63-campmate contract — 63 sealed + 63 gossip-only was admissible.
 * One helper, both doors.
 */
const knownWriterUnion = (
  conn: QuickSQLiteConnection,
  campId: string,
  ownWriterId: string,
): Set<string> => {
  const out = new Set<string>();
  const sealed = conn.execute(
    'SELECT writer_id FROM camp_writers WHERE camp_id = ?',
    [campId],
  ).rows?._array ?? [];
  for (const r of sealed as { writer_id: string }[]) {
    out.add(r.writer_id);
  }
  const gossiped = conn.execute(
    `SELECT DISTINCT writer_id FROM camp_posts
     WHERE camp_id = ? AND pack_id NOT LIKE '%-fork-%'`,
    [campId],
  ).rows?._array ?? [];
  for (const r of gossiped as { writer_id: string }[]) {
    out.add(r.writer_id);
  }
  out.delete(ownWriterId);
  return out;
};

const enabledBoardRows = (conn: QuickSQLiteConnection): PostRow[] => {
  const campId = getCampIdentity(conn).campId;
  const rows = (conn.execute(
    `SELECT cp.* FROM camp_posts cp
     JOIN packs p ON p.id = cp.pack_id AND p.enabled = 1
     WHERE cp.camp_id = ? ORDER BY cp.created_at, cp.id`,
    [campId],
  ).rows?._array ?? []) as PostRow[];
  return rows.map(r => aliasReplyTarget(conn, r));
};

/**
 * Incarnation aliasing AT PROJECTION (review batch 4.2): a foreign
 * campmate's reply naming our pre-rotation writer keeps its canonical row
 * untouched — that row is THEIR sealed content — and resolves to the new
 * writer only when read, so threads stay whole locally while relays carry
 * the authenticated original. The alias map is tiny (one entry per
 * rotation this phone has performed).
 */
/** Follow the rotation-alias chain to its LIVE end (binding review C9): a
 * second incarnation rotation writes old2→new2 while old1 still points at
 * old2, so a single lookup left every reply naming old1 pointing at a dead
 * writer and its thread silently vanished. Hop-capped: the chain grows one
 * link per rotation this phone performed; a cycle (impossible via randHex,
 * but corruption exists) exits at the cap instead of spinning. */
const resolveWriterAlias = (
  conn: QuickSQLiteConnection,
  writerId: string,
): string => {
  // Cycle-detected, not hop-capped (codex closure rider on C9): the chain
  // grows one link per rotation and nothing bounds a phone's lifetime
  // rotations at any particular number — a cap would silently return a
  // dead intermediate id on rotation N+1 and reopen the own-copy
  // recognition hole. A repeat visit is the only true stop.
  const seen = new Set<string>([writerId]);
  let current = writerId;
  for (;;) {
    const next = kvGet(conn, `camp_writer_alias_${current}`);
    if (!next || seen.has(next)) {
      return current;
    }
    seen.add(next);
    current = next;
  }
};

const aliasReplyTarget = <T extends { ref_writer_id?: string | null }>(
  conn: QuickSQLiteConnection,
  row: T,
): T => {
  if (!row.ref_writer_id) {
    return row;
  }
  const aliased = resolveWriterAlias(conn, row.ref_writer_id);
  return aliased !== row.ref_writer_id
    ? { ...row, ref_writer_id: aliased }
    : row;
};

const replyMatches = (reply: PostRow | BoardPost, root: PostRow | BoardPost): boolean => {
  if (reply.ref_id !== root.id) {
    return false;
  }
  if (reply.ref_writer_id) {
    return reply.ref_writer_id === root.writer_id;
  }
  return false;
};


/**
 * Idempotent startup reconciliation (upgrade migration, audit 2026-08-20):
 * a phone that switched camps BEFORE projection-gating shipped may still
 * hold enabled old-camp note projections and board chunks. Run the same
 * sweep saveCampProfile now performs, against the current identity.
 */
/**
 * A GHOST OF ME, left by a build that could not recognise its own past
 * (binding re-review): before the alias check, a rotated phone that
 * re-imported its own relayed envelope stored itself as a foreign
 * campmate — duplicating its board, re-exporting itself forever, and
 * arming the removal amplifier on a pack that is not really a campmate's.
 * The import-time cure cannot help a database that ALREADY holds the
 * ghost, so startup retires any camp_writers row whose writer id
 * alias-resolves to this phone, with its pack, posts and projections.
 * Bounded by the alias map (one entry per rotation this phone performed),
 * so a phone that never rotated does no work at all.
 */
function retireSelfGhostWriters(
  conn: QuickSQLiteConnection,
  campId: string,
): void {
  const me = getCampIdentity(conn).writerId;
  const rows = (conn.execute(
    'SELECT writer_id FROM camp_writers WHERE camp_id = ?',
    [campId],
  ).rows?._array ?? []) as { writer_id: string }[];
  const ghosts = rows
    .map(r => r.writer_id)
    .filter(w => w !== me && resolveWriterAlias(conn, w) === me);
  if (ghosts.length === 0) {
    return;
  }
  inTransaction(conn, () => {
    for (const ghost of ghosts) {
      const packId = boardPackId(campId, ghost);
      conn.execute('DELETE FROM camp_posts WHERE pack_id = ?', [packId]);
      conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [packId]);
      conn.execute('DELETE FROM packs WHERE id = ?', [packId]);
      conn.execute(
        'DELETE FROM camp_writers WHERE camp_id = ? AND writer_id = ?',
        [campId, ghost],
      );
    }
  });
}

export function reconcileCampProjections(conn: QuickSQLiteConnection): void {
  const campId = getCampIdentity(conn).campId;
  retireSelfGhostWriters(conn, campId);
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
  const rows = enabledBoardRows(conn);
  const packIds = new Set<string>(
    ((conn.execute(
      `SELECT DISTINCT pack_id FROM camp_posts
       UNION SELECT DISTINCT pack_id FROM camp_forks`,
    ).rows?._array ?? []) as { pack_id: string }[]).map(r => r.pack_id),
  );
  const writers = (conn.execute(
    'SELECT camp_id, writer_id FROM camp_writers',
  ).rows?._array ?? []) as { camp_id: string; writer_id: string }[];
  for (const writer of writers) {
    packIds.add(boardPackId(writer.camp_id, writer.writer_id));
  }
  packIds.add(ownBoardPackId(conn));
  const rootsByPack = new Map<string, PostRow[]>();
  const repliesByTargetId = new Map<string, PostRow[]>();
  const legacyTargets = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.camp_id}${row.ref_id ?? row.id}`;
    if (row.ref_id) {
      if (row.done === 0) {
        const replies = repliesByTargetId.get(key) ?? [];
        replies.push(row);
        repliesByTargetId.set(key, replies);
      }
      continue;
    }
    legacyTargets.set(key, (legacyTargets.get(key) ?? 0) + 1);
    if (row.done === 0) {
      const roots = rootsByPack.get(row.pack_id) ?? [];
      roots.push(row);
      rootsByPack.set(row.pack_id, roots);
    }
  }
  const typeWord: Record<CampPostType, string> = {
    offer: 'offering',
    need: 'need',
  };
  for (const packId of packIds) {
    conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [packId]);
    const own = rootsByPack.get(packId) ?? [];
    const byType = new Map<CampPostType, string[]>();
    let author = '';
    for (const post of own) {
      author = post.author_name;
      const thread = [
        `${typeWord[asType(post.type)]}: ${post.text} (${displayName(post.author_name)})`,
        ...(repliesByTargetId.get(`${post.camp_id}${post.id}`) ?? [])
          .filter(
            reply =>
              // A CANONICAL root shows every reply — its own unmarked,
              // a conflicted copy's MARKED (silent inlining fed the Angel
              // fork text as camp fact; full exclusion vanished a
              // reply-only fork, and the contract says both versions are
              // SHOWN). A FORK root's thread stays PACK-LOCAL: admitting
              // other packs' replies blurred two forks into a third,
              // invented version (binding review C8 + closure riders).
              (packId.includes('-fork-')
                ? reply.pack_id === packId
                : true) &&
              (replyMatches(reply, post) ||
                (!reply.ref_writer_id &&
                  legacyTargets.get(`${post.camp_id}${post.id}`) === 1)),
          )
          // A fork carries byte-identical copies of the writer's OTHER,
          // unchanged replies, so a conflicted copy whose divergence lay
          // elsewhere printed every untouched reply TWICE — once plain,
          // once marked (binding re-review). A fork copy is only worth
          // showing where it actually DIFFERS from the canonical row of
          // the same id.
          .filter((reply, _i, all) =>
            !reply.pack_id.includes('-fork-') ||
            !all.some(other =>
              !other.pack_id.includes('-fork-') &&
              other.id === reply.id &&
              other.text === reply.text,
            ),
          )
          .map(reply =>
            reply.pack_id.includes('-fork-') && !packId.includes('-fork-')
              ? `  reply (conflicted copy — see the board's conflicted packs): ${reply.text} (${displayName(reply.author_name)})`
              : `  reply: ${reply.text} (${displayName(reply.author_name)})`,
          ),
      ];
      const t = asType(post.type);
      const entries = byType.get(t) ?? [];
      entries.push(thread.join('\n'));
      byType.set(t, entries);
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
  // Fork NOTES ride the same rebuild (review batch 4.1): every fork pack's
  // chunks were swept above, so an enabled fork re-projects its envelope's
  // notes here and a removed/disabled one rebuilds nothing — removal and
  // re-import idempotence are the camp_forks row's own lifecycle. A
  // damaged envelope_json skips silently: the fork's POSTS were installed
  // from the verified beam at import time and remain surfaced.
  const forks = (conn.execute(
    // Camp-scoped like every sibling projection (binding review C7): a
    // conflicted copy imported in a camp this phone has LEFT must not
    // keep its notes retrievable in the new camp — the set-aside promise
    // covers forks too. The sweep above already deleted the old camp's
    // chunks; scoping the rebuild is what keeps them gone.
    `SELECT cf.pack_id, cf.writer_id, cf.envelope_json FROM camp_forks cf
     JOIN packs p ON p.id = cf.pack_id AND p.enabled = 1
     WHERE cf.camp_id = ?`,
    [getCampIdentity(conn).campId],
  ).rows?._array ?? []) as {
    pack_id: string;
    writer_id: string;
    envelope_json: string;
  }[];
  for (const fork of forks) {
    try {
      const env = JSON.parse(fork.envelope_json) as CampEnvelope;
      const notes = parseWireNotes(
        env.notes,
        fork.writer_id,
        displayName(env.author_name),
      );
      projectForkNotes(conn, fork.pack_id, notes);
    } catch {
      // unparseable stored envelope — posts-only fork surface stands
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
  const rows = ((res.rows?._array ?? []) as PostRow[]).map(r =>
    aliasReplyTarget(conn, r),
  );
  return rows.map(r => ({
    id: r.id,
    writer_id: r.writer_id,
    author_name: r.author_name,
    type: asType(r.type),
    text: r.text,
    ref_id: r.ref_id ?? null,
    ref_writer_id: r.ref_writer_id ?? null,
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
  const replies = posts.filter(p => p.ref_id && !p.done);
  const roots = posts.filter(p => !p.ref_id);
  const legacyTargets = new Map<string, number>();
  for (const root of roots) {
    legacyTargets.set(root.id, (legacyTargets.get(root.id) ?? 0) + 1);
  }
  const items = roots.filter(
    p => !opts.freshOnly || isFresh(p.created_at, now),
  );
  const sections: BoardSection[] = [];
  for (const t of ['offer', 'need'] as CampPostType[]) {
    const mine = items.filter(i => i.type === t);
    const open = mine.filter(i => !i.done);
    const done = mine.filter(i => i.done);
    const threads = [...open, ...done].map(post => {
      const thread = replies
        .filter(
          r =>
            // Same fork discipline as the chunk materializer (binding
            // review C8 + riders): a fork root's thread is pack-local; a
            // canonical root shows every reply and the UI badges the
            // conflicted ones via r.fork.
            (post.fork ? r.pack_id === post.pack_id : true) &&
            (replyMatches(r, post) ||
              (!r.ref_writer_id &&
                r.ref_id === post.id &&
                legacyTargets.get(post.id) === 1)),
        )
        // Same de-duplication as the chunk materializer: an unchanged
        // reply carried by a fork is the SAME statement, not a second one.
        .filter((r, _i, all) =>
          !r.fork ||
          !all.some(other => !other.fork && other.id === r.id && other.text === r.text),
        )
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

type CampWirePost = Omit<CampPost, 'ref_writer_id'> & {
  /** Present only in format 3+. */
  ref_writer_id?: string | null;
};

export interface CampEnvelope {
  /** The format this envelope was SEALED under (1 = posts only,
   * 2 = posts+notes, 3 = posts+notes with qualified reply identity). */
  format: number;
  camp_id: string;
  writer_id: string;
  author_name: string;
  key_id: string;
  seq: number;
  payload_hash: string;
  posts: CampWirePost[];
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
const canonicalPosts = (
  posts: readonly CampWirePost[],
  format = CAMP_BUNDLE_FORMAT,
): string => {
  const qualified = format >= 3;
  return posts
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(p =>
      [
        p.id,
        p.ref_id ?? '',
        ...(qualified ? [p.ref_writer_id ?? ''] : []),
        p.type,
        p.text,
        p.author_name,
        p.created_at,
        p.done ? '1' : '0',
      ].join('\u001f'),
    )
    .join('\n');
};

/** One strict canonical payload per format: v1 posts; v2+ posts and notes. */
const canonicalPayload = (
  format: number,
  posts: readonly CampWirePost[],
  notes: readonly WireNote[],
): string =>
  format >= 2
    ? `${canonicalPosts(posts, format)}\n${canonicalNotes(notes)}`
    : canonicalPosts(posts, format);

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
    ref_writer_id: r.ref_writer_id ?? null,
    created_at: r.created_at,
    done: r.done === 1,
  }));
};

/** Preserve the notes train when this diff is rebased onto a note-capable DB. */
const hasCampNotes = (conn: QuickSQLiteConnection): boolean =>
  Boolean(
    conn.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'camp_notes'",
    ).rows?.length,
  );

/** Hydrate a newly added notes table from already verified high-water envelopes.
 * Without this upgrade bridge, a format-2 beam accepted by a pre-notes build is
 * forever classified unchanged after upgrade and its notes never materialize. */
export function hydrateStoredCampNotes(conn: QuickSQLiteConnection): void {
  const stamp = 'camp_notes_envelope_hydration_version';
  if (!hasCampNotes(conn) || kvGet(conn, stamp) === '1') {
    return;
  }
  const stored = conn.execute(
    'SELECT writer_id, author_name, envelope_json FROM camp_writers',
  ).rows?._array ?? [];
  inTransaction(conn, () => {
    for (const row of stored as {
      writer_id: string;
      author_name: string;
      envelope_json: string;
    }[]) {
      const env = JSON.parse(row.envelope_json) as CampEnvelope;
      if (Number(env.format ?? 1) < 2 || !Array.isArray(env.notes)) {
        continue;
      }
      // Owner-layer write (the shim is retired): by the time hydrate runs,
      // initDb has created camp_notes and applied the additive columns, so
      // the shim's existence guards guarded nothing real any more.
      replaceWriterNotes(
        conn,
        env.camp_id,
        row.writer_id,
        parseWireNotes(env.notes, row.writer_id, row.author_name),
      );
    }
    kvSet(conn, stamp, '1');
  });
}

function buildOwnEnvelope(conn: QuickSQLiteConnection): CampEnvelope {
  const identity = getCampIdentity(conn);
  const posts = ownPostRows(conn);
  // The campNotes OWNER LAYER seals the notes — the campWireNotes shim is
  // replaced per the integration contract, so imports/deletions and the
  // Angel/Now projections share one write path and one change signal.
  const notes = ownWireNoteRows(conn, identity.campId, identity.writerId);
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
/** The WIRE admits more than authoring mints (review batch 2.3): the
 * author cap tightened to 500 while interim builds sealed snapshots of up
 * to 2000 posts, and a receiver that refuses a legally-sealed envelope
 * strands a campmate's whole board. Authoring keeps the tight cap; the
 * door honors what the format ever allowed. */
export const WIRE_MAX_POSTS_PER_ENVELOPE = 2000;

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
  // Strict fixed-set acceptance (integration contract): v1, v2, v3 — no
  // dual-v2 guessing, no try-both verification. Anything past the set from
  // a well-formed bundle is a future format.
  if (!SUPPORTED_CAMP_BUNDLE_FORMATS.has(bundle.format)) {
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
  if (bundle.camp_id !== identity.campId) {
    throw new CampBeamError(
      'This beam is from a different camp (its passphrase does not match yours) — nothing was imported.',
    );
  }
  // CAMP IDENTITY BEFORE CAPACITY (binding review C11): a near-capacity
  // phone handed a beam from a DIFFERENT camp used to be told to delete a
  // campmate's board — the wrong-passphrase answer is the true one and
  // must win whatever the store's size.
  {
    // The durable camp-capacity contract: a phone holds its own board plus
    // at most MAX_BEAM_ENVELOPES - 1 campmates' — refusing here keeps the
    // stored camp bounded at the source. (Export independently sheds to a
    // fresh receiver's capacity, so an overfull legacy store would still
    // emit an importable beam with named shedding — this gate is about the
    // camp's size, not about rescuing export. Both sites spell the 63 as
    // MAX_BEAM_ENVELOPES - 1; if a third appears, derive a shared constant.)
    const known = knownWriterUnion(conn, bundle.camp_id, identity.writerId);
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
  if (
    !Array.isArray(bundle.envelopes) ||
    bundle.envelopes.length === 0 ||
    bundle.envelopes.length > MAX_BEAM_ENVELOPES
  ) {
    throw new CampBeamError('This camp beam looks damaged and cannot be imported.');
  }

  // ---- Verify every envelope BEFORE any write. --------------------------
  const key = sealKey(identity.passphrase);
  const byWriter = new Map<string, VerifiedEnvelope[]>();
  for (const raw of bundle.envelopes) {
    const writerId = String(raw?.writer_id ?? '');
    const seq = Number(raw?.seq);
    // An envelope without its own format is a v1 snapshot, even when a newer
    // phone relays it verbatim inside a v3 bundle.
    const format = raw?.format == null ? 1 : Number(raw.format);
    if (
      !WRITER_ID_RE.test(writerId) ||
      !SUPPORTED_CAMP_BUNDLE_FORMATS.has(format) ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      raw.camp_id !== bundle.camp_id ||
      typeof raw.tag !== 'string' ||
      typeof raw.payload_hash !== 'string' ||
      !Array.isArray(raw.posts) ||
      raw.posts.length > WIRE_MAX_POSTS_PER_ENVELOPE ||
      (format >= 2 && !Array.isArray(raw.notes))
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
      ref_writer_id:
        format >= 3 && p?.ref_writer_id ? String(p.ref_writer_id) : null,
      created_at: String(p?.created_at ?? ''),
      done: p?.done === true || p?.done === 1,
    }));
    if (
      posts.some(
        p =>
          !validWireScalar(p.id, 128) ||
          !validWireScalar(p.text, POST_TEXT_MAX) ||
          !validWireScalar(p.created_at, 64) ||
          (p.ref_id !== null && !validWireScalar(p.ref_id, 128)) ||
          (p.ref_writer_id !== null && !WRITER_ID_RE.test(p.ref_writer_id)) ||
          (!p.ref_id && p.ref_writer_id !== null) ||
          (format >= 3 && Boolean(p.ref_id) !== Boolean(p.ref_writer_id)),
      )
    ) {
      throw new CampBeamError(
        'This camp beam looks damaged and cannot be imported.',
      );
    }
    const wirePosts: CampWirePost[] = posts.map(post => {
      if (format >= 3) {
        return post;
      }
      return {
        id: post.id,
        writer_id: post.writer_id,
        author_name: post.author_name,
        type: post.type,
        text: post.text,
        ref_id: post.ref_id,
        created_at: post.created_at,
        done: post.done,
      };
    });
    let notes: WireNote[] = [];
    if (format >= 2) {
      try {
        notes = parseWireNotes(raw.notes, writerId, authorName);
      } catch {
        throw new CampBeamError(
          'This camp beam looks damaged and cannot be imported.',
        );
      }
    }
    const canonical = canonicalPayload(format, wirePosts, notes);
    const head = {
      format,
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
    list.push({
      env: { ...head, posts: wirePosts, notes, tag: raw.tag },
      posts,
      notes,
    });
    byWriter.set(writerId, list);
  }

  // Import closure: every accepted durable writer set must still fit when this
  // phone prepends its own envelope for the next multi-hop relay.
  const knownWriters = new Set<string>([identity.writerId, ...byWriter.keys()]);
  const storedWriters = conn.execute(
    'SELECT writer_id FROM camp_writers WHERE camp_id = ?',
    [bundle.camp_id],
  ).rows?._array ?? [];
  for (const row of storedWriters as { writer_id: string }[]) {
    knownWriters.add(row.writer_id);
  }
  if (knownWriters.size > MAX_BEAM_ENVELOPES) {
    throw new CampBeamError(
      'This camp beam would leave too many writers to relay — remove old camp-board packs, then import again.',
    );
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
           (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, ref_writer_id, created_at, done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          packId,
          bundle.camp_id,
          p.writer_id,
          p.author_name,
          p.type,
          p.text,
          p.ref_id,
          p.ref_writer_id,
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
    // notes: a conflicted copy surfaces through its board pack only. The
    // campNotes OWNER LAYER does the write (contract: the campWireNotes
    // shim is replaced), so imports refresh the Angel/Now projections
    // through the same rematerialize + change signal as local edits.
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
           (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, ref_writer_id, created_at, done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          packId,
          bundle.camp_id,
          p.writer_id,
          p.author_name,
          p.type,
          p.text,
          p.ref_id,
          p.ref_writer_id,
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
      `INSERT INTO camp_forks
         (camp_id, writer_id, seq, payload_hash, pack_id, envelope_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        bundle.camp_id,
        v.env.writer_id,
        v.env.seq,
        v.env.payload_hash,
        packId,
        JSON.stringify(v.env),
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

      // A pre-rotation envelope of MINE is my own past only while its seq
      // is at or below the high-water I held when I rotated; anything
      // newer is the still-living original phone and is a campmate like
      // any other (binding re-review — the alias alone blinded a restored
      // clone to the original forever).
      const aliasedToMe =
        writerId !== identity.writerId &&
        resolveWriterAlias(conn, writerId) === identity.writerId;
      const myPastHighWater = aliasedToMe
        ? Number(kvGet(conn, `camp_writer_alias_seq_${writerId}`) ?? '')
        : NaN;
      const isMyOwnPast =
        aliasedToMe &&
        Number.isFinite(myPastHighWater) &&
        top.every(v => v.env.seq <= myPastHighWater);
      if (writerId === identity.writerId || isMyOwnPast) {
        // A copy of THIS writer. Never installable: older/equal-same is
        // noise; anything else is a cloned/forked "me" — surface it, never
        // touch the live board.
        const ownSeq = getOwnSeq(conn);
        const ownHash = sha256Hex(
          canonicalPayload(
            CAMP_BUNDLE_FORMAT,
            ownPostRows(conn),
            ownWireNoteRows(conn, identity.campId, identity.writerId),
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
    if (result.installed.length > 0) {
      // Accepted state must remain exportable: enforce the same byte and writer
      // limits before the transaction commits, not when this phone next beams.
      exportCampBundle(conn);
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
// Mesh in: single posts that rode the pod gossip mesh (src/crews/boardRecords.ts)
//
// The BEAM above moves a sealed SNAPSHOT of a whole writer's board. The mesh
// moves one post at a time, unsealed, over whatever pod the two phones share.
// Both end up writing the SAME row — (pack_id, id) — which is what makes a
// post that arrives twice render once. What the mesh must never do is speak
// for a snapshot it does not carry, so nothing below touches camp_writers,
// camp_forks or the seal: the high-water stays the beam's word alone.
//
// A POD CODE AND A CAMP PASSPHRASE ARE DIFFERENT TRUST CIRCLES. The pod is
// who carries the bytes; the passphrase is who the board belongs to. The
// sealed-envelope check still applies on every beam import, unchanged, and a
// gossiped row is never re-exported under this phone's seal (exports read
// own rows + stored VERIFIED envelopes, and a gossiped row is neither).
// ---------------------------------------------------------------------------

/** What the mesh publisher needs to say who it is and what it holds. */
export function ownBoardSnapshot(conn: QuickSQLiteConnection): {
  seq: number;
  posts: CampPost[];
} {
  return { seq: getOwnSeq(conn), posts: ownPostRows(conn) };
}

/** One board post that arrived over a pod rather than in a sealed beam. */
export interface GossipedPost {
  /** The camp the author wrote it under — must be this phone's. */
  campId: string;
  /** The author's board writer id (NOT their friend-card id: the gossip
   * record's own identity is minted from a card, and a card has nothing to
   * do with a board writer — see boardRecords.ts decision (b)). */
  writerId: string;
  authorName: string;
  /** The author's own_seq this copy is true as of. */
  seq: number;
  post: CampPost;
  /** Deterministic tie-break when two copies claim the same seq. Both ride
   * the wire, so every phone breaks the tie the same way. */
  recordId: string;
  recordMin: number;
}

export interface GossipApplyResult {
  /** Rows written (new or changed). */
  applied: number;
  /** Rows already saying exactly this — the idempotent case. */
  unchanged: number;
  /** Copies beaten by a newer copy of the same post in this batch. */
  superseded: number;
  /** Copies a beamed snapshot already speaks past (seq <= high-water). */
  stale: number;
  /** Copies refused: wrong camp, my own writer, malformed, or over a cap. */
  refused: number;
  /** Copies refused for claiming a revision further ahead than the writer's
   * sealed high-water can vouch for (GOSSIP_SEQ_LOOKAHEAD). A SUBSET of
   * `refused`, counted apart because it is the one refusal that means someone
   * may be minting posts under a campmate's name — and because a post the
   * reader cannot see has to be a post the reader is TOLD about. */
  refusedFuture: number;
  /** Author names whose posts landed. */
  writers: string[];
}

/**
 * HOW FAR AHEAD OF THE SEAL A GOSSIPED REVISION MAY CLAIM TO BE.
 *
 * The mesh proves nothing about authorship (TRUST LABEL above), so the only
 * thing ordering two copies of a post is the writer seq in the body — and the
 * winner of a revision fight is the highest one. Unbounded, that number IS the
 * attack: anyone holding the pod's PIN can relay one post under a campmate's
 * writer id stamped 2^30 and own that post forever, since no real author ever
 * counts that high and even a full beam re-sync only reinstalls a snapshot the
 * forgery still outranks — the self-heal then re-applies it on the next pass.
 * On a board campers read for needs and offers, a permanent forged "we moved,
 * find us at ..." is what that costs.
 *
 * So a gossiped copy may sit at most this far above the writer's last SEALED
 * seq. Three things decided the shape:
 *
 *  - PER WRITER, NOT PER CAMP. Seqs are per-writer counters with nothing in
 *    common between two writers, so a camp-wide ceiling (the camp's highest
 *    high-water + a window) would hand a quiet camper's board the chattiest
 *    camper's number: a forgery minted up there would still outrank
 *    everything its supposed author is ever going to write. One camper's
 *    activity must not be every other camper's security parameter.
 *  - THE ANCHOR IS THE SEAL'S, NEVER THE MESH'S. camp_writers is written by
 *    the beam alone, and a beam is HMAC'd with the camp passphrase — a
 *    circle the pod's PIN does not open. Anchoring instead on the highest seq
 *    the MESH has accepted would build the attacker a ladder: land at
 *    anchor + 500, watch that become the anchor, land at anchor + 1000, and
 *    be back at 2^30 within a few passes. The surface being bounded cannot be
 *    the thing that vouches for it.
 *  - A WRITER THIS PHONE HAS NEVER SEEN: the honest floor is ZERO. At first
 *    contact there is no anchor of any kind — no high-water, no rows, no
 *    envelope — and any generous floor is exactly the headroom a forgery
 *    wants, since a campmate this phone has never beamed with is the easiest
 *    identity to mint under. So a first-contact copy has to fit under the
 *    window itself. THE COST, said plainly rather than discovered in the
 *    dust: an install more than GOSSIP_SEQ_LOOKAHEAD revisions past its own
 *    last sealed snapshot cannot introduce itself to this phone over the
 *    mesh. It is refused out loud (refusedFuture, surfaced under the board),
 *    and ONE beam re-anchors that writer permanently. A burn of heavy use is
 *    on the order of a hundred-odd own-payload revisions, so 500 covers
 *    seasons of a lifetime counter, and — measured from a real high-water —
 *    a week of drift for a phone that has been off the mesh.
 *
 * What this does NOT claim: a copy under the ceiling is still unproven. The
 * window is the whole residue, and it is bounded rather than permanent — the
 * author's own next revisions climb past a forgery, and any beam sealed above
 * it deletes it for good.
 */
export const GOSSIP_SEQ_LOOKAHEAD = 500;

/** Newer wins: the author's revision first, then the record's own mint
 * minute, then its id — all three are on the wire, so this is the same
 * answer on every phone. */
const gossipBeats = (a: GossipedPost, b: GossipedPost): boolean =>
  a.seq !== b.seq
    ? a.seq > b.seq
    : a.recordMin !== b.recordMin
    ? a.recordMin > b.recordMin
    : a.recordId > b.recordId;

/** Everything about a row that a re-import could change. */
/** ONE canonical change-signature over every mutable wire field — the
 * review caught the two post signatures drifting OPPOSITELY (this one had
 * author_name but not ref_writer_id; the mesh rider's had refWriterId but
 * not authorName), so a rename republished here but not there, and a
 * re-qualified reply republished there but not here. */
const postSignature = (p: CampPost): string =>
  [
    p.type,
    p.text,
    p.ref_id ?? '',
    p.ref_writer_id ?? '',
    p.created_at,
    p.done ? '1' : '0',
    p.author_name,
  ].join('\u001f');

/**
 * Take posts the mesh brought in. THE REVISION RULE IS CAMPBOARD'S OWN, so
 * a gossiped edit supersedes exactly like a beamed one:
 *
 *  - within the batch, the copy with the greatest writer seq wins (an edit
 *    bumps the author's seq, so the edited copy is simply the newer record —
 *    nothing is ever mutated in place, here or on the mesh);
 *  - against the stored HIGH-WATER, a copy at or below the writer's beamed
 *    seq is STALE and dropped: that snapshot already spoke for the whole
 *    board at that revision, including this post's absence if the author had
 *    removed it. Only seq > high-water is news.
 *
 * The high-water is deliberately NOT advanced. One post is not a snapshot:
 * claiming the writer's seq from a single row would make their real beam at
 * that seq read as an equal-seq FORK, and would drop every other post in it.
 * The cost of that choice is one honest, self-healing case — an older beam
 * arriving after a newer gossiped post reinstalls the older snapshot, and
 * the next pass re-applies the gossiped copy because it is still above the
 * new high-water.
 */
export function applyGossipedPosts(
  conn: QuickSQLiteConnection,
  incoming: GossipedPost[],
): GossipApplyResult {
  const result: GossipApplyResult = {
    applied: 0,
    unchanged: 0,
    superseded: 0,
    stale: 0,
    refused: 0,
    refusedFuture: 0,
    writers: [],
  };
  const identity = getCampIdentity(conn);
  if (identity.campId.length === 0) {
    // No passphrase, no camp, no audience: a phone with only pre-camp drafts
    // has nowhere to file someone else's camp post.
    result.refused += incoming.length;
    return result;
  }
  // This camp's SEALED high-waters, read once, BEFORE the election below —
  // the ceiling has to refuse a minted copy before it can beat the real one,
  // or a forgery this phone refuses would take the author's post down with it
  // (elected in-batch, then dropped, and the reader keeps neither). The same
  // map is the stale gate's high-water inside the transaction.
  const sealedRes = conn.execute(
    'SELECT writer_id, seq FROM camp_writers WHERE camp_id = ?',
    [identity.campId],
  );
  const highWater = new Map<string, number>(
    ((sealedRes.rows?._array ?? []) as { writer_id: string; seq: number }[]).map(
      r => [r.writer_id, Number(r.seq)] as [string, number],
    ),
  );
  const winners = new Map<string, GossipedPost>();
  for (const g of incoming) {
    const post = g.post;
    if (
      g.campId !== identity.campId ||
      // My own writer id can only ever be an echo of me or an impersonation
      // of me, and my rows are the ones this phone SEALS. The mesh does not
      // get to write into the envelope this phone signs.
      g.writerId === identity.writerId ||
      !WRITER_ID_RE.test(g.writerId) ||
      !Number.isInteger(g.seq) ||
      g.seq < 0 ||
      post.id.length === 0 ||
      post.id.length > 64 ||
      post.text.length === 0 ||
      post.text.length > POST_TEXT_MAX ||
      post.created_at.length === 0
    ) {
      result.refused += 1;
      continue;
    }
    // ...and no further ahead of the seal than the seal can vouch for. A
    // writer with no sealed snapshot on this phone anchors at 0 — the
    // constant's own comment says why that floor is the honest one.
    if (g.seq > (highWater.get(g.writerId) ?? 0) + GOSSIP_SEQ_LOOKAHEAD) {
      result.refusedFuture += 1;
      result.refused += 1;
      continue;
    }
    const key = `${g.writerId}\u001f${post.id}`;
    const held = winners.get(key);
    if (!held) {
      winners.set(key, g);
      continue;
    }
    result.superseded += 1;
    if (gossipBeats(g, held)) {
      winners.set(key, g);
    }
  }
  if (winners.size === 0) {
    return result;
  }
  const byWriter = new Map<string, GossipedPost[]>();
  for (const g of winners.values()) {
    byWriter.set(g.writerId, [...(byWriter.get(g.writerId) ?? []), g]);
  }
  inTransaction(conn, () => {
    // The camp-capacity contract, applied to the mesh door too: a phone
    // holds its own board plus at most MAX_BEAM_ENVELOPES - 1 campmates'.
    // Without this, a pod could fill the store with boards for writer ids
    // nobody in camp has ever met.
    const known = knownWriterUnion(conn, identity.campId, identity.writerId);
    for (const [writerId, group] of byWriter) {
      if (!known.has(writerId) && known.size >= MAX_BEAM_ENVELOPES - 1) {
        result.refused += group.length;
        continue;
      }
      const packId = boardPackId(identity.campId, writerId);
      const hw = highWater.get(writerId) ?? null;
      const existingRes = conn.execute(
        'SELECT * FROM camp_posts WHERE pack_id = ?',
        [packId],
      );
      const existing = new Map<string, string>();
      /** id -> the stored gossip revision, for CROSS-batch supersession:
       * within-batch election alone let a late relay of an OLDER copy
       * reinstall stale text tomorrow (review batch 5). NULL seq = the row
       * came from a sealed beam, which any gossip legitimately advances. */
      const storedRev = new Map<
        string,
        { seq: number | null; min: number; rid: string }
      >();
      for (const r of (existingRes.rows?._array ?? []) as (PostRow & {
        gossip_seq?: number | null;
        gossip_min?: number | null;
        gossip_rid?: string | null;
      })[]) {
        storedRev.set(r.id, {
          seq: r.gossip_seq ?? null,
          min: r.gossip_min ?? 0,
          rid: r.gossip_rid ?? '',
        });
        existing.set(
          r.id,
          postSignature({
            id: r.id,
            writer_id: r.writer_id,
            author_name: r.author_name,
            type: asType(r.type),
            text: r.text,
            ref_id: r.ref_id ?? null,
            ref_writer_id: r.ref_writer_id ?? null,
            created_at: r.created_at,
            done: r.done === 1,
          }),
        );
      }
      let rowCount = existing.size;
      let wrote = 0;
      let author = '';
      for (const g of group) {
        const authorName = clean(g.authorName).slice(0, 24);
        const post: CampPost = {
          id: g.post.id,
          writer_id: writerId,
          author_name: authorName,
          type: asType(g.post.type),
          text: g.post.text,
          ref_id: g.post.ref_id ?? null,
          ref_writer_id: g.post.ref_writer_id ?? null,
          created_at: g.post.created_at,
          done: g.post.done,
        };
        if (hw !== null && g.seq <= hw) {
          result.stale += 1;
          continue;
        }
        const rev = storedRev.get(g.post.id);
        if (rev && rev.seq !== null) {
          // Strictly-older loses; the fully-EQUAL tuple is NOT refused —
          // it is the same record arriving again, which the signature
          // check below counts as the no-op it is (stale would misreport
          // a benign relay echo as a refused rewrite).
          const beats =
            g.seq !== rev.seq
              ? g.seq > rev.seq
              : g.recordMin !== rev.min
              ? g.recordMin > rev.min
              : g.recordId !== rev.rid
              ? g.recordId > rev.rid
              : true;
          if (!beats) {
            result.stale += 1;
            continue;
          }
        }
        const prev = existing.get(post.id);
        if (prev !== undefined && prev === postSignature(post)) {
          result.unchanged += 1;
          continue;
        }
        // The authoring cap, re-enforced against the wire (the beam does the
        // same with its 2000-posts-per-envelope gate): a writer cannot own
        // more of this phone's board through the mesh than through a beam.
        if (prev === undefined && rowCount >= MAX_POSTS_PER_WRITER) {
          result.refused += 1;
          continue;
        }
        conn.execute(
          `INSERT OR REPLACE INTO camp_posts
             (id, pack_id, camp_id, writer_id, author_name, type, text, ref_id, ref_writer_id, created_at, done, gossip_seq, gossip_min, gossip_rid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            post.id,
            packId,
            identity.campId,
            post.writer_id,
            post.author_name,
            post.type,
            post.text,
            post.ref_id,
            post.ref_writer_id,
            post.created_at,
            post.done ? 1 : 0,
            g.seq,
            g.recordMin,
            g.recordId,
          ],
        );
        if (prev === undefined) {
          rowCount += 1;
        }
        author = post.author_name;
        wrote += 1;
      }
      if (wrote === 0) {
        continue;
      }
      known.add(writerId);
      // An unnamed campmate is "a campmate" — NOT displayName's "this
      // phone", which is the own-board fallback and would label someone
      // else's board as this one's. (The beam path passes a foreign
      // envelope's empty name through displayName and does say "this
      // phone"; that is a pre-existing wart in its own right and not this
      // lane's to change under a shipped string.)
      const label = author.length > 0 ? author : 'a campmate';
      // Create the pack row when there is none — listCampBoard joins it, so
      // a writer whose posts have only ever gossiped would otherwise hold
      // rows nothing renders. An EXISTING row is left exactly as it is: a
      // beam install stamps it with the snapshot's seq, and a single post
      // has no business overwriting that.
      const packRow = conn.execute('SELECT id FROM packs WHERE id = ?', [packId]);
      if (!packRow.rows || packRow.rows.length === 0) {
        upsertBoardPackRow(conn, {
          packId,
          name: `Camp board — ${label}`,
          description: `Board posts from ${label}, carried here by your pod. A beam from their phone brings their whole board.`,
          version: 0,
        });
      }
      result.writers.push(label);
      result.applied += wrote;
    }
    if (result.applied > 0) {
      rematerializeAllBoards(conn);
    }
  });
  if (result.refusedFuture > 0) {
    // The other half of "never a silent drop": the caller says it under the
    // board, and the log says it where a dogfood session can count it.
    console.warn(
      '[camp] mesh posts held back — revision beyond the sealed anchor:',
      result.refusedFuture,
    );
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
