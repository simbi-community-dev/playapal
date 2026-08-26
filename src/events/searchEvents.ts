/**
 * The search_events tool executor — fully deterministic, per the prototype:
 * the model contributes KEYWORDS; the time window comes from the app-side
 * parser over the RAW USER TEXT; the model's `day` argument is only a
 * whitelisted fallback hint and model-supplied dates are always discarded.
 *
 * Strategy ladder: FTS AND -> FTS OR -> LIKE AND -> LIKE OR, then one retry
 * without the date window if a window produced zero rows ("relaxed").
 */

import type { DateWindow, EventRow, EventSearchOutcome } from '../types';
import { eventDates, getDb, isFtsAvailable } from './db';
import {
  asksWhichDay,
  invalidUserDate,
  parseTimeWindow,
  stripEventDayCoordinates,
  stripEventTemporalCoordinates,
  validateModelDayHint,
} from './timeParser';
import {
  buildEventBrowseQuery,
  buildExactEventTitlesQuery,
  buildFtsQuery,
  buildLikeQuery,
  eventTermProbes,
  EventTimeFilter,
  sanitizeKeywords,
  TOP_N,
} from './ftsQuery';
import { collectLadder, LadderRung } from './ladder';
import { EVENTS_NOT_HIDDEN_SQL } from '../facts/hiddenItems';
import {
  eventTitleReferenceSpans,
  eventTitleSpans,
  mapOutsideTextSpans,
  normalizeEventTitle,
  omitTextSpans,
  prepareEventTitle,
  prepareEventTitleText,
  type EventTitleSpan,
  type PreparedEventTitle,
} from './eventTitle';
import type { DbConnection } from './engine';

export interface SearchEventsArgs {
  query: string;
  /** Untrusted day-word hint from the model. */
  day?: string;
}

type EventStrategy = Exclude<EventSearchOutcome['strategy'], 'none'>;

/**
 * Relevance floor for the OR rungs (owner field bug 2026-08-13: a clarify
 * follow-up about MOOP dragged a packing-for-exodus event into the answer —
 * an OR-only, single-term match with no floor). Multi-term queries require
 * at least TWO distinct terms present in the event's text before an OR-only
 * hit may return; single-term queries have no OR/AND distinction, so no
 * floor. Terms match on a 4-char prefix (mirrors the shrinkTerms rescue) so
 * porter-stem variants ("packing"/"packed" vs "pack") still count.
 */
export function orRelevanceFloor(
  terms: string[],
): ((row: EventRow) => boolean) | undefined {
  if (terms.length < 2) {
    return undefined;
  }
  const probes = eventTermProbes(terms);
  if (probes.length < 2) {
    return undefined;
  }
  return row => {
    const hay =
      `${row.title} ${row.desc} ${row.camp} ${row.location}`.toLowerCase();
    let hits = 0;
    for (const probe of probes) {
      if (hay.includes(probe)) {
        hits += 1;
        if (hits >= 2) {
          return true;
        }
      }
    }
    return false;
  };
}

const ALTERNATIVE_SCAN_LIMIT = 100;

