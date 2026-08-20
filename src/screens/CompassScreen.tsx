/**
 * Waypoint Compass — the whiteout screen. One giant arrow to the selected
 * target, distance in huge text, the clock phrase under it. Owner's bar:
 * "operable in a whiteout OR while delirious — one giant button, huge text,
 * zero cognitive load"; Tuftian — the arrow, distance, and name ARE the
 * interface, no chrome.
 *
 * Targets: saved pins first (Home — the pin named "Home" — most prominent),
 * then the nearest toilet bank, then whatever the caller handed in (a tapped
 * event address). "Nearest potty" deliberately RETARGETS as you move.
 *
 * SAFETY FLOOR: pin -> arrow works with ZERO city geometry (pure GPS vector
 * between fixes, src/geo/brcGeo.ts). No magnetometer -> the arrow yields to
 * a huge clock-phrase/cardinal line. No geometry -> cardinal + feet. Each
 * layer degrades alone; none takes the others down.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CityMap } from './CityMap';
import { getDb } from '../events/db';
import { listFriends, subscribeFriendsChanged } from '../friends/friendCard';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  arrowRotation,
  cardinal8,
  formatDistanceFt,
  latLonToBrc,
  nearestToilets,
  toWaypoint,
  type WaypointTarget,
} from '../geo/brcGeo';
import { getCityGeometry } from '../geo/cityGeometry';
import { useLocation } from '../geo/useLocation';
import { useHeading } from '../geo/useHeading';
import { HOME_LABEL, homePin, listPins, removePin, savePin, type SavedPin } from '../geo/waypoints';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  /** Caller-supplied target (a tapped event location); null = open on pins. */
  initialTarget: WaypointTarget | null;
  onClose: () => void;
}

type Selection = { kind: 'pin'; id: string } | { kind: 'toilet' } | { kind: 'caller' };

