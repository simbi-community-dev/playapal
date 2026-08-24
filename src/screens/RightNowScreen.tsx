/**
 * Right Now — the DEFAULT surface (iBurn's field-tested lesson: on-playa the
 * one flow that matters is "what's near me happening now, and what next";
 * chat is secondary). Free-text + suggestion chips, fully deterministic —
 * works with no model loaded.
 *
 * A when-picker (2026-08-13, owner request) switches the list from "now" to
 * any day in the data (chips derived from the packs' actual dates) plus a
 * coarse time-of-day. "Now" stays the default.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  rightNow,
  browseEvents,
  favoriteEvents,
  startsInLabel,
  RightNowResult,
  RightNowItem,
  VIBE_CHIPS,
  WALK_ANCHOR,
} from '../rightnow/rightNow';
import {
  favoriteKeySet,
  favoritesRevision,
  subscribeFavoritesChanged,
} from '../events/favorites';
import { dayChipLabel, dayHeading, TodSelection, TOD_SEGMENTS } from '../rightnow/browse';
import { eventDates, listPacks } from '../events/db';
import { sanitizeKeywords } from '../events/ftsQuery';
import { EventCard } from '../components/EventCard';
import { addressToLatLon, latLonToBrc, type WaypointTarget } from '../geo/brcGeo';
import { getCityGeometry } from '../geo/cityGeometry';
import { useLocation } from '../geo/useLocation';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  /** Route a question to the Angel chat tab. */
  onAskAngel: (question: string) => void;
  /** Open the waypoint compass (null target = pins/home picker). */
  onOpenCompass: (target: WaypointTarget | null) => void;
}

/** 'now' (default) | 'week' | 'faves' (the ♥ itinerary) | an ISO date chip. */
type DaySelection = 'now' | 'week' | 'faves' | string;

