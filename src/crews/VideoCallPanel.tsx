/**
 * VideoCallPanel — the call's whole visible life, rendered inside the
 * walkie deck (the call is the pod's fourth verb, and it lives where the
 * peers it can reach are already listed). Pure over a CallSnapshot plus
 * handlers, so the arc — ring, answer/decline, live, honest endings — is
 * testable without a camera.
 *
 * ── THE LIVE SURFACE (owner report 2026-08-26, after the first real
 * iPhone↔iPhone call: "it's amazing functionally", "please get the
 * facetime interface up to modern standards not just mvp working
 * buttons") ────────────────────────────────────────────────────────────
 *
 * The ringing / calling / ended arcs are unchanged — they are banners over
 * whatever tab the camper was on and they work. Only the LIVE phase is
 * re-skinned, into the shape three decades of calling apps have settled
 * on, spoken in this app's own voice:
 *
 *   • the remote is FULL BLEED — the person you called is the screen;
 *   • the self-view is a rounded corner tile over it, MIRRORED only while
 *     the front lens is capturing (videoCall.ts callSelfMirrored owns that
 *     rule and says why);
 *   • the controls are big round glove-targets that FADE after four idle
 *     seconds and come back on any touch — unless the phone asks for
 *     reduced motion or is running a screen reader, in which case they
 *     never move and never hide;
 *   • mute is not a shaded button. It is a slashed mic on a filled circle
 *     AND a standing "Muted" pill beside the self-view, because the owner's
 *     complaint was that mute state had to be INFERRED, and out there it is
 *     read at arm's length, in the sun, through dust.
 *
 * WHAT IS DELIBERATELY NOT HERE: any sign of the REMOTE side's mute. The
 * signaling wire carries invite/accept/decline/busy/bye/sdp/ice and
 * nothing else (docs/VIDEO-CALLS.md §2), so a "they are muted" dot would
 * be a guess wearing a fact's clothes. It needs a new control message —
 * see §8's future line — and this slice does not invent wire.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../components/Text';
import {
  EndCallIcon,
  FlipCameraIcon,
  MicIcon,
  VideoIcon,
} from './CallIcons';
import {
  callDurationCopy,
  callEndedCopy,
  callSelfMirrored,
  callVideoOn,
} from './videoCall';
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

/** Idle seconds before the controls step out of the way of the face. */
const CONTROLS_IDLE_MS = 4000;

/** The fade itself — short enough that it never feels like a transition,
 * long enough that the chrome does not blink out. */
const FADE_MS = 180;

/**
 * Chrome insets, in points, that clear a notch or Dynamic Island and the
 * home indicator.
 *
 * NOT useSafeAreaInsets, and that is a considered trade: this panel and
 * the deck that mounts it are both rendered BARE by their suites, and the
 * hook throws without a SafeAreaProvider above it — a call surface that
 * cannot be rendered in a test is a call surface whose arcs stop being
 * checked. Two numbers with a comment cost less than that.
 */
const TOP_CHROME = 56;
const BOTTOM_CHROME = 40;

/** The round controls: 64pt of target for a gloved thumb (well over
 * `tap`'s 44pt floor, because these are pressed one-handed, in the dark,
 * on a phone held at arm's length) around a 30pt glyph. */
const CONTROL_SIZE = 64;
const CONTROL_GLYPH = 30;

/** One round control. `tone` is the whole state language: 'idle' is chrome
 * over video, 'on' means the camper has turned something OFF and needs to
 * see that from across a camp, 'end' is the one irreversible button. */
