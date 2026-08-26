/**
 * Crew message sync — the injected transport contract, the wire codec,
 * and the sync conductor for "the answering machine" (docs/CREW-DESIGN.md
 * §6b). Pure TypeScript: the GATT message-exchange characteristic is
 * built separately and implements CrewSyncLink, exactly how session.ts
 * treats the beacon radio — this file owns WHAT moves, the native half
 * owns HOW bytes cross the air.
 *
 * THE EXCHANGE (one "sighting" of a peer):
 *
 *   1. fetchDigest()            -> peer's carried {id, expires_min} list
 *   2. wantsFrom(digest)        -> the ids this phone lacks
 *   3. fetchMessages(wantIds)   -> full messages for those ids
 *   4. acceptIncoming(...)      -> validate + store, origin 'heard'
 *
 * Both directions of a real meeting are just this exchange run once each
 * way — the peer's own conductor pulls from OUR serve side (serveDigest /
 * serveMessages below, called through JS by the native GATT server). A
 * partial sync is FINE by design: everything is idempotent (dedupe by
 * id), so the next sighting simply continues where this one broke off.
 *
 * WIRE FORMAT — the contract for the native implementer:
 *
 *   frame = [4-byte big-endian byte count N] [N bytes of UTF-8 JSON]
 *
 * Digest JSON: an array of {id, expires_min}. Messages JSON: an array of
 * WireMessage (messages.ts — a stored row minus the local-only origin/
 * read_at fields, which must never leak to a peer). Length-prefixed JSON
 *
 * KIND-BLIND ON PURPOSE. The store carries typed records — pod text and
 * voice today, board posts and camp notes reserved — and NOTHING in this
 * file branches on `kind`. The digest offers ids, the want list asks for
 * ids, and a served frame is whatever rows those ids name. Every per-kind
 * decision (cap, TTL, horizon, unknown-kind refusal) lives in exactly one
 * place, messages.ts's KIND_POLICY + accept gate, so a new kind ships by
 * adding a policy row and never by touching the transport.
 *
 * on purpose: GATT moves values in MTU-sized chunks, and the native layer
 * reassembles them transparently — JS always sees whole frames, and the
 * prefix is how the native reader knows a value is complete (and how this
 * side rejects a truncated one instead of mis-parsing it). Hand-rolled
 * UTF-8 (friendLink.ts) because Hermes' TextEncoder coverage varies.
 *
 * POSTURE: frames are plaintext. Gating WHO may read the exchange
 * characteristic is the radio layer's job (it holds the crew-keyed
 * session context; see beacon.ts for the obfuscation vocabulary) — this
 * codec deliberately does not invent a second crypto layer. Matches the
 * app's stated trust model: note-board honesty, not encryption theater.
 */

import { utf8DecodeStrict, utf8Encode } from '../friends/friendLink';
import {
  acceptIncoming,
  clearWants,
  forgiveWants,
  heldIdsAmong,
  messagesByIds,
  pruneExpired,
  recordWants,
  syncDigest,
  utf8ByteLength,
  wantsFrom,
} from './messages';
import type { CrewMessage, DigestEntry, WireMessage } from './messages';

/**
 * THE seam the native half implements — bytes in, bytes out, because the
 * radio layer moves opaque chunks (the CrewRadio precedent, session.ts).
 * Both calls settle when the peer's complete frame is in hand, or reject
 * with a transport error (out of range, connection dropped) that
 * syncWithPeer wraps into something human-actionable.
 */
export interface CrewSyncLink {
  fetchDigest(): Promise<Uint8Array>;
  fetchMessages(wantIds: string[]): Promise<Uint8Array>;
}

/** Sanity ceiling on any single frame — a corrupted length prefix or a
 * hostile peer must fail fast, never balloon memory on a phone. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Ids fetched per sighting. 64 messages is a generous mail run; a peer
 * carrying more hands over the freshest 64 now and the rest next
 * sighting (partial sync is the design, not a failure). */
export const MAX_FETCH_IDS = 64;

/** Byte budget for one served messages frame — voice-heavy mail (or a run
 * of photo-carrying camp notes) could otherwise stack 64 big bodies into
 * one 16 MB transfer that a BLE-rate link would hold open for minutes.
 * Rows past the budget wait for the next sighting. Measured on the body,
 * whatever kind it is: the budget is about radio time, not content. */
export const SERVE_BYTE_BUDGET = 4 * 1024 * 1024;

// ----------------------------------------------------------------- codec

