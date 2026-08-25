/**
 * meshSync — the conductor that turns sightings into mailbox syncs (Camp
 * Mesh, docs/CREW-DESIGN.md §6b). Composition only:
 *
 *   radio sighting (peerId) ──> throttle ──> CrewSyncLink over the native
 *   syncWithPeer ──> syncLink.syncWithPeer (digest → wants → messages →
 *   accept) ──> messagesRevision bump ──> inbox re-renders.
 *
 * And the SERVING side: the native GATT server asks JS two things —
 * "what do you carry?" (answered by keeping setSyncDigest fresh on every
 * store change) and "peer X wants these ids" (CrewSyncWant → serveMessages
 * → provideSyncMessages).
 *
 * TWO CONNECTIONS PER SYNC, on purpose: the native syncWithPeer runs one
 * connected op and cannot pause mid-connection while JS computes the want
 * list, so the link does a digest-only pass, JS diffs against its own
 * store, then a second pass writes the want and reads the messages. The
 * second pass re-reads the digest and throws it away — a few hundred bytes
 * against not holding a radio connection open across a JS round-trip.
 *
 * WHAT MOVES: every typed record the store carries, not just pod mail.
 * The digest/want/serve path here is kind-blind (syncLink.ts owns that
 * contract), so a board post or camp note riding these rails propagates
 * across camp on exactly the same sightings, with no wiring in this file.
 *
 * BASE STATION (design §6b): there is NO special base mode in code — the
 * serving side runs whenever the GATT server is up, so any phone with
 * sharing on relays everything it carries. A plugged-in phone at camp with
 * the toggle left on IS the base station.
 *
 * The want wire format is OURS (native moves opaque bytes): UTF-8 JSON
 * array of message ids. The digest/messages formats belong to syncLink.ts.
 */
import { NativeModules } from 'react-native';
import {
  messagesRevision,
  subscribeMessagesChanged,
  epochMinutes,
} from './messages';
import {
  serveDigest,
  serveMessages,
  syncWithPeer as linkSync,
  type CrewSyncLink,
} from './syncLink';
import { b64ToBytes, bytesToB64, onSighting, onSyncWant } from './radio';

const native = NativeModules.CrewBeacon;

/** A peer is re-synced at most this often — sightings repeat every scan
 * window, mailboxes change on human timescales. */
const PEER_SYNC_COOLDOWN_MS = 60_000;

/**
 * The freshness rule: an address is stale when it has missed too many of
 * ITS OWN heartbeats — not when it crosses one number chosen for one
 * platform.
 *
 * A peerId here is a BLE address, and a BLE address is a temporary name.
 * Android mints a fresh random address every time the advertisement is
 * (re)started, which on a sharing phone is every refresh tick — measured
 * on two handsets: an address is visible for a median of 11 seconds and
 * then is gone forever, replaced by an unrelated one.
 *
 * THE SPIRAL THE GATE ENDS, measured rather than reasoned: a queued
 * address that has rotated does not fail fast, it fails at the GATT
 * connect TIMEOUT. Dials were landing exactly 30 seconds apart — so every
 * attempt spent 30 seconds learning that a 10-second name was dead, and
 * left the next queue entry 30 seconds staler than the one that just
 * died. Once behind, never caught up: 5 of the last 5 dials targeted an
 * address that had not been on the air at any point in the log, while the
 * mailbox sat full and the radio was healthy.
 *
 * WHY THE THRESHOLD ADAPTS instead of being the flat ten seconds this
 * shipped with for one commit: sighting CADENCE is a platform property.
 * An Android advertisement carries the payload inline, so a live
 * neighbour is sighted every second or two — but an iOS peer's payload
 * rides a GATT characteristic and the read is rate-limited to 30 seconds
 * (CrewBeaconModule.GATT_COOLDOWN_MS), so a live iPhone is sighted twice
 * a minute AT BEST. A flat 10-second gate reads every live iPhone as a
 * corpse and starves it of mail forever — caught in cross-family review,
 * not on devices, because the test pair is two Androids. So an 'adv'
 * address is judged against its own observed rhythm — missing three of
 * your own heartbeats means gone — and a GATT-sighted address is not
 * judged at all (see addressFresh for why no number can be right there).
 */
const FRESH_GAP_MULTIPLE = 3;
/** Floor: an Android address seen twice 1s apart is not stale 4s later —
 * scan bursts under-estimate the true gap. */
const FRESH_FLOOR_MS = 12_000;
/** An 'adv' address seen only ONCE has no rhythm to judge against, and a
 * short allowance is safe BECAUSE of how 'adv' sightings arrive: inline
 * scan data, a path our own busy radio can never starve — a live Android
 * neighbour re-sights within a second or two no matter what the sync
 * worker is doing. A 20-second-old one-shot 'adv' name is a rotation
 * drive-by, and dialling it burns a connect timeout. */
const FRESH_SINGLE_ADV_MS = 15_000;
/** Ceiling, so a wildly-spaced pair of sightings cannot argue an address
 * into being dialable minutes after it left the air. */
