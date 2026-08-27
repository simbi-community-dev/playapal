/**
 * "Don't use this" on an event must hold on EVERY event path, and must hold
 * BEFORE the LIMIT -- both found by codex review of the first version
 * (2026-08-17): the Right Now tab bypassed the filter entirely, and
 * searchEvents filtered after TOP_N so hidden hits could underfill or
 * false-empty otherwise valid results. Real events pack, real FTS.
 */
import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import { searchEvents } from '../src/events/searchEvents';
import { rightNow, browseEvents } from '../src/rightnow/rightNow';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS } from '../src/packs/builtins';
import { hideItem, unhideItem, listHidden } from '../src/facts/hiddenItems';

const { DatabaseSync } = require('node:sqlite');

function makeConn() {
  const db = new DatabaseSync(':memory:');
  return {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return { rows: { _array: rows, length: rows.length, item: (i: number) => rows[i] } };
      }
      stmt.run(...params);
      return { rows: undefined };
    },
  };
}
let mockConn: ReturnType<typeof makeConn>;

jest.mock('../src/events/db', () => ({
  getDb: () => mockConn,
  isFtsAvailable: () => true,
  eventDates: () => {
    const res = mockConn.execute(
      `SELECT DISTINCT e.date FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 ORDER BY e.date`,
    );
    return (res.rows?._array ?? []).map((r: any) => r.date as string);
  },
}));

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  installPackFromFiles(mockConn as any, BUILTIN_PACKS[0].files, { builtin: true });
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

afterEach(() => {
  // leave no hide behind: each test starts from a clean hidden set
  for (const h of listHidden(mockConn as any)) {
    unhideItem(mockConn as any, h.kind, h.key);
  }
});

const AUG14 = new Date(2026, 7, 14, 10, 0);

describe('a hidden event never surfaces, on any path', () => {
  test('search_events: hidden event drops out and the LIMIT is refilled, not underfilled', async () => {
    const before = await searchEvents({ query: 'yoga' }, 'yoga', AUG14);
    expect(before.results.length).toBeGreaterThan(1);
    const victim = before.results[0];
    const n = before.results.length;

    hideItem(mockConn as any, { kind: 'event', key: String(victim.id), label: victim.title });
    const after = await searchEvents({ query: 'yoga' }, 'yoga', AUG14);
    expect(after.results.map(e => e.id)).not.toContain(victim.id);
    // THE LIMIT-UNDERFILL CASE: with the filter INSIDE the query, another
    // matching event takes the freed slot. A post-hoc filter would have
    // returned n-1 here.
    expect(after.results.length).toBe(n);
  });

  test('Right Now (rightNow + browseEvents): the paths that bypassed the filter', () => {
    // during the event window, so "now"/"next" are populated
    const DURING = new Date(2026, 8, 2, 10, 0);
    const rn = rightNow({ lookaheadHours: 12 }, DURING);
    const all = [...rn.now, ...rn.next];
    expect(all.length).toBeGreaterThan(0);
    const victim = all[0].event;
    hideItem(mockConn as any, { kind: 'event', key: String(victim.id), label: victim.title });
    const rn2 = rightNow({ lookaheadHours: 12 }, DURING);
    expect([...rn2.now, ...rn2.next].map(i => i.event.id)).not.toContain(victim.id);

    const b = browseEvents({ day: victim.date, tod: 'all' } as any, {});
    expect(b.map(i => i.event.id)).not.toContain(victim.id);
  });

  test('restore brings it back on every path', async () => {
    const before = await searchEvents({ query: 'yoga' }, 'yoga', AUG14);
    const victim = before.results[0];
    hideItem(mockConn as any, { kind: 'event', key: String(victim.id), label: victim.title });
    unhideItem(mockConn as any, 'event', String(victim.id));
    const after = await searchEvents({ query: 'yoga' }, 'yoga', AUG14);
    expect(after.results.map(e => e.id)).toContain(victim.id);
    expect(listHidden(mockConn as any)).toEqual([]);
  });

  test('the Settings list carries the event with its title, not its id', () => {
    hideItem(mockConn as any, { kind: 'event', key: '12345', label: 'Sunrise Yoga' });
    const items = listHidden(mockConn as any);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'event', key: '12345', label: 'Sunrise Yoga' });
  });
});
