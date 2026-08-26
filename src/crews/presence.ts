/**
 * Crew presence — the sighting store (Crew Phase B, docs/CREW-DESIGN.md §4).
 * Every decoded beacon lands here as (memberHash, position, heard-at); the
 * crew screen reads it back per FriendCard to turn "last confirmed
 * [timestamp]" rows into "live" ones.
 *
 * MODULE-LEVEL MAP, NO DB — on purpose. Presence is ephemeral by design:
 * a position older than half an hour is playa-stale (people move), and
 * persisting it would quietly build a location-history file on disk that
 * the feature's whole privacy posture says should not exist. App restart
 * = empty map = honest "no live fixes yet"; the durable layer stays the
 * friend card ("where they said they'd be"), exactly Phase A's floor.
 *
 * KEYED BY memberHash, not card id: that is all a beacon carries (the wire
 * never says a name — src/crews/beacon.ts header). The resolver hashes a
 * held card's id on read, so a sighting from someone whose card you don't
 * hold just sits unmatched and unrendered — a stranger's beacon is noise,
 * never a row.
 *
 * Change-signal follows the favorites revision-emitter pattern
 * (src/events/favorites.ts): writers bump, mounted readers subscribe.
 */

import { hash32 } from './beacon';

/**
 * "Live" = heard within 3 minutes. Foreground Phase B refreshes on a
 * caller-owned cadence of ~30-60 s (src/crews/session.ts), so three
 * minutes = several missed beacons, not one unlucky packet — the row
 * downgrades to its timestamp only when someone is genuinely gone.
 */
export const LIVE_WINDOW_MS = 3 * 60_000;

/**
 * Sightings older than 30 minutes are dropped entirely: on foot at ~3 mph
 * that is over a mile of possible movement — showing it as a position at
 * all (even a stale-marked one) points people the wrong way in a whiteout.
 * The friend card's static address is the better answer by then.
 */
export const SIGHTING_TTL_MS = 30 * 60_000;

export interface Sighting {
  lat: number;
  lon: number;
  /** Sender-clock time the beacon was true (heard-at minus its own age). */
  atMs: number;
}

/**
 * What the store actually holds per member, since a beacon may now carry
 * reach WITHOUT a place (src/crews/beacon.ts, the mailbox frame): two
 * facts with two ages, because they are two different claims.
 *
 *  - `atMs` — when this phone was last heard from AT ALL. Drives "live",
 *    the roster fold, and the walkie's "is anyone here" check: every one
 *    of those questions is about reach, and a mailbox frame proves reach
 *    exactly as well as a position frame does.
 *  - `pos` — the last place they BROADCAST, carrying the time it was true.
 *    A mailbox frame never writes it, and never clears it either: hearing
 *    someone say nothing about where they are is not news about where they
 *    were. Its own stamp is what keeps a distance line from borrowing the
 *    freshness of an unrelated hello.
 */
interface Tracked {
  atMs: number;
  pos: { lat: number; lon: number; atMs: number } | null;
}

export interface Presence {
  /** When any beacon from them was last true (sender-stamped). */
  atMs: number;
  /** Heard within LIVE_WINDOW_MS of now. */
  live: boolean;
  /** Their last broadcast position, with its own age — null for a podmate
   * this phone has only ever heard position-free. */
  pos: { lat: number; lon: number; atMs: number } | null;
}

const sightings = new Map<number, Tracked>();

// ------------------------------------------------------------- revisions

let revision = 0;
const watchers = new Set<() => void>();

export function presenceRevision(): number {
  return revision;
}

export function subscribePresenceChanged(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

function notifyPresenceChanged(): void {
  revision += 1;
  for (const w of watchers) {
    w();
  }
}

// ------------------------------------------------------------------ store

/**
 * Record a decoded beacon. Newest heard-time wins; an out-of-order older
 * report (e.g. a previous-bucket beacon surfacing late) never rolls a
 * fresher position back, and is dropped without a notify so the UI doesn't
 * re-render for nothing.
 */
export function reportSighting(memberHash: number, s: Sighting): void {
  const prev = sightings.get(memberHash);
  const heardIsNews = !prev || s.atMs > prev.atMs;
  const posIsNews = !prev?.pos || s.atMs > prev.pos.atMs;
  if (!heardIsNews && !posIsNews) {
    return;
  }
  sightings.set(memberHash, {
    atMs: heardIsNews ? s.atMs : prev!.atMs,
    pos: posIsNews ? { lat: s.lat, lon: s.lon, atMs: s.atMs } : prev!.pos,
  });
  notifyPresenceChanged();
}

/**
 * Record a beacon that proved REACH and said nothing about place — the
 * mailbox frame (beacon.ts). It moves `atMs` and never touches `pos`:
 * a podmate who turned position sharing off goes on reading as near
 * (their notes get through now, which is the truth), while the map keeps
 * showing the last place they actually chose to broadcast, aging under its
 * own stamp until the TTL drops it.
 *
 * The deliberate ASYMMETRY with reportSighting: this function CANNOT be
 * handed coordinates, so wiring the mailbox path here can never leak a
 * position by a copy-paste that carried one field too many.
 */
export function reportHeard(memberHash: number, atMs: number): void {
  const prev = sightings.get(memberHash);
  if (prev && prev.atMs >= atMs) {
    return;
  }
  sightings.set(memberHash, { atMs, pos: prev?.pos ?? null });
  notifyPresenceChanged();
}

/**
 * The read side, in the UI's vocabulary: a FriendCard.id in, a position (or
 * null) out. Hashing happens HERE so no caller ever handles memberHashes —
 * the wire-format detail stays inside src/crews. `nowMs` is injectable for
 * tests; the default suits render-time reads (this is a store like
 * favorites, not a pure protocol function).
 */
export function presenceFor(
  cardId: string,
  nowMs: number = Date.now(),
): Presence | null {
  const s = sightings.get(hash32(cardId));
  if (!s) {
    return null;
  }
  return {
    atMs: s.atMs,
    live: nowMs - s.atMs <= LIVE_WINDOW_MS,
    pos: s.pos,
  };
}

/**
 * Drop sightings past SIGHTING_TTL_MS. The session's caller-owned cadence
 * runs this beside each refresh; nothing here schedules itself (same
 * lifecycle rule as session.ts — cadence is a battery concern the UI
 * layer owns). Notifies only when something actually fell out.
 */
export function pruneSightings(nowMs: number): void {
  let dropped = false;
  for (const [key, s] of sightings) {
    if (nowMs - s.atMs > SIGHTING_TTL_MS) {
      sightings.delete(key);
      dropped = true;
      continue;
    }
    // A member still being HEARD (mailbox frames keep arriving) whose last
    // broadcast position has aged past the TTL: the row stays, the place
    // goes. Same reason as the whole-entry rule above — over a mile of
    // possible movement — and this is the case that rule could not see
    // before, because reach and place used to share one timestamp.
    if (s.pos && nowMs - s.pos.atMs > SIGHTING_TTL_MS) {
      sightings.set(key, { atMs: s.atMs, pos: null });
      dropped = true;
    }
  }
  if (dropped) {
    notifyPresenceChanged();
  }
}
