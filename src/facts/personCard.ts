/**
 * PERSON CARDS — the identity twin of lookup_history's relational cards.
 *
 * DEVICE-MEASURED FAILURE (chat_log receipts, 2026-08-16, v3.0 model): a
 * fresh session asked "Who is Marisol from the camp". Routing was right
 * (lookup_facts{topic:"marisol from camp"}) and retrieval was right — it
 * returned "Campers > Marisol Vega (Marisol) — Dusty Star camper > Who is
 * Marisol Vega? Marisol Vega is a Dusty Star camper, active on the camp
 * list from Mar 2010 to Aug 2026, …". The model then answered "I don't have
 * details on who Marisol is in your specific camp right now." A FALSE IDK
 * OVER RETRIEVED EVIDENCE — and the same question shape for "Who is pug"
 * answered faithfully in the same build. Unreliable, not broken: the class
 * prompt wording cannot fix.
 *
 * The cure this repo already proved for relational facts (historyLookup):
 * take the answer out of the model's mouth. A retrieved passage that IS a
 * person card gets parsed here and rendered by the app; the model's prose is
 * replaced by one deferential line (llm/factNarration).
 *
 * DETECTION IS STRUCTURAL — never a shape read off prose:
 *  1. source_file starts with "people-" — the pack-file convention that
 *     searchDocs' about-pin already relies on for "about-*";
 *  2. the heading breadcrumb is exactly three segments, the middle one
 *     "<name>[ (<also known as>)] — <camp> camper" and the leaf
 *     "Who is <name>?";
 *  3. the two segments AGREE on the name (425/425 in the shipped
 *     dusty-star-lore-25y pack) — a disagreement means the shape drifted;
 *  4. the passage's first paragraph opens with that same name and carries a
 *     parseable activity window.
 * Segment 0 ("Campers") is deliberately NOT pinned: it is the people file's
 * H1 and the least stable part of the shape, while "… camper" + "Who is …?"
 * already pin the domain. Any camp's people-*.md that follows the shape
 * works; anything else falls through to today's prose path unchanged.
 *
 * FAIL SOFT IS THE CONTRACT. Every step above returns null rather than
 * guessing, and a null means the turn behaves exactly as it does today. A
 * card that renders wrong is far worse than prose that reads fine.
 *
 * ENGAGEMENT is narrower still (see personCardFromResults): the card is
 * built only from the TOP-RANKED passage, and only when the user's own
 * question carries that camper's name. The two gates together are what keep
 * a person card that merely rode along in the results from hijacking a
 * non-person answer.
 */

import type { DocSearchOutcome, PersonFactCard, PersonRef } from '../types';
import { identityToolArgs } from '../llm/identityIntent';
import { normalizeFactEntity } from './normalizeFactEntity';

/** The people-pack file convention, sibling of about-*.md (searchDocs). */
const PEOPLE_SOURCE_PREFIX = 'people-';

/** "Marisol Vega (Marisol) — Dusty Star camper" (em dash, always spaced). */
const CAMPER_HEADING = /^(.+?)(?: \((.+?)\))? — (.+) camper$/;
/** "Who is Marisol Vega?" — the pack states the question the card answers. */
const WHO_IS_HEADING = /^Who is (.+)\?$/;

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
/** "from Mar 2010 to Aug 2026", "in Sep 2015", "once, in Mar 2013". */
const TENURE = new RegExp(
  `\\b(?:from|in)\\s+(${MONTH} \\d{4})(?:\\s+to\\s+(${MONTH} \\d{4}))?`,
);
/** The card's own alias sentence — always the last one in the summary
 * paragraph, and anchored there because the names inside carry periods of
 * their own ("Also appears on the list as David T. Anderson."). */
const ALIAS_SENTENCE = /\s*Also appears on the list as (.+)\.\s*$/;
/** camp-voice: a memorial card never leads with how much archive it has. */
const VOLUME_CLAUSE = /,\s*with \d+ list messages? across \d+ threads?/;
const MEMORIAM_PREFIX = 'In memoriam.';

/**
 * A single-token name may only earn a question match at 3+ characters: the
 * shipped pack lists campers as "A", "C", "I", "n" and "DL", and a one- or
 * two-character token matches most English sentences by accident.
 */
const MIN_MATCH_TOKEN = 3;

type Passage = DocSearchOutcome['results'][number];

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Space-padded canonical fact normalization so `includes` is a
 * whole-token-sequence test. */
function normalized(value: string): string {
  return ` ${normalizeFactEntity(value)} `;
}

export function parsePersonCardHeading(
  heading: string,
): { name: string; alsoKnownAs: string | null } | null {
  const parts = heading.split('>').map(part => part.trim()).filter(Boolean);
  if (parts.length !== 3) {
    return null;
  }
  const card = CAMPER_HEADING.exec(parts[1]);
  const leaf = WHO_IS_HEADING.exec(parts[2]);
  if (!card || !leaf || card[1] !== leaf[1]) {
    return null;
  }
  return { name: card[1], alsoKnownAs: card[2] ?? null };
}

/**
 * Parse one retrieved passage into a person card, or null when it is not one
 * (or not confidently one). Pure string work — no database, no model.
 */
