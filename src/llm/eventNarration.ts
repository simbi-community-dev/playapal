import type {
  EventRow,
  EventSearchOutcome,
  SourceRef,
} from '../types';
import { hasTemporalExpression, isISODate } from '../events/timeParser';
import {
  isEventTitleReference,
  normalizeEventTitle,
} from '../events/eventTitle';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Stable, locale-independent date copy for app-owned event facts. */
export function eventDateLabel(dateISO: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!match || !isISODate(dateISO)) {
    return dateISO;
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? `${MONTHS[month - 1]} ${day}, ${match[1]}`
    : dateISO;
}

function alternativeDates(events: EventRow[]): string {
  const dates = [...new Map(events.map(event => [event.date, event])).values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(event => `${event.day}, ${eventDateLabel(event.date)}`);
  if (dates.length === 0) {
    return 'other dates';
  }
  if (dates.length === 1) {
    return dates[0];
  }
  return `${dates.slice(0, -1).join(', ')}, and ${dates[dates.length - 1]}`;
}

/** One deterministic sentence for one authoritative search_events result. */
export function eventSearchNarration(
  search: EventSearchOutcome,
  identifyQuery = false,
): string {
  const count = search.results.length;
  const requested = search.window?.label;
  const query = identifyQuery && search.query
    ? ` matching “${search.query}”`
    : '';
  const queryTarget = identifyQuery && search.query
    ? ` for “${search.query}”`
    : '';
  if (search.state === 'not-run') {
    return 'I need an event name, activity, place, or time to search the offline guide.';
  }
  if (search.state === 'invalid-date') {
    return `I can't search ${search.dateText} because it isn't a valid calendar date.`;
  }
  if (
    search.state === 'matches' &&
    (search.relation === 'outside-requested-time' ||
      search.relation === 'outside-requested-date')
  ) {
    const alternatives = count === 1 ? '1 alternative' : `${count} alternatives`;
    const certainty = search.relation === 'outside-requested-time'
      ? 'No confirmed'
      : 'No';
    return `${certainty} ${requested ?? 'requested-time'} matches${query}; here ${
      count === 1 ? 'is' : 'are'
    } ${alternatives} on ${alternativeDates(search.results)}.`;
  }
  if (count === 0) {
    return requested
      ? `I found no matching events for ${requested}${query} in the offline guide.`
      : `I found no matching events${queryTarget} in the offline guide.`;
  }
  const found = count === 1 ? '1 event' : `${count} events`;
  return requested
    ? `I found ${found} for ${requested}${query} in the offline guide.`
    : `I found ${found}${query} in the offline guide.`;
}

function dedupeEvents(events: readonly EventRow[]): EventRow[] {
  const rows = new Map<number, EventRow>();
  for (const event of events) {
    if (!rows.has(event.id)) {
      rows.set(event.id, event);
    }
  }
  return [...rows.values()];
}

function sameWindow(
  left: EventSearchOutcome['window'],
  right: EventSearchOutcome['window'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collapseEventSearches(
  searches: readonly EventSearchOutcome[],
  finalEvents?: readonly EventRow[],
): EventSearchOutcome[] {
  if (searches.length === 0) {
    return [];
  }
  const substantive = searches.filter(search => search.state !== 'not-run');
  if (substantive.length === 0) {
    return [searches[0]];
  }

  const events = dedupeEvents(
    finalEvents ?? substantive.flatMap(search => search.results),
  ).slice(0, 5);
  if (events.length > 0) {
    const ids = new Set(events.map(event => event.id));
    const matches = substantive.filter(
      (search): search is Extract<EventSearchOutcome, { state: 'matches' }> =>
        search.state === 'matches' && search.results.some(event => ids.has(event.id)),
    );
    const first = matches[0];
    const coherent = first !== undefined && matches.every(
      search => search.relation === first.relation && sameWindow(search.window, first.window),
    );
    return [{
      state: 'matches',
      results: events,
      window: coherent ? first.window : null,
      query: first?.query,
      relation: coherent ? first.relation : 'unconstrained',
      strategy: first?.strategy ?? 'none',
    }];
  }

  const invalid = substantive.find(
    (search): search is Extract<EventSearchOutcome, { state: 'invalid-date' }> =>
      search.state === 'invalid-date',
  );
  if (invalid) {
    return [invalid];
  }

  const empty = substantive.filter(
    (search): search is Extract<EventSearchOutcome, { state: 'empty' }> =>
      search.state === 'empty',
  );
  if (empty.length === substantive.length && empty.length > 0) {
    const first = empty[0];
    const coherent = empty.every(
      search =>
        search.searchedScope === first.searchedScope &&
        sameWindow(search.window, first.window),
    );
    return coherent
      ? [first]
      : empty;
  }

  return [];
}

/** Collapse repeated executions of one semantic event query while preserving
 * distinct query/window intents. The final deduped cards remain the row and
 * count authority for every downstream surface. */
export function authoritativeEventSearches(
  searches: readonly EventSearchOutcome[],
  finalEvents?: readonly EventRow[],
): EventSearchOutcome[] {
  if (searches.every(search => search.query === undefined)) {
    return collapseEventSearches(searches, finalEvents);
  }
  const groups = new Map<string, EventSearchOutcome[]>();
  for (const search of searches) {
    const key = JSON.stringify([search.query ?? '', search.window]);
    const group = groups.get(key) ?? [];
    group.push(search);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => {
    if (!finalEvents) {
      return collapseEventSearches(group);
    }
    const ids = new Set(group.flatMap(search => search.results.map(event => event.id)));
    return collapseEventSearches(
      group,
      finalEvents.filter(event => ids.has(event.id)),
    );
  });
}

export interface EventNarration {
  text: string;
  /** Inference-only content retaining exact app-owned event identity for broad
   * conversational references. Reserved date/time/location follow-ups are
   * resolved from session-owned rows before the model runs. */
  history: string;
}

export type EventFollowUpField =
  | 'start'
  | 'end'
  | 'time'
  | 'location'
  | 'date'
  | 'when';

export interface EventFollowUp {
  text: string;
  event: EventRow | null;
  field: EventFollowUpField;
}

const ORDINALS: Record<string, number> = {
  first: 0,
  '1st': 0,
  second: 1,
  '2nd': 1,
  third: 2,
  '3rd': 2,
  fourth: 3,
  '4th': 3,
  fifth: 4,
  '5th': 4,
};

function normalizedWords(text: string): string {
  return normalizeEventTitle(text);
}

function withoutEventTitles(text: string, events: readonly EventRow[]): string {
  return [...events]
    .sort((a, b) => normalizedWords(b.title).length - normalizedWords(a.title).length)
    .reduce((value, event) => {
      const title = normalizedWords(event.title);
      return title.length === 0
        ? value
        : ` ${value} `.replaceAll(` ${title} `, ' ').trim();
    }, normalizedWords(text));
}

export function eventFollowUpHasTemporalConstraint(
  text: string,
  event: EventRow | null,
  events: readonly EventRow[] = [],
): boolean {
  if (!event) {
    return hasTemporalExpression(withoutEventTitles(text, events));
  }
  const titlePattern = normalizedWords(event.title)
    .split(' ')
    .filter(Boolean)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\p{L}\\p{N}]+');
  const remainder = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(new RegExp(`\\b${titlePattern}\\b`, 'iu'), ' ');
  return hasTemporalExpression(remainder);
}

const TITLE_REFERENCE_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'at', 'begin', 'begins', 'can', 'could',
  'date', 'day',
  'did', 'do', 'does', 'end', 'ending', 'ends', 'event', 'events', 'has', 'have', 'is',
  'know', 'located', 'location', 'me', 'of', 'on', 'option', 'options', 'please',
  'remind', 'result',
  'results', 's', 'start', 'starting', 'starts', 'beginning', 'tell', 'the', 'time', 'was', 'what', 'whats',
  'when',
  'where', 'will', 'would', 'you', 'today', 'tonight', 'tomorrow', 'tmrw',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'morning', 'afternoon', 'evening', 'night',
]);

