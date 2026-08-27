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
declare global {
  // eslint-disable-next-line no-var
  var __airtimeNative: string[] | undefined;
  // eslint-disable-next-line no-var
  var __airtimeOrder: string[] | undefined;
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
    }),
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
} from '../src/crews/walkieSession';

const PAYLOAD = new Uint8Array([1, 2, 3]);
/** Every native verb the crew beacon was asked for, in order. */
const mockNativeCalls = globalThis.__airtimeNative!;
/** …and every seam of the walkie's own lifecycle, in the same shape, so
 * the hold and the walkie's advertiser can be compared as a SEQUENCE. */
const mockOrder = globalThis.__airtimeOrder!;

const POD = {
  crewId: 'pod-1',
  crewCode: 'dusty llamas',
  myCardId: 'me',
  myName: 'Pug',
};

beforeEach(() => {
  mockNativeCalls.length = 0;
  mockOrder.length = 0;
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
      await nativeStop();
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
