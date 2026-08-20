/**
 * "DON'T USE THIS" -- one gesture for anything the Angel showed you that was
 * wrong, and one place to take it back.
 *
 * The UX rule: excluding any particular datapoint must be elegant and
 * lightweight — one gesture, not a menu of per-type verbs.
 * The user long-presses the thing that was wrong -- a person card, an event
 * card, a source passage -- and says "don't use this". The app knows what
 * "this" is and does the right hide. Settings > Hidden lists everything
 * hidden, of every kind, and a tap brings it back.
 *
 * TWO MECHANISMS, ONE VERB. A PERSON is a graph node; hiding one must rebuild
 * the derived person-card index, and factExclusions.ts already does that
 * correctly -- it is not duplicated here, it is CALLED from here. A PASSAGE
 * or an EVENT is a plain row, and hiding it is a filter on the search that
 * returns it. Same word to the user, right plumbing underneath each.
 *
 * NOTHING IS DELETED. The pack rows are untouched; a hide is a row in
 * hidden_items and an unhide removes it. That is what makes it safe to put
 * behind a long-press.
 */
import type { DbConnection } from '../events/engine';
import { setFactNodeExcluded, listHiddenPeople } from './factExclusions';
import { notifyNotesChanged, rematerializeNotes } from '../camp/campNotes';
import { CAMP_PASSPHRASE_KEY, campIdFor } from '../camp/campBoard';

export type HiddenKind = 'person' | 'passage' | 'event' | 'camp_note';

export interface HiddenItem {
  kind: HiddenKind;
  /** person: 'pack_id node_id' (both halves needed to restore);
   *  passage: 'pack_id:chunk_id' (== SourceRef.id); event: events.id;
   *  camp_note: the canonical note id — ONE key hides every projection
   *  (CAMP-NOTES ruling D). Passage/event hides that land on a note
   *  PROJECTION are remapped here, centrally, so no surface can hide half
   *  a note. */
  key: string;
  /** Human words for the Settings list -- the person's name, the passage's
   *  heading, the event's title. Never an id. */
  label: string;
  ts: string;
}

const noteKeyBehind = (
  conn: DbConnection,
  kind: HiddenKind,
  key: string,
): string | null => {
  if (kind === 'passage') {
    const sep = key.lastIndexOf(':');
    const packPart = sep > 0 ? key.slice(0, sep) : '';
    const chunkId = Number(key.slice(sep + 1));
    if (!Number.isInteger(chunkId)) {
      return null;
    }
    const r = conn.execute(
      'SELECT pack_id, note_key FROM doc_chunks WHERE id = ?',
      [chunkId],
    );
    if (!r.rows || r.rows.length === 0) {
      // The cited chunk no longer exists (a board rematerialized since the
      // citation). Refuse honestly instead of hiding a dead id.
      throw new Error(
        'That passage moved since it was shown — long-press it again.',
      );
    }
    if (packPart && String(r.rows.item(0).pack_id) !== packPart) {
      // The id was REUSED by a different pack's chunk — same refusal.
      throw new Error(
        'That passage moved since it was shown — long-press it again.',
      );
    }
    const nk = String(r.rows.item(0).note_key ?? '');
    return nk || null;
  }
  if (kind === 'event') {
    const r = conn.execute('SELECT note_key FROM events WHERE id = ?', [Number(key)]);
    const nk = r.rows && r.rows.length > 0 ? String(r.rows.item(0).note_key ?? '') : '';
    return nk || null;
  }
  return null;
};

