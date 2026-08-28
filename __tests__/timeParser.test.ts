/**
 * Unit tests for the app-side time parser — the deterministic axis the
 * prototype says the model must never own (fabricated dates, dropped
 * "tomorrow"). Pure functions, fixed `now` values, no device needed.
 *
 * Burn-week 2026 reference: Sun 2026-08-30 .. Mon 2026-09-07.
 */

import {
  hasTemporalExpression,
  invalidUserDate,
  parseDayOnly,
  parseTimeWindow,
  stripEventDayCoordinates,
  stripEventTemporalCoordinates,
  validateModelDayHint,
  toISODate,
 asksWhichDay } from '../src/events/timeParser';

// Tuesday of burn week, 2:00pm local.
const TUE_2PM = new Date(2026, 8, 1, 14, 0); // 2026-09-01T14:00
// Monday of burn week (month rollover: tomorrow = Sep 1).
const MON_10AM = new Date(2026, 7, 31, 10, 0); // 2026-08-31T10:00
const PRE_SEASON = new Date(2026, 7, 14, 10, 0); // Friday 2026-08-14
const BURN_DATES = [
  '2026-08-30',
  '2026-08-31',
  '2026-09-01',
  '2026-09-02',
  '2026-09-03',
  '2026-09-04',
  '2026-09-05',
  '2026-09-06',
  '2026-09-07',
];