function runLadder(
  terms: string[],
  dateRange: { startDate: string; endDate: string } | null,
  timeFilter: EventTimeFilter | null,
  limit = TOP_N,
): { rows: EventRow[]; strategy: EventSearchOutcome['strategy'] } {
  const conn = getDb();
  const ladder: LadderRung<EventStrategy>[] = [];
  // OR rungs carry the ≥2-term relevance floor in SQL, before ORDER/LIMIT.
  // Applying it to a capped result array can false-negative a valid row ranked
  // behind one-term decoys; AND rungs match all terms and stay floorless.
  const minimumTermMatches = eventTermProbes(terms).length >= 2 ? 2 : undefined;
  if (isFtsAvailable()) {
    if (terms.length >= 2) {
      // Ordered-adjacent phrase first, same primitive as the docs ladder
      // (ftsQuery.buildFtsMatch 'phrase'): "temple burn" must rank the
      // Temple Burn milestone above "Temple Burn Perimeter Training", and
      // bm25 alone put them a hair apart the wrong way. Fill-to-limit means
      // AND/OR still top up beneath it.
      ladder.push({
        q: buildFtsQuery({
          terms,
          mode: 'phrase',
          dateRange,
          timeFilter,
          limit,
        }),
        strategy: 'fts-phrase',
      });
    }
    ladder.push(
      {
        q: buildFtsQuery({
          terms,
          mode: 'and',
          dateRange,
          timeFilter,
          limit,
        }),
        strategy: 'fts-and',
      },
      {
        q: buildFtsQuery({
          terms,
          mode: 'or',
          dateRange,
          timeFilter,
          limit,
          minimumTermMatches,
        }),
        strategy: 'fts-or',
      },
    );
  }
  ladder.push(
    {
      q: buildLikeQuery({
        terms,
        mode: 'and',
        dateRange,
        timeFilter,
        limit,
      }),
      strategy: 'like-and',
    },
    {
      q: buildLikeQuery({
        terms,
        mode: 'or',
        dateRange,
        timeFilter,
        limit,
        minimumTermMatches,
      }),
      strategy: 'like-or',
    },
  );
  // Fill-to-limit: an under-full AND rung is topped up from the OR rungs
  // (deduped) instead of starving the model of ranked context.
  return collectLadder<EventStrategy, EventRow>(conn, ladder, limit);
}

function interleaveEventGroups(groups: readonly EventRow[][]): EventRow[] {
  return Array.from(
    { length: Math.max(0, ...groups.map(group => group.length)) },
    (_, index) => index,
  ).flatMap(index => groups.flatMap(group => group[index] ? [group[index]] : []));
}

function runExactTitles(
  titleGroups: readonly ExactTitleGroup[],
  terms: readonly string[],
  dateRange: { startDate: string; endDate: string } | null,
  timeFilter: EventTimeFilter | null,
  limit = TOP_N,
): { rows: EventRow[]; strategy: EventSearchOutcome['strategy'] } {
  const groups = titleGroups.map(group => {
    const q = buildExactEventTitlesQuery({
      titles: group.titles,
      terms,
      dateRange,
      timeFilter,
      limit,
    });
    if (!q) {
      return { first: [], rest: [] };
    }
    const rows = (getDb().execute(q.sql, q.params).rows?._array ?? []) as EventRow[];
    const bySpelling = new Map(group.titles.map(title => [title, [] as EventRow[]]));
    for (const row of rows) {
      bySpelling.get(row.title)?.push(row);
    }
    const spellings = [...bySpelling.values()];
    return {
      first: spellings.flatMap(rowsForTitle => rowsForTitle[0] ? [rowsForTitle[0]] : []),
      rest: interleaveEventGroups(spellings.map(rowsForTitle => rowsForTitle.slice(1))),
    };
  });
  const seen = new Set<number>();
  const rows = [
    ...interleaveEventGroups(groups.map(group => group.first)),
    ...interleaveEventGroups(groups.map(group => group.rest)),
  ]
    .filter(row => {
      if (seen.has(row.id)) {
        return false;
      }
      seen.add(row.id);
      return true;
    })
    .slice(0, limit);
  if (rows.length === 0 && terms.length > 0) {
    // Qualifiers RANK AND NARROW, they never manufacture an absence
    // (binding review C1): the qualifier terms ride in from the model's
    // semantic query, which is an untrusted hint — one stray word
    // ('location', 'schedule') hard-ANDed onto `title IN (…)` turned a
    // real event into an app-authoritative "nothing found" (measured:
    // 399/400 sampled pack titles flipped matches→empty with one plain
    // appended word). A named title with zero qualified rows retries
    // unqualified — the camper NAMED the event; the title is the query.
    return runExactTitles(titleGroups, [], dateRange, timeFilter, limit);
  }
  return { rows, strategy: rows.length > 0 ? 'like-and' : 'none' };
}

