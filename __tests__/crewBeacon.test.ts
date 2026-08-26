/**
 * Crew Phase B, radio-independent half (docs/CREW-DESIGN.md §4): the wire
 * protocol (src/crews/beacon.ts), the sighting store (presence.ts) and the
 * sharing session (session.ts), exercised end-to-end with a fake radio.
 * Everything is injected — no native modules, no jest.mock, no clocks: the
 * same property that lets the parallel native BLE build implement CrewRadio
 * against a frozen, fully-tested protocol.
 *
 * The forgery and replay suites pin the cross-family review fixes (codex
 * 2026-08-24): the old 1-byte xorCheck was XOR-linear (flip a ciphertext
 * payload bit + the matching check bit = still valid), and a replayed
 * capture could re-stamp a stale position as heard-now. The keyed mac and
 * the epochMin stamp close both; these tests ARE those attacks.
 */

import {
  BEACON_LENGTH,
  buildMailboxPayload,
  buildPayload,
  crewHashOf,
  decodeBeacon,
  deobfuscate,
  encodeBeacon,
  epochMinOf,
  encodeMailbox,
  hash32,
  keystreamSeed,
  macKeyOf,
  MAILBOX_LENGTH,
  obfuscate,
  obfuscateMailbox,
  timeBucketOf,
  type DecodedBeacon,
} from '../src/crews/beacon';
import {
  LIVE_WINDOW_MS,
  presenceFor,
  presenceRevision,
  pruneSightings,
  reportHeard,
  reportSighting,
  SIGHTING_TTL_MS,
  subscribePresenceChanged,
} from '../src/crews/presence';
import {
  CrewRadio,
  masterOff,
  sessionActive,
  sessionRevision,
  startCrewSession,
  subscribeSessionChanged,
} from '../src/crews/session';

/** The real 2026 golden spike (assets/city-geo/geometry.json). */
const CENTER = { lat: 40.783242, lon: -119.207871 };
/** Independent meters-per-degree approximations for error measurement —
 * deliberately NOT the module's own series, so a symmetric bug in its
 * projection can't cancel out of the assertion. */
const M_LAT = 111132;
const M_LON = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);

const errorMeters = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number => Math.hypot((a.lat - b.lat) * M_LAT, (a.lon - b.lon) * M_LON);

/** A fixed instant ~6.7 min into its 10-min bucket — the phase matters for
 * the replay tests: T0 - 15 min lands in the PREVIOUS bucket (decodable),
 * T0 - 25 min lands two buckets back (not). */
const T0 = 1_756_000_000_000;
const CODE = 'dusty llamas';
const MY_CARD = 'aaaa1111';
const OTHER_CARD = 'bbbb2222';

/** Build the wire bytes exactly as a sender at `atMs` would. */
const wireFor = (
  cardId: string,
  pos: { lat: number; lon: number },
  atMs: number,
  code: string = CODE,
): Uint8Array =>
  obfuscate(
    encodeBeacon(buildPayload(code, cardId, pos, CENTER, atMs), code, timeBucketOf(atMs)),
    code,
    timeBucketOf(atMs),
  );

/**
 * Decode something that MUST be a position frame. beacon.ts's union hides
 * lat/lon until a caller proves the kind, so every position assertion in
 * this file goes through this one narrowing — and the mailbox suite below
 * calls decodeBeacon raw, which is exactly the separation the union buys.
 */
const decodePos = (
  bytes: Uint8Array,
  codes: string[],
  nowMs: number,
  center: { lat: number; lon: number },
): (DecodedBeacon & { kind: 'position' }) | null => {
  const hit = decodeBeacon(bytes, codes, nowMs, center);
  return hit !== null && hit.kind === 'position' ? hit : null;
};

const hex = (a: Uint8Array): string =>
  Array.from(a)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

const flip = (wire: Uint8Array, byteAt: number, bit: number): Uint8Array => {
  const m = Uint8Array.from(wire);
  // eslint-disable-next-line no-bitwise -- flipping wire bits IS the attack
  m[byteAt] ^= 1 << bit;
  return m;
};

beforeEach(async () => {
  // Module-level stores outlive each test: kill any session, then age every
  // sighting out through the store's own public prune.
  await masterOff();
  pruneSightings(Number.POSITIVE_INFINITY);
});

// ---------------------------------------------------------------------------

describe('hash32', () => {
  test('matches the published FNV-1a 32-bit vectors (cross-platform anchor)', () => {
    // The native half may re-implement this in Kotlin/Swift; these vectors
    // are the contract that both sides hash identically forever.
    expect(hash32('')).toBe(0x811c9dc5);
    expect(hash32('a')).toBe(0xe40c292c);
    expect(hash32('foobar')).toBe(0xbf9cf968);
  });

  test('is unsigned and stable across calls', () => {
    const h = hash32(MY_CARD);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(hash32(MY_CARD)).toBe(h);
    expect(hash32(OTHER_CARD)).not.toBe(h);
  });
});

