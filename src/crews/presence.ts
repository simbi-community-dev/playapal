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
  /** Receiver-clock time the beacon was HEARD (the wire carries no time). */
  atMs: number;
}

export interface Presence extends Sighting {
  /** Heard within LIVE_WINDOW_MS of now. */
  live: boolean;
}

const sightings = new Map<number, Sighting>();

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
  if (prev && prev.atMs > s.atMs) {
    return;
  }
  sightings.set(memberHash, { lat: s.lat, lon: s.lon, atMs: s.atMs });
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
  return { ...s, live: nowMs - s.atMs <= LIVE_WINDOW_MS };
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
    }
  }
  if (dropped) {
    notifyPresenceChanged();
  }
}
