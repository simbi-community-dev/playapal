/**
 * THE SESSION'S PERSON ANCHOR — one hop of coreference, one slot, and no more.
 *
 * DEVICE-MEASURED FAILURE (chat_log receipt, 2026-08-16, owner testing):
 *   turn 1  "Who is Coco"        -> lookup_facts -> Coco's person card renders.
 *   turn 2  "who sponsored her?" -> lookup_history{"query":"sponsors",
 *                                   "entity":"her"} -> not_found, candidates []
 * There is no camper named "her", so that lookup could only fail. The
 * question was perfectly clear: the app had JUST rendered Coco's card, so it
 * knew exactly who "her" was — and threw that knowledge away at the slot
 * filler, which reads the literal words of one sentence and nothing else.
 *
 * THE ANCHOR IS THE APP'S OWN PRIOR RESOLUTION, never the raw text. The
 * strongest thing in the session is not "the last capitalized word the user
 * typed" — it is an exact PersonRef from the graph resolver, committed only
 * after its direct person card or singular history card survives final
 * reconciliation. A text- or presentation-card-scraped anchor would guess;
 * this one repeats a structured decision the app already made and showed.
 *
 * CONSERVATIVE BY CONSTRUCTION:
 *  - only a slot that is EXACTLY a bare third-person pronoun is replaced —
 *    "her" resolves, "her camp" and "the guy from Reno" never do;
 *  - replacement happens only when a prior person entity exists in THIS
 *    session; with no anchor the pronoun is left alone and today's path runs
 *    byte-for-byte;
 *  - the anchor is read once at the top of a turn, so a turn's own lookups
 *    can never re-point the pronoun the same turn is resolving;
 *  - cards that name two people (a sponsorship path) or many (a cohort) set
 *    no anchor at all: an ambiguous antecedent is worse than none.
 */

import type { ChatCard, PersonRef } from '../types';

/**
 * The pronouns a follow-up question uses for someone already named. Subject,
 * object and possessive forms all appear in the shapes historyIntent parses
 * ("who sponsored her", "who did they sponsor", "projects by him").
 */
const THIRD_PERSON_PRONOUNS = new Set([
  'he', 'him', 'his',
  'she', 'her', 'hers',
  'they', 'them', 'their', 'theirs',
]);

/**
 * Is this slot a bare third-person pronoun? Punctuation and quotes are
 * stripped; internal whitespace is NOT collapsed away, so a multi-word slot
 * can never collide with a single pronoun.
 */
export function isPronounSlot(slot: string): boolean {
  const word = slot.toLowerCase().replace(/[^a-z']+/g, ' ').trim();
  return THIRD_PERSON_PRONOUNS.has(word);
}

/**
 * The person slot as the app should read it: the anchor when the asker used
 * a bare pronoun and this session has resolved someone, otherwise the slot
 * exactly as written.
 */
export interface ResolvedPersonSlot {
  value: string;
  anchored: boolean;
  pack_id?: string;
}

export function resolvePersonArgument(
  slot: string,
  anchor: PersonRef | string | null,
): ResolvedPersonSlot {
  if (anchor === null || !isPronounSlot(slot)) {
    return { value: slot, anchored: false };
  }
  return typeof anchor === 'string'
    ? { value: anchor, anchored: true }
    : { value: anchor.name, anchored: true, pack_id: anchor.pack_id };
}

export function resolvePersonSlot(
  slot: string,
  anchor: PersonRef | string | null,
): string {
  return resolvePersonArgument(slot, anchor).value;
}

/**
 * The exact graph identity attached to a direct person card, or null.
 * Presentation-only history cards deliberately cannot recreate an identity
 * from a display name; LlamaSession commits their ToolOutcome.resolvedPerson
 * only after final evidence reconciliation.
 */
export function personAnchorFromCards(cards: readonly ChatCard[]): PersonRef | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const card = cards[i];
    if (card.kind === 'person' && card.person_ref) {
      return card.person_ref;
    }
  }
  return null;
}
