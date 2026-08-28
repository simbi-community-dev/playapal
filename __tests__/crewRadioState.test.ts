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
  startCrewSession,
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

/**
 * THE MESH READINESS BARRIER, HAND-DRIVEN — the stand-in for what share.ts
 * threads in from meshSync. Every MINT is recorded and settles only when
 * this arm says so, which is the whole point: the leg the session cannot
 * see for itself is the one the transaction has to wait for.
 *
 * `ack(n)` settles the nth mint the way a landed publish ack does; `stale`
 * settles it the way a superseded identity does (the mesh stopped, or
 * another session replaced it). Both are addressed by INDEX, so an arm can
 * settle the mint from BEFORE a bounce after the bounce has happened —
 * which is the staleness case, and cannot be written at all if the barrier
 * is minted once and shared.
 */
function makeDigestBarrier() {
  const settles: Array<(ok: boolean) => void> = [];
  return {
    /** The injectable itself: one call = one mint = one identity. */
    barrier: (): Promise<boolean> =>
      new Promise<boolean>(resolve => {
        settles.push(resolve);
      }),
    mints: () => settles.length,
    ack: (n = settles.length - 1) => settles[n]?.(true),
    stale: (n = settles.length - 1) => settles[n]?.(false),
  };
}

function makeSession(
  r: ReturnType<typeof makeRadio>,
  pos = POS,
  awaitMeshDigest?: () => Promise<boolean>,
) {
  return startCrewSession({
    radio: r.radio,
    shareCrewCode: CODE,
    myCardId: MY_CARD,
    center: CENTER,
    getPosition: () => pos,
    knownCrewCodes: () => [CODE],
    now: () => T0,
    awaitMeshDigest,
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

/**
 * THE RECOVERY TRANSACTION (2026-08-27, the cross-family IMMEDIATE BINDING
 * blocker on 4f4fd37).
 *
 * The honest open the review named: noteRadioState cleared `interrupted`
 * once resumeRadio's two legs settled — the scan restarted and a fresh
 * payload on the air — while the mesh's republish ack lived somewhere else
 * entirely and gated only what this phone will SERVE. Both radio legs are
 * true before any offer is installed, so the UI could report a recovered
 * session over a phone whose digest characteristic still answered the
 * not-ready frame: sharing reads as on, the pod's mailbox reads as empty,
 * and nothing anywhere is an error.
 *
 * So recovery is ONE transaction over THREE legs — scan, advertise payload,
 * and the CURRENT mesh digest publish ack — under one generation, and every
 * arm below is a way for that generation to stop being current.
 */
describe('the recovery transaction: three legs, one generation, one clear', () => {
  test('(a) the digest leg HELD keeps the session interrupted, however green the radio looks', async () => {
    // Mutation (the clear-on-two-legs plant): settle the transaction on the
    // scan and the payload and let the digest ack land whenever it lands.
    const r = makeRadio();
    const b = makeDigestBarrier();
    const s = makeSession(r, POS, b.barrier);
    await s.started;

    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();

    // LEGS 1 AND 2 ARE DONE: the scan is back and a fresh beacon went out.
    expect(r.calls).toEqual(['startScan', 'advertise', 'startScan', 'advertise']);
    // …and exactly one digest leg was minted, at the bounce.
    expect(b.mints()).toBe(1);
    // THE SESSION IS STILL HONEST. Nothing this phone serves has been acked
    // since the adapter withdrew it, so a podmate dialling us right now
    // reads the not-ready frame — which is not a recovered session.
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });

    // And a healthy radio event cannot talk it out of that either: the
    // radio's own account of itself is exactly the evidence that is not
    // enough. It also starts no second transaction.
    noteRadioState(healthy);
    await flush();
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });
    expect(b.mints()).toBe(1);
    await s.stop();
  });

  test('(b) the CURRENT ack clears the interruption exactly once', async () => {
    const r = makeRadio();
    const b = makeDigestBarrier();
    const s = makeSession(r, POS, b.barrier);
    await s.started;

    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();
    const held = sessionRevision();

    b.ack();
    await flush();
    expect(radioInterrupted()).toBeNull();
    const cleared = sessionRevision();
    expect(cleared).toBeGreaterThan(held);

    // A SECOND ACK FOR THE SAME MINT IS NOT A SECOND RECOVERY: no second
    // clear, and no re-render behind it.
    b.ack();
    await flush();
    expect(radioInterrupted()).toBeNull();
    expect(sessionRevision()).toBe(cleared);
    await s.stop();
  });

  test('(c) a STALE ack — the outage moved on under it — cannot clear', async () => {
    // The pre-bounce identity, said in the session's own terms: the digest
    // leg minted for the FIRST bounce settles after a SECOND outage has
    // been classified. Its scan and its payload describe a radio that is
    // down again, so its ack proves nothing about now.
    const r = makeRadio();
    const b = makeDigestBarrier();
    const s = makeSession(r, POS, b.barrier);
    await s.started;

    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();
    expect(b.mints()).toBe(1);

    noteRadioState(adapterOff); // down again, under the transaction
    b.ack(0); // …and the first bounce's ack arrives at last
    await flush();
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });

    // THE NEW OUTAGE MINTS ITS OWN LEG — the stale transaction's latch did
    // not swallow the second adapter-on — and THAT one clears.
    noteRadioState(adapterOn);
    await flush();
    expect(b.mints()).toBe(2);
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });
    b.ack(1);
    await flush();
    expect(radioInterrupted()).toBeNull();
    await s.stop();
  });

  test('(d) a replaced session: the dead transaction cannot clear the live one', async () => {
    const r = makeRadio();
    const b = makeDigestBarrier();
    const s = makeSession(r, POS, b.barrier);
    await s.started;
    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();
    expect(b.mints()).toBe(1);

    // The camper cycles the switch: a NEW session, its own radio, its own
    // barrier — and its own outage.
    await s.stop();
    const r2 = makeRadio();
    const b2 = makeDigestBarrier();
    const s2 = makeSession(r2, POS, b2.barrier);
    await s2.started;
    noteRadioState(adapterOff);
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });

    const calls2 = [...r2.calls];
    b.ack(0); // the DEAD session's digest leg, acked at last
    await flush();
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });
    // …and it re-keyed nothing on the live session's radio either.
    expect(r2.calls).toEqual(calls2);
    await s2.stop();
  });

  test('(d2) a stop mid-transaction: the ack lands on nobody', async () => {
    const r = makeRadio();
    const b = makeDigestBarrier();
    const s = makeSession(r, POS, b.barrier);
    await s.started;
    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();

    await s.stop();
    const after = [...r.calls];
    b.ack();
    await flush();
    expect(radioInterrupted()).toBeNull(); // no session, no badge
    expect(r.calls).toEqual(after);
  });

  test('(e) a SUPERSEDED digest leg leaves the interruption standing', async () => {
    // The barrier says false when the mesh identity it captured stopped or
    // was replaced. That is not an ack, so it is not a recovery — and the
    // next adapter-on may still try, because the latch was released.
    const r = makeRadio();
    const b = makeDigestBarrier();
    const s = makeSession(r, POS, b.barrier);
    await s.started;
    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();

    b.stale();
    await flush();
    expect(radioInterrupted()).toEqual({ down: true, why: 'bluetooth-off' });

    noteRadioState(adapterOn);
    await flush();
    expect(b.mints()).toBe(2);
    b.ack(1);
    await flush();
    expect(radioInterrupted()).toBeNull();
    await s.stop();
  });

  test('(f) NO MESH, NO THIRD LEG: recovery completes on the two radio legs', async () => {
    // Mutation (the unconditional-third-leg-wait plant): wait for a digest
    // ack even when nothing injected a barrier. A phone with no pod has no
    // mesh to publish anything, so that recovery could never complete —
    // the camper's radio comes back and the session goes on saying it did
    // not, for the rest of the evening.
    const r = makeRadio();
    const s = makeSession(r); // solo: no pod, no mesh, no barrier
    await s.started;

    noteRadioState(adapterOff);
    noteRadioState(adapterOn);
    await flush();

    expect(r.calls).toEqual(['startScan', 'advertise', 'startScan', 'advertise']);
    expect(radioInterrupted()).toBeNull();
    await s.stop();
  });
});