const frameOf = (json: string): Uint8Array => {
  const body = utf8Encode(json);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length); // big-endian
  out.set(body, 4);
  return out;
};

const unframe = (bytes: Uint8Array, what: string): string => {
  if (bytes.length < 4) {
    throw new Error(`${what} arrived empty — the link dropped mid-exchange.`);
  }
  const declared = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  if (declared > MAX_FRAME_BYTES) {
    throw new Error(`${what} claims an impossible size — corrupted frame.`);
  }
  if (declared !== bytes.length - 4) {
    throw new Error(
      `${what} was cut short mid-transfer — moved out of range? The next sighting picks up where this left off.`,
    );
  }
  const json = utf8DecodeStrict(Array.from(bytes.subarray(4)));
  if (json === null) {
    throw new Error(`${what} is garbled — not valid UTF-8.`);
  }
  return json;
};

const parseArray = (json: string, what: string): unknown[] => {
  const parsed = (() => {
    try {
      return JSON.parse(json) as unknown;
    } catch {
      throw new Error(`${what} is garbled — not valid JSON.`);
    }
  })();
  if (!Array.isArray(parsed)) {
    throw new Error(`${what} has the wrong shape — expected a list.`);
  }
  return parsed;
};

export function encodeDigest(entries: DigestEntry[]): Uint8Array {
  return frameOf(JSON.stringify(entries));
}

/** Decode a peer's digest frame. Entries are kept loosely — wantsFrom is
 * the real gate — but non-objects are dropped here so the typed contract
 * stays honest. Throws (human-actionable) on framing/JSON damage. */
export function decodeDigest(bytes: Uint8Array): DigestEntry[] {
  const raw = parseArray(unframe(bytes, 'The peer digest'), 'The peer digest');
  const out: DigestEntry[] = [];
  for (const e of raw) {
    const r = e as Record<string, unknown>;
    if (r && typeof r.id === 'string' && Number.isInteger(r.expires_min)) {
      out.push({ id: r.id, expires_min: r.expires_min as number });
    }
  }
  return out;
}

/** Stored rows -> the wire, any kind. origin/read_at are STRIPPED here — a
 * phone's read state and provenance are local business, never a peer's.
 * `kind` rides through untouched: it is the far side's accept gate that
 * decides whether it has a policy for it. */
export function encodeMessages(msgs: CrewMessage[]): Uint8Array {
  const wire: WireMessage[] = msgs.map(m => ({
    id: m.id,
    crew_code: m.crew_code,
    from_hash: m.from_hash,
    to_hash: m.to_hash,
    kind: m.kind,
    body: m.body,
    mime: m.mime,
    created_min: m.created_min,
    expires_min: m.expires_min,
    hops: m.hops,
  }));
  return frameOf(JSON.stringify(wire));
}

/** Decode a peer's messages frame. Returns UNVALIDATED rows on purpose:
 * acceptIncoming is the single accept gate, and a second half-validation
 * here would just be a place for the two to disagree. */
export function decodeMessages(bytes: Uint8Array): unknown[] {
  return parseArray(
    unframe(bytes, 'The message bundle'),
    'The message bundle',
  );
}

// ------------------------------------------------------------ serve side
// What the native GATT server calls through JS when a PEER's conductor
// runs its exchange against this phone. Synchronous — both are one DB
// read away — so the native bridge can respond within a GATT timeout.

/** Everything carried for these crews, framed. Prunes first so a corpse
 * is never offered (nowMin injected — the lane's no-clocks rule). */
export function serveDigest(crewCodes: string[], nowMin: number): Uint8Array {
  pruneExpired(nowMin);
  return encodeDigest(syncDigest(crewCodes));
}

/**
 * The requested messages, framed, under two guards mirroring the fetch
 * side: at most MAX_FETCH_IDS rows, and stop once SERVE_BYTE_BUDGET of
 * body bytes are in the frame. Unknown ids are silently absent — the
 * peer asked from a digest that may have expired out from under it.
 */
