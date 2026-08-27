/**
 * Crew beacon — the BLE wire protocol, pure functions only (Crew Phase B,
 * docs/CREW-DESIGN.md §4). No imports, no I/O, no clocks: every function is
 * a plain (bytes, strings, numbers) -> value transform, so the whole
 * protocol is unit-testable without a radio and the native BLE half only
 * ever moves opaque byte arrays.
 *
 * THE RADIO REALITY this format is shaped by: Android can put a data
 * payload inline in an advertisement (manufacturer/service data), so an
 * Android beacon is read passively by anyone scanning. iOS CANNOT
 * (CoreBluetooth advertises only service UUIDs + local name), so an iOS
 * sender is discovered by UUID and the receiver must CONNECT and READ a
 * GATT characteristic to get the same bytes. Both paths carry the SAME
 * 21-byte payload below — the transport differs, the logical protocol
 * doesn't. Budget: 21 bytes + 2 (company id) + 2 (AD length/type) = 25,
 * inside the 31-byte legacy advertising budget, which is why the format
 * is offsets-and-hashes rather than floats-and-strings.
 *
 * BYTE LAYOUT (21 bytes, all multi-byte fields big-endian):
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------------
 *      0      2   magic 'PP' (0x50 0x50)
 *      2      1   version (0x01)
 *      3      4   crewHash    — hash32 of the crew code, normalized
 *      7      4   memberHash  — hash32 of the sender's FriendCard.id
 *     11      2   latQ        — int16, two's complement (see below)
 *     13      2   lonQ        — int16, two's complement
 *     15      2   epochMin    — sender's minutes-since-Unix-epoch mod 65536
 *     17      4   mac         — keyed hash32 chain over clear bytes 0..16
 *
 * THE MAILBOX FRAME (17 bytes) — the second thing this wire carries, and
 * the reason it exists: until 2026-08-25 the ONLY caller that ever started
 * the radio was the position-share session, so a pod whose members had
 * "Share my position" off had no radio at all — and pod messages and voice
 * notes, which ride sightings (meshSync.ts), simply never moved. Measured
 * on two adjacent Pixels: sharing off = zero PlayaMesh lines in 47 s and
 * zero delivery; sharing on = delivery in 27.4 s. Mail must not be a
 * side-effect of consenting to be located.
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------------
 *      0      2   magic 'PP'
 *      2      1   version (0x01)
 *      3      4   crewHash
 *      7      4   memberHash
 *     11      2   epochMin
 *     13      4   mac         — keyed hash32 chain over clear bytes 0..12
 *
 * THERE IS NO POSITION FIELD. Not a sentinel, not a zeroed pair: the frame
 * is structurally four bytes shorter, so "the mailbox advert leaked a
 * position" is not a bug that can be written — there is nowhere to put it,
 * and a decoder returns a value that has no lat/lon to read (the union
 * below). That is the privacy pin the app's stance needs: the advert IS
 * position data by design (AndroidManifest's BLUETOOTH_SCAN comment: "a
 * crew sighting IS position data (self-reported in the payload)"), so the
 * only honest way to advertise without sharing a position is a frame that
 * cannot carry one.
 *
 * WHAT A MAILBOX FRAME STILL DISCLOSES, said plainly: a podmate who hears
 * it learns that a member of this pod is within radio range right now, and
 * that this phone will serve mail. Any BLE mailbox necessarily discloses
 * that much — being reachable is what makes delivery possible — but it
 * discloses NO coordinates, and nothing about it enters the sighting
 * store's position half (presence.ts reportHeard vs reportSighting).
 *
 * LENGTH IS THE DISCRIMINATOR, and it is also the compatibility story: a
 * build that predates this frame checks `bytes.length !== BEACON_LENGTH`
 * first and rejects a mailbox advert outright. An old phone therefore sees
 * a mailbox-only podmate as quiet — never as a false pin somewhere on the
 * rim, which is the failure mode a spare-value sentinel would have shipped
 * to every un-updated handset in a pod.
 *
 * POSITION ENCODING. latQ/lonQ are offsets from the city's golden-spike
 * center (BrcGeometry.center) in QUANT_METERS (~2 m) steps, north/east
 * positive, meters-per-degree evaluated at the center latitude. int16 x 2 m
 * = +/-65.5 km of reach around the spike — the trash fence is ~2.5 km out,
 * so the whole city fits ~26x over and even a Gerlach run stays on-scale
 * (beyond it the value CLAMPS to the rim, it never wraps). The ~2 m grain
 * is far below phone GPS error (~5-15 m) and street width, so quantization
 * never moves anyone visibly. Four bytes instead of sixteen of float64 is
 * what keeps the payload inside the advertising budget.
 *
 * IDENTITY. crewHash gates "is this one of MY crews" without ever putting
 * the code itself on the air; memberHash lets a receiver match a sighting
 * to a FriendCard it already holds (src/friends/friendCard.ts — the card
 * exchange IS the introduction; a hash you can't match is a stranger and
 * decodes to nothing useful).
 *
 * INTEGRITY + REPLAY (cross-family review fixes, codex 2026-08-24):
 *
 * - mac: a 4-byte KEYED, NONLINEAR check — hash32 chained from a key
 *   derived from the crew code + time bucket, folded over the clear
 *   payload. The first design's 1-byte xorCheck was XOR-linear, so an
 *   attacker WITHOUT the code could flip a ciphertext payload bit plus the
 *   matching check bit and blind-shift someone's position; FNV's multiply
 *   step breaks that linearity, and the key means a valid mac can only be
 *   minted with the crew code.
 * - epochMin: the sender stamps its own clock (minute grain, wraps every
 *   ~45.5 days). A decoder rejects anything more than EPOCH_WINDOW_MIN
 *   (20 min) out of step with its own clock — mod-65536 wrap handled — and
 *   surfaces the beacon's true age, so a captured-and-replayed beacon
 *   re-decodes with its ORIGINAL timestamp and can never re-stamp a stale
 *   position as "live" (the whiteout-compass steering attack).
 * - DOMAIN SEPARATION: the obfuscation keystream seeds from
 *   'ks|code|bucket' and the mac key from 'mac|code|bucket' — two prefixes
 *   so keystream bytes and mac-key bytes never coincide. Both derivations
 *   are pinned by test vectors: they are wire contract for a native port.
 *
 * POSTURE — honest, per the app's stated trust model (friendCard.ts:
 * "share what you'd write on a note board"): forging or altering a beacon
 * now requires the crew code — and the code is ~13 bits (a 4-digit PIN is
 * 10,000 spellings; the three-word phrase it replaced was 9,000, so the
 * short one is very slightly stronger). Say the consequence plainly rather
 * than softly: the code resists SHOULDER-SURFING, not CAPTURE. crewHash is
 * hash32 of the code, so one captured beacon brute-forces it offline in
 * milliseconds, and that yields the pod — its mail, its member
 * announcements' names, and the ability to mint valid MACs. The code is a
 * note-board secret and nothing more; real entropy belongs in the QR/beam
 * path (docs/CREW-DESIGN.md §6e, the sync-privacy row).
 * hash32 is not a cryptographic hash and this is not encryption:
 * the construction defeats casual sniffing, blind forgery and replay, not
 * a resourced adversary. The 10-minute rotation still changes the wire
 * bytes so a fixed passive antenna can't trivially follow one member
 * across the week without the code.
 */

