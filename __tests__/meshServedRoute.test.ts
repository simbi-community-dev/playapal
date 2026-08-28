/**
 * THE ONE-WAY MIRROR, and the idle heartbeat underneath it — both measured
 * on the 2026-08-26 four-phone bench (iPhone 13 mini + Pixel 7 + Pixel 9,
 * one foot apart, app open on all three).
 *
 * WHAT THE LOGS SAID. In two minutes each Pixel's scan produced 74 results
 * and every single one was the OTHER Pixel: zero sightings of the iPhone,
 * whose crew beacon was held off the air for an open walkie (share.ts,
 * holdCrewAdvertising). In those same two minutes the iPhone connected to
 * each Pixel and pulled its entire digest eleven times, from nine different
 * rotating addresses. Sync is PULL-ONLY, so mail sitting on the iPhone had
 * no path at all: the Pixels could not dial a phone they could not
 * discover, and the nine live addresses it handed them were discarded on
 * arrival. Eight minutes for a text between adjacent phones — the length of
 * the walkie call, not of anything on the radio.
 *
 * And on the OTHER pair, the opposite waste: two caught-up Pixels re-pulling
 * a byte-identical 1105-byte digest over a fresh GATT connection four times
 * a minute, logging accepted=0 every time, forever.
 *
 * Both pins live here. Each assertion names the mutation it dies on.
 */

let mockSighting: ((s: { peerId: string; via?: string }) => void) | undefined;
let mockServed:
  | ((s: { peerId: string; dialable: boolean }) => void)
  | undefined;
const mockPostures: boolean[] = [];

/** What the native peer answers with on its next digest read. */
let mockPeerDigest = 'aaaa';

jest.mock('react-native', () => ({
  NativeModules: {
    CrewBeacon: {
      setSyncDigest: jest.fn(async () => undefined),
      provideSyncMessages: jest.fn(async () => undefined),
      syncWithPeer: jest.fn(async () => ({ digest: mockPeerDigest, messages: '' })),
    },
  },
  AppState: {
    get currentState() {
      return 'active';
    },
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

jest.mock('../src/crews/radio', () => ({
  onSighting: (cb: (s: { peerId: string; via?: string }) => void) => {
    mockSighting = cb;
    return () => {
      mockSighting = undefined;
    };
  },
  onSyncServed: (cb: (s: { peerId: string; dialable: boolean }) => void) => {
    mockServed = cb;
    return () => {
      mockServed = undefined;
    };
  },
  onSyncWant: () => () => undefined,
  setScanPosture: async (lowLatency: boolean) => {
    mockPostures.push(lowLatency);
  },
  // Enough of a codec for the digest signature to mean something: distinct
  // strings must decode to distinct bytes, or the idle gate is testing
  // nothing.
  b64ToBytes: (s: string) =>
    Uint8Array.from(Array.from(String(s)).map(c => c.charCodeAt(0) & 0xff)),
  bytesToB64: () => '',
}));

jest.mock('../src/crews/messages', () => ({
  messagesRevision: () => 0,
  subscribeMessagesChanged: () => () => undefined,
  subscribeLocalCompose: () => () => undefined,
  epochMinutes: (ms: number) => Math.floor(ms / 60000),
}));

jest.mock('../src/crews/syncLink', () => ({
  serveDigest: () => new Uint8Array(),
  serveMessages: () => new Uint8Array(),
  // The REAL conductor always fetches the digest first; the stand-in must
  // too, or meshSync never learns what the peer offered.
  syncWithPeer: jest.fn(async (link: { fetchDigest(): Promise<Uint8Array> }) => {
    await link.fetchDigest();
    return { accepted: 0 };
  }),
}));

import { syncWithPeer as linkSync } from '../src/crews/syncLink';
import {
  checkPodUpdates,
  startMeshSync,
  stopMeshSync,
} from '../src/crews/meshSync';

const CODES = () => ['amber-lantern-31'];
/** The Pixel next door: discoverable, sighted, ordinary. */
const SIGHTED = 'AA:BB:CC:DD:EE:01';
/** The iPhone's rotating central names — never sighted, only ever served. */
const PULLED_A = '5A:34:2C:79:29:2C';
const PULLED_B = '44:8E:7A:85:47:46';
const PULLED_C = '4C:45:D4:F8:21:E4';
const PULLED_D = '6F:7B:E5:21:17:B2';

const flush = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};

/** The [mesh] decision log — this layer's own field record, and the only
 * place the ADDRESS of a dial is stated (linkSync is handed a link, not a
 * name). Asserting on it is asserting on what the 3am logcat would show. */
const meshLog: string[] = [];
const dialedAddrs = (): string[] =>
  meshLog
    .filter(l => l.startsWith('[mesh] dial '))
    .map(l => l.split(' ')[2]);

let now = 1_756_000_000_000;

const okSync = async (link: { fetchDigest(): Promise<Uint8Array> }) => {
  await link.fetchDigest();
  return { accepted: 0 };
};

beforeEach(() => {
  now = 1_756_000_000_000;
  mockPeerDigest = 'aaaa';
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  meshLog.length = 0;
  jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') {
      meshLog.push(line);
    }
  });
  (linkSync as jest.Mock).mockReset();
  (linkSync as jest.Mock).mockImplementation(okSync);
  mockPostures.length = 0;
  startMeshSync(CODES);
});

