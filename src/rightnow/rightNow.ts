/**
 * The Right Now surface — ported in shape from iBurn's RightNowWorkflow
 * (iBurn-iOS Docs/2026-05-29-ai-guide-right-now-overhaul.md, MPL-2.0):
 * their field-tested lesson is that on-playa the ONE flow that matters is
 * "what's near me happening now, and what next", with chat demoted to a
 * secondary surface.
 *
 * Our v0 keeps the gather step fully DETERMINISTIC (SQL + device clock — no
 * model required, so the screen works before a GGUF is even picked). The
 * LLM curation+pitch layer can sit on top later via the chat loop.
 *
 * "Now" is always an injectable parameter (iBurn's Date.present pattern) so
 * every path is testable off-device.
 */

import { EVENTS_NOT_HIDDEN_SQL } from '../facts/hiddenItems';
import type { EventRow } from '../types';
import { getDb } from '../events/db';
import { toISODate } from '../events/timeParser';
import { escapeLike } from '../events/ftsQuery';
import {
  playaWalkMinutes,
  playaWalkMinutesFromPolar,
  type PolarFt,
} from './playaWalk';
import { inTodWindow, TodSelection, TOD_WINDOWS } from './browse';
import { isDaily, recurrenceCounts } from './recurrence';

export interface RightNowItem {
  event: EventRow;
  /** Approx. walk minutes from the anchor address; null when unparseable. */
  walkMinutes: number | null;
  /** True when the same listing repeats on enough dates to read as daily. */
  daily: boolean;
}

export interface RightNowResult {
  /** Happening at this moment. */
  now: RightNowItem[];
  /** Starting within the look-ahead window. */
  next: RightNowItem[];
}

/**
 * Suggestion chips (iBurn Vibe/SuggestionChip pattern): label -> keyword
 * terms. Terms feed the same LIKE/keyword matching as search_events.
 */
export const VIBE_CHIPS: { label: string; terms: string[] }[] = [
  { label: 'Coffee & tea', terms: ['coffee', 'tea', 'espresso'] },
  { label: 'Food', terms: ['food', 'breakfast', 'pancake', 'brunch', 'grilled', 'dinner'] },
  { label: 'Music', terms: ['music', 'disco', 'dj', 'party', 'sound'] },
  { label: 'Chill', terms: ['yoga', 'quiet', 'tea', 'sound bath', 'nap', 'meditation'] },
  { label: 'Kids', terms: ['kids', 'family', 'children'] },
  { label: 'Make things', terms: ['workshop', 'build', 'welding', 'craft', 'repair'] },
];

/** v0 walk-time anchor until we read GPS: everyone knows where Center Camp is. */
export const WALK_ANCHOR = 'Center Camp';

const DEFAULT_LOOKAHEAD_HOURS = 3;

