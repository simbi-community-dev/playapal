/**
 * APP-SIDE temporal parsing.
 *
 * Prototype finding (toolcall-proto-results.md, 2026-08-13): the model's `day`
 * argument is untrustworthy — "tomorrow" is never passed through with thinking
 * on, and fabricated plausible ISO dates appear ~40% of the time on vague
 * queries despite an explicit "NEVER invent a calendar date" instruction.
 *
 * Therefore the time window for an event search is ALWAYS derived here, from
 * the raw user text plus the device clock. The model's `day` argument is used
 * only as a whitelisted fallback hint (see validateModelDayHint) and an ISO
 * date from the model is always discarded.
 *
 * Pure functions — no Date.now() inside; `now` is always a parameter, so this
 * module is fully unit-testable.
 */

import type { DateWindow } from '../types';

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

// Abbreviations map to full weekday names. Matched with word boundaries so
// "sunrise" does not match "sun" and "money" does not match "mon".
const WEEKDAY_ABBREV: Record<string, string> = {
  sun: 'sunday',
  mon: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  fri: 'friday',
  sat: 'saturday',
};

/** A strict one-turn clarification answer: one day word plus harmless edge
 * punctuation. Longer phrases stay in the ordinary model path. */
export function parseDayOnly(text: string): string | null {
  const day = text
    .trim()
    .toLowerCase()
    .replace(/^[\s,.!?;:—–-]+|[\s,.!?;:—–-]+$/g, '');
  if (day === 'today' || day === 'tonight') {
    return day;
  }
  if (day === 'tomorrow' || day === 'tmrw') {
    return 'tomorrow';
  }
  if ((WEEKDAYS as readonly string[]).includes(day)) {
    return day;
  }
  return WEEKDAY_ABBREV[day] ?? null;
}

interface TimeOfDay {
  label: string;
  startHM: [number, number];
  endHM: [number, number];
  /** True when the window crosses midnight into the next calendar day. */
  crossesMidnight: boolean;
}