export function RightNowScreen({ onAskAngel, onOpenCompass }: Props) {
  const [freeText, setFreeText] = useState('');
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [daySel, setDaySel] = useState<DaySelection>('now');
  const [todSel, setTodSel] = useState<TodSelection>('all');
  const [now, setNow] = useState(() => new Date());

  // Keep "now" fresh (injectable-now pattern: rightNow() takes the Date).
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Day chips come from the dates actually present in enabled packs.
  const dates = useMemo(() => eventDates(), []);
  // BEFORE THE GATES (found by using the app on 2026-08-20, ten days out):
  // "Now" correctly finds nothing because the event pack starts Aug 30 —
  // but the generic empty state then blamed the user's VIBE and PACKS and
  // sent them hunting for a problem that does not exist. Everyone who
  // installs this before the burn — every tester, every burner packing —
  // met that screen. Say the true thing instead, and point at the tab that
  // actually has content.
  const beforeGates = useMemo(() => {
    if (dates.length === 0) {
      return false;
    }
    const d = new Date();
    const todayISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    return todayISO < dates[0];
  }, [dates]);

  // Live GPS -> BRC address. Walk times anchor to the REAL location when the
  // fix is inside the fence; otherwise (no fix, no permission, or testing
  // from home) everything falls back to the Center Camp anchor.
  const { position, status: locStatus } = useLocation();
  const geo = getCityGeometry();
  const here = useMemo(
    () => (position && geo ? latLonToBrc(position.lat, position.lon, geo) : null),
    [position, geo],
  );
  const liveHere = here && here.ring !== 'outside fence' ? here : null;
  const anchorPolar = useMemo(
    () =>
      liveHere ? { radiusFt: liveHere.distanceFt, angleDeg: liveHere.clockDeg } : undefined,
    [liveHere],
  );

  // Tappable event locations: resolvable playa addresses open the compass.
  const compassTargetFor = useCallback(
    (location: string): WaypointTarget | null => {
      if (!geo) {
        return null;
      }
      const t = addressToLatLon(location, geo);
      return t ? { label: t.label, lat: t.lat, lon: t.lon } : null;
    },
    [geo],
  );

  const vibeTerms = useMemo(() => {
    if (activeChip) {
      return VIBE_CHIPS.find(c => c.label === activeChip)?.terms ?? [];
    }
    return sanitizeKeywords(freeText);
  }, [activeChip, freeText]);

  const nowResult: RightNowResult | null = useMemo(
    () => (daySel === 'now' ? rightNow({ vibeTerms, anchorPolar }, now) : null),
    [daySel, vibeTerms, anchorPolar, now],
  );

  // Any heart toggled anywhere re-renders this screen (chip count + list).
  const favRev = useSyncExternalStore(subscribeFavoritesChanged, favoritesRevision);
  // No memo: favoriteKeySet() is revision-cached, so per-render is O(1).
  const favCount = favoriteKeySet().size;

  const browseResult: RightNowItem[] | null = useMemo(
    () =>
      daySel === 'now'
        ? null
        : daySel === 'faves'
          ? favoriteEvents({ anchorPolar })
          : browseEvents(
              { day: daySel === 'week' ? 'week' : daySel, tod: todSel },
              { vibeTerms, anchorPolar },
            ),
    // favRev is the recompute TRIGGER for faves mode, not a read value —
    // the store changes outside React (same shape as PackReader's 'open').
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [daySel, todSel, vibeTerms, anchorPolar, favRev],
  );

  const toggleChip = useCallback((label: string) => {
    setFreeText('');
    setActiveChip(prev => (prev === label ? null : label));
  }, []);

  const navProps = useCallback(
    (location: string) => {
      const t = compassTargetFor(location);
      return t ? { onNavigate: () => onOpenCompass(t) } : {};
    },
    [compassTargetFor, onOpenCompass],
  );

  // THE PACK-AWARE EMPTY STATE (P2-7): 'Nothing matching right now…' is a
  // FALSE empty when no event pack is enabled or the events table is empty —
  // the listings aren't sparse, the source is off. Detect that case and say
  // so with the fix, instead of a message that reads like the city has
  // nothing on tonight.
  const hasEnabledEventPack = useMemo(
    () => listPacks().some(p => p.enabled && p.eventCount > 0),
    [],
  );

  const empty =
    daySel === 'now'
      ? (nowResult?.now.length ?? 0) === 0 && (nowResult?.next.length ?? 0) === 0
      : (browseResult?.length ?? 0) === 0;

  const whenChip = (
    key: string,
    label: string,
    selected: boolean,
    onPress: () => void,
  ) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[styles.chip, selected && styles.whenChipActive]}>
      <Text style={[styles.chipText, selected && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="What are you in the mood for?"
        placeholderTextColor={colors.faded}
        value={freeText}
        onChangeText={t => {
          setFreeText(t);
          setActiveChip(null);
        }}
        returnKeyType="search"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={{ paddingRight: spacing.lg }}>
        {VIBE_CHIPS.map(chip => (
          <Pressable
            key={chip.label}
            onPress={() => toggleChip(chip.label)}
            style={[styles.chip, activeChip === chip.label && styles.chipActive]}>
            <Text
              style={[
                styles.chipText,
                activeChip === chip.label && styles.chipTextActive,
              ]}>
              {chip.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={{ paddingRight: spacing.lg }}>
        {whenChip('now', 'Now', daySel === 'now', () => setDaySel('now'))}
        {/* The itinerary chip carries its count — a glance answers "how
            full is my day?" without opening it. */}
        {whenChip(
          'faves',
          favCount > 0 ? `♥ ${favCount}` : '♥ Faves',
          daySel === 'faves',
          () => setDaySel('faves'),
        )}
        {whenChip('week', 'All week', daySel === 'week', () => setDaySel('week'))}
        {dates.map(d =>
          whenChip(d, dayChipLabel(d), daySel === d, () => setDaySel(d)),
        )}
      </ScrollView>

      {daySel !== 'now' && daySel !== 'faves' ? (
        <View style={styles.todRow}>
          {TOD_SEGMENTS.map(seg => (
            <Pressable
              key={seg.key}
              onPress={() => setTodSel(seg.key)}
              style={[styles.todBtn, todSel === seg.key && styles.todBtnActive]}>
              <Text
                style={[
                  styles.todText,
                  todSel === seg.key && styles.chipTextActive,
                ]}>
                {seg.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <ScrollView style={styles.results}>
        {daySel === 'now' && nowResult ? (
          <>
            {nowResult.now.length > 0 ? (
              <>
                <Text style={styles.section}>Happening now</Text>
                {nowResult.now.map(item => (
                  <EventCard
                    key={item.event.id}
                    event={item.event}
                    walkMinutes={item.walkMinutes}
                    startsIn="now"
                    daily={item.daily}
                    {...navProps(item.event.location)}
                  />
                ))}
              </>
            ) : null}
            {nowResult.next.length > 0 ? (
              <>
                <Text style={styles.section}>Up next</Text>
                {nowResult.next.map(item => (
                  <EventCard
                    key={item.event.id}
                    event={item.event}
                    walkMinutes={item.walkMinutes}
                    startsIn={startsInLabel(item.event, now)}
                    daily={item.daily}
                    {...navProps(item.event.location)}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : null}
        {browseResult
          ? browseResult.map((item, i) => {
              const prevDate = i > 0 ? browseResult[i - 1].event.date : null;
              const showHeading = item.event.date !== prevDate;
              return (
                <React.Fragment key={`${item.event.id}-${item.event.date}`}>
                  {showHeading ? (
                    <Text style={styles.section}>{dayHeading(item.event.date)}</Text>
                  ) : null}
                  <EventCard
                    event={item.event}
                    walkMinutes={item.walkMinutes}
                    startsIn={item.event.time_start ? undefined : 'anytime'}
                    daily={item.daily}
                    {...navProps(item.event.location)}
                  />
                </React.Fragment>
              );
            })
          : null}
        {empty ? (
          <Text style={styles.empty}>
            {!hasEnabledEventPack
              ? 'No event pack is enabled — turn one on in Settings › Public packs.'
              : daySel === 'now'
                ? beforeGates
                  ? `Black Rock City opens ${dayHeading(dates[0])}. Nothing is happening yet — tap “All week” to see what's planned, or ask the Angel anything about the burn.`
                  : 'Nothing matching right now — try a different vibe, ask the Angel, or check your packs in Settings.'
                : daySel === 'faves'
                  ? 'No faves yet — tap the ♡ on any event to line up your day or night; everything lands here in order.'
                  : 'Nothing scheduled for that pick — try another day or time.'}
          </Text>
        ) : null}
        {freeText.trim().length > 3 ? (
          <Pressable style={styles.askAngel} onPress={() => onAskAngel(freeText)}>
            <Text style={styles.askAngelText}>Ask the Angel: "{freeText.trim()}"</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.takeMeHome} onPress={() => onOpenCompass(null)}>
          <Text style={styles.takeMeHomeText}>🧭 Take me home</Text>
        </Pressable>
        <Text style={styles.anchorNote}>
          {liveHere
            ? `Rough walk times, from your location (${liveHere.address}).`
            : locStatus === 'denied'
              ? `Rough walk times, from ${WALK_ANCHOR}. Turn location on in system settings and they'll count from where you stand.`
              : `Rough walk times, from ${WALK_ANCHOR}.`}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  input: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.night,
    fontSize: type.body,
  },
  chipRow: { marginTop: spacing.sm, flexGrow: 0 },
  chip: {
    backgroundColor: colors.sand,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
  },
  chipActive: { backgroundColor: colors.clay, borderColor: colors.clay },
  whenChipActive: { backgroundColor: colors.plum, borderColor: colors.plum },
  chipText: { color: colors.night, fontSize: type.small },
  chipTextActive: { color: colors.cream, fontWeight: '700' },
  todRow: { flexDirection: 'row', marginTop: spacing.sm },
  todBtn: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingVertical: spacing.xs,
    marginRight: spacing.xs,
  },
  todBtnActive: { backgroundColor: colors.plum, borderColor: colors.plum },
  todText: { color: colors.night, fontSize: type.tiny },
  results: { flex: 1, marginTop: spacing.sm },
  section: {
    color: colors.plum,
    fontSize: type.small,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  empty: {
    color: colors.faded,
    fontSize: type.body,
    marginTop: spacing.xl,
    textAlign: 'center',
  },
  askAngel: {
    backgroundColor: colors.plum,
    borderRadius: radius.card,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  askAngelText: { color: colors.cream, fontSize: type.small, fontWeight: '600' },
  anchorNote: {
    color: colors.faded,
    fontSize: type.tiny,
    textAlign: 'center',
    marginVertical: spacing.lg,
  },
  takeMeHome: {
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    alignItems: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  takeMeHomeText: { color: colors.cream, fontSize: type.body, fontWeight: '800' },
});