describe('beacon wire format', () => {
  test('encodes 21 bytes with the PP magic and version 1', () => {
    const plain = encodeBeacon(
      buildPayload(CODE, MY_CARD, CENTER, CENTER, T0),
      CODE,
      timeBucketOf(T0),
    );
    expect(plain.length).toBe(BEACON_LENGTH);
    expect(plain[0]).toBe(0x50);
    expect(plain[1]).toBe(0x50);
    expect(plain[2]).toBe(1);
  });

  test('round-trips: encode -> obfuscate -> decode recovers member, position and age', () => {
    const pos = { lat: CENTER.lat + 0.005, lon: CENTER.lon - 0.008 };
    const hit = decodePos(wireFor(MY_CARD, pos, T0), [CODE], T0, CENTER);
    expect(hit).not.toBeNull();
    expect(hit!.crewCode).toBe(CODE);
    expect(hit!.memberHash).toBe(hash32(MY_CARD));
    expect(hit!.ageMs).toBe(0);
    expect(errorMeters(hit!, pos)).toBeLessThan(3);
  });

  test('quantization error stays under 3 m across the city at BRC latitude', () => {
    // 2 m grain -> worst case 1 m per axis, ~1.42 m diagonal; assert the
    // documented < 3 m bound at Esplanade-to-fence scale offsets.
    const offsets = [
      [0.0001, 0.0001],
      [0.01, -0.015],
      [-0.02, 0.02],
      [0.0234, 0.0177],
    ];
    for (const [dLat, dLon] of offsets) {
      const pos = { lat: CENTER.lat + dLat, lon: CENTER.lon + dLon };
      const hit = decodePos(wireFor(MY_CARD, pos, T0), [CODE], T0, CENTER);
      expect(hit).not.toBeNull();
      expect(errorMeters(hit!, pos)).toBeLessThan(3);
    }
  });

  test('a crew code you do not hold decodes to nothing', () => {
    const wire = wireFor(MY_CARD, CENTER, T0);
    expect(decodePos(wire, ['other crew'], T0, CENTER)).toBeNull();
    expect(decodePos(wire, [], T0, CENTER)).toBeNull();
    // wrong length is not even tried
    expect(decodePos(wire.slice(0, BEACON_LENGTH - 1), [CODE], T0, CENTER)).toBeNull();
  });

  test('crew codes are normalized: case and padding never split a crew', () => {
    const wire = wireFor(MY_CARD, CENTER, T0, 'dusty llamas');
    const hit = decodePos(wire, ['  DUSTY Llamas '], T0, CENTER);
    expect(hit).not.toBeNull();
    // the caller's own spelling comes back verbatim, for keying its records
    expect(hit!.crewCode).toBe('  DUSTY Llamas ');
  });

  test('previous time bucket still decodes; two buckets old does not', () => {
    const wire = wireFor(MY_CARD, CENTER, T0);
    expect(decodePos(wire, [CODE], T0, CENTER)).not.toBeNull();
    const nextBucket = decodePos(wire, [CODE], T0 + 600_000, CENTER);
    expect(nextBucket).not.toBeNull();
    expect(nextBucket!.ageMs).toBe(600_000); // the epoch stamp keeps age honest
    expect(decodePos(wire, [CODE], T0 + 1_200_000, CENTER)).toBeNull();
  });

  test('obfuscation rotates the wire bytes per bucket and is its own inverse', () => {
    const plain = encodeBeacon(
      buildPayload(CODE, MY_CARD, CENTER, CENTER, T0),
      CODE,
      timeBucketOf(T0),
    );
    const b = timeBucketOf(T0);
    const w1 = obfuscate(plain, CODE, b);
    const w2 = obfuscate(plain, CODE, b + 1);
    expect(Array.from(w1)).not.toEqual(Array.from(plain));
    expect(Array.from(w1)).not.toEqual(Array.from(w2));
    expect(Array.from(deobfuscate(w1, CODE, b))).toEqual(Array.from(plain));
  });

  test('off-scale positions clamp to the int16 rim, never wrap', () => {
    // ~222 km south / ~168 km east — way past the +/-65.5 km span.
    const far = { lat: CENTER.lat - 2, lon: CENTER.lon + 2 };
    const p = buildPayload(CODE, MY_CARD, far, CENTER, T0);
    expect(p.latQ).toBe(-32768);
    expect(p.lonQ).toBe(32767);
    const hit = decodePos(wireFor(MY_CARD, far, T0), [CODE], T0, CENTER);
    expect(hit).not.toBeNull();
    // decoded point sits on the rim in the TRUE direction (a wrap would
    // flip the sign and point crew mates exactly backwards)
    expect(hit!.lat).toBeLessThan(CENTER.lat);
    expect(hit!.lat).toBeGreaterThan(CENTER.lat - 0.7);
    expect(hit!.lon).toBeGreaterThan(CENTER.lon);
    expect(hit!.lon).toBeLessThan(CENTER.lon + 0.9);
  });
});

