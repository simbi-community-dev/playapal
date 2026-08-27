/**
 * INFO TAP — the circled "?" that holds the paragraph.
 *
 * THE OWNER'S ASK (2026-08-26): "lots of places in the app where there is
 * like a paragraph of explanation, just sitting in tiny print in the main
 * screen … maybe put it behind a question mark with a circle around it, so
 * one curious tap gives the full info. tufte would be sad!" He is right:
 * a screen that explains itself at all times is a screen whose ink is
 * mostly not data. The explanation is good — it just does not need to be
 * shouted at a camper who already knows.
 *
 * WHAT GOES BEHIND IT, AND WHAT NEVER DOES. This component is for STATIC
 * TEACHING TEXT — the sentence that reads the same on every phone, every
 * day, whether or not anything is wrong ("Cards travel phone-to-phone
 * only…"). It is emphatically NOT for the app's diagnosis lines: a quiet
 * link, a paused share, a churn notice, a "nobody can see you right now"
 * appear ON a condition and are the only warning a camper gets. Those stay
 * inline and loud. Hiding a status behind a tap is how a phone lies
 * politely.
 *
 * WHY A BOTTOM CARD AND NOT A POPOVER. A popover has to measure itself
 * against the trigger, and every screen that needs this component is a
 * ScrollView (Settings, Camp, Compass, Friends): a measured position is
 * correct for exactly as long as nobody scrolls. A Modal owes nothing to
 * layout, dismisses on a tap anywhere, takes the hardware back button on
 * Android for free, and is already this app's idiom — the friend-card QR
 * sheet is the same shape, down to the accessible={false} veil.
 *
 * DISMISS IS EVERYWHERE. The veil fills the screen and the card sits on
 * it, so a tap on either one closes: there is no aiming, no corner ✕ to
 * find at night with dusty hands. The paragraph itself carries the same
 * tap, because it lives in a ScrollView that would otherwise eat it.
 * "Got it" exists anyway, because a veil is not a thing a screen reader
 * can tap — and it sits OUTSIDE the scroll, so the longest explanation at
 * the biggest size can never push the exit off the card.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text, useTextScale } from './Text';
import { colors, radius, spacing, tap, type } from '../theme';

/**
 * The drawn circle, in points at the default rung — and it GROWS with the
 * glyph inside it (a11y review 2026-08-26).
 *
 * The ? is type.small. Turn the dial to Biggest, add the OS's own font
 * scale on top, and an 18pt-and-up glyph in a frozen 22pt circle is a
 * clipped mark with Android's line padding pushing it further out. The
 * other option on the table was to call the ring decorative and exempt it;
 * a question mark nobody can read is not decoration, and the camper it
 * fails is precisely the one who turned the dial up to find it.
 */
const RING_PT = 22;

interface Props {
  /** What the explanation is ABOUT, in the camper's words — "the field
   * log", "sharing cards". It titles the card and, more importantly, it is
   * what a screen reader announces: "More about the field log, button".
   * Never a sentence; this is a noun phrase that finishes "More about …". */
  topic: string;
  /** The explanation itself. The plain-string path, which is what nearly
   * every conversion wants. */
  text?: string;
  /** …and the escape hatch, for an explanation that needs more than one
   * paragraph or carries its own emphasis. Ignored when `text` is given, so
   * a caller can never ship two competing explanations by accident. */
  children?: React.ReactNode;
}

/**
 * A circled ? that opens its paragraph. Quiet until asked.
 *
 * The glyph is drawn, not typed: the "?" in a bordered circle themes with
 * the palette in both modes, where a ❓/⍰ character would be whatever the
 * device font decided and would carry an emoji's color into a dusty
 * monochrome row.
 */
export function InfoTap({ topic, text, children }: Props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const scale = useTextScale();
  // Identity at the default rung, the same discipline growTextStyle keeps:
  // every screen that carries a ? renders one of these on every frame, and
  // the rung most campers never leave should allocate nothing.
  const ring = useMemo(
    () =>
      scale === 1
        ? styles.ring
        : [styles.ring, { height: RING_PT * scale, width: RING_PT * scale }],
    [scale],
  );
  return (
    <>
      <Pressable
        style={styles.trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`More about ${topic}`}
        accessibilityHint="Opens the full explanation"
        accessibilityState={{ expanded: open }}>
        <View style={ring}>
          <Text style={styles.glyph}>?</Text>
        </View>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={close}>
        {/* accessible={false} on the veil is load-bearing (the a11y sweep
            2026-08-24 lesson the friend-card sheet already carries): a
            Pressable is an accessibility element by default, so a
            full-screen one swallows the card below it into a single
            unlabelled blob. */}
        <Pressable style={styles.veil} onPress={close} accessible={false}>
          <View
            style={styles.card}
            accessibilityViewIsModal
            onAccessibilityEscape={close}>
            <Text style={styles.title} accessibilityRole="header">
              {topic}
            </Text>
            {/* THE PARAGRAPH SCROLLS; THE WAY OUT DOES NOT (a11y review
                2026-08-26). The card stops at 85% of the screen, and a long
                explanation at Biggest with the OS scale on top used to push
                "Got it" past that ceiling — off the bottom of a card whose
                only other exit is a veil a screen reader cannot tap. Title
                and button sit OUTSIDE this scroll and never move; only the
                explanation runs. */}
            <ScrollView style={styles.bodyScroll}>
              {/* A ScrollView takes the touch responder, so the veil below
                  it stops hearing the tap that used to close from anywhere.
                  This hands that promise back: a tap closes, a drag still
                  scrolls (Pressable yields the responder on move), and
                  accessible={false} keeps the paragraph beneath it its own
                  announced element instead of one unlabelled blob. */}
              <Pressable onPress={close} accessible={false}>
                {text !== undefined ? (
                  <Text style={styles.body}>{text}</Text>
                ) : (
                  children
                )}
              </Pressable>
            </ScrollView>
            <Pressable
              style={styles.done}
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Got it">
              <Text style={styles.doneText}>Got it</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // 44pt floor around a 22pt mark (the theme's `tap`): the ring is small
  // so the row stays calm, the target is not.
  trigger: {
    ...tap,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    alignItems: 'center',
    borderColor: colors.clay,
    borderRadius: radius.chip,
    // The stroke stays a hairline at every rung: it is the line AROUND the
    // mark, not part of the mark. radius.chip is 999, so the shape is a
    // circle at any size the dial asks for.
    borderWidth: 1.5,
    height: RING_PT,
    justifyContent: 'center',
    width: RING_PT,
  },
  glyph: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '700',
    // The glyph's own line box sits low inside a 22pt circle on Android;
    // this is optical centering, not a magic number looking for a home.
    lineHeight: type.small + 2,
  },
  veil: {
    backgroundColor: colors.backdrop,
    flex: 1,
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.sand,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    maxHeight: '85%',
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  // flexShrink, and NOT flex: 1 — the difference IS the cure. flex: 1 hands
  // the scroll a zero flex-basis, and inside a card whose height comes from
  // its own content that collapses the paragraph to nothing and leaves a
  // title sitting on a button. flexShrink lets the card grow with the text
  // up to the 85% ceiling and only then takes the overflow into the scroll.
  bodyScroll: {
    flexShrink: 1,
  },
  // Body copy at full reading size, not the tiny print it came out of —
  // the whole point of moving it here is that it gets room.
  body: {
    color: colors.night,
    fontSize: type.body,
    lineHeight: 24,
  },
  done: {
    ...tap,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  doneText: {
    color: colors.clay,
    fontSize: type.body,
    fontWeight: '700',
  },
});
