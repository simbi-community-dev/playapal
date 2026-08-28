/**
 * CardQr — my friend card as a QR the other phone scans (rung 0,
 * docs/WALKIE-LADDER.md §8).
 *
 * The sibling of PodQr and BeamQr, wearing the same stance: line-of-sight,
 * no radio, no signal, and the trust story a human can check by looking up —
 * you can SEE whose card you are taking. It carries the CUSTOM SCHEME link
 * (see cardShare.ts for why: it opens the app offline whatever the app-link
 * verification state is, which is the difference between working and not
 * working on a dev build).
 *
 * A card with no name cannot be sent at all — `exportMyCard` refuses it,
 * because a card is how a friend knows WHO landed on their phone — so this
 * says the one true sentence rather than rendering a code that installs a
 * stranger. Every failure reads as "no code", never as a crash inside a
 * render: this mounts in a panel a camper opened with a person waiting.
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';
import QRCode from 'react-native-qrcode-svg';
import type { DbConnection } from '../events/engine';
import { myCardQrLink } from './cardShare';
import { QR_MAX_CHARS } from '../beam/beamLink';
import { colors, spacing, type } from '../theme';

type Props = {
  conn: DbConnection;
  /** QR size in dp; the friend card's 280 is the shared default. */
  size?: number;
};

export default function CardQr({ conn, size = 280 }: Props) {
  const { link, problem } = useMemo(() => {
    let encoded: string;
    try {
      encoded = myCardQrLink(conn);
    } catch (e: any) {
      return { link: null, problem: e?.message ?? String(e) };
    }
    // One card never approaches the budget (a full one is ~300 chars), so
    // this arm is a guard rather than a case — but a code too dense to read
    // must say so instead of being held up hopefully in the dust.
    return encoded.length <= QR_MAX_CHARS
      ? { link: encoded, problem: null }
      : {
          link: null,
          problem:
            'Your card is too long for one code — shorten your find-me note and try again.',
        };
  }, [conn]);

  if (link === null) {
    return (
      <View style={styles.problemBox}>
        <Text style={styles.hint}>{problem}</Text>
      </View>
    );
  }

  return (
    <View style={styles.qrBox}>
      {/* The QR stays white in BOTH modes: quiet-zone contrast is a
          scanner-hardware requirement, not a theme choice (allowlisted in
          themeGuard). */}
      <QRCode value={link} size={size} backgroundColor="#ffffff" />
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
    textAlign: 'center',
  },
  problemBox: { alignItems: 'center', padding: spacing.md },
});
