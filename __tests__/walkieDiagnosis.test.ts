/**
 * Walkie silence diagnosis (src/crews/walkie.ts) — field test #8, measured
 * on two real phones: both showed one Wi-Fi name, but one sat on
 * 192.168.1.x and the other on 192.168.86.x — two routers sharing an SSID.
 * mDNS does not cross a subnet and UDP unicast does not route between
 * them, so the walkie genuinely could not work, and the app's only word
 * was "Nobody else on the channel yet".
 *
 * What this file pins:
 *  - subnetLabel: the comparable network half of an IP, byte-granular,
 *    /24 assumed when the prefix is unknown,
 *  - diagnoseChannel: no Wi-Fi beats everything; Wi-Fi + a BLE-near
 *    podmate = the split-network call; Wi-Fi alone = the quiet subnet
 *    line — including the measured two-router pair producing two labels
 *    a person can compare across screens,
 *  - the copy: the split message carries our subnet and treats only a
 *    MISMATCH as conclusive (two routers can both hand out 192.168.1.x),
 *  - podmateNearbyByBluetooth: reads picked ∪ announced members, excludes
 *    me, honors the presence live window, and a store error reads as
 *    "nobody known near" rather than a crash.
 *
 * Harness: crew.test.tsx's settings-map db mock, with the crew_messages
 * kind query served from an array so an announced-only podmate exists.
 */

const mockSettings = new Map<string, string>();
const mockRecords: any[] = [];
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
  getDb: () => ({
    execute: (sql: string, params: unknown[] = []) => {
      const rows =
        /FROM crew_messages/.test(sql) && /kind = \?/.test(sql)
          ? mockRecords.filter(r => r.kind === params[params.length - 1])
          : [];
      return {
        rows: {
          _array: rows,
          length: rows.length,
          item: (i: number) => rows[i],
        },
      };
    },
  }),
}));

import { hash32 } from '../src/crews/beacon';
import { joinCrew, saveCrew } from '../src/crews/crew';
import { encodeMemberBody } from '../src/crews/podMembers';
import {
  LIVE_WINDOW_MS,
  SIGHTING_TTL_MS,
  pruneSightings,
  reportSighting,
} from '../src/crews/presence';
import {
  VOICE_NOTE_ROUTE,
  VOICE_NOTE_ROUTE_KEEPS,
  diagnoseChannel,
  podmateNearbyByBluetooth,
  subnetLabel,
  walkieDiagnosisCopy,
  type WalkieNet,
} from '../src/crews/walkie';

const wifi = (ip: string, prefix: number | null = 24): WalkieNet => ({
  wifi: true,
  ip,
  prefix,
});
const NO_WIFI: WalkieNet = { wifi: false, ip: null, prefix: null };

beforeEach(() => {
  mockSettings.clear();
  mockRecords.length = 0;
});

describe('subnetLabel', () => {
  it('masks the host byte at /24', () => {
    expect(subnetLabel('192.168.1.216', 24)).toBe('192.168.1.x');
    expect(subnetLabel('192.168.86.127', 24)).toBe('192.168.86.x');
  });

  it('assumes /24 when the prefix is unknown', () => {
    expect(subnetLabel('10.0.5.7', null)).toBe('10.0.5.x');
  });

  it('is byte-granular for other prefixes', () => {
    expect(subnetLabel('172.16.9.3', 16)).toBe('172.16.x.x');
    // A /25 renders as a /24 would — accurate enough for eyes.
    expect(subnetLabel('192.168.1.9', 25)).toBe('192.168.1.x');
  });

  it('returns a non-IPv4 string untouched rather than lying about it', () => {
    expect(subnetLabel('fe80::1', 64)).toBe('fe80::1');
  });
});

describe('diagnoseChannel', () => {
  it('calls no Wi-Fi before anything else, podmate near or not', () => {
    expect(diagnoseChannel(NO_WIFI, false)).toEqual({ kind: 'no-wifi' });
    expect(diagnoseChannel(NO_WIFI, true)).toEqual({ kind: 'no-wifi' });
  });

  it('the measured two-router pair: each phone names its own subnet', () => {
    // Field test #8, verbatim numbers: same network name, two routers.
    const p7 = diagnoseChannel(wifi('192.168.1.216'), true);
    const p9 = diagnoseChannel(wifi('192.168.86.127'), true);
    expect(p7).toEqual({ kind: 'split-network', subnet: '192.168.1.x' });
    expect(p9).toEqual({ kind: 'split-network', subnet: '192.168.86.x' });
    // Two screens, two different labels — the comparison IS the fix.
    expect((p7 as any).subnet).not.toBe((p9 as any).subnet);
  });

  it('Wi-Fi up with nobody known near is the quiet subnet line', () => {
    expect(diagnoseChannel(wifi('192.168.1.216'), false)).toEqual({
      kind: 'alone',
      subnet: '192.168.1.x',
    });
  });
});

