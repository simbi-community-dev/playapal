/**
 * Pod member announcements — how IDENTITY travels the mesh (Camp Mesh,
 * docs/CREW-DESIGN.md §6f). The bug this exists to close, measured on two
 * real phones: a pod is joined by a CODE, but everything that makes a pod
 * feel like a group chat — its name, its roster, the name over a message —
 * was carried by FRIEND CARDS, which the code never brings with it. So the
 * joiner saw the raw code where the pod's name belongs, "0 people" under a
 * podmate who was beaconing at that moment, and "someone in the pod" over
 * a message that had a perfectly good author.
 *
 * THE RECORD. An announcement is one typed record on the SAME substrate as
 * pod mail (src/crews/messages.ts, kind 'pod-member'): "this card id is in
 * this pod, it goes by this name, and — if I am the one who named the pod
 * — the pod is called this." It gossips, hops, expires and dedupes exactly
 * like a message, because it IS one; there is no second transport, no new
 * radio and no new switch. An announcement moves precisely when the radio
 * does, so nothing here starts, stops or asks for anything.
 *
 * THE POD IS A REPLICATED LOG (owner, Aug 24: "for all phones in a pod that
 * can see each other by bluetooth, they can all propagate all info from the
 * group among them, like simbi's clockchain"). The pod's name, its roster,
 * its joins and its leaves are RECORDS that gossip until every phone
 * converges — not fields one phone owns. This announcement is the log's
 * first record kind, and the vocabulary is deliberately left open:
 *
 *  - ANOTHER FIELD in a v1 body (say `findable`): older new-builds ignore
 *    unknown keys, so it costs nothing and strands nobody.
 *  - A v2 BODY: decode below accepts any version >= 1 and reads the fields
 *    it knows, so a v2 announcement is a roster row on a v1 phone, never a
 *    hole. Bump MEMBER_BODY_VERSION only when a field's MEANING changes.
 *  - A SIBLING KIND ('pod-rename', 'pod-leave'): a policy row in
 *    KIND_POLICY and a codec here. Design one knowing the accept gate: a
 *    build with no policy for a kind drops AND does not relay it, so a new
 *    kind spreads only across phones taught what it costs. A leave record
 *    is therefore an ACCELERATOR of the 7-day expiry, never the mechanism —
 *    the mechanism has to keep working on phones that never learn it.
 *
 * Nothing here may dress a LOCAL value as group truth (the "Dust Bunnies,
 * 0 people" incident: a pod's member count rendered from this phone's pick
 * list while three podmates were beaconing at it). The roster, the count
 * and the pod's name all resolve from the log; where the log is still
 * converging the UI says so instead of asserting a total.
 *
 * THE BODY IS OURS. The substrate sizes envelopes and never looks inside
 * one, so this file owns the codec: JSON {v, cardId, name, podName?} with
 * the version marker INSIDE the body.
 *
 * CARD FIRST, ANNOUNCEMENT SECOND — one resolution order, everywhere a
 * podmate is named (this file's roster and the answering machine's sender
 * line both read it from here). A held FriendCard whose id matches the
 * announcement wins, because "the card swap is an announcement the air
 * hasn't delivered yet" (cross-family review, Aug 24): the card is instant,
 * offline and already what the rest of the app calls that person, while
 * the announcement is the durable record that reaches everyone else. One
 * person under two names on one screen is the failure this avoids.
 *
 * IMMUTABLE, LIKE EVERYTHING ELSE ON THIS SUBSTRATE. Nothing is edited in
 * place and nothing can be deleted off other people's phones — a rename is
 * a NEW announcement, and the old one keeps circulating until it expires.
 * So every read resolves newest-per-author (dedupe by from_hash, keep the
 * newest created_min) and no code path anywhere tries to retract a record.
 * Deleting a superseded copy locally would be worse than useless: we would
 * simply re-fetch it from the next peer that offers it.
 *
 * LIFECYCLE OF AN ANNOUNCEMENT — every stage, stated (see §6f):
 *
 *  - MINTED on join, on create, on a rename of me or of the pod, and
 *    refreshed once it passes half its TTL, so a live pod's roster never
 *    expires out from under it.
 *  - NAMELESS AUTHOR: a phone whose card has no name announces NOTHING.
 *    An empty nameplate is worse than absence, and the pod card offers the
 *    one-tap repair instead. The moment a name is saved, the refresh rule
 *    below sees the mismatch and announces.
 *  - MEMBER LEAVES: there is no retraction on a store-and-forward mesh.
 *    Their nameplate fades from every roster when it expires (7 days), and
 *    ages visibly in the meantime — the row says when they last said hello.
 *  - POD DISBANDED: its code leaves listCrews, so its records stop being
 *    offered, accepted and read the same minute; the rows sit inert until
 *    pruneExpired takes them. Rejoining the same code inside a week finds
 *    my own announcement still valid, which is correct — I am in that pod
 *    again — and the refresh rule re-states it if anything changed.
 *  - TWO MEMBERS ANNOUNCE DIFFERENT POD NAMES: newest wins, and only
 *    people who TYPED the pod's name put it in their announcement (a phone
 *    that adopted a name never re-broadcasts it — Crew.nameSource is
 *    'mesh', not 'mine'), so adoption cannot amplify into a loop between
 *    two joiners.
 *  - TWO PODS AT ONCE: announcements are per crew_code, and reconcilePods
 *    walks every pod on the phone — being in two pods announces to two.
 *  - EXPIRES WHILE THE AUTHOR IS STILL IN RANGE: only possible if their app
 *    never ran for three and a half days; their next reconcile re-announces
 *    and the roster heals on the next sighting.
 *
 * PRIVACY, SAID PLAINLY. This is a posture change and it is written down
 * in §6e: before announcements, a captured join code yielded the positions
 * of people whose cards you already held; now it also yields the pod's
 * roster of playa names. The code is ~13 bits either way — it resists
 * shoulder-surfing, not capture — so the pod's own copy tells the user
 * what joining broadcasts, and the fix rides with the sync-privacy row.
 */

