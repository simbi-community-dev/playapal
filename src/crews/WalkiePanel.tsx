/**
 * WalkiePanel — live talk for the pod (docs/CREW-DESIGN.md §6d), the third
 * verb on the pod: Find / Message / TALK. Mounted inside the Pod card;
 * opens into a simple stage: who's on the channel, one huge hold-to-talk
 * button (the mic runs only while held — the button IS the consent
 * surface), who's talking, and the honest Wi-Fi constraint said out loud.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  WALKIE_DIAG_MS,
  diagnoseWalkieSilence,
  onWalkiePeers,
  onWalkieSpeaking,
  doubleTalkCopy,
  walkieCapCopy,
  startTalking,
  startWalkie,
  stopTalking,
  stopWalkie,
  WALKIE_DOUBLETALK_MS,
  walkieDiagnosisCopy,
  walkiePresent,
  type WalkieDiagnosis,
  type WalkieSpeakerSample,
} from './walkie';
import { colors, radius, spacing, tap, type } from '../theme';

/** Guarded screen-reader announcement (a11y review 2026-08-24): the PTT
 * state flip is visual-only otherwise. try/catch so a bridge without
 * AccessibilityInfo (tests) is a silent no-op, never a crash. */
function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // no announcer here — the visible copy still tells the story
  }
}

