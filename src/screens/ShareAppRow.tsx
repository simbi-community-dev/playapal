/**
 * ShareAppRow — Playa Pal handing ITSELF to a phone that has none
 * (docs/FINAL-WEEK.md "Lane D"), as ONE component with two mount points.
 *
 * WHY IT IS ITS OWN FILE (sharing audit, docs/SHARING-SURFACES.md §1.7/§3.2).
 * This is the only affordance in the whole app that reaches a person who does
 * not already have Playa Pal — every QR, every beam, every card presupposes
 * the app on both ends. It lived three levels deep in Settings (tab → the
 * collapsed "Help & about" group → "Share the app"), which is fine for the
 * "where do I get this app" instinct and wrong for the "somebody is standing
 * in front of me with nothing" one. Both instincts are real, so the row now
 * mounts in BOTH places:
 *
 *   - Camp tab → "Share & receive"  (someone is here, hand it over)
 *   - Settings → Help & about       (the where-do-I-get-this instinct)
 *
 * TWO MOUNTS, ONE IMPLEMENTATION — not a duplicated affordance. The state
 * below is per-mount (each does its own describe(), a stat() with no copy),
 * but the native call, the progress wiring and every word of the copy exist
 * exactly once. __tests__/shareApp.test.ts asserts that: the row's strings
 * may appear in exactly one source file, this one.
 *
 * THE COPY IS A LENGTH INVARIANT. Every sentence in shareAppDesc was bought
 * with a real field incident on real phones (see the test's note). This row
 * is the ONLY surface that reaches the installing person AT install time —
 * the share sheet cannot carry text and the receiver has no signal to read
 * playapal.lol. It cannot be shortened by moving half of it to the website,
 * only by dropping something a camper needs while standing in dust.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  DeviceEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../components/Text';
import { colors, spacing, tap, type } from '../theme';

/**
 * Lane D — the app-bootstrap hole. A campmate with no app cannot receive a
 * beam, and on playa they cannot download one. Android can hand over its own
 * installed APK with no internet at all; iOS cannot sideload, so that half is
 * the TestFlight public link and the one moment of signal it needs.
 *
 * An EMPTY link is an honest state, not a bug: the row says the build is not
 * published yet rather than opening a dead URL. Pending from the coordinator
 * (asked in #playapal, 2026-08-21).
 */
const TESTFLIGHT_PUBLIC_LINK = '';
const SHARE_APP_PROGRESS_EVENT = 'PlayaPalShareAppProgress';

type AppShareInfo = {
  versionName: string;
  bytes: number;
  shareable: boolean;
  splitInstall: boolean;
};

export function ShareAppRow(): React.JSX.Element {
  // `describe` costs a stat() and no copy, so the row can name the real size
  // before the tap; the progress event carries the whole-APK copy (132.5 MB
  // release, 292.5 debug), which is far too long to leave a row looking dead.
  const [appShare, setAppShare] = useState<AppShareInfo | null>(null);
  const [preparingPct, setPreparingPct] = useState<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android' || !NativeModules.ShareApp) {
      return;
    }
    let alive = true;
    NativeModules.ShareApp.describe()
      .then((d: AppShareInfo) => {
        if (alive) {
          setAppShare(d);
        }
      })
      .catch(() => {
        // A phone that cannot read its own APK still gets the row; the tap
        // is where it says so, with the native error.
      });
    const sub = DeviceEventEmitter.addListener(
      SHARE_APP_PROGRESS_EVENT,
      (e: { percent?: number }) => {
        setPreparingPct(typeof e?.percent === 'number' ? e.percent : null);
      },
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const shareApp = useCallback(async () => {
    if (Platform.OS === 'android') {
      const mod = NativeModules.ShareApp;
      if (!mod) {
        Alert.alert(
          'Not available in this build',
          'This copy of Playa Pal cannot pass itself on. Update from a phone that can.',
        );
        return;
      }
      setPreparingPct(0);
      try {
        await mod.shareApp();
      } catch (e: any) {
        Alert.alert('Could not prepare the app', e?.message ?? String(e));
      } finally {
        setPreparingPct(null);
      }
      return;
    }
    if (!TESTFLIGHT_PUBLIC_LINK) {
      Alert.alert(
        'No install link yet',
        'The public TestFlight link is not published yet. An Android phone nearby can pass Playa Pal along with no internet at all.',
      );
      return;
    }
    try {
      await Share.share({
        title: 'Playa Pal',
        message: `Playa Pal — the offline playa companion. Install it here: ${TESTFLIGHT_PUBLIC_LINK}`,
      });
    } catch {
      // Share sheet dismissed or unavailable — nothing to clean up.
    }
  }, []);

  const appShareMb =
    appShare && appShare.bytes > 0
      ? ` (${Math.round(appShare.bytes / 1048576)} MB)`
      : '';
  const shareAppDesc =
    Platform.OS === 'android'
      ? appShare && !appShare.shareable
        ? 'This copy was installed in per-device pieces, so it cannot be passed on whole. A phone that installed the APK directly can share it.'
        : `Hands the whole app${appShareMb} to a phone that has none — Quick Share, Bluetooth or a cable, no internet needed.\n\nOn their phone, open it from Files → Downloads, not the transfer popup’s own Open button, which can launch the wrong app.\n\nThen turn on “Allow from this source” when Android asks, and when Play Protect says the developer is unknown, tap “More details” and the small “Install anyway” — the big button cancels.\n\nOne rule of the road: a phone that installed Playa Pal from the Play Store updates from the Play Store — beams install only onto phones that have no app yet, or got it by beam.`
      : TESTFLIGHT_PUBLIC_LINK
      ? 'Sends the TestFlight invite. iPhones can only install from Apple, so they need signal once — an Android phone nearby can pass the app along with none.'
      : 'The public TestFlight link is not published yet.';

  return (
    <Pressable
      style={styles.row}
      onPress={shareApp}
      disabled={preparingPct !== null}
      accessibilityRole="button"
      accessibilityState={{ disabled: preparingPct !== null }}
      accessibilityLabel="Share Playa Pal">
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>
          {preparingPct === null
            ? 'Share Playa Pal'
            : `Preparing… ${preparingPct}%`}
        </Text>
        <Text style={styles.rowDesc}>{shareAppDesc}</Text>
      </View>
      <Text style={styles.rowChevron}>›</Text>
    </Pressable>
  );
}

// The Settings row shape, verbatim, so the component looks native in both of
// its homes (Camp's cards use the same sand ground and the same chevron).
const styles = StyleSheet.create({
  // minHeight: the 44pt row floor (a11y review 2026-08-24).
  row: { alignItems: 'center', flexDirection: 'row', minHeight: tap.minHeight },
  rowBody: { flex: 1, marginRight: spacing.md },
  rowTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  rowDesc: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  rowChevron: { color: colors.faded, fontSize: type.title, fontWeight: '300' },
});
