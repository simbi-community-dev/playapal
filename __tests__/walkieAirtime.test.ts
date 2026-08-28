/**
 * THE WALKIE TAKES THE ADVERTISING SLOT — pinned against the bench that
 * found the defect, three phones, 2026-08-26.
 *
 * An iPhone carried live BLE voice to an Android for the first time, and
 * neither Android could see that iPhone in their channel at all. P7's
 * logcat proved the other Pixel's PV hash over and over and never once
 * attempted the iPhone's: the UUID-filtered Android scan never matched the
 * iPhone's advertisement.
 *
 * The cause is a documented CoreBluetooth budget, not a bug in either
 * scanner. With the walkie open, an iPhone runs TWO CBPeripheralManager
 * advertisers — rung 3's voice service (a 128-bit UUID plus the "PV…"
 * local name) and the crew beacon's own service UUID — and two 128-bit
 * UUIDs do not fit one 31-byte primary advertising packet. CoreBluetooth
 * then moves the service UUIDs into the proprietary OVERFLOW AREA, which
 * Apple documents as discoverable only by an iOS device explicitly
 * scanning for that exact UUID. `ScanFilter.setServiceUuid` on Android
 * matches nothing. Two advertisers do not halve the iPhone's reach; they
 * end it.
 *
 * So while the walkie is on, the crew beacon goes quiet, and it comes back
 * when the walkie closes. This suite holds both halves:
 *
 *  - THE MECHANISM (src/crews/radio.ts): a held advertiser is taken off the
 *    air once and stays off, and the scan is never touched.
 *  - THE WIRING (src/crews/walkieSession.ts): the hold lands BEFORE the
 *    walkie's own advertiser comes up and the release lands AFTER it goes
 *    down — an overlap in either direction is the whole defect.
 *
 * Each assertion names the mutation it dies on.
 */

// Mock factories run BEFORE this file's own consts are initialised (jest
// hoists them above the imports, and the imports run first), so every
// shared array is minted on globalThis inside whichever factory needs it
// first — the idiom __tests__/walkiePanel.test.tsx already uses.
interface MockRev {
  revisionHi: number;
  revisionLo: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __airtimeNative: string[] | undefined;
  // eslint-disable-next-line no-var
  var __airtimeOrder: string[] | undefined;
  /**
   * THE NATIVE AIRTIME SEAM, AS A DOUBLE THIS FILE CAN DRIVE.
   *
   * The arbiter's state is a LEVEL with two roads — a query and a
   * replayed event — and both carry the identical versioned body. The
   * double carries the same shape for the same reason: an arm that could
   * only drive one road would prove nothing about the road the production
   * code actually took.
   */
  /** Named OUTSIDE the factory: jest's out-of-scope guard reads the
   *  identifiers inside a type annotation too, so a factory may not spell
   *  `(snap: unknown) => void` inline. */
  // eslint-disable-next-line no-var
  var __airtimeSeam:
    | {
        capability: 'arbiter' | 'incompatible' | 'absent';
        state: unknown;
        stop: unknown;
        listeners: Set<(snap: unknown) => void>;
        asked: number;
      }
    | undefined;
}

jest.mock('react-native', () => {
  const calls: string[] = (globalThis.__airtimeNative =
    globalThis.__airtimeNative ?? []);
  const note = (name: string) => async () => {
    calls.push(name);
  };
  return {
    NativeModules: {
      CrewBeacon: {
        setPayload: note('setPayload'),
        startAdvertising: note('startAdvertising'),
        stopAdvertising: note('stopAdvertising'),
        startScan: note('startScan'),
        stopScan: note('stopScan'),
      },
      Walkie: {},
    },
    NativeEventEmitter: class {
      addListener() {
        return { remove: () => undefined };
      }
    },
    Platform: { OS: 'ios', Version: 0 },
    PermissionsAndroid: {
      PERMISSIONS: {},
      RESULTS: {},
      request: async () => 'granted',
      requestMultiple: async () => ({}),
      check: async () => true,
    },
  };
});

jest.mock('../src/crews/share', () => {
  const order: string[] = (globalThis.__airtimeOrder =
    globalThis.__airtimeOrder ?? []);
  return {
    holdCrewAdvertising: jest.fn(async () => {
      order.push('hold');
    }),
    releaseCrewAdvertising: jest.fn(async () => {
      order.push('release');
    }),
  };
});

