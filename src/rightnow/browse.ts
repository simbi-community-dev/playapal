/**
 * Pure helpers for the Right Now day/time picker (no SQLite imports, fully
 * unit-testable). The picker lets one tap switch from "now" to any burn-week
 * day (chips derived from the DATES ACTUALLY IN THE DATA, so they stay
 * correct for any pack) plus a coarse time-of-day, with "now" the default.
 */

import { weekdayName } from '../events/timeParser';

export type TimeOfDayKey = 'morning' | 'afternoon' | 'evening' | 'night';
export type TodSelection = TimeOfDayKey | 'all';

/** Segment order for the UI row. */
export const TOD_SEGMENTS: { key: TodSelection; label: string }[] = [
  { key: 'all', label: 'All day' },
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
  { key: 'night', label: 'Night' },
];

/**
 * Coarse picker windows in minutes-since-midnight, [start, end). Non-
 * overlapping, and together with `night` wrapping past midnight they cover
 * the full 24 h: morning 05-12, afternoon 12-17, evening 17-21, night 21-05.
 * (Chat keeps its own colloquial windows in timeParser — "tonight" there
 * deliberately stretches from 17:00; a PICKER wants disjoint buckets.)
 */
export const TOD_WINDOWS: Record<
  TimeOfDayKey,
  { startMin: number; endMin: number; wraps: boolean }
> = {
  morning: { startMin: 5 * 60, endMin: 12 * 60, wraps: false },
  afternoon: { startMin: 12 * 60, endMin: 17 * 60, wraps: false },
  evening: { startMin: 17 * 60, endMin: 21 * 60, wraps: false },
  night: { startMin: 21 * 60, endMin: 5 * 60, wraps: true },
};

/** Minutes since local midnight for "HH:MM"; null for blank/invalid. */
export function timeToMinutes(t: string): number | null {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/**
 * Does an event STARTING at `timeStart` fall in the picked time-of-day
 * bucket? Untimed events (no parseable start) only surface under 'all'.
 */
export function inTodWindow(timeStart: string, tod: TodSelection): boolean {
  if (tod === 'all') {
    return true;
  }
  const start = timeToMinutes(timeStart);
  if (start === null) {
    return false;
  }
  const w = TOD_WINDOWS[tod];
  if (w.wraps) {
    return start >= w.startMin || start < w.endMin;
  }
  return start >= w.startMin && start < w.endMin;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Compact chip label for an ISO date: "2026-08-30" -> "Sun 30". */
export function dayChipLabel(dateISO: string): string {
  return `${weekdayName(dateISO).slice(0, 3)} ${parseInt(dateISO.slice(8, 10), 10)}`;
}

/** Section heading for a browse day: "2026-08-30" -> "Sunday, Aug 30". */
export function dayHeading(dateISO: string): string {
  const month = MONTHS_SHORT[parseInt(dateISO.slice(5, 7), 10) - 1] ?? '';
  return `${weekdayName(dateISO)}, ${month} ${parseInt(dateISO.slice(8, 10), 10)}`;
}
