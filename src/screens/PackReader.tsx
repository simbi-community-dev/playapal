/**
 * Pack Reader — the offline reader over a pack's saved materials (owner
 * commission 2026-08-19): browse and READ the source documents directly
 * instead of asking the Angel and waiting for a reply. Two levels, both
 * plain: the pack's contents (one row per source file), then the document —
 * every chunk in insertion order, headings shown once per run. readPack.ts
 * owns both facts; this screen only lays them out.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getDb } from '../events/db';
import {
  contentParagraphs,
  headingSegments,
  humanizeSource,
  listDocSources,
  markHeadingChanges,
  readDocSource,
} from '../docs/readPack';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  packId: string;
  packName: string;
  onClose: () => void;
}

export function PackReader({ packId, packName, onClose }: Props) {
  const conn = getDb();
  // Read once on mount: the reader is remounted per open, and pack content
  // only changes through install/remove flows that live elsewhere.
  const [sources] = useState(() => listDocSources(conn, packId));
  const [open, setOpen] = useState<string | null>(null);
  const chunks = useMemo(
    () =>
      open === null
        ? []
        : markHeadingChanges(readDocSource(conn, packId, open)),
    [conn, packId, open],
  );

  const title =
    open === null ? packName : humanizeSource(open, packName, sources.length);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          onPress={() => (open === null ? onClose() : setOpen(null))}
          hitSlop={8}
          style={styles.headerBtn}
          accessibilityRole="button"
          accessibilityLabel={open === null ? 'Close reader' : 'Back to contents'}>
          <Text style={styles.headerBtnText}>
            {open === null ? '‹ back' : '‹ contents'}
          </Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {/* Right spacer keeps the title centered (LineageScreen shape). */}
        <View style={styles.headerBtn} />
      </View>

      {open === null ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.hint}>
            Saved on this phone — read it straight, no question needed.
          </Text>
          {sources.map(s => (
            <Pressable
              key={s.source}
              style={styles.sourceRow}
              onPress={() => setOpen(s.source)}
              accessibilityRole="button">
              <View style={styles.sourceBody}>
                <Text style={styles.sourceTitle}>
                  {humanizeSource(s.source, packName, sources.length)}
                </Text>
                <Text style={styles.sourceMeta}>
                  {s.chunkCount} passage{s.chunkCount === 1 ? '' : 's'}
                </Text>
              </View>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
          ))}
          {sources.length === 0 ? (
            <Text style={styles.hint}>Nothing to read in this pack.</Text>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {chunks.map((c, i) => {
            const segments = headingSegments(c.heading);
            return (
              <View key={i}>
                {c.newHeading ? (
                  <>
                    {/* The full breadcrumb is context; a one-segment trail
                        would just repeat the heading below it. */}
                    {segments.length > 1 ? (
                      <Text style={styles.crumb}>{c.heading}</Text>
                    ) : null}
                    <Text
                      style={[
                        styles.heading,
                        segments.length <= 1 && styles.headingSolo,
                      ]}>
                      {segments[segments.length - 1] ?? ''}
                    </Text>
                  </>
                ) : null}
                {contentParagraphs(c.content).map((p, j) => (
                  <Text key={j} style={styles.para}>
                    {p}
                  </Text>
                ))}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.dust,
    paddingHorizontal: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  headerBtn: { minWidth: 72 },
  headerBtnText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  title: {
    flex: 1,
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    textAlign: 'center',
  },
  content: { paddingBottom: spacing.xl },
  hint: { color: colors.faded, fontSize: type.small, marginVertical: spacing.sm },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
    marginVertical: spacing.xs,
  },
  sourceBody: { flex: 1, marginRight: spacing.md },
  sourceTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  sourceMeta: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  rowChevron: { color: colors.faded, fontSize: type.title, fontWeight: '300' },
  crumb: {
    color: colors.faded,
    fontSize: type.tiny,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: spacing.lg,
  },
  heading: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  // A crumb-less heading carries the section gap the crumb otherwise would.
  headingSolo: { marginTop: spacing.lg },
  para: {
    color: colors.night,
    fontSize: type.body,
    lineHeight: 24,
    marginTop: spacing.sm,
  },
});
