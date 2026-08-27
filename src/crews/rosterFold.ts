/**
 * ONE PERSON, ONE ROW — folding the identity a reinstall leaves behind.
 *
 * MEASURED ON TWO PHONES (field sweep X4): a phone was wiped and rejoined
 * the pod. The roster then showed TWO rows both reading the same playa
 * name — one live, one "seen 20m ago" — and counted 2 for what was one
 * other phone standing right there.
 *
 * THE MECHANISM, and it is not a bug in any one file. A phone's identity IS
 * its FriendCard id, minted as randHex(8) on first read and persisted from
 * that moment (src/friends/friendCard.ts). A wipe takes the store with it,
 * so the reinstall mints a DIFFERENT id and there is no continuity anywhere
 * to tie the two together — no key, no recovery phrase, no claim record.
 * Meanwhile the old identity's announcement is a 7-day record on a
 * store-and-forward mesh that nobody can retract (src/crews/podMembers.ts
 * header: "there is no retraction"). So podRoster, which dedupes by CARD
 * ID and is right to, resolves two authors — and both spell the same name.
 *
 * ∴ THE ONLY EVIDENCE AVAILABLE IS BEHAVIOURAL, and this file is the place
 * that says so. It cannot know the two rows are one person. It can only
 * know that one identity is on the air right now and the other has gone
 * quiet, and act on the reading a camper would make standing there.
 *
 * WHY NOT DEDUPE BY NAME (the obvious cure, and the wrong one). Two people
 * in one camp can share a playa name — the whole city runs on nicknames and
 * a duplicate is a joke, not an error. A name-only dedupe deletes a real
 * person from the roster of the app whose job is finding people in a dust
 * storm, and it does it silently, forever, with no way for either of them
 * to discover why. So NAME ALONE NEVER FOLDS ANYTHING here.
 *
 * WHAT DOES FOLD, all four conditions together:
 *   1. the rows resolve to the same name (case- and space-insensitive),
 *   2. EXACTLY ONE of them is live by Bluetooth right now — two live
 *      same-name rows are two people who are both here, and a group with
 *      nobody live is one this file has no evidence about at all,
 *   3. the quiet one's announcement is strictly OLDER than the live one's,
 *      which is always true of a reinstall (the new id is minted after the
 *      wipe) and is what protects the podmate who joined by code sixty
 *      seconds ago and whose first beacon has not landed yet, and
 *   4. both actually announced — a picked card that never said anything
 *      carries no ordering, so it is left alone.
 *
 * NOTHING IS DELETED AND NOTHING IS SILENT. The fold produces one row that
 * KEEPS the folded identities (`quiet`) and carries a line that says a
 * second phone here goes by this name (`quietNote`). If the reading is
 * wrong and they are two different people, the row says so, and the fold
 * undoes itself the moment the quiet phone's beacon lands — condition 2
 * stops holding and both rows come back. A heuristic that reverses itself
 * on new evidence and shows its work is a different thing from a dedupe.
 *
 * THE ONE THING NOT MERGED IS THE ADDRESS. The quiet identity often holds
 * the friend card, and the live one — freshly installed — often holds
 * nothing. It is tempting to lend the card across the fold so the row keeps
 * a camp and an address. It must not: if the reading IS wrong, that points
 * a camper at the wrong person's camp, which is the failure presence.ts
 * refuses for stale positions ("points people the wrong way in a whiteout")
 * and it would arrive dressed as a confident address. The row keeps its own
 * card or none, and offers the card swap it already offers.
 *
 * SURVIVES A RESTART BY GOING QUIET, NOT BY GUESSING: presence is an
 * in-memory map (src/crews/presence.ts), so a freshly launched app has
 * nobody live and folds nothing until beacons arrive. Two rows for a minute
 * is the honest state of a phone that has not heard anyone yet.
 *
 * TWO BOUNDS THAT REMAIN, known and accepted rather than discovered later
 * (cross-family review, Aug 24):
 *
 *  - CLOCK SKEW. Condition 3 compares announcedMin stamps, and across two
 *    DIFFERENT phones those are two different clocks — the accept gate
 *    tolerates days of skew. For the true reinstall (one phone, one clock,
 *    before and after a wipe) the ordering is sound; for two same-named
 *    strangers it can point either way. The false fold that survives it is
 *    bounded by everything above — reversal on beacon, the visible note,
 *    and the card guard in the filter below — not by the stamp being
 *    trustworthy, because it is not.
 *
 *  - RENDER STALENESS — closed after the release. Liveness EXPIRING is
 *    not an event, so a fold made while a phone was live could outlive
 *    its evidence on screen until unrelated traffic re-rendered the
 *    section. CrewSection now carries a slow liveness heartbeat (a
 *    60-second tick; presence is re-read on every render), which bounds
 *    the hold at one beat instead of "whenever the mesh next speaks".
 */