describe('parseTimeWindow', () => {
  // INTERROGATIVE DAY-WORDS ARE THE UNKNOWN (2026-08-17): "What night does
  // the Man burn?" read bare "night" as tonight and pinned question #1 of
  // the app to today's events, on every model. The asked-about word must
  // not become a window; anything else temporal in the sentence still does.
  test('"What night does the Man burn?" sets NO window', () => {
    const now = new Date(2026, 8, 1, 12, 0);
    expect(parseTimeWindow('What night does the Man burn?', now)).toBeNull();
    expect(parseTimeWindow('which day is the Temple burn', now)).toBeNull();
    expect(parseTimeWindow('what day does the gate open?', now)).toBeNull();
    expect(asksWhichDay('What night does the Man burn?')).toBe(true);
    expect(asksWhichDay('when is exodus?')).toBe(true);
    expect(asksWhichDay("what's happening tonight?")).toBe(false);
  });

  test('"what time is the burn tonight?" still keeps tonight', () => {
    const now = new Date(2026, 8, 5, 12, 0);
    const w = parseTimeWindow('what time is the burn tonight?', now);
    expect(w?.label).toBe('tonight');
    // "which day" + an explicit weekday: the named weekday is still a real
    // filter (two names in one sentence resolve by the parser's existing
    // rule — not this test's concern).
    expect(parseTimeWindow('which day is the Man burn, Saturday?', now)?.label).toBe('Saturday');
  });

  test('"tonight" spans 17:00 today to 02:00 tomorrow', () => {
    const w = parseTimeWindow("what's happening tonight?", TUE_2PM);
    expect(w).toEqual({
      startISO: '2026-09-01T17:00',
      endISO: '2026-09-02T02:00',
      label: 'tonight',
    });
  });

  test('a strict ISO date written by the user is an exact whole-day window', () => {
    expect(parseTimeWindow('events on 2026-09-03', TUE_2PM)).toEqual({
      startISO: '2026-09-03T00:00',
      endISO: '2026-09-03T23:59',
      label: '2026-09-03',
    });
  });

  test('a raw exact date may carry a time-of-day window', () => {
    expect(parseTimeWindow('morning events 2026-09-03', TUE_2PM)).toEqual({
      startISO: '2026-09-03T05:00',
      endISO: '2026-09-03T12:00',
      label: '2026-09-03 morning',
    });
  });

  test('an exact date combines with tonight and clock-time constraints', () => {
    expect(parseTimeWindow('events tonight on 2026-09-03', TUE_2PM)).toEqual({
      startISO: '2026-09-03T17:00',
      endISO: '2026-09-04T02:00',
      label: '2026-09-03 night',
    });
    expect(parseTimeWindow('events on 2026-09-03 at 9pm', TUE_2PM)).toEqual({
      startISO: '2026-09-03T21:00',
      endISO: '2026-09-03T21:00',
      label: '2026-09-03 21:00',
      timeStart: '21:00',
      timeEnd: '21:00',
    });
  });

  test('invalid calendar dates never fall through to another time constraint', () => {
    expect(invalidUserDate('yoga on 2026-02-31 morning', TUE_2PM)).toBe('2026-02-31');
    expect(invalidUserDate('yoga on February 31', TUE_2PM)).toBe('February 31');
    expect(invalidUserDate('yoga on February 29', TUE_2PM)).toBe('February 29');
    expect(invalidUserDate('yoga on 2026-09-03 and 2026-02-31', TUE_2PM)).toBe('2026-02-31');
    expect(parseTimeWindow('yoga on 2026-02-31 morning', TUE_2PM)).toBeNull();
  });

  test('playa addresses are not reinterpreted as clock constraints', () => {
    expect(parseTimeWindow('events at 7:30 & G', TUE_2PM)).toBeNull();
    expect(parseTimeWindow('events at 7:30 and G', TUE_2PM)).toBeNull();
    expect(parseTimeWindow('events at 7:30 on G', TUE_2PM)).toBeNull();
    expect(hasTemporalExpression('events at 7:30 & G')).toBe(false);
  });

  test('an address clock does not suppress a separate real clock', () => {
    expect(parseTimeWindow('music at 17:00 near 7:30 & G', TUE_2PM)).toMatchObject({
      startISO: '2026-09-01T17:00',
      endISO: '2026-09-01T17:00',
    });
  });

  test('a bare low-hour clock remains a time constraint, not a stripped keyword', () => {
    expect(parseTimeWindow('music 7:30 Friday', TUE_2PM)).toEqual({
      startISO: '2026-09-04T07:30',
      endISO: '2026-09-04T07:30',
      label: 'Friday 7:30',
      timeStart: '07:30',
      timeEnd: '07:30',
    });
    expect(stripEventTemporalCoordinates('music 7:30 Friday').trim()).toBe('music');
  });

  test('day clarification replacement preserves time but removes every prior day form', () => {
    expect(stripEventDayCoordinates('sunrise sets Tuesday morning')).toBe(
      'sunrise sets morning',
    );
    expect(stripEventDayCoordinates('sunrise sets this week at 9pm')).toBe(
      'sunrise sets at 9pm',
    );
    expect(stripEventDayCoordinates('music tonight')).toBe('music night');
    expect(stripEventDayCoordinates('music September 4 at 21:00')).toBe(
      'music at 21:00',
    );
  });

  test('modal May plus a capacity is not a named date', () => {
    expect(hasTemporalExpression('May 5 people attend the workshop?')).toBe(false);
    expect(parseTimeWindow('May 5 people attend the workshop?', TUE_2PM)).toBeNull();
  });

  test('detects numeric and named-date constraints for stale-row routing', () => {
    expect(hasTemporalExpression('yoga at 9pm')).toBe(true);
    expect(hasTemporalExpression('yoga on February 31')).toBe(true);
  });

  test('"tomorrow" is the next calendar day, full day', () => {
    const w = parseTimeWindow('sunrise yoga tomorrow', TUE_2PM);
    expect(w).toEqual({
      startISO: '2026-09-02T00:00',
      endISO: '2026-09-02T23:59',
      label: 'tomorrow',
    });
  });

  test('"tomorrow" rolls over a month boundary correctly', () => {
    const w = parseTimeWindow('anything on tomorrow?', MON_10AM);
    expect(w?.startISO).toBe('2026-09-01T00:00');
    expect(w?.endISO).toBe('2026-09-01T23:59');
  });

  test('"tomorrow night" combines day and time-of-day', () => {
    const w = parseTimeWindow('parties tomorrow night', TUE_2PM);
    expect(w).toEqual({
      startISO: '2026-09-02T17:00',
      endISO: '2026-09-03T02:00',
      label: 'tomorrow night',
    });
  });

  test('after-midnight clocks stay inside the named night window', () => {
    expect(parseTimeWindow('events tonight at 1am', TUE_2PM)).toMatchObject({
      startISO: '2026-09-02T01:00',
      endISO: '2026-09-02T01:00',
      eventDateISO: '2026-09-01',
    });
    expect(parseTimeWindow('events tomorrow night at 1am', TUE_2PM)).toMatchObject({
      startISO: '2026-09-03T01:00',
      endISO: '2026-09-03T01:00',
      eventDateISO: '2026-09-02',
    });
  });

  test('"today" is the current calendar day', () => {
    const w = parseTimeWindow('kids activities today', TUE_2PM);
    expect(w?.startISO).toBe('2026-09-01T00:00');
    expect(w?.endISO).toBe('2026-09-01T23:59');
    expect(w?.label).toBe('today');
  });

  test('a weekday names its next occurrence; today counts', () => {
    // now IS Tuesday -> "tuesday" means today, not next week.
    const w = parseTimeWindow('pancake breakfast on Tuesday', TUE_2PM);
    expect(w?.startISO).toBe('2026-09-01T00:00');
    expect(w?.label).toBe('Tuesday');
  });

  test('a future weekday resolves within the next 7 days', () => {
    const w = parseTimeWindow('welding workshop thursday', TUE_2PM);
    expect(w?.startISO).toBe('2026-09-03T00:00');
    expect(w?.label).toBe('Thursday');
  });

  test('weekday abbreviations work ("thu")', () => {
    const w = parseTimeWindow('anything thu?', TUE_2PM);
    expect(w?.startISO).toBe('2026-09-03T00:00');
  });

  test('pre-season weekday anchors to the first enabled event date', () => {
    const w = parseTimeWindow(
      'Wednesday morning yoga',
      PRE_SEASON,
      BURN_DATES,
    );
    expect(w).toEqual({
      startISO: '2026-09-02T05:00',
      endISO: '2026-09-02T12:00',
      label: 'Wednesday morning',
    });
    expect(parseTimeWindow('anything wed?', PRE_SEASON, BURN_DATES)?.startISO)
      .toBe('2026-09-02T00:00');
  });

  test('an archival prior season does not disable next-season weekday anchoring', () => {
    const withArchive = ['2025-08-25', ...BURN_DATES];
    expect(
      parseTimeWindow('Wednesday yoga', PRE_SEASON, withArchive)?.startISO,
    ).toBe('2026-09-02T00:00');
  });

  test('an unmatched calendar weekday safely keeps ordinary next-weekday behavior', () => {
    const onlyMonday = ['2026-08-31'];
    expect(
      parseTimeWindow('Wednesday yoga', PRE_SEASON, onlyMonday)?.startISO,
    ).toBe('2026-08-19T00:00');
  });

  test('post-season weekday never jumps backward into the event calendar', () => {
    const after = new Date(2026, 8, 10, 10, 0); // Thursday after the burn
    expect(
      parseTimeWindow('Wednesday yoga', after, BURN_DATES)?.startISO,
    ).toBe('2026-09-16T00:00');
  });

  test('"saturday night" crosses midnight', () => {
    const w = parseTimeWindow('burns saturday night', TUE_2PM);
    expect(w).toEqual({
      startISO: '2026-09-05T17:00',
      endISO: '2026-09-06T02:00',
      label: 'Saturday night',
    });
  });

  test('"this week" spans 7 days from today', () => {
    const w = parseTimeWindow('what art is up this week', TUE_2PM);
    expect(w?.startISO).toBe('2026-09-01T00:00');
    expect(w?.endISO).toBe('2026-09-07T23:59');
  });

  test('named dayparts remain daily constraints across this/all week', () => {
    expect(parseTimeWindow('morning yoga this week', TUE_2PM)).toEqual({
      startISO: '2026-09-01T05:00',
      endISO: '2026-09-07T12:00',
      label: 'this week morning',
      timeStart: '05:00',
      timeEnd: '12:00',
    });
    expect(parseTimeWindow('parties all week at night', TUE_2PM)).toEqual({
      startISO: '2026-09-01T17:00',
      endISO: '2026-09-08T02:00',
      label: 'this week night',
      timeStart: '17:00',
      timeEnd: '02:00',
    });
  });

  test('bare "at dawn" uses today while the window has not passed', () => {
    const early = new Date(2026, 8, 1, 5, 0);
    const w = parseTimeWindow('trash fence at dawn', early);
    expect(w).toEqual({
      startISO: '2026-09-01T04:30',
      endISO: '2026-09-01T08:00',
      label: 'dawn',
    });
  });

  test('bare "in the morning" rolls to tomorrow once today\'s window passed', () => {
    const w = parseTimeWindow('yoga in the morning', TUE_2PM); // 14:00 > 12:00
    expect(w?.startISO).toBe('2026-09-02T05:00');
    expect(w?.endISO).toBe('2026-09-02T12:00');
  });

  test('"sunrise" is a keyword, not the weekday "sun"', () => {
    expect(parseTimeWindow('sunrise yoga', TUE_2PM)).toBeNull();
  });

  test('weekday fragments inside words do not match', () => {
    // "demonstration" contains "mon"; "saturated" contains "sat".
    expect(parseTimeWindow('fire demonstration, saturated colors', TUE_2PM)).toBeNull();
  });

  test('no temporal expression returns null', () => {
    expect(parseTimeWindow('naked pub crawl - when?', TUE_2PM)).toBeNull();
    expect(parseTimeWindow('where can I fix my bike', TUE_2PM)).toBeNull();
    expect(parseTimeWindow('', TUE_2PM)).toBeNull();
  });
});

