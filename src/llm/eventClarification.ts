import { sanitizeKeywords } from '../events/ftsQuery';
import {
  hasTemporalExpression,
  stripEventTemporalCoordinates,
} from '../events/timeParser';
import { splitClauses } from './historyIntent';

// `show` counts as the COLLECTION NOUN only in noun position — plural, or
// singular behind an article ("the show", "a show") — never the bare
// imperative verb (binding review C4): `shows?` matched "show me yoga"
// into the collection branch whose head grammar then refused it, so the
// most common browse imperative lost event routing to one optional 's'.
const EVENT_COLLECTION =
  /\b(?:events?|schedules?|activit(?:y|ies)|class(?:es)?|workshops?|concerts?|shows|(?:the|an?|this|that)\s+show)\b/i;

const EVENT_ACTIVITY =
  /\b(?:part(?:y|ies)|sunrise|music|yoga|breakfast|dinner|dance|playing|burns?|swim)\b/i;

const EVENT_FIELD_REQUEST =
  /\b(?:when|where|what\s+time|what\s+(?:day|date|night)|which\s+(?:day|date|night))\b/i;

const EVENT_BROWSE_REQUEST =
  /\b(?:what(?:'s| is)\s+happening|what(?:'s| is)\s+going\s+on|things?\s+to\s+do)\b/i;

const EVENT_COLLECTION_HEAD =
  /^\s*(?:(?:(?:can|could|would)\s+you\s+|do\s+you\s+)?(?:please\s+)?(?:show|find|list|give|browse)(?:\s+(?:me|us))?\s+(?:\S+\s+){0,4}|(?:what|which)\s+(?:\S+\s+){0,3}|are\s+there\s+(?:\S+\s+){0,3})?(?:any\s+|all\s+|the\s+)?(?:events?|schedules?|activities|classes?|workshops?|concerts?|shows)\b/i;

const FACTUAL_EVENT_SHAPE =
  /\b(?:shaped?|founded|history|historical|origins?|safety\s+rules?|what\s+is\s+(?:(?:a|an|the|this)\s+)?[^?!.]+|(?:where|when)\s+(?:did|was)\b[^?!.]*\b(?:begin|began|originate[sd]?|founded))\b/i;

// The polite-auxiliary prefix, one article slot, and one adjective slot
// between the browse verb and the activity noun (binding review C4 +
// codex closure measurements): "can you show me sunrise yoga", "find me
// a dance party" and "any good parties" are the same browse as "find me
// yoga" — EVENT_COLLECTION_HEAD already granted its nouns all three.
// The article and adjective slots live INSIDE the browse-verb group, not
// beside it (binding re-review: my own C4 widening let 21 of 26 newly
// routing strings be ordinary talk — 'no music please', 'my dance teacher
// is great', 'the burn barrel is out back', 'great music!' — each turning
// into a forced search whose empty result then spoke as app authority).
// A bare activity noun still routes only when it STARTS the utterance,
// exactly as before; everything looser must be asked for with a verb.
const EVENT_ACTIVITY_BROWSE =
  /^\s*(?:(?:(?:can|could|would)\s+you\s+|do\s+you\s+)?(?:please\s+)?(?:any|show|find|list|give|browse)(?:\s+(?:me|us))?\s+(?:(?:a|an|the|some|any)\s+)?(?:[a-z]+\s+)?)?(?:part(?:y|ies)|sunrise|music|yoga|breakfast|dinner|dance|playing|burns?|swim)\b/i;

export function isFactualEventRequest(text: string): boolean {
  return FACTUAL_EVENT_SHAPE.test(text);
}

/** Conservative broad hint for buffering a model-selected event tool round. */
export function isEventRequest(text: string): boolean {
  return EVENT_COLLECTION.test(text) || EVENT_ACTIVITY.test(text) ||
    EVENT_BROWSE_REQUEST.test(text);
}

/** App-owned event-routing obligation. Collection-head browse syntax, event
 * fields, and trusted temporal coordinates route; factual uses of the same
 * nouns remain on the grounding path. */
export function shouldRouteEventSearch(text: string): boolean {
  if (EVENT_BROWSE_REQUEST.test(text)) {
    return true;
  }
  const collection = EVENT_COLLECTION.test(text);
  const activity = EVENT_ACTIVITY.test(text);
  if (!collection && !activity) {
    return false;
  }
  const temporalRemainder = text
    .replace(new RegExp(EVENT_COLLECTION.source, 'gi'), ' ')
    .replace(new RegExp(EVENT_ACTIVITY.source, 'gi'), ' ');
  if (hasTemporalExpression(temporalRemainder)) {
    return true;
  }
  if (FACTUAL_EVENT_SHAPE.test(text)) {
    return false;
  }
  if (EVENT_FIELD_REQUEST.test(text)) {
    return true;
  }
  return collection
    ? EVENT_COLLECTION_HEAD.test(text)
    : EVENT_ACTIVITY_BROWSE.test(text);
}

const EVENT_COORDINATOR = /\s*(?:,\s*(?:(?:and|or|then)\s+)?|\b(?:and|or|then)\b\s+)/gi;

export type EventRoutePredicate = (text: string) => boolean;

/** Character spans a splitter must not cut through — enabled exact-title
 * occurrences, supplied by the caller who owns the catalog (binding review
 * C2: "Sock puppet workshop and karaoke" dismembered into two searches
 * that returned two DIFFERENT events as authoritative cards). */
export type TitleSpanProvider = (
  text: string,
) => readonly { start: number; end: number }[];

