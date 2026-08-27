/**
 * WalkiePanel's call seams — EVOLVED to the ownership move (lane
 * ring-anywhere, 2026-08-25). The contracts are the same three the 0.8.2
 * binding review traced; what changed is WHO holds them, and these tests
 * follow the contract rather than the file.
 *
 *  - TEARDOWN ORDER. Turning the walkie off must hand the runtime's bye to
 *    the native queue BEFORE stopWalkie closes the socket — the
 *    native-modules thread serializes them, so the order of the JS calls IS
 *    the order on the wire. The old order rejected every close-path bye as
 *    'idle' and the peer read "the link dropped" 8 s later instead of "hung
 *    up". It used to be enforced by React cleanup DEFINITION ORDER; it now
 *    lives in walkieSession.stopWalkieSession, and the pin moved with it.
 *  - CLOSING THE STAGE IS NOT CLOSING THE CHANNEL. The new half of the same
 *    contract: unmounting the panel (tab switch, pod switch) must leave the
 *    radio exactly as it was, while still releasing a held mic.
 *  - SUPPRESSION ARCS. The render gate stops NEW talk only; a talk already
 *    held when the call takes the mic must stop, and walkie playback must
 *    mute while the call runs and unmute on every end arc — from the
 *    SESSION now, because pod voice plays with the stage closed.
 *
 * The walkie and call-runtime modules are mocked at their seams so call
 * ORDER is observable; the session store, reducer and copy stay real.
 */
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

type Snap = {
  model: Record<string, unknown>;
  localStreamUrl: string | null;
  remoteStreamUrl: string | null;
};

declare global {
  var __seamOrder: string[] | undefined;
  var __seamRuntimes: { cb: ((s: Snap) => void) | null }[] | undefined;
  var __seamWalkieOn: { value: boolean } | undefined;
}

jest.mock('../src/crews/walkie', () => {
  const order: string[] = (globalThis.__seamOrder = globalThis.__seamOrder ?? []);
  // The channel flag and its revision emitter are REAL here (a tiny copy of
  // walkie.ts's own store): the session republishes them, and a mock that
  // could not close would hide exactly the arcs under test.
  const flag = (globalThis.__seamWalkieOn = globalThis.__seamWalkieOn ?? {
    value: false,
  });
  const watchers = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const w of [...watchers]) {
      w();
    }
  };
  return {
    WALKIE_DIAG_MS: 10_000,
    WALKIE_DOUBLETALK_MS: 3000,
    WALKIE_CHURN_MS: 60_000,
    linkChurnCopy: () => null,
    diagnoseWalkieSilence: jest.fn(async () => null),
    formatChannelNames: (entries: { name: string }[]) =>
      entries.map(e => e.name).join(', '),
    onWalkiePeers: jest.fn(() => () => {}),
    onWalkieSpeaking: jest.fn(() => () => {}),
    doubleTalkCopy: () => null,
    walkieCapCopy: () => null,
    walkieDiagnosisCopy: () => '',
    walkiePresent: () => true,
    // "Look again" is capability-gated on the native method. This panel
    // suite is about the SESSION seams, so the control is simply absent
    // here — which is also the honest shape of an older native build.
    walkieRefreshPresent: () => false,
    refreshWalkieDiscovery: jest.fn(async () => undefined),
    WALKIE_REFRESH_COPY: '',
    walkieOn: () => flag.value,
    walkieChannelRevision: () => revision,
    subscribeWalkieChannel: (cb: () => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    dedupeWalkiePeers: (rows: unknown[]) => rows,
    startTalking: jest.fn(async () => {
      order.push('startTalking');
    }),
    startWalkie: jest.fn(async () => {
      order.push('startWalkie');
      flag.value = true;
      notify();
    }),
    stopTalking: jest.fn(async () => {
      order.push('stopTalking');
    }),
    stopWalkie: jest.fn(async () => {
      order.push('stopWalkie');
      flag.value = false;
      notify();
    }),
    setWalkieCallMuted: jest.fn(async () => {}),
  };
});

jest.mock('../src/crews/callRuntime', () => {
  const order: string[] = (globalThis.__seamOrder = globalThis.__seamOrder ?? []);
  const runtimes: { cb: ((s: Snap) => void) | null }[] =
    (globalThis.__seamRuntimes = globalThis.__seamRuntimes ?? []);
  const idleModel = {
    phase: 'idle',
    callId: null,
    peerHash: null,
    peerName: null,
    offerer: false,
    userMuted: false,
    backgrounded: false,
    endedReason: null,
  };
  class FakeRuntime {
    cb: ((s: Snap) => void) | null = null;
    constructor() {
      runtimes.push(this);
    }
    start() {}
    destroy() {
      order.push('destroy');
    }
    subscribe(cb: (s: Snap) => void) {
      this.cb = cb;
      return () => {};
    }
    snapshot(): Snap {
      return { model: idleModel, localStreamUrl: null, remoteStreamUrl: null };
    }
    notePeers() {}
    place() {}
    answer() {}
    decline() {}
    hangUp() {}
    dismiss() {}
    toggleVideo() {}
    flipCamera() {}
  }
  return { callsPresent: () => true, CallRuntime: FakeRuntime };
});

