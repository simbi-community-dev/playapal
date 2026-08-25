/**
 * The dial target must still be ON THE AIR (src/crews/meshSync.ts) —
 * judged by the address's OWN heartbeat, not one platform's clock.
 *
 * MEASURED ON TWO PHONES, 2026-08-24, and this suite is the pin for it.
 * A peerId is a BLE address, and a BLE address is a temporary name: every
 * time Android restarts an advertisement it mints a new random one. On a
 * sharing phone that is every refresh tick — an address was visible for a
 * median of 11 seconds and then gone forever.
 *
 * The failure was not "a sync failed". It was a spiral:
 *
 *   a rotated address does not fail fast, it fails at the GATT connect
 *   TIMEOUT — dials landed exactly 30 seconds apart — so each attempt
 *   spent 30 seconds learning a 10-second name was dead, and left the
 *   next queue entry 30 seconds staler than the one that just died.
 *
 * Once behind, never caught up: 5 of the last 5 dials on the test phone
 * targeted an address that had not been on the air at any point in the
 * log. Every sync failed at phase=connect, all evening, with a full
 * mailbox and a perfectly healthy radio.
 *
 * Everything is injected here — no native modules, no store, no db.
 */

const dialled: string[] = [];

jest.mock('react-native', () => ({
  NativeModules: {
    CrewBeacon: {
      setSyncDigest: jest.fn(async () => undefined),
      provideSyncMessages: jest.fn(async () => undefined),
      syncWithPeer: jest.fn(async () => ({ digest: '', messages: '' })),
    },
  },
}));

let sighting: ((s: { peerId: string; via?: string }) => void) | undefined;
jest.mock('../src/crews/radio', () => ({
  onSighting: (cb: (s: { peerId: string; via?: string }) => void) => {
    sighting = cb;
    return () => {
      sighting = undefined;
    };
  },
  onSyncWant: () => () => undefined,
  b64ToBytes: () => new Uint8Array(),
  bytesToB64: () => '',
}));

jest.mock('../src/crews/messages', () => ({
  messagesRevision: () => 0,
  subscribeMessagesChanged: () => () => undefined,
  epochMinutes: (ms: number) => Math.floor(ms / 60000),
}));

jest.mock('../src/crews/syncLink', () => ({
  serveDigest: () => new Uint8Array(),
  serveMessages: () => new Uint8Array(),
  // The one thing under observation: WHICH addresses we actually dial.
  syncWithPeer: jest.fn(async () => {
    return undefined;
  }),
}));

import { syncWithPeer as linkSync } from '../src/crews/syncLink';
import { startMeshSync, stopMeshSync } from '../src/crews/meshSync';

const CODES = () => ['amber-lantern-31'];

/** A sync whose connect hangs until released — the 30-second timeout,
 * which is what lets the queue behind it go stale in the first place. */
function hangingDial() {
  let release: (() => void) | undefined;
  (linkSync as jest.Mock).mockImplementation(async () => {
    await new Promise<void>(res => {
      release = res;
    });
  });
  return () => release?.();
}

