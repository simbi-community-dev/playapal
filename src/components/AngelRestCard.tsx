/**
 * THE ANGEL'S REST SWITCH — one card, two mount points: the Angel
 * conversation (where a resting Angel has to explain herself, because that
 * is the surface someone opened expecting her) and Settings › Angel & voice
 * (where the choice lives afterwards, and where a big phone can send her to
 * rest if it wants the room back).
 *
 * ONE component on purpose: the copy is the feature here, and two hand-kept
 * copies of it would drift the first time either was edited.
 *
 * The register is the app's (CLAUDE.md § voice): warm, unhurried, no
 * self-pity, and not one word of machinery. A camper does not need to hear
 * "memory pressure" — they need to hear that their phone is on the small
 * side, that the rest of the app is better off, and that she will wake if
 * they ask.
 */

import React from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import type { AngelPosture } from '../llm/angelRest';
import { colors, radius, spacing, tap, type } from '../theme';

interface Props {
  posture: AngelPosture;
  /** True while a wake (load) or rest (unload) is actually happening. */
  busy?: boolean;
  onChange: (awake: boolean) => void;
}

/** Title + body for each of the four honest states. */
function copyFor({ awake, constrained }: AngelPosture): {
  title: string;
  body: string;
} {
  if (constrained) {
    return awake
      ? {
          title: 'The Angel is awake',
          body:
            'You asked for her on this phone, and here she is. She works, ' +
            'she is just slower here — send her back to resting any time and ' +
            'the rest of the app gets the room back.',
        }
      : {
          title: 'The Angel is resting',
          body:
            'This phone is on the small side, so she is resting — everything ' +
            'else runs faster and steadier without her. Right Now, the map, ' +
            'your pods and the camp board never needed her. Wake her anyway?',
        };
  }
  return awake
    ? {
        title: 'The Angel is awake',
        body:
          'She comes up with the app and stays ready. Let her rest if you ' +
          'would rather the phone spent everything it has on the rest.',
      }
    : {
        title: 'The Angel is resting',
        body:
          'She stays out of the way until you ask for her. Everything else ' +
          'works the same either way.',
      };
}

export function AngelRestCard({ posture, busy = false, onChange }: Props) {
  const { title, body } = copyFor(posture);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <View style={styles.body}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.desc}>
            {busy ? (posture.awake ? 'Waking her up…' : 'Letting her rest…') : body}
          </Text>
        </View>
        {/* The Switch names ITS OWN setting: an unlabeled switch reads as a
            bare "switch, off" (the a11y rule the speech toggle follows). */}
        <Switch
          value={posture.awake}
          onValueChange={onChange}
          disabled={busy}
          accessibilityLabel="Wake the Angel"
          accessibilityState={{ checked: posture.awake, disabled: busy }}
          trackColor={{ true: colors.sage, false: colors.haze }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: tap.minHeight,
  },
  body: { flex: 1 },
  title: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  desc: { color: colors.faded, fontSize: type.small, marginTop: 2 },
});