jest.mock('../src/crews/radio', () => ({
  ensureCrewPermissions: jest.fn(async () => true),
}));

import { WalkiePanel } from '../src/crews/WalkiePanel';
import { __resetWalkieSessionForTests } from '../src/crews/walkieSession';

const order = globalThis.__seamOrder!;
const runtimes = globalThis.__seamRuntimes!;
const walkieFlag = globalThis.__seamWalkieOn!;
const walkieMock = jest.requireMock('../src/crews/walkie') as {
  stopTalking: jest.Mock;
  startTalking: jest.Mock;
  stopWalkie: jest.Mock;
  setWalkieCallMuted: jest.Mock;
};

const snapWith = (phase: string): Snap => ({
  model: {
    phase,
    callId: 'c1',
    peerHash: 1,
    peerName: 'Dusty',
    offerer: true,
    userMuted: false,
    backgrounded: false,
    endedReason: phase === 'ended' ? 'hung-up' : null,
  },
  localStreamUrl: null,
  remoteStreamUrl: null,
});

const byLabel = (tree: ReactTestRenderer, label: string) => {
  const hit = tree.root
    .findAll(n => n.props?.accessibilityLabel === label)
    .at(0);
  expect(hit).toBeDefined();
  return hit!;
};

async function openPanel(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <WalkiePanel crewId="pod-1" crewCode="1234" myCardId="me" myName="Pug" />,
    );
  });
  await act(async () => {
    byLabel(tree, 'Open the walkie').props.onPress();
  });
  return tree;
}

beforeEach(() => {
  order.length = 0;
  runtimes.length = 0;
  walkieFlag.value = false;
  __resetWalkieSessionForTests();
  jest.clearAllMocks();
});

test('turning the walkie off hangs up BEFORE the socket closes', async () => {
  // Mutation: put stopWalkie ahead of destroy() in stopWalkieSession — the
  // bye meets a closed socket, rejects 'idle', and the peer waits out the
  // 8 s ICE grace to read the wrong sentence.
  const tree = await openPanel();
  order.length = 0;
  await act(async () => {
    byLabel(tree, 'Walkie is on — tap to turn off').props.onPress();
  });
  expect(order.indexOf('destroy')).toBeGreaterThan(-1);
  expect(order.indexOf('destroy')).toBeLessThan(order.indexOf('stopWalkie'));
  act(() => tree.unmount());
});

test('the whole teardown runs runtime, then mic, then transport', async () => {
  // The order contract in full, in one place now that one function owns it.
  // Mutation: reorder any pair in stopWalkieSession.
  const tree = await openPanel();
  order.length = 0;
  await act(async () => {
    byLabel(tree, 'Walkie is on — tap to turn off').props.onPress();
  });
  expect(
    order.filter(x => x === 'destroy' || x === 'stopTalking' || x === 'stopWalkie'),
  ).toEqual(['destroy', 'stopTalking', 'stopWalkie']);
  act(() => tree.unmount());
});

test('unmounting the panel does NOT close the channel — it only releases the mic', async () => {
  // THE LANE'S WHOLE POINT. Mutation: restore the old unmount cleanup
  // (stopTalking + stopWalkie) — every tab switch and every pod switch
  // hangs up a walkie the camper deliberately left on, which is the defect
  // "calls ring anywhere" exists to fix.
  const tree = await openPanel();
  order.length = 0;
  act(() => tree.unmount());
  expect(walkieMock.stopTalking).toHaveBeenCalled();
  expect(walkieMock.stopWalkie).not.toHaveBeenCalled();
  expect(order).not.toContain('destroy');
  expect(walkieFlag.value).toBe(true);
});

test('a call taking the mic stops an already-held talk and mutes playback; the end arc unmutes', async () => {
  // Mutation 1: rely on the render gate alone — `disabled` blocks future
  // presses, but the recorder held since before the accept stays live
  // through getUserMedia (the §5 two-clients contention). Mutation 2:
  // never unmute — the pod stays silent after every call.
  const tree = await openPanel();
  const rt = runtimes[runtimes.length - 1];
  await act(async () => {
    byLabel(tree, 'Hold to talk').props.onPressIn();
  });
  expect(walkieMock.startTalking).toHaveBeenCalled();
  walkieMock.stopTalking.mockClear();
  walkieMock.setWalkieCallMuted.mockClear();
  await act(async () => {
    rt.cb?.(snapWith('connecting'));
  });
  expect(walkieMock.stopTalking).toHaveBeenCalled();
  expect(walkieMock.setWalkieCallMuted).toHaveBeenLastCalledWith(true);
  await act(async () => {
    rt.cb?.(snapWith('ended'));
  });
  expect(walkieMock.setWalkieCallMuted).toHaveBeenLastCalledWith(false);
  act(() => tree.unmount());
});

test('the PTT is suppressed and says why while the call holds the mic', async () => {
  // The visible half of the same contract, unchanged by the move.
  const tree = await openPanel();
  const rt = runtimes[runtimes.length - 1];
  await act(async () => {
    rt.cb?.(snapWith('live'));
  });
  const ptt = byLabel(tree, 'Live talk paused during the call');
  expect(ptt.props.disabled).toBe(true);
  act(() => tree.unmount());
});
