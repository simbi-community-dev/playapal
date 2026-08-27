/**
 * SOURCE CHIPS — why the Angel said that, one tap away.
 *
 * An answer built on retrieval carries the passages it stood on. Collapsed,
 * they are a quiet row naming the document and the pack; opened, the chip
 * shows the passage text the model actually read. The analogue is a
 * knowledge panel's source line, not a bibliography: you see WHERE without
 * asking, and you open it only when you care.
 *
 * DUSTY, ONE-HANDED, AT NIGHT (the shipping constraint):
 *  - every chip is a full-width row at least TOUCH_TARGET tall — no small
 *    inline link, nothing needing aim;
 *  - the label is two lines (document, then pack) so neither gets truncated
 *    into meaninglessness at a glance;
 *  - dark ink on the card grounds, with a real border — readable through
 *    dust and glare, no low-contrast grey;
 *  - one chip open at a time, so the thread never turns into a wall;
 *  - nothing depends on hover, long-press, or a swipe.
 *
 * MEMORIAL REGISTER (camp-voice): when the passage remembers someone who
 * died, provenance is not a citation — it is the camp's own voice. The row
 * says so in those words, takes the sage edge the memorial card takes, and
 * shows the remembrance without a single storage token near it. The
 * SourceRef shape carries no pack id and no filename in either register.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import type { SourceRef } from '../types';
import { colors, radius, spacing, type } from '../theme';
import { confirmDontUse, HOLD_MS, type OnHide } from './dontUseThis';

interface Props {
  sources: SourceRef[];
  /** "Don't use this" on long-press -- a wrong passage stops being retrieved.
   * The header rule "nothing depends on long-press" protects the READING
   * path, which stays a plain tap; a hold is the deliberate, rare act of
   * saying a source is bad, and it never blocks reading. Offered on memorial
   * passages too (codex review 2026-08-17): the gentle register governs how a
   * remembrance RENDERS, not whether the user may stop a wrong one surfacing.
   * A harmful memorial with no local revocable fix is the worse outcome. */
  onHide?: OnHide;
}

/** Android/iOS minimum comfortable target; dusty gloved thumbs want more. */
const TOUCH_TARGET = 48;

function SourceChip({ source, onHide }: { source: SourceRef; onHide?: OnHide }) {
  const [open, setOpen] = useState(false);
  const canHide = onHide !== undefined;
  const onLongPress = useCallback(() => {
    if (canHide) {
      confirmDontUse({ kind: 'passage', key: source.id, label: source.doc, memorial: source.memorial }, onHide!);
    }
  }, [canHide, onHide, source.id, source.doc, source.memorial]);
  // The pack line is context, not a second name: a board chunk headed "Camp
  // board — offers (Dusty)" under a pack called "Camp board" would stutter.
  const showPack =
    source.pack.length > 0 &&
    !source.doc.toLowerCase().includes(source.pack.toLowerCase());
  return (
    <View style={styles.chipWrap}>
      <Pressable
        style={[styles.chip, source.memorial ? styles.chipMemorial : null]}
        onPress={() => setOpen(prev => !prev)}
        onLongPress={onLongPress}
        delayLongPress={HOLD_MS}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={
          open
            ? `Collapse the passage from ${source.doc}`
            : `Read the passage from ${source.doc}`
        }
        accessibilityHint={canHide ? "Long press: don't use this passage" : undefined}>
        <View style={styles.chipBody}>
          <Text style={styles.chipDoc} numberOfLines={1}>
            {source.doc}
          </Text>
          {showPack ? (
            <Text style={styles.chipPack} numberOfLines={1}>
              {source.pack}
            </Text>
          ) : null}
        </View>
        <Text style={styles.caret}>{open ? '⌄' : '›'}</Text>
      </Pressable>
      {open ? (
        <View
          style={[styles.passage, source.memorial ? styles.passageMemorial : null]}>
          {source.heading.length > 0 && source.heading !== source.doc ? (
            <Text style={styles.breadcrumb}>{source.heading}</Text>
          ) : null}
          <Text style={styles.passageText}>{source.passage}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function SourceChips({ sources, onHide }: Props) {
  if (sources.length === 0) {
    return null;
  }
  const memorial = sources.some(s => s.memorial);
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {memorial ? 'In the camp’s own words' : 'Where this came from'}
      </Text>
      {sources.map(source => (
        <SourceChip key={source.id} source={source} onHide={onHide} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  label: {
    color: colors.faded,
    fontSize: type.tiny,
    marginBottom: spacing.xs,
  },
  chipWrap: { marginTop: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TOUCH_TARGET,
    backgroundColor: colors.dust,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    borderLeftWidth: 3,
    borderLeftColor: colors.clay,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  // A remembrance is not a record: the memorial card's own sage edge.
  chipMemorial: { borderLeftColor: colors.sage },
  chipBody: { flex: 1 },
  chipDoc: { color: colors.night, fontSize: type.small, fontWeight: '600' },
  chipPack: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  caret: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '700',
    marginLeft: spacing.sm,
  },
  passage: {
    backgroundColor: colors.dust,
    borderRadius: radius.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.clay,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  passageMemorial: { borderLeftColor: colors.sage },
  breadcrumb: {
    color: colors.faded,
    fontSize: type.tiny,
    marginBottom: spacing.xs,
  },
  passageText: { color: colors.night, fontSize: type.small, lineHeight: 19 },
});