import { hash32, normalizeCrewCode } from './beacon';
import {
  canAdoptPodName,
  dedupeCrewsByCode,
  podNameSource,
  saveCrew,
  type Crew,
} from './crew';
import {
  POD_MEMBER_TTL_MIN,
  composeRecord,
  recordsOfKind,
  type CrewRecord,
} from './messages';

/** The wire token. Permanent vocabulary once shipped — a rename would
 * strand every phone already carrying the old one, for nothing gained
 * (the same rule that keeps pod mail on 'text'/'voice'). */
export const POD_MEMBER_KIND = 'pod-member' as const;

/** The body format this build MINTS. Decode accepts anything >= 1: a v2
 * body from a newer phone still has a card id and a name in it. */
export const MEMBER_BODY_VERSION = 1;

/** Codepoints carried for a name — the announcement is a nameplate, not a
 * card. 40 is the pod-name cap in crew.ts and comfortably longer than any
 * playa name that fits on a chip; clamping HERE is what guarantees the
 * body fits POD_MEMBER_MAX_BYTES even in 4-byte codepoints, so a user
 * never meets the substrate's over-cap refusal. */
export const MEMBER_NAME_MAX = 40;

/** Re-announce once my live announcement is older than this — half the
 * TTL, so a pod that keeps meeting never sees a roster gap, and a phone
 * that is off for a day misses nothing. */
export const MEMBER_REFRESH_MIN = POD_MEMBER_TTL_MIN / 2;

/** When a nameplate starts reading as a MEMORY rather than a presence.
 * Half a playa day: a member seen this morning is part of today's pod, a
 * member last heard on Tuesday is someone the log still remembers. The row
 * fades at this line — it never silently disappears (only the 7-day expiry
 * removes it) and it never keeps reading as current. */
export const MEMBER_STALE_MIN = 12 * 60;

/** What one announcement says. */
export interface MemberBody {
  /** The author's FriendCard.id — the identity the beacon, the mail and
   * the friend card all key on (hash32 of it is from_hash). */
  cardId: string;
  /** Their playa name, as their own card spells it. */
  name: string;
  /** The pod's name, present only when the author NAMED this pod. */
  podName?: string;
  /**
   * Which radios this phone HAS (docs/WALKIE-LADDER.md §4) — bit 1 live
   * lo-fi, bit 2 Wi-Fi Aware, bit 4 shared-LAN. CAPABILITY, never
   * availability: hardware does not change while the app runs, so this is
   * exactly the durable, refreshable fact an announcement is for. Whether a
   * peer can be REACHED on a rung is proven by a round trip and never by
   * this field — a stale "I have Wi-Fi Aware" that is currently off would
   * strand a peer in silence, which is the one thing the ladder forbids.
   *
   * It rides here rather than in the 21-byte beacon because every beacon
   * byte is already spoken for; adding one there would mean BEACON_VERSION 2
   * and a v1 phone rejects a v2 beacon outright — a fleet split at the one
   * layer that must never split. Here it is FREE: decodeMemberBody ignores
   * keys it does not know, so an old phone reads a new body fine.
   */
  radios?: number;
}