describe('a queued address is only dialled while it is still on the air', () => {
  let now = 1_756_000_000_000;

  beforeEach(() => {
    dialled.length = 0;
    now = 1_756_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    (linkSync as jest.Mock).mockReset();
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    startMeshSync(CODES);
  });

  afterEach(() => {
    stopMeshSync();
    jest.restoreAllMocks();
  });

  it('dials a peer that was just seen', async () => {
    sighting!({ peerId: 'AA:BB:CC:DD:EE:01', via: 'adv' });
    await Promise.resolve();
    await Promise.resolve();
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);
  });

  // THE SPIRAL, reproduced. Two peers are sighted; the first dial hangs on
  // the connect timeout. While it hangs, the second peer's address rotates
  // away. Without the freshness gate the queue dials it anyway and burns
  // another timeout on a name that no longer exists.
  it('does NOT dial an address that went off the air while it queued', async () => {
    const release = hangingDial();
    sighting!({ peerId: 'AA:BB:CC:DD:EE:01', via: 'adv' });
    // :02 shows an ANDROID heartbeat — sighted twice two seconds apart —
    // so the gate can judge it by its own rhythm. A single sighting gets
    // the conservative allowance now (see the iOS test below), which is
    // deliberate: with no rhythm to judge against, a wrong drop costs a
    // slow peer its mail while a wrong dial costs one bounded timeout.
    sighting!({ peerId: 'AA:BB:CC:DD:EE:02', via: 'adv' });
    now += 2_000;
    sighting!({ peerId: 'AA:BB:CC:DD:EE:02', via: 'adv' });
    await Promise.resolve();
    await Promise.resolve();

    // The first dial is in flight and holding the radio.
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);

    // 30 seconds pass — the connect timeout. :02 has not been seen since
    // it was queued, so by now it answers to a different name entirely.
    now += 30_000;
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Still one. The dead name was dropped, not dialled.
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);
  });

  // ...and dropping is not the same as giving up on the peer. This is the
  // half that makes the gate safe: a real neighbour is sighted every
  // second or two, so they come straight back under their current name.
  it('re-queues the same phone the moment it is seen again', async () => {
    const release = hangingDial();
    sighting!({ peerId: 'AA:BB:CC:DD:EE:01', via: 'adv' });
    sighting!({ peerId: 'AA:BB:CC:DD:EE:02', via: 'adv' });
    now += 2_000;
    sighting!({ peerId: 'AA:BB:CC:DD:EE:02', via: 'adv' });
    await Promise.resolve();

    now += 30_000;
    release();
    await Promise.resolve();
    await Promise.resolve();

    // The peer is still right there, now advertising as :03.
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    sighting!({ peerId: 'AA:BB:CC:DD:EE:03', via: 'adv' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const names = (linkSync as jest.Mock).mock.calls.length;
    expect(names).toBe(2);
  });

  // THE OTHER HALF OF THE GATE, and the one that is easy to get wrong in a
  // way no other test here notices: the stamp reads "when was this name
  // last on the air", NOT "when did we last sync it". Those are different
  // clocks, because the cooldown turns most sightings away.
  //
  // A peer queued behind a hanging dial keeps being sighted the whole time
  // it waits — it is standing right there — but every one of those
  // sightings is suppressed by its own cooldown. Stamp the address only on
  // the sightings that survive the cooldown and this peer looks 30 seconds
  // dead when the queue finally reaches it, and gets dropped: a live
  // neighbour, discarded for being politely quiet.
  //
  // Written after a mutation ran clean. The version of this suite that
  // checked the cooldown WITHOUT a hanging dial could not tell the two
  // stampings apart at all, because the drain always caught up before the
  // distinction could show.
  it('dials a peer that stayed on the air while it waited, cooldown or not', async () => {
    const release = hangingDial();
    sighting!({ peerId: 'AA:BB:CC:DD:EE:01', via: 'adv' });
    sighting!({ peerId: 'AA:BB:CC:DD:EE:02', via: 'adv' });
    await Promise.resolve();
    await Promise.resolve();
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);

    // :02 waits in the queue and is sighted throughout — every one of
    // these is inside its cooldown and syncs nothing.
    for (let i = 0; i < 15; i++) {
      now += 2_000;
      sighting!({ peerId: 'AA:BB:CC:DD:EE:02', via: 'adv' });
    }

    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Seen two seconds ago. It must be dialled.
    expect((linkSync as jest.Mock).mock.calls.length).toBe(2);
  });
});

describe('the gate speaks iOS, which has a slower heartbeat', () => {
  let now = 1_756_000_000_000;

  beforeEach(() => {
    now = 1_756_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    (linkSync as jest.Mock).mockReset();
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    startMeshSync(CODES);
  });

  afterEach(() => {
    stopMeshSync();
    jest.restoreAllMocks();
  });

  // THE CROSS-FAMILY CATCH, and the reason the threshold adapts. An iOS
  // peer's payload rides a GATT characteristic, and the read is
  // rate-limited to 30 seconds — so a live iPhone is sighted twice a
  // minute AT BEST. The flat ten-second gate this file first shipped with
  // read every live iPhone as a corpse and starved it of mail forever,
  // and no device test here could see it: the test pair is two Androids.
  it('an address on a 30-second rhythm is still dialable 35s after its last sighting', async () => {
    // Establish the rhythm: three sightings, 30s apart. Each is queued and
    // drained immediately (nothing ahead of it), so use a hanging dial to
    // hold the queue and make the LAST sighting wait.
    sighting!({ peerId: 'IO:S1:00:00:00:01', via: 'gatt' });
    await Promise.resolve();
    await Promise.resolve();
    now += 30_000;
    sighting!({ peerId: 'IO:S1:00:00:00:01', via: 'gatt' });
    now += 30_000;
    // A slow in-flight dial of someone else is what makes the iOS peer
    // wait long enough for a flat gate to kill it.
    const release = (() => {
      let r: (() => void) | undefined;
      (linkSync as jest.Mock).mockImplementation(async () => {
        await new Promise<void>(res => {
          r = res;
        });
      });
      return () => r?.();
    })();
    sighting!({ peerId: 'AN:DR:00:00:00:99', via: 'adv' });
    sighting!({ peerId: 'IO:S1:00:00:00:01', via: 'gatt' });
    await Promise.resolve();
    await Promise.resolve();

    // 35 seconds pass while the other dial hangs — more than three times
    // the dead flat gate, barely one beat of this address's own rhythm.
    now += 35_000;
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const dialled = (linkSync as jest.Mock).mock.calls.length;
    // Three: the iOS peer's first-contact dial, the hanging Android dial,
    // and — the assertion this test exists for — the iOS peer's SECOND
    // dial, 35 seconds after its last sighting. The dead flat gate dropped
    // exactly that third one, and this count reads 2 under it.
    expect(dialled).toBe(3);
  });

  // The other direction still holds under the adaptive rule: an address
  // with a FAST rhythm that goes quiet has rotated, and three of its own
  // missed heartbeats condemn it long before the conservative allowance.
  it('a fast-rhythm address that goes quiet is still dropped', async () => {
    const release = (() => {
      let r: (() => void) | undefined;
      (linkSync as jest.Mock).mockImplementation(async () => {
        await new Promise<void>(res => {
          r = res;
        });
      });
      return () => r?.();
    })();
    sighting!({ peerId: 'AN:DR:00:00:00:01', via: 'adv' });
    // Android rhythm: two seconds between sightings.
    sighting!({ peerId: 'AN:DR:00:00:00:02', via: 'adv' });
    now += 2_000;
    sighting!({ peerId: 'AN:DR:00:00:00:02', via: 'adv' });
    await Promise.resolve();
    await Promise.resolve();
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);

    // 30 seconds of silence from a 2-second talker: rotated, gone.
    now += 30_000;
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);
  });
});