const TEMPORAL_REFERENCE_WORDS = new Set([
  'all', 'this', 'week', 'am', 'pm',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

function exactTitleTargets(
  text: string,
  titled: readonly { event: EventRow; title: string }[],
): EventRow[] {
  return titled
    .filter(({ event }) => isEventTitleReference(text, event.title))
    .map(({ event }) => event);
}

function eventTarget(text: string, events: readonly EventRow[]): EventRow[] | null {
  const words = normalizedWords(text);
  const normalized = ` ${words} `;
  const titled = events
    .map(event => ({ event, title: normalizedWords(event.title) }))
    .filter(({ title }) => title.length > 0 && normalized.includes(` ${title} `));
  const exact = exactTitleTargets(text, titled);
  if (exact.length > 0) {
    return exact;
  }

  const ordinal = /\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)(?=\s+(?:one|event|option|result|start|starts|end|ends|begin|begins|located)\b|\s*[?.,!]|\s*$)(?:\s+(?:one|event|option|result))?\b/i.exec(text);
  if (ordinal) {
    const index = ordinal[1].toLowerCase() === 'last'
      ? events.length - 1
      : ORDINALS[ordinal[1].toLowerCase()];
    return index >= 0 && index < events.length ? [events[index]] : [];
  }

  if (titled.length > 0) {
    const specific = titled.filter(({ title }, index) => {
      const containers = titled.filter(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.title !== title &&
          ` ${other.title} `.includes(` ${title} `),
      );
      if (containers.length === 0) {
        return true;
      }
      const remainder = containers.reduce(
        (value, other) => value.replaceAll(` ${other.title} `, ' '),
        normalized,
      );
      return remainder.includes(` ${title} `);
    });
    const remainder = withoutEventTitles(text, specific.map(({ event }) => event));
    const temporal = hasTemporalExpression(text);
    if (
      remainder.split(' ').filter(Boolean).some(
        word =>
          !TITLE_REFERENCE_WORDS.has(word) &&
          !(
            temporal &&
            (/^\d+(?:am|pm)?$/.test(word) || TEMPORAL_REFERENCE_WORDS.has(word))
          ),
      )
    ) {
      return null;
    }
    return specific.map(({ event }) => event);
  }
  const pronoun = /\b(?:it|its|this one|that one|the event|this event|that event)\b/i;
  if (pronoun.test(text)) {
    const remainder = normalizedWords(text.replace(pronoun, ''));
    if (
      remainder.split(' ').filter(Boolean).some(word => !TITLE_REFERENCE_WORDS.has(word))
    ) {
      return null;
    }
    return events.length === 1 ? [events[0]] : [];
  }
  return null;
}

function eventFollowUpField(text: string): EventFollowUpField | null {
  const asksTime = /\bwhat\s+time\b/i.test(text);
  const asksWhen = /\bwhen\b/i.test(text);
  const asksEnd = /\b(?:end|ends|ending)\b/i.test(text);
  const asksStart = /\b(?:start|starts|starting|begin|begins|beginning)\b/i.test(text);
  const fields = [
    [/\bwhere\b|\blocation\b/i.test(text), 'location'],
    [/\bend\s+time\b/i.test(text), 'end'],
    [/\bwhat\s+(?:day|date)\b/i.test(text), 'date'],
    [(asksTime || asksWhen) && asksEnd, 'end'],
    [(asksTime || asksWhen) && asksStart, 'start'],
    [asksTime && !asksEnd && !asksStart, 'time'],
    [asksWhen && !asksEnd && !asksStart, 'when'],
  ].filter((entry): entry is [true, EventFollowUpField] => entry[0] === true)
    .map(([, field]) => field);
  const unique = [...new Set(fields)];
  return unique.length === 1 ? unique[0] : null;
}

/** Resolve narrow reserved-fact follow-ups without asking the model to restate
 * an event's date, time, or location from inference history. An ambiguity may
 * carry its requested field into a following bare-title disambiguation. */
export function eventFollowUp(
  text: string,
  events: readonly EventRow[],
  pendingField: EventFollowUpField | null = null,
): EventFollowUp | null {
  if (events.length === 0) {
    return null;
  }
  const bareTitle = pendingField !== null && events.some(
    event => normalizedWords(event.title) === normalizedWords(text),
  );
  const targets = eventTarget(text, events);
  if (targets === null) {
    return null;
  }
  const explicitField = bareTitle
    ? null
    : eventFollowUpField(withoutEventTitles(text, targets));
  const field = bareTitle ? pendingField : explicitField;
  if (field === null) {
    return null;
  }
  if (targets.length !== 1) {
    return {
      event: null,
      field,
      text: "I can't tell which event you mean. Name one of the event titles shown above.",
    };
  }
  const event = targets[0];
  if (field === 'end') {
    return {
      event,
      field,
      text: event.time_end
        ? `${event.title} ends at ${event.time_end}.`
        : `${event.title} has no listed end time.`,
    };
  }
  if (field === 'start') {
    return {
      event,
      field,
      text: event.time_start
        ? `${event.title} starts at ${event.time_start}.`
        : `${event.title} has no listed start time.`,
    };
  }
  if (field === 'location') {
    return {
      event,
      field,
      text: event.location
        ? `${event.title} is at ${event.location}.`
        : `${event.title} has no listed location.`,
    };
  }
  const date = `${event.day}, ${eventDateLabel(event.date)}`;
  if (field === 'date') {
    return { event, field, text: `${event.title} is on ${date}.` };
  }
  const time = event.time_start
    ? event.time_end
      ? `${event.time_start}–${event.time_end}`
      : `starting at ${event.time_start}, with no listed end time`
    : event.time_end
    ? `ending at ${event.time_end}, with no listed start time`
    : null;
  if (field === 'time') {
    const narration = event.time_start
      ? event.time_end
        ? `${event.title} runs ${event.time_start}–${event.time_end}.`
        : `${event.title} starts at ${event.time_start}, with no listed end time.`
      : event.time_end
      ? `${event.title} ends at ${event.time_end}, with no listed start time.`
      : `${event.title} has no listed time.`;
    return { event, field, text: narration };
  }
  return {
    event,
    field,
    text: time === null
      ? `${event.title} is on ${date}, with no listed time.`
      : `${event.title} is on ${date}, ${time}.`,
  };
}

/**
 * Build display copy and richer inference history from structured tool
 * outcomes. Arbitrary generated prose, descriptions, and passages never cross
 * the display/speech boundary: those lower-authority fields can contain stale
 * dates, times, or locations that contradict the structured event rows.
 */
export function reconcileEventNarration(
  searches: readonly EventSearchOutcome[],
  sources: readonly SourceRef[] = [],
): EventNarration | null {
  const resolved = authoritativeEventSearches(searches);
  if (
    resolved.length === 0 ||
    (sources.length > 0 && resolved.every(search => search.state === 'not-run'))
  ) {
    return null;
  }
  const identified = new Set(
    resolved.map(search => search.query).filter(Boolean),
  ).size > 1;
  const summary = resolved
    .map(search => eventSearchNarration(search, identified))
    .join(' ');
  const historyRows = dedupeEvents(
    resolved.flatMap(search => search.results),
  ).map(event => ({
    id: event.id,
    title: event.title,
    date: event.date,
    day: event.day,
    start: event.time_start,
    end: event.time_end,
    camp: event.camp,
    location: event.location,
    description: event.desc.length > 160
      ? `${event.desc.slice(0, 157)}...`
      : event.desc,
  }));
  const guideHistory = sources.length > 0
    ? `Grounded guide material: ${sources
        .map(source => source.passage.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 640)}\n`
    : '';
  return {
    text: summary,
    history: `${guideHistory}Structured event results: ${JSON.stringify(historyRows)}`,
  };
}