/** One resolved member: the newest valid announcement from one author. */
export interface AnnouncedMember extends MemberBody {
  /** hash32(cardId) — matches CrewMessage.from_hash and the beacon's
   * memberHash, which is why presence resolves for an announced-only
   * member the moment their beacon is heard. */
  fromHash: number;
  /** Author's clock, epoch minutes — "said hello 20m ago". */
  createdMin: number;
}

// ------------------------------------------------------------------ codec

/** Trim, collapse runs of whitespace, clamp to MEMBER_NAME_MAX codepoints.
 * [...s] walks CODEPOINTS, so slicing can never split an emoji in half. */
const clampName = (s: string): string =>
  [...s.trim().replace(/\s+/g, ' ')].slice(0, MEMBER_NAME_MAX).join('');

/** The announcement body this phone mints. */
export function encodeMemberBody(b: MemberBody): string {
  const name = clampName(b.name);
  const podName = b.podName === undefined ? undefined : clampName(b.podName);
  const out: Record<string, unknown> = {
    v: MEMBER_BODY_VERSION,
    cardId: b.cardId,
    name,
  };
  if (podName) {
    out.podName = podName;
  }
  // Omitted when zero, never sent as 0: "no rungs above the floor" is what
  // ABSENCE already means, and it is what every phone shipped before this
  // field says by saying nothing. Spending bytes to repeat the default would
  // only shrink the headroom under POD_MEMBER_MAX_BYTES.
  if (Number.isInteger(b.radios) && (b.radios as number) > 0) {
    out.radios = b.radios;
  }
  return JSON.stringify(out);
}

/**
 * A peer's body is a peer's word for it — every field checked, null on
 * anything malformed (the decodeBeacon posture: a bad frame is cheap to
 * drop, never a crash). A version we don't know is NOT a rejection: the
 * fields we understand still make a roster row.
 */
export function decodeMemberBody(body: string): MemberBody | null {
  const raw = (() => {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  })();
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.v) || (r.v as number) < 1) {
    return null;
  }
  if (typeof r.cardId !== 'string' || typeof r.name !== 'string') {
    return null;
  }
  const cardId = r.cardId.trim();
  const name = clampName(r.name);
  if (cardId.length === 0 || cardId.length > 64 || name.length === 0) {
    // A nameless or id-less nameplate says nothing — it would render as a
    // blank row, which is worse than the member simply not being there yet.
    return null;
  }
  const podName =
    typeof r.podName === 'string' && clampName(r.podName).length > 0
      ? clampName(r.podName)
      : undefined;
  const out: MemberBody = { cardId, name };
  if (podName) {
    out.podName = podName;
  }
  if (Number.isInteger(r.radios) && (r.radios as number) > 0) {
    out.radios = r.radios as number;
  }
  return out;
}

// ------------------------------------------------------------------ reads

/**
 * Everyone who has announced themselves into this pod, newest announcement
 * per author, newest author first.
 *
 * The cardId is checked against from_hash: a record whose body claims
 * someone else's card id is dropped. Anyone can mint a record with any
 * from_hash (this is a note board, not a PKI), but the check keeps ONE
 * author from occupying another's roster slot or overwriting their name,
 * which is the difference between an honest store and a corruptible one.
 */
export function announcedMembers(crewCode: string): AnnouncedMember[] {
  const code = normalizeCrewCode(crewCode);
  if (code.length === 0) {
    return [];
  }
  const out: AnnouncedMember[] = [];
  const seen = new Set<number>();
  // recordsOfKind returns created_min DESC, id DESC — so the FIRST row for
  // an author is that author's newest, and every later one is superseded.
  for (const rec of recordsOfKind(POD_MEMBER_KIND, [code])) {
    if (seen.has(rec.from_hash)) {
      continue;
    }
    const body = decodeMemberBody(rec.body);
    if (!body || hash32(body.cardId) !== rec.from_hash) {
      continue;
    }
    seen.add(rec.from_hash);
    out.push({ ...body, fromHash: rec.from_hash, createdMin: rec.created_min });
  }
  return out;
}

/**
 * from_hash -> announced name, for anyone resolving a hash they have no
 * friend card for (the answering machine's sender line). Cards win where
 * both exist — the card is the name this phone shows for that person
 * everywhere else, and one person with two names in one screen is worse
 * than a slightly stale one.
 */
export function announcedNames(crewCode: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const a of announcedMembers(crewCode)) {
    m.set(a.fromHash, a.name);
  }
  return m;
}