export function WalkiePanel({
  crewCode,
  myCardId,
  myName,
}: {
  crewCode: string;
  myCardId: string;
  myName: string;
}) {
  const [open, setOpen] = useState(false);
  const [peers, setPeers] = useState<string[]>([]);
  const [talking, setTalking] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [diag, setDiag] = useState<WalkieDiagnosis | null>(null);
  // What the RADIO will actually reach, which is not the same as who is
  // here once a pod outgrows the channel (walkie.ts WALKIE_MAX_PEERS).
  const [talkingTo, setTalkingTo] = useState(0);
  // Recent speakers, for the double-talk sentence (PUNCHLIST #12). A ref,
  // not state: it is written on every speaking event and read only when one
  // arrives, so making it state would re-render the panel once a second for
  // a value the render does not otherwise use.
  const speakers = useRef<WalkieSpeakerSample[]>([]);
  const [doubleTalk, setDoubleTalk] = useState<string | null>(null);

  // Terminal-state hygiene (composed review, Aug 24): an unmounted panel
  // must never leave the mic or the channel running — unmount = off.
  useEffect(
    () => () => {
      void stopTalking();
      void stopWalkie();
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const offPeers = onWalkiePeers(p => {
      setPeers(p.names);
      setTalkingTo(p.talkingTo);
    });
    let clearSpeak: ReturnType<typeof setTimeout> | null = null;
    const offSpeak = onWalkieSpeaking(s => {
      setSpeaking(s.name);
      const now = Date.now();
      // Keep only the window's worth — this list is appended to about once a
      // second for as long as the walkie is open.
      speakers.current = [
        ...speakers.current.filter(x => now - x.atMs <= WALKIE_DOUBLETALK_MS),
        { name: s.name, atMs: now },
      ];
      setDoubleTalk(doubleTalkCopy(speakers.current, now));
      if (clearSpeak) {
        clearTimeout(clearSpeak);
      }
      clearSpeak = setTimeout(() => {
        setSpeaking(null);
        setDoubleTalk(null);
      }, 2000);
    });
    return () => {
      offPeers();
      offSpeak();
      if (clearSpeak) {
        clearTimeout(clearSpeak);
      }
    };
  }, [open]);

  // An empty channel diagnoses itself (field test #8: two routers behind
  // one Wi-Fi name left "Nobody else..." as the app's only word). First
  // tick at WALKIE_DIAG_MS — discovery resolves in seconds, so a channel
  // still empty then is empty, not slow — and re-checked at the same
  // cadence so joining the right Wi-Fi clears the message in place.
  useEffect(() => {
    if (!open || peers.length > 0) {
      setDiag(null);
      return;
    }
    let alive = true;
    const timer = setInterval(() => {
      void diagnoseWalkieSilence(crewCode, myCardId).then(d => {
        if (alive) {
          setDiag(d);
        }
      });
    }, WALKIE_DIAG_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, peers.length, crewCode, myCardId]);

  const toggleOpen = useCallback(() => {
    (async () => {
      try {
        if (open) {
          await stopTalking();
          await stopWalkie();
          setOpen(false);
          setTalking(false);
          setPeers([]);
          setTalkingTo(0);
        } else {
          await startWalkie(crewCode, myCardId, myName);
          setOpen(true);
        }
      } catch (e: any) {
        Alert.alert('Before you talk', e?.message ?? String(e));
      }
    })();
  }, [open, crewCode, myCardId, myName]);

  const pressIn = useCallback(() => {
    (async () => {
      try {
        await startTalking();
        setTalking(true);
        announce('Talking — let go to stop');
      } catch (e: any) {
        setTalking(false);
        Alert.alert(
          'Before you talk',
          e?.code === 'permission' || /microphone|permission/i.test(String(e?.message))
            ? 'Playa Pal needs the microphone for live talk — allow it and hold the button again.'
            : e?.message ?? String(e),
        );
      }
    })();
  }, []);

  const pressOut = useCallback(() => {
    if (talking) {
      // Announce only a REAL stop — a failed start already alerted.
      announce('Stopped talking');
    }
    setTalking(false);
    void stopTalking();
  }, [talking]);

  if (!walkiePresent()) {
    return null; // no dead affordance on a build without the module
  }

  return (
    <View style={styles.wrap}>
      {/* The opener names its state (a11y review 2026-08-24): expanded +
          on/off travel to a screen reader, not just the emoji and color. */}
      <Pressable
        onPress={toggleOpen}
        accessibilityRole="button"
        accessibilityLabel={
          open ? 'Walkie is on — tap to turn off' : 'Open the walkie'
        }
        accessibilityState={{ expanded: open }}
        style={styles.toggleTap}>
        <Text style={styles.toggle}>{open ? '🎙 Walkie · on — tap to turn off' : '🎙 Walkie'}</Text>
      </Pressable>
      {open ? (
        <View>
          {peers.length === 0 ? (
            // Only while we cannot yet say WHY (the first WALKIE_DIAG_MS, or
            // a native that cannot tell), or when the diagnosis is the quiet
            // 'alone' footnote, which never claims the channel is empty.
            // When the diagnosis IS the answer it REPLACES this line instead
            // of sitting on top of it: stacked, the generic sentence is read
            // first and buries the one the camper can act on. Measured in the
            // field — the tester read "nobody else on the channel yet" and
            // stopped, with the split-network explanation directly beneath.
            !diag || diag.kind === 'alone' ? (
              <Text style={styles.peers}>Nobody else on the channel yet.</Text>
            ) : null
          ) : (
            <Text style={styles.peers}>
              {talkingTo > 0 && talkingTo < peers.length
                ? // Over the ceiling: name BOTH numbers. "On the channel: 12
                  // people" while the radio reaches 9 is a lie of omission,
                  // and it is the kind a camper only discovers by not being
                  // heard. talkingTo is the NATIVE cap's own count, not a
                  // number this screen derived.
                  `On the channel: ${peers.join(', ')} — talking to ${talkingTo} of ${peers.length}`
                : `On the channel: ${peers.join(', ')}`}
            </Text>
          )}
          {walkieCapCopy(peers.length) ? (
            // The channel is at its ceiling. Says the limit, says this phone
            // is talking to the first N, and routes the rest to the voice
            // note — which is a PEER of live talk, not a consolation prize
            // (owner ruling 16:20), and at this pod size the better tool.
            <Text style={styles.diag} accessibilityLiveRegion="polite">
              {walkieCapCopy(peers.length)}
            </Text>
          ) : null}
          {peers.length === 0 && diag ? (
            <Text
              style={diag.kind === 'alone' ? styles.diagQuiet : styles.diag}
              accessibilityLiveRegion="polite">
              {walkieDiagnosisCopy(diag)}
            </Text>
          ) : null}
          <Pressable
            onPressIn={pressIn}
            onPressOut={pressOut}
            accessibilityRole="button"
            accessibilityLabel="Hold to talk"
            style={[styles.ptt, talking && styles.pttLive]}>
            <Text style={styles.pttText}>
              {talking ? 'TALKING — let go to stop' : 'HOLD TO TALK'}
            </Text>
          </Pressable>
          {speaking ? (
            <Text style={styles.speaking}>🔊 {speaking} is talking</Text>
          ) : null}
          {doubleTalk ? (
            // PUNCHLIST #12: two people on one channel interleave into one
            // PCM stream — not two voices, neither voice. The speaker hears
            // themselves fine and has no other way to learn nobody else did.
            <Text style={styles.diag} accessibilityLiveRegion="assertive">
              {doubleTalk}
            </Text>
          ) : null}
          <Text style={styles.hint}>
            Live talk works when pod phones share the same Wi-Fi — the camp
            mailbox phone's hotspot or the camp router. No internet needed.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  toggle: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
  // The opener is the panel's only door — give it the 44pt floor (a11y
  // review 2026-08-24).
  toggleTap: { justifyContent: 'center', minHeight: tap.minHeight },
  peers: { color: colors.faded, fontSize: type.small, marginTop: spacing.sm },
  // The actionable diagnoses (no Wi-Fi, split network) wear the status
  // gold; the quiet subnet line stays metadata-faded.
  diag: { color: colors.gold, fontSize: type.small, marginTop: spacing.sm },
  diagQuiet: {
    color: colors.faded,
    fontSize: type.tiny,
    marginTop: spacing.sm,
  },
  ptt: {
    alignItems: 'center',
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    marginTop: spacing.md,
    paddingVertical: spacing.xl,
  },
  pttLive: { backgroundColor: colors.sage },
  // onAccent, not cream: dark mode brightens clay/sage, so the label flips
  // to deep ink there (a11y review 2026-08-24 — cream read 2.58:1 on sage).
  pttText: { color: colors.onAccent, fontSize: type.title, fontWeight: '800' },
  speaking: {
    color: colors.gold,
    fontSize: type.body,
    fontWeight: '700',
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  hint: { color: colors.faded, fontSize: type.tiny, marginTop: spacing.md },
});
