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
  commitWantAttempt,
  forgiveWantAttempt,
  heldIdsAmong,
  messagesByIds,
  openWantAttempt,
  pruneExpired,
  rollBackWantAttempt,
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
  /**
   * THE IDENTITY OF THE OFFER `fetchDigest` JUST HANDED BACK (row 120).
   *
   * Read once, on the line after that await, and carried to `fetchMessages`
   * with the ids derived from those exact bytes. It exists because the
   * second pass RE-READS the digest before it writes the want — that is
   * what the two-pass design costs — so nothing the server remembers about
   * "what this central last read" can be the authority for "the offer this
   * ask was built against". The ask has to name it, and only this side
   * knows which read the ids came from.
   *
   * OPTIONAL, and a link that cannot answer returns nothing rather than
   * guessing: a transport with no identity on its wire hands `null` down,
   * and the native server refuses an ask it cannot attribute. Fail-closed.
   */
  offerRead?(): OfferIdentity | null;
  fetchMessages(
    wantIds: string[],
    offer?: OfferIdentity | null,
  ): Promise<Uint8Array>;
}

/**
 * WHICH OFFER A DIGEST WAS. `epoch` and `rev` are the publishing session's
 * own (epoch, revision); `generation` is the native server's per-install
 * counter, which moves on republishes the pair cannot see. All three ride
 * the wire in both directions — see CrewBeacon.swift's offerIdentityBlock
 * and CrewBeaconModule.kt's twin.
 */
export type OfferIdentity = {
  epoch: number;
  rev: number;
  generation: number;
};

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
 *
 * AND UNDER A THIRD GUARD, WHICH IS THE ONE A STRANGER TESTS: `crewCodes`
 * is the scope this phone is serving under RIGHT NOW, and a row outside it
 * is not served however honestly it is named. A want list is an
 * unauthenticated write — whoever holds a GATT connection names ids — and
 * without the scope the only thing standing between a stranger and every
 * pod's mail on this phone is that they would have to guess an id. The
 * digest they were offered was crew-scoped (syncDigest), so a want built
 * from that offer is inside the scope by construction and this guard costs
 * an honest peer nothing.
 *
 * The scope is also a LIVENESS check, not only a membership one: the codes
 * come from the running mesh session's own getter, so a want answered after
 * the pod left (or after the session was replaced) is answered under the
 * codes that are current, never the ones the offer was built from.
 */
