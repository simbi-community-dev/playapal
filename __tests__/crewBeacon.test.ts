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
  buildPayload,
  crewHashOf,
  decodeBeacon,
  deobfuscate,
  encodeBeacon,
  epochMinOf,
  hash32,
  keystreamSeed,
  macKeyOf,
  obfuscate,
  timeBucketOf,
} from '../src/crews/beacon';
import {
  LIVE_WINDOW_MS,
  presenceFor,
  presenceRevision,
  pruneSightings,
  reportSighting,
  SIGHTING_TTL_MS,
  subscribePresenceChanged,
} from '../src/crews/presence';
import {
  CrewRadio,
  masterOff,
  sessionActive,
  sessionRevision,
  startSharing,
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
    const hit = decodeBeacon(wireFor(MY_CARD, pos, T0), [CODE], T0, CENTER);
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
      const hit = decodeBeacon(wireFor(MY_CARD, pos, T0), [CODE], T0, CENTER);
      expect(hit).not.toBeNull();
      expect(errorMeters(hit!, pos)).toBeLessThan(3);
    }
  });

  test('a crew code you do not hold decodes to nothing', () => {
    const wire = wireFor(MY_CARD, CENTER, T0);
    expect(decodeBeacon(wire, ['other crew'], T0, CENTER)).toBeNull();
    expect(decodeBeacon(wire, [], T0, CENTER)).toBeNull();
    // wrong length is not even tried
    expect(decodeBeacon(wire.slice(0, BEACON_LENGTH - 1), [CODE], T0, CENTER)).toBeNull();
  });

  test('crew codes are normalized: case and padding never split a crew', () => {
    const wire = wireFor(MY_CARD, CENTER, T0, 'dusty llamas');
    const hit = decodeBeacon(wire, ['  DUSTY Llamas '], T0, CENTER);
    expect(hit).not.toBeNull();
    // the caller's own spelling comes back verbatim, for keying its records
    expect(hit!.crewCode).toBe('  DUSTY Llamas ');
  });

  test('previous time bucket still decodes; two buckets old does not', () => {
    const wire = wireFor(MY_CARD, CENTER, T0);
    expect(decodeBeacon(wire, [CODE], T0, CENTER)).not.toBeNull();
    const nextBucket = decodeBeacon(wire, [CODE], T0 + 600_000, CENTER);
    expect(nextBucket).not.toBeNull();
    expect(nextBucket!.ageMs).toBe(600_000); // the epoch stamp keeps age honest
    expect(decodeBeacon(wire, [CODE], T0 + 1_200_000, CENTER)).toBeNull();
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
    const hit = decodeBeacon(wireFor(MY_CARD, far, T0), [CODE], T0, CENTER);
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

describe('forgery resistance (the codex linearity attack)', () => {
  test('EVERY single-bit flip anywhere in the ciphertext is rejected', () => {
    const wire = wireFor(MY_CARD, CENTER, T0);
    for (let byteAt = 0; byteAt < BEACON_LENGTH; byteAt++) {
      for (let bit = 0; bit < 8; bit++) {
        expect(decodeBeacon(flip(wire, byteAt, bit), [CODE], T0, CENTER)).toBeNull();
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
          expect(decodeBeacon(mangled, [CODE], T0, CENTER)).toBeNull();
        }
        // ...and the same bit across ALL four mac bytes at once
        let all = flip(wire, payloadByte, bit);
        for (let macByte = 17; macByte < 21; macByte++) {
          all = flip(all, macByte, bit);
        }
        expect(decodeBeacon(all, [CODE], T0, CENTER)).toBeNull();
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
    const hit = decodeBeacon(captured, [CODE], T0, CENTER);
    expect(hit).not.toBeNull();
    expect(hit!.ageMs).toBe(15 * 60_000); // stale forever, never "live"
  });

  test('a capture replayed 25 min later is rejected outright', () => {
    const captured = wireFor(MY_CARD, CENTER, T0 - 25 * 60_000);
    expect(decodeBeacon(captured, [CODE], T0, CENTER)).toBeNull();
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
    expect(decodeBeacon(forged, [CODE], T0, CENTER)).toBeNull();
  });

  test('the minute stamp survives its mod-65536 wrap boundary', () => {
    // A receiver whose minute counter sits just past a wrap (nowMin =
    // 65536k + 5) hearing a sender stamped just before it (65534).
    const wrapNow = 29_360_133 * 60_000; // 29_360_133 = 448 * 65536 + 5
    const senderAt = wrapNow - 7 * 60_000;
    expect(epochMinOf(senderAt)).toBe(65534); // proves the wrap is exercised
    const hit = decodeBeacon(wireFor(MY_CARD, CENTER, senderAt), [CODE], wrapNow, CENTER);
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
    expect(presenceFor(MY_CARD, T0 + 5000)!.lat).toBeCloseTo(POS.lat, 10);
    off();
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
    const session = startSharing({
      radio: r.radio,
      crewCode: CODE,
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
    const first = decodeBeacon(r.ads[0], [CODE], state.clock, CENTER);
    expect(first!.memberHash).toBe(hash32(MY_CARD));
    expect(errorMeters(first!, state.pos!)).toBeLessThan(3);

    state.pos = { lat: CENTER.lat - 0.002, lon: CENTER.lon + 0.003 };
    state.clock += 45_000;
    await session.refresh();
    const second = decodeBeacon(r.ads[1], [CODE], state.clock, CENTER);
    expect(errorMeters(second!, state.pos)).toBeLessThan(3);
    await session.stop();
  });

  test('with no fix it goes (and stays) silent instead of advertising stale air', async () => {
    const r = makeRadio();
    const { session, state } = makeSession(r);
    await session.started;
    state.pos = null;
    await session.refresh();
    await session.refresh(); // second null tick must not stack another stop
    expect(r.calls).toEqual(['startScan', 'advertise', 'stopAdvertising']);
    state.pos = { lat: CENTER.lat, lon: CENTER.lon + 0.001 };
    await session.refresh(); // fix back -> back on the air
    expect(r.calls[r.calls.length - 1]).toBe('advertise');
    await session.stop();
  });

  test('never advertises before a first fix exists', async () => {
    const r = makeRadio();
    const s = startSharing({
      radio: r.radio,
      crewCode: CODE,
      myCardId: MY_CARD,
      center: CENTER,
      getPosition: () => null,
      knownCrewCodes: () => [CODE],
      now: () => T0,
    });
    await s.started;
    expect(r.calls).toEqual(['startScan']); // no advertise, no stopAdvertising
    await s.stop();
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
    expect(errorMeters(p!, theirPos)).toBeLessThan(3);
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
    const b = startSharing({
      radio: rB.radio,
      crewCode: 'other crew',
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
