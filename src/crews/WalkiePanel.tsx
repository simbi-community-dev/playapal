/**
 * WalkiePanel — live talk for the pod (docs/CREW-DESIGN.md §6d), the third
 * verb on the pod: Find / Message / TALK. Mounted inside the Pod card;
 * opens into a simple stage: who's on the channel, one huge hold-to-talk
 * button (the mic runs only while held — the button IS the consent
 * surface), who's talking, and the honest Wi-Fi constraint said out loud.
 *
 * THE PANEL IS A VIEW, NOT THE RADIO (owner un-defer, 2026-08-25). The
 * session — the open channel, its roster, and the CallRuntime that rides
 * the same sockets — is owned above this component in walkieSession.ts, so
 * a call rings wherever the camper is and closing the STAGE no longer
 * closes the CHANNEL. What still lives here is what only makes sense in
 * front of the stage: hold-to-talk, the channel's names and diagnosis, and
 * the one explicit call button per callable podmate.
 *
 * PTT STAYS HERE ON PURPOSE. A live mic reachable from a floating bar on
 * some other tab is the accidental open mic this design has always refused
 * — the held button is the consent gesture, and you have to be looking at
 * it to hold it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../components/Text';
import { InfoTap } from '../components/InfoTap';
import {
  WALKIE_DIAG_MS,
  diagnoseWalkieSilence,
  formatChannelNames,
  onWalkieSpeaking,
  doubleTalkCopy,
  walkieCapCopy,
  startTalking,
  stopTalking,
  WALKIE_DOUBLETALK_MS,
  WALKIE_CHURN_MS,
  linkChurnCopy,
  walkieDiagnosisCopy,
  walkiePresent,
  type WalkieDiagnosis,
  type WalkieSpeakerSample,
} from './walkie';
import { AwarePairRow } from './AwarePairRow';
import { nameKey } from './rosterFold';
import { ensureCrewPermissions } from './radio';
import { armPocketAlerts } from './pocketAlerts';
import {
  setWalkiePanelOpen,
  startWalkieSession,
  stopWalkieSession,
  subscribeWalkieSession,
  walkieCallRuntime,
  walkieOnFor,
  walkieSessionRevision,
  walkieSessionState,
} from './walkieSession';
import { PTT_SUPPRESSED_COPY, walkiePttSuppressed } from './videoCall';
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
  crewId,
  crewCode,
  myCardId,
  myName,
}: {
  crewId: string;
  crewCode: string;
  myCardId: string;
  myName: string;
}) {
  React.useSyncExternalStore(subscribeWalkieSession, walkieSessionRevision);
  const sess = walkieSessionState();
  // TWO FACTS, NOT ONE. `on` is the radio — and it is the radio FOR THIS
  // POD, because the session outlives this card and can be holding a
  // different pod's channel. `open` is only whether the stage is showing.
  const on = walkieOnFor(crewId);
  const open = on && sess.panelOpen;
  // Entries, not bare names: each row knows which rung carries it, so the
  // lo-fi badge lands on exactly the peers that sound like it (§5a).
  const peers = on ? sess.peers : [];
  const peerRows = on ? sess.peerRows : [];
  const talkingTo = on ? sess.talkingTo : 0;
  const callSnap = on ? sess.call : null;
  const [talking, setTalking] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [diag, setDiag] = useState<WalkieDiagnosis | null>(null);
  // Recent speakers, for the double-talk sentence (PUNCHLIST #12). A ref,
  // not state: it is written on every speaking event and read only when one
  // arrives, so making it state would re-render the panel once a second for
  // a value the render does not otherwise use.
  const speakers = useRef<WalkieSpeakerSample[]>([]);
  const [doubleTalk, setDoubleTalk] = useState<string | null>(null);

  // Membership-churn sample ring — PANEL-LOCAL on purpose: it dies with
  // the stage, so there is nothing to clear in stopWalkieSession (the
  // staleness class PodLinks was built to forbid). It observes the PAST —
  // the sentence appears only after the channel line has already flipped
  // twice inside the window, and ages out as renders arrive.
  const churn = useRef<{ names: string; flips: number[] }>({
    names: '',
    flips: [],
  });
  {
    const names = peers
      .map(p => p.name)
      .sort()
      .join('|');
    if (names !== churn.current.names) {
      const now = Date.now();
      churn.current = {
        names,
        flips: [
          ...churn.current.flips.filter(t => now - t <= WALKIE_CHURN_MS),
          now,
        ].slice(-8),
      };
    }
  }
  const churnLine = linkChurnCopy(churn.current.flips, Date.now());

  // Who is talking, and the double-talk warning, are STAGE copy — App.tsx
  // carries the app-wide "X is talking" chip for everywhere else.
  useEffect(() => {
    if (!open) {
      return;
    }
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
      offSpeak();
      if (clearSpeak) {
        clearTimeout(clearSpeak);
      }
    };
  }, [open]);

  // TERMINAL-STATE HYGIENE, EVOLVED. This used to be "unmount = channel
  // off", because the panel WAS the radio. It cannot be that any more —
  // unmounting is what a tab switch and a pod switch do, and killing the
  // channel there is the exact defect this lane exists to fix. What an
  // unmounted stage still owes is the MIC: `talking` is panel-local state
  // and a held button that unmounts mid-hold would otherwise leave the
  // recorder running with no button to let go of.
  useEffect(
    () => () => {
      void stopTalking();
    },
    [],
  );

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

  /** The radio switch. On -> off tears the whole session down (runtime
   * before transport, walkieSession.ts owns that order); off -> on opens
   * the channel AND the stage, because opening the walkie is the gesture
   * that asked for both. */
  const toggleWalkie = useCallback(() => {
    (async () => {
      try {
        if (on) {
          await stopWalkieSession();
          setTalking(false);
        } else {
          // Rung 3 rides BLE, and on Android 12+ that is a runtime grant
          // this user may never have given (pod sharing asks it too, but a
          // walkie-first user hasn't been there). Ask HERE, in context —
          // opening the walkie is the gesture the radio serves. A decline
          // is not an error: the Wi-Fi rungs run regardless, the BLE rung
          // just contributes no peers (the native fencing law).
          await ensureCrewPermissions().catch(() => false);
          // The walkie is also the CALL surface, and an incoming call is
          // the one thing that buzzes a pocketed phone — so opening it is
          // the walkie-side in-context moment for the notification ask
          // (pocketAlerts.ts; sharing start is the pod-side one). Awaited
          // so two OS dialogs never stack; a stored decline returns
          // instantly and silently.
          await armPocketAlerts();
          await startWalkieSession({ crewId, crewCode, myCardId, myName });
          setWalkiePanelOpen(true);
        }
      } catch (e: any) {
        Alert.alert('Before you talk', e?.message ?? String(e));
      }
    })();
  }, [on, crewId, crewCode, myCardId, myName]);

  // The call OWNS the mic while it runs (decision, docs/VIDEO-CALLS.md §5):
  // WebRTC's audio unit and the walkie's raw recorder would contend for one
  // microphone, and the call's loudspeaker into the walkie's open mic is an
  // echo machine. Suppressed with the reason on screen, never grayed
  // mysteriously. Voice notes (the async lane) are untouched.
  const pttSuppressed =
    callSnap != null && walkiePttSuppressed(callSnap.model.phase);

  // The render gate above suppresses NEW talk; this effect covers what it
  // cannot: a talk already HELD when the call takes the mic must stop NOW —
  // `disabled` only blocks future presses, so the walkie's recorder was
  // still live at the call's getUserMedia, the two-concurrent-
  // VOICE_COMMUNICATION-clients contention §5 forbids.
  //
  // Its sibling — muting walkie PLAYBACK for the call's duration — moved UP
  // to walkieSession.ts with the runtime, because pod voice now plays with
  // the stage closed, so the echo path exists whether or not anyone is
  // looking at this component.
  useEffect(() => {
    if (pttSuppressed) {
      setTalking(false);
      void stopTalking();
    }
  }, [pttSuppressed]);

  const pressIn = useCallback(() => {
    if (pttSuppressed) {
      return; // the caption under the button says why
    }
    (async () => {
      try {
        // ASK, don't just fail (owner field test 2026-08-25: the walkie
        // only rejected on a missing mic and left the camper to enable it
        // through the voice-note screen first). The system prompt fires
        // here on the FIRST hold — the held button is the consent gesture,
        // so asking at press is exactly in context. A native reject still
        // Alerts below (a permanently-denied mic returns never_ask_again).
        if (Platform.OS === 'android') {
          const got = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          );
          if (got !== PermissionsAndroid.RESULTS.GRANTED) {
            setTalking(false);
            Alert.alert(
              'Before you talk',
              got === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
                ? 'Playa Pal needs the microphone for live talk. Turn it on in Settings › Apps › Playa Pal › Permissions, then hold the button again.'
                : 'Playa Pal needs the microphone for live talk — allow it and hold the button again.',
            );
            return;
          }
        }
        await startTalking();
        setTalking(true);
        announce('Talking — let go to stop');
      } catch (e: any) {
        setTalking(false);
        Alert.alert(
          'Before you talk',
          // ONLY a real permission refusal earns the Settings slate — the
          // owner's mini showed 'enable mic' over a granted mic because a
          // 'record' reject's message contains the word 'microphone'
          // (field report 2026-08-25). A busy/unavailable mic says its own
          // honest sentence with no CTA.
          e?.code === 'permission'
            ? 'Playa Pal needs the microphone for live talk — allow it and hold the button again.'
            : e?.message ?? String(e),
        );
      }
    })();
  }, [pttSuppressed]);

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
          on/off travel to a screen reader, not just the emoji and color.
          It is the RADIO switch — the honest on/off for this pod — and the
          stage's own Hide row below is what closes the view alone. */}
      <Pressable
        onPress={toggleWalkie}
        accessibilityRole="button"
        accessibilityLabel={
          on ? 'Walkie is on — tap to turn off' : 'Open the walkie'
        }
        accessibilityState={{ expanded: open }}
        style={styles.toggleTap}>
        <Text style={styles.toggle}>{on ? '🎙 Walkie · on — tap to turn off' : '🎙 Walkie'}</Text>
      </Pressable>
      {on && !open ? (
        // The channel is this pod's and running, but the stage is hidden —
        // say where the stage went, so the row is never a dead switch.
        <Pressable
          onPress={() => setWalkiePanelOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Show the walkie stage"
          style={styles.stageTap}>
          <Text style={styles.stageVerb}>Show the walkie — it stays on</Text>
        </Pressable>
      ) : null}
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
                  `On the channel: ${formatChannelNames(peers)} — talking to ${talkingTo} of ${peers.length}`
                : `On the channel: ${formatChannelNames(peers)}`}
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
          {peers.some(p => p.rung === 'stale') ? (
            // A (quiet) row is a person the radio stopped answering about:
            // the one sentence a camper needs is that their VOICE may not
            // be landing while the async lanes still are.
            <Text style={styles.diag} accessibilityLiveRegion="polite">
              A quiet link stopped answering a moment ago — your voice may
              not be reaching them. Messages and voice notes still go.
            </Text>
          ) : null}
          {churnLine ? (
            <Text style={styles.diag} accessibilityLiveRegion="polite">
              {churnLine}
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
            disabled={pttSuppressed}
            accessibilityRole="button"
            accessibilityLabel={
              pttSuppressed ? 'Live talk paused during the call' : 'Hold to talk'
            }
            // The visual state lives in the button's color and its caption —
            // both invisible to a screen reader, which announced "Hold to
            // talk, button" identically whether the mic was hot or not. A
            // camper who cannot see the green cannot know they are LIVE ON
            // AIR, and an open mic you do not know about is the worst state
            // a walkie has.
            accessibilityState={{ selected: talking, disabled: pttSuppressed }}
            style={[
              styles.ptt,
              talking && styles.pttLive,
              pttSuppressed && styles.pttPaused,
            ]}>
            <Text style={styles.pttText}>
              {pttSuppressed
                ? 'ON A CALL'
                : talking
                ? 'TALKING — let go to stop'
                : 'HOLD TO TALK'}
            </Text>
          </Pressable>
          {pttSuppressed ? (
            <Text style={styles.hint} accessibilityLiveRegion="polite">
              {PTT_SUPPRESSED_COPY}
            </Text>
          ) : null}
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
          {callSnap && callSnap.model.phase === 'idle' && peerRows.length > 0 ? (
            // One explicit button per callable podmate — 1:1, opt-in, never
            // ambient (owner scope 2026-08-25). Only identities the wire
            // attributed get a row; an un-hashed "someone" is not an
            // address a call can dial. The call itself renders app-level
            // (WalkieDeck), so placing one here and walking to the map
            // keeps the call on screen.
            <View style={styles.callRows}>
              {peerRows.map(r => (
                <Pressable
                  key={r.hash}
                  onPress={() => walkieCallRuntime()?.place(r.hash, r.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`Video call ${r.name}`}
                  style={styles.callBtn}>
                  <Text style={styles.callBtnText}>📹 Call {r.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {(() => {
            // A lo-fi-only podmate has no Call button by construction
            // (calls need a datagram row), and silence about the absence
            // read as a fault. Name the ceiling and the working
            // alternative — gated on PROVEN 'ble' rows only: a 'stale'
            // name here would be the same overclaim the (quiet) badge
            // exists to end.
            if (!callSnap || callSnap.model.phase !== 'idle') {
              return null;
            }
            const lofiOnly = peers
              .filter(
                p =>
                  p.rung === 'ble' &&
                  !peerRows.some(r => nameKey(r.name) === nameKey(p.name)),
              )
              .map(p => p.name);
            return lofiOnly.length > 0 ? (
              <Text style={styles.hint}>
                Video calls need a full-quality link.{' '}
                {lofiOnly.join(', ')}{' '}
                {lofiOnly.length === 1 ? 'comes' : 'come'} through lo-fi —
                hold to talk instead.
              </Text>
            ) : null;
          })()}
          {/* The one thing on this stage that makes the radio reach
              FURTHER rather than telling you about it. It self-hides on
              Android, on any build without the native pair, and on any
              iPhone whose Wi-Fi Aware probe is not a plain ok — so on most
              phones this line renders nothing at all. Placed below the
              live controls on purpose: it is a setup gesture, and it must
              never compete with hold-to-talk. */}
          <AwarePairRow />
          <Pressable
            onPress={() => setWalkiePanelOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Hide the walkie stage — the walkie stays on"
            style={styles.stageTap}>
            <Text style={styles.stageVerb}>Hide — the walkie stays on</Text>
          </Pressable>
          {/* THE TUFTE PASS (owner ask 2026-08-26): static link-quality
              teaching, on screen at all times under a live radio. The
              conditional lo-fi line above it — which names actual people —
              stays exactly where it is; that one appears ON a condition and
              is the only warning a camper gets.

              THE MATRIX, corrected the same night (owner: "i swore i did
              successfully call the iphone with the p9 … on the same wifi").
              He had, and the old sentence undersold it two ways: a shared
              Wi-Fi lifts EVERY pair including an iPhone and an Android, and
              two Android phones already sound clean with no network at
              all. */}
          <View style={styles.hintInfo}>
            <InfoTap
              topic="link quality"
              text={
                'Some pairs of phones link at full quality; others always ' +
                'come through rougher — marked lo-fi. Both carry your ' +
                'voice. Any two phones on one Wi-Fi get full quality, an ' +
                'iPhone and an Android included; two Android phones manage ' +
                'it with no network at all, over their own direct ' +
                'phone-to-phone link. Otherwise podmates close by still ' +
                'come through lo-fi.'
              }
            />
          </View>
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
  // Show/Hide the stage: a quiet verb, deliberately not styled like the
  // radio switch above it — one of them changes what the phone is doing.
  stageTap: { justifyContent: 'center', minHeight: tap.minHeight },
  stageVerb: { color: colors.sage, fontSize: type.small, fontWeight: '700' },
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
  // Paused-for-the-call wears the divider's haze, not a mystery gray: the
  // caption right under it carries the reason.
  pttPaused: { backgroundColor: colors.haze },
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
  callRows: { marginTop: spacing.sm },
  callBtn: {
    justifyContent: 'center',
    minHeight: tap.minHeight,
  },
  callBtnText: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
  hint: { color: colors.faded, fontSize: type.tiny, marginTop: spacing.md },
  // The link-quality lesson's ? keeps the paragraph's own top margin, so
  // the foot of the stage sits where it always did.
  hintInfo: { marginTop: spacing.md },
});
