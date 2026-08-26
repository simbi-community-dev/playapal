import {
  BASE_TABLES_SQL,
  FTS_TABLES_SQL,
  REBUILD_FTS_SQL,
} from '../src/events/schema';
import {
  isEnabledEventTitleRequest,
  replaceEventDayCoordinate,
  searchEvents,
} from '../src/events/searchEvents';
import { installPackFromFiles } from '../src/packs/installPack';
import { BUILTIN_PACKS } from '../src/packs/builtins';
import type { DbConnection } from '../src/events/engine';

const { DatabaseSync } = require('node:sqlite');

const TUE_2PM = new Date(2026, 8, 1, 14, 0);

function makeConn(): DbConnection {
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
  installPackFromFiles(mockConn, BUILTIN_PACKS[0].files, {
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
  test('pack installation rejects impossible calendar dates', () => {
    expect(() => installPackFromFiles(mockConn, [
      {
        name: 'pack.json',
        content: JSON.stringify({
          id: 'invalid-date-pack',
          name: 'Invalid Date Pack',
          description: '',
          version: 1,
        }),
      },
      {
        name: 'events.json',
        content: JSON.stringify([{ title: 'Impossible', date: '2026-02-31' }]),
      },
    ])).toThrow('"date" must be YYYY-MM-DD');
  });

  test('an impossible raw date closes authoritatively without searching another window', async () => {
    await expect(searchEvents(
      { query: 'yoga', day: 'tomorrow' },
      'yoga on 2026-02-31 morning',
      new Date(2026, 7, 14, 10, 0),
    )).resolves.toEqual({
      state: 'invalid-date',
      results: [],
      window: null,
      query: 'yoga',
      dateText: '2026-02-31',
      strategy: 'none',
    });
  });

  test('an exact raw date returns only that authoritative date', async () => {
    const outcome = await searchEvents(
      { query: 'yoga' },
      'yoga on 2026-09-02',
      new Date(2026, 7, 14, 10, 0),
    );
    expect(outcome).toMatchObject({
      state: 'matches',
      relation: 'within-request',
      window: { label: '2026-09-02' },
    });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.every(event => event.date === '2026-09-02')).toBe(true);
  });

  test('an exact empty date reports alternatives as outside the requested date', async () => {
    const outcome = await searchEvents(
      { query: 'yoga' },
      'yoga on 2026-08-14',
      new Date(2026, 7, 14, 10, 0),
    );
    expect(outcome).toMatchObject({
      state: 'matches',
      relation: 'outside-requested-date',
      window: { label: '2026-08-14' },
    });
    expect(outcome.results.every(event => event.date !== '2026-08-14')).toBe(true);
  });

  test('exact-time authority filters the complete interval set before capping', async () => {
    installPackFromFiles(mockConn, [
      {
        name: 'pack.json',
        content: JSON.stringify({
          id: 'time-filter-probe',
          name: 'Time Filter Probe',
          description: '',
          version: 1,
        }),
      },
      {
        name: 'events.json',
        content: JSON.stringify([
          ...Array.from({ length: 55 }, (_, index) => ({
            title: `Rankprobe early ${index}`,
            date: '2026-09-03',
            time_start: `${String(6 + Math.floor(index / 10)).padStart(2, '0')}:00`,
            time_end: `${String(6 + Math.floor(index / 10)).padStart(2, '0')}:30`,
          })),
          {
            title: 'Rankprobe spanning',
            date: '2026-09-03',
            time_start: '20:00',
            time_end: '22:00',
          },
          {
            title: 'Nightprobe overnight',
            date: '2026-09-03',
            time_start: '18:00',
            time_end: '06:00',
          },
          ...Array.from({ length: 110 }, (_, index) => ({
            title: `Nightalt morning ${index}`,
            date: '2026-09-04',
            time_start: '07:00',
            time_end: '08:00',
          })),
          {
            title: 'Nightalt evening',
            date: '2026-09-05',
            time_start: '19:00',
            time_end: '20:00',
          },
          {
            title: 'Untimedprobe',
            date: '2026-09-03',
            time_start: '',
            time_end: '',
          },
          {
            title: 'Weekprobe prior morning',
            date: '2026-08-31',
            time_start: '09:00',
            time_end: '10:00',
          },
          {
            title: 'Weekprobe overnight',
            date: '2026-08-31',
            time_start: '23:00',
            time_end: '06:00',
          },
          {
            title: 'Weekprobe morning',
            date: '2026-09-02',
            time_start: '06:00',
            time_end: '07:00',
          },
          {
            title: 'Weekprobe afternoon',
            date: '2026-09-02',
            time_start: '14:00',
            time_end: '15:00',
          },
          {
            title: 'Weekprobe evening',
            date: '2026-09-02',
            time_start: '18:00',
            time_end: '19:00',
          },
          {
            title: 'Clockweek prior day',
            date: '2026-08-31',
            time_start: '21:00',
            time_end: '22:00',
          },
          {
            title: 'Clockweek current week',
            date: '2026-09-02',
            time_start: '21:00',
            time_end: '22:00',
          },
          {
            title: 'Exactleak prior day',
            date: '2026-09-02',
            time_start: '21:00',
            time_end: '22:00',
          },
          {
            title: 'Morning Coffee',
            date: '2026-09-04',
            time_start: '14:00',
            time_end: '15:00',
            desc: 'Kid friendly gathering',
          },
          {
            title: 'Night Swim',
            date: '2026-09-03',
            time_start: '10:00',
            time_end: '11:00',
          },
          {
            title: 'Night-Swim Circle',
            date: '2026-09-04',
            time_start: '14:00',
            time_end: '15:00',
          },
          {
            title: 'Morning Coffee &amp; Consent Talk',
            date: '2026-09-04',
            time_start: '14:00',
            time_end: '15:00',
          },
          {
            title: 'Tea & Tarot',
            date: '2026-09-01',
            time_start: '16:00',
            time_end: '17:00',
          },
          {
            title: "Devil's Punchbowl",
            date: '2026-09-02',
            time_start: '13:00',
            time_end: '14:00',
          },
          {
            title: 'Tea and Tarot',
            date: '2026-09-05',
            time_start: '16:00',
            time_end: '17:00',
          },
          {
            title: 'Tuesday Sunrise Set',
            date: '2026-09-04',
            time_start: '06:00',
            time_end: '07:00',
          },
          {
            title: 'Yoga',
            desc: 'An advanced practice',
            date: '2026-09-04',
            time_start: '09:00',
            time_end: '10:00',
          },
          {
            title: 'Beginner Yoga Flow',
            desc: 'A yoga practice for beginners',
            date: '2026-09-04',
            time_start: '10:00',
            time_end: '11:00',
          },
          {
            title: 'Café',
            date: '2026-09-04',
            time_start: '11:00',
            time_end: '12:00',
          },
          {
            title: 'Cafe Racer',
            date: '2026-09-05',
            time_start: '11:00',
            time_end: '12:00',
          },
          {
            title: 'Friday',
            date: '2026-09-05',
            time_start: '12:00',
            time_end: '13:00',
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            title: `Phrase Clock decoy ${index}`,
            desc: 'Phrase Clock gathering',
            date: '2026-09-03',
            time_start: `0${index}:00`,
            time_end: `0${index}:30`,
          })),
          {
            title: 'Phrase Clock evening',
            desc: 'Phrase Clock gathering',
            date: '2026-09-03',
            time_start: '21:00',
            time_end: '22:00',
          },
          {
            title: 'Friday',
            desc: 'A hidden title that must not own calendar words',
            date: '2026-09-04',
            time_start: '12:00',
            time_end: '13:00',
          },
          {
            title: 'After Man Burn Party!',
            desc: 'Man Burn Man Burn Man Burn afterparty',
            date: '2026-09-05',
            time_start: '23:00',
            time_end: '23:59',
          },
          {
            title: 'Man Burn',
            date: '2026-09-05',
            time_start: '21:00',
            time_end: '22:00',
          },
        ]),
      },
    ]);
    for (const sql of REBUILD_FTS_SQL) {
      mockConn.execute(sql);
    }
    const hiddenFriday = mockConn.execute(
      "SELECT id FROM events WHERE title = 'Friday' AND desc LIKE 'A hidden%'",
    ).rows?._array[0] as { id: string };
    mockConn.execute(
      'INSERT INTO hidden_items (kind, key, label, ts) VALUES (?, ?, ?, ?)',
      ['event', String(hiddenFriday.id), 'Friday', '2026-08-25T00:00:00.000Z'],
    );

    const spanning = await searchEvents(
      { query: 'rankprobe 2026-09-03' },
      'rankprobe on 2026-09-03 at 21:00',
      TUE_2PM,
    );
    expect(spanning).toMatchObject({ state: 'matches', relation: 'within-request' });
    expect(spanning.results.map(row => row.title)).toContain('Rankprobe spanning');

    const phraseClock = await searchEvents(
      { query: 'phrase clock' },
      'phrase clock on 2026-09-03 at 9pm',
      TUE_2PM,
    );
    expect(phraseClock).toMatchObject({ state: 'matches', relation: 'within-request' });
    expect(phraseClock.results.map(row => row.title)).toEqual(['Phrase Clock evening']);

    const overnight = await searchEvents(
      { query: 'nightprobe' },
      'nightprobe on 2026-09-03 at 11pm',
      TUE_2PM,
    );
    expect(overnight).toMatchObject({ state: 'matches', relation: 'within-request' });
    expect(overnight.results.map(row => row.title)).toEqual(['Nightprobe overnight']);

    const untimed = await searchEvents(
      { query: 'untimedprobe' },
      'untimedprobe on 2026-09-03 at 9pm',
      TUE_2PM,
    );
    expect(untimed).toMatchObject({ state: 'matches', relation: 'outside-requested-time' });

    const alternatives = await searchEvents(
      { query: 'nightalt' },
      'nightalt tonight',
      TUE_2PM,
    );
    expect(alternatives).toMatchObject({ state: 'matches', relation: 'outside-requested-date' });
    expect(alternatives.results.map(row => row.title)).toEqual(['Nightalt evening']);

    const weekMorning = await searchEvents(
      { query: 'weekprobe' },
      'weekprobe morning this week',
      TUE_2PM,
    );
    expect(weekMorning).toMatchObject({ state: 'matches', relation: 'within-request' });
    expect(weekMorning.results.map(row => row.title).sort()).toEqual([
      'Weekprobe morning',
      'Weekprobe overnight',
    ]);

    const weekNight = await searchEvents(
      { query: 'weekprobe' },
      'weekprobe all week at night',
      TUE_2PM,
    );
    expect(weekNight).toMatchObject({ state: 'matches', relation: 'within-request' });
    expect(weekNight.results.map(row => row.title)).toEqual(['Weekprobe evening']);

    const weeklyClock = await searchEvents(
      { query: 'clockweek' },
      'clockweek this week at 9pm',
      TUE_2PM,
    );
    expect(weeklyClock).toMatchObject({ state: 'matches', relation: 'within-request' });
    expect(weeklyClock.results.map(row => row.title)).toEqual([
      'Clockweek current week',
    ]);

    const priorDayLeak = await searchEvents(
      { query: 'exactleak' },
      'exactleak on 2026-09-03 at 9pm',
      TUE_2PM,
    );
    expect(priorDayLeak).toMatchObject({
      state: 'matches',
      relation: 'outside-requested-date',
    });
    expect(priorDayLeak.results.map(row => row.title)).toEqual([
      'Exactleak prior day',
    ]);

    const morningTitle = await searchEvents(
      { query: 'Morning Coffee' },
      'Morning Coffee',
      TUE_2PM,
    );
    expect(morningTitle).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      window: null,
      query: 'morning coffee',
    });
    expect(morningTitle.results.length).toBeGreaterThan(0);
    expect(morningTitle.results.every(row => row.title === 'Morning Coffee')).toBe(true);

    const exactRank = await searchEvents(
      { query: 'Man Burn' },
      'Man Burn',
      TUE_2PM,
    );
    expect(exactRank.results[0].title).toBe('Man Burn');

    const rawTitleOwnsTemporalWords = await searchEvents(
      { query: 'coffee' },
      'What time is Morning Coffee?',
      TUE_2PM,
    );
    expect(rawTitleOwnsTemporalWords).toMatchObject({
      state: 'matches',
      window: null,
      query: 'coffee',
    });
    expect(rawTitleOwnsTemporalWords.results[0].title).toBe('Morning Coffee');

    const lowercaseEmbeddedTitle = await searchEvents(
      { query: 'morning coffee kid friendly' },
      'is morning coffee kid friendly?',
      TUE_2PM,
    );
    expect(lowercaseEmbeddedTitle).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      window: null,
    });
    expect(lowercaseEmbeddedTitle.results[0].title).toBe('Morning Coffee');

    const modelMayOmitTitleWord = await searchEvents(
      { query: 'coffee kid friendly' },
      'is Morning Coffee kid friendly?',
      TUE_2PM,
    );
    expect(modelMayOmitTitleWord).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      window: null,
    });
    expect(modelMayOmitTitleWord.results[0].title).toBe('Morning Coffee');

    const punctuationVariantTitle = await searchEvents(
      { query: 'night swim circle Friday' },
      'night swim circle Friday',
      TUE_2PM,
    );
    expect(punctuationVariantTitle).toMatchObject({
      state: 'matches',
      relation: 'within-request',
      window: { label: 'Friday' },
    });
    expect(punctuationVariantTitle.results.map(row => row.title)).toEqual([
      'Night-Swim Circle',
    ]);

    const htmlPunctuationTitle = await searchEvents(
      { query: 'coffee consent' },
      'What time is Morning Coffee and Consent Talk?',
      TUE_2PM,
    );
    expect(htmlPunctuationTitle).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      window: null,
    });
    expect(htmlPunctuationTitle.results.map(row => row.title)).toEqual([
      'Morning Coffee &amp; Consent Talk',
    ]);

    const equivalentTitleSpellings = await searchEvents(
      { query: 'tea tarot Tuesday' },
      'What time is Tea & Tarot Tuesday?',
      TUE_2PM,
    );
    expect(equivalentTitleSpellings).toMatchObject({
      state: 'matches',
      relation: 'within-request',
      window: { label: 'Tuesday' },
    });
    expect(equivalentTitleSpellings.results.every(row =>
      row.title === 'Tea & Tarot' && row.date === '2026-09-01'
    )).toBe(true);

    const multipleTitles = await searchEvents(
      { query: 'morning coffee night swim' },
      'When are Morning Coffee and Night Swim?',
      TUE_2PM,
    );
    expect(new Set(multipleTitles.results.map(row => row.title))).toEqual(
      new Set(['Morning Coffee', 'Night Swim']),
    );

    // Qualifiers rank and narrow but NEVER manufacture an absence (binding
    // review C1): the model's semantic query is an untrusted hint, and one
    // stray appended word ('location', 'schedule', 'time') hard-ANDed onto
    // `title IN (…)` turned a named, present event into an app-voice
    // "nothing found" — measured 399/400 sampled pack titles flipped.
    const strayQualifier = await searchEvents(
      { query: 'morning coffee location' },
      'where is Morning Coffee',
      TUE_2PM,
    );
    expect(strayQualifier.state).toBe('matches');
    expect(strayQualifier.results.some(row => row.title === 'Morning Coffee')).toBe(true);

    // Contracted question leads name a title too (binding re-review, the
    // sibling of C5's root): "where's Morning Coffee" must reach the same
    // exact-title authority as "where is Morning Coffee".
    const contracted = await searchEvents(
      { query: 'morning coffee' },
      "where's Morning Coffee",
      TUE_2PM,
    );
    expect(contracted.state).toBe('matches');
    expect(contracted.results.some(row => row.title === 'Morning Coffee')).toBe(true);

    // A possessive title is named WITHOUT its apostrophe (binding review
    // C5): the tokenizer kept the trailing 's' as its own token, so
    // "devils punchbowl" never matched "Devil's Punchbowl" and the
    // camper's elided spelling lost exact-title authority.
    const elidedPossessive = await searchEvents(
      { query: 'devils punchbowl' },
      'where is devils punchbowl',
      TUE_2PM,
    );
    expect(elidedPossessive.state).toBe('matches');
    expect(
      elidedPossessive.results.some(row => row.title === "Devil's Punchbowl"),
    ).toBe(true);

    const commaSeparatedTitles = await searchEvents(
      { query: 'morning coffee night swim tea tarot' },
      'When are Morning Coffee, Night Swim, and Tea & Tarot?',
      TUE_2PM,
    );
    expect(new Set(commaSeparatedTitles.results.map(row => row.title))).toEqual(
      new Set(['Morning Coffee', 'Night Swim', 'Tea & Tarot', 'Tea and Tarot']),
    );

    const recurringTitleCannotStarveAnother = await searchEvents(
      { query: 'morning coffee man burn' },
      'When are Morning Coffee and Man Burn?',
      TUE_2PM,
    );
    expect(recurringTitleCannotStarveAnother.results.map(row => row.title)).toContain(
      'Man Burn',
    );

    const articleTitle = await searchEvents(
      { query: 'coffee' },
      'What time is the Morning Coffee?',
      TUE_2PM,
    );
    expect(articleTitle.results.every(row => row.title === 'Morning Coffee')).toBe(true);

    const accentedTitle = await searchEvents(
      { query: 'cafe' },
      'When is Café?',
      TUE_2PM,
    );
    expect(accentedTitle.results.map(row => row.title)).toEqual(['Café']);

    const temporalOnlyTitle = await searchEvents(
      { query: '' },
      'What time is Friday?',
      TUE_2PM,
    );
    expect(temporalOnlyTitle.results.map(row => row.title)).toEqual(['Friday']);

    const bareTemporalTitle = await searchEvents(
      { query: '' },
      'Friday?',
      TUE_2PM,
    );
    expect(bareTemporalTitle.results.map(row => row.title)).toEqual(['Friday']);

    expect(isEnabledEventTitleRequest('What is Morning Coffee?')).toBe(true);
    expect(isEnabledEventTitleRequest('What is yoga?')).toBe(false);

    const titleListWithPoliteLead = await searchEvents(
      { query: 'morning coffee night swim' },
      'Tell me when Morning Coffee and Night Swim are',
      TUE_2PM,
    );
    expect(new Set(titleListWithPoliteLead.results.map(row => row.title))).toEqual(
      new Set(['Morning Coffee', 'Night Swim']),
    );

    const titleListWithPoliteAuxiliary = await searchEvents(
      { query: 'morning coffee night swim' },
      'Could you show me Morning Coffee and Night Swim?',
      TUE_2PM,
    );
    expect(new Set(titleListWithPoliteAuxiliary.results.map(row => row.title))).toEqual(
      new Set(['Morning Coffee', 'Night Swim']),
    );

    await searchEvents(
      { query: 'catalog revision probe' },
      'When is Catalog Revision Probe?',
      TUE_2PM,
    );
    mockConn.execute(
      `INSERT INTO events
       (pack_id, title, desc, day, date, time_start, time_end, camp, location)
       VALUES (?, ?, '', 'Friday', '2026-09-04', '13:00', '14:00', '', '')`,
      ['time-filter-probe', 'Catalog Revision Probe'],
    );
    const insertedCatalogTitle = await searchEvents(
      { query: 'catalog revision probe' },
      'When is Catalog Revision Probe?',
      TUE_2PM,
    );
    expect(insertedCatalogTitle.results.map(row => row.title)).toEqual([
      'Catalog Revision Probe',
    ]);
    expect(isEnabledEventTitleRequest(
      'When is Catalog Revision Probe?',
    )).toBe(true);
    const catalogRow = mockConn.execute(
      "SELECT id FROM events WHERE title = 'Catalog Revision Probe'",
    ).rows?._array[0] as { id: number };
    mockConn.execute(
      "INSERT INTO hidden_items (kind, key, label, ts) VALUES ('event', ?, ?, ?)",
      [String(catalogRow.id), 'Catalog Revision Probe', '2026-09-01T00:00:00.000Z'],
    );
    const hiddenCatalogTitle = await searchEvents(
      { query: 'catalog revision probe' },
      'When is Catalog Revision Probe?',
      TUE_2PM,
    );
    expect(hiddenCatalogTitle.results).toEqual([]);
    expect(isEnabledEventTitleRequest(
      'When is Catalog Revision Probe?',
    )).toBe(false);
    mockConn.execute(
      "DELETE FROM hidden_items WHERE kind = 'event' AND key = ?",
      [String(catalogRow.id)],
    );
    expect(isEnabledEventTitleRequest(
      'When is Catalog Revision Probe?',
    )).toBe(true);
    mockConn.execute(
      "UPDATE packs SET enabled = 0 WHERE id = 'time-filter-probe'",
    );
    const disabledCatalogTitle = await searchEvents(
      { query: 'catalog revision probe' },
      'When is Catalog Revision Probe?',
      TUE_2PM,
    );
    expect(disabledCatalogTitle.results).toEqual([]);
    expect(isEnabledEventTitleRequest(
      'When is Catalog Revision Probe?',
    )).toBe(false);
    mockConn.execute(
      "UPDATE packs SET enabled = 1 WHERE id = 'time-filter-probe'",
    );
    expect(isEnabledEventTitleRequest(
      'When is Catalog Revision Probe?',
    )).toBe(true);

    const correctedTitleDay = replaceEventDayCoordinate(
      'What time is Tuesday Sunrise Set Tuesday morning?',
      'friday',
    );
    expect(correctedTitleDay).toBe(
      'What time is Tuesday Sunrise Set morning? friday',
    );
    const titleDayIsNotAStaleCoordinate = await searchEvents(
      { query: 'sunrise set' },
      correctedTitleDay,
      TUE_2PM,
    );
    expect(titleDayIsNotAStaleCoordinate).toMatchObject({
      state: 'matches',
      relation: 'within-request',
      window: { label: 'Friday morning' },
    });
    expect(titleDayIsNotAStaleCoordinate.results.map(row => row.title)).toEqual([
      'Tuesday Sunrise Set',
    ]);

    const oneWordCategoryIsNotIdentity = await searchEvents(
      { query: 'yoga beginners Friday' },
      'yoga for beginners Friday',
      TUE_2PM,
    );
    expect(oneWordCategoryIsNotIdentity.results.map(row => row.title)).toContain(
      'Beginner Yoga Flow',
    );

    const hiddenCalendarTitle = await searchEvents(
      { query: '' },
      'events on Friday',
      TUE_2PM,
    );
    expect(hiddenCalendarTitle).toMatchObject({
      state: 'matches',
      relation: 'within-request',
      window: { label: 'Friday' },
    });
    expect(hiddenCalendarTitle.results.every(row => row.title !== 'Friday')).toBe(true);

    const titleNeedsTokenBoundary = await searchEvents(
      { query: 'Morning Coffees Friday' },
      'Morning Coffees Friday',
      TUE_2PM,
    );
    expect(titleNeedsTokenBoundary.window).toEqual({
      startISO: '2026-09-04T05:00',
      endISO: '2026-09-04T12:00',
      label: 'Friday morning',
    });

    const nightTitle = await searchEvents(
      { query: 'Night Swim' },
      'Where is Night Swim?',
      TUE_2PM,
    );
    expect(nightTitle).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      window: null,
      query: 'night swim',
    });
    expect(nightTitle.results.length).toBeGreaterThan(0);
    expect(nightTitle.results.every(row => row.title === 'Night Swim')).toBe(true);

    const titledConstraint = await searchEvents(
      { query: 'Morning Coffee Friday' },
      'Morning Coffee Friday',
      TUE_2PM,
    );
    expect(titledConstraint).toMatchObject({
      state: 'matches',
      relation: 'within-request',
      window: { label: 'Friday' },
      query: 'morning coffee',
    });
    expect(titledConstraint.results.map(row => row.title)).toContain('Morning Coffee');
    expect(titledConstraint.results.every(row => row.date === '2026-09-04')).toBe(true);
  });

  test('exact-title qualifiers filter before recurring occurrences are capped', async () => {
    for (let index = 0; index < 6; index += 1) {
      const target = index === 5;
      mockConn.execute(
        `INSERT INTO events
         (pack_id, title, desc, day, date, time_start, time_end, camp, location)
         VALUES (?, 'Qualified Coffee', ?, ?, ?, '10:00', '11:00', ?, ?)`,
        [
          'time-filter-probe',
          target ? 'Coffee for kids' : 'General coffee hour',
          index === 5 ? 'Monday' : ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index],
          `2026-09-0${index + 1}`,
          target ? 'Family Camp' : 'Other Camp',
          target ? 'Center Camp' : 'Outer Playa',
        ],
      );
    }
    const outcome = await searchEvents(
      { query: 'Qualified Coffee Family Camp Center kids' },
      'When is Qualified Coffee at Center Camp for kids?',
      TUE_2PM,
    );
    expect(outcome).toMatchObject({
      state: 'matches',
      relation: 'unconstrained',
      window: null,
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      title: 'Qualified Coffee',
      camp: 'Family Camp',
      location: 'Center Camp',
      desc: 'Coffee for kids',
    });
  });

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
    expect(outcome).toMatchObject({
      state: 'matches',
      relation: 'within-request',
    });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results.every(e => e.date === '2026-09-02')).toBe(true);
    expect(outcome.results.every(e => e.time_start >= '05:00' && e.time_start <= '12:00'))
      .toBe(true);
  });
});
