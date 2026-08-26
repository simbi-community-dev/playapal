/**
 * The delivery clock, held to the owner's bar (field report 2026-08-25):
 * app open on both phones + Bluetooth on + phones adjacent => a pod
 * message arrives within seconds, not at the next cooldown boundary.
 *
 * Sync is PULL-ONLY (syncLink.ts), so the sender's compose cannot push;
 * what meets the bar is the trio under test here:
 *
 *  - a local COMPOSE nudges a dial at everyone on the air (sender side);
 *  - a served digest (CrewSyncServed) nudges the reciprocal dial back
 *    (receiver side — this is the hop that actually moves the new mail);
 *  - the FOREGROUND posture shortens the ambient cooldown, and hands the
 *    frugal clocks back the moment the app backgrounds (the battery half
 *    of the bargain, asserted as hard as the fast half).
 *
 * Same injected-everything harness as meshSyncFreshness.test.ts. Each
 * assertion names the mutation it dies on.
 */

let mockSighting: ((s: { peerId: string; via?: string }) => void) | undefined;
let mockServed: ((s: { peerId: string }) => void) | undefined;
let mockCompose: (() => void) | undefined;
const mockPostures: boolean[] = [];
let mockAppStateHandler: ((st: string) => void) | undefined;
let mockAppStateCurrent = 'active';

jest.mock('react-native', () => ({
  NativeModules: {
    CrewBeacon: {
      setSyncDigest: jest.fn(async () => undefined),
      provideSyncMessages: jest.fn(async () => undefined),
      syncWithPeer: jest.fn(async () => ({ digest: '', messages: '' })),
    },
  },
  AppState: {
    get currentState() {
      return mockAppStateCurrent;
    },
    addEventListener: (_: string, cb: (st: string) => void) => {
      mockAppStateHandler = cb;
      return {
        remove: () => {
          mockAppStateHandler = undefined;
        },
      };
    },
  },
}));

jest.mock('../src/crews/radio', () => ({
  onSighting: (cb: (s: { peerId: string; via?: string }) => void) => {
    mockSighting = cb;
    return () => {
      mockSighting = undefined;
    };
  },
  onSyncServed: (cb: (s: { peerId: string }) => void) => {
    mockServed = cb;
    return () => {
      mockServed = undefined;
    };
  },
  onSyncWant: () => () => undefined,
  setScanPosture: async (lowLatency: boolean) => {
    mockPostures.push(lowLatency);
  },
  b64ToBytes: () => new Uint8Array(),
  bytesToB64: () => '',
}));

jest.mock('../src/crews/messages', () => ({
  messagesRevision: () => 0,
  subscribeMessagesChanged: () => () => undefined,
  subscribeLocalCompose: (cb: () => void) => {
    mockCompose = cb;
    return () => {
      mockCompose = undefined;
    };
  },
  epochMinutes: (ms: number) => Math.floor(ms / 60000),
}));

jest.mock('../src/crews/syncLink', () => ({
  serveDigest: () => new Uint8Array(),
  serveMessages: () => new Uint8Array(),
  syncWithPeer: jest.fn(async () => ({ accepted: 0 })),
}));

import { syncWithPeer as linkSync } from '../src/crews/syncLink';
import {
  checkPodUpdates,
  lastPodSyncMs,
  startMeshSync,
  stopMeshSync,
} from '../src/crews/meshSync';

const CODES = () => ['amber-lantern-31'];
const PEER = 'AA:BB:CC:DD:EE:01';

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

const dials = () => (linkSync as jest.Mock).mock.calls.length;

let now = 1_756_000_000_000;

beforeEach(() => {
  now = 1_756_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  // [mesh] lines are for phones, not for test output.
  jest.spyOn(console, 'log').mockImplementation(() => {});
  (linkSync as jest.Mock).mockReset();
  (linkSync as jest.Mock).mockImplementation(async () => ({ accepted: 0 }));
  mockPostures.length = 0;
  mockAppStateCurrent = 'active';
  startMeshSync(CODES);
});

afterEach(() => {
  stopMeshSync();
  jest.restoreAllMocks();
});