jest.mock('../src/crews/walkie', () => {
  const order: string[] = (globalThis.__airtimeOrder =
    globalThis.__airtimeOrder ?? []);
  const seam = (globalThis.__airtimeSeam = globalThis.__airtimeSeam ?? {
    capability: 'arbiter' as const,
    state: null as unknown,
    stop: null as unknown,
    listeners: new Set(),
    asked: 0,
  });
  const watchers = new Set<() => void>();
  let revision = 0;
  let on = false;
  return {
    walkieOn: () => on,
    walkieChannelRevision: () => revision,
    subscribeWalkieChannel: (cb: () => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    dedupeWalkiePeers: (rows: unknown[]) => rows,
    formatChannelNames: () => '',
    onWalkiePeers: () => () => undefined,
    setWalkieCallMuted: async () => undefined,
    startWalkie: jest.fn(async () => {
      order.push('startWalkie');
      on = true;
      revision += 1;
      for (const w of [...watchers]) {
        w();
      }
    }),
    stopTalking: async () => undefined,
    stopWalkie: jest.fn(async () => {
      order.push('stopWalkie');
      on = false;
      revision += 1;
      for (const w of [...watchers]) {
        w();
      }
      return seam.stop;
    }),
    // THE TWO ROADS INTO THE SAME LEVEL, both driveable.
    walkieAirtimeState: jest.fn(async () => {
      seam.asked += 1;
      return { capability: seam.capability, state: seam.state };
    }),
    onWalkieAirtimeState: (cb: never) => {
      seam.listeners.add(cb);
      return () => seam.listeners.delete(cb);
    },
    // The REAL comparator's rule, spelled here so an arm above 2^53 is
    // comparing the way production does rather than the way a double
    // found convenient.
    compareWalkieRevision: (a: MockRev, b: MockRev) => {
      if (a.revisionHi !== b.revisionHi) {
        return a.revisionHi < b.revisionHi ? -1 : 1;
      }
      if (a.revisionLo !== b.revisionLo) {
        return a.revisionLo < b.revisionLo ? -1 : 1;
      }
      return 0;
    },
  };
});

jest.mock('../src/crews/callRuntime', () => ({
  callsPresent: () => false,
  CallRuntime: class {},
}));

import {
  crewAdvertisingHeld,
  crewRadio,
  setCrewAdvertisingHold,
} from '../src/crews/radio';
import {
  __resetWalkieSessionForTests,
  startWalkieSession,
  stopWalkieSession,
  walkieHoldReason,
} from '../src/crews/walkieSession';

const PAYLOAD = new Uint8Array([1, 2, 3]);
/** Every native verb the crew beacon was asked for, in order. */
const mockNativeCalls = globalThis.__airtimeNative!;
/** …and every seam of the walkie's own lifecycle, in the same shape, so
 * the hold and the walkie's advertiser can be compared as a SEQUENCE. */
const mockOrder = globalThis.__airtimeOrder!;
/** The arbiter's state, as this file drives it. */
const seam = globalThis.__airtimeSeam!;

/** One versioned body, the shape the real decoder accepts. Arms override
 *  only the field they are about, so a body can never drift into being
 *  unreadable for a reason the arm did not intend. */
const airtime = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  processIncarnation: 'proc-1',
  revision: '4',
  revisionHi: 0,
  revisionLo: 4,
  phase: 'idle',
  leaseId: null,
  opId: null,
  rung: 'none',
  debtCount: 0,
  crewMayAdvertise: true,
  holdRequired: false,
  why: 'query',
  ...over,
});

const CLEAR = airtime();
/** The SAME clear slot, one debt settlement LATER. Revision 9 against the
 *  hold's 7 — which is the only thing that tells a body describing the
 *  world after the settlement from one describing it before. */
const SETTLED = airtime({ revision: '9', revisionLo: 9, why: 'debt-settled' });
const HOLDING = airtime({
  phase: 'debt',
  rung: 'none',
  debtCount: 1,
  crewMayAdvertise: false,
  holdRequired: true,
  revision: '7',
  revisionLo: 7,
  why: 'debt-transfer',
});