export function serveMessages(wantIds: string[], nowMin: number): Uint8Array {
  const ids = [
    ...new Set(wantIds.filter(id => typeof id === 'string' && id.length > 0)),
  ].slice(0, MAX_FETCH_IDS);
  // SERVE IN THE ORDER ASKED. messagesByIds has no ORDER BY, so SQLite hands
  // back `id IN (...)` rows in index order — lexicographic by id, which is
  // uncorrelated with anything. The byte budget below then TRUNCATES along
  // that arbitrary axis, so a want list carefully ordered roster-first (the
  // digest's servePriority) could still have its roster records cut while
  // some unrelated mail rode along. Ranking by request position costs one
  // Map and makes the two ends of the exchange agree about what matters.
  const rank = new Map(ids.map((id, i) => [id, i]));
  const ordered = messagesByIds(ids).sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
  const fit: CrewMessage[] = [];
  let total = 0;
  for (const m of ordered) {
    // RE-STAMP THE EXPIRY INTO THE AUTHOR'S FRAME BEFORE IT GOES ON THE WIRE.
    //
    // A heard row carries TWO stamps from TWO DIFFERENT CLOCKS: created_min is
    // the AUTHOR's, relayed verbatim, while expires_min is OURS, written at
    // arrival. Serving that pair raw is a silent poison one hop downstream —
    // if our clock lags the author by more than the TTL, `expires - created`
    // goes NEGATIVE and every receiver refuses the record as incoherent,
    // forever, while we hold it happily in our own inbox and show it.
    //
    // So we emit the REMAINING life expressed against the author's created_min.
    // The pair is coherent again, and the length a receiver reads is what is
    // actually left rather than a fresh full TTL — which also means a relayed
    // record now DECAYS across hops instead of restarting at each one.
    const remaining = m.expires_min - nowMin;
    if (remaining <= 0) {
      continue; // dead by our own clock; serving it wastes the peer's budget
    }
    const size = utf8ByteLength(m.body);
    if (fit.length > 0 && total + size > SERVE_BYTE_BUDGET) {
      break; // the rest ride the next sighting
    }
    fit.push({ ...m, expires_min: m.created_min + remaining });
    total += size;
  }
  return encodeMessages(fit);
}

// ------------------------------------------------------------- conductor

const attempt = async <T>(step: () => Promise<T>, why: string): Promise<T> => {
  try {
    return await step();
  } catch (e) {
    throw new Error(`${why} (${String((e as Error)?.message ?? e)})`);
  }
};

/**
 * Run one pull-exchange against a peer this phone can currently reach.
 * Returns how many messages were newly accepted. Prunes first (never
 * trade dead mail), skips the message fetch entirely when the digest
 * offers nothing new, and caps the want list at MAX_FETCH_IDS — the
 * digest's freshest-first order means a capped sync still moves the
 * liveliest mail. Rejections carry human-actionable messages; a failed
 * or partial sync loses nothing — every sighting starts from the store.
 */
export async function syncWithPeer(
  link: CrewSyncLink,
  crewCodes: string[],
  nowMin: number,
): Promise<{ accepted: number }> {
  pruneExpired(nowMin);
  const digestBytes = await attempt(
    () => link.fetchDigest(),
    "Couldn't reach the peer's mailbox — out of range already? Nothing was lost; the next sighting starts fresh.",
  );
  const want = wantsFrom(decodeDigest(digestBytes), nowMin).slice(
    0,
    MAX_FETCH_IDS,
  );
  if (want.length === 0) {
    return { accepted: 0 };
  }
  // Stamp BEFORE the fetch. A fetch that never returns — the peer walked away
  // mid-transfer — is exactly the case that must still count as a try, or a
  // peer who reliably drops us keeps the same ids in every slot list forever.
  recordWants(want, nowMin);
  let msgBytes: Uint8Array;
  try {
    msgBytes = await attempt(
      () => link.fetchMessages(want),
      'The message transfer broke off partway — whatever landed is kept; the next sighting continues.',
    );
  } catch (e) {
    // The TRANSPORT failed, not the ids: the connection died before the
    // peer said anything about any of them, which on a rotating-address
    // mesh is routine. Left alone, the stamp above doubles each id's
    // back-off for a failure the id had no part in — measured at twenty
    // minutes' delay between two phones side by side, with a six-hour
    // ceiling. The stamp itself stays (the walked-away case above must
    // still count); only its GROWTH is undone.
    forgiveWants(want, nowMin);
    throw e;
  }
  const accepted = acceptIncoming(decodeMessages(msgBytes), crewCodes, nowMin);
  // Clear only what LANDED. Clearing the whole request would reset the
  // back-off on every id the accept gate refused (hop horizon, per-kind byte
  // cap, unknown kind, unknown crew) — reintroducing the exact starvation the
  // ledger exists to stop, through the cure itself.
  clearWants(heldIdsAmong(want));
  return { accepted };
}