export function CompassScreen({ initialTarget, onClose }: Props) {
  // Map mode (2026-08-19): the same geometry, drawn instead of pointed.
  // Map-first (owner report 2026-08-20: the city map was invisible behind
  // an unlabeled emoji — he never saw it). The arrow is the head-down
  // walking view; the map is the product. Without geometry there IS no
  // map: land on the arrow and hide the mode pill entirely, or the pill
  // would name a view that can never render.
  const [showMap, setShowMap] = useState(() => getCityGeometry() !== null);
  const [friends, setFriends] = useState(() => listFriends(getDb()));
  useEffect(
    () => subscribeFriendsChanged(() => setFriends(listFriends(getDb()))),
    [],
  );
  const geo = getCityGeometry(); // null-safe: floor mode without it
  const { position, status } = useLocation();
  const heading = useHeading(geo?.declinationDeg ?? 0);
  const [pins, setPins] = useState<SavedPin[]>(() => listPins());
  const [pinName, setPinName] = useState('');
  const [selection, setSelection] = useState<Selection | null>(() => {
    if (initialTarget) {
      return { kind: 'caller' };
    }
    const home = homePin();
    if (home) {
      return { kind: 'pin', id: home.id };
    }
    const first = listPins()[0];
    return first ? { kind: 'pin', id: first.id } : null;
  });

  // Home first, other pins by recency — the whiteout case is one tap.
  const orderedPins = useMemo(() => {
    const home = homePin(pins);
    return home ? [home, ...pins.filter(p => p.id !== home.id)] : pins;
  }, [pins]);

  const target: WaypointTarget | null = useMemo(() => {
    if (!selection) {
      return null;
    }
    if (selection.kind === 'caller') {
      return initialTarget;
    }
    if (selection.kind === 'toilet') {
      if (!position || !geo) {
        return null;
      }
      const t = nearestToilets(position.lat, position.lon, geo, 1)[0];
      return t ? { label: 'Nearest potty', lat: t.lat, lon: t.lon } : null;
    }
    const pin = pins.find(p => p.id === selection.id);
    return pin ? { label: pin.label, lat: pin.lat, lon: pin.lon } : null;
  }, [selection, initialTarget, position, geo, pins]);

  const reading = position && target ? toWaypoint(position, target, geo) : null;
  const rotation =
    reading && heading !== null ? arrowRotation(reading.bearingDeg, heading) : null;
  const here = position && geo ? latLonToBrc(position.lat, position.lon, geo) : null;

  const directionLine = reading
    ? reading.clockDirection ?? `head ${cardinal8(reading.bearingDeg)}`
    : null;

  const dropPin = () => {
    if (!position) {
      return;
    }
    const pin = savePin(pinName, position.lat, position.lon);
    setPins(listPins());
    setSelection({ kind: 'pin', id: pin.id });
    setPinName('');
  };

  const confirmRemove = (pin: SavedPin) => {
    Alert.alert('Remove pin?', `"${pin.label}" will be forgotten.`, [
      {
        text: 'Remove',
        onPress: () => {
          removePin(pin.id);
          setPins(listPins());
        },
      },
      { text: 'Keep', style: 'cancel' },
    ]);
  };

  const chip = (
    key: string,
    label: string,
    selected: boolean,
    onPress: () => void,
    opts: { prominent?: boolean; onLongPress?: () => void } = {},
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      onLongPress={opts.onLongPress}
      delayLongPress={600}
      style={[
        styles.chip,
        opts.prominent && styles.chipProminent,
        selected && styles.chipActive,
      ]}>
      <Text style={[styles.chipText, selected && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.targetName} numberOfLines={1}>
          {target ? target.label : 'Compass'}
        </Text>
        {geo ? (
          <Pressable
            onPress={() => setShowMap(m => !m)}
            style={styles.viewToggle}
            accessibilityLabel={showMap ? 'Show the arrow' : 'Show the city map'}>
            <Text style={styles.viewToggleText}>
              {showMap ? '🧭 Arrow' : '🗺 Map'}
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close compass">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      {showMap && geo ? (
        <View style={styles.stage}>
          <CityMap
            geo={geo}
            position={position}
            target={target}
            pins={pins}
            friends={friends}
          />
          <Text style={styles.hint}>
            Friends, pins, toilets, and your blue dot — all offline, from the
            measured city geometry. Tap 🧭 for the arrow.
          </Text>
        </View>
      ) : (
      <View style={styles.stage}>
        {!position ? (
          <>
            <Text style={styles.bigWord}>
              {status === 'denied' ? 'No location' : 'Waiting for GPS…'}
            </Text>
            {status === 'unavailable' ? (
              <Text style={styles.hint}>
                No signal yet — GPS needs open sky. Step outside or toward a window.
              </Text>
            ) : null}
            {status === 'denied' ? (
              <Text style={styles.hint}>
                Location permission is off. Enable it in system settings — everything stays
                on this phone.
              </Text>
            ) : null}
          </>
        ) : !target ? (
          <Text style={styles.hint}>
            No pins yet. Name this spot below and drop a pin — name one “{HOME_LABEL}” and
            the way home is always one tap.
          </Text>
        ) : reading ? (
          <>
            {rotation !== null ? (
              <Text style={[styles.arrow, { transform: [{ rotate: `${rotation}deg` }] }]}>
                ↑
              </Text>
            ) : (
              <Text style={styles.bigWord}>{directionLine}</Text>
            )}
            <Text style={styles.distance}>{formatDistanceFt(reading.distanceFt)}</Text>
            <Text style={styles.walk}>
              ~{reading.walkMin} min walk{rotation !== null && directionLine ? ` · ${directionLine}` : ''}
            </Text>
            {here ? <Text style={styles.you}>You: {here.address}</Text> : null}
          </>
        ) : null}
      </View>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={{ paddingRight: spacing.lg, alignItems: 'center' }}>
        {orderedPins.map(p =>
          chip(
            p.id,
            p.label.toLowerCase() === HOME_LABEL.toLowerCase() ? `🏠 ${p.label}` : `📍 ${p.label}`,
            selection?.kind === 'pin' && selection.id === p.id,
            () => setSelection({ kind: 'pin', id: p.id }),
            {
              prominent: p.label.toLowerCase() === HOME_LABEL.toLowerCase(),
              onLongPress: () => confirmRemove(p),
            },
          ),
        )}
        {geo
          ? chip('toilet', '🚻 Nearest potty', selection?.kind === 'toilet', () =>
              setSelection({ kind: 'toilet' }),
            )
          : null}
        {initialTarget
          ? chip('caller', `🎪 ${initialTarget.label}`, selection?.kind === 'caller', () =>
              setSelection({ kind: 'caller' }),
            )
          : null}
      </ScrollView>

      <View style={styles.dropRow}>
        <TextInput
          style={styles.dropInput}
          placeholder={`Name this spot (“${HOME_LABEL}”, “My bike”…)`}
          placeholderTextColor={colors.faded}
          value={pinName}
          onChangeText={setPinName}
          returnKeyType="done"
          onSubmitEditing={dropPin}
        />
        <Pressable
          onPress={dropPin}
          disabled={!position}
          style={[styles.dropBtn, !position && styles.dropBtnDisabled]}>
          <Text style={styles.dropBtnText}>Drop pin</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.dust, paddingHorizontal: spacing.lg },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  targetName: { flex: 1, color: colors.night, fontSize: 34, fontWeight: '800' },
  closeBtn: { padding: spacing.lg, marginRight: -spacing.md },
  viewToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.haze,
  },
  viewToggleText: {
    color: colors.night,
    fontSize: 14,
    fontWeight: '600',
  }, // huge hit area
  closeText: { color: colors.night, fontSize: 34, fontWeight: '800' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  arrow: {
    color: colors.clay,
    fontSize: 170,
    lineHeight: 190,
    fontWeight: '800',
    // Rotation pivots on the glyph center; ↑ is visually centered already.
  },
  distance: { color: colors.night, fontSize: 64, fontWeight: '800', marginTop: spacing.md },
  walk: { color: colors.faded, fontSize: 22, fontWeight: '600', marginTop: spacing.xs },
  you: { color: colors.faded, fontSize: type.body, marginTop: spacing.lg },
  bigWord: { color: colors.night, fontSize: 44, fontWeight: '800', textAlign: 'center' },
  hint: {
    color: colors.faded,
    fontSize: type.body,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
  chipRow: { flexGrow: 0, marginBottom: spacing.sm },
  chip: {
    backgroundColor: colors.sand,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginRight: spacing.sm,
  },
  chipProminent: { borderColor: colors.clay, borderWidth: 2 },
  chipActive: { backgroundColor: colors.clay, borderColor: colors.clay },
  chipText: { color: colors.night, fontSize: 18, fontWeight: '700' },
  chipTextActive: { color: colors.cream },
  dropRow: { flexDirection: 'row', marginBottom: spacing.lg },
  dropInput: {
    flex: 1,
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    color: colors.night,
    fontSize: type.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginRight: spacing.sm,
  },
  dropBtn: {
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  dropBtnDisabled: { backgroundColor: colors.haze },
  dropBtnText: { color: colors.cream, fontSize: 18, fontWeight: '800' },
});
