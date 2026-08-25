/**
 * BeamQr — the QR view for a camp-board beam (contract §5, 2026-08-21).
 *
 * Renders the deep link as a QR the system camera scans (no in-app
 * scanner, no camera permission — the same stance as FriendsSection).
 * Over the one-QR budget it shows ONE honest sentence and offers the file
 * beam via onUseFile — never a chain, never a half-scannable code.
 *
 * Wiring into CampScreen/App.tsx is pug-claude-5's lane (contract §8);
 * this component is the leaf he mounts.
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { encodeBeamSchemeLink, fitsOneQr } from './beamLink';
import { colors, spacing, type } from '../theme';

type Props = {
  /** The camp-bundle JSON to beam (kind playapal-camp-board, unchanged). */
  bundleJson: string;
  /** Called when the board is too big for one QR and the user asks for the
   * file beam instead. Required: the overflow sentence must always offer
   * the way out. */
  onUseFile: () => void;
  /** QR size in dp; defaults to the friend card's 280. */
  size?: number;
};

export default function BeamQr({ bundleJson, onUseFile, size = 280 }: Props) {
  const link = useMemo(() => {
    try {
      // THE SCHEME CARRIER, not https — and this is the offline rule the
      // beam lane's own header states and this line was breaking.
      //
      // An https app-link only opens the app once Android has VERIFIED it
      // against assetlinks.json, which needs network. The camper this QR
      // exists for got Playa Pal by Quick Share in the dust and has had no
      // network since install, so verification never happened — and on
      // targetSdk 31+ an unverified https link goes STRAIGHT to the browser
      // with no chooser. The board is then silently lost to an offline
      // browser tab. `playapal://beam#...` opens the app regardless.
      //
      // It also makes fitsOneQr honest: it measures the scheme link, so
      // rendering the https one (22-char prefix vs 15) could exceed the
      // budget by 7 characters while fitsOneQr said yes.
      return fitsOneQr(bundleJson) ? encodeBeamSchemeLink(bundleJson) : null;
    } catch {
      return null; // a bundle that cannot encode reads as overflow, not a crash
    }
  }, [bundleJson]);

  if (link === null) {
    return (
      <View style={styles.overflowBox}>
        <Text style={styles.hint}>
          This board is too big for one QR code — send it as a file instead.
        </Text>
        <Pressable style={styles.fileBtn} onPress={onUseFile}>
          <Text style={styles.fileBtnText}>Beam as file</Text>
        </Pressable>
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
        They scan this with their normal camera — Playa Pal opens and imports
        the board. No signal needed.
      </Text>
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
  fileBtn: {
    backgroundColor: colors.clay,
    borderRadius: 8,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  fileBtnText: { color: colors.onAccent, fontSize: type.body, fontWeight: '600' },
});