/** List events inside the window with no keyword filter (browse-style query). */
function browseWindow(
  dateRange: { startDate: string; endDate: string },
  timeFilter: EventTimeFilter | null,
): EventRow[] {
  const q = buildEventBrowseQuery({ dateRange, timeFilter, limit: TOP_N });
  const res = getDb().execute(q.sql, q.params);
  return (res.rows?._array ?? []) as EventRow[];
}

function shiftDate(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split('-').map(Number);
  const shifted = new Date(year, month - 1, day + days);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

function eventInterval(ev: EventRow): { start: string; end: string } | null {
  if (!ev.time_start) {
    return null;
  }
  const timeEnd = ev.time_end || ev.time_start;
  return {
    start: `${ev.date}T${ev.time_start}`,
    end: `${timeEnd < ev.time_start ? shiftDate(ev.date, 1) : ev.date}T${timeEnd}`,
  };
}

function repeatedDailyIntervals(window: DateWindow): Array<{ start: string; end: string }> {
  if (!window.timeStart || !window.timeEnd) {
    return [];
  }
  const crossesMidnight = window.timeEnd < window.timeStart;
  const lastDate = crossesMidnight
    ? shiftDate(window.endISO.slice(0, 10), -1)
    : window.endISO.slice(0, 10);
  const intervals: Array<{ start: string; end: string }> = [];
  for (
    let date = window.startISO.slice(0, 10);
    date <= lastDate;
    date = shiftDate(date, 1)
  ) {
    intervals.push({
      start: `${date}T${window.timeStart}`,
      end: `${crossesMidnight ? shiftDate(date, 1) : date}T${window.timeEnd}`,
    });
  }
  return intervals;
}

/** Keep events whose actual interval overlaps the requested local-time window. */
function filterByTimeOfDay(rows: EventRow[], window: DateWindow): EventRow[] {
  const startTime = window.timeStart ?? window.startISO.slice(11);
  const endTime = window.timeEnd ?? window.endISO.slice(11);
  if (startTime === '00:00' && endTime === '23:59') {
    return rows;
  }
  const daily = repeatedDailyIntervals(window);
  return rows.filter(ev => {
    const event = eventInterval(ev);
    if (!event) {
      return false;
    }
    return daily.length > 0
      ? daily.some(interval => event.start <= interval.end && event.end >= interval.start)
      : event.start <= window.endISO && event.end >= window.startISO;
  });
}

function filterByTimeOnEventDate(rows: EventRow[], window: DateWindow): EventRow[] {
  const startTime = window.timeStart ?? window.startISO.slice(11);
  const endTime = window.timeEnd ?? window.endISO.slice(11);
  const crossesMidnight = window.timeStart
    ? endTime < startTime
    : window.endISO.slice(0, 10) > window.startISO.slice(0, 10);
  return rows.filter(ev => {
    const event = eventInterval(ev);
    if (!event) {
      return false;
    }
    const requestedStart = `${ev.date}T${startTime}`;
    const requestedEnd = `${
      crossesMidnight ? shiftDate(ev.date, 1) : ev.date
    }T${endTime}`;
    return event.start <= requestedEnd && event.end >= requestedStart;
  });
}

function needsTimeFiltering(window: DateWindow | null): boolean {
  return window !== null && (
    window.timeStart !== undefined ||
    window.startISO.slice(11) !== '00:00' ||
    window.endISO.slice(11) !== '23:59'
  );
}

function queryTimeFilter(window: DateWindow | null): EventTimeFilter | null {
  if (!window || !needsTimeFiltering(window)) {
    return null;
  }
  const spansDays = window.startISO.slice(0, 10) !== window.endISO.slice(0, 10);
  if (window.timeStart && window.timeEnd && spansDays && !window.eventDateISO) {
    return {
      startISO: window.startISO,
      endISO: window.endISO,
      ...(window.timeStart === window.timeEnd
        ? { dailyTime: window.timeStart }
        : { dailyStart: window.timeStart, dailyEnd: window.timeEnd }),
    };
  }
  return { startISO: window.startISO, endISO: window.endISO };
}

function allSeasonTimeScope(
  window: DateWindow,
  calendar: string[],
): {
  dateRange: { startDate: string; endDate: string };
  timeFilter: EventTimeFilter;
} | null {
  if (!needsTimeFiltering(window) || !window.timeStart || !window.timeEnd) {
    return null;
  }
  const dates = calendar.slice().sort();
  if (dates.length === 0) {
    return null;
  }
  const startDate = dates[0];
  const endDate = dates.at(-1)!;
  return {
    dateRange: { startDate: shiftDate(startDate, -1), endDate },
    timeFilter: {
      startISO: `${startDate}T00:00`,
      endISO: `${endDate}T23:59`,
      ...(window.timeStart === window.timeEnd
        ? { dailyTime: window.timeStart }
        : { dailyStart: window.timeStart, dailyEnd: window.timeEnd }),
    },
  };
}

interface TitleCatalogGroup extends PreparedEventTitle {
  titles: string[];
}

interface ExactTitleGroup extends PreparedEventTitle {
  titles: readonly string[];
}

interface ExactTitleReferences {
  groups: ExactTitleGroup[];
  rawSpans: EventTitleSpan[];
}

const titleCatalogCache = new WeakMap<DbConnection, {
  revision: string;
  groups: TitleCatalogGroup[];
}>();

function titleCatalog(): TitleCatalogGroup[] {
  // Fail-soft like the FTS/vector arms: routing consults this catalog on
  // EVERY chat turn, so a read failure (schema mid-upgrade, a harness
  // without the db seam) must make the exact-title arm INERT — never
  // reject the turn.
  try {
    return titleCatalogUnsafe();
  } catch {
    return [];
  }
}

function titleCatalogUnsafe(): TitleCatalogGroup[] {
  const conn = getDb();
  const revisionRow = conn.execute(
    "SELECT value FROM settings WHERE key = 'event_title_catalog_revision'",
  ).rows?._array?.[0] as { value?: unknown } | undefined;
  const revision = String(revisionRow?.value ?? '0');
  const cached = titleCatalogCache.get(conn);
  if (cached?.revision === revision) {
    return cached.groups;
  }
  const result = conn.execute(
    `SELECT DISTINCT e.title FROM events e
     JOIN packs p ON p.id = e.pack_id AND p.enabled = 1
     WHERE length(trim(e.title)) > 0 AND ${EVENTS_NOT_HIDDEN_SQL}`,
  );
  const grouped = (result.rows?._array ?? []).reduce(
    (catalog, row) => {
      const raw = (row as { title?: unknown }).title;
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return catalog;
      }
      const title = raw.trim();
      const prepared = prepareEventTitle(title);
      const prior = catalog.get(prepared.normalized);
      catalog.set(prepared.normalized, prior
        ? { ...prior, titles: [...prior.titles, title].sort((a, b) => a.localeCompare(b)) }
        : { ...prepared, titles: [title] });
      return catalog;
    },
    new Map<string, TitleCatalogGroup>(),
  );
  const groups = [...grouped.values()];
  titleCatalogCache.set(conn, { revision, groups });
  return groups;
}

