/**
 * VideoCallPanel — the call's whole visible life, rendered inside the
 * walkie panel (the call is the pod's fourth verb, and it lives where the
 * peers it can reach are already listed). Pure over a CallSnapshot plus
 * handlers, so the arc — ring, answer/decline, live, honest endings — is
 * testable without a camera.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { callEndedCopy, callVideoOn } from './videoCall';
import type { CallSnapshot } from './callRuntime';
import { colors, radius, spacing, tap, type } from '../theme';

interface RtcViewProps {
  streamURL?: string;
  style?: object;
  objectFit?: 'contain' | 'cover';
  mirror?: boolean;
  zOrder?: number;
}

/** RTCView, required lazily: a build without the native module renders
 * no call UI at all (callsPresent() gates upstream), and tests get the
 * mapped mock. */
function rtcView(): React.ComponentType<RtcViewProps> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('react-native-webrtc') as {
      RTCView: React.ComponentType<RtcViewProps>;
    }).RTCView;
  } catch {
    return null;
  }
}

export function VideoCallPanel({
  snap,
  onAnswer,
  onDecline,
  onHangUp,
  onToggleVideo,
  onFlipCamera,
  onToggleMic,
  onDismiss,
  stillLofi,
}: {
  snap: CallSnapshot;
  onAnswer: () => void;
  onDecline: () => void;
  onHangUp: () => void;
  onToggleVideo: () => void;
  onFlipCamera: () => void;
  onToggleMic: () => void;
  onDismiss: () => void;
  /** EVIDENCE that this peer still carries a proven lo-fi voice row —
   * computed by the caller from the live roster (never from hope), and
   * only consumed by the 'unreachable' ending's walkie route. */
  stillLofi?: boolean;
}) {
  const m = snap.model;
  const who = m.peerName || 'your podmate';

  if (m.phase === 'idle') {
    return null;
  }

  if (m.phase === 'ended') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {m.endedReason
            ? callEndedCopy(m.endedReason, m.peerName, stillLofi)
            : ''}
        </Text>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={styles.quietBtn}>
          <Text style={styles.quietBtnText}>OK</Text>
        </Pressable>
      </View>
    );
  }

  if (m.phase === 'ringing') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.status} accessibilityLiveRegion="assertive">
          📹 {who} is calling
        </Text>
        <View style={styles.row}>
          <Pressable
            onPress={onAnswer}
            accessibilityRole="button"
            accessibilityLabel={`Answer the call from ${who}`}
            style={[styles.btn, styles.btnGo]}>
            <Text style={styles.btnText}>Answer</Text>
          </Pressable>
          <Pressable
            onPress={onDecline}
            accessibilityRole="button"
            accessibilityLabel="Decline the call"
            style={[styles.btn, styles.btnStop]}>
            <Text style={styles.btnText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (m.phase === 'calling' || m.phase === 'connecting') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {m.phase === 'calling' ? `Calling ${who}…` : `Connecting to ${who}…`}
        </Text>
        <Pressable
          onPress={onHangUp}
          accessibilityRole="button"
          accessibilityLabel={
            m.phase === 'calling' ? 'Cancel the call' : 'Hang up'
          }
          style={[styles.btn, styles.btnStop]}>
          <Text style={styles.btnText}>
            {m.phase === 'calling' ? 'Cancel' : 'Hang up'}
          </Text>
        </Pressable>
      </View>
    );
  }

  // live
  const RTCView = rtcView();
  const videoOn = callVideoOn(m);
  return (
    <View style={styles.wrap}>
      {RTCView ? (
        <View style={styles.stage}>
          {snap.remoteStreamUrl ? (
            <RTCView
              streamURL={snap.remoteStreamUrl}
              style={styles.remote}
              objectFit="cover"
              zOrder={0}
            />
          ) : (
            <View style={[styles.remote, styles.remoteEmpty]}>
              <Text style={styles.hint}>Waiting for their camera…</Text>
            </View>
          )}
          {snap.localStreamUrl && videoOn ? (
            <RTCView
              streamURL={snap.localStreamUrl}
              style={styles.pip}
              objectFit="cover"
              mirror
              zOrder={1}
            />
          ) : null}
        </View>
      ) : null}
      {!videoOn ? (
        <Text style={styles.hint}>
          {m.backgrounded
            ? 'Camera paused while the app is in the background.'
            : 'Your camera is off — sound still carries.'}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Pressable
          onPress={onToggleVideo}
          accessibilityRole="button"
          accessibilityLabel={m.userMuted ? 'Turn camera on' : 'Turn camera off'}
          style={[styles.btn, styles.btnQuietWide]}>
          <Text style={styles.btnText}>
            {m.userMuted ? 'Camera on' : 'Camera off'}
          </Text>
        </Pressable>
        <Pressable
          onPress={onToggleMic}
          accessibilityRole="button"
          accessibilityLabel={m.micMuted ? 'Unmute microphone' : 'Mute microphone'}
          style={[styles.btn, styles.btnQuietWide]}>
          <Text style={styles.btnText}>{m.micMuted ? 'Mic on' : 'Mic off'}</Text>
        </Pressable>
        <Pressable
          onPress={onFlipCamera}
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
          style={[styles.btn, styles.btnQuietWide]}>
          <Text style={styles.btnText}>Flip</Text>
        </Pressable>
        <Pressable
          onPress={onHangUp}
          accessibilityRole="button"
          accessibilityLabel="Hang up"
          style={[styles.btn, styles.btnStop]}>
          <Text style={styles.btnText}>Hang up</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.md },
  status: {
    color: colors.gold,
    fontSize: type.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  stage: { borderRadius: radius.card, overflow: 'hidden' },
  remote: { aspectRatio: 3 / 4, width: '100%' },
  remoteEmpty: {
    alignItems: 'center',
    backgroundColor: colors.haze,
    justifyContent: 'center',
  },
  pip: {
    borderRadius: radius.card,
    bottom: spacing.sm,
    height: 128,
    position: 'absolute',
    right: spacing.sm,
    width: 96,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  btn: {
    alignItems: 'center',
    borderRadius: radius.card,
    justifyContent: 'center',
    minHeight: tap.minHeight,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  btnGo: { backgroundColor: colors.sage },
  btnStop: { backgroundColor: colors.clay },
  btnQuietWide: { backgroundColor: colors.gold },
  btnText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  quietBtn: {
    alignSelf: 'center',
    justifyContent: 'center',
    minHeight: tap.minHeight,
    paddingHorizontal: spacing.lg,
  },
  quietBtnText: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
  hint: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
});