/** Let every already-queued microtask run — the park's query, the
 *  rejection, the finally's decrement and the re-drive it fires. */
const settleMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
};

const POD = {
  crewId: 'pod-1',
  crewCode: 'dusty llamas',
  myCardId: 'me',
  myName: 'Pug',
};

beforeEach(() => {
  mockNativeCalls.length = 0;
  mockOrder.length = 0;
  seam.capability = 'arbiter';
  seam.state = CLEAR;
  // THE ORDINARY CLOSE, and it is the only word that hands the slot back.
  seam.stop = { v: 2, outcome: 'clear', why: 'not-advertising', state: CLEAR };
  seam.listeners.clear();
  seam.asked = 0;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  await setCrewAdvertisingHold(false);
  __resetWalkieSessionForTests();
  jest.restoreAllMocks();
});

describe('the mechanism: a held advertiser is off the air and stays off', () => {
  test('holding takes the beacon down once, and later ticks put nothing back', async () => {
    // THE LOAD-BEARING ONE. Mutation: make the hold a flag that only
    // suppresses FUTURE advertise() calls without stopping the advertiser
    // that is already running — the payload on the air at the moment the
    // walkie opens simply stays there, both advertisers overlap, and every
    // Android in the pod loses this iPhone exactly as the bench measured.
    const radio = crewRadio();
    await radio.advertise(PAYLOAD);
    expect(mockNativeCalls).toContain('startAdvertising');

    mockNativeCalls.length = 0;
    await setCrewAdvertisingHold(true);
    expect(crewAdvertisingHeld()).toBe(true);
    expect(mockNativeCalls).toEqual(['stopAdvertising']);

    // Two cadence ticks land while the walkie is open. Neither may reach
    // the radio: setPayload into a module that is not advertising is the
    // measured no-op that made the bounce bug invisible, and
    // startAdvertising would re-open the overlap the hold exists to close.
    mockNativeCalls.length = 0;
    await radio.advertise(PAYLOAD);
    await radio.advertise(PAYLOAD);
    expect(mockNativeCalls).toEqual([]);
  });

  test('releasing puts the NEXT beacon back on the air, advertiser and all', async () => {
    // Mutation: clear the flag without clearing radio.ts's cached
    // `advertising` bit — the next advertise() calls setPayload only, the
    // module is not advertising, and the phone stays silent until someone
    // toggles Bluetooth. That is the exact shape of the 2026-08-24 bounce
    // failure this file's truth-sync was written against.
    const radio = crewRadio();
    await radio.advertise(PAYLOAD);
    await setCrewAdvertisingHold(true);

    mockNativeCalls.length = 0;
    await setCrewAdvertisingHold(false);
    expect(crewAdvertisingHeld()).toBe(false);
    await radio.advertise(PAYLOAD);
    expect(mockNativeCalls).toEqual(['setPayload', 'startAdvertising']);
  });

  test('the hold touches advertising ONLY — the scan keeps running', async () => {
    // THE HONESTY OF THE TRADE, pinned. Mutation: stop the scan too
    // ("the walkie needs the radio"), and this phone stops hearing its pod
    // for the length of a walkie session — no sightings, so no mesh sync,
    // so pod messages and voice notes stop moving for a reason that has
    // nothing to do with either. What the walkie needs is the ADVERTISING
    // slot; the central half is what keeps mail flowing from an iPhone.
    const radio = crewRadio();
    await radio.startScan(() => undefined);
    mockNativeCalls.length = 0;
    await setCrewAdvertisingHold(true);
    expect(mockNativeCalls).not.toContain('stopScan');
  });
});

