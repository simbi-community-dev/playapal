/**
 * Favorites (0.7.2, Karl's itinerary ask): hearts persist by the event's
 * NATURAL key (title+date+time_start) so they survive the pack reinstalls
 * that re-mint events.id right up to the burn — the property this file
 * exists to pin. favoriteEvents() is the joined read the Faves list draws.
 */

let mockConn: any;
jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
}));

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import {
  favKey,
  favoritesRevision,
  isFavorite,
  subscribeFavoritesChanged,
  toggleFavorite,
} from '../src/events/favorites';
import { favoriteEvents } from '../src/rightnow/rightNow';

const { DatabaseSync } = require('node:sqlite');

function makePhone() {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...(params as never[]));
        return {
          rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] },
        };
      }
      stmt.run(...(params as never[]));
      return { rows: undefined };
    },
  } as any;
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  return conn;
}

const EV = {
  yoga: { title: 'Sunrise Yoga', date: '2026-08-31', time_start: '06:30' },
  yogaLate: { title: 'Sunrise Yoga', date: '2026-08-31', time_start: '18:00' },
  noodles: { title: 'DanDan Noodles', date: '2026-08-31', time_start: '03:00' },
  craft: { title: 'Craft Table', date: '2026-09-01', time_start: '10:00' },
};

function insertEvent(
  conn: any,
  ev: { title: string; date: string; time_start: string },
  id: number,
  packId = 'brc-events-2026',
) {
  conn.execute(
    "INSERT INTO events (id, pack_id, title, desc, day, date, time_start, time_end, camp, location) VALUES (?, ?, ?, '', ?, ?, ?, '', 'Camp X', '3:00 & C')",
    [id, packId, ev.title, 'Monday', ev.date, ev.time_start],
  );
}

function installPack(conn: any, packId = 'brc-events-2026', enabled = 1) {
  conn.execute(
    'INSERT OR REPLACE INTO packs (id, name, enabled) VALUES (?, ?, ?)',
    [packId, packId, enabled],
  );
}

beforeEach(() => {
  mockConn = makePhone();
  // The module's key-set cache keys on its revision, which outlives each
  // test's fresh db — round-trip one toggle so the cache re-reads THIS conn.
  toggleFavorite({ title: ' cachebuster', date: '0', time_start: '0' });
  toggleFavorite({ title: ' cachebuster', date: '0', time_start: '0' });
});

describe('the favorites store', () => {
  test('toggle hearts on, off, and keys on ALL THREE identity fields', () => {
    expect(isFavorite(EV.yoga)).toBe(false);
    toggleFavorite(EV.yoga);
    expect(isFavorite(EV.yoga)).toBe(true);
    // same title+date, different time: an independent heart — the daily
    // 06:30 session and the 18:00 one are different plans
    expect(isFavorite(EV.yogaLate)).toBe(false);
    toggleFavorite(EV.yoga);
    expect(isFavorite(EV.yoga)).toBe(false);
  });

  test('a toggle notifies subscribers and bumps the revision', () => {
    const before = favoritesRevision();
    const fired = jest.fn();
    const off = subscribeFavoritesChanged(fired);
    toggleFavorite(EV.noodles);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(favoritesRevision()).toBeGreaterThan(before);
    off();
    toggleFavorite(EV.noodles);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  test('favKey separates fields so lookalike tuples cannot collide', () => {
    expect(favKey(EV.yoga)).not.toBe(favKey(EV.yogaLate));
    expect(favKey({ title: 'A\nB', date: 'C', time_start: 'D' })).not.toBe(
      favKey({ title: 'A', date: 'B\nC', time_start: 'D' }),
    );
  });
});

describe('favoriteEvents — the itinerary read', () => {
  test('joins hearted events chronologically across days', () => {
    installPack(mockConn);
    insertEvent(mockConn, EV.noodles, 1);
    insertEvent(mockConn, EV.yoga, 2);
    insertEvent(mockConn, EV.craft, 3);
    toggleFavorite(EV.yoga);
    toggleFavorite(EV.craft);
    toggleFavorite(EV.noodles);
    const list = favoriteEvents();
    expect(list.map(i => i.event.title)).toEqual([
      'DanDan Noodles', // 08-31 03:00
      'Sunrise Yoga', // 08-31 06:30
      'Craft Table', // 09-01 10:00
    ]);
  });

  test('THE LOAD-BEARING PROPERTY: hearts survive a pack reinstall that re-mints every id', () => {
    installPack(mockConn);
    insertEvent(mockConn, EV.yoga, 1);
    toggleFavorite(EV.yoga);
    // the v6 data update: rows deleted, reinserted under new ids + pack row replaced
    mockConn.execute('DELETE FROM events', []);
    insertEvent(mockConn, EV.yoga, 999);
    installPack(mockConn);
    expect(favoriteEvents().map(i => i.event.id)).toEqual([999]);
  });

  test('an event edited out of the newer pack silently stops joining', () => {
    installPack(mockConn);
    insertEvent(mockConn, EV.yoga, 1);
    toggleFavorite(EV.yoga);
    mockConn.execute('DELETE FROM events', []);
    // v6 shifted the session to 07:00 — the old heart no longer matches
    insertEvent(mockConn, { ...EV.yoga, time_start: '07:00' }, 2);
    expect(favoriteEvents()).toEqual([]);
    // the heart row itself survives (count in the store, not the join)
    expect(isFavorite(EV.yoga)).toBe(true);
  });

  test('disabled packs and hidden events stay out of the itinerary', () => {
    installPack(mockConn, 'brc-events-2026', 1);
    installPack(mockConn, 'other-pack', 0);
    insertEvent(mockConn, EV.yoga, 1);
    insertEvent(mockConn, EV.craft, 2, 'other-pack');
    insertEvent(mockConn, EV.noodles, 3);
    toggleFavorite(EV.yoga);
    toggleFavorite(EV.craft);
    toggleFavorite(EV.noodles);
    mockConn.execute(
      "INSERT INTO hidden_items (kind, key, label, ts) VALUES ('event', '3', 'DanDan Noodles', '2026-08-31')",
      [],
    );
    expect(favoriteEvents().map(i => i.event.title)).toEqual(['Sunrise Yoga']);
  });
});
