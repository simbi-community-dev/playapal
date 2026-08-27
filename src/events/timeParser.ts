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
import { parsePlayaAddress } from '../rightnow/playaWalk';

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
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return day;
  }
  if (new RegExp(`^(?:${NAMED_DATE_EXPRESSION.source})$`, 'i').test(day)) {
    return day;
  }
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

const MONTH_NUMBERS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const ISO_DATE_EXPRESSION = /\b\d{4}-\d{2}-\d{2}\b/;
const NAMED_DATE_EXPRESSION = new RegExp(
  `\\b(${Object.keys(MONTH_NUMBERS).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'i',
);

function namedDateMatches(text: string): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(NAMED_DATE_EXPRESSION.source, 'gi'))]
    .filter(match => {
      if (match[1].toLowerCase() !== 'may' || match[3]) {
        return true;
      }
      const rest = text.slice((match.index ?? 0) + match[0].length);
      return !/^\s+(?:people|persons|attendees|campers|burners|guests)\s+(?:attend|come|join|fit|enter|ride|use)\b/i.test(rest);
    });
}

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

/** Syntactic temporal intent, including an impossible user-written date.
 * This is for routing only; parseTimeWindow remains the validity/window owner. */
export function invalidUserDate(text: string, now: Date): string | null {
  const candidates = [
    ...[...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => ({
      index: match.index,
      text: match[0],
      valid: isISODate(match[0]),
    })),
    ...namedDateMatches(text).map(match => {
      const month = MONTH_NUMBERS[match[1].toLowerCase()];
      const day = Number(match[2]);
      const year = Number(match[3] ?? now.getFullYear());
      return {
        index: match.index,
        text: match[0],
        valid: isISODate(`${year}-${pad2(month)}-${pad2(day)}`),
      };
    }),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return candidates.find(candidate => !candidate.valid)?.text ?? null;
}

export function hasTemporalExpression(text: string): boolean {
  const t = text.toLowerCase();
  if (ISO_DATE_EXPRESSION.test(t) || namedDateMatches(t).length > 0) {
    return true;
  }
  if (clockTime(t)) {
    return true;
  }
  if (/\b(?:this|all)\s+week\b/.test(t)) {
    return true;
  }
  if (
    ['today', 'tonight', 'tomorrow', 'tmrw', ...WEEKDAYS].some(word => hasWord(t, word)) ||
    Object.keys(WEEKDAY_ABBREV).some(word => hasWord(t, word))
  ) {
    return true;
  }
  return Object.keys(TIMES_OF_DAY).some(word => hasWord(t, word));
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

export function isISODate(dateISO: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return false;
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
}

function dateFromISO(dateISO: string): Date | null {
  if (!isISODate(dateISO)) {
    return null;
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, m - 1, d);
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
  if (dates.length === 0) {
    return ordinary;
  }
  const future = dates.filter(d => d.getTime() >= ordinary.getTime());
  if (future.length === 0) {
    return ordinary;
  }
  // Historical enabled packs must not disable pre-season projection for the
  // next schedule. A recent prior event means the current season is active;
  // a distant archive is not evidence that this year's season already began.
  const prior = dates.filter(d => d.getTime() <= ordinary.getTime()).at(-1);
  const activeSeason = prior
    ? ordinary.getTime() - prior.getTime() <= 30 * 24 * 60 * 60 * 1000
    : false;
  if (activeSeason) {
    return ordinary;
  }
  const target = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
  return future.find(d => d.getDay() === target) ?? ordinary;
}

function findTimeOfDay(text: string): TimeOfDay | null {
  if (hasWord(text, 'tonight')) {
    return TIMES_OF_DAY.night;
  }
  for (const key of Object.keys(TIMES_OF_DAY)) {
    if (hasWord(text, key)) {
      return TIMES_OF_DAY[key];
    }
  }
  return null;
}

function namedDate(text: string, now: Date): { date: Date; label: string } | null {
  const match = namedDateMatches(text)[0];
  if (!match) {
    return null;
  }
  const month = MONTH_NUMBERS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3] ?? now.getFullYear());
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const date = dateFromISO(iso);
  return date ? { date, label: match[0] } : null;
}

function isPlayaAddressClock(text: string, clockIndex: number): boolean {
  const clock = '(?:[1-9]|1[0-2]):[0-5]\\d';
  const ring = '(?:[a-l]|esplanade)';
  const expression = new RegExp(
    `(?:\\b${ring}\\b\\s*(?:&|and|at|on)\\s*\\b${clock}\\b|` +
      `\\b${clock}\\b\\s*(?:&|and|at|on)\\s*\\b${ring}\\b|` +
      `\\b${clock}\\b\\s+deep playa\\b)`,
    'gi',
  );
  return [...text.matchAll(expression)].some(match =>
    clockIndex >= match.index &&
    clockIndex < match.index + match[0].length &&
    parsePlayaAddress(match[0]) !== null,
  );
}

function clockTime(text: string): [number, number] | null {
  const twelve = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(text);
  if (twelve) {
    const hour = Number(twelve[1]) % 12 + (/^p/i.test(twelve[3]) ? 12 : 0);
    return [hour, Number(twelve[2] ?? 0)];
  }
  for (const twentyFour of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    if (isPlayaAddressClock(text, twentyFour.index)) {
      continue;
    }
    return [Number(twentyFour[1]), Number(twentyFour[2])];
  }
  return null;
}

type TextSpan = [number, number];

const EVENT_DAY_WORDS = [
  'today', 'tomorrow', 'tmrw',
  ...WEEKDAYS,
  ...Object.keys(WEEKDAY_ABBREV),
];

function dateCoordinateSpans(text: string): TextSpan[] {
  return [
    ...[...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match =>
      [match.index ?? 0, (match.index ?? 0) + match[0].length] as TextSpan
    ),
    ...namedDateMatches(text).map(match =>
      [match.index ?? 0, (match.index ?? 0) + match[0].length] as TextSpan
    ),
  ];
}

function removeCoordinateSpans(text: string, spans: readonly TextSpan[]): string {
  return [...spans]
    .sort((a, b) => b[0] - a[0])
    .reduce(
      (value, [start, end]) => `${value.slice(0, start)} ${value.slice(end)}`,
      text,
    );
}

/** Replace a clarification's prior day/date coordinate while preserving its
 * semantic words and additive clock/daypart constraint. The model may ask for
 * a day even after the user supplied one; appending the answer leaves two
 * weekdays and findWeekday then chooses enum order rather than the correction. */
export function stripEventDayCoordinates(text: string): string {
  return removeCoordinateSpans(text, dateCoordinateSpans(text))
    .replace(/\btonight\b/gi, 'night')
    .replace(/\b(?:this|all)\s+week\b/gi, ' ')
    .replace(new RegExp(`\\b(?:${EVENT_DAY_WORDS.join('|')})\\b`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove coordinates that the app-side parser owns before keyword retrieval. */
export function stripEventTemporalCoordinates(text: string): string {
  const spans = dateCoordinateSpans(text);
  const collect = (expression: RegExp, keep?: (index: number) => boolean): void => {
    for (const match of text.matchAll(expression)) {
      if (!keep?.(match.index ?? 0)) {
        spans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
      }
    }
  };
  collect(/\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi);
  collect(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g, index =>
    isPlayaAddressClock(text, index),
  );
  const ownedWords = [
    'tonight',
    ...EVENT_DAY_WORDS,
    ...Object.keys(TIMES_OF_DAY),
  ].join('|');
  return removeCoordinateSpans(text, spans)
    .replace(/\b(?:this|all)\s+week\b/gi, ' ')
    .replace(new RegExp(`\\b(?:${ownedWords})\\b`, 'gi'), ' ');
}

function clockWindow(
  baseDay: Date,
  clock: [number, number],
  label: string,
  eventDay?: Date,
): DateWindow {
  const time = `${pad2(clock[0])}:${pad2(clock[1])}`;
  const at = `${toISODate(baseDay)}T${time}`;
  return {
    startISO: at,
    endISO: at,
    label,
    timeStart: time,
    timeEnd: time,
    ...(eventDay && toISODate(eventDay) !== toISODate(baseDay)
      ? { eventDateISO: toISODate(eventDay) }
      : {}),
  };
}

function clockDayForIntent(
  baseDay: Date,
  tod: TimeOfDay | null,
  clock: [number, number],
): Date {
  if (!tod?.crossesMidnight) {
    return baseDay;
  }
  const [endHour, endMinute] = tod.endHM;
  return clock[0] < endHour || (clock[0] === endHour && clock[1] <= endMinute)
    ? addDays(baseDay, 1)
    : baseDay;
}

function windowForIntent(
  baseDay: Date,
  tod: TimeOfDay | null,
  clock: [number, number] | null,
  dayLabel: string,
): DateWindow {
  return clock
    ? clockWindow(
        clockDayForIntent(baseDay, tod, clock),
        clock,
        `${dayLabel} ${clock[0]}:${pad2(clock[1])}`.trim(),
        baseDay,
      )
    : windowFor(baseDay, tod, dayLabel);
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
 * Supported: a strict ISO date written by the user, today, tonight, tomorrow
 * (+ "tomorrow night" etc.), weekday names/abbreviations (+ time-of-day),
 * "this week", and bare times of day (dawn / morning / afternoon / evening /
 * night). Model-supplied ISO dates remain rejected by validateModelDayHint.
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
  if (invalidUserDate(t, now)) {
    return null;
  }
  const clock = clockTime(t);
  const exactISO = /(?:^|\D)(\d{4}-\d{2}-\d{2})(?!\d)/.exec(t)?.[1];
  const exact = exactISO ? dateFromISO(exactISO) : null;
  if (exact && exactISO) {
    return windowForIntent(exact, findTimeOfDay(t), clock, exactISO);
  }
  const named = namedDate(t, now);
  if (named) {
    return windowForIntent(named.date, findTimeOfDay(t), clock, named.label);
  }

  if (hasWord(t, 'tonight')) {
    const night = TIMES_OF_DAY.night;
    return clock
      ? clockWindow(
          clockDayForIntent(today, night, clock),
          clock,
          `tonight ${clock[0]}:${pad2(clock[1])}`,
          today,
        )
      : {
          startISO: toISO(today, night.startHM[0], night.startHM[1]),
          endISO: toISO(addDays(today, 1), night.endHM[0], night.endHM[1]),
          label: 'tonight',
        };
  }

  const tod = findTimeOfDay(t);
  if (/\bthis week\b/.test(t) || /\ball week\b/.test(t)) {
    if (clock) {
      const time = `${pad2(clock[0])}:${pad2(clock[1])}`;
      return {
        startISO: toISO(today, 0, 0),
        endISO: toISO(addDays(today, 6), 23, 59),
        label: `this week ${clock[0]}:${pad2(clock[1])}`,
        timeStart: time,
        timeEnd: time,
      };
    }
    if (tod) {
      const endDay = addDays(today, 6 + (tod.crossesMidnight ? 1 : 0));
      return {
        startISO: toISO(today, tod.startHM[0], tod.startHM[1]),
        endISO: toISO(endDay, tod.endHM[0], tod.endHM[1]),
        label: `this week ${tod.label}`,
        timeStart: `${pad2(tod.startHM[0])}:${pad2(tod.startHM[1])}`,
        timeEnd: `${pad2(tod.endHM[0])}:${pad2(tod.endHM[1])}`,
      };
    }
    return {
      startISO: toISO(today, 0, 0),
      endISO: toISO(addDays(today, 6), 23, 59),
      label: 'this week',
    };
  }

  if (hasWord(t, 'tomorrow') || hasWord(t, 'tmrw')) {
    return windowForIntent(addDays(today, 1), tod, clock, 'tomorrow');
  }

  if (hasWord(t, 'today')) {
    return windowForIntent(today, tod, clock, 'today');
  }

  const weekday = findWeekday(t);
  if (weekday) {
    const ordinary = nextWeekday(today, weekday);
    const base = eventSeasonWeekday(ordinary, weekday, eventCalendar);
    const label = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return windowForIntent(base, tod, clock, label);
  }

  if (clock) {
    const at = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
      clock[0],
      clock[1],
    );
    const base = now.getTime() <= at.getTime() ? today : addDays(today, 1);
    return clockWindow(base, clock, `${clock[0]}:${pad2(clock[1])}`);
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
