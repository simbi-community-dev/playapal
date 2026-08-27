/**
 * WalkieDeck — the walkie's two APP-LEVEL surfaces, mounted once in App.tsx
 * so they are there whichever tab the camper is on (owner un-defer,
 * 2026-08-25: "with the walkie on, a call must ring wherever the camper is
 * in the app — the camp board, the map, anywhere").
 *
 *  1. THE RING / CALL SURFACE. A call used to render inside WalkiePanel,
 *     which meant it could only be seen from inside the pod card's walkie
 *     stage. It now rides the session (walkieSession.ts), so the ring lands
 *     over whatever is on screen, naming the caller with Answer and Not now,
 *     and answering opens the call right there.
 *
 *  2. THE MINI-BAR. Walkie audio with the stage closed is the new feature,
 *     and it MUST be visible: a hot radio nobody can see is a lie of
 *     omission about the camper's battery. The bar says
 *     what channel is open and who is on it, opens the stage on tap, and
 *     carries the off switch — because the thing that discloses the drain
 *     should also be the thing that ends it.
 *
 * PTT is deliberately NOT here. Holding a button to talk is the stage's
 * gesture, and a live mic reachable from a floating bar on the camp board is
 * exactly the accidental open mic the panel's design has always refused.
 */
import React from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '../components/Text';
import { VideoCallPanel } from './VideoCallPanel';
import {
  setWalkiePanelOpen,
  stopWalkieSession,
  subscribeWalkieSession,
  walkieCallRuntime,
  walkieMiniBarCopy,
  walkieMiniBarShown,
  walkieSessionRevision,
  walkieSessionState,
} from './walkieSession';
import { useHangPulse } from './hangPulse';
import { rungsByName } from './podStatus';
import { nameKey } from './rosterFold';
import { colors, radius, spacing, tap, type } from '../theme';

export function WalkieDeck({ onOpenPanel }: { onOpenPanel: () => void }) {
  React.useSyncExternalStore(subscribeWalkieSession, walkieSessionRevision);
  const s = walkieSessionState();
  const { height } = useWindowDimensions();
  const call = s.call;
  // Evidence for the 'unreachable' ending's walkie route: true ONLY when
  // the call peer holds a PROVEN lo-fi row right now (rung 'ble'). A
  // 'stale' row has no pipe under it, so it must never light this.
  const stillLofi =
    call?.model.peerName != null &&
    rungsByName(s.peers).get(nameKey(call.model.peerName)) === 'ble';
  const phase = call?.model.phase ?? 'idle';
  const ringing = phase === 'ringing';
  // A live call takes the screen; every other visible phase (ringing,
  // calling, connecting, the ended sentence) is a banner that leaves the
  // camper's current tab readable underneath it.
  const live = phase === 'live';
  // ONE of the two windows a hard freeze has been seen in (the other is the
  // pairing sheet, in AwarePairRow). While anything call-shaped is on
  // screen, the native pulse proves both threads are still turning — see
  // src/crews/hangPulse.ts for how to read the pair on a tether.
  useHangPulse(phase !== 'idle' && phase !== 'ended');

  return (
    <>
      {call && phase !== 'idle' ? (
        <View
          style={[
            live ? styles.stage : styles.banner,
            live ? null : { maxHeight: height * 0.6 },
          ]}
          // The ring is the one thing here that must interrupt: a screen
          // reader announces the caller's name assertively (VideoCallPanel
          // owns the sentence) rather than waiting for a lull.
          accessibilityViewIsModal={ringing || live}>
          <VideoCallPanel
            snap={call}
            stillLofi={stillLofi}
            onAnswer={() => walkieCallRuntime()?.answer()}
            onDecline={() => walkieCallRuntime()?.decline()}
            onHangUp={() => walkieCallRuntime()?.hangUp()}
            onToggleVideo={() => walkieCallRuntime()?.toggleVideo()}
            onFlipCamera={() => walkieCallRuntime()?.flipCamera()}
            onToggleMic={() => walkieCallRuntime()?.toggleMic()}
            onDismiss={() => walkieCallRuntime()?.dismiss()}
          />
        </View>
      ) : null}
      {walkieMiniBarShown(s) ? (
        <View style={styles.mini}>
          <Pressable
            onPress={() => {
              setWalkiePanelOpen(true);
              onOpenPanel();
            }}
            accessibilityRole="button"
            accessibilityLabel={`${walkieMiniBarCopy(s)} — tap to open the walkie`}
            style={styles.miniTap}>
            <Text style={styles.miniText} numberOfLines={1}>
              {walkieMiniBarCopy(s)}
            </Text>
            <Text style={styles.miniHint}>tap to open</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void stopWalkieSession();
            }}
            accessibilityRole="button"
            accessibilityLabel="Turn the walkie off"
            style={styles.miniOff}>
            <Text style={styles.miniOffText}>Turn off</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // The banner sits under the header and above everything else, so a ring
  // is the first thing the eye lands on without hiding where the camper was.
  banner: {
    backgroundColor: colors.dust,
    borderColor: colors.haze,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 8,
    left: spacing.md,
    padding: spacing.md,
    position: 'absolute',
    right: spacing.md,
    shadowColor: colors.night,
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    top: spacing.md,
    // Above App.tsx's "X is talking" chip (zIndex 40): a phone ringing at
    // you outranks a note about who is on the channel.
    zIndex: 50,
  },
  // NO PADDING, unlike the banner: a live call is full bleed, and the
  // panel positions its own chrome against these edges (VideoCallPanel's
  // TOP_CHROME / BOTTOM_CHROME). Padding here would frame the other
  // person's face in a dust-coloured mat.
  stage: {
    backgroundColor: colors.dust,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 50,
  },
  // A flex row, NOT an overlay: it is mounted directly above the tab bar
  // and takes its own space there. Floating it would have put a permanent
  // bar over the tabs — the surface that exists to be honest about the
  // radio has no business hiding the way out of the screen.
  mini: {
    alignItems: 'center',
    backgroundColor: colors.haze,
    borderTopColor: colors.dust,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
  },
  miniTap: { flex: 1, justifyContent: 'center', minHeight: tap.minHeight },
  miniText: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  miniHint: { color: colors.faded, fontSize: type.tiny },
  miniOff: {
    justifyContent: 'center',
    minHeight: tap.minHeight,
    paddingLeft: spacing.md,
  },
  miniOffText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
});
