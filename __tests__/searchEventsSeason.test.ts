import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import { searchEvents } from '../src/events/searchEvents';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS } from '../src/packs/builtins';

const { DatabaseSync } = require('node:sqlite');

function makeConn() {
  const db = new DatabaseSync(':memory:');
  return {
    execute(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return {
          rows: {
            _array: rows,
            length: rows.length,
            item: (i: number) => rows[i],
          },
        };
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
      `SELECT DISTINCT e.date FROM events e
       JOIN packs p ON p.id = e.pack_id AND p.enabled = 1
       ORDER BY e.date`,
    );
    return (res.rows?._array ?? []).map((r: any) => r.date as string);
  },
}));

beforeAll(() => {
  mockConn = makeConn();
  for (const sql of [...BASE_TABLES_SQL, ...FTS_TABLES_SQL]) {
    mockConn.execute(sql);
  }
  installPackFromFiles(mockConn as any, BUILTIN_PACKS[0].files, {
    builtin: true,
  });
  for (const sql of REBUILD_FTS_SQL) {
    mockConn.execute(sql);
  }
});

describe('city milestones ride the events pack (2026-08-17)', () => {
  // The Playa Events listing never carries the burns, the Gate, or Exodus,
  // so "What night does the Man burn?" — which the model routes to
  // search_events like every other "when" question — dead-ended in the app
  // (the v4.0 battery routed it there on all three models). The milestones
  // now ship as rows in the bundled pack (tools/data/brc-2026-city-
  // milestones.jsonl via load_events.py --extra-jsonl), and the title-
  // weighted bm25 must rank them above camp events that merely mention the
  // burn ("Grilled Cheese After the Man Burn").
  test('"Man burn" ranks the Man Burn milestone first, on Saturday Sept 5', async () => {
    const outcome = await searchEvents(
      { query: 'Man burn' },
      'What night does the Man burn?',
      new Date(2026, 8, 1, 12, 0),
    );
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results[0].title).toBe('Man Burn');
    expect(outcome.results[0].date).toBe('2026-09-05');
    expect(outcome.results[0].day).toBe('Saturday');
  });

  test('"Temple burn" ranks the Temple Burn milestone first, on Sunday Sept 6', async () => {
    const outcome = await searchEvents(
      { query: 'Temple burn' },
      'When does the Temple burn?',
      new Date(2026, 8, 1, 12, 0),
    );
    expect(outcome.results[0].title).toBe('Temple Burn');
    expect(outcome.results[0].date).toBe('2026-09-06');
  });

  test('untimed milestones survive a day window ("Saturday")', async () => {
    const outcome = await searchEvents(
      { query: 'Man burn', day: 'Saturday' },
      'is the Man burning Saturday?',
      new Date(2026, 8, 1, 12, 0),
    );
    expect(outcome.results.some(e => e.title === 'Man Burn')).toBe(true);
  });
});

describe('search_events event-season weekday anchoring', () => {
  test('August 14 Wednesday morning reaches real September 2 yoga without relaxing', async () => {
    const outcome = await searchEvents(
      { query: 'yoga' },
      'Wednesday morning yoga',
      new Date(2026, 7, 14, 10, 0),
    );
    expect(outcome.window).toEqual({
      startISO: '2026-09-02T05:00',
      endISO: '2026-09-02T12:00',
      label: 'Wednesday morning',
    });
    expect(outcome.windowRelaxed).toBe(false);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.every(e => e.date === '2026-09-02')).toBe(true);
    expect(outcome.results.every(e => e.time_start >= '05:00' && e.time_start <= '12:00'))
      .toBe(true);
  });
});
