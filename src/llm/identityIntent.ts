/**
 * PERSON-IDENTITY PRE-ROUTE — the identity twin of historyIntent's relational
 * slot filler, and the same cure: when routing is a coin flip, the app
 * decides and the model only answers.
 *
 * DEVICE-MEASURED FAILURE (chat_log receipts, 2026-08-16, v3.0 model, three
 * fresh single-turn sessions, one question shape):
 *   "Who is pug"                  -> lookup_facts -> grounded answer.  PASS
 *   "Who is Marisol from the camp" -> lookup_facts -> person card.      PASS
 *   "Who is Coco"                 -> NO TOOL CALL AT ALL -> "Coco is a camp
 *      located in the 9:00 sector of Black Rock City." FABRICATED. Coco is a
 *      camper with a card in the people pack — and she is dead and
 *      memorialized, so an invented location for her is the worst answer this
 *      app can give.
 * The mid-conversation hypothesis was tested and REFUTED: every session was
 * fresh. Same shape, same freshness, different NAME, different behavior —
 * routing is unreliable PER QUESTION, not per turn position. Three prompt
 * revisions have already failed on this class; the shipping nudge still
 * carries a verbatim sentence for it ("A question about a person — who
 * someone is, what they did, their story — is a lookup_facts question: pass
 * their name as the topic"). No wording fixes a coin flip.
 *
 * So the SHAPE is matched here, deterministically, the name is extracted
 * conservatively, and LlamaSession supplies the lookup_facts call the model
 * failed to make. A FLOOR, never a ceiling: a model that routes itself keeps
 * its own call untouched (see runTurn).
 *
 * THREE NARROWINGS, each load-bearing:
 *  1. historyIntent WINS. "Who sponsored X" / "who was X sponsored by" are
 *     the more specific shapes and own their own forced tool, so this router
 *     returns null for anything historyToolArgs claims.
 *  2. Only identity SHAPES: "who is/was X", "who's X", "tell me about X",
 *     "what do you know about X". Event questions ("what is happening"),
 *     logistics ("where is ice") and everything else keep today's path
 *     byte-for-byte — this file returning null means nothing changed.
 *  3. Only NAME-LIKE slots. 1-3 word-shaped tokens, at least one of them 3+
 *     characters, none a keyword-stopword, none a role/activity/logistics
 *     head. A slot that cannot confidently be read as a name returns null
 *     rather than guessing — the same fail-soft contract personCard keeps.
 */

import type { PersonRef } from '../types';
import { sanitizeKeywords } from '../events/ftsQuery';
import { historyToolArgs } from './historyIntent';
import { isPronounSlot } from './priorPerson';

/** lookup_facts' one slot, filled with the person the asker named. */
export interface IdentityToolArgs {
  topic: string;
}