describe('a one-shot address tells the gate how it was heard', () => {
  let now = 1_756_000_000_000;

  beforeEach(() => {
    now = 1_756_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    (linkSync as jest.Mock).mockReset();
    startMeshSync(CODES);
  });

  afterEach(() => {
    stopMeshSync();
    jest.restoreAllMocks();
  });

  // A single sighting has no rhythm, but `via` is the platform signal the
  // rhythm would have carried. An inline advertisement is the Android
  // path — a live neighbour repeats within seconds, so a 20-second-old
  // one-shot 'adv' name is a rotation drive-by and dialling it burns a
  // connect timeout. The same silence on a 'gatt' name is one missed iOS
  // read and the peer is probably still there.
  it("drops a 20s-stale one-shot 'adv' name, dials the same-aged 'gatt' one", async () => {
    const release = (() => {
      let r: (() => void) | undefined;
      (linkSync as jest.Mock).mockImplementation(async () => {
        await new Promise<void>(res => {
          r = res;
        });
      });
      return () => r?.();
    })();
    sighting!({ peerId: 'HO:LD:00:00:00:00', via: 'adv' });
    sighting!({ peerId: 'AN:DR:00:00:00:01', via: 'adv' });
    sighting!({ peerId: 'IO:S1:00:00:00:01', via: 'gatt' });
    await Promise.resolve();
    await Promise.resolve();
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);

    now += 20_000;
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The holder plus the iOS name; the drive-by was dropped.
    expect((linkSync as jest.Mock).mock.calls.length).toBe(2);
  });

  // THE TWO-NATIVE-CALL CASE (review, round 4): one queued item is up to
  // TWO native syncWithPeer calls, each with its own 60-second timeout, so
  // a first-contact iOS peer can wait ~120 seconds with no re-sighting —
  // the GATT read that would re-sight it competes with the very sync
  // holding the radio. No allowance constant survives that arithmetic
  // honestly, which is why GATT-sighted names are simply never
  // freshness-dropped: their silence is not evidence when we caused it.
  it("dials a first-contact 'gatt' name after 130 seconds behind a two-call sync", async () => {
    const release = (() => {
      let r: (() => void) | undefined;
      (linkSync as jest.Mock).mockImplementation(async () => {
        await new Promise<void>(res => {
          r = res;
        });
      });
      return () => r?.();
    })();
    sighting!({ peerId: 'HO:LD:00:00:00:00', via: 'adv' });
    sighting!({ peerId: 'IO:S1:00:00:00:02', via: 'gatt' });
    await Promise.resolve();
    await Promise.resolve();
    expect((linkSync as jest.Mock).mock.calls.length).toBe(1);

    // Two full native timeouts pass with no re-sighting at all.
    now += 130_000;
    (linkSync as jest.Mock).mockImplementation(async () => undefined);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The iOS name was dialled, not dropped.
    expect((linkSync as jest.Mock).mock.calls.length).toBe(2);
  });
});
