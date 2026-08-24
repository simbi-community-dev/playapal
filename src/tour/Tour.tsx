/**
 * The replayable feature tour (0.7.3) — the Navigate-to-Yes finding,
 * applied (docs/NTY-PATTERNS.md §4): a tour is a durable, revisitable help
 * artifact, never a one-shot modal. Five cards, one per surface, paged
 * with Next/Back, closable any time with ✕, replayable forever from
 * Settings.
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
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { markTourSeen } from './tourState';
import { colors, radius, spacing, type } from '../theme';

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

  const finish = () => {
    markTourSeen();
    onDone();
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        <Pressable
          accessibilityLabel="Close the tour"
          onPress={finish}
          style={styles.close}
          hitSlop={spacing.md}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
        <Text style={styles.headline}>{card.headline}</Text>
        <Text style={styles.body}>{card.body}</Text>
        <View style={styles.dots}>
          {TOUR_CARDS.map((c, i) => (
            <View
              key={c.headline}
              style={[styles.dot, i === page && styles.dotActive]}
            />
          ))}
        </View>
        <View style={styles.buttons}>
          {page > 0 ? (
            <Pressable style={styles.back} onPress={() => setPage(page - 1)}>
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          ) : (
            <View style={styles.back} />
          )}
          <Pressable
            style={styles.next}
            onPress={last ? finish : () => setPage(page + 1)}>
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
    backgroundColor: 'rgba(58, 47, 40, 0.85)', // colors.night at dusk
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
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minWidth: 72,
  },
  backText: { color: colors.faded, fontSize: type.body, fontWeight: '600' },
  next: {
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  nextText: { color: colors.cream, fontSize: type.body, fontWeight: '800' },
});