describe('a local compose dials NOW, not at the next cooldown boundary', () => {
  it('nudges a fresh-sighted peer straight through the cooldown', async () => {
    // Mutation: drop the subscribeLocalCompose wiring (or make the nudge
    // respect the cooldown) — the second dial vanishes and the sender is
    // back to waiting out the clock the owner reported.
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);

    now += 6_000; // inside the foreground cooldown, past the nudge floor
    mockSighting!({ peerId: PEER, via: 'adv' }); // suppressed by cooldown
    await flush();
    expect(dials()).toBe(1);

    mockCompose!();
    await flush();
    expect(dials()).toBe(2);
  });

  it('never re-dials someone synced seconds ago (the nudge floor)', async () => {
    // Mutation: drop NUDGE_MIN_GAP_MS — a burst of composes becomes a
    // burst of connects at one phone.
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    now += 2_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    mockCompose!();
    await flush();
    expect(dials()).toBe(1);
  });
});

describe('a peer that pulled from us is pulled back — reciprocity', () => {
  it('a served digest triggers the dial-back inside the cooldown', async () => {
    // Mutation: drop the onSyncServed wiring — the receiver keeps its own
    // cooldown clock and the sender's fresh message waits it out; this is
    // the hop that actually meets the seconds bar.
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);

    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    mockServed!({ peerId: 'F0:0F:00:00:00:99' }); // their central-side name
    await flush();
    expect(dials()).toBe(2);
  });

  it('reciprocity cannot ping-pong: the fresh stamp stops the chain', async () => {
    // Mutation: bypass the nudge floor for served events — two idle phones
    // dial each other in a tight loop forever.
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    mockServed!({ peerId: 'F0:0F:00:00:00:99' });
    await flush();
    expect(dials()).toBe(2);

    // Our dial just landed; their server's served event answers back at
    // once. The stamp we just wrote is seconds old: no third dial.
    mockServed!({ peerId: 'F0:0F:00:00:00:99' });
    await flush();
    expect(dials()).toBe(2);
  });
});

describe('the posture bargain: fast while watched, frugal when pocketed', () => {
  it('foreground re-syncs on the short clock; background restores the long one', async () => {
    // Mutation: make cooldownMs() ignore the posture — either the
    // background battery promise or the foreground bar breaks, and this
    // test dies on whichever direction the mutation picked.
    mockAppStateHandler!('background');
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);

    now += 20_000; // over the 15 s foreground clock, under the 60 s one
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1); // background: still cooling down

    mockAppStateHandler!('active');
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(2); // foreground: 20 s is past the short clock
  });

  it('a compose while backgrounded does not nudge the radio', async () => {
    // Mutation: drop the foreground gate on the compose nudge — a
    // background write (a future scheduled record) burns pocket battery.
    mockAppStateHandler!('background');
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    mockCompose!();
    await flush();
    expect(dials()).toBe(1);
  });

  it('the scan duty cycle follows the posture, and stop() hands back frugal', async () => {
    // Mutation: never call setScanPosture (or skip the reverse arc) — the
    // LOW_LATENCY scan outlives the session that justified it.
    expect(mockPostures).toEqual([true]); // start under an active app
    mockAppStateHandler!('background');
    expect(mockPostures).toEqual([true, false]);
    mockAppStateHandler!('active');
    expect(mockPostures).toEqual([true, false, true]);
    stopMeshSync();
    expect(mockPostures).toEqual([true, false, true, false]);
  });
});

describe('the manual check reports what actually happened', () => {
  it('nobody on the air: says so without dialling anything', async () => {
    // Mutation: fake a result (or dial stale names) — the "never a fake
    // spinner" rule broken at the source.
    const r = await checkPodUpdates();
    expect(r).toEqual({ inRange: 0, moved: 0 });
    expect(dials()).toBe(0);
  });

  it('a peer in range is re-synced past the cooldown and the moved count is real', async () => {
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(dials()).toBe(1);

    now += 6_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    (linkSync as jest.Mock).mockImplementation(async () => ({ accepted: 2 }));
    const r = await checkPodUpdates();
    expect(dials()).toBe(2);
    expect(r.inRange).toBe(1);
    expect(r.moved).toBe(2);
  });

  it('a peer synced seconds ago counts as in range but is not re-dialled', async () => {
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    now += 2_000;
    mockSighting!({ peerId: PEER, via: 'adv' });
    const r = await checkPodUpdates();
    expect(dials()).toBe(1);
    expect(r.inRange).toBe(1);
    expect(r.moved).toBe(0);
  });
});