const rematNoteProjections = (conn: DbConnection, noteKey: string): void => {
  const r = conn.execute('SELECT camp_id FROM camp_notes WHERE id = ?', [noteKey]);
  if (r.rows && r.rows.length > 0) {
    // Only the ACTIVE camp rematerializes: a hide/unhide touching a
    // set-aside camp's note must not resurrect that camp's packs while
    // another camp is active (audit 2026-08-20). The set-aside camp's
    // projections rebuild wholesale on switch-back.
    const noteCamp = String(r.rows.item(0).camp_id);
    const pass = conn.execute('SELECT value FROM settings WHERE key = ?', [
      CAMP_PASSPHRASE_KEY,
    ]);
    const stored =
      pass.rows && pass.rows.length > 0
        ? String(pass.rows.item(0).value ?? '')
        : '';
    const active = stored ? campIdFor(stored) : '';
    if (noteCamp !== active) {
      return;
    }
    rematerializeNotes(conn, noteCamp);
    notifyNotesChanged();
  }
};

export function hideItem(conn: DbConnection, item: Omit<HiddenItem, 'ts'>): void {
  if (item.kind === 'person') {
    const [pack_id, id] = item.key.split(' ');
    setFactNodeExcluded(conn, { pack_id, id }, true);
    return;
  }
  const noteKey = noteKeyBehind(conn, item.kind, item.key);
  // A board-section key is durable but NOT a camp note: it stays kind
  // 'passage' (filtered at read time) and triggers no note rematerialize.
  const isBoardSection = noteKey?.startsWith('boardsec:camp-board-') ?? false;
  const kind = noteKey && !isBoardSection ? 'camp_note' : item.kind;
  const key = noteKey ?? item.key;
  conn.execute(
    'INSERT OR REPLACE INTO hidden_items (kind, key, label, ts) VALUES (?, ?, ?, ?)',
    [kind, key, item.label, new Date().toISOString()],
  );
  if (noteKey && !isBoardSection) {
    rematNoteProjections(conn, noteKey);
  }
}

export function unhideItem(conn: DbConnection, kind: HiddenKind, key: string): void {
  if (kind === 'person') {
    const [pack_id, id] = key.split(' ');
    setFactNodeExcluded(conn, { pack_id, id }, false);
    return;
  }
  conn.execute('DELETE FROM hidden_items WHERE kind = ? AND key = ?', [kind, key]);
  if (kind === 'camp_note') {
    rematNoteProjections(conn, key);
  }
}

/** Everything hidden, every kind, newest first -- the Settings list. */
export function listHidden(conn: DbConnection): HiddenItem[] {
  const rows =
    conn.execute('SELECT kind, key, label, ts FROM hidden_items ORDER BY ts DESC')
      .rows?._array ?? [];
  const items: HiddenItem[] = rows.map(r => ({
    kind: String(r.kind) as HiddenKind,
    key: String(r.key),
    label: String(r.label),
    ts: String(r.ts),
  }));
  for (const p of listHiddenPeople(conn)) {
    items.push({
      kind: 'person',
      key: `${p.pack_id} ${p.id}`,
      label: p.pack_name ? `${p.name} (${p.pack_name})` : p.name,
      ts: '', // people carry no timestamp; they list after dated rows
    });
  }
  return items;
}

/**
 * THE ONE SQL CLAUSE EVERY EVENT QUERY SHARES. Append to a WHERE on the
 * events table aliased `e`. Filtering INSIDE the query, not on the returned
 * rows, is what makes a hide correct under LIMIT: a post-hoc filter after
 * `LIMIT 5` can return four rows -- or zero -- when hidden rows filled the
 * cap (codex review, 2026-08-17: "filtered only after LIMIT/TOP_N, so hidden
 * hits can underfill or false-empty otherwise valid results"). Every event
 * path -- search, browse, Right Now -- uses this same string, so there is
 * exactly one place a hidden event can leak from, and it is here.
 */
export const EVENTS_NOT_HIDDEN_SQL =
  "NOT EXISTS (SELECT 1 FROM hidden_items h WHERE h.kind = 'event' AND h.key = CAST(e.id AS TEXT))";

/** The set a search path filters through. Cheap: one indexed read. */
export function hiddenKeys(conn: DbConnection, kind: HiddenKind): Set<string> {
  const rows =
    conn.execute('SELECT key FROM hidden_items WHERE kind = ?', [kind]).rows
      ?._array ?? [];
  return new Set(rows.map(r => String(r.key)));
}
