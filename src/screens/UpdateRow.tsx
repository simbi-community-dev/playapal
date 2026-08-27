/**
 * UpdateRow — "Update to latest", the sideloader's missing update channel,
 * as one Settings row under About.
 *
 * WHY IT SITS UNDER ABOUT. About already answers "which version am I
 * running", and this is the same question with a second half: "…and is
 * there a newer one?". A camper who wants to know what they have and a
 * camper who wants the newest build are the same person two seconds apart.
 *
 * THE CONTAINER OWNS NO WORDS AND NO DECISIONS. Every sentence and every
 * (state, event) transition lives in src/update/appUpdate.ts; this file
 * mounts the machine, runs its effects, and draws a row. That split is the
 * one the hotspot card already keeps, and it is what makes the copy — the
 * actual product here — testable without a renderer.
 *
 * NOTHING TOUCHES THE NETWORK UNTIL A TAP. The one thing this component
 * does on mount is ask the NATIVE half what version is installed and
 * whether it is debug-signed, which costs no signal at all. An
 * offline-first app that phones home when a screen opens has quietly
 * stopped being one.
 *
 * ON IPHONES IT DOES NOT PRETEND. iOS installs only what Apple delivered,
 * so the row becomes a quiet line and its explanation goes behind the
 * circled ? — the Tufte pass's shape, and honest: there is no action to
 * offer, only a fact to have available.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../components/Text';
import { InfoTap } from '../components/InfoTap';
import {
  UPDATE_PROGRESS_EVENT,
  checkLatestRelease,
  describeInstalledApp,
  downloadAndInstall,
  reduceUpdate,
  updateActionLabel,
  updateIdle,
  updateReasonCopy,
  updateStatusLine,
  type InstalledApp,
  type UpdateEvent,
  type UpdateModel,
} from '../update/appUpdate';
import { colors, spacing, tap, type } from '../theme';

export function UpdateRow({
  version,
}: {
  /** The version baked into the JS bundle, used until (or unless) the
   * native half reports the installed versionName. They agree on every
   * normal build; they disagree exactly when Metro is serving a newer
   * bundle onto an older APK, and the APK's answer is the true one. */
  version: string;
}): React.JSX.Element {
  const android = Platform.OS === 'android';
  const [installed, setInstalled] = useState<InstalledApp | null>(null);
  const [model, setModel] = useState<UpdateModel>(updateIdle);

  // The model is read INSIDE send rather than closed over, so the
  // reducer's never-two-requests guard is the thing that actually decides
  // — a container that ran the effect on every tap would leave that guard
  // decorative, which is the same as not having it (CampHotspotCard's
  // lesson, and the same shape).
  const modelRef = useRef<UpdateModel>(updateIdle);
  const sendRef = useRef<(e: UpdateEvent) => void>(() => {});
  // Read when the answer LANDS, not when the tap happened: `describe()`
  // may still have been in flight at the tap, and the version the
  // comparison uses has to be the truest one available by then.
  const versionRef = useRef<string>(version);

  const send = useCallback((e: UpdateEvent) => {
    const step = reduceUpdate(modelRef.current, e);
    modelRef.current = step.model;
    setModel(step.model);
    for (const effect of step.effects) {
      if (effect === 'check-github') {
        runCheck(sendRef, versionRef);
      } else {
        runDownload(sendRef);
      }
    }
  }, []);
  sendRef.current = send;

  useEffect(() => {
    if (!android) {
      return;
    }
    let alive = true;
    describeInstalledApp().then(d => {
      if (alive) {
        setInstalled(d);
        if (d.versionName.length > 0) {
          versionRef.current = d.versionName;
        }
      }
    });
    // The transfer is long enough that the camper will leave the screen;
    // the native half keeps emitting, and the reducer drops anything that
    // arrives outside 'downloading'.
    const sub = DeviceEventEmitter.addListener(
      UPDATE_PROGRESS_EVENT,
      (e: { percent?: number }) => {
        if (typeof e?.percent === 'number') {
          sendRef.current({ type: 'progress', percent: e.percent });
        }
      },
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, [android]);

  if (!android) {
    return (
      <View style={styles.infoRow}>
        <Text style={styles.rowDesc}>Updates arrive through TestFlight.</Text>
        <InfoTap topic="updating on iPhone" text={updateReasonCopy('ios')} />
      </View>
    );
  }

  const shown = installed?.versionName || version;
  // The debug-key wall: a released APK cannot install over a build signed
  // with a developer key, so the row reports the newer version and refuses
  // the download rather than spending 130 MB of borrowed signal on an
  // install Android was always going to bounce.
  const blocked =
    model.phase === 'available' && installed?.developerBuild === true;
  const busy = model.phase === 'checking' || model.phase === 'downloading';
  const label = updateActionLabel(model, blocked);

  return (
    <Pressable
      style={styles.row}
      disabled={busy || blocked}
      onPress={() =>
        send({ type: model.phase === 'available' ? 'download' : 'check' })
      }
      accessibilityRole="button"
      accessibilityState={{ disabled: busy || blocked, busy }}
      accessibilityLabel={label}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{label}</Text>
        <Text style={styles.rowDesc}>
          {updateStatusLine(model, shown, blocked)}
        </Text>
      </View>
      <Text style={styles.rowChevron}>{busy ? '' : '›'}</Text>
    </Pressable>
  );
}

/**
 * The lookup, as an effect. It resolves into `send` rather than into a
 * setState, so a late answer meets the same table every other event does
 * and a row the camper already dismissed cannot be repainted by it.
 */
function runCheck(
  sendRef: React.RefObject<(e: UpdateEvent) => void>,
  versionRef: React.RefObject<string>,
): void {
  checkLatestRelease().then(r => {
    sendRef.current(
      r.ok
        ? { type: 'checked', latest: r.latest, installed: versionRef.current }
        : { type: 'failed', reason: r.reason, detail: r.detail },
    );
  });
}

/** The download and the hand-off to Android's installer, as one effect —
 * the native half does not report them separately, because a download that
 * finished and an installer that never opened is not a state a camper can
 * act on differently. */
function runDownload(sendRef: React.RefObject<(e: UpdateEvent) => void>): void {
  downloadAndInstall().then(r => {
    sendRef.current(
      r.ok
        ? { type: 'handed-off' }
        : { type: 'failed', reason: r.reason, detail: r.detail },
    );
  });
}

const styles = StyleSheet.create({
  // The Settings row shape, verbatim, so this looks native where it mounts
  // (ShareAppRow keeps the same copy of it, for the same reason).
  row: { alignItems: 'center', flexDirection: 'row', minHeight: tap.minHeight },
  rowBody: { flex: 1, marginRight: spacing.md },
  rowTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  rowDesc: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  rowChevron: { color: colors.faded, fontSize: type.title, fontWeight: '300' },
  infoRow: { alignItems: 'center', flexDirection: 'row' },
});
