/**
 * Pack Reader — the offline reader over a pack's saved materials (owner
 * commission 2026-08-19): browse and READ the source documents directly
 * instead of asking the Angel and waiting for a reply. Two levels, both
 * plain: the pack's contents (one row per source file), then the document —
 * every chunk in insertion order, headings shown once per run. readPack.ts
 * owns both facts; this screen only lays them out.
 */

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Image,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../components/Text';
import { getDb } from '../events/db';
import { NOTES_PACK_PREFIX, notesRevision, subscribeNotesChanged } from '../camp/campNotes';
import {
  contentParagraphs,
  headingSegments,
  humanizeSource,
  listDocSources,
  markHeadingChanges,
  readDocSource,
} from '../docs/readPack';
import { ART_PACK_ID, gateOpen, sealedLocationFor } from '../packs/artLocations';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  packId: string;
  packName: string;
  onClose: () => void;
}

export function PackReader({ packId, packName, onClose }: Props) {
  const conn = getDb();
  // Read once on mount for immutable packs; camp-notes packs are LIVE
  // documents (a campmate's beam or your own new note lands mid-read), so
  // those re-read on the notes-changed signal (CAMP-NOTES ruling G).
  // useSyncExternalStore, not useState+useEffect: a notification that
  // fires between render and the effect's subscribe was LOST, leaving an
  // open reader stale until the next unrelated change (codex final sweep,
  // addendum 2). The store pair already existed in campNotes.
  const liveRev = useSyncExternalStore(subscribeNotesChanged, notesRevision);
  const rev = packId.startsWith(NOTES_PACK_PREFIX) ? liveRev : 0;
  // rev is a real input: notes packs re-read when the canonical store
  // changes; rev < 0 never happens, the guard just makes the dependency
  // honest to the linter and the reader alike.
  const sources = useMemo(
    () => (rev >= 0 ? listDocSources(conn, packId) : []),
    [conn, packId, rev],
  );
  const [open, setOpen] = useState<string | null>(null);
  // Hardware back walks the reader's own stack (doc -> contents -> close)
  // instead of backgrounding the whole app (P7/emulator field test 08-20).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (open !== null) {
        setOpen(null);
      } else {
        onClose();
      }
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);
  // Art-note photos (ruling H): a camp-note chunk carries its note id, and
  // the note may carry a thumbnail. One query per open document, keyed maps
  // in memory — the reader stays synchronous.
  const photos = useMemo(() => {
    if (open === null || rev < 0 || !packId.startsWith(NOTES_PACK_PREFIX)) {
      return new Map<string, string>();
    }
    // Scoped to the OPEN document's chunks: an unscoped sweep would pull
    // every writer's photos (potentially MBs) into JS for one page
    // (codex review blocker 8).
    const res = conn.execute(
      `SELECT c.note_key AS id, n.photo AS photo
       FROM doc_chunks c JOIN camp_notes n ON n.id = c.note_key
       WHERE c.pack_id = ? AND c.source_file = ? AND n.photo != ''`,
      [packId, open],
    );
    const map = new Map<string, string>();
    for (const r of (res.rows?._array ?? []) as { id: string; photo: string }[]) {
      map.set(r.id, r.photo);
    }
    return map;
  }, [conn, packId, open, rev]);

  const chunks = useMemo(
    () =>
      open === null || rev < 0
        ? []
        : markHeadingChanges(readDocSource(conn, packId, open)),
    [conn, packId, open, rev],
  );

  const title =
    open === null ? packName : humanizeSource(open, packName, sources.length);

  // Sealed art locations (ToS 6.1): the reader is the ONLY surface that can
  // show an address, and only once the device clock passes Gate. Computed
  // once per open document; the map is in-memory already.
  const isArt = packId === ART_PACK_ID;
  // 'open' is the trigger, not a value: one clock read per opened document
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gateNow = useMemo(() => new Date(), [open]);

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
          {/* Pre-gate: one honest line at the top, never per piece. */}
          {isArt && !gateOpen(gateNow) ? (
            <Text style={styles.sealed}>
              Locations unlock when Gate opens.
            </Text>
          ) : null}
          {chunks.map((c, i) => {
            const segments = headingSegments(c.heading);
            const leafHeading = segments[segments.length - 1] ?? '';
            const loc = c.newHeading
              ? sealedLocationFor(packId, leafHeading, gateNow)
              : null;
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
                      {leafHeading}
                    </Text>
                    {loc !== null ? (
                      <Text style={styles.location}>{loc}</Text>
                    ) : null}
                  </>
                ) : null}
                {photos.get(c.noteKey) ? (
                  <Image
                    source={{
                      uri: `data:image/jpeg;base64,${photos.get(c.noteKey)}`,
                    }}
                    style={styles.notePhoto}
                    resizeMode="cover"
                  />
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
  notePhoto: {
    width: 160,
    height: 160,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: colors.pressHint,
  },
  sealed: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginTop: spacing.md,
  },
  location: {
    color: colors.faded,
    fontSize: type.small,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
});