describe('parseDayOnly', () => {
  test.each([
    ['Tuesday', 'tuesday'],
    ['tues.', 'tuesday'],
    ['Tomorrow!', 'tomorrow'],
    ['tmrw', 'tomorrow'],
    [' tonight? ', 'tonight'],
    ['2026-09-03', '2026-09-03'],
    ['2026-02-31', '2026-02-31'],
    ['September 3', 'september 3'],
  ])('accepts one day word or ISO-shaped clarification with harmless punctuation: %s', (text, day) => {
    expect(parseDayOnly(text)).toBe(day);
  });

  test.each([
    'on Tuesday',
    'Tuesday please',
    'Tuesday - any sunrise sets?',
    'this week',
    'September 1 please',
    'sunrise',
    '',
  ])('rejects longer or unrelated text: %s', text => {
    expect(parseDayOnly(text)).toBeNull();
  });
});

describe('validateModelDayHint (untrusted model `day` argument)', () => {
  test('accepts whitelisted day words', () => {
    expect(validateModelDayHint('tomorrow', TUE_2PM)?.startISO).toBe('2026-09-02T00:00');
    expect(validateModelDayHint('TUESDAY', TUE_2PM)?.startISO).toBe('2026-09-01T00:00');
    expect(validateModelDayHint('tonight', TUE_2PM)?.label).toBe('tonight');
    expect(validateModelDayHint('this week', TUE_2PM)?.endISO).toBe('2026-09-07T23:59');
  });

  test('whitelisted weekday hints use the same event-season calendar', () => {
    expect(
      validateModelDayHint('Wednesday', PRE_SEASON, BURN_DATES)?.startISO,
    ).toBe('2026-09-02T00:00');
  });

  test('rejects fabricated calendar dates (the prototype failure mode)', () => {
    expect(validateModelDayHint('2026-07-01', TUE_2PM)).toBeNull();
    expect(validateModelDayHint('2026-07-21', TUE_2PM)).toBeNull();
    expect(validateModelDayHint('sept 3', TUE_2PM)).toBeNull();
    expect(validateModelDayHint('9/3', TUE_2PM)).toBeNull();
  });

  test('rejects anything off-whitelist', () => {
    expect(validateModelDayHint('someday', TUE_2PM)).toBeNull();
    expect(validateModelDayHint('during the burn', TUE_2PM)).toBeNull();
    expect(validateModelDayHint('', TUE_2PM)).toBeNull();
    expect(validateModelDayHint(undefined, TUE_2PM)).toBeNull();
    expect(validateModelDayHint(null, TUE_2PM)).toBeNull();
  });
});

describe('toISODate', () => {
  test('pads month and day', () => {
    expect(toISODate(new Date(2026, 8, 1))).toBe('2026-09-01');
    expect(toISODate(new Date(2026, 11, 25))).toBe('2026-12-25');
  });
});
