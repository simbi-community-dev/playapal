/**
 * PodQr — the QR view for a pod invite (docs/WALKIE-LADDER.md §8, rung 0).
 *
 * The sibling of BeamQr and of the friend card's QR, wearing the same stance:
 * the system camera scans it — no pairing, no account — and the payload rides
 * the fragment so no server ever sees a pod code. (Since 2026-08-25 the app
 * can also read a code itself, src/links/scanCode.ts; that is a second READER,
 * and changes nothing about what this component draws.) Rung 0 is the only
 * rung with NO RADIO — it works with Bluetooth off,
 * Wi-Fi off, and no signal, and because it is line-of-sight it is the only
 * rung whose trust story a human can check by looking up.
 *
 * Wiring this into CrewSection is the pod-identity lane's call (that file is
 * owned elsewhere right now); this component is the leaf they mount, exactly
 * as BeamQr was the leaf CampScreen mounted.
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import QRCode from 'react-native-qrcode-svg';
import { encodePodSchemeLink, fitPodInvite, type PodInvite } from './podLink';
import { colors, spacing, type } from '../theme';

type Props = {
  /** The invite to hand over — code, and whatever else the inviter can give
   * away early (pod name, their own card, their radios). */
  invite: PodInvite;
  /** QR size in dp; defaults to the friend card's 280. */
  size?: number;
};

export default function PodQr({ invite, size = 280 }: Props) {
  const { link, droppedCard } = useMemo(() => {
    try {
      const fitted = fitPodInvite(invite);
      return {
        link: encodePodSchemeLink(fitted.invite),
        droppedCard: fitted.droppedCard,
      };
    } catch {
      // An invite that cannot encode reads as no invite, never as a crash
      // inside a render.
      return { link: null, droppedCard: false };
    }
  }, [invite]);

  if (link === null) {
    return (
      <View style={styles.overflowBox}>
        <Text style={styles.hint}>
          This pod code can&apos;t be turned into a QR — read them the code
          instead.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.qrBox}>
      {/* The QR stays white in BOTH modes: quiet-zone contrast is a
          scanner-hardware requirement, not a theme choice (allowlisted in
          themeGuard). */}
      <QRCode value={link} size={size} backgroundColor="#ffffff" />
      <Text style={styles.hint}>
        They scan this with their normal camera — Playa Pal opens and they are
        in the pod. No signal needed.
      </Text>
      {droppedCard ? (
        <Text style={styles.hint}>
          Your own card didn&apos;t fit alongside the invite — they&apos;ll get
          it over the air once you&apos;re both nearby.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Stays white in BOTH modes — the QR quiet zone is scanner-hardware
  // contrast, not a theme choice (themeGuard allowlist).
  qrBox: { backgroundColor: '#ffffff', borderRadius: 8, padding: 12 },
  hint: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  overflowBox: { alignItems: 'center', padding: spacing.md },
});
