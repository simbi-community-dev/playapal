/**
 * Radio honesty and bounce recovery (src/crews/session.ts), pinned against
 * the two defects MEASURED on two phones on 2026-08-24:
 *
 *  1. Bluetooth was disabled under a live share session. The switch still
 *     read checked, the copy still promised the pod could see you, and the
 *     foreground service kept ticking. Nothing in src/ listened to the
 *     CrewBeaconState events both native modules have always emitted.
 *  2. Bluetooth came back and the phone stayed invisible: the service went
 *     on calling setPayload into a module that was no longer advertising
 *     (PlayaMesh `advertise//payload bytes=21 advertising=false`, never an
 *     `advertise//started`). Cycling the switch by hand was the workaround.
 *
 * Everything here is injected — a fake radio and hand-fed state events, no
 * native modules — the same discipline as crewBeacon.test.ts. The events
 * are the exact shapes the two modules emit (Kotlin emitState /
 * Swift emitState), so this suite is the contract between them and the UI.
 */

import {
  CrewRadio,
  masterOff,
  noteRadioState,
  radioDownReason,
  radioInterrupted,
  sessionRevision,
  startSharing,
} from '../src/crews/session';

const CENTER = { lat: 40.783242, lon: -119.207871 };
const CODE = 'amber-lantern-31';
const MY_CARD = 'card-me';
const T0 = 1_756_000_000_000;
const POS = { lat: 40.7855, lon: -119.2065 };

function makeRadio() {
  const calls: string[] = [];
  let heard: ((b: Uint8Array) => void) | undefined;
  let failScan: string | null = null;
  const radio: CrewRadio = {
    advertise: async () => {
      calls.push('advertise');
    },
    stopAdvertising: async () => {
      calls.push('stopAdvertising');
    },
    startScan: async cb => {
      calls.push('startScan');
      if (failScan) {
        const why = failScan;
        failScan = null;
        throw new Error(why);
      }
      heard = cb;
    },
    stopScan: async () => {
      calls.push('stopScan');
    },
  };
  return {
    radio,
    calls,
    hear: (b: Uint8Array) => heard?.(b),
    breakNextScan: (why: string) => {
      failScan = why;
    },
  };
}

function makeSession(r: ReturnType<typeof makeRadio>, pos = POS) {
  return startSharing({
    radio: r.radio,
    crewCode: CODE,
    myCardId: MY_CARD,
    center: CENTER,
    getPosition: () => pos,
    knownCrewCodes: () => [CODE],
    now: () => T0,
  });
}

/** Drain the microtask queue: resumeRadio() is an async chain of awaits
 * with no timers in it, so a handful of turns settles it deterministically
 * without touching the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

/** The Android module's event shape (CrewBeaconModule.emitState). */
const adapterOff = { advertising: false, scanning: false, adapterEnabled: false, error: 'Bluetooth is off' };
const adapterOn = { advertising: false, scanning: false, adapterEnabled: true };
const healthy = { advertising: true, scanning: true, adapterEnabled: true };

afterEach(async () => {
  await masterOff();
});