import { presenceFor } from './presence';
import type { PodMember } from './podMembers';

/** One PERSON on the pod card: a roster row plus whatever it absorbed. */
export interface PodPerson extends PodMember {
  /** Identities folded into this row — same name, gone quiet, older
   * announcement. Empty for the overwhelming majority of rows. Kept rather
   * than dropped: the fold is a reading, and a reading has to be able to
   * show its evidence. */
  quiet: PodMember[];
  /** The one line the row shows when something was folded in, else null. */
  quietNote: string | null;
}

/** Same-person-by-name, as loosely as is still safe: trimmed, whitespace
 * collapsed, case-folded. Deliberately no fuzzier than that — "Pug" and
 * "Pug!" are two nameplates and this file does not get to decide they are
 * one person. Exported because the pod link list (podStatus.ts) matches
 * walkie channel rows to roster rows by name — the peers event carries no
 * card id — and TWO folding rules would disagree about who is who. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The line the folded row carries. Names the ambiguity instead of hiding
 * it, and states the exact condition that undoes the fold — because that
 * condition is the camper's recourse, not a footnote about it.
 */
function quietNoteFor(name: string, quietCount: number): string {
  const who =
    quietCount === 1
      ? `Another phone here goes by ${name} too`
      : `${quietCount} other phones here go by ${name}`;
  return (
    `${who} — this is the live one. If that's a different ${name}, ` +
    'their row comes back the moment their phone says hello.'
  );
}

/**
 * The decision itself, pure for tests: liveness arrives as a predicate so
 * this never touches the sighting store or a clock.
 *
 * Order is preserved exactly — podRoster's order is meaningful (picked
 * people first, in the order the user picked them) and folding must not
 * reshuffle the list a camper has learned to read.
 */
export function foldRosterGhosts(
  rows: PodMember[],
  isLive: (cardId: string) => boolean,
): PodPerson[] {
  const groups = new Map<string, PodMember[]>();
  for (const row of rows) {
    const key = nameKey(row.name);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  /** cardId -> the rows folded into it. */
  const absorbed = new Map<string, PodMember[]>();
  /** cardIds that no longer get a row of their own. */
  const folded = new Set<string>();

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const live = group.filter(r => isLive(r.cardId));
    if (live.length !== 1) {
      // Two live same-name phones are two people; none live is no evidence.
      continue;
    }
    const survivor = live[0];
    const since = survivor.announcedMin;
    if (since === null) {
      continue; // nothing to order the others against (condition 4)
    }
    // Everyone else in the group is already known not-live (live.length is
    // 1), so the remaining tests are the ordering ones.
    const quiet = group.filter(
      r =>
        r.cardId !== survivor.cardId &&
        r.announcedMin !== null &&
        r.announcedMin < since &&
        // THE CARD GUARD (cross-family review, both rounds): a carded row
        // NEVER folds. A swapped card is human-verified identity plus a
        // camp address — a compass target for finding this person
        // precisely when they are NOT in radio range — and any fold hides
        // it behind a footnote at the exact moment it is the most useful
        // line on the screen. Round one narrowed this to "not into a
        // card-less survivor"; round two showed the both-carded fold
        // still buries a card that may be a different same-named PERSON'S
        // camp. Cards are for humans to reconcile: the duplicate stands,
        // visibly, until someone removes the stale card in Edit.
        r.card === null,
    );
    if (quiet.length === 0) {
      continue;
    }
    absorbed.set(survivor.cardId, quiet);
    for (const q of quiet) {
      folded.add(q.cardId);
    }
  }

  return rows
    .filter(r => !folded.has(r.cardId))
    .map(r => {
      const quiet = absorbed.get(r.cardId) ?? [];
      return {
        ...r,
        quiet,
        quietNote:
          quiet.length > 0 ? quietNoteFor(r.name, quiet.length) : null,
      };
    });
}

