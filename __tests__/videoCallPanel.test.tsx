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
  return tree!;
}

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

test('live shows both streams and the three call controls', () => {
  const tree = render(
    snap(
      { phase: 'live' },
      { localStreamUrl: 'mock://me', remoteStreamUrl: 'mock://them' },
    ),
  );
  const views = tree.root.findAllByType('RTCView' as never);
  expect(views.map(v => v.props.streamURL).sort()).toEqual([
    'mock://me',
    'mock://them',
  ]);
  expect(texts(tree)).toContain('Hang up');
  expect(texts(tree)).toContain('Flip');
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
