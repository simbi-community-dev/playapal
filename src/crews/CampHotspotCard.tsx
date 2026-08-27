/**
 * CAMP HOTSPOT — the pod's own shared Wi-Fi, on the pod card beside the
 * walkie, because it is the same question one rung up: how do we reach each
 * other when there is nothing out here to reach each other through.
 *
 * THE SENTENCE THIS CARD EXISTS TO SAY, before any switch: video calls need
 * a shared Wi-Fi, one phone can make one, and no internet is involved. A
 * camper who reads only that line has learned the whole feature.
 *
 * THE VIEW IS PURE and the container is thin, deliberately: the arc that
 * matters — off, starting, on with a scannable code, refused with a reason
 * a human can act on — is a render of a model, so every one of those states
 * is a test rather than a phone in a dust storm.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Text } from '../components/Text';
import {
  HOTSPOT_STOPPED_EVENT,
  type HotspotEvent,
  type HotspotModel,
  type HotspotReason,
  campHotspotPresent,
  describeCampHotspot,
  hotspotOff,
  hotspotQrPayload,
  hotspotReasonCopy,
  reduceHotspot,
  startCampHotspot,
  stopCampHotspot,
} from './campHotspot';
import { colors, radius, spacing, tap, type } from '../theme';

/** The one line that explains the whole feature. Exported so the suite can
 * pin it: this card can lose its switch and still be worth shipping, but a
 * camper who cannot tell WHY a hotspot is on a pod card will never turn it
 * on. */
export const HOTSPOT_WHY =
  'Video calls need a shared Wi-Fi (linked iPhones manage without). One phone can host it — no internet involved.';

