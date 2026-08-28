/**
 * THE DIRECT-LINK ROW — rung 4's door, where the thing it unblocks lives
 * (docs/WALKIE-LADDER.md §9a).
 *
 * WHY IT SITS IN THE WALKIE AND NOT IN SETTINGS. Pairing two iPhones does
 * exactly one observable thing: it lets the WALKIE reach further with no
 * Wi-Fi. A camper looking at "Nobody else on the channel yet" is the person
 * this row is for, and they are looking at the walkie stage, not at
 * Settings. Settings is where a diagnostic goes (the mic check lives there
 * for exactly that reason); this is a capability, and a capability belongs
 * beside the feature it grows.
 *
 * THREE GATES, ALL OF THEM QUIET. Android renders nothing (the module is
 * iOS-only). A build without the native pair renders nothing. And an iPhone
 * whose probe does not say a plain `ok` renders nothing — a phone below iOS
 * 26, or without the radio, has a PERMANENT no, and a row that opens onto
 * "your phone cannot" is a row that should not have been drawn. The probe
 * is the one already shipped (`describeWifiAware`), not a second opinion.
 *
 * THE COPY SAYS "FIELD-TESTED" ON PURPOSE. Nothing in this lane has been
 * proven between two iPhones yet. The row is allowed to offer; it is not
 * allowed to promise, and it is never allowed to imply Android.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import { InfoTap } from '../components/InfoTap';
import { useHangPulse } from './hangPulse';
import { describeWifiAware } from './wifiAware';
import {
  AWARE_PAIR_INFO,
  AWARE_PAIR_LINE,
  AWARE_PAIR_TITLE,
  awarePairFailureCopy,
  awarePairingPresent,
  presentAwarePairing,
} from './awarePairing';
import { colors, spacing, tap, type } from '../theme';

/**
 * How long the hang-diagnosis pulse runs after the pairing sheet is opened
 * (the second of the two windows a hard freeze has been seen in — see
 * src/crews/hangPulse.ts).
 *
 * A WINDOW, not a matching close, because Apple's sheet never tells us it
 * was dismissed: present() resolves when the sheet goes UP, and there is no
 * second callback. A minute covers a real pairing ceremony with room to
 * spare, and the diagnosis it feeds is read off the first few seconds
 * anyway — the interesting line is the one that STOPS arriving.
 */
const PAIR_PULSE_WINDOW_MS = 60_000;

export function AwarePairRow() {
  // The probe is a device fact that cannot change while the app runs
  // (wifiAware.ts says so and caches on that basis), so it is asked once
  // per mount and never re-polled. `null` is "not answered yet" and renders
  // nothing — a row that appears a beat late is better than one that
  // appears and then vanishes under a thumb.
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!awarePairingPresent()) {
      setOk(false);
      return;
    }
    let alive = true;
    void describeWifiAware().then(r => {
      if (alive) {
        // Exactly one reason draws the row. 'unsupported', 'os-too-old' and
        // 'no-framework' are all a permanent or build-level no, and each of
        // them would make this row a dead end.
        setOk(r.reason === 'ok');
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // The pairing window: true from the tap until PAIR_PULSE_WINDOW_MS later,
  // or immediately false if the sheet never came up.
  const [pairing, setPairing] = useState(false);
  useHangPulse(pairing);
  useEffect(() => {
    if (!pairing) {
      return;
    }
    const id = setTimeout(() => setPairing(false), PAIR_PULSE_WINDOW_MS);
    return () => clearTimeout(id);
  }, [pairing]);

  const open = useCallback(() => {
    setPairing(true);
    void presentAwarePairing().then(r => {
      if (!r.presented) {
        setPairing(false);
        // The gate above should have caught every one of these, so an alert
        // here is genuinely news — and it names the cause rather than
        // saying "error", because most causes are facts a camper can act
        // on or safely ignore.
        Alert.alert(AWARE_PAIR_TITLE, awarePairFailureCopy(r.reason));
      }
    });
  }, []);

  if (ok !== true) {
    return null;
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={AWARE_PAIR_TITLE}
          accessibilityHint="Opens the iPhone pairing screen"
          style={styles.tap}>
          <Text style={styles.title}>📶 {AWARE_PAIR_TITLE}</Text>
        </Pressable>
        <InfoTap topic="linking two iPhones" text={AWARE_PAIR_INFO} />
      </View>
      <Text style={styles.line}>{AWARE_PAIR_LINE}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.md },
  // The ? sits beside the verb, not under the paragraph: the row is the
  // target, the ring is the aside.
  head: { alignItems: 'center', flexDirection: 'row' },
  tap: { flex: 1, justifyContent: 'center', minHeight: tap.minHeight },
  title: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
  line: { color: colors.faded, fontSize: type.tiny, marginTop: spacing.xs },
});
