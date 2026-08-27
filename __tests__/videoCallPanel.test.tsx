/**
 * VideoCallPanel (src/crews/VideoCallPanel.tsx): the call's visible arcs.
 * Rendered over fixed CallSnapshots — react-native-webrtc is the manual
 * mock (jest.config moduleNameMapper), so RTCView is a plain marker
 * element whose presence and streamURL these tests can assert.
 */
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { VideoCallPanel } from '../src/crews/VideoCallPanel';
import { idleCall, type CallModel } from '../src/crews/videoCall';
import type { CallSnapshot } from '../src/crews/callRuntime';

function snap(
  model: Partial<CallModel>,
  streams: Partial<Pick<CallSnapshot, 'localStreamUrl' | 'remoteStreamUrl'>> = {},
): CallSnapshot {
  return {
    model: { ...idleCall, peerHash: 1, peerName: 'Dusty', ...model },
    localStreamUrl: streams.localStreamUrl ?? null,
    remoteStreamUrl: streams.remoteStreamUrl ?? null,
  };
}

const noop = () => {};

// The live surface runs a one-second duration timer and a four-second
// controls fade. Both are cleaned up on unmount, so every tree this file
// makes is torn down after its test — an interval that outlives the suite
// fires setState into a dead environment, which is a flake, not a finding.
const trees: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const t of trees.splice(0)) {
      t.unmount();
    }
  });
});

function render(s: CallSnapshot, handlers: Partial<Record<string, () => void>> = {}) {
  let tree: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <VideoCallPanel
        snap={s}
        onAnswer={handlers.onAnswer ?? noop}
        onDecline={handlers.onDecline ?? noop}
        onHangUp={handlers.onHangUp ?? noop}
        onToggleVideo={handlers.onToggleVideo ?? noop}
        onFlipCamera={handlers.onFlipCamera ?? noop}
        onToggleMic={handlers.onToggleMic ?? noop}
        onDismiss={handlers.onDismiss ?? noop}
      />,
    );
  });
  trees.push(tree!);
  return tree!;
}

/** The RTCView carrying a given stream, or undefined. */
const viewFor = (tree: ReactTestRenderer, url: string) =>
  tree.root
    .findAllByType('RTCView' as never)
    .find(v => v.props.streamURL === url);

/** Every rendered string, concatenated in order — JSX interpolation splits
 * text into sibling strings, so a substring match needs the joined form. */
const flatten = (node: unknown): string => {
  if (node == null) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(flatten).join('');
  }
  return flatten((node as { children?: unknown }).children ?? null);
};
const texts = (tree: ReactTestRenderer): string => flatten(tree.toJSON());

const pressByLabel = (tree: ReactTestRenderer, label: RegExp) => {
  const target = tree.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .find(n => label.test(n.props.accessibilityLabel));
  expect(target).toBeDefined();
  act(() => target!.props.onPress());
};

test('idle renders nothing at all — no dead call chrome', () => {
  expect(render(snap({ phase: 'idle' })).toJSON()).toBeNull();
});

test('ringing asks by name, and both buttons reach their handlers', () => {
  const onAnswer = jest.fn();
  const onDecline = jest.fn();
  const tree = render(snap({ phase: 'ringing' }), { onAnswer, onDecline });
  expect(texts(tree)).toContain('Dusty is calling');
  pressByLabel(tree, /^Answer/);
  expect(onAnswer).toHaveBeenCalled();
  pressByLabel(tree, /^Decline/);
  expect(onDecline).toHaveBeenCalled();
});

test('calling shows the ring state with a cancel that hangs up', () => {
  const onHangUp = jest.fn();
  const tree = render(snap({ phase: 'calling' }), { onHangUp });
  expect(texts(tree)).toContain('Calling Dusty…');
  pressByLabel(tree, /Cancel/);
  expect(onHangUp).toHaveBeenCalled();
});

