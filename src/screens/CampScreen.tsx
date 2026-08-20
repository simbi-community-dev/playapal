/**
 * Camp — the append-only needs/offers board (camp board v0, doc 30 pilot
 * re-scoped per the codex refutation + lifecycle addendum).
 *
 * Value at N=1: post offers/needs alone with ZERO setup. Sync is opt-in:
 * set a name + camp passphrase once, then "Beam the board" shares every
 * known writer's sealed envelope through the system share sheet; a
 * campmate's beam imports via Packs → Import. The board renders the union
 * across phones, threaded (replies ride under items), age-labeled, default
 * fresh (≤72h). You write ONLY your own rows: your posts, your done flag,
 * and your replies to anyone's item ("re: took 2, thanks") — an item with
 * replies renders as "likely met ✨" without anyone touching the
 * original. Pilot label: the check rejects files made without the shared
 * phrase; it does not encrypt the board or prove who wrote a post.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getDb, rebuildFtsIndexes, listPacks } from '../events/db';
import { importPackViaPicker } from '../packs/importPack';
import { PackRowCard, isBoardPack } from './packRows';
import { FriendsSection } from './FriendsSection';
import type { PackRow } from '../types';
import {
  BoardPost,
  BoardThread,
  CampBeamError,
  CampPostType,
  ageLabel,
  deriveBoard,
  exportCampBundle,
  getCampIdentity,
  listCampBoard,
  saveCampProfile,
  setPostDone,
  upsertCampPost,
} from '../camp/campBoard';
import { hasLineageData } from '../facts/lineageView';
import { LineageScreen } from './LineageScreen';
import { PackReader } from './PackReader';
import { colors, radius, spacing, type } from '../theme';

const TYPE_LABELS: Record<CampPostType, string> = {
  offer: 'Gift',
  need: 'Need',
};
const SECTION_LABELS: Record<CampPostType, string> = {
  offer: 'Gifts',
  need: 'Needs',
};
/** A met need / a given gift completes like a small story, not a ticket
 * close (design lens): "met ✨" / "given ✨", never "done". */
const doneWord = (t: CampPostType): string => (t === 'need' ? 'met' : 'given');

