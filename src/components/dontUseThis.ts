/**
 * "DON'T USE THIS" -- the one confirmation every hideable thing shares.
 *
 * Streamlined means the SAME gesture and the SAME words on a person card, an
 * event card, and a source passage. The user learns it once. Each surface
 * only supplies what it is (kind, key, label) and where the answer should
 * refresh; this file owns the wording and the undo pointer, so they cannot
 * drift apart across three components.
 *
 * WHY LONG-PRESS. SourceChips forbids gestures on the READING path so a dusty
 * gloved thumb reaches the source with a plain tap. Hiding is the opposite
 * kind of act -- rare, deliberate, dangerous to trigger by brushing a card in
 * a scroll -- and a 600 ms hold cannot fire by accident and never blocks
 * tap-to-read. Same rule, opposite conclusion, because the acts differ.
 *
 * NOTHING IS DELETED and the dialog says where the undo lives, so the user
 * is never one wrong tap from losing something.
 */
import { Alert } from 'react-native';
import type { HiddenKind } from '../events/db';

export interface HideTarget {
  kind: HiddenKind;
  key: string;
  /** Human words -- a name, a title, a heading. Shown in the dialog and the
   * Settings list. Never an id. */
  label: string;
  /** True when this remembers someone who died. The gesture is the same;
   * the WORDS take the gentle register (hippo-spirit): no "hide", no
   * "remove" -- "set aside", and the undo named plainly. */
  memorial?: boolean;
}

export type OnHide = (target: HideTarget) => void;

/** The delay every hideable surface uses, so the gesture feels identical. */
export const HOLD_MS = 600;

const NOUN: Record<HiddenKind, string> = {
  person: 'them',
  event: 'this event',
  passage: 'this passage',
  camp_note: 'this camp note',
};

export function confirmDontUse(target: HideTarget, onHide: OnHide): void {
  if (target.memorial) {
    Alert.alert(
      'Set this aside?',
      `${target.label} will stop appearing in answers on this phone. ` +
        'Nothing is deleted and nothing is forgotten -- the pack keeps it, ' +
        'and you can bring it back any time from Settings > Hidden.',
      [
        { text: 'Keep', style: 'cancel' },
        { text: 'Set aside', style: 'destructive', onPress: () => onHide(target) },
      ],
    );
    return;
  }
  Alert.alert(
    `Don't use this?`,
    `${target.label} will stop appearing in answers on this phone. ` +
      `Nothing is deleted -- you can bring ${NOUN[target.kind]} back any ` +
      `time from Settings > Hidden.`,
    [
      { text: 'Keep', style: 'cancel' },
      { text: "Don't use", style: 'destructive', onPress: () => onHide(target) },
    ],
  );
}