test('live shows both streams and every call control', () => {
  const onToggleMic = jest.fn();
  const onFlipCamera = jest.fn();
  const onHangUp = jest.fn();
  const tree = render(
    snap(
      { phase: 'live' },
      { localStreamUrl: 'mock://me', remoteStreamUrl: 'mock://them' },
    ),
    { onToggleMic, onFlipCamera, onHangUp },
  );
  const views = tree.root.findAllByType('RTCView' as never);
  expect(views.map(v => v.props.streamURL).sort()).toEqual([
    'mock://me',
    'mock://them',
  ]);
  // The controls are glyphs now, so the LABEL is the contract — it is what
  // a screen reader reads and what these presses aim at.
  pressByLabel(tree, /^Mute microphone$/);
  expect(onToggleMic).toHaveBeenCalled();
  pressByLabel(tree, /^Flip camera$/);
  expect(onFlipCamera).toHaveBeenCalled();
  pressByLabel(tree, /^Turn camera off$/);
  pressByLabel(tree, /^Hang up$/);
  expect(onHangUp).toHaveBeenCalled();
});

describe('the mirror convention (owner: "pan right and it goes left")', () => {
  // A self-view is a MIRROR and a remote view is a WINDOW. The old panel
  // hardcoded `mirror` on the self-view, so Flip left the REAR lens
  // mirrored and the world moved the wrong way.
  const both = { localStreamUrl: 'mock://me', remoteStreamUrl: 'mock://them' };

  test('the front-camera self-view is mirrored and the remote never is', () => {
    const tree = render(snap({ phase: 'live', frontCamera: true }, both));
    expect(viewFor(tree, 'mock://me')!.props.mirror).toBe(true);
    expect(viewFor(tree, 'mock://them')!.props.mirror).toBeFalsy();
  });

  test('flipping to the rear lens UNMIRRORS the self-view', () => {
    // Mutation: hardcode mirror back on — this goes true and the rear
    // camera pans backwards again.
    const tree = render(snap({ phase: 'live', frontCamera: false }, both));
    expect(viewFor(tree, 'mock://me')!.props.mirror).toBe(false);
    expect(viewFor(tree, 'mock://them')!.props.mirror).toBeFalsy();
  });
});

test('a muted mic stands a pill beside the self-view, not just a shaded button', () => {
  // The owner's actual complaint: mute state had to be INFERRED from
  // button shading. Mutation: drop the pill — the only mute signal left is
  // a colour change on a 64pt circle, at arm's length, in the sun.
  const tree = render(
    snap(
      { phase: 'live', micMuted: true },
      { localStreamUrl: 'mock://me', remoteStreamUrl: 'mock://them' },
    ),
  );
  expect(texts(tree)).toContain('Muted');
  // ...and the button says the opposite verb, because pressing it unmutes.
  pressByLabel(tree, /^Unmute microphone$/);
});

test('an unmuted call shows no mute pill at all', () => {
  const tree = render(
    snap({ phase: 'live' }, { localStreamUrl: 'mock://me', remoteStreamUrl: 'mock://them' }),
  );
  expect(texts(tree)).not.toContain('Muted');
});

test('a live call carries its duration from the first second', () => {
  // Mutation: render nothing until a minute has passed — a blank where the
  // clock goes reads as "not connected yet" on a call that IS connected.
  const tree = render(
    snap({ phase: 'live' }, { remoteStreamUrl: 'mock://them' }),
  );
  expect(texts(tree)).toContain('0:00');
});

test('live without the remote stream says it is waiting, honestly', () => {
  const tree = render(snap({ phase: 'live' }, { localStreamUrl: 'mock://me' }));
  expect(texts(tree)).toContain('Waiting for their camera…');
});

test('a muted camera hides the self-view and says sound still carries', () => {
  // Mutation: keep streaming the pip while muted — the tile claims the
  // camera is off while showing it running.
  const tree = render(
    snap(
      { phase: 'live', userMuted: true },
      { localStreamUrl: 'mock://me', remoteStreamUrl: 'mock://them' },
    ),
  );
  const views = tree.root.findAllByType('RTCView' as never);
  expect(views).toHaveLength(1); // remote only
  expect(texts(tree)).toContain('camera is off');
});

test('backgrounded says WHY the camera is paused', () => {
  const tree = render(
    snap(
      { phase: 'live', backgrounded: true },
      { remoteStreamUrl: 'mock://them' },
    ),
  );
  expect(texts(tree)).toContain('background');
});

test('ended shows the honest reason and dismisses', () => {
  const onDismiss = jest.fn();
  const tree = render(snap({ phase: 'ended', endedReason: 'lost' }), {
    onDismiss,
  });
  expect(texts(tree)).toContain('The link to Dusty dropped');
  pressByLabel(tree, /Dismiss/);
  expect(onDismiss).toHaveBeenCalled();
});