describe('the wiring: the two advertisers never overlap', () => {
  test('the beacon is held BEFORE the walkie opens and released AFTER it closes', async () => {
    // THE ORDER IS THE CONTRACT. Mutation: move holdCrewAdvertising below
    // startWalkie (or releaseCrewAdvertising above stopWalkie) and there is
    // a window — however short — with both advertisers up. That window is
    // when CoreBluetooth decides where the service UUIDs go, and it does
    // not revisit the decision when one of them stops.
    await startWalkieSession(POD);
    await stopWalkieSession();
    expect(mockOrder).toEqual(['hold', 'startWalkie', 'stopWalkie', 'release']);
  });

  test('a second start for the same pod is a no-op, not a second hold', async () => {
    // Mutation: drop the idempotence guard at the top of
    // startWalkieSession — a double-tapped switch (or a re-render that
    // re-opens the session) files a second hold and, worse, a second
    // native start, and the release that eventually arrives is one of two.
    await startWalkieSession(POD);
    await startWalkieSession(POD);
    expect(mockOrder.filter(x => x === 'hold')).toHaveLength(1);
    expect(mockOrder.filter(x => x === 'startWalkie')).toHaveLength(1);
    await stopWalkieSession();
  });

  test('a start landing mid-teardown waits out the whole stop — the toggle is never swallowed', async () => {
    // THE RACE, confirmed adversarially (2026-08-26) before it was ever
    // benched: stopWalkieSession honestly clears state BEFORE its native
    // awaits, so a fast off→on toggle used to slip past the session fence
    // while the old teardown was suspended in the native stop — and the
    // teardown then resumed to stop the NEW session's radio and release the
    // NEW session's advertising hold. The tap that turned the walkie on was
    // silently undone.
    //
    // The stall below is the load-bearing part of the reproduction: on a
    // phone the native stop is SLOW relative to a tap, and only a stop that
    // outlasts the re-open's own awaits opens the window. A pure-microtask
    // teardown happens to finish under the permissions await and the race
    // hides — measured before this stall was added. Mutation: run the verbs
    // directly instead of through the lifecycle queue and the interleaved
    // order returns.
    await startWalkieSession(POD);
    mockOrder.length = 0;
    const walkie = jest.requireMock('../src/crews/walkie') as {
      stopWalkie: jest.Mock;
    };
    const nativeStop = walkie.stopWalkie.getMockImplementation()!;
    walkie.stopWalkie.mockImplementationOnce(async () => {
      await new Promise<void>(r => setTimeout(() => r(), 0));
      // THE ANSWER IS RETURNED, not merely awaited: the stop's outcome is
      // what decides whether the slot is handed back, so a slow double
      // that swallowed it would be testing a stop that answered nothing.
      return await nativeStop();
    });
    const stop = stopWalkieSession(); // teardown suspends in the slow stop
    const start = startWalkieSession(POD); // the fast re-open tap
    await Promise.all([stop, start]);
    expect(mockOrder).toEqual(['stopWalkie', 'release', 'hold', 'startWalkie']);
    await stopWalkieSession();
  });

  test('a beacon that refuses to go quiet does not cost the camper the walkie', async () => {
    // Mutation: await the hold without catching. The crew radio can be off,
    // denied, or wedged — none of which is a reason to refuse someone the
    // radio they just switched on. The walkie still works between iPhones
    // and still dials Androids as a central; the beacon is the degraded
    // half, and a degraded rung never fails the rung above it (§1).
    const share = jest.requireMock('../src/crews/share') as {
      holdCrewAdvertising: jest.Mock;
    };
    share.holdCrewAdvertising.mockImplementationOnce(async () => {
      throw new Error('Bluetooth is off');
    });
    await expect(startWalkieSession(POD)).resolves.toBeUndefined();
    expect(mockOrder).toContain('startWalkie');
    await stopWalkieSession();
  });
});

/**
 * THE FAILED START, AGAINST THE PRODUCTION CODE ITSELF (test-vacuity
 * addendum, 2026-08-27).
 *
 * THE FINDING THIS FILE EXISTS TO ANSWER, verbatim:
 *
 *   "a24's 627-line Process model clears pendingStart BEFORE failStart
 *   cleanup, but production pendingStarts remains >0 until outer lifecycle
 *   finally, while abandonFailedStart awaits its parked watcher. Thus
 *   model makes the exact race impossible and self-verifies the intended
 *   behavior."
 *
 * That is the worst kind of green: a model whose stepper cleared the very
 * flag the production fence reads, one line before the code under test
 * would have read it. Every arm above it passed and none of them could
 * have failed. A mirror can only ever be as honest as its own ordering,
 * and there is no way to audit that from inside the mirror.
 *
 * So this arm does not model anything. It calls the REAL
 * `startWalkieSession`, with the real lifecycle queue, the real
 * `pendingStarts`, the real `abandonFailedStart` and the real watcher,
 * and only the module boundary is doubled. The exact production sequence
 * it walks:
 *
 *   1. the native start REJECTS after the hold is taken;
 *   2. `abandonFailedStart` runs the shared teardown and the native stop
 *      answers DEBT, so the mirror parks and the watcher subscribes and
 *      queries;
 *   3. the arbiter's state is CLEAR by then — the debt settled in the gap
 *      — so the watcher's own query comes back clear;
 *   4. `pendingStarts` is STILL 1, because the verb's `finally` has not
 *      run: `abandonFailedStart` is inside `doStartWalkieSession`. The
 *      ordering fence refuses;
 *   5. the rejection surfaces, the `finally` decrements, and the re-drive
 *      asks again — which is the line this commit adds.
 *
 * ON a24b1e2 STEP 4 IS THE END OF THE STORY: the watcher latched `done`
 * on the clear STATE before asking whether it was allowed to act,
 * unsubscribed, and nothing ever asked again. The hold stranded for the
 * life of the process. This arm goes red there and green here, which is
 * the only thing that makes it worth having.
 */