// ---------------------------------------------------------------------------

/**
 * THE MAILBOX FRAME — the position-free half of the wire, and the privacy
 * pin of the whole mailbox lane. The app now advertises whenever it is open
 * with a pod, so that pod messages move without anyone consenting to be
 * LOCATED; the entire safety of that rests on this frame carrying no place.
 * Every assertion here is written to die on a specific way of leaking one.
 */
describe('the mailbox frame carries no position', () => {
  const mailboxWire = (
    cardId: string,
    atMs: number,
    code: string = CODE,
  ): Uint8Array =>
    obfuscateMailbox(
      encodeMailbox(
        buildMailboxPayload(code, cardId, atMs),
        code,
        timeBucketOf(atMs),
      ),
      code,
      timeBucketOf(atMs),
    );

  test('the builder has no way to be handed a position', () => {
    // Mutation: add a position parameter (or a latQ/lonQ field) to
    // buildMailboxPayload — the key set below grows and this dies. It is
    // the STRUCTURAL half of the pin: what cannot be expressed cannot leak.
    const p = buildMailboxPayload(CODE, MY_CARD, T0);
    expect(Object.keys(p).sort()).toEqual(['crewHash', 'epochMin', 'memberHash']);
    expect(buildMailboxPayload.length).toBe(3); // code, cardId, nowMs
  });

  test('encodes 17 bytes: magic, version, crew, member, minute, mac', () => {
    const plain = encodeMailbox(
      buildMailboxPayload(CODE, MY_CARD, T0),
      CODE,
      timeBucketOf(T0),
    );
    expect(plain.length).toBe(MAILBOX_LENGTH);
    expect(MAILBOX_LENGTH).toBe(BEACON_LENGTH - 4); // exactly latQ+lonQ short
    expect(plain[0]).toBe(0x50);
    expect(plain[1]).toBe(0x50);
    expect(plain[2]).toBe(1);
    expect(plain.slice(3, 7)).toEqual(
      Uint8Array.from([
        (crewHashOf(CODE) >>> 24) & 255,
        (crewHashOf(CODE) >>> 16) & 255,
        (crewHashOf(CODE) >>> 8) & 255,
        crewHashOf(CODE) & 255,
      ]),
    );
    expect((plain[11] << 8) | plain[12]).toBe(epochMinOf(T0));
  });

  test('A PLANTED POSITION CANNOT SURVIVE THE FRAME', () => {
    // The mutation this file exists to catch, performed by hand: take a
    // real fix, quantize it the way the position frame does, and try to
    // smuggle the bytes into a mailbox advert. There is no room for them —
    // the frame is 17 bytes and every one of them is spoken for — so the
    // only way to carry them is to grow the frame, and a grown frame is no
    // longer a mailbox frame to any decoder on either phone.
    const somewhere = { lat: CENTER.lat + 0.01, lon: CENTER.lon - 0.01 };
    const carrying = buildPayload(CODE, MY_CARD, somewhere, CENTER, T0);
    const honest = encodeMailbox(
      buildMailboxPayload(CODE, MY_CARD, T0),
      CODE,
      timeBucketOf(T0),
    );
    const smuggled = Uint8Array.from(honest);
    smuggled[11] = (carrying.latQ >> 8) & 255;
    smuggled[12] = carrying.latQ & 255;
    const wire = obfuscateMailbox(smuggled, CODE, timeBucketOf(T0));
    // The mac covers bytes 0..12, so the tamper is not merely detected as a
    // wrong position — the frame stops decoding at all.
    expect(decodeBeacon(wire, [CODE], T0, CENTER)).toBeNull();
    // ...and the honest frame's own bytes never contain the quantized pair.
    expect(hex(honest)).not.toContain(
      hex(
        Uint8Array.from([
          (carrying.latQ >> 8) & 255,
          carrying.latQ & 255,
          (carrying.lonQ >> 8) & 255,
          carrying.lonQ & 255,
        ]),
      ),
    );
  });

  test('round-trips as a MAILBOX kind, with member and age, and no coordinates', () => {
    const hit = decodeBeacon(mailboxWire(MY_CARD, T0), [CODE], T0, CENTER);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('mailbox');
    expect(hit!.crewCode).toBe(CODE);
    expect(hit!.memberHash).toBe(hash32(MY_CARD));
    expect(hit!.ageMs).toBe(0);
    expect(Object.keys(hit!).sort()).toEqual([
      'ageMs',
      'crewCode',
      'kind',
      'memberHash',
    ]);
  });

  test('the same guards as the position frame: crew, forgery, replay', () => {
    const wire = mailboxWire(MY_CARD, T0);
    // A crew you do not hold hears nothing.
    expect(decodeBeacon(wire, ['other crew'], T0, CENTER)).toBeNull();
    // Every single-bit flip is rejected by the keyed mac.
    for (let byteAt = 0; byteAt < MAILBOX_LENGTH; byteAt += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        expect(decodeBeacon(flip(wire, byteAt, bit), [CODE], T0, CENTER)).toBeNull();
      }
    }
    // A 25-minute-old capture is outside both the bucket and epoch windows.
    expect(
      decodeBeacon(mailboxWire(MY_CARD, T0 - 25 * 60_000), [CODE], T0, CENTER),
    ).toBeNull();
    // A 5-minute-old one decodes with its OWN age, never as fresh.
    expect(
      decodeBeacon(mailboxWire(MY_CARD, T0 - 5 * 60_000), [CODE], T0, CENTER)!.ageMs,
    ).toBe(5 * 60_000);
  });

  test('the two frames are separately keyed — neither masks the other', () => {
    // Mutation: drop the 'ksm'/'macm' domains and reuse the position
    // frame's keystream — the XOR of the two frames would leak their
    // plaintext difference under one key (the two-time-pad), and the
    // prefixes are the whole defence.
    const b = timeBucketOf(T0);
    expect(keystreamSeed(CODE, b)).not.toBe(keystreamSeed(CODE, b, 'ksm'));
    expect(macKeyOf(CODE, b)).not.toBe(macKeyOf(CODE, b, 'macm'));
    const plain = encodeMailbox(
      buildMailboxPayload(CODE, MY_CARD, T0),
      CODE,
      timeBucketOf(T0),
    );
    // The mailbox masking is involutive, like the position one.
    expect(Array.from(obfuscateMailbox(obfuscateMailbox(plain, CODE, b), CODE, b))).toEqual(
      Array.from(plain),
    );
    // And masking a mailbox frame with the POSITION keystream produces
    // something no decoder accepts.
    expect(decodeBeacon(obfuscate(plain, CODE, b), [CODE], T0, CENTER)).toBeNull();
  });

  test('an older build sees a mailbox frame as nothing at all — never as a false pin', () => {
    // The compatibility half of the length discriminator: a build that
    // predates this frame rejects on length before anything else, which is
    // why a spare-value sentinel inside the 21-byte frame was refused. A
    // wrong pin points a camper into the desert; silence does not.
    const wire = mailboxWire(MY_CARD, T0);
    expect(wire.length).not.toBe(BEACON_LENGTH);
    expect(decodePos(wire, [CODE], T0, CENTER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('forgery resistance (the codex linearity attack)', () => {
  test('EVERY single-bit flip anywhere in the ciphertext is rejected', () => {
    const wire = wireFor(MY_CARD, CENTER, T0);
    for (let byteAt = 0; byteAt < BEACON_LENGTH; byteAt++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(decodePos(flip(wire, byteAt, bit), [CODE], T0, CENTER)).toBeNull();
      }
    }
  });

  test('the old check-patch trick — payload bit + matching check bit — is dead', () => {
    // Against the XOR-linear 1-byte xorCheck this exact pairing kept the
    // check valid and blind-shifted a position WITHOUT the crew code. The
    // keyed nonlinear mac must reject every such pairing.
    const wire = wireFor(MY_CARD, CENTER, T0);
    for (const payloadByte of [11, 12, 13, 14]) {
      for (let bit = 0; bit < 8; bit++) {
        for (let macByte = 17; macByte < 21; macByte++) {
          const mangled = flip(flip(wire, payloadByte, bit), macByte, bit);
          expect(decodePos(mangled, [CODE], T0, CENTER)).toBeNull();
        }
        // ...and the same bit across ALL four mac bytes at once
        let all = flip(wire, payloadByte, bit);
        for (let macByte = 17; macByte < 21; macByte++) {
          all = flip(all, macByte, bit);
        }
        expect(decodePos(all, [CODE], T0, CENTER)).toBeNull();
      }
    }
  });

  test('keystream and mac-key derivations are domain-separated', () => {
    // Same code + bucket must never yield the same word for both roles —
    // if they collided, the XOR mask would cancel against the mac key.
    for (const bucket of [0, 1, timeBucketOf(T0), timeBucketOf(T0) + 1]) {
      expect(keystreamSeed(CODE, bucket)).not.toBe(macKeyOf(CODE, bucket));
    }
  });
});

describe('replay resistance (the epochMin stamp)', () => {
  test('a capture replayed 15 min later decodes with its ORIGINAL age', () => {
    const captured = wireFor(MY_CARD, CENTER, T0 - 15 * 60_000);
    const hit = decodePos(captured, [CODE], T0, CENTER);
    expect(hit).not.toBeNull();
    expect(hit!.ageMs).toBe(15 * 60_000); // stale forever, never "live"
  });

  test('a capture replayed 25 min later is rejected outright', () => {
    const captured = wireFor(MY_CARD, CENTER, T0 - 25 * 60_000);
    expect(decodePos(captured, [CODE], T0, CENTER)).toBeNull();
  });

  test('a stale epoch is rejected even inside a valid current bucket', () => {
    // Isolates the epoch gate from the keystream gate: bytes minted with
    // the CURRENT bucket's keys but a 25-min-old sender stamp.
    const bucket = timeBucketOf(T0);
    const forged = obfuscate(
      encodeBeacon(
        buildPayload(CODE, MY_CARD, CENTER, CENTER, T0 - 25 * 60_000),
        CODE,
        bucket,
      ),
      CODE,
      bucket,
    );
    expect(decodePos(forged, [CODE], T0, CENTER)).toBeNull();
  });

  test('the minute stamp survives its mod-65536 wrap boundary', () => {
    // A receiver whose minute counter sits just past a wrap (nowMin =
    // 65536k + 5) hearing a sender stamped just before it (65534).
    const wrapNow = 29_360_133 * 60_000; // 29_360_133 = 448 * 65536 + 5
    const senderAt = wrapNow - 7 * 60_000;
    expect(epochMinOf(senderAt)).toBe(65534); // proves the wrap is exercised
    const hit = decodePos(wireFor(MY_CARD, CENTER, senderAt), [CODE], wrapNow, CENTER);
    expect(hit).not.toBeNull();
    expect(hit!.ageMs).toBe(7 * 60_000);
  });
});

describe('golden wire vectors (cross-platform codec anchor)', () => {
  // Captured from this reference implementation; a Kotlin/Swift port must
  // reproduce every value byte-for-byte. Payload fields are pinned as
  // integers (not derived from float math) so the vector is FP-proof.
  const BUCKET = 2926666; // timeBucketOf(T0)

  test('key derivations', () => {
    expect(crewHashOf(CODE)).toBe(0x5de82822);
    expect(hash32(MY_CARD)).toBe(0xa7f92c6d);
    expect(keystreamSeed(CODE, BUCKET)).toBe(0xf1f3c163);
    expect(macKeyOf(CODE, BUCKET)).toBe(0xbf2f81ca);
  });

  test('clear and obfuscated bytes', () => {
    const payload = {
      crewHash: 0x5de82822,
      memberHash: 0xa7f92c6d,
      latQ: 278,
      lonQ: -337,
      epochMin: 12345,
    };
    const clear = encodeBeacon(payload, CODE, BUCKET);
    expect(hex(clear)).toBe('5050015de82822a7f92c6d0116feaf30396480a60a');
    expect(hex(obfuscate(clear, CODE, BUCKET))).toBe(
      '3391f2ac17623dc0f87be2ef3b9c98bb8b91619914',
    );
  });
});

// ---------------------------------------------------------------------------

describe('presence store', () => {
  const POS = { lat: CENTER.lat + 0.001, lon: CENTER.lon + 0.002 };

  test('a sighting reads back live within 3 minutes, stale after', () => {
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 });
    const live = presenceFor(MY_CARD, T0 + LIVE_WINDOW_MS - 1000);
    expect(live).not.toBeNull();
    expect(live!.live).toBe(true);
    expect(live!.atMs).toBe(T0);
    expect(presenceFor(MY_CARD, T0 + LIVE_WINDOW_MS + 1000)!.live).toBe(false);
    expect(presenceFor(OTHER_CARD, T0)).toBeNull();
  });

  test('newest heard-time wins; a late older report changes nothing', () => {
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 + 5000 });
    const fired = jest.fn();
    const off = subscribePresenceChanged(fired);
    reportSighting(hash32(MY_CARD), { lat: 0, lon: 0, atMs: T0 });
    expect(fired).not.toHaveBeenCalled();
    expect(presenceFor(MY_CARD, T0 + 5000)!.pos!.lat).toBeCloseTo(POS.lat, 10);
    off();
  });

  test('a position-free hello moves "last heard" and never erases the place', () => {
    // The mailbox frame's effect on the store, directly. Mutation: have
    // reportHeard write a null position over the last one — a podmate who
    // turns sharing off vanishes from the map at the moment they prove they
    // are standing next to you, and the row's own words say "live".
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 });
    reportHeard(hash32(MY_CARD), T0 + 60_000);
    const p = presenceFor(MY_CARD, T0 + 60_000);
    expect(p!.atMs).toBe(T0 + 60_000); // heard just now
    expect(p!.live).toBe(true);
    expect(p!.pos!.lat).toBeCloseTo(POS.lat, 10);
    expect(p!.pos!.atMs).toBe(T0); // ...and the place keeps its OWN age
  });

  test('an older hello never rolls the heard-time back', () => {
    reportHeard(hash32(MY_CARD), T0 + 5000);
    const fired = jest.fn();
    const off = subscribePresenceChanged(fired);
    reportHeard(hash32(MY_CARD), T0);
    expect(fired).not.toHaveBeenCalled();
    expect(presenceFor(MY_CARD, T0 + 5000)!.atMs).toBe(T0 + 5000);
    off();
  });

  test('a place past the TTL falls off while the person stays in reach', () => {
    // Mutation: keep pruning whole entries only — a podmate heard seconds
    // ago carries a 40-minute-old position, which at walking pace is over a
    // mile of "away" the row would state as if it were current.
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 });
    const late = T0 + SIGHTING_TTL_MS + 60_000;
    reportHeard(hash32(MY_CARD), late);
    pruneSightings(late);
    const p = presenceFor(MY_CARD, late);
    expect(p).not.toBeNull();
    expect(p!.live).toBe(true);
    expect(p!.pos).toBeNull();
  });

  test('a report bumps the revision and notifies subscribers', () => {
    const before = presenceRevision();
    const fired = jest.fn();
    const off = subscribePresenceChanged(fired);
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 });
    expect(fired).toHaveBeenCalledTimes(1);
    expect(presenceRevision()).toBeGreaterThan(before);
    off();
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 + 1000 });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  test('prune drops sightings past 30 minutes, keeps younger ones, and only notifies on a drop', () => {
    reportSighting(hash32(MY_CARD), { ...POS, atMs: T0 });
    reportSighting(hash32(OTHER_CARD), { ...POS, atMs: T0 + 5 * 60_000 });
    const fired = jest.fn();
    const off = subscribePresenceChanged(fired);
    pruneSightings(T0 + 60_000); // nothing old enough yet
    expect(fired).not.toHaveBeenCalled();
    pruneSightings(T0 + SIGHTING_TTL_MS + 1000);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(presenceFor(MY_CARD, T0 + SIGHTING_TTL_MS + 1000)).toBeNull();
    expect(presenceFor(OTHER_CARD, T0 + SIGHTING_TTL_MS + 1000)).not.toBeNull();
    off();
  });
});