const FRESH_CEILING_MS = 90_000;

/** Addresses stop existing, so their bookkeeping has to stop too: an entry
 * older than this can never pass the freshness gate again, and on a phone
 * left sharing for a week the rotation would otherwise grow these maps by
 * thousands of dead names per peer. */
const ADDRESS_FORGET_MS = 5 * 60_000;

let running = false;
let unsubs: Array<() => void> = [];
let lastSynced = new Map<string, number>();
/** addr -> when we last actually SAW it advertising. */
let lastSeen = new Map<string, number>();
/** addr -> the observed gap between its last two sightings — the
 * address's own heartbeat, which the freshness gate judges it against. */
let seenGap = new Map<string, number>();
/** addr -> how its last sighting arrived ('adv' | 'gatt' | ...): the
 * gate's jurisdiction test — only scan-path ('adv') names can be
 * freshness-dropped, because only their silence is trustworthy. */
let seenVia = new Map<string, string>();
let syncing = false;
const queue: string[] = [];

/** All three maps are keyed by an address, pruned by the same rule. */
function forgetOldAddresses(now: number): void {
  for (const [addr, at] of lastSeen) {
    if (now - at > ADDRESS_FORGET_MS) {
      lastSeen.delete(addr);
      lastSynced.delete(addr);
      seenGap.delete(addr);
      seenVia.delete(addr);
    }
  }
}

/**
 * Is this address still plausibly on the air, judged by its own rhythm?
 *
 * ONLY 'adv'-SIGHTED NAMES ARE EVER CONDEMNED. The gate's evidence is
 * "this address stopped being heard", and that is only meaningful when
 * the hearing could not have been our own fault. An inline-advertisement
 * sighting rides the scan path, which keeps delivering while the sync
 * worker holds connections — so silence from an 'adv' name really is the
 * name leaving the air (measured: rotation kills one every ~11s). A
 * GATT-read sighting is produced by the very radio the queue occupies:
 * one queued item is up to TWO native calls at 60s timeout each (review,
 * round 4 — the single-call bound the previous constant assumed was
 * false), so a live iPhone can go unsighted for minutes because WE were
 * busy, and no allowance constant can separate that from absence. Those
 * names are not freshness-dropped at all; their bound is the address
 * forget horizon, and a rare truly-departed one costs one bounded
 * timeout — the pre-gate world's price, paid only on the platform where
 * it is rare. This replaces a widening series of allowance constants
 * (45s, then 75s, then the next dispute) with the reason the number
 * could never be right.
 */
function addressFresh(addr: string, now: number): boolean {
  if (seenVia.get(addr) !== 'adv') {
    return true;
  }
  const seen = lastSeen.get(addr) ?? 0;
  const gap = seenGap.get(addr);
  const allowance =
    gap === undefined
      ? FRESH_SINGLE_ADV_MS
      : Math.min(
          Math.max(gap * FRESH_GAP_MULTIPLE, FRESH_FLOOR_MS),
          FRESH_CEILING_MS,
        );
  return now - seen <= allowance;
}

function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c > 0xffff) {
      i++;
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
    }
  }
  return Uint8Array.from(out);
}

function wantToB64(ids: string[]): string {
  return bytesToB64(utf8Bytes(JSON.stringify(ids)));
}

function bytesToUtf8(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      s += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63));
      i += 2;
    } else if (b < 0xf0) {
      s += String.fromCharCode(
        ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63),
      );
      i += 3;
    } else {
      const cp =
        ((b & 7) << 18) |
        ((bytes[i + 1] & 63) << 12) |
        ((bytes[i + 2] & 63) << 6) |
        (bytes[i + 3] & 63);
      s += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return s;
}

/** The CrewSyncLink over the native two-pass op, for one peer. */
function linkFor(peerId: string): CrewSyncLink {
  return {
    async fetchDigest(): Promise<Uint8Array> {
      const r = await native.syncWithPeer(peerId, '');
      // A completed digest exchange is BETTER evidence than any sighting:
      // this address answered a connection just now. Stamp it, so the
      // freshness check before pass 2 cannot condemn a peer for the crime
      // of serving us — an iOS peripheral may pause discovery entirely
      // while it holds our connection, which starves the sighting path at
      // exactly the moment the address is provably alive.
      lastSeen.set(peerId, Date.now());
      return b64ToBytes(r.digest ?? '');
    },
    async fetchMessages(wantIds: string[]): Promise<Uint8Array> {
      // The SECOND dial of the two-pass sync, and the same adaptive
      // freshness rule as the queue's: between the digest pass and this
      // one sits a JS round-trip, and an address that rotated inside that
      // gap fails at the connect TIMEOUT, not fast. Better to throw now —
      // the failure path forgives the want stamps and the next sighting of
      // this phone, under its new name, carries the same digest. Judged by
      // the address's OWN cadence, so an iOS peer — whose sightings are
      // 30-second GATT reads, and whose discovery may pause entirely while
      // it serves this very connection — is not aborted mid-sync by a
      // clock tuned to Android's chatter.
      if (!addressFresh(peerId, Date.now())) {
        throw new Error('peer address left the air between sync passes');
      }
      const r = await native.syncWithPeer(peerId, wantToB64(wantIds));
      return b64ToBytes(r.messages ?? '');
    },
  };
}

