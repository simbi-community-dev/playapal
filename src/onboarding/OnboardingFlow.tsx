/**
 * First-run onboarding flow (0.7.3) — three short steps, every one
 * skippable, nothing required.
 *
 * Modeled on the Navigate-to-Yes study (docs/NTY-PATTERNS.md §1): a short
 * separate first-run flow, an optional name that pays off later in
 * personalization, and a camp picked from data the app already has (with
 * freehand text honored — theme camps aren't the only camps).
 *
 * ONE DELIBERATE DEPARTURE, on purpose and per the same study (§2): NO
 * permission requests live in this flow. NTY's own rationale copy shows the
 * winning shape — name the payoff at the moment the feature needs the
 * permission — so Playa Pal keeps every OS ask in-context at feature use
 * (location when the compass or walk times first matter, never as a
 * first-run gate), and every denial stays recoverable inside the feature.
 *
 * Wiring contract (mount point + the settings the main seat consumes):
 * see src/onboarding/onboarding.ts.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../components/Text';
import {
  campDirectory,
  markOnboardingDone,
  saveOnboardingChoices,
  type CampEntry,
  type OnboardingChoices,
} from './onboarding';
import { colors, radius, spacing, tap, type } from '../theme';
import { announce } from '../util/a11y';

interface Props {
  /** Called after the flow has persisted its choices and marked itself
   * done — the host only needs to unmount it. */
  onDone: () => void;
}

const STEPS = ['welcome', 'name', 'camp'] as const;
type Step = (typeof STEPS)[number];

/** Render cap for the camp list — the directory holds hundreds of camps and
 * the search box narrows faster than any scroll. */
const MAX_ROWS = 50;