export function CampScreen({
  onOpenCompass,
}: {
  onOpenCompass: (target: import('../geo/brcGeo').WaypointTarget | null) => void;
}) {
  const conn = getDb();
  const [posts, setPosts] = useState<BoardPost[]>(() => listCampBoard(conn));
  const [identity, setIdentity] = useState(() => getCampIdentity(conn));
  const [freshOnly, setFreshOnly] = useState(true);
  // Lineage rides the Camp tab (LINEAGE-STATEMENTS-DESIGN §6): the row exists
  // ONLY when an enabled pack carries sponsorship edges — no pack, no surface.
  // The tab remounts on every visit, so this is fresh after a pack toggle.
  const [lineageAvailable] = useState(() => hasLineageData(conn));
  const [view, setView] = useState<'board' | 'lineage'>('board');

  // Composer: new post, edit-own, or reply — one inline card.
  const [postType, setPostType] = useState<CampPostType>('offer');
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<BoardPost | null>(null);

  // Camp sync settings card (collapsed once configured).
  const [syncOpen, setSyncOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(identity.authorName);
  const [passDraft, setPassDraft] = useState(identity.passphrase);

  // Camp & private packs (Option A consolidation): the Packs tab's camp half
  // lives here, after Camp sync, before The board. Board packs (camp-board-*)
  // render compactly (one expandable count row), never as full rows.
  const [packs, setPacks] = useState<PackRow[]>(() => listPacks());
  const [boardsOpen, setBoardsOpen] = useState(false);
  // The offline reader (owner commission 2026-08-19): 'Read' on a camp-pack
  // row swaps the whole screen for the reader — the LineageScreen pattern,
  // one piece of state, no navigator.
  const [readingPack, setReadingPack] = useState<PackRow | null>(null);
  const refreshPacks = useCallback(() => setPacks(listPacks()), []);
  const campPacks = packs.filter(p => !p.builtin && !isBoardPack(p));
  const boardPacks = packs.filter(p => isBoardPack(p));

  const refresh = useCallback(() => {
    setPosts(listCampBoard(conn));
    setIdentity(getCampIdentity(conn));
  }, [conn]);

  const doImport = useCallback(async () => {
    try {
      const result = await importPackViaPicker();
      if (result) {
        const warn =
          result.warnings.length > 0 ? `\n\n${result.warnings.join('\n')}` : '';
        const counts =
          result.detail !== undefined
            ? result.detail
            : result.items !== undefined
            ? `${result.items} open board post${result.items === 1 ? '' : 's'} — see the board above`
            : [
                result.events ? `${result.events} events` : null,
                result.chunks ? `${result.chunks} guide passages` : null,
                result.nodes ? `${result.nodes} facts` : null,
                result.edges ? `${result.edges} relationships` : null,
              ]
                .filter(Boolean)
                .join(', ');
        Alert.alert('Pack added', `${result.name}: ${counts}.${warn}`);
        refreshPacks();
        refresh(); // a beamed board lands NEXT TO the board — show it now, not on remount
      }
    } catch (e: any) {
      Alert.alert("Couldn't read that pack", e?.message ?? String(e));
    }
  }, [refreshPacks, refresh]);


  const clearComposer = useCallback(() => {
    setEditingId(null);
    setReplyTo(null);
    setText('');
  }, []);

  const submit = useCallback(() => {
    try {
      upsertCampPost(conn, {
        id: editingId ?? undefined,
        type: replyTo ? replyTo.type : postType,
        text,
        ref_id: replyTo ? replyTo.id : undefined,
      });
      rebuildFtsIndexes(conn);
      clearComposer();
      refresh();
    } catch (e: any) {
      Alert.alert('Could not post', e?.message ?? String(e));
    }
  }, [conn, editingId, replyTo, postType, text, clearComposer, refresh]);

  const startEdit = useCallback((p: BoardPost) => {
    setReplyTo(null);
    setEditingId(p.id);
    setPostType(p.type);
    setText(p.text);
  }, []);

  const startReply = useCallback((p: BoardPost) => {
    setEditingId(null);
    setReplyTo(p);
    setText('');
  }, []);

  const toggleDone = useCallback(
    (p: BoardPost) => {
      setPostDone(conn, p.id, !p.done);
      rebuildFtsIndexes(conn);
      refresh();
    },
    [conn, refresh],
  );

  const saveSync = useCallback(() => {
    const next = saveCampProfile(conn, {
      authorName: nameDraft,
      passphrase: passDraft,
    });
    rebuildFtsIndexes(conn);
    setIdentity(next);
    setNameDraft(next.authorName);
    setPassDraft(next.passphrase);
    setSyncOpen(false);
    refresh();
  }, [conn, nameDraft, passDraft, refresh]);

  const beam = useCallback(async () => {
    let bundle: string;
    try {
      bundle = exportCampBundle(conn);
    } catch (e: any) {
      if (e instanceof CampBeamError) {
        setSyncOpen(true);
      }
      Alert.alert('Before you beam', e?.message ?? String(e));
      return;
    }
    try {
      await Share.share(
        { title: 'Playa Pal camp board', message: bundle },
        { dialogTitle: 'Beam the board' },
      );
    } catch {
      // Share sheet dismissed — nothing to clean up.
    }
  }, [conn]);

  const sections = useMemo(
    () => deriveBoard(posts, { freshOnly }),
    [posts, freshOnly],
  );
  const writerCount = useMemo(
    () => new Set(posts.map(p => p.writer_id)).size,
    [posts],
  );
  const hiddenByFresh = useMemo(() => {
    if (!freshOnly) {
      return 0;
    }
    const shown = sections.reduce((n, s) => n + s.threads.length, 0);
    const all = deriveBoard(posts, { freshOnly: false }).reduce(
      (n, s) => n + s.threads.length,
      0,
    );
    return all - shown;
  }, [posts, sections, freshOnly]);

  const renderThread = (thread: BoardThread) => {
    const p = thread.post;
    const own = p.writer_id === identity.writerId && !p.fork;
    return (
      <View key={`${p.pack_id}:${p.id}`} style={styles.itemCard}>
        <View style={styles.itemRow}>
          <View style={styles.itemBody}>
            <Text style={[styles.itemText, p.done && styles.itemTextDone]}>
              {p.text}
            </Text>
            <Text style={styles.itemMeta}>
              {own ? `${identity.authorName || 'this phone'} (you)` : p.author_name || 'campmate'}
              {'  ·  '}
              {ageLabel(p.created_at)}
              {p.done
                ? `  ·  ${doneWord(p.type)} ✨`
                : thread.likelyResolved
                ? `  ·  likely ${doneWord(p.type)} ✨`
                : ''}
              {p.fork ? '  ·  conflicted copy' : ''}
            </Text>
          </View>
          <View style={styles.itemActions}>
            {own ? (
              <>
                <Pressable style={styles.actionBtn} onPress={() => toggleDone(p)}>
                  <Text style={styles.actionText}>
                    {p.done ? 'Undo' : p.type === 'need' ? 'Met' : 'Given'}
                  </Text>
                </Pressable>
                <Pressable style={styles.actionBtn} onPress={() => startEdit(p)}>
                  <Text style={styles.actionText}>Edit</Text>
                </Pressable>
              </>
            ) : null}
            {!p.done ? (
              <Pressable style={styles.actionBtn} onPress={() => startReply(p)}>
                <Text style={styles.actionText}>Reply</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        {thread.replies.map(r => (
          <View key={`${r.pack_id}:${r.id}`} style={styles.replyRow}>
            <Text style={styles.replyMark}>↳</Text>
            <Text style={styles.replyText}>
              {r.text}
              <Text style={styles.replyMeta}>
                {'  — '}
                {r.writer_id === identity.writerId
                  ? identity.authorName || 'you'
                  : r.author_name || 'campmate'}
                {' · '}
                {ageLabel(r.created_at)}
              </Text>
            </Text>
          </View>
        ))}
      </View>
    );
  };

  if (readingPack) {
    return (
      <PackReader
        packId={readingPack.id}
        packName={readingPack.name}
        onClose={() => setReadingPack(null)}
      />
    );
  }

  if (view === 'lineage') {
    return <LineageScreen onBack={() => setView('board')} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {lineageAvailable ? (
        <Pressable style={styles.lineageRow} onPress={() => setView('lineage')}>
          <View style={styles.itemBody}>
            <Text style={styles.lineageTitle}>Lineage — who sponsored whom</Text>
            <Text style={styles.hintTight}>The camp's family tree, from your camp pack. Tap anyone to follow the line.</Text>
          </View>
          <Text style={styles.rowChevron}>›</Text>
        </Pressable>
      ) : null}

      {/* Composer */}
      <Text style={styles.sectionTitle}>
        {replyTo
          ? `Reply to: ${replyTo.text.slice(0, 40)}${replyTo.text.length > 40 ? '…' : ''}`
          : editingId
          ? 'Edit your post'
          : 'Post to the camp board'}
      </Text>
      <View style={styles.card}>
        {!replyTo ? (
          <View style={styles.chipRow}>
            {(['offer', 'need'] as CampPostType[]).map(t => (
              <Pressable
                key={t}
                style={[styles.chip, postType === t && styles.chipActive]}
                onPress={() => setPostType(t)}>
                <Text style={[styles.chipText, postType === t && styles.chipTextActive]}>
                  {TYPE_LABELS[t]}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <TextInput
          style={styles.input}
          placeholder={
            replyTo
              ? 'e.g. took 2, thanks!'
              : postType === 'offer'
              ? 'e.g. 3 spare bike tubes at the dome'
              : 'e.g. ride to Reno on Tuesday'
          }
          placeholderTextColor={colors.faded}
          value={text}
          onChangeText={setText}
        />
        <View style={styles.btnRow}>
          <Pressable style={styles.primaryBtn} onPress={submit}>
            <Text style={styles.primaryBtnText}>
              {replyTo ? 'Post reply' : editingId ? 'Save changes' : 'Post'}
            </Text>
          </Pressable>
          {editingId || replyTo ? (
            <Pressable style={styles.secondaryBtn} onPress={clearComposer}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Beam + sync */}
      <Text style={styles.sectionTitle}>Camp sync</Text>
      <View style={styles.card}>
        <Pressable style={styles.primaryBtn} onPress={beam}>
          <Text style={styles.primaryBtnText}>Beam the board</Text>
        </Pressable>
        <Text style={styles.hint}>
          Beams every board this phone knows (yours + imported campmates') to
          anyone nearby — AirDrop, Quick Share, LocalSend, no internet. Their
          beam imports with "Import a pack…" below.
          {writerCount > 1 ? ` Showing boards from ${writerCount} phones.` : ''}
        </Text>
        <Pressable style={styles.syncRow} onPress={() => setSyncOpen(o => !o)}>
          <Text style={styles.syncRowText}>
            {identity.passphrase
              ? `You: ${identity.authorName || 'unnamed'} · camp passphrase set`
              : 'Set your name + camp passphrase — shared files are checked'}
          </Text>
          <Text style={styles.rowChevron}>{syncOpen ? '˅' : '›'}</Text>
        </Pressable>
        {syncOpen ? (
          <View>
            <TextInput
              style={styles.input}
              placeholder="Your name — e.g. Maria"
              placeholderTextColor={colors.faded}
              value={nameDraft}
              onChangeText={setNameDraft}
            />
            <TextInput
              style={styles.input}
              placeholder="Camp passphrase — same on every phone"
              placeholderTextColor={colors.faded}
              autoCapitalize="none"
              value={passDraft}
              onChangeText={setPassDraft}
            />
            <Pressable style={styles.primaryBtn} onPress={saveSync}>
              <Text style={styles.primaryBtnText}>Save</Text>
            </Pressable>
            <Text style={styles.hint}>
              Agree on the passphrase in person; it never leaves the phone. It
              rejects files made without the shared phrase — it does not
              encrypt the board or prove who wrote a post.
            </Text>
          </View>
        ) : null}
        <Text style={styles.pilotLabel}>
          Pilot — boards are not encrypted, and anyone who knows the
          passphrase can create a valid beam. Use test-only data.
        </Text>
      </View>

      {/* Camp & private packs (moved from the retired Packs tab) */}
      <Text style={styles.sectionTitle}>Camp & private packs</Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          These travel camper-to-camper, never through an app store: get them
          from a camper who has them — they beam or share the pack file, you
          tap "Import a pack…" below. Playa Pal does not upload them anywhere.
        </Text>
        {boardPacks.length > 0 ? (
          <Pressable onPress={() => setBoardsOpen(o => !o)}>
            <Text style={styles.boardsToggle}>
              Campmates' boards: {boardPacks.length} {boardsOpen ? '˅' : '›'}
            </Text>
          </Pressable>
        ) : null}
        {boardsOpen
          ? boardPacks.map(p => (
              <PackRowCard key={p.id} pack={p} all={packs} onChanged={refreshPacks} />
            ))
          : null}
        {campPacks.length === 0 ? (
          <Text style={styles.emptySection}>None on this phone yet.</Text>
        ) : (
          campPacks.map(p => (
            <PackRowCard
              key={p.id}
              pack={p}
              all={packs}
              onChanged={refreshPacks}
              // Board packs above get no onRead: their chunks ARE the board
              // posts, and the board itself is their reader.
              onRead={() => setReadingPack(p)}
            />
          ))
        )}
        <Pressable style={styles.primaryBtn} onPress={doImport}>
          <Text style={styles.primaryBtnText}>Import a pack…</Text>
        </Pressable>
        <Text style={styles.hint}>
          Choose all files belonging to the pack together.
        </Text>
      </View>

      {/* Friends on playa (2026-08-19): my card + collected friend cards. */}
      <FriendsSection conn={conn} onOpenCompass={onOpenCompass} />

      {/* Board */}
      <View style={styles.boardHeader}>
        <Text style={styles.sectionTitle}>The board</Text>
        <View style={styles.chipRow}>
          {([true, false] as const).map(fresh => (
            <Pressable
              key={String(fresh)}
              style={[styles.chip, freshOnly === fresh && styles.chipActive]}
              onPress={() => setFreshOnly(fresh)}>
              <Text
                style={[
                  styles.chipText,
                  freshOnly === fresh && styles.chipTextActive,
                ]}>
                {fresh ? 'Fresh (3 days)' : 'All'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {sections.length === 0 ? (
        <Text style={styles.empty}>
          {freshOnly && hiddenByFresh > 0
            ? `Nothing fresh — ${hiddenByFresh} older post${
                hiddenByFresh === 1 ? '' : 's'
              } under "All".`
            : 'Nothing on the board yet — post a gift or a need above. Works fully offline, just for you until you beam.'}
        </Text>
      ) : (
        sections.map(section => (
          <View key={section.type}>
            <Text style={styles.groupHeader}>{SECTION_LABELS[section.type]}</Text>
            {section.threads.map(renderThread)}
          </View>
        ))
      )}
      {sections.length > 0 && freshOnly && hiddenByFresh > 0 ? (
        <Text style={styles.hiddenNote}>
          {hiddenByFresh} older post{hiddenByFresh === 1 ? '' : 's'} hidden —
          tap "All" to see everything.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  content: { paddingBottom: spacing.xl },
  sectionTitle: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    backgroundColor: colors.dust,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  chipActive: { backgroundColor: colors.sage, borderColor: colors.sage },
  chipText: { color: colors.night, fontSize: type.small },
  chipTextActive: { color: colors.cream, fontWeight: '700' },
  input: {
    backgroundColor: colors.dust,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    color: colors.night,
    fontSize: type.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  btnRow: { flexDirection: 'row', gap: spacing.sm },
  primaryBtn: {
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    padding: spacing.md,
    alignItems: 'center',
    flexGrow: 1,
  },
  primaryBtnText: { color: colors.cream, fontSize: type.body, fontWeight: '700' },
  secondaryBtn: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    padding: spacing.md,
    alignItems: 'center',
  },
  secondaryBtnText: { color: colors.night, fontSize: type.body },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
  },
  syncRowText: { flex: 1, color: colors.faded, fontSize: type.small },
  rowChevron: { color: colors.faded, fontSize: type.title, fontWeight: '300' },
  hint: { color: colors.faded, fontSize: type.small, marginTop: spacing.sm },
  // Camp & private packs section (Option A): the board-packs collapse toggle
  // and the empty-state line.
  boardsToggle: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  emptySection: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginVertical: spacing.sm,
  },
  hintTight: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  lineageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.plum,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  lineageTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  pilotLabel: {
    color: colors.gold,
    fontSize: type.tiny,
    marginTop: spacing.md,
  },
  boardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  empty: {
    color: colors.faded,
    fontSize: type.small,
    textAlign: 'center',
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  groupHeader: {
    color: colors.sage,
    fontSize: type.small,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  itemCard: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
    marginVertical: spacing.xs / 2,
  },
  itemRow: { flexDirection: 'row', alignItems: 'center' },
  itemBody: { flex: 1, marginRight: spacing.sm },
  itemText: { color: colors.night, fontSize: type.body, fontWeight: '600' },
  itemTextDone: {
    color: colors.faded,
    textDecorationLine: 'line-through',
    fontWeight: '400',
  },
  itemMeta: { color: colors.sage, fontSize: type.tiny, marginTop: spacing.xs },
  itemActions: { flexDirection: 'row' },
  actionBtn: { paddingVertical: spacing.sm, paddingLeft: spacing.md },
  actionText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  hiddenNote: {
    color: colors.faded,
    fontSize: type.tiny,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  replyRow: {
    flexDirection: 'row',
    marginTop: spacing.xs,
    paddingLeft: spacing.md,
  },
  replyMark: { color: colors.faded, fontSize: type.small, width: 20 },
  replyText: { flex: 1, color: colors.night, fontSize: type.small },
  replyMeta: { color: colors.faded, fontSize: type.tiny },
});