/** My own newest announcement in this pod, or null. */
export function myAnnouncement(
  crewCode: string,
  myCardId: string,
): AnnouncedMember | null {
  const mine = hash32(myCardId);
  return announcedMembers(crewCode).find(a => a.fromHash === mine) ?? null;
}

/**
 * The pod name to adopt: the newest one announced by SOMEONE ELSE. Newest
 * wins, flatly — two people who each named the same code differently is a
 * disagreement no algorithm can settle, and "the most recent thing a human
 * typed" is the rule people already expect from every shared document.
 */
export function announcedPodName(
  crewCode: string,
  myCardId: string,
): string | null {
  const mine = hash32(myCardId);
  for (const a of announcedMembers(crewCode)) {
    if (a.fromHash !== mine && a.podName) {
      return a.podName;
    }
  }
  return null;
}

// ------------------------------------------------------------------ roster

/** A row on the pod card. `card` null = announced only: they told the pod
 * who they are, but this phone holds no card for them, so there is no
 * address to walk to — presence still resolves, because a beacon carries
 * the same hash the announcement does. */
export interface PodMember {
  cardId: string;
  name: string;
  card: FriendCardLike | null;
  /** Epoch minutes of their announcement; null for a picked card that has
   * not announced (an older build, or simply not in range yet). */
  announcedMin: number | null;
}

/** The shape the roster needs from a friend card. Structural on purpose:
 * this file must not care about the rest of src/friends. */
export interface FriendCardLike {
  id: string;
  name: string;
  camp: string;
  address: string;
  updated_at: string;
}

/**
 * THE ROSTER: announced ∪ picked, deduped by card id, me excluded.
 *
 * PICKED FIRST, in the order the user picked them — the people they chose
 * are the people they look for — then announced-only members, newest
 * announcement first, so whoever just walked into camp appears at the top
 * of the part of the list the user did not curate.
 *
 * A picked card that never announces still renders (nothing regressed for
 * a pod built out of cards), and an announced member whose card this phone
 * happens to hold renders as a full card row, picked or not: they said
 * they are in this pod, which is better evidence than a checkbox.
 */
export function podRoster(
  crew: Crew,
  cards: FriendCardLike[],
  myCardId: string,
): PodMember[] {
  const byId = new Map(cards.map(c => [c.id, c]));
  const announced = new Map(
    announcedMembers(crew.code).map(a => [a.cardId, a]),
  );
  const out: PodMember[] = [];
  const used = new Set<string>([myCardId]);
  for (const id of crew.memberIds) {
    const card = byId.get(id);
    if (!card || used.has(id)) {
      // An id whose card was removed has no row — the card IS the data,
      // and an announcement (if any) adds it back through the loop below.
      continue;
    }
    used.add(id);
    const a = announced.get(id);
    out.push({
      cardId: id,
      // The card's spelling wins (see announcedNames).
      name: card.name,
      card,
      announcedMin: a ? a.createdMin : null,
    });
  }
  for (const a of announced.values()) {
    if (used.has(a.cardId)) {
      continue;
    }
    used.add(a.cardId);
    // Card first (see the header): an announced member whose card arrived
    // by QR or beam is named by that card, picked into the pod or not.
    const card = byId.get(a.cardId) ?? null;
    out.push({
      cardId: a.cardId,
      name: card ? card.name : a.name,
      card,
      announcedMin: a.createdMin,
    });
  }
  return out;
}

// ------------------------------------------------------------------ writes

/**
 * Announce myself into a pod, if anything needs saying. Returns the minted
 * record, or null when the pod already carries a current announcement of
 * mine — this is the ONE write path, and it is idempotent, so every caller
 * (join, create, rename, mount) can simply call it.
 *
 * A phone with no name on its card announces NOTHING (see the header).
 */
