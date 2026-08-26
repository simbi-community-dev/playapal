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
 * The map also WRITES: "Log art here" opens the camp-notes composer on the
 * selected spot's clock address, which is how a camp builds its own art
 * directory during setup while the official locations are still embargoed.
 *
 * SAFETY FLOOR: pin -> arrow works with ZERO city geometry (pure GPS vector
 * between fixes, src/geo/brcGeo.ts). No magnetometer -> the arrow yields to
 * a huge clock-phrase/cardinal line. No geometry -> cardinal + feet. Each
 * layer degrades alone; none takes the others down.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CityMap } from './CityMap';
import { AddNoteSheet, type AddNotePrefill } from './AddNoteSheet';
import { getDb } from '../events/db';
import { getMyCard, listFriends, subscribeFriendsChanged } from '../friends/friendCard';
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
  addressToLatLon,
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
import { colors, radius, spacing, tap, type } from '../theme';

interface Props {
  /** Caller-supplied target (a tapped event location); null = open on pins. */
  initialTarget: WaypointTarget | null;
  onClose: () => void;
}

type Selection =
  | { kind: 'pin'; id: string }
  | { kind: 'toilet' }
  | { kind: 'caller' }
  | { kind: 'cardHome' }
  | { kind: 'mapPoint' };

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
  // Pin management (owner ask 2026-08-24: "no way to delete pins or keep
  // them organized overall as you have more than a few"). Long-press-to-
  // remove existed but was undiscoverable — an affordance nobody finds is
  // a missing affordance. The ✎ chip swaps the stage for the full pin list
  // (Home first, then newest), each row with its address and a VISIBLE
  // Remove. No new screen: the same stage, the same chips, one more mode.
  const [managePins, setManagePins] = useState(false);
  // A spot tapped ON the map (owner ask 2026-08-20): navigable immediately,
  // pinnable via the same drop row. One at a time — a new tap replaces it.
  const [mapPoint, setMapPoint] = useState<WaypointTarget | null>(null);
  // Home without a dropped pin (owner, 2026-08-20: "the app doesn't seem
  // to have a default understanding of where my home camp is"): the camp
  // address on YOUR card is a real Home until a GPS pin replaces it. An
  // explicit Home pin always wins — standing at your tent beats math.
  const cardHome: WaypointTarget | null = useMemo(() => {
    if (!geo) {
      return null;
    }
    try {
      const addr = getMyCard(getDb()).address;
      if (!addr) {
        return null;
      }
      const at = addressToLatLon(addr, geo);
      return at ? { label: `Home — ${addr}`, lat: at.lat, lon: at.lon } : null;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo]);
  const [selection, setSelection] = useState<Selection | null>(() => {
    if (initialTarget) {
      return { kind: 'caller' };
    }
    const home = homePin();
    if (home) {
      return { kind: 'pin', id: home.id };
    }
    if (geo) {
      try {
        const addr = getMyCard(getDb()).address;
        if (addr && addressToLatLon(addr, geo)) {
          return { kind: 'cardHome' };
        }
      } catch {
        // fall through to pins
      }
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
    if (selection.kind === 'cardHome') {
      return cardHome;
    }
    if (selection.kind === 'mapPoint') {
      return mapPoint;
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
  }, [selection, initialTarget, position, geo, pins, cardHome, mapPoint]);

  // LOG ART WHERE YOU ARE STANDING (owner, 2026-08-20). Burning Man's own
  // art locations are embargoed until Gate opens, and he flies in two days
  // before that — so the camp builds its own directory during setup. The
  // map is where that happens: you have already told the app which spot you
  // mean, and the address of that spot is what the note is missing. Any
  // selected target works — a tapped spot, a dropped pin, the Man — because
  // the address comes from the target's ground position, not from the map
  // gesture that produced it.
  const [artSheetOpen, setArtSheetOpen] = useState(false);
  const artAddress = useMemo(
    () => (geo && target ? latLonToBrc(target.lat, target.lon, geo).address : ''),
    [geo, target],
  );
  const artPrefill = useMemo<AddNotePrefill>(
    () => ({ kind: 'art', where: artAddress }),
    [artAddress],
  );

  const reading = position && target ? toWaypoint(position, target, geo) : null;
  const rotation =
    reading && heading !== null ? arrowRotation(reading.bearingDeg, heading) : null;
  const here = position && geo ? latLonToBrc(position.lat, position.lon, geo) : null;

  const directionLine = reading
    ? reading.clockDirection ?? `head ${cardinal8(reading.bearingDeg)}`
    : null;

  const dropPin = () => {
    // a tapped map spot pins WHERE YOU TAPPED; otherwise where you stand
    const at =
      selection?.kind === 'mapPoint' && mapPoint
        ? { lat: mapPoint.lat, lon: mapPoint.lon }
        : position;
    if (!at) {
      return;
    }
    const pin = savePin(pinName, at.lat, at.lon);
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
    opts: { prominent?: boolean; onLongPress?: () => void; a11yLabel?: string } = {},
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      onLongPress={opts.onLongPress}
      delayLongPress={600}
      accessibilityRole="button"
      accessibilityLabel={opts.a11yLabel}
      accessibilityState={{ selected }}
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
            accessibilityRole="button"
            accessibilityLabel={showMap ? 'Show the arrow' : 'Show the city map'}>
            {/* ONE GLYPH, ONE MEANING (cross-family meld 2026-08-20): the
                compass glyph means "take me to this thing" everywhere else
                in the app -- the Take-me-home button, the event chips, the
                friend chips. Borrowing it here for a VIEW TOGGLE made it
                mean three unrelated things. A view choice is not a
                destination, so it gets words, not a destination glyph. */}
            <Text style={styles.viewToggleText}>
              {showMap ? 'Arrow view' : 'Map view'}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onClose}
          style={styles.closeBtn}
          accessibilityRole="button"
          accessibilityLabel="Close compass">
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      {managePins ? (
        <ScrollView style={styles.pinStage} contentContainerStyle={styles.pinList}>
          <Text style={styles.pinListHint}>
            Home first, then newest. Tap a pin to aim at it; Remove forgets
            it — you can always drop it again.
          </Text>
          {orderedPins.length === 0 ? (
            <Text style={styles.hint}>All pins removed. Drop a new one below.</Text>
          ) : (
            orderedPins.map(p => {
              const isHome = p.label.toLowerCase() === HOME_LABEL.toLowerCase();
              const addr = geo ? latLonToBrc(p.lat, p.lon, geo).address : null;
              return (
                <View key={p.id} style={styles.pinRow}>
                  <Pressable
                    style={styles.pinRowBody}
                    accessibilityRole="button"
                    accessibilityLabel={`Aim at ${p.label}`}
                    onPress={() => {
                      setSelection({ kind: 'pin', id: p.id });
                      setManagePins(false);
                    }}>
                    <Text style={styles.pinRowTitle}>
                      {isHome ? '🏠' : '📍'} {p.label}
                    </Text>
                    <Text style={styles.pinRowDesc}>
                      {addr ?? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => confirmRemove(p)}
                    hitSlop={spacing.sm}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${p.label}`}
                    style={styles.pinRemove}>
                    <Text style={styles.pinRemoveText}>Remove</Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>
      ) : showMap && geo ? (
        <View style={styles.stage}>
          <CityMap
            geo={geo}
            position={position}
            target={target}
            pins={pins}
            friends={friends}
            onMapTap={t => {
              setMapPoint(t);
              setSelection({ kind: 'mapPoint' });
            }}
            onFeatureTap={hit => {
              // Tapping a pin SELECTS it — the same state the chip below
              // sets — instead of dropping a competing map spot on top of
              // it (owner field test 2026-08-20: "confusing double-pin
              // creation"). Friends and landmarks have no chip of their
              // own, so they ride the map-spot slot under their own name.
              if (hit.feature.kind === 'pin') {
                setSelection({ kind: 'pin', id: hit.feature.id });
                return;
              }
              setMapPoint(hit.target);
              setSelection({ kind: 'mapPoint' });
            }}
          />
          <Text style={styles.hint}>
            Tap a pin, friend, or landmark to select it; tap open ground to
            aim there; hold, then drag to place a spot exactly. All offline.
            Switch to "Arrow view" for the walking arrow.
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
                Playa Pal uses your location for one thing: pointing this arrow and
                placing you on the city map, all on this phone. Turn location on in
                Settings › Apps › Playa Pal › Permissions and come right back.
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
        {/* Kept visible while the manager is open even at zero pins, or
            removing the last pin would strand the view with no way out. */}
        {pins.length > 0 || managePins
          ? chip('manage', managePins ? '✕ Done' : '✎', managePins, () => setManagePins(m => !m), {
              a11yLabel: managePins ? 'Close pin management' : 'Manage pins',
            })
          : null}
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
        {mapPoint
          ? chip('mapPoint', `📌 ${mapPoint.label}`, selection?.kind === 'mapPoint', () =>
              setSelection({ kind: 'mapPoint' }),
            {
              prominent: true,
              onLongPress: () => {
                setMapPoint(null);
                setSelection(null);
              },
            })
          : null}
        {cardHome && !homePin(pins)
          ? chip('cardHome', '🏠 Home (camp)', selection?.kind === 'cardHome', () =>
              setSelection({ kind: 'cardHome' }),
            {
              prominent: true,
            })
          : null}
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

      {artAddress ? (
        <Pressable
          style={styles.artBtn}
          onPress={() => setArtSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Log art at ${artAddress}`}>
          <Text style={styles.artBtnText}>🎨 Log art here — {artAddress}</Text>
        </Pressable>
      ) : null}

      <AddNoteSheet
        visible={artSheetOpen}
        onClose={() => setArtSheetOpen(false)}
        prefill={artPrefill}
        onSaved={(kindLabel, wasEdit) =>
          Alert.alert(
            wasEdit ? 'Camp knowledge updated' : 'Added to camp knowledge',
            `${kindLabel} ${
              wasEdit ? 'updated' : 'saved'
            }. It shows up in search, the reader (“Camp notes”), and travels with your next beam.`,
          )
        }
      />

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
          disabled={!position && !(selection?.kind === 'mapPoint' && mapPoint)}
          accessibilityRole="button"
          accessibilityLabel="Drop pin"
          accessibilityState={{
            disabled: !position && !(selection?.kind === 'mapPoint' && mapPoint),
          }}
          style={[
            styles.dropBtn,
            !position &&
              !(selection?.kind === 'mapPoint' && mapPoint) &&
              styles.dropBtnDisabled,
          ]}>
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
    ...tap, // 44pt floor — this pill was ~30pt tall (a11y review 2026-08-24)
    alignItems: 'center',
    justifyContent: 'center',
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
  pinStage: { flex: 1 },
  pinList: { paddingVertical: spacing.sm },
  pinListHint: { color: colors.faded, fontSize: type.small, marginBottom: spacing.md },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pinRowBody: { flex: 1, marginRight: spacing.md },
  pinRowTitle: { color: colors.night, fontSize: 18, fontWeight: '700' },
  pinRowDesc: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  pinRemove: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm },
  pinRemoveText: { color: colors.clayDeep, fontSize: type.small, fontWeight: '700' },
  chip: {
    ...tap, // 44pt chip floor (a11y review 2026-08-24)
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginRight: spacing.sm,
  },
  chipProminent: { borderColor: colors.clay, borderWidth: 2 },
  chipActive: { backgroundColor: colors.clay, borderColor: colors.clay },
  chipText: { color: colors.night, fontSize: 18, fontWeight: '700' },
  chipTextActive: { color: colors.onAccent }, // scheme-aware ink on clay
  artBtn: {
    backgroundColor: colors.sand,
    borderColor: colors.clay,
    borderRadius: radius.card,
    borderWidth: 2,
    marginBottom: spacing.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  artBtnText: { color: colors.night, fontSize: 18, fontWeight: '700' },
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
    ...tap, // 44pt floor (a11y review 2026-08-24)
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  dropBtnDisabled: { backgroundColor: colors.haze },
  dropBtnText: { color: colors.onAccent, fontSize: 18, fontWeight: '800' },
});
