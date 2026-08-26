import { normalizeFactEntity } from '../facts/normalizeFactEntity';

export interface EventTitleSpan {
  start: number;
  end: number;
}

export interface EventTitleToken extends EventTitleSpan {
  value: string;
}

export interface PreparedEventTitle {
  normalized: string;
  words: readonly string[];
}

export interface PreparedEventTitleText extends PreparedEventTitle {
  source: string;
  tokens: readonly EventTitleToken[];
}

const TITLE_LEADS = new Set([
  '',
  'is',
  'are',
  'where is',
  'where are',
  // Contractions (binding re-review, sibling of C5's own root: a keystroke
  // must not be required). The tokenizer joins letters across the
  // apostrophe, so "where's" normalizes to the single token 'wheres'.
  'wheres',
  'whens',
  'whats',
  'what times',
  'what time is',
  'what day is',
  'what date is',
  'what is',
  'when is',
  'when are',
  'when does',
  'when was',
  'tell me about',
  'tell me when',
  'remind me when',
  'show',
  'show me',
  'find',
  'find me',
  'list',
  'list me',
  'give me',
  'please show',
  'please show me',
  'please find',
  'please list',
]);

function titleTokens(text: string): EventTitleToken[] {
  // Letters JOIN across an apostrophe (binding review C5): "Devil's"
  // tokenizes as one word (normalized "devils"), so the camper who types
  // "devils punchbowl" still names "Devil's Punchbowl" — a possessive 's'
  // as its own token made the apostrophe a required keystroke.
  return [...text.matchAll(/&(?:amp;)?|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/giu)].flatMap(match => {
    const raw = match[0];
    // Apostrophes VANISH inside a token (never become a space):
    // normalizeFactEntity("Devil's") is "devil s", which would leave a
    // space inside one token value and break word-sequence matching.
    const value = raw.startsWith('&')
      ? 'and'
      : normalizeFactEntity(raw.replace(/['’]/g, ''));
    return value.length === 0
      ? []
      : [{
          value,
          start: match.index ?? 0,
          end: (match.index ?? 0) + raw.length,
        }];
  });
}

export function prepareEventTitle(text: string): PreparedEventTitle {
  const words = titleTokens(text).map(token => token.value);
  return { normalized: words.join(' '), words };
}

export function prepareEventTitleText(text: string): PreparedEventTitleText {
  const tokens = titleTokens(text);
  const words = tokens.map(token => token.value);
  return { source: text, tokens, normalized: words.join(' '), words };
}

export function normalizeEventTitle(text: string): string {
  return prepareEventTitle(text).normalized;
}

function preparedText(text: string | PreparedEventTitleText): PreparedEventTitleText {
  return typeof text === 'string' ? prepareEventTitleText(text) : text;
}

function preparedTitle(
  title: string | PreparedEventTitle,
): PreparedEventTitle {
  return typeof title === 'string' ? prepareEventTitle(title) : title;
}

export function eventTitleSpans(
  text: string | PreparedEventTitleText,
  title: string | PreparedEventTitle,
): EventTitleSpan[] {
  const haystack = preparedText(text);
  const needle = preparedTitle(title);
  if (needle.words.length === 0 || needle.words.length > haystack.tokens.length) {
    return [];
  }
  return Array.from(
    { length: haystack.tokens.length - needle.words.length + 1 },
    (_, index) => index,
  ).flatMap(index =>
    needle.words.every(
      (value, offset) => haystack.tokens[index + offset].value === value,
    )
      ? [{
          start: haystack.tokens[index].start,
          end: haystack.tokens[index + needle.words.length - 1].end,
        }]
      : []
  );
}

/** A stored title owns temporal-looking words only when the utterance actually
 * names that event. Category/relation queries such as “yoga for beginners” and
 * “events after Man Burn” remain ordinary semantic searches. */
export function eventTitleReferenceSpans(
  text: string | PreparedEventTitleText,
  title: string | PreparedEventTitle,
): EventTitleSpan[] {
  const haystack = preparedText(text);
  const needle = preparedTitle(title);
  const listText = haystack.normalized
    .replace(/^(?:please )?(?:(?:can|could|would) you )?/, '')
    .trim();
  const titleListLead = [...TITLE_LEADS]
    .filter(Boolean)
    .some(lead => listText === lead || listText.startsWith(`${lead} `));
  return eventTitleSpans(haystack, needle).filter(span => {
    const rawBefore = normalizeEventTitle(haystack.source.slice(0, span.start));
    const before = rawBefore
      .replace(/^(?:please )?(?:(?:can|could|would) you )?/, '')
      .replace(/(?:^| )(?:the|a|an)$/, '')
      .trim();
    const after = normalizeEventTitle(haystack.source.slice(span.end));
    const multipleFieldReference =
      titleListLead &&
      /(?:,|\band\b)\s*$/i.test(haystack.source.slice(0, span.start));
    if (!TITLE_LEADS.has(before) && !multipleFieldReference) {
      return false;
    }
    if (before === 'what is' && needle.words.length < 2) {
      return false;
    }
    return (before.length > 0 && after.startsWith('and ')) ||
      needle.words.length > 1 || after.length === 0 ||
      /^(?:is|are|starts?|begins?|happens?|runs?)$/.test(after) ||
      /^(?:today|tonight|tomorrow|tmrw|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|this week|all week)\b/.test(after);
  });
}

export function isEventTitleReference(text: string, title: string): boolean {
  return eventTitleReferenceSpans(text, title).length > 0;
}

export function omitTextSpans(text: string, spans: readonly EventTitleSpan[]): string {
  return [...spans]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (value, span) => `${value.slice(0, span.start)} ${value.slice(span.end)}`,
      text,
    );
}

export function mapOutsideTextSpans(
  text: string,
  spans: readonly EventTitleSpan[],
  map: (value: string) => string,
): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const segments = ordered.flatMap((span, index) => [
    map(text.slice(index === 0 ? 0 : ordered[index - 1].end, span.start)),
    text.slice(span.start, span.end),
  ]);
  segments.push(map(text.slice(ordered.at(-1)?.end ?? 0)));
  return segments.join(' ');
}
