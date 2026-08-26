/**
 * HelpScreen — the manual a camper has when there is no manual.
 *
 * THE BAR (owner ask, 2026-08-25): someone at Black Rock City with no
 * internet and nobody to ask opens this and understands what the app does
 * offline, how the phones find each other, and what it honestly cannot do
 * yet. Nothing here is clever; it is meant to be read standing up, in
 * daylight, by a person who is mid-plan.
 *
 * THE PATTERN IS PACKREADER'S, deliberately: a full-screen surface owned by
 * ONE piece of Settings state, with the same '‹ back' header, the same
 * hardware-back handling, and the same sand-on-dust cards. No navigator was
 * added for it, because the app does not have one and this screen is not
 * the reason to grow one.
 *
 * EVERY WORD LIVES IN src/help/helpContent.ts. This file lays out strings
 * and owns no copy of its own — so the regression suite can hold the
 * vocabulary law and the README coupling over the content module without
 * ever rendering a component.
 */
import React, { useEffect } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  HELP_LIMITATIONS,
  HELP_LIMITS_INTRO,
  HELP_LIMITS_TITLE,
  HELP_SECTIONS,
} from '../help/helpContent';
import { colors, radius, spacing, tap, type } from '../theme';

interface Props {
  onClose: () => void;
}

export function HelpScreen({ onClose }: Props) {
  // Hardware back closes Help rather than backgrounding the app — the
  // PackReader lesson from the P7/emulator field test, 08-20.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel="Close help">
          <Text style={styles.headerBtnText}>‹ back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          How Playa Pal works
        </Text>
        {/* Right spacer keeps the title centred (the PackReader shape). */}
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {HELP_SECTIONS.map(s => (
          <View key={s.id}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {s.title}
            </Text>
            <View style={styles.card}>
              {s.body.map((p, i) => (
                <Text key={i} style={[styles.para, i > 0 && styles.paraGap]}>
                  {p}
                </Text>
              ))}
            </View>
          </View>
        ))}

        {/* The load-bearing block. Its own heading weight and its own card
            per limitation: a camper skimming for the edges should be able
            to find them without reading the rest, and each edge should be
            possible to read alone. */}
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {HELP_LIMITS_TITLE}
        </Text>
        <Text style={styles.limitsIntro}>{HELP_LIMITS_INTRO}</Text>
        {HELP_LIMITATIONS.map(l => (
          <View key={l.topic} style={styles.limitCard}>
            <Text style={styles.limitTitle}>{l.title}</Text>
            <Text style={styles.para}>{l.body}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.dust,
    paddingHorizontal: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  headerBtn: { minWidth: 72, minHeight: tap.minHeight, justifyContent: 'center' },
  headerBtnText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  title: {
    flex: 1,
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    textAlign: 'center',
  },
  content: { paddingBottom: spacing.xl },
  sectionTitle: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  para: { color: colors.night, fontSize: type.body, lineHeight: 24 },
  paraGap: { marginTop: spacing.md },
  limitsIntro: {
    color: colors.faded,
    fontSize: type.small,
    marginBottom: spacing.sm,
    marginTop: -spacing.xs,
  },
  // A limitation wears a warm left edge rather than a warning colour: these
  // are facts about a tool, not alarms (the pod card's calm-absence rule,
  // applied to prose).
  limitCard: {
    backgroundColor: colors.sand,
    borderLeftColor: colors.clay,
    borderLeftWidth: 3,
    borderRadius: radius.card,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  limitTitle: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '800',
    marginBottom: spacing.xs,
  },
});