function RoundControl({
  label,
  onPress,
  tone,
  spaced,
  selected,
  children,
}: {
  label: string;
  onPress: () => void;
  tone: 'idle' | 'on' | 'end';
  spaced?: boolean;
  selected?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected == null ? undefined : { selected }}
      style={[
        styles.round,
        tone === 'on'
          ? styles.roundOn
          : tone === 'end'
          ? styles.roundEnd
          : styles.roundIdle,
        spaced ? styles.roundSpaced : null,
      ]}>
      {children}
    </Pressable>
  );
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
  const live = m.phase === 'live';

  // ── the fading chrome ────────────────────────────────────────────────
  // Every hook runs on every phase (the early returns below are all after
  // them) — a call that rings, is answered and ends must not change the
  // hook order underneath React.
  const [controlsUp, setControlsUp] = useState(true);
  const [wokeAt, setWokeAt] = useState(() => Date.now());
  /** Motion is unwelcome on this phone: reduced motion is on, or a screen
   * reader is running. Either way the controls stay put and stay visible —
   * chrome that hides itself is chrome a screen reader has to hunt for. */
  const [keepControls, setKeepControls] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let alive = true;
    const ask = (p: Promise<boolean> | undefined) => {
      void p?.then(v => {
        if (alive && v) {
          setKeepControls(true);
        }
      });
    };
    try {
      ask(AccessibilityInfo.isReduceMotionEnabled?.());
      ask(AccessibilityInfo.isScreenReaderEnabled?.());
    } catch {
      // No accessibility surface on this platform or build — fade as usual.
    }
    return () => {
      alive = false;
    };
  }, []);

  /** Any touch anywhere on the stage brings the chrome back. Capture, and
   * always false: this WATCHES the gesture, it never takes it, so a tap
   * that lands on a visible button still presses that button. */
  const wake = useCallback(() => {
    setControlsUp(true);
    setWokeAt(Date.now());
    return false;
  }, []);

  useEffect(() => {
    if (!live || keepControls || !controlsUp) {
      return;
    }
    const id = setTimeout(() => setControlsUp(false), CONTROLS_IDLE_MS);
    return () => clearTimeout(id);
  }, [live, keepControls, controlsUp, wokeAt]);

  useEffect(() => {
    const to = controlsUp ? 1 : 0;
    if (keepControls) {
      fade.setValue(to);
      return;
    }
    const run = Animated.timing(fade, {
      duration: FADE_MS,
      toValue: to,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [controlsUp, keepControls, fade]);

  // ── the duration ─────────────────────────────────────────────────────
  // Clocked from the moment this surface sees 'live', which is the moment
  // the camper sees the other face — not from when the invite left.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [, setBeat] = useState(0);
  useEffect(() => {
    setStartedAt(live ? Date.now() : null);
  }, [live]);
  useEffect(() => {
    if (!live) {
      return;
    }
    const id = setInterval(() => setBeat(b => b + 1), 1000);
    return () => clearInterval(id);
  }, [live]);

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

  // ── live ─────────────────────────────────────────────────────────────
  const RTCView = rtcView();
  const videoOn = callVideoOn(m);
  const elapsed = startedAt == null ? 0 : Date.now() - startedAt;

  return (
    <View style={styles.stage} onStartShouldSetResponderCapture={wake}>
      {RTCView && snap.remoteStreamUrl ? (
        <RTCView
          streamURL={snap.remoteStreamUrl}
          style={styles.remote}
          objectFit="cover"
          zOrder={0}
        />
      ) : (
        <View style={[styles.remote, styles.remoteEmpty]}>
          <Text style={styles.waiting}>Waiting for their camera…</Text>
        </View>
      )}

      <View style={styles.clock} pointerEvents="none">
        <Text style={styles.clockText}>{callDurationCopy(elapsed)}</Text>
      </View>

      {/* The self-view and the mute pill share a corner ON PURPOSE: "am I
          muted" is a question about the tile with your own face in it. */}
      <View style={styles.corner} pointerEvents="none">
        {RTCView && snap.localStreamUrl && videoOn ? (
          <RTCView
            streamURL={snap.localStreamUrl}
            style={styles.pip}
            objectFit="cover"
            mirror={callSelfMirrored(m)}
            zOrder={1}
          />
        ) : null}
        {m.micMuted ? (
          <View style={styles.mutedPill}>
            <MicIcon
              size={16}
              color={colors.onAccent}
              cut={colors.gold}
              off
            />
            <Text style={styles.mutedPillText}>Muted</Text>
          </View>
        ) : null}
      </View>

      {/* The camera-off sentence never fades: it is the honest account of
          why the other phone sees nothing, not chrome. */}
      {!videoOn ? (
        <View style={styles.caption} pointerEvents="none">
          <Text style={styles.hint}>
            {m.backgrounded
              ? 'Camera paused while the app is in the background.'
              : 'Your camera is off — sound still carries.'}
          </Text>
        </View>
      ) : null}

      <Animated.View
        style={[styles.controls, { opacity: fade }]}
        pointerEvents={controlsUp ? 'box-none' : 'none'}>
        <RoundControl
          label={m.micMuted ? 'Unmute microphone' : 'Mute microphone'}
          onPress={onToggleMic}
          selected={m.micMuted}
          tone={m.micMuted ? 'on' : 'idle'}>
          <MicIcon
            size={CONTROL_GLYPH}
            color={m.micMuted ? colors.onAccent : colors.cream}
            cut={m.micMuted ? colors.gold : colors.overlayScrim}
            off={m.micMuted}
          />
        </RoundControl>
        <RoundControl
          label={m.userMuted ? 'Turn camera on' : 'Turn camera off'}
          onPress={onToggleVideo}
          selected={m.userMuted}
          tone={m.userMuted ? 'on' : 'idle'}>
          <VideoIcon
            size={CONTROL_GLYPH}
            color={m.userMuted ? colors.onAccent : colors.cream}
            cut={m.userMuted ? colors.gold : colors.overlayScrim}
            off={m.userMuted}
          />
        </RoundControl>
        <RoundControl label="Flip camera" onPress={onFlipCamera} tone="idle">
          <FlipCameraIcon size={CONTROL_GLYPH} color={colors.cream} />
        </RoundControl>
        <RoundControl label="Hang up" onPress={onHangUp} tone="end" spaced>
          <EndCallIcon size={CONTROL_GLYPH} color={colors.onAccent} />
        </RoundControl>
      </Animated.View>
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
  // The live call takes the whole surface WalkieDeck gives it; every piece
  // of chrome below is positioned against these edges.
  stage: { flex: 1, position: 'relative' },
  remote: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  remoteEmpty: {
    alignItems: 'center',
    // overlayScrim is the one ground token that is dark in BOTH palettes —
    // and the chrome painted on it (cream ink) has to read the same way at
    // noon and at 3am, so it cannot ride `dust`, which flips.
    backgroundColor: colors.overlayScrim,
    justifyContent: 'center',
  },
  waiting: { color: colors.cream, fontSize: type.body, textAlign: 'center' },
  clock: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: TOP_CHROME,
  },
  clockText: {
    backgroundColor: colors.backdrop,
    borderRadius: radius.chip,
    color: colors.cream,
    fontSize: type.small,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  corner: {
    alignItems: 'flex-end',
    position: 'absolute',
    right: spacing.md,
    top: TOP_CHROME,
  },
  pip: {
    backgroundColor: colors.overlayScrim,
    borderRadius: radius.card,
    height: 148,
    overflow: 'hidden',
    width: 108,
  },
  mutedPill: {
    alignItems: 'center',
    backgroundColor: colors.gold,
    borderRadius: radius.chip,
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  mutedPillText: {
    color: colors.onAccent,
    fontSize: type.small,
    fontWeight: '700',
  },
  caption: {
    alignItems: 'center',
    bottom: BOTTOM_CHROME + CONTROL_SIZE + spacing.lg,
    left: spacing.lg,
    position: 'absolute',
    right: spacing.lg,
  },
  controls: {
    alignItems: 'center',
    bottom: BOTTOM_CHROME,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  round: {
    alignItems: 'center',
    borderRadius: CONTROL_SIZE / 2,
    height: CONTROL_SIZE,
    justifyContent: 'center',
    width: CONTROL_SIZE,
  },
  roundIdle: { backgroundColor: colors.backdrop },
  roundOn: { backgroundColor: colors.gold },
  roundEnd: { backgroundColor: colors.clay },
  // Hang up sits apart from the toggles: the three that can be undone with
  // a second tap, then a gap, then the one that cannot.
  roundSpaced: { marginLeft: spacing.xl },
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
  btnText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  quietBtn: {
    alignSelf: 'center',
    justifyContent: 'center',
    minHeight: tap.minHeight,
    paddingHorizontal: spacing.lg,
  },
  quietBtnText: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
  hint: {
    backgroundColor: colors.backdrop,
    borderRadius: radius.chip,
    color: colors.cream,
    fontSize: type.small,
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    textAlign: 'center',
  },
});
