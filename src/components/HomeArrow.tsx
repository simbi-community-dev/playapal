/**
 * HomeArrow — the header's map door, upgraded to N2Y's compass-as-home
 * pattern (docs/NTY-PATTERNS.md §3): when the phone knows where Home is
 * and which way it faces, the door itself becomes a live arrow pointing
 * home from EVERY tab. When it can't (no Home pin yet, no fix, no
 * heading), it stays the plain 🗺 Map door — no dead affordance, no
 * second navigation layer (the header-doors law in App.tsx).
 *
 * Composition only: homePin (waypoints), useLocation, useHeading,
 * toWaypoint + arrowRotation (brcGeo) — the exact math CompassScreen
 * trusts, at header size. Tap behavior is unchanged either way: open the
 * compass overlay.
 */

import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Text } from './Text';
import { getCityGeometry } from '../geo/cityGeometry';
import { useLocation } from '../geo/useLocation';
import { useHeading } from '../geo/useHeading';
import { arrowRotation, toWaypoint } from '../geo/brcGeo';
import { homePin } from '../geo/waypoints';
import { colors, spacing, type } from '../theme';

interface Props {
  /** Opens the compass overlay (same handler as the old Map pill). */
  onPress: () => void;
  /** Style for the pill container (the header's headerWingPill). */
  pillStyle?: object;
  /** Style for the pill text (the header's headerWing). */
  textStyle?: object;
}

export function HomeArrow({ onPress, pillStyle, textStyle }: Props) {
  const geo = getCityGeometry();
  const { position } = useLocation();
  const heading = useHeading(geo?.declinationDeg ?? 0);
  // Re-read per render: the pins row is one tiny settings read, and this
  // component re-renders on heading ticks anyway, so a pin dropped in the
  // compass shows up here the moment the header next moves.
  const home = homePin();

  const rotation =
    home && position && heading !== null
      ? arrowRotation(
          toWaypoint(position, { label: home.label, lat: home.lat, lon: home.lon }, geo).bearingDeg,
          heading,
        )
      : null;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={spacing.md}
      accessibilityLabel={rotation !== null ? 'Open the map — arrow points home' : 'Open the map'}
      style={pillStyle}>
      {rotation !== null ? (
        <Text style={textStyle}>
          <Text style={[styles.arrow, { transform: [{ rotate: `${rotation}deg` }] }]}>➤</Text>
          {' Home'}
        </Text>
      ) : (
        <Text style={textStyle}>🗺 Map</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  arrow: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '800',
  },
});