export function parsePersonCard(passage: Passage): PersonFactCard | null {
  if (!passage.source_file.startsWith(PEOPLE_SOURCE_PREFIX)) {
    return null;
  }
  const heading = parsePersonCardHeading(passage.heading);
  if (!heading) {
    return null;
  }
  const paragraphs = passage.content
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean);
  const lead = paragraphs[0] ?? '';
  // The summary sentence always opens with the name the headings declare.
  // Anything else is a mid-card chunk or a drifted shape: no card.
  if (!normalized(lead).startsWith(normalized(heading.name))) {
    return null;
  }
  const tenure = TENURE.exec(lead);
  if (!tenure) {
    return null;
  }
  const aliasMatch = ALIAS_SENTENCE.exec(lead);
  const memoriam = paragraphs.find(part => part.startsWith(MEMORIAM_PREFIX)) ?? null;
  let summary = aliasMatch ? lead.replace(ALIAS_SENTENCE, '') : lead;
  if (memoriam) {
    summary = summary.replace(VOLUME_CLAUSE, '');
  }
  return {
    kind: 'person',
    name: heading.name,
    alsoKnownAs: heading.alsoKnownAs,
    aliases: aliasMatch ? [aliasMatch[1].trim()].filter(Boolean) : [],
    tenure: { from: tenure[1], to: tenure[2] ?? null },
    summary: summary.trim(),
    memoriam,
    pack_id: passage.pack_id,
    evidence_ref: `${passage.source_file}#${slug(heading.name)}`,
  };
}

/** Materialize a card only when the linked document still declares the exact
 * canonical identity the graph resolved. A stale link fails closed. */
export function materializePersonCard(
  passage: Passage,
  person: PersonRef,
): PersonFactCard | null {
  const card = parsePersonCard(passage);
  return card && normalized(card.name) === normalized(person.name)
    ? { ...card, person_ref: person }
    : null;
}

/** Every name form the card carries that is long enough to match on. */
function matchKeys(card: PersonFactCard): string[] {
  return [card.name, ...(card.alsoKnownAs ? [card.alsoKnownAs] : []), ...card.aliases]
    .map(normalized)
    .filter(key =>
      key
        .trim()
        .split(' ')
        .some(token => token.length >= MIN_MATCH_TOKEN),
    );
}

/** Did the asker actually name this camper? Whole-token-sequence match on
 * the user's own words — the same untrusted-hint discipline anchorTopic
 * applies to the model's topic slot. */
export function questionNamesPerson(card: PersonFactCard, rawUserText: string): boolean {
  const question = normalized(rawUserText ?? '');
  return matchKeys(card).some(key => question.includes(key));
}

/**
 * The engagement rule, in one sentence: render a person card when a
 * retrieved passage is a person card whose name the asker's question
 * carries — from the top rank always, from a lower rank only when the asker
 * explicitly asked WHO SOMEONE IS.
 *
 * THE WIDENING (owner ruling: the person card is the standard shape for any
 * "who is" answer). Top-ranked-only was the original deliberate
 * under-trigger, and its own doc-comment named it the first dial to open.
 * The gap it left is real and common: lookup_facts returns two passages, so
 * a camper whose lore thread out-ranks their own card ("Who is Marisol" ->
 * [bus thread, Marisol's card]) fell all the way back to model prose — which
 * is the exact configuration that produced the measured false IDK. Rank is
 * a retrieval detail; whether the asker asked who someone is is not.
 *
 * The widening is gated hard, and BOTH original gates still stand behind it:
 *  1. the question must parse as an identity question (llm/identityIntent —
 *     "who is X", "tell me about X", and nothing else; an events, logistics
 *     or relational question keeps top-ranked-only, byte for byte);
 *  2. the passage must still parse structurally as a person card;
 *  3. the asker must still have named that camper themselves.
 * A wrong card is still worse than prose that reads fine — this only lets a
 * card the asker asked for win over its own rank.
 *
 * PRONOUNS COUNT AS NAMING (llm/priorPerson). "Tell me about her" one turn
 * after the app rendered Coco's card IS "tell me about Coco" — the app did
 * that resolving itself and showed its work. Both gates are anchor-aware or
 * neither is: gate 1 would otherwise read a pronoun question as no identity
 * question at all, and gate 3 would ask the asker to repeat a name the app
 * just put on their screen. The expansion is proved to come from the ANCHOR,
 * never from the model's slot: the anchor-free parse must return null first.
 */
export function personCardFromResults(
  results: Passage[],
  rawUserText: string,
  personAnchor: PersonRef | string | null = null,
  affiliations: readonly string[] = [],
): PersonFactCard | null {
  const top = results[0];
  if (!top) {
    return null;
  }
  const identity = identityToolArgs(rawUserText, personAnchor, affiliations);
  const asked =
    identity !== null && identityToolArgs(rawUserText, null, affiliations) === null
      ? `${rawUserText} ${identity.topic}`
      : rawUserText;
  const first = parsePersonCard(top);
  if (first && questionNamesPerson(first, asked)) {
    return first;
  }
  if (identity === null) {
    return null;
  }
  for (const passage of results.slice(1)) {
    const card = parsePersonCard(passage);
    if (card && questionNamesPerson(card, asked)) {
      return card;
    }
  }
  return null;
}
