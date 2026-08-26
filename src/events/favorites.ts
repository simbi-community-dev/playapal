/**
 * Event favorites — the "scheduley thing" (Karl, hippo camp, 2026-08-23):
 * heart events while browsing, then read the day's plan back as one
 * chronological, day-headed list. Persistence + change-signal only; the
 * joined, walk-annotated Faves list lives in src/rightnow/rightNow.ts
 * (favoriteEvents), beside the browse machinery it reuses.
 *
 * Identity is the event's NATURAL key (title + date + time_start), never
 * events.id: pack installs re-mint ids, and a heart must survive the data
 * updates that ship right up to the burn.
 */

import { getDb } from './db';

/**
 * Natural identity for favoriting, as a JSON array: collision-proof by
 * construction (no separator can be forged by field content) and safe in
 * every SQLite driver — a NUL-joined key measured TRUNCATED at the first
 * NUL in node:sqlite text binds, and a key that varies by driver would
 * silently orphan hearts.
 */
export function favKey(ev: { title: string; date: string; time_start: string }): string {
  return JSON.stringify([ev.title, ev.date, ev.time_start]);
}

// ---------------------------------------------------------------------------
// Change subscription (the campNotes revision-emitter pattern, ruling G).
// ---------------------------------------------------------------------------

let revision = 0;
const watchers = new Set<() => void>();

export function favoritesRevision(): number {
  return revision;
}

export function subscribeFavoritesChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

function notifyFavoritesChanged(): void {
  revision += 1;
  cachedAt = -1; // invalidate the key-set cache
  for (const w of watchers) {
    w();
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// Key-set cache: EventCard checks membership per render; one SELECT per
// revision beats one per card.
let cached: Set<string> = new Set();
let cachedAt = -1;

/** Every favorited key, cached until the next toggle. */
export function favoriteKeySet(): Set<string> {
  if (cachedAt !== revision) {
    const rows =
      getDb().execute('SELECT fav_key FROM event_favorites', []).rows?._array ?? [];
    cached = new Set(rows.map((r: { fav_key: string }) => r.fav_key));
    cachedAt = revision;
  }
  return cached;
}

export function isFavorite(ev: { title: string; date: string; time_start: string }): boolean {
  return favoriteKeySet().has(favKey(ev));
}

/** Heart on / heart off. */
export function toggleFavorite(ev: {
  title: string;
  date: string;
  time_start: string;
}): void {
  const conn = getDb();
  const key = favKey(ev);
  if (favoriteKeySet().has(key)) {
    conn.execute('DELETE FROM event_favorites WHERE fav_key = ?', [key]);
  } else {
    conn.execute(
      'INSERT OR IGNORE INTO event_favorites (fav_key, title, date, time_start, created_at) VALUES (?, ?, ?, ?, ?)',
      [key, ev.title, ev.date, ev.time_start, new Date().toISOString()],
    );
  }
  notifyFavoritesChanged();
}
