/**
 * Recurrence detection for event cards (owner ask 2026-08-19: "cards that
 * repeat daily should say so" — the 'BUI Tattoo Stamp' card read as one-day
 * when the listing actually runs every day).
 *
 * The events table has NO recurrence field: loaders (iBurn/playaevents
 * shape) emit ONE ROW PER DAY for a repeating listing, so recurrence is a
 * property of the DATA, not the row. We detect it the only honest way: the
 * same listing (title + time + where) appearing on enough distinct dates
 * inside one pack.
 *
 * Two rules keep the badge truthful:
 *  - Identity includes time and place (title+camp+location+time_start+
 *    time_end). Two genuinely different events can share a title; one
 *    listing never changes its time/place mid-week.
 *  - The threshold is 5 distinct dates. BRC's core event window is 7 days
 *    (pre-Sunday through Labor Day), so 5 is "effectively daily" while a
 *    weekend-plus-Friday workshop (≤4 dates) stays unbadged.
 */

import type { EventRow } from '../types';

/** Distinct dates on which the same listing must appear to read as daily. */
export const DAILY_THRESHOLD = 5;

/** The group key: what makes two rows "the same listing on another day". */
export function recurrenceKey(ev: EventRow): string {
  return [
    ev.title.trim().toLowerCase(),
    ev.time_start,
    ev.time_end,
    ev.camp.trim().toLowerCase(),
    ev.location.trim().toLowerCase(),
  ].join('\u001f'); // unit separator — a bare join lets adjacent fields collide
}

/**
 * The recurrence map for a set of rows (typically one query's result set):
 * key -> number of distinct dates. Pure and exported so tests can drive it
 * without SQL; the screen-side callers feed it their already-fetched rows
 * and look up each card's key.
 */
export function recurrenceCounts(rows: EventRow[]): Map<string, number> {
  const datesByKey = new Map<string, Set<string>>();
  for (const ev of rows) {
    const key = recurrenceKey(ev);
    let dates = datesByKey.get(key);
    if (!dates) {
      dates = new Set();
      datesByKey.set(key, dates);
    }
    dates.add(ev.date);
  }
  const counts = new Map<string, number>();
  for (const [key, dates] of datesByKey) {
    counts.set(key, dates.size);
  }
  return counts;
}

/** True when this event's listing appears on enough distinct dates. */
export function isDaily(ev: EventRow, counts: Map<string, number>): boolean {
  return (counts.get(recurrenceKey(ev)) ?? 0) >= DAILY_THRESHOLD;
}