describe('walkieDiagnosisCopy', () => {
  it('the split message carries our subnet so screens can be compared', () => {
    const copy = walkieDiagnosisCopy({
      kind: 'split-network',
      subnet: '192.168.1.x',
    });
    expect(copy).toContain('192.168.1.x');
    expect(copy).toContain('two routers');
    // Only a MISMATCH is conclusive — matching labels can still hide two
    // routers, so the copy must condition on "a different number".
    expect(copy).toContain('different');
  });

  it('no Wi-Fi says the walkie needs it, actionably', () => {
    const copy = walkieDiagnosisCopy({ kind: 'no-wifi' });
    expect(copy).toContain('Wi-Fi');
    expect(copy).toContain('join the same Wi-Fi');
  });

  it('the alone line states the subnet as a necessity, not a promise', () => {
    const copy = walkieDiagnosisCopy({ kind: 'alone', subnet: '10.0.5.x' });
    expect(copy).toContain('10.0.5.x');
    expect(copy).toContain('same number');
  });

  // Every state that means "no live talk" has to name the thing that still
  // works, or the panel is a dead end. 'alone' was the one that did not —
  // found by a field sweep, and it is the state a camper is in MOST of the
  // week, standing at their own camp with nobody in range.
  it('every no-live-talk state routes to the voice note', () => {
    const states = [
      { kind: 'no-wifi' as const },
      { kind: 'split-network' as const, subnet: '192.168.1.x' },
      { kind: 'alone' as const, subnet: '192.168.1.x' },
    ];
    for (const s of states) {
      expect(walkieDiagnosisCopy(s)).toContain('voice note');
    }
  });

  // THE TENSE IS THE ASSERTION, and this test exists because reusing the
  // one sentence everywhere is the obvious, wrong, tidy-looking fix.
  // "Reaches them" is a DELIVERY promise, earned only where a podmate is
  // provably in Bluetooth range. Alone, nobody is known near: the note is
  // held and gossiped later. A camper who reads "reaches them", walks away
  // and is not heard from has been lied to by a helpful-sounding sentence.
  it('the alone route promises keeping, not delivery', () => {
    const copy = walkieDiagnosisCopy({ kind: 'alone', subnet: '10.0.5.x' });
    expect(copy).toContain(VOICE_NOTE_ROUTE_KEEPS);
    expect(copy).not.toContain(VOICE_NOTE_ROUTE);
    expect(copy).not.toContain('reaches them');

    // ...and the states that HAVE the evidence still make the strong
    // promise, so a future tidy-up cannot flatten both into the weak one.
    const split = walkieDiagnosisCopy({
      kind: 'split-network',
      subnet: '192.168.1.x',
    });
    expect(split).toContain(VOICE_NOTE_ROUTE);
  });
});

describe('podmateNearbyByBluetooth', () => {
  const NOW = 1_700_000_000_000;

  // THE SIGHTING STORE OUTLIVES A TEST. src/crews/presence.ts keeps its
  // sightings in a module-level Map on purpose (ephemeral, no db, gone on
  // app restart) — and it exports no clear/reset, because on a phone there
  // is nothing to clear. So every sighting a case below plants was still
  // in the store for the next one, and this block was quietly relying on
  // its own running order: the cases happen to use a different pod code
  // and different card ids each time, which is the only reason nothing
  // went green for the wrong reason.
  //
  // pruneSightings IS the shipped eviction path (the session cadence runs
  // it beside each refresh), so winding the clock one TTL past the newest
  // fixture empties the store through the module's own door — no
  // re-require dance, no reaching into another file's private state.
  beforeEach(() => {
    pruneSightings(NOW + SIGHTING_TTL_MS + 1);
  });

  it('false with no crew, no sightings', () => {
    expect(podmateNearbyByBluetooth('4207', 'card-me', NOW)).toBe(false);
  });

  it('true when a picked member has a live sighting', () => {
    const crew = joinCrew('4207');
    saveCrew({ ...crew, memberIds: ['card-b'] });
    reportSighting(hash32('card-b'), { lat: 40.78, lon: -119.2, atMs: NOW });
    expect(podmateNearbyByBluetooth('4207', 'card-me', NOW)).toBe(true);
  });

  it('my own sighting never counts as a podmate', () => {
    const crew = joinCrew('5511');
    saveCrew({ ...crew, memberIds: ['card-me'] });
    reportSighting(hash32('card-me'), { lat: 40.78, lon: -119.2, atMs: NOW });
    expect(podmateNearbyByBluetooth('5511', 'card-me', NOW)).toBe(false);
  });

  it('an announced-only podmate counts — no card needed on this phone', () => {
    joinCrew('6303');
    mockRecords.push({
      id: 'card-c-hello',
      crew_code: '6303',
      from_hash: hash32('card-c'),
      to_hash: null,
      kind: 'pod-member',
      body: encodeMemberBody({ cardId: 'card-c', name: 'Podmate C' }),
      mime: '',
      created_min: Math.floor(NOW / 60000),
      expires_min: Math.floor(NOW / 60000) + 10080,
      hops: 1,
      origin: 'heard',
      read_at: null,
    });
    reportSighting(hash32('card-c'), { lat: 40.78, lon: -119.2, atMs: NOW });
    expect(podmateNearbyByBluetooth('6303', 'card-me', NOW)).toBe(true);
  });

  it('a sighting past the live window reads as not near', () => {
    const crew = joinCrew('7777');
    saveCrew({ ...crew, memberIds: ['card-d'] });
    reportSighting(hash32('card-d'), {
      lat: 40.78,
      lon: -119.2,
      atMs: NOW - LIVE_WINDOW_MS - 1,
    });
    expect(podmateNearbyByBluetooth('7777', 'card-me', NOW)).toBe(false);
  });
});
