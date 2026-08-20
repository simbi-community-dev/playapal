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

export type HiddenKind = 'person' | 'passage' | 'event';

export interface HiddenItem {
  kind: HiddenKind;
  /** person: 'pack_id node_id' (both halves needed to restore);
   *  passage: 'pack_id:chunk_id' (== SourceRef.id); event: events.id. */
  key: string;
  /** Human words for the Settings list -- the person's name, the passage's
   *  heading, the event's title. Never an id. */
  label: string;
  ts: string;
}

export function hideItem(conn: DbConnection, item: Omit<HiddenItem, 'ts'>): void {
  if (item.kind === 'person') {
    const [pack_id, id] = item.key.split(' ');
    setFactNodeExcluded(conn, { pack_id, id }, true);
    return;
  }
  conn.execute(
    'INSERT OR REPLACE INTO hidden_items (kind, key, label, ts) VALUES (?, ?, ?, ?)',
    [item.kind, item.key, item.label, new Date().toISOString()],
  );
}

export function unhideItem(conn: DbConnection, kind: HiddenKind, key: string): void {
  if (kind === 'person') {
    const [pack_id, id] = key.split(' ');
    setFactNodeExcluded(conn, { pack_id, id }, false);
    return;
  }
  conn.execute('DELETE FROM hidden_items WHERE kind = ? AND key = ?', [kind, key]);
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