export function announceMembership(
  crew: Crew,
  myCardId: string,
  myName: string,
  nowMin: number,
  rand: () => number = Math.random,
  /** This phone's rung bitmap (docs/WALKIE-LADDER.md §4). Passed IN rather
   * than read here on purpose: the probe lives behind a native module, and
   * this file is pure — every crew suite builds a phone out of node:sqlite
   * with no React Native in sight, and an import of the seam would take them
   * all down. The caller already holds the number. */
  radios = 0,
): CrewRecord | null {
  const name = clampName(myName);
  if (name.length === 0 || myCardId.length === 0) {
    return null;
  }
  // Only a NAMER broadcasts the pod's name — the source must be 'mine',
  // not merely "not a placeholder". An ADOPTED name re-broadcast would let
  // one typo echo around a pod forever and would make "newest wins" a race
  // between relays instead of between people. (Measured: with the looser
  // test, a joiner adopted the name and immediately started announcing it
  // as their own.)
  const podName =
    podNameSource(crew) === 'mine' ? clampName(crew.name) : undefined;
  const mine = myAnnouncement(crew.code, myCardId);
  if (
    mine &&
    mine.name === name &&
    (mine.podName ?? '') === (podName ?? '') &&
    // Radios joins the freshness comparison, or the probe's answer never
    // ships: it lands a moment AFTER the first announcement, and a check
    // that ignored it would suppress the re-announce as a duplicate and the
    // pod would never learn this phone's rungs. It cannot spin — the value is
    // a device fact behind a one-shot cache, so it settles after one extra
    // record.
    (mine.radios ?? 0) === radios &&
    nowMin - mine.createdMin < MEMBER_REFRESH_MIN
  ) {
    return null;
  }
  const body = encodeMemberBody({ cardId: myCardId, name, podName, radios });
  return composeRecord(
    POD_MEMBER_KIND,
    crew.code,
    myCardId,
    body,
    '',
    null, // the whole pod, never one member
    nowMin,
    rand,
  );
}

/**
 * Adopt the pod's announced name, when this phone never named it. Returns
 * the saved crew, or null when there is nothing to adopt or the user's own
 * name is in place.
 */
export function adoptPodName(crew: Crew, myCardId: string): Crew | null {
  if (!canAdoptPodName(crew)) {
    return null;
  }
  const announced = announcedPodName(crew.code, myCardId);
  if (!announced || announced === crew.name) {
    return null;
  }
  return saveCrew({ ...crew, name: announced, nameSource: 'mesh' });
}

/**
 * THE SPIN GUARD. reconcilePods runs from a UI effect that re-fires on
 * every store change — including the one IT causes — so a write whose
 * read-back fails (a swapped DB in a test, a store error on a phone) would
 * otherwise compose a record per render forever. Remembering what was
 * announced in this run makes the guard hold even when the store cannot
 * answer, and keying it by content still lets a real rename through
 * immediately and a real refresh through after MEMBER_REFRESH_MIN.
 */
const lastAnnounced = new Map<string, { signature: string; atMin: number }>();

/** Drop the spin guard's memory (tests; a store swap). */
export function resetAnnounceGuard(): void {
  lastAnnounced.clear();
}

/**
 * Run every pod's announcement housekeeping: adopt any name this phone
 * never chose, then say who I am wherever that is missing, stale or out of
 * date. Idempotent and cheap — the common case reads and writes nothing.
 *
 * Failures are swallowed BY POD: a store error must not take down the pod
 * card, and the next reconcile retries.
 */
export function reconcilePods(
  crews: Crew[],
  myCardId: string,
  myName: string,
  nowMin: number,
  /** See announceMembership — supplied by the caller so this file stays
   * free of native imports. 0 means "floor only", which is both the safe
   * answer and what every phone before this field said by saying nothing. */
  radios = 0,
): void {
  // Same-code twins merge FIRST (the pre-idempotent join minted them, and
  // once the real name arrived over the mesh both twins adopted it — "two
  // Dust Bunnies", owner-caught on the P9). Announcing against a twin
  // re-splits the pod's identity every pass, so nothing else runs until
  // the store is clean; the merge's own notify re-fires this effect with
  // the merged rows, and a clean store costs one silent boolean.
  if (dedupeCrewsByCode()) {
    return;
  }
  for (const crew of crews) {
    try {
      const current = adoptPodName(crew, myCardId) ?? crew;
      const name = clampName(myName);
      if (name.length === 0) {
        continue;
      }
      const key = `${normalizeCrewCode(current.code)}|${myCardId}`;
      // The same namer-only rule announceMembership applies, so the guard
      // and the writer can never disagree about what "unchanged" means.
      const podName =
        podNameSource(current) === 'mine' ? clampName(current.name) : '';
      const signature = `${name}|${podName}`;
      const last = lastAnnounced.get(key);
      if (
        last &&
        last.signature === signature &&
        nowMin - last.atMin < MEMBER_REFRESH_MIN
      ) {
        continue;
      }
      announceMembership(current, myCardId, myName, nowMin, Math.random, radios);
      // Stamped whether or not a record was minted: "nothing to say" is
      // exactly as good a reason not to re-ask the store next render.
      lastAnnounced.set(key, { signature, atMin: nowMin });
    } catch {
      // A pod that cannot be reconciled renders from what it has.
    }
  }
}