// ---------------------------------------------------------------------------

describe('sharing session', () => {
  function makeRadio() {
    const calls: string[] = [];
    const ads: Uint8Array[] = [];
    let heard: ((b: Uint8Array) => void) | null = null;
    const radio: CrewRadio = {
      advertise: async b => {
        calls.push('advertise');
        ads.push(b);
      },
      stopAdvertising: async () => {
        calls.push('stopAdvertising');
      },
      startScan: async cb => {
        calls.push('startScan');
        heard = cb;
      },
      stopScan: async () => {
        calls.push('stopScan');
      },
    };
    return { radio, calls, ads, hear: (b: Uint8Array) => heard?.(b) };
  }

  function makeSession(r: ReturnType<typeof makeRadio>) {
    const state = {
      clock: T0,
      pos: { lat: CENTER.lat + 0.001, lon: CENTER.lon } as
        | { lat: number; lon: number }
        | null,
    };
    const session = startCrewSession({
      radio: r.radio,
      shareCrewCode: CODE,
      myCardId: MY_CARD,
      center: CENTER,
      getPosition: () => state.pos,
      knownCrewCodes: () => [CODE],
      now: () => state.clock,
    });
    return { session, state };
  }

  test('advertises on start and again on each refresh, with the current fix', async () => {
    const r = makeRadio();
    const { session, state } = makeSession(r);
    expect(sessionActive()).toBe(true); // flips synchronously for the UI
    await session.started;
    expect(r.calls).toEqual(['startScan', 'advertise']);
    const first = decodePos(r.ads[0], [CODE], state.clock, CENTER);
    expect(first!.memberHash).toBe(hash32(MY_CARD));
    expect(errorMeters(first!, state.pos!)).toBeLessThan(3);

    state.pos = { lat: CENTER.lat - 0.002, lon: CENTER.lon + 0.003 };
    state.clock += 45_000;
    await session.refresh();
    const second = decodePos(r.ads[1], [CODE], state.clock, CENTER);
    expect(errorMeters(second!, state.pos)).toBeLessThan(3);
    await session.stop();
  });

  test('with no fix it drops to the MAILBOX frame — no stale air, and no silence either', async () => {
    // This pin used to read "goes (and stays) silent", and the silence was
    // the bug underneath the field report: a phone waiting for a fix stopped
    // being a mailbox too, so pod mail stopped moving for a reason that has
    // nothing to do with mail. Stale air is still forbidden — what goes out
    // is the frame that CANNOT carry a position.
    // Mutation: go back to stopAdvertising on no-fix — the last assertion
    // (mail still moving) dies.
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    state.pos = null;
    await session.refresh();
    await session.refresh();
    expect(r.calls).toEqual(['startScan', 'advertise', 'advertise', 'advertise']);
    for (const wire of r.ads.slice(1)) {
      expect(wire.length).toBe(MAILBOX_LENGTH);
      expect(decodePos(wire, [CODE], state.clock, CENTER)).toBeNull();
      expect(decodeBeacon(wire, [CODE], state.clock, CENTER)!.kind).toBe('mailbox');
    }
    state.pos = { lat: CENTER.lat, lon: CENTER.lon + 0.001 };
    await session.refresh(); // fix back -> the place goes back on the air
    expect(r.ads[r.ads.length - 1].length).toBe(BEACON_LENGTH);
    await session.stop();
  });

  test('before a first fix exists it is a mailbox, never a position', async () => {
    const r = makeRadio();
    const s = startCrewSession({
      radio: r.radio,
      shareCrewCode: CODE,
      myCardId: MY_CARD,
      center: CENTER,
      getPosition: () => null,
      knownCrewCodes: () => [CODE],
      now: () => T0,
    });
    await s.started;
    expect(r.calls).toEqual(['startScan', 'advertise']);
    expect(r.ads[0].length).toBe(MAILBOX_LENGTH);
    await s.stop();
  });

  test('MAILBOX POSTURE never reads the position, whatever the phone knows', async () => {
    // THE PRIVACY PIN. The session is started position-free while a live,
    // real fix is available — the fix a sharing session would broadcast.
    // Mutation: have refresh() build a position frame in mailbox posture
    // (or pass the fix into buildMailboxPayload — which does not compile,
    // which is the point) and both halves below die: the frame grows to 21
    // bytes and the getter is touched.
    const r = makeRadio();
    const secret = { lat: CENTER.lat + 0.004, lon: CENTER.lon - 0.006 };
    let asked = 0;
    const s = startCrewSession({
      radio: r.radio,
      shareCrewCode: null,
      myCardId: MY_CARD,
      center: CENTER,
      getPosition: () => {
        asked += 1;
        return secret;
      },
      knownCrewCodes: () => [CODE],
      now: () => T0,
    });
    await s.started;
    await s.refresh();
    expect(asked).toBe(0); // the GPS is never even consulted
    expect(r.ads).toHaveLength(2);
    for (const wire of r.ads) {
      expect(wire.length).toBe(MAILBOX_LENGTH);
      const hit = decodeBeacon(wire, [CODE], T0, CENTER);
      expect(hit).not.toBeNull();
      expect(hit!.kind).toBe('mailbox');
      expect(hit!.memberHash).toBe(hash32(MY_CARD));
      // And no run of bytes anywhere in the frame decodes as the position
      // frame, under this crew's code, in either live bucket.
      expect(decodePos(wire, [CODE], T0, CENTER)).toBeNull();
    }
    await s.stop();
  });

  test('mailbox posture takes every pod in turn — a second pod is never starved', async () => {
    // Mutation: advertise codes[0] every tick — pod B never hears this
    // phone, so its mail never moves, silently.
    const r = makeRadio();
    const s = startCrewSession({
      radio: r.radio,
      shareCrewCode: null,
      myCardId: MY_CARD,
      center: CENTER,
      getPosition: () => null,
      knownCrewCodes: () => [CODE, 'other crew'],
      now: () => T0,
    });
    await s.started;
    await s.refresh();
    const kinds = r.ads.map(w => {
      const a = decodeBeacon(w, [CODE], T0, CENTER);
      const b = decodeBeacon(w, ['other crew'], T0, CENTER);
      return a ? 'A' : b ? 'B' : '?';
    });
    expect(kinds).toEqual(['A', 'B']);
    await s.stop();
  });

  test('a sharing session that turns sharing OFF stays on the air, position-free', async () => {
    // THE ROOT FIX, at the session seam. Mutation: make setShareCrew(null)
    // stop the radio (the old shape) — the advert count stops growing and
    // the last frame is a position one.
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    expect(r.ads[0].length).toBe(BEACON_LENGTH);

    await session.setShareCrew(null);
    expect(r.calls).toEqual(['startScan', 'advertise', 'advertise']);
    expect(r.ads[1].length).toBe(MAILBOX_LENGTH);
    expect(r.calls).not.toContain('stopAdvertising');
    expect(r.calls).not.toContain('stopScan');

    // ...and back on layers the place onto the same session.
    await session.setShareCrew(CODE);
    expect(r.ads[2].length).toBe(BEACON_LENGTH);
    expect(errorMeters(decodePos(r.ads[2], [CODE], state.clock, CENTER)!, state.pos!)).toBeLessThan(3);
    await session.stop();
  });

  test('a heard MAILBOX beacon is reach without a place', async () => {
    // Mutation: route mailbox frames through reportSighting — a pin appears
    // for someone who never broadcast one (and, at the center, ON THE MAN).
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    const t = state.clock;
    r.hear(
      obfuscateMailbox(
        encodeMailbox(
          buildMailboxPayload(CODE, OTHER_CARD, t),
          CODE,
          timeBucketOf(t),
        ),
        CODE,
        timeBucketOf(t),
      ),
    );
    const p = presenceFor(OTHER_CARD, t);
    expect(p).not.toBeNull();
    expect(p!.live).toBe(true); // in reach: messages get through now
    expect(p!.atMs).toBe(t);
    expect(p!.pos).toBeNull(); // and nowhere on the map
    await session.stop();
  });

  test('a heard beacon flows into presence for the sender card', async () => {
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    const theirPos = { lat: CENTER.lat + 0.004, lon: CENTER.lon - 0.006 };
    r.hear(wireFor(OTHER_CARD, theirPos, state.clock));
    const p = presenceFor(OTHER_CARD, state.clock);
    expect(p).not.toBeNull();
    expect(p!.live).toBe(true);
    expect(p!.atMs).toBe(state.clock);
    expect(errorMeters(p!.pos!, theirPos)).toBeLessThan(3);
    // noise and wrong-crew beacons never land
    r.hear(Uint8Array.from({ length: BEACON_LENGTH }, (_, i) => i * 7));
    r.hear(wireFor('cccc3333', theirPos, state.clock, 'some other crew'));
    expect(presenceFor('cccc3333', state.clock)).toBeNull();
    await session.stop();
  });

  test('an old-but-valid beacon is stamped with SENDER time, so it is never live', async () => {
    // The replay fix end-to-end: a 5-min-old capture decodes, but presence
    // records heardAt - ageMs, so the row shows honestly stale.
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    const theirPos = { lat: CENTER.lat + 0.002, lon: CENTER.lon + 0.002 };
    r.hear(wireFor(OTHER_CARD, theirPos, state.clock - 5 * 60_000));
    const p = presenceFor(OTHER_CARD, state.clock);
    expect(p).not.toBeNull();
    expect(p!.atMs).toBe(state.clock - 5 * 60_000);
    expect(p!.live).toBe(false);
    await session.stop();
  });

  test('our own beacon looping back never becomes a presence row', async () => {
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    r.hear(r.ads[0]);
    expect(presenceFor(MY_CARD, state.clock)).toBeNull();
    await session.stop();
  });

  test('masterOff kills the active session and flips sessionActive', async () => {
    const r = makeRadio();
    const { session } = makeSession(r);
    await session.started;
    const before = sessionRevision();
    const fired = jest.fn();
    const off = subscribeSessionChanged(fired);
    expect(sessionActive()).toBe(true);
    await masterOff();
    expect(sessionActive()).toBe(false);
    expect(sessionRevision()).toBeGreaterThan(before);
    expect(fired).toHaveBeenCalled();
    expect(r.calls).toContain('stopAdvertising');
    expect(r.calls).toContain('stopScan');
    off();
  });

  test('stop is idempotent and a straggler refresh after stop is a no-op', async () => {
    const r = makeRadio();
    const { session } = makeSession(r);
    await session.started;
    await Promise.all([session.stop(), session.stop()]);
    await session.stop();
    expect(r.calls.filter(c => c === 'stopScan')).toHaveLength(1);
    const callsAfterStop = r.calls.length;
    await session.refresh(); // the caller's tick may fire once more; must not touch the radio
    expect(r.calls).toHaveLength(callsAfterStop);
  });

  test('starting a second session tears the first down before its radio comes up', async () => {
    const rA = makeRadio();
    const { session: a } = makeSession(rA);
    await a.started;
    const rB = makeRadio();
    const b = startCrewSession({
      radio: rB.radio,
      shareCrewCode: 'other crew',
      myCardId: MY_CARD,
      center: CENTER,
      getPosition: () => ({ lat: CENTER.lat, lon: CENTER.lon }),
      knownCrewCodes: () => ['other crew'],
      now: () => T0,
    });
    await b.started;
    expect(rA.calls).toContain('stopScan'); // A fully torn down
    expect(sessionActive()).toBe(true); // ...and B is the one live session
    await b.stop();
    expect(sessionActive()).toBe(false);
  });
});