export function CampHotspotView({
  model,
  supported,
  unsupportedReason,
  onArm,
  onDisarm,
  onDismiss,
  qrSize = 220,
}: {
  model: HotspotModel;
  /** Whether this phone can host at all. False draws the reason instead of
   * a switch that could never work. */
  supported: boolean;
  unsupportedReason: HotspotReason | null;
  onArm: () => void;
  onDisarm: () => void;
  onDismiss: () => void;
  qrSize?: number;
}) {
  const payload = hotspotQrPayload(model);
  const on = model.phase === 'on' || model.phase === 'starting';

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Camp hotspot</Text>
      <Text style={styles.why}>{HOTSPOT_WHY}</Text>

      {supported ? (
        <View style={styles.switchRow}>
          {/* The Switch names its own setting: a screen reader lands on the
              control, not on the label two lines above it. */}
          <Switch
            value={on}
            onValueChange={v => (v ? onArm() : onDisarm())}
            accessibilityLabel="Host a hotspot for the pod from this phone"
          />
          <Text style={styles.switchLabel}>Host it on this phone</Text>
        </View>
      ) : (
        <Text style={styles.reason}>
          {hotspotReasonCopy(unsupportedReason ?? 'absent')}
        </Text>
      )}

      {model.phase === 'starting' ? (
        <Text style={styles.status} accessibilityLiveRegion="polite">
          Starting the hotspot…
        </Text>
      ) : null}

      {model.phase === 'failed' ? (
        <View>
          <Text style={styles.reason} accessibilityLiveRegion="polite">
            {hotspotReasonCopy(model.reason ?? 'error')}
          </Text>
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            style={styles.quietTap}>
            <Text style={styles.quietVerb}>OK</Text>
          </Pressable>
        </View>
      ) : null}

      {payload !== null && model.creds !== null ? (
        <View>
          <View style={styles.qrBox}>
            {/* The QR stays white in BOTH modes: quiet-zone contrast is a
                scanner-hardware requirement, not a theme choice
                (themeGuard allowlist). */}
            <QRCode value={payload} size={qrSize} backgroundColor="#ffffff" />
          </View>
          <Text style={styles.status}>
            Scan this with any phone&apos;s camera. An iPhone offers to join
            straight from the Camera app — nothing to install.
          </Text>
          {/* Printed as well as drawn: a cracked lens, a dead camera, or a
              phone that will not scan still gets onto the network, and the
              text is selectable so it can be copied rather than squinted
              at. */}
          <Text style={styles.credLabel}>Network</Text>
          <Text style={styles.cred} selectable>
            {model.creds.ssid}
          </Text>
          {model.creds.passphrase.length > 0 ? (
            <>
              <Text style={styles.credLabel}>Password</Text>
              <Text style={styles.cred} selectable>
                {model.creds.passphrase}
              </Text>
            </>
          ) : null}
          <Text style={styles.note}>
            On Android, scan the same code from Settings → Wi-Fi, or type the
            name and password in.
          </Text>
          {/* Two truths a camper pays for if nobody says them, both
              measured elsewhere and neither one a surprise worth saving
              for later. */}
          <Text style={styles.note}>
            Hosting eats battery, so turn it off when the call ends. Some
            phones can&apos;t run the walkie&apos;s own Wi-Fi link while
            hosting — if the walkie goes quiet, that is why.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The 'start-hotspot' effect: the runtime permission ask, then the radio.
 *
 * The grant is asked HERE, at the switch, and not at pod-join time: a
 * permission dialog that appears because someone opened a screen is a prompt
 * with no payoff on screen to justify it. A refusal comes back as the same
 * kind of answer every other refusal does.
 *
 * TWO PERMISSIONS BELOW ANDROID 13, ASKED IN ONE BREATH. Android 12 (API 31
 * and 32) put ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION into a single
 * dialog with a precise/approximate choice, and it IGNORES a request that
 * names FINE alone — no dialog appears at all and the callback returns
 * denied immediately. Asking for one was therefore a clean install on an
 * Android 12 phone that could never host: 'no-permission' on screen, over a
 * grant the camper was never once offered. Both names go into a single
 * requestMultiple, which is the shape the platform requires.
 *
 * AND PRECISE IS THE ONE THAT COUNTS. `startLocalOnlyHotspot` needs FINE
 * below 13, so an "Approximate" tap is a refusal — the same refusal the
 * native half reaches independently, because it checks that same grant.
 * Reading COARSE as success here would put a hopeful card in front of a
 * radio that is about to say no.
 *
 * (requestMultiple takes no rationale — the RN API has no argument for one
 * — so the thing that sentence was for, saying why a Wi-Fi feature is
 * asking about Location at all, is carried by the 'no-permission' copy the
 * refusal lands on, which is the screen a camper who taps "Not now"
 * actually reads.)
 */
async function runStart(sendRef: {
  current: (e: HotspotEvent) => void;
}): Promise<void> {
  if (Platform.OS === 'android') {
    let granted = false;
    try {
      if (Number(Platform.Version) >= 33) {
        const got = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
          {
            title: 'Make a hotspot for the pod',
            message:
              'Playa Pal makes a Wi-Fi network your podmates can join for a video call. It has no internet behind it, and nothing about your position leaves the phone.',
            buttonPositive: 'OK',
            buttonNegative: 'Not now',
          },
        );
        granted = got === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const got = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);
        granted =
          got[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
          PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch {
      granted = false;
    }
    if (!granted) {
      sendRef.current({ type: 'failed', reason: 'no-permission' });
      return;
    }
  }
  const r = await startCampHotspot();
  if (r.ok) {
    sendRef.current({ type: 'started', creds: r.creds });
  } else {
    sendRef.current({
      type: 'failed',
      reason: r.reason,
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
    });
  }
}

/**
 * The container. Owns the permission ask, the native calls and the
 * system-teardown subscription; owns no copy and no decisions.
 */
export default function CampHotspotCard() {
  const [model, setModel] = useState<HotspotModel>(hotspotOff);
  const [supported, setSupported] = useState(false);
  const [unsupportedReason, setUnsupportedReason] = useState<HotspotReason | null>(
    () => (campHotspotPresent() ? null : Platform.OS === 'ios' ? 'ios' : 'absent'),
  );

  // The model is read INSIDE send, not closed over, so the reducer's
  // one-request-per-app guard is the thing that actually decides — a
  // container that ran 'start' on every tap would leave that guard
  // decorative, which is the same as not having it.
  const modelRef = useRef<HotspotModel>(hotspotOff);
  const sendRef = useRef<(e: HotspotEvent) => void>(() => {});

  const send = useCallback((e: HotspotEvent) => {
    const step = reduceHotspot(modelRef.current, e);
    modelRef.current = step.model;
    setModel(step.model);
    for (const effect of step.effects) {
      if (effect === 'stop-hotspot') {
        stopCampHotspot();
      } else {
        runStart(sendRef);
      }
    }
  }, []);
  sendRef.current = send;

  // A build with no native half (an iPhone, a test renderer) knows the
  // answer WITHOUT asking, and asking anyway would land a state update a
  // tick after every render of the pod card — noise in other lanes' suites
  // for a question already settled.
  useEffect(() => {
    if (!campHotspotPresent()) {
      return;
    }
    let alive = true;
    describeCampHotspot().then(r => {
      if (alive) {
        setSupported(r.supported);
        setUnsupportedReason(r.supported ? null : r.reason);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // The system can take the hotspot away (real tethering starts, the Wi-Fi
  // stack resets). The card has to hear that, or it keeps showing a QR for
  // a network that is gone.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(HOTSPOT_STOPPED_EVENT, () => {
      sendRef.current({ type: 'stopped-outside' });
    });
    return () => sub.remove();
  }, []);

  // Leaving the pod card must not leave an access point broadcasting.
  useEffect(
    () => () => {
      stopCampHotspot();
    },
    [],
  );

  const onArm = useCallback(() => send({ type: 'arm' }), [send]);
  const onDisarm = useCallback(() => send({ type: 'disarm' }), [send]);
  const onDismiss = useCallback(() => send({ type: 'dismiss' }), [send]);

  return (
    <CampHotspotView
      model={model}
      supported={supported}
      unsupportedReason={unsupportedReason}
      onArm={onArm}
      onDisarm={onDisarm}
      onDismiss={onDismiss}
    />
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  title: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  why: { color: colors.faded, fontSize: type.small, marginTop: spacing.xs },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
    minHeight: tap.minHeight,
  },
  switchLabel: { color: colors.night, fontSize: type.body, flexShrink: 1 },
  status: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  reason: { color: colors.gold, fontSize: type.small, marginTop: spacing.md },
  // Stays white in BOTH modes — the QR quiet zone is scanner-hardware
  // contrast, not a theme choice (themeGuard allowlist).
  qrBox: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#ffffff',
    borderRadius: radius.card,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  credLabel: {
    color: colors.faded,
    fontSize: type.tiny,
    marginTop: spacing.md,
  },
  // Big, because it gets read aloud across a camp at night.
  cred: { color: colors.night, fontSize: type.title, fontWeight: '700' },
  note: { color: colors.faded, fontSize: type.tiny, marginTop: spacing.md },
  quietTap: { justifyContent: 'center', minHeight: tap.minHeight },
  quietVerb: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
});