const TIMES_OF_DAY: Record<string, TimeOfDay> = {
  dawn: { label: 'dawn', startHM: [4, 30], endHM: [8, 0], crossesMidnight: false },
  sunrise__NOT_A_KEY: { label: '', startHM: [0, 0], endHM: [0, 0], crossesMidnight: false },
  morning: { label: 'morning', startHM: [5, 0], endHM: [12, 0], crossesMidnight: false },
  afternoon: { label: 'afternoon', startHM: [12, 0], endHM: [17, 0], crossesMidnight: false },
  evening: { label: 'evening', startHM: [17, 0], endHM: [22, 0], crossesMidnight: false },
  night: { label: 'night', startHM: [17, 0], endHM: [2, 0], crossesMidnight: true },
};
// NOTE: "sunrise" is deliberately NOT a temporal keyword — on playa it is
// usually part of an event name ("sunrise yoga"). It stays a search keyword.
delete (TIMES_OF_DAY as Record<string, unknown>).sunrise__NOT_A_KEY;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Format a Date as local "YYYY-MM-DD". */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Weekday name ("Tuesday") for an ISO date, parsed as LOCAL time. */
export function weekdayName(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const name = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Format a local datetime "YYYY-MM-DDTHH:MM". */
function toISO(d: Date, h: number, m: number): string {
  return `${toISODate(d)}T${pad2(h)}:${pad2(m)}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(text);
}

/** Find a weekday mentioned in the text (full name or abbreviation). */
function findWeekday(text: string): string | null {
  for (const day of WEEKDAYS) {
    if (hasWord(text, day)) {
      return day;
    }
  }
  for (const [abbr, day] of Object.entries(WEEKDAY_ABBREV)) {
    if (hasWord(text, abbr)) {
      return day;
    }
  }
  return null;
}

/** Next occurrence of `weekday` on or after `now`'s date (today counts). */
function nextWeekday(now: Date, weekday: string): Date {
  const target = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
  const delta = (target - now.getDay() + 7) % 7;
  return addDays(now, delta);
}

function dateFromISO(dateISO: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return null;
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return toISODate(date) === dateISO ? date : null;
}

/** Before an enabled event season, a named weekday means the first actual
 * enabled schedule date with that weekday, not an empty calendar week. */
function eventSeasonWeekday(
  ordinary: Date,
  weekday: string,
  eventCalendar: string[] | undefined,
): Date {
  const dates = (eventCalendar ?? [])
    .map(dateFromISO)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0 || ordinary.getTime() >= dates[0].getTime()) {
    return ordinary;
  }
  const target = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
  return dates.find(d => d.getDay() === target) ?? ordinary;
}

function findTimeOfDay(text: string): TimeOfDay | null {
  // "tonight" is handled separately (it implies today + night).
  for (const key of Object.keys(TIMES_OF_DAY)) {
    if (hasWord(text, key)) {
      return TIMES_OF_DAY[key];
    }
  }
  return null;
}

function windowFor(baseDay: Date, tod: TimeOfDay | null, dayLabel: string): DateWindow {
  if (!tod) {
    return {
      startISO: toISO(baseDay, 0, 0),
      endISO: toISO(baseDay, 23, 59),
      label: dayLabel,
    };
  }
  const endDay = tod.crossesMidnight ? addDays(baseDay, 1) : baseDay;
  return {
    startISO: toISO(baseDay, tod.startHM[0], tod.startHM[1]),
    endISO: toISO(endDay, tod.endHM[0], tod.endHM[1]),
    label: dayLabel ? `${dayLabel} ${tod.label}` : tod.label,
  };
}

/**
 * Parse a temporal expression out of the RAW USER TEXT against the device
 * clock. Returns null when the text contains no temporal expression — the
 * caller then searches without a date filter.
 *
 * Supported: today, tonight, tomorrow (+ "tomorrow night" etc.), weekday
 * names/abbreviations (+ time-of-day), "this week", and bare times of day
 * (dawn / morning / afternoon / evening / night).
 */
/**
 * INTERROGATIVE DAY-WORDS ARE THE UNKNOWN, NOT A FILTER. "What night does the
 * Man burn?", "which day is the Temple burn?", "when is Exodus?" — the day
 * word here is what the user is ASKING, and reading it as a window pinned
 * the search to tonight/today (measured 2026-08-17: "What night does the Man
 * burn?" -> window=night -> the Saturday milestone could never surface, on
 * every model). Detected on the raw user text; the caller also uses it to
 * refuse the model's day hint, because the model answers a "which day"
 * question with day='today' — an invented day is worse than none.
 */
const INTERROGATIVE_TIME_RE =
  /\b(what|which)\s+(night|nights|day|days|evening|morning|afternoon|time)\b|\bwhen\s+(is|are|does|do|will|did|was|were|would|should|can)\b/;

export function asksWhichDay(text: string): boolean {
  return INTERROGATIVE_TIME_RE.test(text.toLowerCase());
}

/** Remove the interrogative phrase so its day-word cannot become a window;
 * anything ELSE temporal in the sentence still parses ("what time is the
 * burn tonight?" keeps tonight). */
function stripInterrogativeTime(t: string): string {
  return t.replace(
    /\b(what|which)\s+(night|nights|day|days|evening|morning|afternoon|time)\b/g,
    ' ',
  );
}

export function parseTimeWindow(
  text: string,
  now: Date,
  eventCalendar?: string[],
): DateWindow | null {
  const t = stripInterrogativeTime(text.toLowerCase());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (hasWord(t, 'tonight')) {
    const night = TIMES_OF_DAY.night;
    return {
      startISO: toISO(today, night.startHM[0], night.startHM[1]),
      endISO: toISO(addDays(today, 1), night.endHM[0], night.endHM[1]),
      label: 'tonight',
    };
  }

  if (/\bthis week\b/.test(t) || /\ball week\b/.test(t)) {
    return {
      startISO: toISO(today, 0, 0),
      endISO: toISO(addDays(today, 6), 23, 59),
      label: 'this week',
    };
  }

  const tod = findTimeOfDay(t);

  if (hasWord(t, 'tomorrow') || hasWord(t, 'tmrw')) {
    return windowFor(addDays(today, 1), tod, 'tomorrow');
  }

  if (hasWord(t, 'today')) {
    return windowFor(today, tod, 'today');
  }

  const weekday = findWeekday(t);
  if (weekday) {
    const ordinary = nextWeekday(today, weekday);
    const base = eventSeasonWeekday(ordinary, weekday, eventCalendar);
    const label = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return windowFor(base, tod, label);
  }

  if (tod) {
    // Bare time-of-day ("at dawn", "in the morning"): today if the window has
    // not fully passed yet, otherwise tomorrow.
    const endToday = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + (tod.crossesMidnight ? 1 : 0),
      tod.endHM[0],
      tod.endHM[1],
    );
    const base = now.getTime() <= endToday.getTime() ? today : addDays(today, 1);
    return windowFor(base, tod, '');
  }

  return null;
}

/**
 * Whitelisted fallback for the model-supplied `day` argument. Used ONLY when
 * parseTimeWindow found nothing in the raw user text. Accepts day WORDS the
 * user could plausibly have said; rejects everything else — in particular any
 * calendar/ISO date, which the prototype showed the model fabricates.
 */
export function validateModelDayHint(
  day: string | undefined | null,
  now: Date,
  eventCalendar?: string[],
): DateWindow | null {
  if (!day) {
    return null;
  }
  const d = day.trim().toLowerCase();
  if (d.length === 0 || d.length > 20) {
    return null;
  }
  // Hard reject anything containing a digit (catches ISO dates, "sept 3", etc).
  if (/\d/.test(d)) {
    return null;
  }
  const allowed =
    d === 'today' ||
    d === 'tonight' ||
    d === 'tomorrow' ||
    d === 'this week' ||
    (WEEKDAYS as readonly string[]).includes(d) ||
    d in WEEKDAY_ABBREV;
  if (!allowed) {
    return null;
  }
  return parseTimeWindow(d, now, eventCalendar);
}