export function OnboardingFlow({ onDone }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [campQuery, setCampQuery] = useState('');
  const [picked, setPicked] = useState<CampEntry | null>(null);

  const directory = useMemo(() => campDirectory(), []);
  const matches = useMemo(() => {
    const q = campQuery.trim().toLocaleLowerCase();
    const pool = q
      ? directory.filter(c => c.camp.toLocaleLowerCase().includes(q))
      : directory;
    return pool.slice(0, MAX_ROWS);
  }, [directory, campQuery]);

  const finish = useCallback(
    (choices: OnboardingChoices) => {
      saveOnboardingChoices(choices);
      markOnboardingDone();
      onDone();
    },
    [onDone],
  );

  // Progress, spoken (a11y review 2026-08-24): the dots carry "Step N of
  // M" as their label, and each page CHANGE is announced — the mount stays
  // quiet so the welcome copy reads first.
  const stepIndex = STEPS.indexOf(step);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    announce(`Step ${stepIndex + 1} of ${STEPS.length}`);
  }, [stepIndex]);

  const dots = (
    <View
      style={styles.dotRow}
      accessibilityLabel={`Step ${stepIndex + 1} of ${STEPS.length}`}>
      {STEPS.map(s => (
        <View key={s} style={[styles.dot, step === s && styles.dotActive]} />
      ))}
    </View>
  );

  if (step === 'welcome') {
    return (
      <View style={styles.container}>
        <View style={styles.body}>
          <Text style={styles.title}>Welcome to Playa Pal</Text>
          <Text style={styles.lead}>
            Your offline guide to Black Rock City — what's on right now,
            survival answers, and the way back to camp, all with zero signal.
          </Text>
          <Text style={styles.lead}>
            No account, no sign-in. Nothing you type leaves this phone.
          </Text>
          <Text style={styles.hint}>Two quick questions, both optional.</Text>
        </View>
        {dots}
        <Pressable
          style={styles.primary}
          onPress={() => setStep('name')}
          accessibilityRole="button"
          accessibilityLabel="Next">
          <Text style={styles.primaryText}>Next</Text>
        </Pressable>
        <Pressable
          style={styles.skip}
          onPress={() => finish({})}
          accessibilityRole="button"
          accessibilityLabel="Skip setup">
          <Text style={styles.skipText}>Skip setup</Text>
        </Pressable>
      </View>
    );
  }

  if (step === 'name') {
    return (
      <View style={styles.container}>
        <View style={styles.body}>
          <Text style={styles.title}>What do your campmates call you?</Text>
          <Text style={styles.lead}>
            It's just for the greeting — playa name, default-world name,
            whatever fits.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Your name"
            placeholderTextColor={colors.faded}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            returnKeyType="next"
            onSubmitEditing={() => setStep('camp')}
          />
        </View>
        {dots}
        <Pressable
          style={styles.primary}
          onPress={() => setStep('camp')}
          accessibilityRole="button"
          accessibilityLabel="Next">
          <Text style={styles.primaryText}>Next</Text>
        </Pressable>
        <Pressable
          style={styles.skip}
          accessibilityRole="button"
          accessibilityLabel="Skip this step"
          onPress={() => {
            // Skip means "don't keep this" — a half-typed name included.
            setName('');
            setStep('camp');
          }}>
          <Text style={styles.skipText}>Skip</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.body}>
        <Text style={styles.title}>Where are you camped?</Text>
        <Text style={styles.lead}>
          Pick your camp and “Take me home” knows where home is from night
          one.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="Search camps, or type your own"
          placeholderTextColor={colors.faded}
          value={campQuery}
          onChangeText={t => {
            setCampQuery(t);
            setPicked(null);
          }}
          autoCapitalize="words"
          returnKeyType="done"
        />
        <ScrollView
          style={styles.campList}
          keyboardShouldPersistTaps="handled">
          {matches.map(entry => {
            const selected = picked?.camp === entry.camp;
            return (
              // One camp at a time — a radio, with the selection said out
              // loud (a11y review 2026-08-24: the sage flip was the only
              // signal).
              <Pressable
                key={entry.camp}
                accessibilityRole="radio"
                accessibilityLabel={
                  entry.location
                    ? `${entry.camp}, ${entry.location}`
                    : entry.camp
                }
                accessibilityState={{ selected }}
                style={[styles.campRow, selected && styles.campRowActive]}
                onPress={() => {
                  setPicked(entry);
                  setCampQuery(entry.camp);
                }}>
                <Text
                  style={[
                    styles.campRowText,
                    selected && styles.campRowTextActive,
                  ]}>
                  {entry.location
                    ? `${entry.camp} · ${entry.location}`
                    : entry.camp}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Text style={styles.hint}>
          Not on the list? Whatever you type is your camp.
        </Text>
      </View>
      {dots}
      <Pressable
        style={styles.primary}
        accessibilityRole="button"
        accessibilityLabel="Let's go"
        onPress={() =>
          finish({
            name,
            camp: picked ? picked.camp : campQuery,
            ...(picked ? { location: picked.location } : {}),
          })
        }>
        <Text style={styles.primaryText}>Let's go</Text>
      </Pressable>
      <Pressable
        style={styles.skip}
        onPress={() => finish({ name })}
        accessibilityRole="button"
        accessibilityLabel="Skip this step">
        <Text style={styles.skipText}>Skip</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.dust,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl * 2,
    paddingBottom: spacing.xl,
  },
  body: { flex: 1 },
  title: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    marginBottom: spacing.md,
  },
  lead: {
    color: colors.night,
    fontSize: type.body,
    lineHeight: 24,
    marginBottom: spacing.md,
  },
  hint: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.night,
    fontSize: type.body,
    marginTop: spacing.md,
  },
  campList: { flexGrow: 0, marginTop: spacing.sm, maxHeight: 320 },
  campRow: {
    ...tap, // 44pt row floor (a11y review 2026-08-24)
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  campRowActive: { backgroundColor: colors.sage, borderColor: colors.sage },
  campRowText: { color: colors.night, fontSize: type.small },
  // onAccent: scheme-aware ink on the sage fill (a11y review 2026-08-24).
  campRowTextActive: { color: colors.onAccent, fontWeight: '700' },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
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
  primary: {
    ...tap, // 44pt floor (a11y review 2026-08-24)
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  primaryText: { color: colors.onAccent, fontSize: type.body, fontWeight: '800' },
  skip: {
    ...tap,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  skipText: { color: colors.faded, fontSize: type.small, fontWeight: '600' },
});
