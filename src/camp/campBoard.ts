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

export const CAMP_PACK_PREFIX = 'camp-board-';
export const CAMP_BUNDLE_KIND = 'playapal-camp-board';
export const CAMP_BUNDLE_FORMAT = 1;

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
    }
    // The name labels this writer's statements in the CURRENT context only.
    conn.execute('UPDATE camp_posts SET author_name = ? WHERE pack_id = ?', [
      authorName,
      newPack,
    ]);
    bumpOwnSeq(conn);
    refreshOwnPackRowOnly(conn);
    rematerializeAllBoards(conn);
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

export function rematerializeAllBoards(conn: QuickSQLiteConnection): void {
  const rows = allBoardRows(conn);
  const packIdsRes = conn.execute(
    `SELECT id FROM packs WHERE id LIKE '${CAMP_PACK_PREFIX}%'`,
  );
  const packIds = new Set<string>(
    ((packIdsRes.rows?._array ?? []) as { id: string }[]).map(r => r.id),
  );
  for (const r of rows) {
    packIds.add(r.pack_id);
  }
  const replies = rows.filter(r => r.ref_id);
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
        'INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES (?, ?, ?, ?)',
        [
          packId,
          'camp-board',
          `Camp board — ${t === 'offer' ? 'offers' : 'needs'} (${displayName(author)})`,
          entries.join('\n'),
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
  camp_id: string;
  writer_id: string;
  author_name: string;
  key_id: string;
  seq: number;
  payload_hash: string;
  posts: CampPost[];
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

const macMessage = (
  env: Omit<CampEnvelope, 'tag' | 'posts'>,
  canonical: string,
): string =>
  [
    CAMP_BUNDLE_KIND,
    String(CAMP_BUNDLE_FORMAT),
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
  const canonical = canonicalPosts(posts);
  const head = {
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
  const identity = getCampIdentity(conn);
  if (identity.passphrase.length === 0) {
    throw new CampBeamError(
      'Set your camp passphrase first (Camp tab → Camp sync) so campmates can verify this beam came from your camp.',
    );
  }
  const others = (conn.execute(
    'SELECT envelope_json FROM camp_writers WHERE camp_id = ? AND writer_id != ?',
    [identity.campId, identity.writerId],
  ).rows?._array ?? []) as { envelope_json: string }[];
  const bundle: CampBundle = {
    kind: CAMP_BUNDLE_KIND,
    format: CAMP_BUNDLE_FORMAT,
    camp_id: identity.campId,
    envelopes: [
      buildOwnEnvelope(conn),
      ...others.map(o => JSON.parse(o.envelope_json) as CampEnvelope),
    ],
  };
  return JSON.stringify(bundle, null, 1);
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
}

const WRITER_ID_RE = /^[a-z0-9]{4,32}$/;

interface VerifiedEnvelope {
  env: CampEnvelope;
  posts: CampPost[];
}

export function installCampBundle(
  conn: QuickSQLiteConnection,
  text: string,
): CampInstallResult {
  const bundle = parseCampBundle(text);
  if (!bundle) {
    throw new CampBeamError('This file is not a camp-board beam.');
  }
  if (bundle.format !== CAMP_BUNDLE_FORMAT) {
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
    const canonical = canonicalPosts(posts);
    const head = {
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
    list.push({ env: { ...head, posts, tag: raw.tag }, posts });
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
    result.installed.push(author);
    result.posts += v.posts.filter(p => !p.done && !p.ref_id).length;
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
        const ownHash = sha256Hex(canonicalPosts(ownPostRows(conn)));
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
    }
  });
  return result;
}