const hm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Minutes since local midnight for "HH:MM"; null for blank/invalid. */
function minutes(t: string): number | null {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function isHappeningNow(ev: EventRow, todayISO: string, yesterdayISO: string, nowMin: number): boolean {
  const start = minutes(ev.time_start);
  if (start === null) {
    return false;
  }
  const end = minutes(ev.time_end);
  if (ev.date === todayISO) {
    if (end === null) {
      // Open-ended: call it "now" for 2 hours after start.
      return nowMin >= start && nowMin <= start + 120;
    }
    if (end >= start) {
      return nowMin >= start && nowMin <= end;
    }
    return nowMin >= start; // crosses midnight, started today
  }
  if (ev.date === yesterdayISO && end !== null && end < (start ?? 0)) {
    return nowMin <= end; // started yesterday, still running past midnight
  }
  return false;
}

/**
 * Gather "happening now" + "starting soon" events, optionally filtered by
 * vibe keywords, annotated with walk minutes from the anchor.
 */
export function rightNow(
  opts: {
    vibeTerms?: string[];
    lookaheadHours?: number;
    anchor?: string;
    /** Exact polar anchor (live GPS via src/geo/brcGeo). Wins over `anchor`. */
    anchorPolar?: PolarFt;
  } = {},
  now: Date = new Date(),
): RightNowResult {
  const conn = getDb();
  const today = toISODate(now);
  const yesterday = toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const tomorrow = toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const anchor = opts.anchor ?? WALK_ANCHOR;
  const lookahead = (opts.lookaheadHours ?? DEFAULT_LOOKAHEAD_HOURS) * 60;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const params: (string | number)[] = [yesterday, today, tomorrow];
  let sql =
    'SELECT e.* FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 ' +
    'WHERE e.date IN (?, ?, ?) AND ' + EVENTS_NOT_HIDDEN_SQL;
  const terms = (opts.vibeTerms ?? []).filter(t => t.trim().length > 0);
  if (terms.length > 0) {
    const groups = terms.map(term => {
      const like = `%${escapeLike(term.toLowerCase())}%`;
      params.push(like, like, like);
      return "(e.title LIKE ? ESCAPE '\\' OR e.desc LIKE ? ESCAPE '\\' OR e.camp LIKE ? ESCAPE '\\')";
    });
    sql += ` AND (${groups.join(' OR ')})`;
  }
  sql += ' ORDER BY e.date, e.time_start';
  const rows = (conn.execute(sql, params).rows?._array ?? []) as EventRow[];

  // Recurrence is a property of the WHOLE listing, not the 3-day window:
  // count same-listing dates across every enabled pack (no date filter) so
  // a daily listing is still "Daily" when viewed from its first day.
  const allRows = (conn
    .execute(
      'SELECT e.* FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 WHERE ' +
        EVENTS_NOT_HIDDEN_SQL,
      [],
    )
    .rows?._array ?? []) as EventRow[];
  const counts = recurrenceCounts(allRows);

  const annotate = (ev: EventRow): RightNowItem => ({
    event: ev,
    walkMinutes: opts.anchorPolar
      ? playaWalkMinutesFromPolar(opts.anchorPolar, ev.location)
      : playaWalkMinutes(anchor, ev.location),
    daily: isDaily(ev, counts),
  });

  const nowItems: RightNowItem[] = [];
  const nextItems: { item: RightNowItem; startsInMin: number }[] = [];
  for (const ev of rows) {
    if (isHappeningNow(ev, today, yesterday, nowMin)) {
      nowItems.push(annotate(ev));
      continue;
    }
    const start = minutes(ev.time_start);
    if (start === null) {
      continue;
    }
    const dayOffset = ev.date === today ? 0 : ev.date === tomorrow ? 24 * 60 : null;
    if (dayOffset === null) {
      continue;
    }
    const startsIn = start + dayOffset - nowMin;
    if (startsIn > 0 && startsIn <= lookahead) {
      nextItems.push({ item: annotate(ev), startsInMin: startsIn });
    }
  }
  nextItems.sort((a, b) => a.startsInMin - b.startsInMin);
  return {
    now: nowItems.slice(0, 5),
    next: nextItems.slice(0, 5).map(n => n.item),
  };
}

/** Cap for the day/week browse list (deterministic, chronological). */
const BROWSE_LIMIT = 60;

/**
 * Deterministic day/time browse for the Right Now picker: all events on the
 * picked day (or every day for 'week'), filtered to a coarse time-of-day
 * bucket, chronological, with walk minutes. No model involved.
 *
 * `night` wraps past midnight: picking "Sun night" also surfaces events that
 * START before 05:00 on the following date (late-night spillover).
 */
export function browseEvents(
  sel: { day: string | 'week'; tod: TodSelection },
  opts: { vibeTerms?: string[]; anchor?: string; anchorPolar?: PolarFt } = {},
): RightNowItem[] {
  const conn = getDb();
  const anchor = opts.anchor ?? WALK_ANCHOR;
  const params: (string | number)[] = [];
  let sql =
    'SELECT e.* FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1';
  const where: string[] = [EVENTS_NOT_HIDDEN_SQL];

  const nightSpill = sel.tod === 'night' && sel.day !== 'week';
  if (sel.day !== 'week') {
    if (nightSpill) {
      const [y, m, d] = sel.day.split('-').map(Number);
      const nextDay = toISODate(new Date(y, m - 1, d + 1));
      where.push('e.date IN (?, ?)');
      params.push(sel.day, nextDay);
    } else {
      where.push('e.date = ?');
      params.push(sel.day);
    }
  }
  const terms = (opts.vibeTerms ?? []).filter(t => t.trim().length > 0);
  if (terms.length > 0) {
    const groups = terms.map(term => {
      const like = `%${escapeLike(term.toLowerCase())}%`;
      params.push(like, like, like);
      return "(e.title LIKE ? ESCAPE '\\' OR e.desc LIKE ? ESCAPE '\\' OR e.camp LIKE ? ESCAPE '\\')";
    });
    where.push(`(${groups.join(' OR ')})`);
  }
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }
  sql += ' ORDER BY e.date, e.time_start';
  const rows = (conn.execute(sql, params).rows?._array ?? []) as EventRow[];

  // Same recurrence counting as rightNow(): whole-listing property, counted
  // over every enabled pack, not the picked day's slice.
  const allRows = (conn
    .execute(
      'SELECT e.* FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 WHERE ' +
        EVENTS_NOT_HIDDEN_SQL,
      [],
    )
    .rows?._array ?? []) as EventRow[];
  const counts = recurrenceCounts(allRows);

  const filtered = rows.filter(ev => {
    if (nightSpill && ev.date !== sel.day) {
      // Spillover date: only the wee-hours tail (start before the wrap end).
      const start = minutes(ev.time_start);
      return start !== null && start < TOD_WINDOWS.night.endMin;
    }
    return inTodWindow(ev.time_start, sel.tod);
  });
  return filtered.slice(0, BROWSE_LIMIT).map(ev => ({
    event: ev,
    walkMinutes: opts.anchorPolar
      ? playaWalkMinutesFromPolar(opts.anchorPolar, ev.location)
      : playaWalkMinutes(anchor, ev.location),
    daily: isDaily(ev, counts),
  }));
}

