/**
 * CALLS RING ANYWHERE (owner un-defer, 2026-08-25) — the arcs the ownership
 * move exists to make true.
 *
 * The defect: CallRuntime and the walkie transport both lived inside
 * WalkiePanel, so a 1:1 call could only ring into a subtree the camper was
 * already looking at, and closing the stage closed the channel. The session
 * now lives above the panel (src/crews/walkieSession.ts) and its two
 * app-level surfaces mount once in App.tsx (src/crews/WalkieDeck.tsx).
 *
 * These tests drive the SESSION, never the panel, precisely because the
 * panel is not required to exist for any of it — which is the claim.
 *
 * Deliberately out of scope, and it is a real limit: ringing with the app
 * backgrounded or killed. That needs an Android foreground service and
 * Apple PushToTalk, and nothing here should be read as covering it.
 */
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

type Snap = {
  model: Record<string, unknown>;
  localStreamUrl: string | null;
  remoteStreamUrl: string | null;
};

declare global {
  var __ringRuntimes: { cb: ((s: Snap) => void) | null; acts: string[] }[] | undefined;
  var __ringWalkie: { on: boolean; peers: unknown[] } | undefined;
  var __ringPeerCbs: ((p: unknown) => void)[] | undefined;
}

jest.mock('../src/crews/walkie', () => {
  const st = (globalThis.__ringWalkie = globalThis.__ringWalkie ?? {
    on: false,
    peers: [],
  });
  const peerCbs: ((p: unknown) => void)[] = (globalThis.__ringPeerCbs =
    globalThis.__ringPeerCbs ?? []);
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
    diagnoseWalkieSilence: jest.fn(async () => null),
    formatChannelNames: (entries: { name: string; rung?: string }[]) =>
      entries.map(e => (e.rung === 'ble' ? `${e.name} (lo-fi)` : e.name)).join(', '),
    onWalkiePeers: (cb: (p: unknown) => void) => {
      peerCbs.push(cb);
      return () => {
        const i = peerCbs.indexOf(cb);
        if (i >= 0) {
          peerCbs.splice(i, 1);
        }
      };
    },
    onWalkieSpeaking: jest.fn(() => () => {}),
    doubleTalkCopy: () => null,
    walkieCapCopy: () => null,
    walkieDiagnosisCopy: () => '',
    walkiePresent: () => true,
    walkieOn: () => st.on,
    walkieChannelRevision: () => revision,
    subscribeWalkieChannel: (cb: () => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    dedupeWalkiePeers: (rows: { hash: number }[]) => rows.filter(r => r.hash !== 0),
    startTalking: jest.fn(async () => {}),
    startWalkie: jest.fn(async () => {
      st.on = true;
      notify();
    }),
    stopTalking: jest.fn(async () => {}),
    stopWalkie: jest.fn(async () => {
      st.on = false;
      notify();
    }),
    setWalkieCallMuted: jest.fn(async () => {}),
    // The hang-diagnosis pulse (src/crews/hangPulse.ts), absent here on
    // purpose: this suite is about the ring reaching the camper, and a
    // two-second interval inside it would only add a timer to clean up.
    walkiePulsePresent: () => false,
    walkiePulse: jest.fn(),
    /** Test-only: the native side closing the channel on its own. */
    __nativeClose: () => {
      st.on = false;
      notify();
    },
  };
});

