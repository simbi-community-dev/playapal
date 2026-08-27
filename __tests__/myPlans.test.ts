/**
 * "My plans" (src/rightnow/myPlans.ts): the user's hearted events + saved
 * pins synthesized into ONE app-maintained document that rides the EXISTING
 * search_docs tool — deliberately not a fifth tool (the training contract
 * pins four; FTS finds "my faves"/"my pins" trivially).
 *
 * Proven against the REAL shipped DDL on node:sqlite (the crewMessages /
 * favorites harness) with REAL FTS5, through the REAL searchDocs query path
 * — so "a faved event is findable and citable via the my-plans doc" is a
 * property of the shipped schema + retrieval ladder, not of a test double.
 */

let mockConn: any;
let mockGeo: any;

jest.mock('../src/events/db', () => {
  // The real rebuild statements, so the FTS the test searches is exactly the
  // FTS a refresh leaves behind on-device (drift here would test nothing).
  const { REBUILD_FTS_SQL } = jest.requireActual('../src/events/schema');
  return {
    getDb: () => mockConn,
    isFtsAvailable: () => true,
    isVecAvailable: () => false,
    getSetting: (key: string) => {
      const r = mockConn.execute('SELECT value FROM settings WHERE key = ?', [key]);
      return r.rows && r.rows.length > 0 ? r.rows.item(0).value : null;
    },
    setSetting: (key: string, value: string) => {
      mockConn.execute(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
    },
    rebuildFtsIndexes: (conn: any) => {
      for (const sql of REBUILD_FTS_SQL) {
        conn.execute(sql);
      }
    },
  };
});

// Injectable geometry: the real 2026 asset for address rendering, null for
// the geometry-free coordinate floor — both branches the app actually has.
jest.mock('../src/geo/cityGeometry', () => ({
  EVENT_YEAR: 2026,
  getCityGeometry: () => mockGeo,
}));

import { BASE_TABLES_SQL, FTS_TABLES_SQL } from '../src/events/schema';
import { toggleFavorite } from '../src/events/favorites';
import {
  listPins,
  pinsRevision,
  removePin,
  savePin,
  subscribePinsChanged,
} from '../src/geo/waypoints';
import { polarToLatLon, type BrcGeometry } from '../src/geo/brcGeo';
import { searchDocs } from '../src/docs/searchDocs';
import {
  MY_PLANS_DEBOUNCE_MS,
  MY_PLANS_PACK_ID,
  NO_FAVES_LINE,
  NO_PINS_LINE,
  refreshMyPlansDoc,
  renderMyPlansMarkdown,
  startMyPlansSync,
  stopMyPlansSync,
} from '../src/rightnow/myPlans';

const { DatabaseSync } = require('node:sqlite');

const realGeo = require('../assets/city-geo/geometry.json') as BrcGeometry;

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

let nextEventId = 1;

/** Seed one enabled-pack event the way favorites.test.ts does — the join in
 * favoriteEvents() requires the pack row, exactly like on-device. */
function insertEvent(ev: {
  title: string;
  date: string;
  time_start: string;
  camp?: string;
  location?: string;
}) {
  mockConn.execute(
    "INSERT OR IGNORE INTO packs (id, name, enabled) VALUES ('brc-events-2026', 'BRC Events 2026', 1)",
  );
  mockConn.execute(
    "INSERT INTO events (id, pack_id, title, desc, day, date, time_start, time_end, camp, location) VALUES (?, 'brc-events-2026', ?, '', '', ?, ?, '', ?, ?)",
    [nextEventId++, ev.title, ev.date, ev.time_start, ev.camp ?? '', ev.location ?? ''],
  );
}

const heart = (ev: { title: string; date: string; time_start: string }) => {
  insertEvent(ev as any);
  toggleFavorite(ev);
};

/** Injected clock: Sat Aug 29 2026, noon — the day David lands at BRC. */
const NOW = new Date(2026, 7, 29, 12, 0);

const myPlansChunks = () =>
  (mockConn.execute(
    'SELECT heading, content FROM doc_chunks WHERE pack_id = ? ORDER BY id',
    [MY_PLANS_PACK_ID],
  ).rows?._array ?? []) as { heading: string; content: string }[];

beforeEach(() => {
  mockConn = makePhone();
  mockGeo = realGeo;
  nextEventId = 1;
});

afterEach(() => {
  stopMyPlansSync();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('renderMyPlansMarkdown', () => {
  test('faved events render with their real joined fields, grouped by day', () => {
    heart({ title: 'Misty Fjord Pancake Symposium', date: '2026-08-30', time_start: '09:30', camp: 'Fjordlandia', location: '7:30 & G' } as any);
    heart({ title: 'Velvet Nebula Tea Ceremony', date: '2026-08-31', time_start: '16:00', camp: 'Nebula Lounge', location: '3:00 & C' } as any);
    heart({ title: 'Second Sunday Serenade', date: '2026-08-30', time_start: '21:00', camp: '', location: '' } as any);

    const md = renderMyPlansMarkdown(NOW);
    // One day heading per date, chronological, mirroring the Faves list.
    expect(md.indexOf('### Sunday, Aug 30')).toBeGreaterThan(-1);
    expect(md.indexOf('### Monday, Aug 31')).toBeGreaterThan(md.indexOf('### Sunday, Aug 30'));
    expect(md.match(/### Sunday, Aug 30/g)).toHaveLength(1);
    // The full line: title, date+time, camp, address, walk annotation.
    expect(md).toMatch(
      /\*\*Misty Fjord Pancake Symposium\*\* — Sunday, Aug 30, 09:30 · Fjordlandia · 7:30 & G · ~\d+ min walk/,
    );
    // Blank camp/location/walk collapse instead of leaving ' ·  · ' litter.
    expect(md).toContain('**Second Sunday Serenade** — Sunday, Aug 30, 21:00');
    expect(md).not.toMatch(/·\s*·/);
    expect(md).not.toContain(NO_FAVES_LINE);
  });

  test('a heart on a date already behind the injected clock says so', () => {
    heart({ title: 'Gate Road Dust Communion', date: '2026-08-28', time_start: '20:00' } as any);
    expect(renderMyPlansMarkdown(NOW)).toMatch(
      /\*\*Gate Road Dust Communion\*\* — .*already happened/,
    );
  });

  test('pins render as clock addresses with geometry, coordinates without', () => {
    // Center Camp sits at 6:00 by construction every year; project its polar
    // position through the real 2026 geometry and pin there.
    const [lat, lon] = polarToLatLon(
      { radiusFt: realGeo.centerCamp.distanceFt, angleDeg: 180 },
      realGeo,
    );
    savePin('Home', lat, lon);
    expect(renderMyPlansMarkdown(NOW)).toContain('**Home** — Center Camp');

    mockGeo = null; // the compass's geometry-free floor
    savePin('My bike', 40.7864, -119.2065);
    expect(renderMyPlansMarkdown(NOW)).toContain('**My bike** — 40.7864, -119.2065');
  });

  test('honest empty states: no faves / no pins answer, never silence', () => {
    const md = renderMyPlansMarkdown(NOW);
    expect(md).toContain('# My plans');
    expect(md).toContain(NO_FAVES_LINE);
    expect(md).toContain(NO_PINS_LINE);
  });
});

// ---------------------------------------------------------------------------

describe('refreshMyPlansDoc — the campNotes projection seam', () => {
  test('materializes into doc_chunks and is FTS-findable through searchDocs', () => {
    heart({ title: 'Misty Fjord Pancake Symposium', date: '2026-08-30', time_start: '09:30', camp: 'Fjordlandia', location: '7:30 & G' } as any);
    savePin('Stashed water', 40.7864, -119.2065);
    refreshMyPlansDoc(NOW);

    // "When's that thing I hearted?" — the title reaches a citable passage.
    const byTitle = searchDocs({ query: 'Misty Fjord Pancake' });
    const hit = byTitle.results.find(r => r.pack_id === MY_PLANS_PACK_ID);
    expect(hit).toBeDefined();
    expect(hit!.pack_name).toBe('My plans');
    expect(hit!.heading).toBe('My plans > Faves — Sunday, Aug 30');
    expect(hit!.content).toContain('Sunday, Aug 30, 09:30');

    // The trivially-guessable queries the no-fifth-tool decision leans on.
    const faves = searchDocs({ query: 'my faves' });
    expect(faves.results.some(r => r.pack_id === MY_PLANS_PACK_ID)).toBe(true);
    const pins = searchDocs({ query: 'my pins' });
    const pinHit = pins.results.find(r => r.pack_id === MY_PLANS_PACK_ID);
    expect(pinHit!.content).toContain('**Stashed water**');
  });

  test('empty states materialize too, so "my faves" gets a real answer', () => {
    refreshMyPlansDoc(NOW);
    const out = searchDocs({ query: 'my faves' });
    const hit = out.results.find(r => r.pack_id === MY_PLANS_PACK_ID);
    expect(hit!.content).toBe(NO_FAVES_LINE);
  });

  test('refresh REPLACES: no duplicate chunks, edits land, toggle survives', () => {
    heart({ title: 'Dawn Chorus Kazoo Parade', date: '2026-08-30', time_start: '06:00' } as any);
    refreshMyPlansDoc(NOW);
    const first = myPlansChunks();
    refreshMyPlansDoc(NOW);
    expect(myPlansChunks()).toHaveLength(first.length);
    // A search after two refreshes returns the passage once, not twice.
    const out = searchDocs({ query: 'Dawn Chorus Kazoo' });
    expect(out.results.filter(r => r.pack_id === MY_PLANS_PACK_ID)).toHaveLength(1);

    // Un-heart -> the next refresh forgets it (projection, not archive)…
    toggleFavorite({ title: 'Dawn Chorus Kazoo Parade', date: '2026-08-30', time_start: '06:00' });
    // …and a user's disable of the derived pack is NOT clobbered by refresh.
    mockConn.execute('UPDATE packs SET enabled = 0 WHERE id = ?', [MY_PLANS_PACK_ID]);
    refreshMyPlansDoc(NOW);
    expect(myPlansChunks().map(c => c.content).join()).not.toContain('Kazoo');
    const pack = mockConn.execute('SELECT enabled FROM packs WHERE id = ?', [MY_PLANS_PACK_ID]);
    expect(pack.rows.item(0).enabled).toBe(0);
    // Disabled pack = invisible to the Angel (the searchDocs pack gate).
    expect(
      searchDocs({ query: 'my pins' }).results.some(r => r.pack_id === MY_PLANS_PACK_ID),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('startMyPlansSync — debounced live sync over both stores', () => {
  test('a heart-tap burst rebuilds the doc ONCE; pins trigger too; stop stops', () => {
    jest.useFakeTimers();
    // Count wholesale rebuilds by their first statement — the chunk wipe.
    let wipes = 0;
    const rawExecute = mockConn.execute.bind(mockConn);
    mockConn.execute = (sql: string, params?: unknown[]) => {
      if (/^DELETE FROM doc_chunks WHERE pack_id = \?$/.test(sql)) {
        wipes += 1;
      }
      return rawExecute(sql, params);
    };

    startMyPlansSync();
    startMyPlansSync(); // idempotent — a re-run must not double-subscribe
    heart({ title: 'Alpha Sparkle Waffles', date: '2026-08-30', time_start: '08:00' } as any);
    heart({ title: 'Beta Dust Opera', date: '2026-08-30', time_start: '19:00' } as any);
    heart({ title: 'Gamma Fence Walk', date: '2026-08-31', time_start: '07:00' } as any);

    jest.advanceTimersByTime(MY_PLANS_DEBOUNCE_MS - 1);
    expect(wipes).toBe(0); // still inside the debounce window
    jest.advanceTimersByTime(1);
    expect(wipes).toBe(1); // the whole burst (start included) collapsed
    const doc = myPlansChunks().map(c => c.content).join('\n');
    expect(doc).toContain('Alpha Sparkle Waffles');
    expect(doc).toContain('Beta Dust Opera');
    expect(doc).toContain('Gamma Fence Walk');

    savePin('Shade spot', 40.79, -119.2);
    jest.advanceTimersByTime(MY_PLANS_DEBOUNCE_MS);
    expect(wipes).toBe(2);
    expect(myPlansChunks().map(c => c.content).join('\n')).toContain('**Shade spot**');

    stopMyPlansSync();
    heart({ title: 'Delta Midnight Soup', date: '2026-08-31', time_start: '23:30' } as any);
    jest.advanceTimersByTime(MY_PLANS_DEBOUNCE_MS * 5);
    expect(wipes).toBe(2); // unsubscribed AND the pending timer was cleared
  });
});

// ---------------------------------------------------------------------------

describe('waypoints change signal (the favorites emitter pattern)', () => {
  test('save/remove bump the revision and notify; unsubscribe detaches', () => {
    const before = pinsRevision();
    const fired = jest.fn();
    const off = subscribePinsChanged(fired);
    const pin = savePin('Water cache', 40.78, -119.21);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(pinsRevision()).toBeGreaterThan(before);
    removePin(pin.id);
    expect(fired).toHaveBeenCalledTimes(2);
    expect(listPins()).toHaveLength(0);
    off();
    savePin('After unsubscribe', 40.78, -119.21);
    expect(fired).toHaveBeenCalledTimes(2);
  });
});