function exactRequestedTitles(
  text: string,
  semanticText?: string,
): ExactTitleReferences {
  const haystack = prepareEventTitleText(text);
  const normalizedSemantic = normalizeEventTitle(semanticText ?? '');
  const matches = titleCatalog()
    .flatMap(group => eventTitleReferenceSpans(haystack, group).map(span => ({
      group,
      span,
    })))
    .filter(match => {
      const before = normalizeEventTitle(text.slice(0, match.span.start));
      if (semanticText === undefined || before.length > 0) {
        return true;
      }
      const bareExact = haystack.normalized === match.group.normalized &&
        (
          normalizedSemantic.length === 0 ||
          normalizedSemantic === match.group.normalized
        );
      if (bareExact) {
        return true;
      }
      if (match.group.words.length < 2) {
        return false;
      }
      return normalizedSemantic.split(' ').filter(Boolean).length >= 2;
    })
    .sort((a, b) =>
      b.group.words.length - a.group.words.length ||
      a.span.start - b.span.start ||
      a.group.normalized.localeCompare(b.group.normalized)
    );
  const selected = matches
    .filter((match, index, all) =>
      !all.slice(0, index).some(prior =>
        prior.span.start < match.span.end && match.span.start < prior.span.end
      )
    )
    .sort((a, b) => a.span.start - b.span.start);
  const seen = new Set<string>();
  const groups = selected.flatMap(match => {
    if (seen.has(match.group.normalized)) {
      return [];
    }
    seen.add(match.group.normalized);
    return [match.group];
  });
  return {
    groups,
    rawSpans: selected.map(match => match.span),
  };
}