/**
 * THE LAYER UNDERNEATH (delivery-clock lane, 2026-08-25). Everything above
 * this point is JS deciding when to dial — and it was all sitting under a
 * flat 30-second NATIVE floor. For a peer whose payload rides a
 * characteristic (every iOS peer, and any Android record the stack strips),
 * the GATT read IS the sighting, and a nudge can only dial an address it has
 * SEEN: 27.4 seconds to deliver between two adjacent phones is that floor
 * being waited out, not the JS clock the previous suite pins.
 *
 * Source assertions, in the shareApp.test.ts idiom — this repo has no Kotlin
 * test runner, and the alternative is a constant that drifts away from the
 * JS one it is supposed to agree with, silently, exactly like last time.
 */
describe('the native floor agrees with the JS one', () => {
  const readSource = (p: string): string =>
    require('fs').readFileSync(p, 'utf8') as string;
  const KT = 'android/app/src/main/java/com/playapal/CrewBeaconModule.kt';
  const MESH = 'src/crews/meshSync.ts';

  test('foreground re-reads at the SAME floor the JS nudge holds', () => {
    // Mutation: change either number without the other — the layers hold
    // two opinions about "how often may one peer be dialled", and the
    // stricter one silently wins, which is how 27.4 s happened.
    const kt = readSource(KT);
    const fg = /GATT_COOLDOWN_FOREGROUND_MS = (\d[\d_]*)L/.exec(kt)?.[1];
    const js = /NUDGE_MIN_GAP_MS = (\d[\d_]*)/.exec(readSource(MESH))?.[1];
    expect(fg).toBeDefined();
    expect(js).toBeDefined();
    expect(Number((fg as string).replace(/_/g, ''))).toBe(
      Number((js as string).replace(/_/g, '')),
    );
  });

  test('there IS still a floor, and the background one stays frugal', () => {
    // Mutation: drop the floor to 0 (or delete the cooldown check) — a
    // dense camp becomes a GATT storm from this phone, which is the whole
    // reason the constant exists.
    const kt = readSource(KT);
    const fg = Number(
      (/GATT_COOLDOWN_FOREGROUND_MS = (\d[\d_]*)L/.exec(kt)?.[1] ?? '0').replace(
        /_/g,
        '',
      ),
    );
    const bg = Number(
      (/GATT_COOLDOWN_BACKGROUND_MS = (\d[\d_]*)L/.exec(kt)?.[1] ?? '0').replace(
        /_/g,
        '',
      ),
    );
    expect(fg).toBeGreaterThanOrEqual(5_000);
    expect(bg).toBe(30_000);
    expect(bg).toBeGreaterThan(fg);
    // ...and the in-flight cap, which is the actual crowd guard, is intact.
    expect(kt).toMatch(/MAX_GATT_IN_FLIGHT = \d+/);
    expect(kt).toMatch(/gattInFlight\.size >= MAX_GATT_IN_FLIGHT/);
  });

  test('the floor is READ per decision, from the posture JS set', () => {
    // Mutation: cache the value at scan start (or key it off anything but
    // scanLowLatency) — a phone that comes to the foreground keeps the
    // pocket's clock until something restarts the scan.
    const kt = readSource(KT);
    expect(kt).toMatch(
      /private fun gattCooldownMs\(\): Long =\s*\n?\s*if \(scanLowLatency\) GATT_COOLDOWN_FOREGROUND_MS else GATT_COOLDOWN_BACKGROUND_MS/,
    );
    expect(kt).toMatch(/val cooldown = gattCooldownMs\(\)/);
    expect(kt).toMatch(/now - last < cooldown/);
    // The posture itself still arrives from JS's own foreground rule.
    expect(kt).toMatch(/fun setScanMode\(lowLatency: Boolean/);
    expect(readSource(MESH)).toMatch(/setScanPosture\(fg\)/);
  });
});

describe('recency is stamped by completed syncs only', () => {
  it('lastPodSyncMs is null until a sync lands, then the landing time', async () => {
    // Mutation: stamp at dial (or at sighting) — the pod card claims
    // "caught up" about an exchange that never finished.
    expect(lastPodSyncMs()).toBeNull();
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(lastPodSyncMs()).toBe(now);
  });

  it('a failed sync does not move the stamp', async () => {
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('peer walked away');
    });
    mockSighting!({ peerId: PEER, via: 'adv' });
    await flush();
    expect(lastPodSyncMs()).toBeNull();
  });
});
