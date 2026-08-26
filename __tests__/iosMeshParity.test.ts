/**
 * iOS MESH FAST-PATH PARITY.
 *
 * The delivery clock in meshResponsiveness.test.ts is asserted entirely in
 * JS, against a radio.ts that calls BOTH of the fast-path hooks through
 * OPTIONAL guards. Guards are exactly the shape that passes a green suite
 * while one platform quietly keeps the slow cadence: `native?.setScanMode`
 * on a module that never exported it is not a failure, it is a no-op, and
 * an iPhone whose Swift server never emits CrewSyncServed simply waits out
 * its cooldown while the Android phone next to it does not. Nothing in a JS
 * harness can see either.
 *
 * So this suite reads the native sources, in the walkieCap idiom, and holds
 * the two modules to ONE contract:
 *
 *  - the reciprocity event exists, is named identically on both sides, is
 *    emitted at the same moment (the last digest frame, once per pull,
 *    after the response), and is a name JS actually listens for;
 *  - the scan posture is a stored, two-way knob on both sides — the frugal
 *    return arc asserted as hard as the fast direction, because that is the
 *    battery half of the bargain and the half a mutation deletes first;
 *  - and the iOS bridge's exported surface satisfies every call site radio.ts
 *    and meshSync.ts aim at the module, with zero JS changes.
 *
 * Each assertion names the mutation it dies on.
 */

// Suites are SCRIPTS, not modules: a top-level const is GLOBAL to the tsc
// program, so these names carry the suite prefix (see advertiserInPlace).
const readParitySrc = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const PARITY_KT = 'android/app/src/main/java/com/playapal/CrewBeaconModule.kt';
const PARITY_SWIFT = 'ios/PlayaPal/CrewBeacon.swift';
const PARITY_BRIDGE = 'ios/PlayaPal/CrewBeaconBridge.m';
const PARITY_RADIO = 'src/crews/radio.ts';
const PARITY_MESH = 'src/crews/meshSync.ts';

/**
 * The iOS module's real JS-visible surface: RCT_EXTERN_METHOD is what
 * actually reaches NativeModules.CrewBeacon, so the bridge file — not a
 * hand-written mock, and not the Swift @objc annotations — is the honest
 * source for "what an iPhone answers to".
 */
const paritySwiftExports = (src: string): string[] => {
  const re = /RCT_EXTERN_METHOD\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(src);
  while (m) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
};