function splitEventCoordination(
  clause: string,
  routesEvent: EventRoutePredicate,
  titleSpans?: TitleSpanProvider,
): string[] {
  const protectedSpans = titleSpans?.(clause) ?? [];
  const boundary = [...clause.matchAll(EVENT_COORDINATOR)].find(match => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (protectedSpans.some(span => start < span.end && span.start < end)) {
      // A coordinator INSIDE a named title is title text, not grammar.
      return false;
    }
    const suffix = clause.slice(end).trim();
    const temporalOnly = hasTemporalExpression(suffix) &&
      eventSearchQuery(suffix).length === 0;
    return routesEvent(suffix) || temporalOnly;
  });
  if (!boundary) {
    return [clause];
  }
  const start = boundary.index ?? 0;
  const end = start + boundary[0].length;
  return [
    clause.slice(0, start).trim(),
    ...splitEventCoordination(clause.slice(end).trim(), routesEvent, titleSpans),
  ].filter(Boolean);
}

export function splitEventClauses(
  text: string,
  routesEvent: EventRoutePredicate = shouldRouteEventSearch,
  titleSpans?: TitleSpanProvider,
): {
  eventClauses: string[];
  otherClauses: string[];
} {
  // splitClauses cuts BEFORE the coordinator shield sees anything (codex
  // closure deviation on C2, measured: "Cum and Make Sum Noise" was cut
  // at its own 'and' by CLAUSE_SPLIT, so the span shield below never
  // ran). Any two adjacent parts whose boundary a title span straddles
  // are re-joined from the ORIGINAL text; a part that cannot be located
  // verbatim keeps its split — the shield must never invent text.
  const spans = titleSpans?.(text) ?? [];
  const rawParts = splitClauses(text);
  const mergedParts = (() => {
    if (spans.length === 0 || rawParts.length < 2) {
      return rawParts;
    }
    const located: { part: string; start: number; end: number }[] = [];
    let cursor = 0;
    for (const part of rawParts) {
      const at = text.indexOf(part, cursor);
      if (at < 0) {
        return rawParts;
      }
      located.push({ part, start: at, end: at + part.length });
      cursor = at + part.length;
    }
    const out = [located[0]];
    for (const cur of located.slice(1)) {
      const prev = out[out.length - 1];
      if (spans.some(s => s.start < prev.end && s.end > cur.start)) {
        out[out.length - 1] = {
          part: text.slice(prev.start, cur.end),
          start: prev.start,
          end: cur.end,
        };
      } else {
        out.push(cur);
      }
    }
    return out.map(l => l.part);
  })();
  const clauses = mergedParts.flatMap(clause => {
    const parts = splitEventCoordination(clause, routesEvent, titleSpans);
    const inheritedEventIntent = routesEvent(clause) && parts.length > 1;
    return parts.map(part => ({ part, inheritedEventIntent }));
  });
  return {
    eventClauses: clauses
      .filter(({ part, inheritedEventIntent }) =>
        inheritedEventIntent || routesEvent(part)
      )
      .map(({ part }) => part),
    otherClauses: clauses
      .filter(({ part, inheritedEventIntent }) =>
        !inheritedEventIntent && !routesEvent(part)
      )
      .map(({ part }) => part),
  };
}

const EVENT_QUERY_SHELL = new Set([
  "what's",
  'now',
  'please',
  'search',
  'show',
  'find',
  'list',
  'give',
  'browse',
  'include',
  'includes',
  'including',
  'guide',
  'day',
  'event',
  'events',
  'schedule',
  'scheduled',
  'happening',
  'activities',
  'offered',
  'available',
]);

const EVENT_CATEGORY_TERMS = new Set([
  'class', 'classes', 'workshop', 'workshops', 'concert', 'concerts',
  'show', 'shows',
]);

/** The app-sanitized semantic side of an event request. Temporal authority
 * remains in the raw text passed separately to search_events. Generic category
 * words yield to specific terms, but remain when they are the requested filter. */
export function eventSearchQuery(userText: string): string {
  const terms = sanitizeKeywords(stripEventTemporalCoordinates(userText), {
    exclude: EVENT_QUERY_SHELL,
  });
  const specific = terms.filter(term => !EVENT_CATEGORY_TERMS.has(term));
  return (specific.length > 0 ? specific : terms).join(' ');
}

const DAY_REQUESTS = [
  /\b(?:what|which)\s+day\b/i,
  /\b(?:name|pick|choose|give|tell|specify)\s+(?:me\s+)?(?:a|the)\s+day\b/i,
  /\bneed\s+(?:a|the)\s+day\b/i,
  /\bday\s+(?:works|would you like|are you interested in)\b/i,
];

export interface PendingEventQuery {
  query: string;
  rawUserText: string;
}

/** Arm one deterministic retry only when an event-shaped request received an
 * explicit ask for a day. Semantic terms and trusted temporal text travel as
 * separate state so a day-only reply cannot erase "morning" or "at 9pm". */
export function eventClarificationQuery(
  userText: string,
  assistantText: string,
): PendingEventQuery | null {
  const clarifiableActivity =
    !FACTUAL_EVENT_SHAPE.test(userText) &&
    /\bwhat\s+about\s+(?:part(?:y|ies)|sunrise|music|yoga|breakfast|dinner|dance|playing|burns?|swim)\b/i.test(userText);
  if (
    (!shouldRouteEventSearch(userText) && !clarifiableActivity) ||
    !DAY_REQUESTS.some(pattern => pattern.test(assistantText))
  ) {
    return null;
  }
  return {
    query: eventSearchQuery(userText),
    rawUserText: userText,
  };
}