/* eslint-disable no-bitwise -- a byte-level wire codec IS bitwise math;
   scoped to this one protocol file, nothing above this layer shifts bits */

// ---------------------------------------------------------------------------
// hash32 — FNV-1a
// ---------------------------------------------------------------------------

/**
 * Small, stable 32-bit FNV-1a over UTF-16 code units. Not cryptographic —
 * it only has to be deterministic across devices and app versions (a crew
 * mate's phone must derive the very same crewHash/memberHash forever) and
 * well-spread enough that two 8-hex card ids virtually never collide.
 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned — a beacon field, never a JS negative
}

// ---------------------------------------------------------------------------
// Crew code normalization
// ---------------------------------------------------------------------------

/**
 * One canonical spelling per crew code, applied EVERYWHERE a code touches
 * the protocol (crewHash, keystream seed, mac key): codes are typed by
 * dusty humans on two different phones, and " Dusty-Llamas " must join the
 * same crew as "dusty-llamas" or the feature silently never works.
 */
export function normalizeCrewCode(code: string): string {
  return code.trim().toLowerCase();
}

/** The crewHash a beacon carries for a code — hash of the NORMALIZED form. */
export function crewHashOf(code: string): number {
  return hash32(normalizeCrewCode(code));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BEACON_LENGTH = 21;
/** The position-free mailbox frame (see the header's layout table). */
export const MAILBOX_LENGTH = 17;
export const BEACON_VERSION = 1;
/** 'P' — the two magic bytes are 'PP' for Playa Pal. */
const MAGIC = 0x50;
/** Where the 4-byte mac starts; everything before it is the clear payload
 * the mac covers. One per frame kind — the mailbox frame's mac sits where
 * the position frame's latQ does, which is why the two are never confusable
 * (the mac is keyed, so a truncated position frame cannot validate here). */
const MAC_AT = 17;
const MAILBOX_MAC_AT = 13;

/** Position grain, meters per int16 step (header: span/grain tradeoff). */
export const QUANT_METERS = 2;

/**
 * Obfuscation rotation period. Ten minutes is coarse on purpose: phone
 * clocks drift and nobody NTP-syncs on playa, so a decoder tries the
 * current and previous bucket — +/-10 min of skew always lands on one of
 * the two, and a beacon older than ~20 minutes stops decoding at the
 * keystream level. The epochMin field (below) is the finer, minute-grain
 * truth inside that window.
 */
export const TIME_BUCKET_MS = 600_000;

/** Accept window for the sender's epochMin stamp, minutes either way —
 * matched to the ~20 min the two-bucket keystream window already implies,
 * so neither check quietly widens the other. */
export const EPOCH_WINDOW_MIN = 20;

/** nowMs -> the obfuscation bucket. Callers pass time IN (no clocks here). */
export function timeBucketOf(nowMs: number): number {
  return Math.floor(nowMs / TIME_BUCKET_MS);
}

/** nowMs -> the wire's minute stamp (mod 65536; wraps every ~45.5 days —
 * the decode window is 20 minutes, so the wrap is handled, never felt). */
export function epochMinOf(nowMs: number): number {
  return Math.floor(nowMs / 60_000) % 65536;
}

// ---------------------------------------------------------------------------
// Key derivation (domain-separated; pinned by test vectors — wire contract)
// ---------------------------------------------------------------------------

/**
 * The four domains, one prefix each. Two axes, both load-bearing:
 *
 *  - KEYSTREAM vs MAC (the original separation): keystream bytes and
 *    mac-key bytes must never coincide, or XOR-masking could leak mac
 *    structure.
 *  - POSITION frame vs MAILBOX frame (added with the mailbox frame): the
 *    two frames are sent by the same phone, for the same crew, inside the
 *    same 10-minute bucket. One keystream across two plaintexts under one
 *    key is the two-time-pad, and while a mailbox frame carries nothing
 *    secret, "this frame has nothing worth protecting" is exactly the
 *    reasoning that ages badly when a field is added later. One prefix is
 *    the whole cost of not having to think about it again.
 */
const KEYSTREAM_DOMAIN = 'ks';
const MAC_DOMAIN = 'mac';
const MAILBOX_KEYSTREAM_DOMAIN = 'ksm';
const MAILBOX_MAC_DOMAIN = 'macm';

/** Seed for the XOR keystream: 'ks|' + normalized code + '|' + bucket (or
 * the mailbox frame's own 'ksm|' domain). */
export function keystreamSeed(
  crewCode: string,
  timeBucket: number,
  domain: string = KEYSTREAM_DOMAIN,
): number {
  return hash32(`${domain}|${normalizeCrewCode(crewCode)}|${timeBucket}`);
}

/** Key for the mac chain: 'mac|' + normalized code + '|' + bucket (or the
 * mailbox frame's 'macm|'). */
export function macKeyOf(
  crewCode: string,
  timeBucket: number,
  domain: string = MAC_DOMAIN,
): number {
  return hash32(`${domain}|${normalizeCrewCode(crewCode)}|${timeBucket}`);
}

/** Keyed nonlinear check over the clear bytes before `macAt`: FNV-1a
 * continued from the keyed state, one multiply per byte — the multiply's
 * carries are what break the XOR-linearity the old 1-byte xorCheck died of. */
function macOf(
  clear: Uint8Array,
  crewCode: string,
  timeBucket: number,
  macAt: number = MAC_AT,
  domain: string = MAC_DOMAIN,
): number {
  let h = macKeyOf(crewCode, timeBucket, domain);
  for (let i = 0; i < macAt; i++) {
    h ^= clear[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Quantization (center-relative int16 offsets)
// ---------------------------------------------------------------------------

/**
 * Meters per degree of latitude/longitude at a latitude — same standard
 * series as src/geo/brcGeo.ts, restated here in meters because this module
 * must stay import-free (it is the wire spec; the native half may one day
 * port it verbatim to Kotlin/Swift for background use).
 */
function mPerDegLat(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180;
  return (
    111132.92 -
    559.82 * Math.cos(2 * p) +
    1.175 * Math.cos(4 * p) -
    0.0023 * Math.cos(6 * p)
  );
}

function mPerDegLon(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180;
  return (
    111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
  );
}

const clampI16 = (v: number): number =>
  Math.max(-32768, Math.min(32767, Math.round(v)));

/** What a beacon says, before bytes. See the header's layout table. */
export interface Payload {
  /** hash32 of the crew code (lowercased + trimmed). */
  crewHash: number;
  /** hash32 of the sender's FriendCard.id. */
  memberHash: number;
  /** North offset from the city center, int16, ~2 m units. */
  latQ: number;
  /** East offset from the city center, int16, ~2 m units. */
  lonQ: number;
  /** Sender's clock at build time, minutes mod 65536 (replay guard). */
  epochMin: number;
}

/**
 * The one quantizer: a real fix + the city center + the sender's clock ->
 * a Payload. Off-scale positions clamp to the +/-65.5 km rim (never wrap —
 * a wrapped offset would point crew mates the exact wrong way, a clamped
 * one still points out toward you). Center comes from
 * getCityGeometry().center; both sides of a crew bundle the same year's
 * geometry, so the shared origin is free. `nowMs` is passed IN — protocol
 * functions never read clocks.
 */
export function buildPayload(
  crewCode: string,
  cardId: string,
  pos: { lat: number; lon: number },
  center: { lat: number; lon: number },
  nowMs: number,
): Payload {
  return {
    crewHash: crewHashOf(crewCode),
    memberHash: hash32(cardId),
    latQ: clampI16(((pos.lat - center.lat) * mPerDegLat(center.lat)) / QUANT_METERS),
    lonQ: clampI16(((pos.lon - center.lon) * mPerDegLon(center.lat)) / QUANT_METERS),
    epochMin: epochMinOf(nowMs),
  };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

const writeU32 = (out: Uint8Array, at: number, v: number): void => {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
};

const readU32 = (b: Uint8Array, at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

const writeU16 = (out: Uint8Array, at: number, v: number): void => {
  out[at] = (v >>> 8) & 0xff;
  out[at + 1] = v & 0xff;
};

const readU16 = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];

/** int16 two's complement, big-endian. */
const writeI16 = (out: Uint8Array, at: number, v: number): void => {
  out[at] = (v >> 8) & 0xff;
  out[at + 1] = v & 0xff;
};

const readI16 = (b: Uint8Array, at: number): number => {
  const u = readU16(b, at);
  return u >= 0x8000 ? u - 0x10000 : u;
};

/**
 * Payload -> the 21 wire bytes (see the header's layout table), including
 * the keyed mac — which is why the crew code and time bucket are needed
 * here: the mac key is derived from both, so only a holder of the code can
 * mint bytes that will decode. Assumes a payload from buildPayload (fields
 * already integral and in range). The same bucket must then be handed to
 * obfuscate(), and the bucket the receiver recovers is the one that keys
 * its mac recomputation.
 */
export function encodeBeacon(
  p: Payload,
  crewCode: string,
  timeBucket: number,
): Uint8Array {
  const out = new Uint8Array(BEACON_LENGTH);
  out[0] = MAGIC;
  out[1] = MAGIC;
  out[2] = BEACON_VERSION;
  writeU32(out, 3, p.crewHash);
  writeU32(out, 7, p.memberHash);
  writeI16(out, 11, p.latQ);
  writeI16(out, 13, p.lonQ);
  writeU16(out, 15, p.epochMin);
  writeU32(out, MAC_AT, macOf(out, crewCode, timeBucket));
  return out;
}

/** What a MAILBOX frame says: I am in this pod, I am on the air, ask me for
 * mail. Deliberately the position payload minus the position — there is no
 * latQ/lonQ field to omit by accident or to fill in later. */
export interface MailboxPayload {
  /** hash32 of the crew code (lowercased + trimmed). */
  crewHash: number;
  /** hash32 of the sender's FriendCard.id. */
  memberHash: number;
  /** Sender's clock at build time, minutes mod 65536 (replay guard). */
  epochMin: number;
}

/**
 * The mailbox quantizer's whole job is that there is nothing to quantize:
 * a crew code, a card id and the sender's clock. NO position argument is
 * accepted — not "ignored", not "optional". A caller holding a live GPS fix
 * cannot pass it in, which is what makes "the mailbox advert carries no
 * position" a property of the type rather than a promise in a comment.
 */
export function buildMailboxPayload(
  crewCode: string,
  cardId: string,
  nowMs: number,
): MailboxPayload {
  return {
    crewHash: crewHashOf(crewCode),
    memberHash: hash32(cardId),
    epochMin: epochMinOf(nowMs),
  };
}

/** MailboxPayload -> the 17 wire bytes, keyed mac included (same
 * forgery/tamper gate as the position frame, its own mac domain). */
export function encodeMailbox(
  p: MailboxPayload,
  crewCode: string,
  timeBucket: number,
): Uint8Array {
  const out = new Uint8Array(MAILBOX_LENGTH);
  out[0] = MAGIC;
  out[1] = MAGIC;
  out[2] = BEACON_VERSION;
  writeU32(out, 3, p.crewHash);
  writeU32(out, 7, p.memberHash);
  writeU16(out, 11, p.epochMin);
  writeU32(
    out,
    MAILBOX_MAC_AT,
    macOf(out, crewCode, timeBucket, MAILBOX_MAC_AT, MAILBOX_MAC_DOMAIN),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Obfuscation (NOT encryption — see the header's posture paragraph)
// ---------------------------------------------------------------------------

/**
 * XOR the bytes with a keystream chained from hash32, seeded by
 * keystreamSeed (the 'ks|' domain) over the NORMALIZED crew code + the
 * 10-minute time bucket — the bucket computed by the CALLER
 * (timeBucketOf(now); nothing in this file reads a clock, which is what
 * keeps every function here replayable in tests). XOR is an involution, so
 * this same function deobfuscates; a decoder must try the current AND
 * previous bucket to absorb clock skew (see TIME_BUCKET_MS). Returns a new
 * array — never mutates its input.
 */
export function obfuscate(
  bytes: Uint8Array,
  crewCode: string,
  timeBucket: number,
  domain: string = KEYSTREAM_DOMAIN,
): Uint8Array {
  const code = normalizeCrewCode(crewCode);
  const out = new Uint8Array(bytes.length);
  let state = keystreamSeed(crewCode, timeBucket, domain);
  for (let i = 0; i < bytes.length; i++) {
    const shift = (i % 4) * 8;
    if (i > 0 && shift === 0) {
      // Re-chain every 4 bytes so the stream doesn't repeat its one word;
      // the domain prefix keeps even the re-chain inside its own keystream.
      state = hash32(`${domain}|${state.toString(16)}|${code}`);
    }
    out[i] = bytes[i] ^ ((state >>> shift) & 0xff);
  }
  return out;
}

/** Same operation — named so call sites read honestly. */
export const deobfuscate = obfuscate;

/**
 * The mailbox frame's masking pass, in its own keystream domain — the one
 * call sites use, so no caller above this file ever handles a domain
 * string (and none can accidentally mask a mailbox frame with the position
 * frame's keystream, which is the two-time-pad the domains exist to
 * prevent). Involutive, like obfuscate: the same call decodes.
 */
export function obfuscateMailbox(
  bytes: Uint8Array,
  crewCode: string,
  timeBucket: number,
): Uint8Array {
  return obfuscate(bytes, crewCode, timeBucket, MAILBOX_KEYSTREAM_DOMAIN);
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

interface DecodedCommon {
  /** The matching entry from the caller's crewCodes, VERBATIM as passed —
   * so the caller can key its own crew records without re-normalizing. */
  crewCode: string;
  /** hash32 of the sender's card id — resolve against held FriendCards. */
  memberHash: number;
  /** How old the beacon is BY THE SENDER'S OWN STAMP, ms (minute grain,
   * never negative). A replayed capture carries its original stamp, so a
   * presence layer that records atMs = heardAt - ageMs can never be
   * steered into calling a stale position "live". */
  ageMs: number;
}

/**
 * A DISCRIMINATED UNION, not an object with optional coordinates, and the
 * difference is the point: `hit.lat` does not compile until the caller has
 * narrowed on `kind === 'position'`, so no present or future sighting
 * consumer can pin a map marker from a frame that never carried a place.
 * The type is the enforcement; the tests below it are the second lock.
 */
export type DecodedBeacon =
  | (DecodedCommon & {
      kind: 'position';
      /** De-quantized real coordinates (center + offset; ~2 m grain). */
      lat: number;
      lon: number;
    })
  | (DecodedCommon & {
      /** Reach, and nothing else: this pod member's phone is in range and
       * serving mail. No coordinates exist on this frame. */
      kind: 'mailbox';
    });

/**
 * Sniff raw radio bytes against every crew this phone belongs to. Takes
 * the receiver's clock as `nowMs` (passed in, never read) and tries each
 * code x {current bucket, previous bucket} (clock-skew tolerance, see
 * TIME_BUCKET_MS). Accepts only when ALL of these agree: magic + version,
 * the keyed mac over the clear bytes (forgery/tamper gate — see the
 * header's INTEGRITY paragraph), the payload's own crewHash, and the
 * epochMin stamp within EPOCH_WINDOW_MIN of the receiver's clock
 * (replay gate, mod-65536 wrap handled). Returns null for anything else:
 * the scan callback fires for every BLE device at a festival of 70,000
 * phones, so "not ours, ignore" is the hot path and must be cheap and
 * silent.
 *
 * `center` is the same golden-spike origin the sender quantized against
 * (getCityGeometry().center) — passed in, not imported, so this module
 * stays a pure spec and tests can use any origin.
 */
export function decodeBeacon(
  bytes: Uint8Array,
  crewCodes: string[],
  nowMs: number,
  center: { lat: number; lon: number },
): DecodedBeacon | null {
  const mailbox = bytes.length === MAILBOX_LENGTH;
  if (!mailbox && bytes.length !== BEACON_LENGTH) {
    return null;
  }
  // The frame kind picks its own domains, mac offset and epoch offset
  // before a single byte is unmasked — one pass, no guessing between two
  // shapes, and a mailbox frame is never even TRIED as a position one.
  const ksDomain = mailbox ? MAILBOX_KEYSTREAM_DOMAIN : KEYSTREAM_DOMAIN;
  const macDomain = mailbox ? MAILBOX_MAC_DOMAIN : MAC_DOMAIN;
  const macAt = mailbox ? MAILBOX_MAC_AT : MAC_AT;
  const epochAt = mailbox ? 11 : 15;
  const nowMin = Math.floor(nowMs / 60_000);
  const nowBucket = timeBucketOf(nowMs);
  for (const crewCode of crewCodes) {
    for (const bucket of [nowBucket, nowBucket - 1]) {
      const plain = deobfuscate(bytes, crewCode, bucket, ksDomain);
      if (plain[0] !== MAGIC || plain[1] !== MAGIC || plain[2] !== BEACON_VERSION) {
        continue;
      }
      if (
        readU32(plain, macAt) !== macOf(plain, crewCode, bucket, macAt, macDomain)
      ) {
        continue;
      }
      if (readU32(plain, 3) !== crewHashOf(crewCode)) {
        continue;
      }
      // Signed distance receiver-minus-sender on the mod-65536 minute ring,
      // mapped into [-32768, 32767]: positive = beacon is old, negative =
      // sender's clock runs ahead of ours. Either way past the window is
      // a replay or a broken clock — reject, don't guess.
      const skewMin =
        ((((nowMin - readU16(plain, epochAt)) % 65536) + 65536 + 32768) % 65536) -
        32768;
      if (skewMin > EPOCH_WINDOW_MIN || skewMin < -EPOCH_WINDOW_MIN) {
        continue;
      }
      const common = {
        crewCode,
        memberHash: readU32(plain, 7),
        ageMs: Math.max(0, skewMin) * 60_000,
      };
      if (mailbox) {
        return { ...common, kind: 'mailbox' };
      }
      return {
        ...common,
        kind: 'position',
        lat: center.lat + (readI16(plain, 11) * QUANT_METERS) / mPerDegLat(center.lat),
        lon: center.lon + (readI16(plain, 13) * QUANT_METERS) / mPerDegLon(center.lat),
      };
    }
  }
  return null;
}