/** Every method the crew JS calls on the native module. */
const parityCallSites = (src: string): string[] => {
  const re = /\bnative[?]?\.([A-Za-z][A-Za-z0-9]*)\s*\(/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(src);
  while (m) {
    out.push(m[1]);
    m = re.exec(src);
  }
  return out;
};

describe('CrewSyncServed is one event with one meaning on both phones', () => {
  const kt = readParitySrc(PARITY_KT);
  const swift = readParitySrc(PARITY_SWIFT);
  const radio = readParitySrc(PARITY_RADIO);

  test('both servers declare the same event name JS listens for', () => {
    // Mutation: rename either constant. The emitter keeps emitting, the
    // listener keeps listening, and they never meet — a dial-back that
    // silently never happens on one platform.
    expect(kt).toMatch(/SYNC_SERVED_EVENT = "CrewSyncServed"/);
    expect(swift).toMatch(/syncServedEvent = "CrewSyncServed"/);
    expect(radio).toMatch(/'CrewSyncServed'/);
  });

  test('the Swift emitter declares the event, or RN drops it on the floor', () => {
    // Mutation: leave syncServedEvent out of supportedEvents(). RCTEventEmitter
    // warns once into a device log nobody is reading at 3am and discards
    // every send — the hook looks implemented and does nothing.
    const supported = /func supportedEvents\(\) -> \[String\]! \{([\s\S]{0,240}?)\}/.exec(swift)?.[1];
    expect(supported).toBeDefined();
    expect(supported).toMatch(/Self\.syncServedEvent/);
  });

  test('both fire on the LAST digest frame, once per completed pull', () => {
    // Mutation: emit on every read instead of at the end of the stream.
    // A multi-frame digest becomes a burst of dial-backs at whoever is
    // pulling from us — the connect storm NUDGE_MIN_GAP_MS exists to
    // prevent, arriving from below it.
    expect(kt).toMatch(/digestServed = cur \+ 1 >= total/);
    expect(swift).toMatch(/digestServed = cur \+ 1 >= total/);
    // ...and both compute it inside the offset==0 build, so the MTU
    // continuations of one frame never re-fire it. iOS negotiates a ~185
    // byte MTU against our 484-byte frames, so this is three chances to
    // double-fire on every single pull.
    expect(kt).toMatch(/if \(offset == 0\)[\s\S]{0,1400}digestServed = cur \+ 1 >= total/);
    expect(swift).toMatch(/if request\.offset == 0 \{[\s\S]{0,900}digestServed = cur \+ 1 >= total/);
  });

  test('both emit AFTER answering the read, never before', () => {
    // Mutation: emit before sendResponse/respond. The bridge hop now sits
    // in front of the GATT response, so the reciprocity optimisation makes
    // the very read it is optimising slower — and on iOS a peripheral that
    // dawdles inside didReceiveRead is the one that gets timed out.
    const ktResponse = kt.indexOf('GATT_SUCCESS, offset, value');
    const ktEmit = kt.indexOf('emit(SYNC_SERVED_EVENT');
    expect(ktResponse).toBeGreaterThan(-1);
    expect(ktEmit).toBeGreaterThan(ktResponse);

    const swiftResponse = swift.indexOf('respond(to: request, withResult: .success)');
    const swiftEmit = swift.indexOf('withName: Self.syncServedEvent');
    expect(swiftResponse).toBeGreaterThan(-1);
    expect(swiftEmit).toBeGreaterThan(swiftResponse);
  });

  test('the event carries an address and nothing else', () => {
    // Mutation: attach digest bytes or message ids "for debugging". This
    // event crosses no consent boundary today precisely because it is a
    // bare peer id; content on it would leak a mailbox to any stranger who
    // can read a characteristic.
    expect(kt).toMatch(/m\.putString\("peerId", addr\)[\s\S]{0,80}emit\(SYNC_SERVED_EVENT, m\)/);
    expect(swift).toMatch(
      /withName: Self\.syncServedEvent, body: \["peerId": central\.uuidString\]/,
    );
  });
});

describe('the scan posture is a two-way knob on both phones', () => {
  const kt = readParitySrc(PARITY_KT);
  const swift = readParitySrc(PARITY_SWIFT);

  test('both modules default to the FRUGAL posture', () => {
    // Mutation: default either to the fast posture. A phone that never
    // hears from JS — sharing off, a build where the guard is dropped —
    // then burns the low-latency duty cycle forever, which at BRC is the
    // battery the owner needs at 3am, spent on nobody.
    expect(kt).toMatch(/private var scanLowLatency = false/);
    expect(swift).toMatch(/private var scanLowLatency = false/);
  });

  test('the duty cycle READS the stored posture instead of a literal', () => {
    // Mutation: hardcode the fast setting back into the scan call. The
    // stored posture becomes decoration, and setScanMode(false) — the
    // background and stop arcs both — quietly does nothing.
    expect(kt).toMatch(
      /if \(scanLowLatency\) ScanSettings\.SCAN_MODE_LOW_LATENCY[\s\S]{0,80}SCAN_MODE_BALANCED/,
    );
    expect(swift).toMatch(
      /CBCentralManagerScanOptionAllowDuplicatesKey: scanLowLatency/,
    );
    // The literal `true` this replaced must not survive anywhere: the
    // module scanned with duplicates unconditionally on before this lane.
    expect(swift).not.toMatch(/CBCentralManagerScanOptionAllowDuplicatesKey: true/);
  });

  test('one scan bring-up serves both the start path and the flip', () => {
    // Mutation: give the posture flip its own scanForPeripherals call. The
    // two copies drift, and the one nobody is testing is the one that runs
    // for the twelve hours the phone is in a pocket.
    expect(kt).toMatch(/private fun startScanInternal\(/);
    expect(swift).toMatch(/private func beginScan\(_ central: CBCentralManager\)/);
    expect(swift).toMatch(
      /func setScanMode\([\s\S]{0,1400}self\.beginScan\(central\)/,
    );
    expect(swift).toMatch(/case \.poweredOn:[\s\S]{0,400}beginScan\(central\)/);
  });

  test('a flip while scanning does not report the radio as interrupted', () => {
    // Mutation: emitState() between the stop and the restart. `scanning`
    // is momentarily false, session.ts's honesty machine reads a radio
    // interruption, and the pod card tells the truth about a lie — the
    // "knows and does not say" bug's mirror image.
    // `\n {2}\}` is a method's closing brace at class indentation — the end
    // of setScanMode and not the end of some block inside it.
    const flip = /func setScanMode\([\s\S]{0,1600}?\n {2}\}/.exec(swift)?.[0];
    expect(flip).toBeDefined();
    expect(flip).not.toMatch(/emitState\(/);
  });

  test('iOS keeps re-reporting peers in the frugal posture', () => {
    // THE PLATFORM ASYMMETRY, and the mutation that looks like a cleanup:
    // delete the rescan tick and let frugal be a plain `allowDuplicates:
    // false`. Android's BALANCED still reports a peer it has already seen;
    // CoreBluetooth's duplicates-off reports each peripheral ONCE per scan
    // session and then never again. Every backgrounded iPhone's podmates
    // would age out of presence's live window while the radio was still
    // hearing them perfectly — fidelity degrading into MEMBERSHIP, which
    // docs/WALKIE-LADDER.md §1 forbids in as many words.
    expect(swift).toMatch(/private static let frugalRescanInterval: TimeInterval = 30/);
    expect(swift).toMatch(/private func armRescan\(\)/);
    expect(swift).toMatch(/guard !scanLowLatency else \{ return \}/);
    // It re-reports by stop+start, because that is the only thing that
    // makes CoreBluetooth surface an already-discovered peripheral again.
    expect(swift).toMatch(
      /armRescan\(\)[\s\S]{0,900}central\.stopScan\(\)\s*\n\s*central\.scanForPeripherals\(/,
    );
  });

  test('the tick dies with the scan on every arc that stops it', () => {
    // Mutation: forget one cancelRescan(). A repeating timer outlives the
    // session that justified it and pokes a stopped — or powered-off —
    // central twice a minute for as long as the app lives.
    const stopScan = /func stopScan\([\s\S]{0,400}?\n {2}\}/.exec(swift)?.[0];
    const stopAll = /func stopAll\([\s\S]{0,1400}?\n {2}\}/.exec(swift)?.[0];
    const poweredOff = /case \.poweredOff:[\s\S]{0,700}?emitState\("Bluetooth is off"\)/g;
    expect(stopScan).toMatch(/cancelRescan\(\)/);
    expect(stopAll).toMatch(/cancelRescan\(\)/);
    // Two poweredOff arcs (peripheral + central); the central one owns the
    // scan, so at least one must cancel and the timer body re-checks state
    // anyway.
    expect(swift.match(poweredOff)?.some(b => /cancelRescan\(\)/.test(b))).toBe(true);
  });

  test('the tick is cancelled on the thread that installed it', () => {
    // Mutation: collapse cancelRescan to a bare invalidate(). The timer is
    // installed on main (beginScan runs on the CoreBluetooth queue) but
    // stopScan and stopAll arrive on React Native's method queue, and
    // Foundation's contract is that a Timer is invalidated from its own
    // thread or not at all. The failure is silent and is exactly the leak
    // the test above believes it already closed.
    expect(swift).toMatch(
      /private func cancelRescan\(\)[\s\S]{0,500}Thread\.isMainThread/,
    );
    // armRescan cancels INLINE — it is already on main, so the guard above
    // takes the synchronous path. Defer it and the cancel would land after
    // the scheduledTimer below and kill the timer it had just installed.
    expect(swift).toMatch(/private func armRescan\(\) \{\n {4}cancelRescan\(\)/);
  });
});

describe('the iOS module satisfies the JS call sites with zero JS changes', () => {
  const bridge = readParitySrc(PARITY_BRIDGE);
  const exported = paritySwiftExports(bridge);

  test('every crew call site is an exported iOS method', () => {
    // Mutation: implement setScanMode in Swift and forget the bridge line.
    // @objc alone does not reach JS — the module answers to nothing new,
    // radio.ts's optional guard swallows it, and the iPhone keeps the slow
    // cadence exactly as it did before the work.
    const wanted = new Set([
      ...parityCallSites(readParitySrc(PARITY_RADIO)),
      ...parityCallSites(readParitySrc(PARITY_MESH)),
    ]);
    // Phase C's foreground service is Android's; the iOS module keeps
    // no-op twins so JS can call them unconditionally, and they ARE
    // exported — so nothing is exempt here.
    const missing = [...wanted].filter(n => !exported.includes(n));
    expect(missing).toEqual([]);
    expect(wanted.has('setScanMode')).toBe(true);
  });

  test('the posture knob is bridged as a BOOL, matching Kotlin', () => {
    // Mutation: bridge it as NSNumber/NSString. RN would hand Swift a type
    // it cannot coerce and the call rejects at runtime — inside a try/catch
    // that exists to survive a dead radio, so the failure is invisible.
    expect(bridge).toMatch(/RCT_EXTERN_METHOD\(setScanMode:\(BOOL\)lowLatency/);
    expect(readParitySrc(PARITY_KT)).toMatch(/fun setScanMode\(lowLatency: Boolean/);
  });
});

// ---------------------------------------------------------------- live JS

/**
 * The other half of "zero JS changes": drive radio.ts against a native
 * module built FROM THE BRIDGE FILE, so the surface under test is the one
 * an iPhone actually exposes rather than a mock that agrees with the code.
 */
jest.mock('react-native', () => {
  const fs = require('fs');
  const bridgeSrc = fs.readFileSync('ios/PlayaPal/CrewBeaconBridge.m', 'utf8') as string;
  const re = /RCT_EXTERN_METHOD\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  const CrewBeacon: Record<string, unknown> = {};
  let m: RegExpExecArray | null = re.exec(bridgeSrc);
  while (m) {
    CrewBeacon[m[1]] = jest.fn(async () => undefined);
    m = re.exec(bridgeSrc);
  }
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  class NativeEventEmitter {
    addListener(name: string, cb: (e: unknown) => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return {
        remove: () => {
          listeners.set(name, (listeners.get(name) ?? []).filter(x => x !== cb));
        },
      };
    }
  }
  return {
    NativeModules: { CrewBeacon },
    NativeEventEmitter,
    Platform: { OS: 'ios', Version: 0 },
    PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
    __crewListeners: listeners,
  };
});

import { onSyncServed, setScanPosture } from '../src/crews/radio';

const parityRN = jest.requireMock('react-native') as {
  NativeModules: { CrewBeacon: Record<string, jest.Mock> };
  __crewListeners: Map<string, Array<(e: unknown) => void>>;
};

const parityEmit = (name: string, body: unknown): void => {
  for (const cb of parityRN.__crewListeners.get(name) ?? []) {
    cb(body);
  }
};

describe('the guards in radio.ts light up on an iOS-shaped module', () => {
  test('setScanPosture now reaches the native knob instead of no-opping', async () => {
    // Mutation: drop setScanMode from the bridge. This test dies, and the
    // failure names the reason the iPhone would have stayed slow.
    await setScanPosture(true);
    await setScanPosture(false);
    expect(parityRN.NativeModules.CrewBeacon.setScanMode.mock.calls).toEqual([
      [true],
      [false],
    ]);
  });

  test('a CrewSyncServed event reaches the reciprocity callback', async () => {
    const seen: string[] = [];
    const off = onSyncServed(({ peerId }) => seen.push(peerId));
    // The peripheral-side identity of a central: on iOS a UUID string, on
    // Android a MAC. Both are opaque to this seam.
    parityEmit('CrewSyncServed', { peerId: 'B0F5E0A2-0000-4000-8000-00000000FEED' });
    parityEmit('CrewSyncServed', { peerId: 42 }); // not a string: ignored
    off();
    parityEmit('CrewSyncServed', { peerId: 'AA:BB:CC:DD:EE:01' }); // after off
    expect(seen).toEqual(['B0F5E0A2-0000-4000-8000-00000000FEED']);
  });

  test('the optional guard still protects a module without the knob', async () => {
    // The guard is not vestigial now that both platforms implement it: an
    // older build on a phone that has not updated, or a future third
    // module, must degrade to its own cadence rather than throw inside a
    // posture flip. Proven by removing the method, not by reading the code.
    let radioNoKnob: typeof import('../src/crews/radio') | undefined;
    jest.isolateModules(() => {
      const rn = require('react-native');
      delete rn.NativeModules.CrewBeacon.setScanMode;
      radioNoKnob = require('../src/crews/radio');
    });
    await expect(radioNoKnob!.setScanPosture(true)).resolves.toBeUndefined();
  });
});
