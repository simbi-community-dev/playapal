/**
 * The reinstall ghost (src/crews/rosterFold.ts) — field sweep X4, measured
 * on two phones: one was wiped and rejoined the pod, and the roster then
 * showed TWO rows with the same playa name (one live, one "seen 20m ago")
 * and counted 2 for one other phone.
 *
 * The mechanism is structural: a wipe mints a new FriendCard id, the old
 * identity's announcement is a 7-day record nobody can retract, and
 * podRoster dedupes by card id — correctly. So the only cure available is a
 * reading at render time, and the reading is only as good as what stops it
 * from firing. That is what this suite is mostly about: every test below
 * that does NOT fold is guarding a real person against being deleted from
 * the roster of the app that exists to find people.
 *
 * Presence is the real module (an in-memory map with no db and no native
 * behind it), so the last arm exercises the shipped read path rather than a
 * predicate written for the occasion.
 */

import {
  LIVE_WINDOW_MS,
  reportSighting,
  pruneSightings,
} from '../src/crews/presence';
import { hash32 } from '../src/crews/beacon';
import {
  foldPodRoster,
  foldRosterGhosts,
  partitionSelfGhosts,
  selfGhostNote,
} from '../src/crews/rosterFold';
import type { PodMember } from '../src/crews/podMembers';

const member = (
  cardId: string,
  name: string,
  announcedMin: number | null,
  card: PodMember['card'] = null,
): PodMember => ({ cardId, name, card, announcedMin });

const CARD = {
  id: 'old-tumbleweed',
  name: 'Tumbleweed',
  camp: 'Camp Whiptail',
  address: '4:30 & Esplanade',
  updated_at: '2026-08-20T00:00:00.000Z',
};

/** Nobody is on the air unless a test says so. */
const noneLive = () => false;
const liveOnly =
  (...ids: string[]) =>
  (cardId: string) =>
    ids.includes(cardId);