export function serveMessages(
  wantIds: string[],
  nowMin: number,
  crewCodes?: string[],
): Uint8Array {
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
  const ordered = messagesByIds(ids, crewCodes).sort(
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
 * THE WANT-LEDGER ATTEMPT, and why the stamp needs an OWNER.
 *
 * recordWants stamps every id in the want list BEFORE the second pass goes
 * out, on purpose: a fetch that never returns (the peer walked away
 * mid-transfer) must still count as a try. The stamp is a BACK-OFF — it
 * writes `retry_min = now + backoff`, and wantsFrom filters a backed-off id
 * straight out of the next want list — so a stamp nobody ever answers for
 * SUPPRESSES that id.
 *
 * THE HOLE (cross-family review, 2026-08-27). A pass 2 that ends CANCELLED
 * answered for nothing: the cancellation returns before the ack and before
 * the live transport-failure commute, so a session that died mid-exchange
 * left its back-off standing on ids it never got an answer about. The next
 * session's exchange with the same peer then finds those ids filtered out of
 * its own want list for the whole retry window — a dead pod suppressing valid
 * mail in the pod that replaced it.
 *
 * AND THE FIRST CURE FOR IT WAS NOT A ROLLBACK (the architecture round,
 * 2026-08-27). It called forgiveWants, which is a COMMUTATION: the row keeps
 * its bumped tries, is re-armed at the two-minute base step rather than at
 * whatever it had before — and is not touched AT ALL once tries passes
 * FORGIVE_TRIES_CEILING, so an id with refusal history kept up to six hours
 * of back-off charged to a pass that never happened. "Undo" that leaves a
 * two-minute minimum on a clean id and does nothing to a dirty one is a
 * second policy wearing the word.
 *
 * SO THE LEDGER OWNS THE ATTEMPT AND THE UNDO IS AN EXACT CAS. messages.ts
 * opens the attempt (preimage read, stamp written, both inside ONE
 * transaction), and this conductor spends exactly one terminal per attempt:
 *
 *   COMMIT    — the exchange stayed live to the end. Ack what LANDED; the
 *               misses keep the back-off the ledger exists to charge.
 *   FORGIVE   — a LIVE transport failure. The strike stands, the sentence is
 *               commuted. Unchanged, and still the right answer here: the id
 *               was asked for on a radio that really did try.
 *   ROLL BACK — the session died. Every id goes back to its exact prior row,
 *               and only where the row is still byte-identical to what this
 *               attempt wrote, so a later pass that re-stamped the same id
 *               keeps the debt it earned.
 *
 * A terminal on an attempt that is already closed does nothing, so no
 * terminal can run twice and a stale attempt can never speak for a live one.
 */

/**
 * WHAT ONE EXCHANGE ANSWERS WITH — a count, or a cancellation.
 *
 * `cancelled` is not an error and not a failure: it is "the session that
 * asked for this exchange ended while the radio was out, so the exchange
 * stopped at the last point before it would have written anything shared".
 * `at` names that point, for the field log and for the arms. A cancelled
 * outcome always carries accepted: 0, because an exchange that accepted
 * rows is one that already finished its ingest.
 */
export type SyncOutcome = {
  accepted: number;
  cancelled?: true;
  at?: 'digest' | 'transport-error' | 'messages';
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
  isCurrent: () => boolean = () => true,
): Promise<SyncOutcome> {
  // THE CALLER'S EPOCH, THREADED DOWN — because a guard in the caller
  // alone cannot see inside this function. The exchange is two radio
  // passes with a JS round trip between them, and everything that makes it
  // AUTHORITATIVE happens after the first await: the want ledger is
  // stamped, a second pass goes out over the radio, incoming rows are
  // accepted into the store, and the ledger is acked. A mesh session that
  // ends mid-exchange must not do any of that — an old session importing
  // into the new pod is the same defect as an old session dialling for it,
  // one layer down — so the predicate is checked before each of them and a
  // stale answer returns a cancelled outcome having written nothing new.
  //
  // There is no retry loop here to guard: this conductor makes exactly the
  // two passes below, and `attempt` re-throws rather than re-tries. The
  // one re-entry into the radio IS the second pass, and it is behind the
  // first check.
  //
  // AND A CANCELLATION AFTER THE STAMP ROLLS THE STAMP BACK. "Wrote nothing
  // new" is not the same as "wrote nothing": the want stamp goes down before
  // the second pass by design, so the two cancellations that can happen
  // after it own it and undo it (see the attempt token above). Otherwise the
  // dead session's back-off outlives the dead session.
  if (!isCurrent()) {
    return { accepted: 0, cancelled: true, at: 'digest' };
  }
  pruneExpired(nowMin);
  const digestBytes = await attempt(
    () => link.fetchDigest(),
    "Couldn't reach the peer's mailbox — out of range already? Nothing was lost; the next sighting starts fresh.",
  );
  // THE OFFER THESE BYTES ARE, READ ON THE LINE AFTER THE BYTES ARRIVE and
  // held for the rest of this exchange (row 120). Everything below derives
  // from `digestBytes`; the ask that carries those derivations must carry
  // THIS identity, not whatever the peer publishes by the time pass 2 gets
  // there. Reading it here rather than inside the second pass is the whole
  // point: the second pass re-reads the digest, and an identity taken then
  // would name offer B while the ids name offer A.
  const offer = link.offerRead?.() ?? null;
  // Before the want stamp (a shared ledger write) and before the second
  // pass. decodeDigest/wantsFrom below are pure reads, so nothing has been
  // written on this session's behalf yet.
  if (!isCurrent()) {
    return { accepted: 0, cancelled: true, at: 'digest' };
  }
  const want = wantsFrom(decodeDigest(digestBytes), nowMin).slice(
    0,
    MAX_FETCH_IDS,
  );
  if (want.length === 0) {
    return { accepted: 0 };
  }
  // Stamp BEFORE the fetch, under a TOKEN this exchange owns. A fetch that
  // never returns — the peer walked away mid-transfer — is exactly the case
  // that must still count as a try, or a peer who reliably drops us keeps the
  // same ids in every slot list forever; and a stamp whose session dies
  // before it can answer for it is exactly the case that must be rolled back.
  const stamped = openWantAttempt(want, nowMin);
  let msgBytes: Uint8Array;
  try {
    msgBytes = await attempt(
      () => link.fetchMessages(want, offer),
      'The message transfer broke off partway — whatever landed is kept; the next sighting continues.',
    );
  } catch (e) {
    if (!isCurrent()) {
      // A DEAD SESSION'S FAILURE, and it takes the cancellation instead of
      // the error so the caller's own stale path has nothing to do but log.
      // The stamp goes back FIRST — exactly, to the row it replaced: nobody
      // is ever going to answer for it, and left standing it filters these
      // ids out of the next session's want list for the whole retry window.
      rollBackWantAttempt(stamped);
      return { accepted: 0, cancelled: true, at: 'transport-error' };
    }
    // The TRANSPORT failed, not the ids: the connection died before the
    // peer said anything about any of them, which on a rotating-address
    // mesh is routine. Left alone, the stamp above doubles each id's
    // back-off for a failure the id had no part in — measured at twenty
    // minutes' delay between two phones side by side, with a six-hour
    // ceiling. The stamp itself stays (the walked-away case above must
    // still count); only its GROWTH is undone.
    forgiveWantAttempt(stamped, nowMin);
    throw e;
  }
  // THE AUTHORITATIVE INGEST AND ITS ACK, and the last check before them.
  // acceptIncoming writes a peer's rows into THIS phone's store under the
  // crew codes it was handed; clearWants acks the ledger. A stale session
  // performing either would be a pod that no longer exists importing mail
  // into the pod that replaced it.
  if (!isCurrent()) {
    // Same rollback as the failure road, for the same reason: the ids in
    // this attempt's stamp are ids nothing will ever answer for now, and a
    // dead pod must not suppress them in the pod that replaced it.
    rollBackWantAttempt(stamped);
    return { accepted: 0, cancelled: true, at: 'messages' };
  }
  const accepted = acceptIncoming(decodeMessages(msgBytes), crewCodes, nowMin);
  // Commit clears only what LANDED. Clearing the whole request would reset
  // the back-off on every id the accept gate refused (hop horizon, per-kind
  // byte cap, unknown kind, unknown crew) — reintroducing the exact
  // starvation the ledger exists to stop, through the cure itself. The
  // ingest runs FIRST because heldIdsAmong is the question "what do we hold
  // now", and now is after the rows landed.
  commitWantAttempt(stamped, heldIdsAmong(want));
  return { accepted };
}