afterEach(() => {
  stopMeshSync();
  jest.restoreAllMocks();
});

const dials = () => (linkSync as jest.Mock).mock.calls.length;

describe('a peer that pulled from us is a peer we can reach', () => {
  it('dials a phone it has NEVER sighted, on the address that pulled', async () => {
    // THE EIGHT-MINUTE MAIL. Mutation: drop the lastSeen stamp in the
    // onSyncServed handler (the pre-fix shape, where the address was
    // logged and discarded) — nudgeSync finds nothing on the air, queues
    // nothing, and the iPhone's mail has no path off the iPhone. This
    // assertion is the whole fix: no sighting has ever happened here.
    expect(dials()).toBe(0);
    mockServed!({ peerId: PULLED_A, dialable: true });
    await flush();
    expect(dials()).toBe(1);
  });

  it('a served id that is NOT an address is still only a cue', async () => {
    // Mutation: ignore `dialable` and stamp every served id. On iOS the id
    // is an opaque CBCentral identifier that retrievePeripherals cannot
    // take, so every pull would queue an undialable name into the native
    // one-at-a-time sync mutex and stall the peers that DO work.
    mockServed!({
      peerId: 'B0F5E0A2-0000-4000-8000-00000000FEED',
      dialable: false,
    });
    await flush();
    expect(dials()).toBe(0);
  });

  it('the served address is never freshness-condemned as a dead advertiser', async () => {
    // Mutation: stamp the served address via='adv'. A one-shot 'adv' name
    // is judged against FRESH_SINGLE_ADV_MS and condemned 15 s later as a
    // rotation drive-by — correct for a name the scanner stopped hearing,
    // nonsense for one that never advertised at all and completed a
    // connection to us instead. The manual check is where it shows: the
    // camper presses "Check for pod updates" and the one phone that
    // provably reached them is reported as not in range.
    mockServed!({ peerId: PULLED_A, dialable: true });
    await flush();
    expect(dials()).toBe(1);

    now += 40_000; // well past FRESH_SINGLE_ADV_MS
    const r = await checkPodUpdates();
    expect(r.inRange).toBe(1);
    expect(dials()).toBe(2);
  });

  it('forgets a served address at the hard horizon without another radio event', async () => {
    // Mutation: omit the manual check's forgetOldAddresses pass. A GATT-only
    // address always passes addressFresh, so after the peer has left it is
    // still counted and dialled forever unless another radio event happens
    // to prune it first.
    mockServed!({ peerId: PULLED_A, dialable: true });
    await flush();
    expect(dials()).toBe(1);

    now += 5 * 60_000 + 1;
    const r = await checkPodUpdates();
    expect(r).toEqual({ inRange: 0, moved: 0 });
    expect(dials()).toBe(1);
  });

  it('retires a forgotten served address already waiting in the dial queue', async () => {
    // Mutation: forget every map entry but leave the address in queue. The
    // manual check reports nobody in range, then the single-flight worker
    // reaches the state-less entry and addressFresh admits it as non-adv.
    let release!: () => void;
    (linkSync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<{ accepted: number }>(resolve => {
          release = () => resolve({ accepted: 0 });
        }),
    );
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(1); // A owns the worker

    mockServed!({ peerId: PULLED_A, dialable: true });
    await flush();
    expect(dials()).toBe(1); // B is queued behind A

    now += 5 * 60_000 + 1;
    const checked = checkPodUpdates();
    await flush();
    release();

    const r = await checked;
    expect(r).toEqual({ inRange: 0, moved: 0 });
    expect(dials()).toBe(1);
  });
});

