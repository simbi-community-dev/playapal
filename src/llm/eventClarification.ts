import { sanitizeKeywords } from '../events/ftsQuery';

/** The user-side event signal, exported for the grounding floor: an
 * event-shaped question belongs to the events machinery (model's own
 * search_events + the day-only clarification below), never to a forced
 * docs lookup — lookup_facts on "what's happening tonight" grounds the
 * turn in the WRONG corpus and disarms the clarification. */
export const EVENT_REQUEST =
  /\b(?:events?|schedule[sd]?|happening|going on|things? to do|activities|classes?|workshops?|part(?:y|ies)|sunrise|music|yoga|breakfast|dinner|dance|concerts?|shows?)\b/i;

const EVENT_QUERY_SHELL = new Set([
  "what's",
  'now',
  'please',
  'search',
  'guide',
  'day',
]);

const DAY_REQUESTS = [
  /\b(?:what|which)\s+day\b/i,
  /\b(?:name|pick|choose|give|tell|specify)\s+(?:me\s+)?(?:a|the)\s+day\b/i,
  /\bneed\s+(?:a|the)\s+day\b/i,
  /\bday\s+(?:works|would you like|are you interested in)\b/i,
];

/** Arm one deterministic retry only when an event-shaped request received an
 * explicit ask for a day. The stored query is app-sanitized, not model text. */
export function eventClarificationQuery(
  userText: string,
  assistantText: string,
): string | null {
  if (
    !EVENT_REQUEST.test(userText) ||
    !DAY_REQUESTS.some(pattern => pattern.test(assistantText))
  ) {
    return null;
  }
  return sanitizeKeywords(userText)
    .filter(term => !EVENT_QUERY_SHELL.has(term))
    .join(' ');
}