describe('a reinstall leaves one person, not two', () => {
  test('the ghost folds into the live row and the count drops to one', () => {
    // The announced-only reinstall: same name, older announcement, gone
    // quiet, no card — the identity a phone leaves behind when it is wiped
    // before anyone swapped cards with it. (A ghost that HOLDS a card is
    // deliberately not this case any more — see the card guard below.)
    const rows = [
      member('old-tumbleweed', 'Tumbleweed', 100),
      member('new-tumbleweed', 'Tumbleweed', 400),
    ];
    const people = foldRosterGhosts(rows, liveOnly('new-tumbleweed'));
    // Mutation: drop the fold and the pod card counts two of one camper.
    expect(people).toHaveLength(1);
    expect(people[0].cardId).toBe('new-tumbleweed');
    expect(people[0].quiet.map(q => q.cardId)).toEqual(['old-tumbleweed']);
  });

  test('the folded row keeps the identity it absorbed, never drops it', () => {
    // Mutation: fold by deletion instead. The row can no longer say what it
    // did, and the reading becomes unfalsifiable to the person reading it.
    const people = foldRosterGhosts(
      [
        member('old-tumbleweed', 'Tumbleweed', 100),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      liveOnly('new-tumbleweed'),
    );
    expect(people[0].quiet[0].announcedMin).toBe(100);
    expect(people[0].quietNote).toContain('Tumbleweed');
    // The recourse is IN the copy: this is the exact condition that undoes
    // the fold, so a second real Tumbleweed knows what to wait for.
    expect(people[0].quietNote).toContain('says hello');
  });

  test('THE CARD GUARD: a carded identity never folds into a card-less one', () => {
    // Sharpened from "the address is not lent across the fold" after
    // cross-family review: not lending the address was necessary but not
    // sufficient, because the fold still HID it. A swapped card is
    // human-verified identity plus a camp address — a compass target for
    // finding this person precisely when they are NOT in radio range —
    // and folding it behind a card-less survivor buries that line at the
    // moment it is most useful. If the two are different same-named
    // people, it buries the WRONG person's camp. The honest duplicate
    // stands until the humans re-swap.
    const people = foldRosterGhosts(
      [
        member('old-tumbleweed', 'Tumbleweed', 100, CARD),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      liveOnly('new-tumbleweed'),
    );
    expect(people).toHaveLength(2);
    expect(people.every(p => p.quietNote === null)).toBe(true);
    // ...and the carded row still shows its card.
    expect(people.find(p => p.cardId === 'old-tumbleweed')!.card).toBe(CARD);
  });

  test('a carded ghost does not fold even into a carded survivor', () => {
    // Round two of the review killed the both-carded fold the first
    // round had allowed: the quiet card can be a DIFFERENT same-named
    // person's camp, and the survivor rendering its own card does not
    // un-bury the one the fold hides. Cards are for humans to reconcile;
    // the duplicate stands until someone removes the stale card in Edit.
    const newCard = { ...CARD, id: 'new-tumbleweed' };
    const people = foldRosterGhosts(
      [
        member('old-tumbleweed', 'Tumbleweed', 100, CARD),
        member('new-tumbleweed', 'Tumbleweed', 400, newCard),
      ],
      liveOnly('new-tumbleweed'),
    );
    expect(people).toHaveLength(2);
    expect(people.every(p => p.quietNote === null)).toBe(true);
  });
});

describe('what must never fold — two campers can share a playa name', () => {
  test('two live people with one name both keep their rows', () => {
    // Mutation: dedupe by name. A real camper vanishes from the roster,
    // silently, with no way for either of them to find out why.
    const rows = [
      member('sparkle-a', 'Sparkle', 100),
      member('sparkle-b', 'Sparkle', 400),
    ];
    const people = foldRosterGhosts(rows, liveOnly('sparkle-a', 'sparkle-b'));
    expect(people.map(p => p.cardId)).toEqual(['sparkle-a', 'sparkle-b']);
    expect(people.every(p => p.quietNote === null)).toBe(true);
  });

  test('with nobody live there is no evidence, so nothing folds', () => {
    // Mutation: fold on the older announcement alone. Every app launch
    // (presence starts empty) would then delete a row before the first
    // beacon lands.
    const people = foldRosterGhosts(
      [
        member('old-tumbleweed', 'Tumbleweed', 100),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      noneLive,
    );
    expect(people).toHaveLength(2);
  });

  test('a NEWER announcement is never folded into an older live row', () => {
    // The podmate who joined by code a minute ago, whose first beacon has
    // not landed. Mutation: fold every quiet same-name row and this person
    // disappears at exactly the moment they were trying to arrive.
    const people = foldRosterGhosts(
      [
        member('long-standing', 'Tumbleweed', 100),
        member('just-joined', 'Tumbleweed', 400),
      ],
      liveOnly('long-standing'),
    );
    expect(people).toHaveLength(2);
  });

  test('a picked card that never announced is left alone', () => {
    // No announcement means no ordering, so condition 3 cannot be tested
    // and the user's own pick stands. Mutation: treat null as "oldest" and
    // curated rows start disappearing when a same-named stranger goes live.
    const people = foldRosterGhosts(
      [
        member('picked-only', 'Tumbleweed', null, CARD),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      liveOnly('new-tumbleweed'),
    );
    expect(people).toHaveLength(2);
  });

  test('a live row that never announced absorbs nobody', () => {
    // Mutation: fold against a null survivor stamp. Ordering is undefined
    // and the fold would fire on nothing but the name.
    const people = foldRosterGhosts(
      [
        member('old-tumbleweed', 'Tumbleweed', 100),
        member('live-no-announce', 'Tumbleweed', null),
      ],
      liveOnly('live-no-announce'),
    );
    expect(people).toHaveLength(2);
  });

  test('different names are never touched', () => {
    const people = foldRosterGhosts(
      [member('a', 'Dusty', 100), member('b', 'Marisol', 400)],
      liveOnly('b'),
    );
    expect(people).toHaveLength(2);
  });
});

describe('the shape of the list survives', () => {
  test('order is preserved — picked people stay where the user put them', () => {
    // Mutation: rebuild the list from the group map and the pod card
    // reshuffles under a camper who has learned to read it.
    const rows = [
      member('dusty', 'Dusty', 50),
      member('old-tumbleweed', 'Tumbleweed', 100),
      member('marisol', 'Marisol', 200),
      member('new-tumbleweed', 'Tumbleweed', 400),
    ];
    const people = foldRosterGhosts(rows, liveOnly('new-tumbleweed'));
    expect(people.map(p => p.cardId)).toEqual([
      'dusty',
      'marisol',
      'new-tumbleweed',
    ]);
  });

  test('case and spacing do not make two people', () => {
    const people = foldRosterGhosts(
      [
        member('old-tumbleweed', '  tumbleweed ', 100),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      liveOnly('new-tumbleweed'),
    );
    expect(people).toHaveLength(1);
  });

  test('three phones on one name fold into the live one', () => {
    const people = foldRosterGhosts(
      [
        member('t1', 'Tumbleweed', 100),
        member('t2', 'Tumbleweed', 200),
        member('t3', 'Tumbleweed', 400),
      ],
      liveOnly('t3'),
    );
    expect(people).toHaveLength(1);
    expect(people[0].quietNote).toContain('2 other phones');
  });
});

describe('the shipped read path uses the real sighting store', () => {
  const now = 1_000_000_000;

  afterEach(() => {
    // Sightings are a module-level map; drop everything past its TTL so one
    // test's beacon cannot make the next one's ghost look alive.
    pruneSightings(now + 60 * 60_000);
  });

  test('a beacon inside the live window is what makes a row the survivor', () => {
    reportSighting(hash32('new-tumbleweed'), {
      lat: 40.78,
      lon: -119.2,
      atMs: now - 1_000,
    });
    const { people } = foldPodRoster(
      [
        member('old-tumbleweed', 'Tumbleweed', 100),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      now,
    );
    expect(people).toHaveLength(1);
    expect(people[0].cardId).toBe('new-tumbleweed');
  });

  test('a sighting that has aged out of the live window folds nothing', () => {
    // Mutation: read presenceFor without checking `live` and a half-hour-old
    // position starts deciding who exists.
    reportSighting(hash32('new-tumbleweed'), {
      lat: 40.78,
      lon: -119.2,
      atMs: now - LIVE_WINDOW_MS - 1_000,
    });
    const { people } = foldPodRoster(
      [
        member('old-tumbleweed', 'Tumbleweed', 100),
        member('new-tumbleweed', 'Tumbleweed', 400),
      ],
      now,
    );
    expect(people).toHaveLength(2);
  });
});

describe('my own ghost — the fold the group logic can never make', () => {
  // The roster excludes the current self before anyone looks at it, so a
  // pre-reinstall identity bearing MY name reads as another person: seen in
  // the field as a "Pug" row on Pug's own screen and "2 so far" for one
  // camper. The self-anchor needs no radio — the owner is holding the phone.

  test('a quiet card-less row bearing my name is claimed as my past', () => {
    const { rows, selfGhosts } = partitionSelfGhosts(
      [member('old-me', 'Pug', 100), member('friend', 'Hippo', 400)],
      'Pug',
      noneLive,
    );
    expect(rows.map(r => r.cardId)).toEqual(['friend']);
    expect(selfGhosts.map(r => r.cardId)).toEqual(['old-me']);
  });

  test('a LIVE row with my name is a real person, never claimed', () => {
    // Two campers can share a playa name, and one of them beaconing right
    // now is the proof this one is not my past.
    const { rows, selfGhosts } = partitionSelfGhosts(
      [member('other-pug', 'Pug', 100)],
      'Pug',
      liveOnly('other-pug'),
    );
    expect(rows).toHaveLength(1);
    expect(selfGhosts).toHaveLength(0);
  });

  test('a CARDED row with my name is never claimed — the card guard again', () => {
    // A swap is human verification: someone held that phone and traded
    // cards. Claiming it as my past would bury their address.
    const { rows, selfGhosts } = partitionSelfGhosts(
      [member('other-pug', 'Pug', 100, CARD)],
      'Pug',
      noneLive,
    );
    expect(rows).toHaveLength(1);
    expect(selfGhosts).toHaveLength(0);
  });

  test('no name set claims nothing', () => {
    const { rows, selfGhosts } = partitionSelfGhosts(
      [member('old-me', 'Pug', 100)],
      null,
      noneLive,
    );
    expect(rows).toHaveLength(1);
    expect(selfGhosts).toHaveLength(0);
  });

  test('the partition runs before the fold, so my past cannot be folded into a same-named stranger', () => {
    // Without the ordering, a live camper who shares my name would absorb
    // my old identity as their quiet row — a note on the WRONG person: it
    // would tell them "another phone goes by Pug, this is the live one"
    // about a past that is mine, not theirs.
    const now = 1_000_000_000;
    reportSighting(hash32('live-pug'), {
      lat: 40.78,
      lon: -119.2,
      atMs: now - 1_000,
    });
    const { people, selfGhosts } = foldPodRoster(
      [member('old-me', 'Pug', 100), member('live-pug', 'Pug', 400)],
      now,
      'Pug',
    );
    // The self anchor claims my quiet past; the live same-named camper
    // keeps a clean row with no quiet note pinned to them.
    expect(selfGhosts.map(r => r.cardId)).toEqual(['old-me']);
    expect(people.map(p => p.cardId)).toEqual(['live-pug']);
    expect(people[0].quietNote).toBeNull();
    pruneSightings(now + 60 * 60_000);
  });

  test('with nobody live, EVERY quiet card-less row with my name is my past', () => {
    // Multiple reinstalls leave multiple ghosts, and they are all claimed
    // at once — the footer then reads "2 older phones". A real same-named
    // camper caught by this reads the recourse in the same sentence, and
    // their row returns on their next beacon.
    const { people, selfGhosts } = foldPodRoster(
      [member('old-me', 'Pug', 100), member('older-me', 'Pug', 50)],
      1_000_000_000,
      'Pug',
    );
    expect(selfGhosts).toHaveLength(2);
    expect(people).toHaveLength(0);
  });

  test('the footer copy names the reading and the recourse', () => {
    expect(selfGhostNote('Pug', 1)).toContain('older phone here also went by Pug');
    expect(selfGhostNote('Pug', 1)).toContain('reinstall');
    expect(selfGhostNote('Pug', 1)).toContain('says hello');
    expect(selfGhostNote('Pug', 2)).toContain('2 older phones');
  });
});