describe('the served-address path cannot stall the peers that work', () => {
  it('rests after three straight failures, and one success clears the count', async () => {
    // THE BLAST RADIUS. The native sync is one-at-a-time behind a 60 s
    // timeout, so an address that cannot be dialled does not merely waste
    // an attempt — it holds every other peer's mail for the length of a
    // connect timeout. Mutation: drop SERVED_DIAL_STRIKES (or the rest
    // window) and a rotating peer whose central name is not reachable
    // buys a stalled mesh four times a minute, forever.
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('could not connect');
    });
    for (const addr of [PULLED_A, PULLED_B, PULLED_C]) {
      mockServed!({ peerId: addr, dialable: true });
      await flush();
      now += 1_000;
    }
    expect(dials()).toBe(3);

    // WHAT THE REST REFUSES IS REPEATED PROOF, NOT NEW PROOF (composition
    // review, 2026-08-27 — this assertion used to read `toBe(3)` and was
    // the rule that broke the eight-minute bar). A pull this phone has not
    // answered yet is authoritative reachability evidence, and it earns
    // exactly one priority dial.
    mockServed!({ peerId: PULLED_D, dialable: true });
    await flush();
    expect(dials()).toBe(4);

    // …AND THE SAME NAME PULLING AGAIN IS NOT A REPEAT. Native raises the
    // event once per COMPLETED digest pull, so a second callback is a
    // second connection the peer actually made — its own occurrence, worth
    // its own one attempt, whatever address it happens to be wearing
    // (composition review, round 5: keying this on the address made
    // rotation the retry capability, and a podmate whose name did not
    // rotate went mute for the whole window).
    now += 1_000;
    mockServed!({ peerId: PULLED_D, dialable: true });
    await flush();
    expect(dials()).toBe(5);

    now += 5 * 60_000 + 1;
    (linkSync as jest.Mock).mockImplementation(okSync);
    mockServed!({ peerId: PULLED_D, dialable: true });
    await flush();
    expect(dials()).toBe(6); // the rest expired and the path is tried again
  });

  it('a failed served dial forgets that name instead of retrying it', async () => {
    // Mutation: leave the failed address in lastSeen. Nothing will ever
    // re-sight a rotated central name, so no freshness rule can retire it
    // — it would be nudged into the mutex on every single served event
    // for the whole ADDRESS_FORGET_MS horizon.
    (linkSync as jest.Mock).mockImplementation(async () => {
      throw new Error('could not connect');
    });
    mockServed!({ peerId: PULLED_A, dialable: true });
    await flush();
    expect(dials()).toBe(1);

    now += 6_000; // past the nudge floor: a remembered name would re-dial
    (linkSync as jest.Mock).mockImplementation(okSync);
    mockServed!({ peerId: PULLED_B, dialable: true });
    await flush();
    expect(dialedAddrs()).toEqual([PULLED_A, PULLED_B]);
  });
});

describe('an unchanged offer earns a longer clock, not a fresh connection', () => {
  it('stretches the sighting cooldown while the peer offers the same digest', async () => {
    // THE IDLE HEARTBEAT. Mutation: use cooldownMs() instead of
    // sightingGateMs() at the sighting gate — two caught-up phones are
    // straight back to a GATT connect every 15 s with accepted=0, which is
    // what the bench measured.
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(1); // first offer: nothing to compare it to

    now += 15_000;
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(2); // same offer, nothing moved: one idle step

    now += 15_000;
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(2); // the clock is 30 s now, and 15 s have passed

    now += 15_000;
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(3);
  });

  it('a changed offer puts the clock straight back to base', async () => {
    // Mutation: never reset idleRuns on a digest change — the back-off
    // ratchets to its ceiling and stays there, and a peer that has news
    // waits out a minute it did nothing to earn.
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    now += 15_000;
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(2); // idle step 1, clock now 30 s

    mockPeerDigest = 'bbbb'; // their mailbox moved
    now += 30_000;
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(3);

    now += 15_000; // base clock again, not the stretched one
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(4);
  });

  it('never stretches past the frugal clock the pocket already runs', async () => {
    // Mutation: drop IDLE_BACKOFF_CEILING_MS. The multiplier keeps
    // doubling and a foreground pod quietly becomes slower than a
    // backgrounded one — a battery saving nobody asked for, paid in mail.
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    for (let i = 0; i < 8; i++) {
      now += 60_000;
      mockSighting!({ peerId: SIGHTED, via: 'adv' });
      await flush();
    }
    expect(dials()).toBe(9); // every 60 s tick still dials
  });

  it('a nudge ignores the idle clock entirely', async () => {
    // Mutation: apply the idle back-off to nudges. The reciprocity dial —
    // the hop that actually moves fresh mail — would inherit a back-off
    // earned while there was nothing to move.
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    now += 15_000;
    mockSighting!({ peerId: SIGHTED, via: 'adv' });
    await flush();
    expect(dials()).toBe(2); // idle step 1, clock now 30 s

    now += 6_000; // inside the stretched clock, past the nudge floor
    mockServed!({ peerId: SIGHTED, dialable: true });
    await flush();
    expect(dials()).toBe(3);
  });
});