/**
 * The Faves itinerary: every favorited event still present in an enabled
 * pack, chronological, walk-annotated — the same row shape the browse
 * renderer already draws with day headings. Join is on the NATURAL key
 * (title+date+time_start, src/events/favorites.ts), so hearts survive pack
 * reinstalls; a favorite whose event left the data simply does not join.
 */
export function favoriteEvents(
  opts: { anchor?: string; anchorPolar?: PolarFt } = {},
): RightNowItem[] {
  const conn = getDb();
  const anchor = opts.anchor ?? WALK_ANCHOR;
  const rows = (conn
    .execute(
      'SELECT e.* FROM events e ' +
        'JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 ' +
        'JOIN event_favorites f ON f.title = e.title AND f.date = e.date AND f.time_start = e.time_start ' +
        'WHERE ' + EVENTS_NOT_HIDDEN_SQL +
        ' ORDER BY e.date, e.time_start',
      [],
    )
    .rows?._array ?? []) as EventRow[];

  const allRows = (conn
    .execute(
      'SELECT e.* FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 WHERE ' +
        EVENTS_NOT_HIDDEN_SQL,
      [],
    )
    .rows?._array ?? []) as EventRow[];
  const counts = recurrenceCounts(allRows);

  return rows.map(ev => ({
    event: ev,
    walkMinutes: opts.anchorPolar
      ? playaWalkMinutesFromPolar(opts.anchorPolar, ev.location)
      : playaWalkMinutes(anchor, ev.location),
    daily: isDaily(ev, counts),
  }));
}

/** "in 25 min" / "in 2h 05" label for a next-up event. */
export function startsInLabel(ev: EventRow, now: Date): string {
  const start = minutes(ev.time_start);
  if (start === null) {
    return '';
  }
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayOffset = ev.date === toISODate(now) ? 0 : 24 * 60;
  const delta = start + dayOffset - nowMin;
  if (delta <= 0) {
    return 'now';
  }
  if (delta < 60) {
    return `in ${delta} min`;
  }
  return `in ${Math.floor(delta / 60)}h ${String(delta % 60).padStart(2, '0')}`;
}

export { hm as formatHM };
