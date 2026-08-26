/**
 * The replayable feature tour (0.7.3) — the Navigate-to-Yes finding,
 * applied (docs/NTY-PATTERNS.md §4): a tour is a durable, revisitable help
 * artifact, never a one-shot modal. Six cards — one per surface, plus the
 * offline closer — paged with Next/Back, closable any time with ✕,
 * replayable forever from Settings.
 *
 * WIRING CONTRACT (the main seat owns both mounts; this file mounts
 * nothing itself):
 * 1. First run — after onboarding, render <Tour onDone={...}/> when
 *    !tourSeen() (from './tourState'). The component fills its parent
 *    absolutely, so render it LAST inside the root view and it overlays
 *    the tabs. onDone means "unmount me" — the tour has already marked
 *    itself seen (on finish AND on ✕: an explicit dismissal is a choice,
 *    and re-showing after one would be exactly the nagging the replay row
 *    exists to prevent).
 * 2. Settings — a "Replay the feature tour" row that mounts this same
 *    component unconditionally; onDone unmounts. No state reset needed:
 *    replay ignores tour_seen by construction.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { markTourSeen } from './tourState';
import { colors, radius, spacing, tap, type } from '../theme';

/** Guarded screen-reader announcement (a11y review 2026-08-24): the dots
 * are silent — page changes get said out loud. try/catch so a bridge
 * without AccessibilityInfo (tests) is a no-op, never a crash. */
function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // no announcer here — the visible card still shows
  }
}

interface Props {
  /** The tour is finished or dismissed — unmount it. Seen-state is
   * already recorded by the time this fires. */
  onDone: () => void;
}

interface TourCard {
  headline: string;
  body: string;
}

export const TOUR_CARDS: TourCard[] = [
  {
    headline: 'Right now, near you',
    body:
      'The Now tab answers the on-playa question: what’s happening near ' +
      'you, right now — and what’s next. Tap the ♡ on any event and ' +
      '♥ Faves keeps your plan in order, with walk times to each.',
  },
  {
    headline: 'Tap the city, follow the arrow',
    body:
      'Tap anything on the map — a camp, an art piece, a bare patch of ' +
      'playa — and the compass aims the arrow at it. And wherever you ' +
      'wander, Take me home is always one tap.',
  },
  {
    headline: 'Your pod, phone to phone',
    body:
      'A pod is your people — a group chat that hops phone to phone ' +
      'over Bluetooth, no signal needed. Leave a note or a voice message ' +
      'on the answering machine; hold the walkie button and the pod hears ' +
      'you live, clearer on a shared camp Wi-Fi and rougher without one.',
  },
  {
    headline: 'An Angel in your pocket',
    body:
      'The Angel is an AI guide that runs entirely on this phone — ' +
      'nothing you ask ever leaves your hand. It’s an optional download, ' +
      'so bring it on wifi before you roll through the gate.',
  },
  {
    headline: 'Your camp, on one board',
    body:
      'Camp is your camp’s own board and notes — who needs what, who ' +
      'knows what — beamed phone to phone with no signal at all.',
  },
  {
    headline: 'Airplane mode is home',
    body:
      'Everything you just saw works offline. No account, no coverage, ' +
      'no waiting on a bar of signal — airplane mode is the intended ' +
      'habitat.',
  },
];

export function Tour({ onDone }: Props) {
  const [page, setPage] = useState(0);
  const last = page === TOUR_CARDS.length - 1;
  const card = TOUR_CARDS[page];

  // Page changes announced, mount quiet — the first card's headline speaks
  // for itself (a11y review 2026-08-24).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    announce(`Step ${page + 1} of ${TOUR_CARDS.length}: ${TOUR_CARDS[page].headline}`);
  }, [page]);

  const finish = () => {
    markTourSeen();
    onDone();
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the tour"
          onPress={finish}
          style={styles.close}
          hitSlop={spacing.md}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
        <Text style={styles.headline}>{card.headline}</Text>
        <Text style={styles.body}>{card.body}</Text>
        {/* The dots SAY where you are (a11y review 2026-08-24): "Step N of
            M" rides the container as its label — and `accessible` is what
            makes it SAYABLE. A bare View is not an accessibility element,
            so the label alone was never spoken and never focusable; the
            row is one spoken string now, which is also how a listener
            landing on card 1 (announce() stays quiet at mount) hears where
            they are at all. */}
        <View
          style={styles.dots}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`Step ${page + 1} of ${TOUR_CARDS.length}`}>
          {TOUR_CARDS.map((c, i) => (
            <View
              key={c.headline}
              style={[styles.dot, i === page && styles.dotActive]}
            />
          ))}
        </View>
        <View style={styles.buttons}>
          {page > 0 ? (
            <Pressable
              style={styles.back}
              onPress={() => setPage(page - 1)}
              accessibilityRole="button"
              accessibilityLabel="Back">
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          ) : (
            <View style={styles.back} />
          )}
          <Pressable
            style={styles.next}
            onPress={last ? finish : () => setPage(page + 1)}
            accessibilityRole="button"
            accessibilityLabel={last ? 'Finish the tour' : 'Next'}>
            <Text style={styles.nextText}>{last ? 'Let’s go' : 'Next'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.overlayScrim, // night-at-dusk veil, both modes
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.xl,
  },
  close: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    padding: spacing.sm,
  },
  closeText: { color: colors.faded, fontSize: type.body, fontWeight: '700' },
  headline: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    marginBottom: spacing.md,
    marginRight: spacing.xl, // clear of the ✕
  },
  body: { color: colors.night, fontSize: type.body, lineHeight: 24 },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.haze,
    marginHorizontal: spacing.xs,
  },
  dotActive: { backgroundColor: colors.clay },
  buttons: { flexDirection: 'row', justifyContent: 'space-between' },
  back: {
    ...tap, // 44pt floor (a11y review 2026-08-24) — Back was ~35pt tall
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minWidth: 72,
  },
  backText: { color: colors.faded, fontSize: type.body, fontWeight: '600' },
  next: {
    ...tap,
    alignItems: 'center',
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  // onAccent, not cream: dark mode brightens clay, so the label flips to
  // deep ink there (a11y review 2026-08-24).
  nextText: { color: colors.onAccent, fontSize: type.body, fontWeight: '800' },
});
