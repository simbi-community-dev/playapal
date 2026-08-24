/**
 * Daily-recurrence detection (owner ask 2026-08-19: a card for a listing
 * that runs every day must SAY so, not read as a one-day event). The events
 * table carries no recurrence field — loaders emit one row per day — so the
 * badge is derived from the data: same listing (title+time+where) on enough
 * distinct dates.
 */
import {
  DAILY_THRESHOLD,
  isDaily,
  recurrenceCounts,
  recurrenceKey,
} from '../src/rightnow/recurrence';
import type { EventRow } from '../src/types';

const ev = (over: Partial<EventRow>): EventRow => ({
  id: 1,
  title: 'BUI Tattoo Stamp',
  desc: '',
  day: 'Monday',
  date: '2026-08-31',
  time_start: '14:00',
  time_end: '16:00',
  camp: 'BUI Camp',
  location: '7:30 & G',
  ...over,
});

/** One row per date for the same listing, like the loaders emit. */
const listingAcross = (dates: string[], over: Partial<EventRow> = {}): EventRow[] =>
  dates.map((date, i) => ev({ id: i + 1, date, ...over }));

const SEVEN_DAYS = [
  '2026-08-30',
  '2026-08-31',
  '2026-09-01',
  '2026-09-02',
  '2026-09-03',
  '2026-09-04',
  '2026-09-05',
];

describe('recurrenceKey', () => {
  it('ignores date/day/id — same listing on another day shares the key', () => {
    const mon = ev({ id: 1, date: '2026-08-31', day: 'Monday' });
    const tue = ev({ id: 2, date: '2026-09-01', day: 'Tuesday' });
    expect(recurrenceKey(mon)).toBe(recurrenceKey(tue));
  });

  it('treats case and padding differences as the same listing', () => {
    const a = ev({ title: 'BUI Tattoo Stamp', camp: 'BUI Camp' });
    const b = ev({ title: 'bui tattoo stamp', camp: ' bui camp ' });
    expect(recurrenceKey(a)).toBe(recurrenceKey(b));
  });

  it('separates same-title events with different times or places', () => {
    const base = ev({});
    expect(recurrenceKey(ev({ time_start: '20:00' }))).not.toBe(recurrenceKey(base));
    expect(recurrenceKey(ev({ location: '3:00 & C' }))).not.toBe(recurrenceKey(base));
    expect(recurrenceKey(ev({ camp: 'Other Camp' }))).not.toBe(recurrenceKey(base));
  });
});

describe('recurrenceCounts + isDaily', () => {
  it('badges a listing on 7 dates as daily from ANY of its rows', () => {
    const rows = listingAcross(SEVEN_DAYS);
    const counts = recurrenceCounts(rows);
    // Viewed from the FIRST day, the listing is still daily — the whole-
    // corpus count is what matters, not the viewed day's slice.
    expect(isDaily(rows[0], counts)).toBe(true);
    expect(isDaily(rows[6], counts)).toBe(true);
  });

  it(`badges exactly at the ${DAILY_THRESHOLD}-date threshold`, () => {
    const rows = listingAcross(SEVEN_DAYS.slice(0, DAILY_THRESHOLD));
    expect(isDaily(rows[0], recurrenceCounts(rows))).toBe(true);
  });

  it('does NOT badge a weekend-plus-Friday listing (4 dates)', () => {
    const rows = listingAcross(SEVEN_DAYS.slice(0, DAILY_THRESHOLD - 1));
    expect(isDaily(rows[0], recurrenceCounts(rows))).toBe(false);
  });

  it('a one-off event is never daily', () => {
    const rows = [ev({})];
    expect(isDaily(rows[0], recurrenceCounts(rows))).toBe(false);
  });

  it('duplicate rows on the SAME date do not inflate the count', () => {
    // Defensive: a loader bug re-inserting a day must not manufacture
    // recurrence — distinct DATES are counted, not rows.
    const rows = [
      ...listingAcross(['2026-08-31']),
      ...listingAcross(['2026-08-31']),
      ...listingAcross(['2026-09-01']),
    ];
    expect(recurrenceCounts(rows).get(recurrenceKey(rows[0]))).toBe(2);
  });

  it('two different listings each keep their own count', () => {
    const daily = listingAcross(SEVEN_DAYS);
    const oneOff = [ev({ id: 99, title: 'One Night Only', date: '2026-09-02' })];
    const counts = recurrenceCounts([...daily, ...oneOff]);
    expect(isDaily(daily[0], counts)).toBe(true);
    expect(isDaily(oneOff[0], counts)).toBe(false);
  });
});