export function isEnabledEventTitleRequest(text: string): boolean {
  return exactRequestedTitles(text).groups.length > 0;
}

/** Every enabled-title OCCURRENCE span in the text — no reference-lead
 * grammar required, because the caller is protecting title text from
 * being cut by a splitter, not claiming query authority (binding review
 * C2). Fail-soft with the catalog. */
export function enabledTitleSpans(
  text: string,
): { start: number; end: number }[] {
  const haystack = prepareEventTitleText(text);
  return titleCatalog().flatMap(group => eventTitleSpans(haystack, group));
}

/** The title-preserving query for a clause that references enabled exact
 * titles: the referenced titles' normalized words, in utterance order.
 * eventSearchQuery strips dayparts and shell words, which DISMEMBERS a
 * title like Morning Coffee into "coffee" (staged-review root 5); a
 * clause that names an exact title searches by the title itself. Null
 * when the clause references none. */
export function exactTitleSearchQuery(text: string): string | null {
  const groups = exactRequestedTitles(text).groups;
  return groups.length > 0
    ? groups.map(group => group.normalized).join(' ')
    : null;
}

function semanticTitleSpans(
  text: string,
  groups: readonly ExactTitleGroup[],
): EventTitleSpan[] {
  const haystack = prepareEventTitleText(text);
  return groups
    .flatMap(group => eventTitleSpans(haystack, group))
    .sort((a, b) => a.start - b.start)
    .filter((span, index, spans) =>
      !spans.slice(0, index).some(prior =>
        prior.start < span.end && span.start < prior.end
      )
    );
}

/** Replace a clarification's prior day outside any exact event title. */
export function replaceEventDayCoordinate(text: string, day: string): string {
  const exact = exactRequestedTitles(text);
  const withoutDay = exact.rawSpans.length > 0
    ? mapOutsideTextSpans(text, exact.rawSpans, stripEventDayCoordinates)
    : stripEventDayCoordinates(text);
  return `${withoutDay} ${day}`.replace(/\s+/g, ' ').trim();
}

/** Replace every event-owned temporal coordinate while preserving exact-title
 * words that happen to look temporal. */
export function replaceEventTemporalCoordinates(
  text: string,
  temporalText: string,
): string {
  const exact = exactRequestedTitles(text);
  const withoutTime = exact.rawSpans.length > 0
    ? mapOutsideTextSpans(text, exact.rawSpans, stripEventTemporalCoordinates)
    : stripEventTemporalCoordinates(text);
  return `${withoutTime} ${temporalText}`.replace(/\s+/g, ' ').trim();
}

