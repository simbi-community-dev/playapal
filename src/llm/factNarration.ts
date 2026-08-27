import type { ChatCard, PersonFactCard } from '../types';
import type { HistoryAbsence } from '../facts/historyLookup';
import type { PersonIdentityCandidate } from '../facts/personIdentity';

/**
 * A KNOWABLE ABSENCE is app-owned prose, exactly like a person card.
 *
 * The packs were searched for a person the asker named and they carry
 * nothing. That is a FACT the app established, not a gap for a 2.6B to
 * narrate over — and narrating over it is how "Who is Coco" became a camp in
 * the 9:00 sector, for a camper who is dead and memorialized. So the sentence
 * is written here and the model's is dropped, the same way its prose is
 * dropped when a card comes back.
 */
export function absentNarration(entity: string): string {
  return `I don't have anything about ${entity} in the packs you're carrying.`;
}

function identityKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function candidateLabel(
  query: string,
  candidate: PersonIdentityCandidate,
): string {
  const used = new Set([identityKey(query), identityKey(candidate.name)]);
  const detail = candidate.aliases.find(alias => !used.has(identityKey(alias)));
  return detail ? `${candidate.name} (${detail})` : candidate.name;
}

function naturalList(items: string[]): string {
  if (items.length < 2) {
    return items[0] ?? '';
  }
  return items.length === 2
    ? `${items[0]} and ${items[1]}`
    : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function personAmbiguityNarration(
  query: string,
  candidates: PersonIdentityCandidate[],
): string {
  const base = candidates.map(candidate => candidateLabel(query, candidate));
  const counts = new Map<string, number>();
  for (const label of base) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = base.map((label, i) =>
    (counts.get(label) ?? 0) > 1
      ? `${label} (${candidates[i].pack_id})`
      : label,
  );
  return labels.length > 0
    ? `There are ${labels.length} campers matching ${query} in your packs — ${naturalList(labels)}. Which one?`
    : `There is more than one camper matching ${query} in your packs. Which one?`;
}

export function personNotFoundNarration(query: string): string {
  return `I couldn't match ${query} to one camper in the packs you're carrying.`;
}

export function personCardUnavailableNarration(name: string, packName: string): string {
  return `I found ${name} in ${packName}, but that pack doesn't carry their person card.`;
}

/**
 * A CAMP-HISTORY lookup ran and the camp pack carries nothing for it — the
 * relational sibling of absentNarration, and app-owned for a sharper reason
 * than fabrication.
 *
 * DEVICE RECEIPT (2026-08-16, owner testing): "who sponsored her?" came back
 * not_found and the turn closed with "…but you can always ask your campmates
 * or check Playa Info at Esplanade & 5:45." That address is REAL — it is
 * verbatim in the shipped survival guide — and that is exactly what makes it
 * the wrong answer, and one no fabrication check would ever catch. Playa Info
 * is a Black Rock City services desk: lost and found, tows, lockouts,
 * directions. It cannot say who sponsored a camper into this camp, for any
 * camper, ever. Pointing there is a DOMAIN error: true, useless, and it reads
 * as the app not understanding what it was asked.
 *
 * THE DISCRIMINATOR IS THE QUESTION'S DOMAIN, NOT THE SHAPE OF THE STRING.
 * A camp-history question is answered out of the camp pack, so its empty
 * state refers INTO the camp: campmates, the camp list, the people who were
 * there. A survival/logistics question is answered out of the guide, so its
 * empty state keeps every city referral it has — "check Playa Info at
 * Esplanade & 5:45" is a genuinely good answer to "where is lost and found",
 * and nothing here touches that path.
 *
 * The referral doubles as camp-voice's referral move: who brought you into
 * this camp is a story the campmates own, and the Angel offers the door
 * rather than reciting through it.
 */
export function campHistoryAbsenceNarration(absence: HistoryAbsence): string {
  const { entity, target } = absence;
  if (absence.query === 'cohort') {
    return (
      `I don't have a roster for ${entity} in the camp pack yet — the ` +
      `campmates who were there would remember it better anyway.`
    );
  }
  const subject =
    absence.query === 'sponsors'
      ? `sponsorship records for ${entity}`
      : absence.query === 'sponsees'
        ? `a record of who ${entity} sponsored`
        : absence.query === 'attendance'
          ? `a record of which years ${entity} camped`
          : absence.query === 'projects'
            ? `a record of what ${entity} worked on`
            : `a sponsorship line between ${entity} and ${target}`;
  return (
    `I don't have ${subject} in the camp pack yet — your campmates would ` +
    `know, and it's really theirs to tell.`
  );
}

/**
 * A lookup ran across the packs and came back empty. Honest, plain, and
 * oriented outward (an empty state is an invitation, never an
 * apology and never whimsy) — the packs are named as the boundary, because
 * the boundary is the true part.
 */
export function nothingFoundNarration(topic: string): string {
  return `I looked through the packs you're carrying and found nothing about ${topic}. ` +
    'Try another word for it?';
}

export const NOTHING_FOUND = nothingFoundNarration('that');

/**
 * The model produced no words at all, twice, having looked nothing up. This
 * is the app failing to answer — say so. "That one slipped away into the
 * dust" narrated a disappearance that never happened; nothing slipped away,
 * the Angel came up empty.
 */
export const NO_ANSWER = "I couldn't put an answer together for that one — ask me again?";

/** The speechless-turn close when retrieval DID land something: the cards
 * under the bubble are real, so the apology must not disown them (measured
 * 2026-08-17: "couldn't put an answer together" rendered above a correct
 * Sunrise Robot Heart event card). */
export const FOUND_UNWRITTEN =
  "I dug up what's below but couldn't wrap words around it — the cards speak for themselves. Ask again and I'll try the telling.";

/** Numeric and relational facts never cross the model-prose boundary. */
export function structuredCardNarration(cards: ChatCard[]): string | null {
  const person = cards.find(
    (card): card is PersonFactCard => card.kind === 'person',
  );
  const records = cards.some(
    card => card.kind !== 'event' && card.kind !== 'person',
  );
  if (!person && !records) {
    return null;
  }
  const events = cards.some(card => card.kind === 'event');
  if (person) {
    // The one deferential line the model's job degrades to. camp-voice
    // register: unhurried, warm, never performing grief and never leading a
    // memorial with how much archive the camp has.
    const line = person.memoriam
      ? `Here's what the camp remembers of ${person.name}.`
      : `Here's what the camp list remembers about ${person.name}.`;
    return events ? `${line} Matching events are below too.` : line;
  }
  return events
    ? 'I found matching events and camp-history records below.'
    : 'I found matching camp-history records below.';
}