jest.mock('../src/crews/callRuntime', () => {
  const runtimes: { cb: ((s: Snap) => void) | null; acts: string[] }[] =
    (globalThis.__ringRuntimes = globalThis.__ringRuntimes ?? []);
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
    acts: string[] = [];
    constructor() {
      runtimes.push(this);
    }
    start() {}
    destroy() {
      this.acts.push('destroy');
    }
    subscribe(cb: (s: Snap) => void) {
      this.cb = cb;
      return () => {};
    }
    snapshot(): Snap {
      return { model: idleModel, localStreamUrl: null, remoteStreamUrl: null };
    }
    notePeers(present: Set<number>) {
      this.acts.push(`notePeers:${[...present].join(',')}`);
    }
    place() {}
    answer() {
      this.acts.push('answer');
    }
    decline() {
      this.acts.push('decline');
    }
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

import { WalkieDeck } from '../src/crews/WalkieDeck';
import {
  __resetWalkieSessionForTests,
  setWalkiePanelOpen,
  startWalkieSession,
  stopWalkieSession,
  subscribeWalkieCallEvents,
  walkieMiniBarCopy,
  walkieMiniBarShown,
  walkieOnFor,
  walkieSessionState,
  type WalkieCallEvent,
} from '../src/crews/walkieSession';

const runtimes = globalThis.__ringRuntimes!;
const walkieState = globalThis.__ringWalkie!;
const peerCbs = globalThis.__ringPeerCbs!;
const walkieMock = jest.requireMock('../src/crews/walkie') as {
  __nativeClose: () => void;
  stopWalkie: jest.Mock;
};

const POD = { crewId: 'pod-1', crewCode: '1234', myCardId: 'me', myName: 'Pug' };

const ringing = (): Snap => ({
  model: {
    phase: 'ringing',
    callId: 'c1',
    peerHash: 7,
    peerName: 'Marisol',
    offerer: false,
    userMuted: false,
    backgrounded: false,
    endedReason: null,
  },
  localStreamUrl: null,
  remoteStreamUrl: null,
});

const live = (): Snap => ({
  model: { ...ringing().model, phase: 'live' },
  localStreamUrl: 'local://1',
  remoteStreamUrl: 'remote://1',
});

/** Every string leaf in the rendered tree, joined — the "what does this
 * actually say on screen" probe the other component suites use. */
const texts = (tree: ReactTestRenderer): string => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      walk((node as { children?: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out.join('');
};

const byLabel = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll(n => n.props?.accessibilityLabel === label).at(0);

function mountDeck(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(<WalkieDeck onOpenPanel={() => {}} />);
  });
  return tree;
}

beforeEach(() => {
  runtimes.length = 0;
  peerCbs.length = 0;
  walkieState.on = false;
  __resetWalkieSessionForTests();
  jest.clearAllMocks();
});

describe('the ring reaches the camper wherever they are', () => {
  test('a call rings with the walkie panel CLOSED, on any tab', async () => {
    // Mutation: move CallRuntime back inside WalkiePanel — with the stage
    // closed there is no runtime to receive the invite and no surface to
    // render it, so the phone never rings and the caller hears nothing but
    // the 30 s no-answer.
    const tree = mountDeck();
    await act(async () => {
      await startWalkieSession(POD);
    });
    setWalkiePanelOpen(false);
    const rt = runtimes[runtimes.length - 1];
    await act(async () => {
      rt.cb?.(ringing());
    });
    expect(walkieSessionState().panelOpen).toBe(false);
    expect(texts(tree)).toContain('Marisol is calling');
    expect(byLabel(tree, 'Answer the call from Marisol')).toBeDefined();
    expect(byLabel(tree, 'Decline the call')).toBeDefined();
    act(() => tree.unmount());
  });

  test('answering from the banner drives the runtime and opens the call UI', async () => {
    // Mutation: render a ring banner that only dismisses itself — the
    // camper taps Answer, the caller's phone keeps ringing, and the app has
    // lied about what the button does.
    const tree = mountDeck();
    await act(async () => {
      await startWalkieSession(POD);
    });
    const rt = runtimes[runtimes.length - 1];
    await act(async () => {
      rt.cb?.(ringing());
    });
    act(() => {
      byLabel(tree, 'Answer the call from Marisol')!.props.onPress();
    });
    expect(rt.acts).toContain('answer');
    // ...and the answered call becomes the call UI, still with no panel.
    await act(async () => {
      rt.cb?.(live());
    });
    expect(byLabel(tree, 'Hang up')).toBeDefined();
    expect(byLabel(tree, 'Flip camera')).toBeDefined();
    act(() => tree.unmount());
  });

  test('the ring is published as an event, once, for the pocket lane', async () => {
    // The seam a notification lane consumes: one post, one cancel, and the
    // cancel does not care WHY the ring ended. Mutation: emit on every
    // snapshot — the pocket gets a notification storm at 500 ms cadence.
    const seen: WalkieCallEvent[] = [];
    const off = subscribeWalkieCallEvents(e => seen.push(e));
    await act(async () => {
      await startWalkieSession(POD);
    });
    const rt = runtimes[runtimes.length - 1];
    await act(async () => {
      rt.cb?.(ringing());
      rt.cb?.(ringing());
    });
    expect(seen).toEqual([
      { kind: 'ring', callId: 'c1', peerHash: 7, peerName: 'Marisol' },
    ]);
    await act(async () => {
      rt.cb?.(live());
    });
    expect(seen[1]).toEqual({ kind: 'ring-cleared', callId: 'c1' });
    off();
  });
});

describe('the mini-bar is the visible proof of a hot radio', () => {
  test('it shows exactly when the walkie is on AND the stage is closed', async () => {
    // Mutation A: show it whenever the walkie is on — it duplicates the
    // stage the camper is already looking at. Mutation B: never show it —
    // the walkie runs, drains the battery and plays pod voice with nothing
    // on screen saying so, which is §5's lie of omission.
    expect(walkieMiniBarShown(walkieSessionState())).toBe(false); // off, closed
    await act(async () => {
      await startWalkieSession(POD);
    });
    setWalkiePanelOpen(true);
    expect(walkieMiniBarShown(walkieSessionState())).toBe(false); // on, open
    setWalkiePanelOpen(false);
    expect(walkieMiniBarShown(walkieSessionState())).toBe(true); // on, closed
    await act(async () => {
      await stopWalkieSession();
    });
    expect(walkieMiniBarShown(walkieSessionState())).toBe(false); // off, closed
  });

  test('it names the channel it is holding open, and renders on any tab', async () => {
    const tree = mountDeck();
    await act(async () => {
      await startWalkieSession(POD);
    });
    setWalkiePanelOpen(false);
    await act(async () => {
      for (const cb of [...peerCbs]) {
        cb({
          count: 2,
          entries: [
            { name: 'Star Hare', rung: 'lan' },
            { name: 'Marisol', rung: 'ble' },
          ],
          peers: [
            { name: 'Star Hare', hash: 3 },
            { name: 'Marisol', hash: 7 },
          ],
          talkingTo: 2,
        });
      }
    });
    expect(walkieMiniBarCopy(walkieSessionState())).toBe(
      'Walkie on — Star Hare, Marisol (lo-fi)',
    );
    expect(texts(tree)).toContain('Walkie on — Star Hare, Marisol (lo-fi)');
    // The off switch rides the same bar — the surface that discloses the
    // drain is the surface that ends it.
    expect(byLabel(tree, 'Turn the walkie off')).toBeDefined();
    act(() => tree.unmount());
  });

  test('an empty channel still gets a bar — the drain is the same', async () => {
    await act(async () => {
      await startWalkieSession(POD);
    });
    setWalkiePanelOpen(false);
    expect(walkieMiniBarCopy(walkieSessionState())).toBe(
      'Walkie on — nobody else on the channel yet',
    );
  });
});

describe('the session is the one owner of the channel', () => {
  test('the roster reaches the call runtime with the stage closed', async () => {
    // Mutation: keep notePeers on the panel — a podmate who walks away
    // during a call the camper answered from the map never tears the call
    // down, and the tile just freezes.
    await act(async () => {
      await startWalkieSession(POD);
    });
    setWalkiePanelOpen(false);
    const rt = runtimes[runtimes.length - 1];
    await act(async () => {
      for (const cb of [...peerCbs]) {
        cb({
          count: 1,
          entries: [{ name: 'Marisol', rung: 'lan' }],
          peers: [{ name: 'Marisol', hash: 7 }, { name: 'someone', hash: 0 }],
          talkingTo: 1,
        });
      }
    });
    expect(rt.acts).toContain('notePeers:7');
  });

  test('a native-side close takes the session down with it', async () => {
    // notifyWalkieChannel must stay TRUTHFUL through the lift: if the flag
    // says the channel is closed, no surface may keep claiming a session.
    // Mutation: drop the store's channel subscription — walkieOnFor keeps
    // returning false while the mini-bar keeps promising a live radio.
    await act(async () => {
      await startWalkieSession(POD);
    });
    expect(walkieOnFor('pod-1')).toBe(true);
    await act(async () => {
      walkieMock.__nativeClose();
    });
    expect(walkieSessionState().session).toBeNull();
    expect(walkieOnFor('pod-1')).toBe(false);
  });

  test('the claim dies at the DECISION, not at the end of the native stop', async () => {
    // walkie.ts's own rule, inherited: stopWalkie notifies before awaiting
    // the native teardown, because a surface's job is to stop claiming a
    // channel that is going away. Mutation: move set({...EMPTY}) below the
    // awaits — the mini-bar promises a live radio for the length of a
    // native round-trip, which is the staleness it exists to prevent.
    await act(async () => {
      await startWalkieSession(POD);
    });
    setWalkiePanelOpen(false);
    expect(walkieMiniBarShown(walkieSessionState())).toBe(true);
    const pending = stopWalkieSession();
    expect(walkieSessionState().session).toBeNull();
    expect(walkieMiniBarShown(walkieSessionState())).toBe(false);
    await act(async () => {
      await pending;
    });
  });

  test('opening a second pod\'s walkie swaps the channel, never doubles it', async () => {
    // One radio, one channel. Mutation: start the new one without stopping
    // the old — both pod cards claim "walkie is on" and only one is true.
    await act(async () => {
      await startWalkieSession(POD);
    });
    await act(async () => {
      await startWalkieSession({ ...POD, crewId: 'pod-2', crewCode: '5678' });
    });
    expect(walkieMock.stopWalkie).toHaveBeenCalledTimes(1);
    expect(walkieOnFor('pod-1')).toBe(false);
    expect(walkieOnFor('pod-2')).toBe(true);
  });
});
