/**
 * Event card — renders ONLY structured event rows from the database.
 * Dates, times, and addresses never come from model prose (the prototype caught the
 * model garbling "6:30 & D" into "6:30 AM"); deterministic narration and
 * these cards render the structured search result.
 */

import { eventDateLabel } from '../llm/eventNarration';
import React, { useCallback, useSyncExternalStore } from 'react';
import { bikeMinutesFor } from '../rightnow/playaWalk';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import type { EventRow } from '../types';
import { colors, radius, spacing, type } from '../theme';
import { confirmDontUse, HOLD_MS, type OnHide } from './dontUseThis';
import {
  favKey,
  favoriteKeySet,
  favoritesRevision,
  subscribeFavoritesChanged,
  toggleFavorite,
} from '../events/favorites';

interface Props {
  event: EventRow;
  /** Optional walk-minutes annotation (Right Now surface). */
  walkMinutes?: number | null;
  /** Optional "in 25 min" style annotation. */
  startsIn?: string;
  /** True when the same listing (title+time+where) repeats on enough dates
   * to read as daily — the when-line says "Daily · 14:00–16:00" instead of
   * naming one weekday (owner ask: cards that repeat daily should say so). */
  daily?: boolean;
  /** "Don't use this" on long-press -- a cancelled or bogus event stops
   * surfacing in answers. Optional: absent, the card is just a card. */
  onHide?: OnHide;
  /** Present ONLY when the parent resolved event.location to coordinates
   * (src/geo/brcGeo.addressToLatLon): the location line becomes a tap
   * target that opens the waypoint compass. Unresolvable locations (pre-
   * placement venue names) stay plain text — no dead affordance. */
  onNavigate?: () => void;
}

export function EventCard({ event, walkMinutes, startsIn, daily, onHide, onNavigate }: Props) {
  const time = event.time_end
    ? `${event.time_start}–${event.time_end}`
    : event.time_start;
  const onLongPress = useCallback(() => {
    if (onHide) {
      confirmDontUse({ kind: 'event', key: String(event.id), label: event.title }, onHide);
    }
  }, [event.id, event.title, onHide]);
  // Self-wired heart: every surface that renders an EventCard (Right Now,
  // browse, the Angel's chat answers) gets favoriting for free, and every
  // card re-renders on any toggle anywhere.
  useSyncExternalStore(subscribeFavoritesChanged, favoritesRevision);
  const fav = favoriteKeySet().has(favKey(event));
  const onHeart = useCallback(() => toggleFavorite(event), [event]);
  return (
    <Pressable
      style={styles.card}
      onLongPress={onLongPress}
      delayLongPress={HOLD_MS}
      disabled={!onHide}
      accessibilityHint={onHide ? "Long press: don't use this" : undefined}>
      <View style={styles.headerRow}>
        <Text style={styles.title} numberOfLines={2}>
          {event.title}
        </Text>
        {startsIn ? <Text style={styles.startsIn}>{startsIn}</Text> : null}
        <Pressable
          onPress={onHeart}
          hitSlop={spacing.md}
          accessibilityLabel={fav ? 'Remove from Faves' : 'Save to Faves'}>
          <Text style={fav ? styles.heartOn : styles.heart}>{fav ? '♥' : '♡'}</Text>
        </Pressable>
      </View>
      <Text style={styles.when}>
        {/* Camp-note events carry no day word; never lead with a bare
            separator ("· 19:30" read as a bug — Marisol, 2026-08-20). */}
        {[
          daily ? 'Daily' : `${event.day}, ${eventDateLabel(event.date)}`,
          time,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <Pressable
        onPress={onNavigate}
        disabled={!onNavigate}
        hitSlop={spacing.sm}
        accessibilityHint={onNavigate ? 'Opens the compass pointing here' : undefined}>
        <Text style={styles.where} numberOfLines={1}>
          {/* Pre-placement, a camp-hosted event's location falls back to the
              camp name — "Best Butt · Best Butt" read as a bug (owner, live
              2026-08-18). The camp prefix earns its ink only when it differs. */}
          {event.camp &&
          event.camp.trim().toLowerCase() !== event.location.trim().toLowerCase()
            ? `${event.camp} · `
            : ''}
          <Text style={onNavigate ? styles.whereTappable : undefined}>
            {onNavigate ? '🧭 ' : ''}
            {event.location}
          </Text>
          {walkMinutes != null
            ? `  ·  🚶 ${walkMinutes} min  🚴 ${bikeMinutesFor(walkMinutes)} min`
            : ''}
        </Text>
      </Pressable>
      {event.desc ? (
        <Text style={styles.desc} numberOfLines={2}>
          {event.desc}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.sage,
    padding: spacing.md,
    marginVertical: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: {
    flex: 1,
    color: colors.night,
    fontSize: type.body,
    fontWeight: '700',
  },
  startsIn: {
    color: colors.gold,
    fontSize: type.small,
    fontWeight: '700',
    marginLeft: spacing.sm,
  },
  // Quiet ink until it means something (Tufte): outline heart in the faded
  // tone, filled heart in clay once saved.
  heart: {
    color: colors.faded,
    fontSize: type.body,
    marginLeft: spacing.sm,
  },
  heartOn: {
    color: colors.clay,
    fontSize: type.body,
    marginLeft: spacing.sm,
  },
  when: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '600',
    marginTop: 2,
  },
  where: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: 2,
  },
  whereTappable: {
    color: colors.clay,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  desc: {
    color: colors.night,
    fontSize: type.small,
    marginTop: spacing.xs,
  },
});