describe('radio honesty', () => {
  test('no session: no interruption, whatever the radio says', () => {
    noteRadioState(adapterOff);
    expect(radioInterrupted()).toBeNull();
  });

  test('a live session goes INTERRUPTED when the adapter dies — never silently off', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    expect(radioInterrupted()).toBeNull();

    noteRadioState(adapterOff);

    // The session is STILL active (the user never turned it off) and the
    // UI now has a reason to render instead of the visibility promise.
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });
    await s.stop();
  });

  test('the interruption bumps the session revision, so the switch re-renders', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    const before = sessionRevision();
    noteRadioState(adapterOff);
    expect(sessionRevision()).toBeGreaterThan(before);
    // Same truth twice must NOT re-render.
    const settled = sessionRevision();
    noteRadioState(adapterOff);
    expect(sessionRevision()).toBe(settled);
    await s.stop();
  });

  test('a quiet advertising:false is NOT an interruption (no GPS fix is a different truth)', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState({ advertising: false, scanning: true, adapterEnabled: true });
    expect(radioInterrupted()).toBeNull();
    await s.stop();
  });

  test('reasons separate: permission needs the user, the adapter does not', () => {
    expect(radioDownReason(adapterOff)).toBe('bluetooth-off');
    expect(
      // The exact strings the two modules emit.
      radioDownReason({ advertising: false, scanning: false, adapterEnabled: true, error: 'permission android.permission.BLUETOOTH_ADVERTISE' }),
    ).toBe('permission');
    expect(
      radioDownReason({ advertising: false, scanning: true, adapterEnabled: true, error: 'Bluetooth permission denied' }),
    ).toBe('permission');
    expect(
      radioDownReason({ advertising: false, scanning: true, adapterEnabled: true, error: 'advertise failed (3)' }),
    ).toBe('advertise-failed');
    expect(
      radioDownReason({ advertising: true, scanning: false, adapterEnabled: true, error: 'scan failed (2)' }),
    ).toBe('advertise-failed');
    expect(radioDownReason(healthy)).toBeNull();
    // An emitter that cannot answer for the adapter reads as UNCHANGED,
    // never as off — the iOS pre-manager case.
    expect(radioDownReason({ advertising: true, scanning: true })).toBeNull();
  });

  test('stopping while interrupted leaves no ghost badge', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState(adapterOff);
    await s.stop();
    expect(radioInterrupted()).toBeNull();
  });
});

describe('bounce recovery', () => {
  test('the adapter returning re-arms scan AND advertise without a user tap', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    expect(r.calls).toEqual(['startScan', 'advertise']);

    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush(); // let resumeRadio's chain run

    // THE fix for defect 2: the scan is restarted (the tick never does it)
    // and a fresh beacon goes out. Before this, the session ticked
    // setPayload forever and nothing was ever on the air again.
    expect(r.calls).toEqual(['startScan', 'advertise', 'startScan', 'advertise']);
    expect(radioInterrupted()).toBeNull();
    await s.stop();
  });

  test('a sighting heard after the bounce still lands — the callback was re-wired', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();
    expect(() => r.hear(new Uint8Array(21))).not.toThrow();
    await s.stop();
  });

  test('one resume per bounce, however many events arrive', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    noteRadioState(adapterOn);
    noteRadioState(healthy);
    await flush();
    expect(r.calls.filter(c => c === 'startScan')).toHaveLength(2);
    await s.stop();
  });

  test('a REVOKED PERMISSION does not auto-recover — that one needs the user', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState({
      advertising: false,
      scanning: false,
      adapterEnabled: true,
      error: 'permission android.permission.BLUETOOTH_SCAN',
    });
    expect(radioInterrupted()).toEqual({ down: true, why: 'permission' });

    noteRadioState(adapterOn);
    await flush();
    // No re-arm: retrying a missing grant is a lie in a loop. The state
    // stays honest until the UI's in-context ask changes it.
    expect(r.calls).toEqual(['startScan', 'advertise']);
    expect(radioInterrupted()).toEqual({ down: true, why: 'permission' });
    await s.stop();
  });

  test('a resume that fails leaves the session interrupted, not falsely healthy', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState(adapterOff);
    r.breakNextScan('bluetooth-off');
    noteRadioState(adapterOn);
    await flush();
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });

    // And the NEXT clean adapter event still recovers: one failure must not
    // wedge the recovery path for the rest of the session.
    noteRadioState(adapterOn);
    await flush();
    expect(radioInterrupted()).toBeNull();
    await s.stop();
  });

  test('a session stopped mid-outage does not re-key the radio when the adapter returns', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    noteRadioState(adapterOff);
    await s.stop();
    const after = [...r.calls];
    noteRadioState(adapterOn);
    await flush();
    expect(r.calls).toEqual(after);
    expect(radioInterrupted()).toBeNull();
  });

  test('resumeRadio on a stopped session is a no-op (a straggler event after stop)', async () => {
    const r = makeRadio();
    const s = makeSession(r);
    await s.started;
    await s.stop();
    const after = [...r.calls];
    await s.resumeRadio();
    expect(r.calls).toEqual(after);
  });
});