/**
 * MY OWN GHOST — the fold the group logic can never make, because the
 * roster excludes the current self before anyone looks at it.
 *
 * A reinstall mints a new card id, so the identity this phone announced
 * BEFORE the wipe is, to the roster, another person: same name, gone
 * quiet, standing in the list of a pod whose owner is holding the phone.
 * Observed in the field as a "Pug" row on Pug's own screen and a "2 so
 * far" count for one person.
 *
 * The self-anchor is the phone's owner, definitionally present, so
 * liveness needs no radio: a quiet, announced, CARD-LESS row bearing my
 * own name is claimed as my past. Carded rows are never claimed — a card
 * is human-verified identity plus an address worth rendering, and a real
 * same-named podmate who swapped cards must keep their row (the card
 * guard, same rule as the group fold). A LIVE same-named row is a real
 * person with a beaconing phone and is never touched.
 *
 * Pure; liveness injected like foldRosterGhosts.
 */
export function partitionSelfGhosts(
  rows: PodMember[],
  myName: string | null,
  isLive: (cardId: string) => boolean,
): { rows: PodMember[]; selfGhosts: PodMember[] } {
  const key = myName ? nameKey(myName) : '';
  if (!key) {
    return { rows, selfGhosts: [] };
  }
  const selfGhosts = rows.filter(
    r =>
      nameKey(r.name) === key &&
      r.card === null &&
      r.announcedMin !== null &&
      !isLive(r.cardId),
  );
  if (selfGhosts.length === 0) {
    return { rows, selfGhosts };
  }
  const gone = new Set(selfGhosts.map(r => r.cardId));
  return { rows: rows.filter(r => !gone.has(r.cardId)), selfGhosts };
}

/** The one line the roster's footer shows when a self-ghost was claimed —
 * names the reading AND the condition that reverses it, the same honesty
 * contract as the row-level quietNote. */
export function selfGhostNote(myName: string, count: number): string {
  const who =
    count === 1
      ? `An older phone here also went by ${myName}`
      : `${count} older phones here also went by ${myName}`;
  return (
    `${who} — probably this phone before a reinstall. If that's someone ` +
    `else, their row comes back the moment their phone says hello.`
  );
}

/**
 * The pod card's one call: the roster as PEOPLE, reading liveness from the
 * sighting store. `nowMs` is injectable for the same reason presenceFor's
 * is — this is a render-time read, not a protocol function. The self
 * partition runs FIRST, so my own quiet past can never be folded into some
 * other live camper who happens to share my name.
 */
export function foldPodRoster(
  rows: PodMember[],
  nowMs: number = Date.now(),
  myName: string | null = null,
): { people: PodPerson[]; selfGhosts: PodMember[] } {
  const live = (cardId: string) => presenceFor(cardId, nowMs)?.live === true;
  const { rows: kept, selfGhosts } = partitionSelfGhosts(rows, myName, live);
  return { people: foldRosterGhosts(kept, live), selfGhosts };
}