describe('a failed start whose clear state lands mid-cleanup is not a stranded hold', () => {
  test('the mirror is refused while the start is pending, then RE-DRIVEN, and released exactly once', async () => {
    const walkie = jest.requireMock('../src/crews/walkie') as {
      startWalkie: jest.Mock;
      walkieAirtimeState: jest.Mock;
    };
    walkie.startWalkie.mockImplementationOnce(async () => {
      throw new Error('the radio refused');
    });
    // The close could not prove the advertiser down: the arbiter took the
    // debt transfer, so the hold stands and the mirror must park.
    seam.stop = { v: 2, outcome: 'debt', why: 'advertiser-still-up', state: HOLDING };
    // …and by the time the watcher asks, the debt has already settled.
    // This is the gap the whole mechanism is about: the state went clear
    // while nobody with permission to act on it was looking.
    seam.state = CLEAR;

    await expect(startWalkieSession(POD)).rejects.toThrow('the radio refused');
    // THE CAMPER'S OWN ERROR SURVIVED THE TEARDOWN — the rejection above
    // is the start's, not a cleanup step's.

    // Mutation: latch the watcher on the clear STATE rather than on a
    // release that RAN (the a24 shape). The first query is refused by the
    // pending fence, the watch is gone, and this stays at zero forever.
    await settleMicrotasks();
    expect(mockOrder.filter(x => x === 'release')).toHaveLength(1);

    // …and it was the RE-DRIVE that did it, not a straight-through: the
    // level was asked twice, once before the decrement and once after.
    // Mutation: delete the redrive in startWalkieSession's finally and
    // this drops to one ask and zero releases.
    expect(walkie.walkieAirtimeState.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The park is over, by its own account.
    expect(walkieHoldReason()).toBe('none');
  });

  test('a start that fails with the slot still OCCUPIED parks and never releases', async () => {
    // THE OTHER HALF, and the one a re-drive must not break. The arbiter
    // is still holding — a debt that did NOT settle — so every road,
    // including the re-drive, must refuse. Handing the slot back because
    // a start failed would be the overflow overlap arriving through the
    // error path.
    const walkie = jest.requireMock('../src/crews/walkie') as {
      startWalkie: jest.Mock;
    };
    walkie.startWalkie.mockImplementationOnce(async () => {
      throw new Error('the radio refused');
    });
    seam.stop = { v: 2, outcome: 'debt', why: 'advertiser-still-up', state: HOLDING };
    seam.state = HOLDING;

    await expect(startWalkieSession(POD)).rejects.toThrow('the radio refused');
    await settleMicrotasks();
    expect(mockOrder.filter(x => x === 'release')).toHaveLength(0);
    // Adopted, watching, and still holding: the hold has an owner and a
    // road out, which is what separates a park from a strand.
    expect(walkieHoldReason()).toBe('watching');

    // A STALE CLEAR CANNOT END IT (S5). This body describes the world at
    // revision 4 — BEFORE the hold this watch adopted at revision 7 — and
    // every other fence waves it through: no session, the right
    // generation, nothing pending. The revision is the only thing that
    // knows it is describing a world two ownership changes ago.
    //
    // Mutation: compare `Number(a.revision) - Number(b.revision)`. It
    // agrees with the real rule everywhere a bench will look and
    // disagrees above 2^53, where two different revisions are the SAME
    // Number and this refusal silently becomes a release.
    for (const cb of [...seam.listeners]) {
      cb(CLEAR);
    }
    await settleMicrotasks();
    expect(mockOrder.filter(x => x === 'release')).toHaveLength(0);
    // …and the watch is STILL LIVE after that refusal (S6): a refused
    // release is not a finished job, and a watch that latched here would
    // strand the hold on the next real settlement.
    expect(walkieHoldReason()).toBe('watching');

    // …and the settlement that actually describes a later world pays it
    // off, through the same one release every other road goes through.
    for (const cb of [...seam.listeners]) {
      cb(SETTLED);
    }
    await settleMicrotasks();
    expect(mockOrder.filter(x => x === 'release')).toHaveLength(1);
  });

  test('a native that answers a shape this JS cannot read parks with a REASON', async () => {
    // THE PRIOR-NATIVE SKEW ARM (acceptance detail 1). New JS, previous
    // native: the query answers the old era's bare `{ why }` — no wire
    // version, no incarnation, no phase — and the real decoder is what
    // classifies it.
    //
    // THE OUTCOME MUST BE STRUCTURED, NOT SILENT: "must produce explicit
    // incompatible/degraded outcome, not null watcher forever; current
    // code strands refused-stop hold." An event fallback is not available
    // and never was — the event carries the SAME body as the query, so a
    // native whose answer we cannot read emits events we cannot read
    // either, and a watcher left on it waits forever on a shape that will
    // never arrive.
    const walkie = jest.requireMock('../src/crews/walkie') as {
      startWalkie: jest.Mock;
    };
    walkie.startWalkie.mockImplementationOnce(async () => {
      throw new Error('the radio refused');
    });
    seam.stop = { why: 'advertiser' }; // the previous era's rejection body
    seam.capability = 'incompatible';
    seam.state = null;

    await expect(startWalkieSession(POD)).rejects.toThrow('the radio refused');
    await settleMicrotasks();
    // The hold stands — an unreadable answer has proved no radio quiet.
    expect(mockOrder.filter(x => x === 'release')).toHaveLength(0);
    // …and it stands FOR A REASON anyone can read, rather than behind a
    // subscription that will never fire. Mutation: return 'watching' here
    // and the strand is back, wearing a cure's name.
    expect(walkieHoldReason()).toBe('incompatible');
    // Nothing is left listening on a shape that cannot arrive.
    expect(seam.listeners.size).toBe(0);
  });
});

describe('the mini-bar composes intent with visibility (codex seam, 2026-08-27)', () => {
  // panelOpen is the camper's Hide/Show intent; stageVisible is whether
  // that stage is actually on screen. A stage the camper wants open but
  // has walked away from — another pane, another pod, another tab — is a
  // hot radio with nothing on screen admitting it. Mutation: read
  // panelOpen alone (the old rule) and the bar stays suppressed exactly
  // when it is the only honest thing left.
  const {
    walkieMiniBarShown,
    setWalkieStageVisible,
    walkieSessionState,
  } = require('../src/crews/walkieSession');
  const on = {
    session: POD,
    peers: [],
    peerRows: [],
    talkingTo: 0,
    call: null,
  };

  test('a wanted-but-hidden stage still gets the bar; a visible one does not', () => {
    expect(walkieMiniBarShown({ ...on, panelOpen: true, stageVisible: false })).toBe(true);
    expect(walkieMiniBarShown({ ...on, panelOpen: true, stageVisible: true })).toBe(false);
    expect(walkieMiniBarShown({ ...on, panelOpen: false, stageVisible: true })).toBe(true);
    expect(walkieMiniBarShown({ ...on, session: null, panelOpen: false, stageVisible: false })).toBe(false);
  });

  test('the card reports visibility through its own setter, idempotently', () => {
    const rev = () => require('../src/crews/walkieSession').walkieSessionRevision();
    setWalkieStageVisible(true);
    expect(walkieSessionState().stageVisible).toBe(true);
    const r = rev();
    setWalkieStageVisible(true); // no change, no churn
    expect(rev()).toBe(r);
    setWalkieStageVisible(false);
    expect(walkieSessionState().stageVisible).toBe(false);
  });
});
