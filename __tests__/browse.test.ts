/**
 * Right Now day/time picker — pure helpers. The picker's buckets must be
 * disjoint, cover the clock, and label chips from the data's own dates.
 */

import {
  inTodWindow,
  timeToMinutes,
  dayChipLabel,
  dayHeading,
  TOD_WINDOWS,
  TOD_SEGMENTS,
  TimeOfDayKey,
} from '../src/rightnow/browse';

describe('timeToMinutes', () => {
  it('parses HH:MM and rejects blanks/garbage', () => {
    expect(timeToMinutes('06:30')).toBe(390);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes('6:30')).toBeNull();
    expect(timeToMinutes('noonish')).toBeNull();
  });
});

describe('inTodWindow', () => {
  it("puts a start in exactly one bucket ('all' aside) for every hour", () => {
    for (let h = 0; h < 24; h++) {
      const t = `${String(h).padStart(2, '0')}:30`;
      const hits = (Object.keys(TOD_WINDOWS) as TimeOfDayKey[]).filter(k =>
        inTodWindow(t, k),
      );
      // 02:30-04:59 belongs to night (wrap); every hour maps to exactly one.
      expect(hits).toHaveLength(1);
    }
  });

  it('maps the obvious cases', () => {
    expect(inTodWindow('06:30', 'morning')).toBe(true);
    expect(inTodWindow('13:00', 'afternoon')).toBe(true);
    expect(inTodWindow('18:00', 'evening')).toBe(true);
    expect(inTodWindow('22:00', 'night')).toBe(true);
    expect(inTodWindow('01:00', 'night')).toBe(true); // wraps past midnight
    expect(inTodWindow('01:00', 'morning')).toBe(false);
  });

  it("matches everything under 'all', untimed events under 'all' only", () => {
    expect(inTodWindow('23:59', 'all')).toBe(true);
    expect(inTodWindow('', 'all')).toBe(true);
    expect(inTodWindow('', 'morning')).toBe(false);
    expect(inTodWindow('', 'night')).toBe(false);
  });
});

describe('chip + heading labels', () => {
  it('labels chips from ISO dates', () => {
    expect(dayChipLabel('2026-08-30')).toBe('Sun 30');
    expect(dayChipLabel('2026-09-01')).toBe('Tue 1');
    expect(dayChipLabel('2026-09-07')).toBe('Mon 7');
  });

  it('builds day headings', () => {
    expect(dayHeading('2026-08-30')).toBe('Sunday, Aug 30');
    expect(dayHeading('2026-09-01')).toBe('Tuesday, Sep 1');
  });

  it('offers exactly the five coarse segments, all-day first', () => {
    expect(TOD_SEGMENTS.map(s => s.key)).toEqual([
      'all',
      'morning',
      'afternoon',
      'evening',
      'night',
    ]);
  });
});