/** One-at-a-time sync worker: the native side rejects concurrent syncs
 * ('busy'), and one radio serves one connection well anyway. */
async function drainQueue(crewCodes: () => string[]): Promise<void> {
  if (syncing) {
    return;
  }
  syncing = true;
  try {
    while (queue.length > 0 && running) {
      const peerId = queue.shift()!;
      // Checked HERE, not at queue time: the wait for the radio is exactly
      // where an address dies. A name that was live when it was queued can
      // be gone by the time the connection ahead of it in this loop
      // finishes, and dialling it costs the whole connect timeout. A drop
      // is cheap to be wrong about — no cooldown was spent, so the very
      // next sighting of this phone re-queues it under its current name.
      const now = Date.now();
      if (!addressFresh(peerId, now)) {
        continue;
      }
      // The cooldown starts when a sync actually STARTS. Re-checked here
      // (not only at queue time) because a sighting can re-queue an
      // address while its own sync is still in flight ahead of it.
      const last = lastSynced.get(peerId) ?? 0;
      if (now - last < PEER_SYNC_COOLDOWN_MS) {
        continue;
      }
      lastSynced.set(peerId, now);
      try {
        await linkSync(linkFor(peerId), crewCodes(), epochMinutes(Date.now()));
      } catch {
        // A failed sync self-heals on the peer's next sighting; the
        // cooldown stamped at dial so we don't hammer a broken peer.
      }
    }
  } finally {
    syncing = false;
  }
}

/** Keep the served digest fresh: on every store change and on start. */
async function pushDigest(crewCodes: () => string[]): Promise<void> {
  try {
    const bytes = serveDigest(crewCodes(), epochMinutes(Date.now()));
    await native.setSyncDigest(bytesToB64(bytes));
  } catch {
    // Radio off / module absent: the next change retries.
  }
}

export function meshSyncRunning(): boolean {
  return running;
}

/**
 * Wire the mesh: called by share.ts when a sharing session starts (the
 * radio is up exactly then — scanning gives sightings, the GATT server
 * gives peers a mailbox to read).
 */
export function startMeshSync(crewCodes: () => string[]): void {
  if (running || !native) {
    return;
  }
  running = true;
  lastSynced = new Map();
  lastSeen = new Map();
  seenGap = new Map();
  seenVia = new Map();
  void pushDigest(crewCodes);
  unsubs = [
    // Every store change re-offers the new truth to anyone who asks.
    subscribeMessagesChanged(() => {
      void pushDigest(crewCodes);
    }),
    // A sighting is the moment a peer is REACHABLE: queue a sync.
    onSighting(({ peerId, via }) => {
      if (!running || !peerId) {
        return;
      }
      seenVia.set(peerId, via);
      const now = Date.now();
      // Stamped on EVERY sighting, including the ones the cooldown below
      // turns away: this is "when was this name last on the air", which is
      // a different question from "when did we last sync it", and the
      // freshness gate needs the honest answer to the first one. The gap
      // between consecutive stampings is the address's own heartbeat.
      const prev = lastSeen.get(peerId);
      if (prev !== undefined && now > prev) {
        seenGap.set(peerId, now - prev);
      }
      lastSeen.set(peerId, now);
      forgetOldAddresses(now);
      // The cooldown reads the DIAL stamp (set in drainQueue when a sync
      // actually starts), not a queue-time stamp. Stamping at queue time
      // charged the cooldown for syncs that never happened: an address
      // dropped as stale had still spent its 60 seconds, so a slow-cadence
      // peer could be refused here on the very sighting that proved it was
      // back on the air.
      const last = lastSynced.get(peerId) ?? 0;
      if (now - last < PEER_SYNC_COOLDOWN_MS) {
        return;
      }
      if (!queue.includes(peerId)) {
        queue.push(peerId);
      }
      void drainQueue(crewCodes);
    }),
    // The serving side: a peer wrote its want list; hand back the bytes.
    onSyncWant(({ peerId, payload }) => {
      try {
        const ids = JSON.parse(bytesToUtf8(b64ToBytes(payload)));
        if (!Array.isArray(ids)) {
          return;
        }
        const bytes = serveMessages(
          ids.filter(x => typeof x === 'string'),
          epochMinutes(Date.now()),
        );
        void native.provideSyncMessages(peerId, bytesToB64(bytes));
      } catch {
        // A malformed want is a stranger's write; serve nothing.
      }
    }),
  ];
  // messagesRevision is read here once so a dead-code eliminator can never
  // decide the subscription above is unobserved.
  void messagesRevision();
}

export function stopMeshSync(): void {
  running = false;
  for (const u of unsubs) {
    u();
  }
  unsubs = [];
  queue.length = 0;
}
