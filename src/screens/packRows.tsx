/**
 * Pack rows — the shared render + behavior for a data-pack row (Option A
 * consolidation, 2026-08-19). Extracted from PacksScreen so the Camp and
 * Settings screens each render their own section without duplicating the
 * row; PacksScreen itself is deleted once both homes hold their halves.
 *
 * Two behaviors live here because both homes need them: the enable/disable
 * switch and the remove flow (with the own-board-pack guard's refusal).
 * The import affordance stays per-screen (it belongs to the Camp tab's
 * camp-packs section, not the Settings public section).
 */
import React from 'react';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';
import { Text } from '../components/Text';
import type { PackRow } from '../types';
import { removePack, setPackEnabled } from '../events/db';
import { colors, radius, spacing, type } from '../theme';

/** The version-difference presentation bug the forensics found: rows that
 * differ ONLY by version (a previous install's or an old passphrase's copy)
 * read as duplicates. When a pack shares its name with another row, the
 * older copy says so meaningfully instead of a bare '· vN'. */
export function packVersionNote(pack: PackRow, all: PackRow[]): string | null {
  const dupes = all.filter(p => p.name === pack.name && p.id !== pack.id);
  if (dupes.length === 0) {
    return null;
  }
  const older = dupes.some(p => p.version > pack.version);
  return older
    ? `older copy (v${pack.version}) — from a previous install or passphrase`
    : `v${pack.version}`;
}

/** The row's count line, without a dangling '· vN' when there are no counts
 * (the zero-count-row separator bug). Version rides the note, not the counts. */
export function packCountLine(pack: PackRow, all: PackRow[]): string {
  const counts = [
    pack.eventCount > 0 ? `${pack.eventCount} events` : null,
    pack.chunkCount > 0 && pack.postCount === 0
      ? `${pack.chunkCount} guide passages`
      : null,
    pack.postCount > 0 ? `${pack.postCount} board posts` : null,
    pack.nodeCount > 0 ? `${pack.nodeCount} facts` : null,
    pack.edgeCount > 0 ? `${pack.edgeCount} relationships` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const note = packVersionNote(pack, all);
  // No dangling separator: counts alone, note alone, or both with ONE join.
  if (counts && note) {
    return `${counts} · ${note}`;
  }
  return counts || note || '';
}

export function PackRowCard({
  pack,
  all,
  onChanged,
  onRead,
}: {
  pack: PackRow;
  all: PackRow[];
  onChanged: () => void;
  /** Open the offline reader on this pack (owner commission 2026-08-19).
   * Optional: homes that render no reader simply pass nothing. */
  onRead?: () => void;
}) {
  // 'Read' needs something to read: doc chunks. Event-only packs keep the
  // row link-free rather than opening an empty reader.
  const showRead = !!onRead && pack.chunkCount > 0;
  const toggle = (enabled: boolean) => {
    // Truthful post-commit FTS semantics (codex batch): the db layer now
    // RETURNS a warning when the flip committed but the index rebuild
    // degraded, and THROWS when nothing changed — both were silent before,
    // and a silent half-updated search index reads as a broken pack.
    try {
      const warning = setPackEnabled(pack.id, enabled);
      onChanged();
      if (warning) {
        Alert.alert('Pack updated', warning);
      }
    } catch (e: unknown) {
      Alert.alert('Pack unchanged', e instanceof Error ? e.message : String(e));
    }
  };
  const doRemove = () => {
    Alert.alert('Remove pack?', `Delete "${pack.name}" and its data?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          try {
            const warning = removePack(pack.id);
            if (warning) {
              Alert.alert('Pack removed', warning);
            }
          } catch (e: unknown) {
            // The one refusal: this phone's OWN camp pack (db.ts guard).
            Alert.alert('This pack stays', e instanceof Error ? e.message : String(e));
          }
          onChanged();
        },
      },
    ]);
  };
  return (
    <View style={styles.card}>
      <View style={styles.cardBody}>
        <Text style={styles.name}>{pack.name}</Text>
        <Text style={styles.desc} numberOfLines={2}>
          {pack.description}
        </Text>
        {packCountLine(pack, all) ? (
          <Text style={styles.counts}>{packCountLine(pack, all)}</Text>
        ) : null}
        {/* An empty row would still carry its top margin — render it only
            when at least one link shows. */}
        {showRead || !pack.builtin ? (
          <View style={styles.linkRow}>
            {showRead ? (
              <Pressable onPress={onRead}>
                <Text style={styles.read}>Read</Text>
              </Pressable>
            ) : null}
            {!pack.builtin ? (
              <Pressable onPress={doRemove}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <Switch
        value={pack.enabled}
        onValueChange={toggle}
        trackColor={{ true: colors.sage, false: colors.haze }}
      />
    </View>
  );
}

/** Camp-board packs (id starts 'camp-board-') are the board's backing store,
 * not packs a camper manages — they render compactly on the Camp tab, not as
 * rows here. This predicate is the one place that knows the id shape. */
export function isBoardPack(pack: PackRow): boolean {
  return pack.id.startsWith('camp-board-');
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
    marginVertical: spacing.xs,
  },
  cardBody: { flex: 1, marginRight: spacing.md },
  name: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  desc: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  counts: { color: colors.sage, fontSize: type.tiny, marginTop: spacing.xs },
  linkRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
  read: { color: colors.clay, fontSize: type.small },
  remove: { color: colors.clay, fontSize: type.small },
});
