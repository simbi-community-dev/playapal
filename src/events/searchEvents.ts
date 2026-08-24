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
import { asksWhichDay, parseTimeWindow, validateModelDayHint } from './timeParser';
import { sanitizeKeywords, buildFtsQuery, buildLikeQuery, TOP_N } from './ftsQuery';
import { collectLadder, LadderRung } from './ladder';
import { EVENTS_NOT_HIDDEN_SQL } from '../facts/hiddenItems';

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
  const probes = terms.map(t =>
    t.length > 4 ? t.toLowerCase().slice(0, 4) : t.toLowerCase(),
  );
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

function runLadder(
  terms: string[],
  dateRange: { startDate: string; endDate: string } | null,
): { rows: EventRow[]; strategy: EventSearchOutcome['strategy'] } {
  const conn = getDb();
  const ladder: LadderRung<EventStrategy>[] = [];
  // OR rungs carry the ≥2-term relevance floor; AND rungs match all terms
  // by construction and stay floorless.
  const floor = orRelevanceFloor(terms) as
    | ((row: { id: number }) => boolean)
    | undefined;
  if (isFtsAvailable()) {
    if (terms.length >= 2) {
      // Ordered-adjacent phrase first, same primitive as the docs ladder
      // (ftsQuery.buildFtsMatch 'phrase'): "temple burn" must rank the
      // Temple Burn milestone above "Temple Burn Perimeter Training", and
      // bm25 alone put them a hair apart the wrong way. Fill-to-limit means
      // AND/OR still top up beneath it.
      ladder.push({
        q: buildFtsQuery({ terms, mode: 'phrase', dateRange }),
        strategy: 'fts-phrase',
      });
    }
    ladder.push(
      { q: buildFtsQuery({ terms, mode: 'and', dateRange }), strategy: 'fts-and' },
      { q: buildFtsQuery({ terms, mode: 'or', dateRange }), strategy: 'fts-or', accept: floor },
    );
  }
  ladder.push(
    { q: buildLikeQuery({ terms, mode: 'and', dateRange }), strategy: 'like-and' },
    { q: buildLikeQuery({ terms, mode: 'or', dateRange }), strategy: 'like-or', accept: floor },
  );
  // Fill-to-limit: an under-full AND rung is topped up from the OR rungs
  // (deduped) instead of starving the model of ranked context.
  return collectLadder<EventStrategy, EventRow>(conn, ladder, TOP_N);
}

/** List events inside the window with no keyword filter (browse-style query). */
function browseWindow(dateRange: { startDate: string; endDate: string }): EventRow[] {
  const res = getDb().execute(
    `SELECT e.* FROM events e
     JOIN packs p ON p.id = e.pack_id AND p.enabled = 1
     WHERE e.date BETWEEN ? AND ? AND ${EVENTS_NOT_HIDDEN_SQL}
     ORDER BY e.date, e.time_start LIMIT 25`,
    [dateRange.startDate, dateRange.endDate],
  );
  // Overfetch, cut after the JS time-of-day filter (CAMP-NOTES ruling E):
  // LIMIT 5 before that filter under-fills the window once camper-authored
  // rows join the table. The caller still sees at most five.
  return ((res.rows?._array ?? []) as EventRow[]);
}

/** Keep events whose start time falls inside an intra-day window. */
function filterByTimeOfDay(rows: EventRow[], window: DateWindow): EventRow[] {
  const startTime = window.startISO.slice(11);
  const endTime = window.endISO.slice(11);
  const startDate = window.startISO.slice(0, 10);
  const endDate = window.endISO.slice(0, 10);
  if (startTime === '00:00' && endTime === '23:59') {
    return rows; // whole-day window: no time filtering
  }
  return rows.filter(ev => {
    if (!ev.time_start) {
      return true; // untimed events survive time filtering
    }
    const evLocal = `${ev.date}T${ev.time_start}`;
    return evLocal >= `${startDate}T${startTime}` && evLocal <= `${endDate}T${endTime}`;
  });
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
  const calendar = eventDates();
  // A "which day/night/when" question names no day; the model's day hint
  // for one is an invention (it answers "What night does the Man burn?" with
  // day='today'), and honoring it pins the search to today. Refuse it.
  const window =
    parseTimeWindow(rawUserText, now, calendar) ??
    (asksWhichDay(rawUserText) ? null : validateModelDayHint(args.day, now, calendar));
  const dateRange = window
    ? { startDate: window.startISO.slice(0, 10), endDate: window.endISO.slice(0, 10) }
    : null;
  const terms = sanitizeKeywords(args.query);

  // No usable keywords but a time window: browse the window instead.
  if (terms.length === 0) {
    const rows = dateRange ? browseWindow(dateRange) : [];
    return {
      results: (window ? filterByTimeOfDay(rows, window) : rows).slice(0, 5),
      window,
      windowRelaxed: false,
      strategy: rows.length > 0 ? 'like-or' : 'none',
    };
  }

  let { rows, strategy } = runLadder(terms, dateRange);
  let windowRelaxed = false;
  if (window && rows.length > 0) {
    const timeFiltered = filterByTimeOfDay(rows, window);
    if (timeFiltered.length > 0) {
      rows = timeFiltered;
    } else {
      windowRelaxed = true; // date matched but time-of-day did not; keep date matches
    }
  }
  if (rows.length === 0 && dateRange) {
    // Nothing in the window — retry unwindowed so the model can say "not
    // tonight, but Thursday" instead of a bare "nothing found".
    const retry = runLadder(terms, null);
    rows = retry.rows;
    strategy = retry.strategy;
    windowRelaxed = rows.length > 0;
  }
  const results = rows.slice(0, 5);
  // Forensics (logcat/ReactNativeJS): the owner's field bug could not be
  // classified because query strings and match strategies were never logged.
  // __DEV__-gated: user queries are personal data and must not reach logcat
  // in production builds (release QA round 2, finding 17).
  if (__DEV__) console.log(
    `[events] q=${JSON.stringify(args.query)} terms=[${terms.join(',')}] window=${
      window?.label ?? 'none'
    } relaxed=${windowRelaxed} strategy=${strategy} rows=[${results
      .map(r => `${r.id}:${r.title.slice(0, 30)}`)
      .join(' | ')}]`,
  );
  return { results, window, windowRelaxed, strategy };
}

/**
 * Shape the outcome for the model's tool-result message. Compact keys, top 5,
 * truncated descriptions — the UI renders full details from the STRUCTURED
 * rows, the model only needs enough to talk about them.
 */
export function toolResultJson(outcome: EventSearchOutcome): string {
  return JSON.stringify({
    window: outcome.window
      ? { label: outcome.window.label, start: outcome.window.startISO, end: outcome.window.endISO }
      : null,
    window_relaxed: outcome.windowRelaxed,
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