/**
 * Execute search_events. `rawUserText` is the user's actual message — the
 * trusted source for temporal parsing. Synchronous SQLite, async signature
 * for the tool loop's convenience.
 */
export async function searchEvents(
  args: SearchEventsArgs,
  rawUserText: string,
  now: Date = new Date(),
): Promise<EventSearchOutcome> {
  // Explicit enabled titles own temporal-looking words. Remove every referenced
  // title before parsing trusted coordinates; preserve title spans in the
  // model's semantic text so Morning Coffee / Night Swim remain query identity.
  const exact = exactRequestedTitles(rawUserText, args.query);
  const temporalText = omitTextSpans(rawUserText, exact.rawSpans);
  const semanticSpans = semanticTitleSpans(args.query, exact.groups);
  const semanticText = semanticSpans.length > 0
    ? mapOutsideTextSpans(args.query, semanticSpans, stripEventTemporalCoordinates)
    : stripEventTemporalCoordinates(args.query);
  // Canonicalize the model's semantic contribution once so every outcome from
  // this execution retains its identity through turn-level reconciliation.
  const terms = sanitizeKeywords(semanticText);
  const semanticTerms = terms;
  const query = semanticTerms.join(' ');
  // The exact-title path ANDs its semantic scope on top of `title IN (…)`,
  // so the terms it carries must be true QUALIFIERS — words outside every
  // referenced title. Passing the full term list re-ANDed title A's words
  // onto title B's rows: "Morning Coffee and Night Swim" required one
  // event to match all four words and returned nothing (staged-review
  // follow-through; the multi-title interval fixture is the regression).
  // Span-stripping alone is not enough: the model's semantic text may spell
  // a referenced title differently ("tea tarot" for Tea & Tarot), leaving
  // title words behind as false qualifiers — so any word a referenced title
  // owns is excluded outright. A qualifier that collides with a title word
  // is conceded to the title; titles own their words.
  const exactTitleWords = new Set(exact.groups.flatMap(group => group.words));
  const exactQualifierTerms = exact.groups.length > 0
    ? sanitizeKeywords(
        stripEventTemporalCoordinates(omitTextSpans(args.query, semanticSpans)),
      ).filter(term => !exactTitleWords.has(term))
    : [];
  const invalidDate = invalidUserDate(temporalText, now);
  if (invalidDate) {
    return {
      state: 'invalid-date',
      results: [],
      window: null,
      query,
      dateText: invalidDate,
      strategy: 'none',
    };
  }
  const calendar = eventDates();
  // A "which day/night/when" question names no day; the model's day hint
  // for one is an invention (it answers "What night does the Man burn?" with
  // day='today'), and honoring it pins the search to today. Refuse it.
  const window =
    parseTimeWindow(temporalText, now, calendar) ??
    (asksWhichDay(rawUserText)
      ? null
      : validateModelDayHint(args.day, now, calendar));
  const timeFilter = queryTimeFilter(window);
  const requestedDateRange = window
    ? {
        startDate: window.eventDateISO ?? window.startISO.slice(0, 10),
        endDate: window.endISO.slice(0, 10),
      }
    : null;
  const dateRange = requestedDateRange
    ? {
        ...requestedDateRange,
        startDate: timeFilter
          ? shiftDate(requestedDateRange.startDate, -1)
          : requestedDateRange.startDate,
      }
    : null;
  // The model contributes semantic keywords, never temporal coordinates. The
  // canonicalized terms above discard model-generated dates before retrieval.

  // No usable keywords or exact titles but a time window: browse the window.
  // With neither, no database query ran, so zero is not authoritative.
  if (terms.length === 0 && exact.groups.length === 0) {
    if (!window || !dateRange) {
      return {
        state: 'not-run',
        results: [],
        window: null,
        query,
        reason: 'no-keywords-or-window',
        strategy: 'none',
      };
    }
    const results = filterByTimeOfDay(
      browseWindow(dateRange, timeFilter),
      window,
    );
    return results.length > 0
      ? {
          state: 'matches',
          results,
          window,
          query,
          relation: 'within-request',
          strategy: 'like-or',
        }
      : {
          state: 'empty',
          results: [],
          window,
          query,
          searchedScope: 'requested-window',
          strategy: 'none',
        };
  }

  const run = (
    scope: { startDate: string; endDate: string } | null,
    time: EventTimeFilter | null,
    limit = TOP_N,
  ) => exact.groups.length > 0
    ? runExactTitles(exact.groups, exactQualifierTerms, scope, time, limit)
    : runLadder(terms, scope, time, limit);
  const first = run(dateRange, timeFilter);
  const outcome: EventSearchOutcome = first.rows.length > 0
    ? {
        state: 'matches',
        results: first.rows,
        window,
        relation: window ? 'within-request' : 'unconstrained',
        strategy: first.strategy,
      }
    : dateRange && window
    ? (() => {
        const sameDate = run(requestedDateRange, null);
        if (sameDate.rows.length > 0) {
          return {
            state: 'matches' as const,
            results: sameDate.rows,
            window,
            relation: 'outside-requested-time' as const,
            strategy: sameDate.strategy,
          };
        }
        const seasonScope = allSeasonTimeScope(window, calendar);
        const retry = seasonScope
          ? run(seasonScope.dateRange, seasonScope.timeFilter)
          : run(null, null, ALTERNATIVE_SCAN_LIMIT);
        const alternatives = seasonScope
          ? retry.rows
          : needsTimeFiltering(window)
          ? filterByTimeOnEventDate(retry.rows, window).slice(0, TOP_N)
          : retry.rows.slice(0, TOP_N);
        return alternatives.length > 0
          ? {
              state: 'matches' as const,
              results: alternatives,
              window,
              relation: 'outside-requested-date' as const,
              strategy: retry.strategy,
            }
          : {
              state: 'empty' as const,
              results: [],
              window,
              searchedScope: 'all-enabled-events' as const,
              strategy: retry.strategy,
            };
      })()
    : {
        state: 'empty',
        results: [],
        window: null,
        searchedScope: 'all-enabled-events',
        strategy: first.strategy,
      };

  // Forensics (logcat/ReactNativeJS): query strategy and semantic result state.
  console.log(
    `[events] q=${JSON.stringify(args.query)} terms=[${terms.join(',')}] window=${
      window?.label ?? 'none'
    } state=${outcome.state} relation=${
      outcome.state === 'matches' ? outcome.relation : 'none'
    } strategy=${outcome.strategy} rows=[${outcome.results
      .map(r => `${r.id}:${r.title.slice(0, 30)}`)
      .join(' | ')}]`,
  );
  return { ...outcome, query };
}

/**
 * Shape the outcome for the model's tool-result message. Compact keys, top 5,
 * truncated descriptions — the UI renders full details from the STRUCTURED
 * rows, the model only needs enough to talk about them.
 */
export function toolResultJson(outcome: EventSearchOutcome): string {
  return JSON.stringify({
    status: outcome.state,
    window: outcome.window
      ? { label: outcome.window.label, start: outcome.window.startISO, end: outcome.window.endISO }
      : null,
    ...(outcome.state === 'matches' ? { relation: outcome.relation } : {}),
    ...(outcome.state === 'empty'
      ? { searched_scope: outcome.searchedScope }
      : {}),
    ...(outcome.state === 'invalid-date'
      ? { invalid_date: outcome.dateText }
      : {}),
    count: outcome.results.length,
    events: outcome.results.map(ev => ({
      title: ev.title,
      day: ev.day,
      date: ev.date,
      start: ev.time_start,
      end: ev.time_end,
      camp: ev.camp,
      location: ev.location,
      desc: ev.desc.length > 160 ? `${ev.desc.slice(0, 157)}...` : ev.desc,
    })),
  });
}