/** The identity question shapes, and only these. Each captures its slot. */
const IDENTITY_SHAPES = [
  /^who(?:\s+(?:is|was)|['’]?s)\s+(.+)$/i,
  /^tell\s+me\s+(?:a\s+bit\s+|more\s+)?about\s+(.+)$/i,
  /^what\s+do\s+you\s+know\s+about\s+(.+)$/i,
];

/**
 * The camp-affiliation trailer an asker adds and a name never carries: "Who
 * is Marisol FROM THE CAMP" is a question about Marisol. Only "camp" and this
 * app's camp name head the clause — "the guy from Reno" is left whole, and
 * then fails the name test, which is the safe direction.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedAffiliation(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function affiliationLabels(affiliations: readonly string[]): string[] {
  return [...new Set(['camp', ...affiliations].map(label => label.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function stripAffiliationTrailer(
  value: string,
  affiliations: readonly string[],
): string {
  const labels = affiliationLabels(affiliations);
  const trailer = new RegExp(
    `\\s+(?:from|in|at|on|with|of)\\s+(?:the\\s+|our\\s+|this\\s+|my\\s+)?(?:${labels.map(escapeRegex).join('|')})(?:\\s+(?:camp|list))?$`,
    'iu',
  );
  return value.replace(trailer, '');
}

function isAffiliationName(
  value: string,
  affiliations: readonly string[],
): boolean {
  const normalized = normalizedAffiliation(value);
  return affiliationLabels(affiliations).some(
    label => normalizedAffiliation(label) === normalized,
  );
}

/** A word-shaped token: letters, plus the punctuation real names carry
 * ("O'Ryan", "Jean-Luc", "David T. Anderson"). A digit is never a name. */
const NAME_TOKEN = /^\p{L}[\p{L}\p{M}'’.-]*$/u;

/** The exact graph resolver is the authority. This ceiling only decides whether
 * an UNKNOWN slot is safe to close app-side rather than leaving to the model. */
const MAX_NAME_TOKENS = 3;

/** personCard's MIN_MATCH_TOKEN, for the same reason: a 1-2 character token
 * matches most English by accident, and a card whose every name form is that
 * short cannot engage the card path anyway — forcing a lookup buys nothing. */
const MIN_NAME_CHARS = 3;

/**
 * Words that survive the keyword-stopword filter but never NAME anyone. Two
 * groups, both taken from questions this router must not hijack:
 *  - ROLE and ACTIVITY heads — "who is the lead", "who is playing", "who is
 *    cooking" are camp-schedule questions wearing an identity shape;
 *  - the tool nudge's own LOGISTICS enumeration (water, ice, MOOP, exodus,
 *    medical, addresses, radio, bike rules, the 10 principles) — "tell me
 *    about ice" is a logistics question and keeps the model's own routing.
 * A name that collides with one of these (a camper called Ranger) loses the
 * floor and keeps today's path: a false negative costs nothing, a false
 * positive hijacks a working answer.
 */
const NOT_A_NAME = new Set([
  // role / activity / group heads
  'camp', 'camps', 'crew', 'team', 'people', 'person',
  'camper', 'campers', 'friend', 'friends', 'everyone', 'everybody',
  'anyone', 'anybody', 'someone', 'somebody', 'nobody',
  'lead', 'leads', 'leader', 'leaders', 'host', 'hosts', 'dj', 'djs',
  'cook', 'cooks', 'chef', 'greeter', 'greeters', 'ranger', 'rangers',
  'playing', 'performing', 'djing', 'cooking', 'speaking', 'hosting',
  'teaching', 'leading', 'driving', 'working', 'dancing', 'burning',
  'coming', 'staying', 'here', 'this', 'that', 'these', 'those',
  'he', 'she', 'him', 'her', 'his', 'hers', 'they', 'them', 'their',
  // the nudge's logistics enumeration
  'water', 'ice', 'moop', 'exodus', 'medical', 'radio', 'address',
  'addresses', 'bike', 'bikes', 'principle', 'principles', 'gate', 'temple',
  'man', 'burn', 'playa', 'dust', 'weather', 'shower', 'showers', 'toilet',
  'toilets', 'arctica', 'center', 'esplanade',
]);

/**
 * Read a name out of an identity question's slot, or null when it cannot be
 * read confidently. Pure string work — no database, no model.
 */
export function identityName(
  slot: string,
  affiliations: readonly string[] = [],
): string | null {
  const cleaned = stripAffiliationTrailer(
    slot
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, ''),
    affiliations,
  ).trim();
  if (isAffiliationName(cleaned, affiliations)) {
    return null;
  }
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_NAME_TOKENS) {
    return null;
  }
  for (const [index, token] of tokens.entries()) {
    if (!NAME_TOKEN.test(token)) {
      return null;
    }
    const word = token
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLocaleLowerCase()
      .replace(/[^\p{L}']/gu, '');
    if (!word || NOT_A_NAME.has(word)) {
      return null;
    }
    // A middle initial ("Alex J Mercer", "David T. Anderson") is one
    // character and cannot pass the keyword floor below, so it counts as a
    // name token only where an article never appears — after the first one.
    if (word.length === 1 && index > 0) {
      continue;
    }
    // The keyword-stopword test anchorTopic uses on capitalized words: a
    // stopword-shaped slot ("the", "any", "tonight") carries no name signal.
    if (sanitizeKeywords(word).length === 0) {
      return null;
    }
  }
  const substantial = tokens.some(
    token => token.replace(/[^\p{L}]/gu, '').length >= MIN_NAME_CHARS,
  );
  return substantial ? tokens.join(' ') : null;
}

export interface IdentityIntent {
  topic: string;
  anchoredPerson?: PersonRef;
  /** A syntactically name-like unknown may be closed honestly. A broader slot
   * only claims the turn when the structured resolver finds an exact person. */
  confidentUnknown: boolean;
}

/** Broad identity-shape parser. Graph identity, not an ASCII regex or retrieval
 * rank, decides whether a shipped camper name is real. */
export function identityIntent(
  text: string,
  anchor: PersonRef | string | null = null,
  affiliations: readonly string[] = [],
): IdentityIntent | null {
  if (historyToolArgs(text, anchor) !== null) {
    return null;
  }
  const q = text.trim().replace(/[?!.]+$/g, '').trim();
  for (const shape of IDENTITY_SHAPES) {
    const m = shape.exec(q);
    if (!m) {
      continue;
    }
    if (isPronounSlot(m[1])) {
      if (!anchor) {
        return null;
      }
      return typeof anchor === 'string'
        ? { topic: anchor, confidentUnknown: true }
        : { topic: anchor.name, anchoredPerson: anchor, confidentUnknown: true };
    }
    const topic = stripAffiliationTrailer(
      m[1]
        .trim()
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, ''),
      affiliations,
    ).trim();
    if (!topic || topic.length > 120 || /^\d+$/u.test(topic)) {
      return null;
    }
    return {
      topic,
      confidentUnknown: identityName(m[1], affiliations) !== null,
    };
  }
  return null;
}

/** Conservative compatibility wrapper for model-facing lookup_facts. */
export function identityToolArgs(
  text: string,
  anchor: PersonRef | string | null = null,
  affiliations: readonly string[] = [],
): IdentityToolArgs | null {
  const intent = identityIntent(text, anchor, affiliations);
  return intent && (intent.anchoredPerson || intent.confidentUnknown)
    ? { topic: intent.topic }
    : null;
}

export function shouldForceIdentityTool(
  text: string,
  anchor: PersonRef | string | null = null,
  affiliations: readonly string[] = [],
): boolean {
  return identityToolArgs(text, anchor, affiliations) !== null;
}
