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
 *
 * ── FOUR PANES, ONE TAB (owner, 2026-08-24) ────────────────────────────
 * "the camp tab is now totally unmanageable, all this useful comms is
 * buried halfway down a long scroll ... fully organizing it all."
 *
 * This tab had grown six unrelated concerns stacked in ONE column: the
 * board, camp sync, the share doors, camp packs and notes, the pod card,
 * and the friend list. Pod comms left for its own tab (App.tsx). What
 * stayed is grouped behind a strip of labelled panes at the top of the
 * screen, which is the part that actually fixes the scroll: the board feed
 * has no length limit, so ANYTHING below it is unreachable on a busy day.
 * A pane strip never scrolls away, so every group is one tap from every
 * other one, whatever the board is doing.
 *
 * WHY PANES AND NOT PUSHED SCREENS. Three reasons, in order. (1) Nothing
 * hides: a pushed detail screen puts the app's only inbound door behind a
 * row a camper has to think to tap, which is the exact defect the sharing
 * audit fixed (docs/SHARING-SURFACES.md §3.3). (2) Every pane stays
 * MOUNTED — hidden panes keep their scroll position and their half-typed
 * drafts, and, load-bearing, FriendsSection stays alive to answer the
 * "Show my card" request the Share pane sends it. (3) The board and its
 * composer are one surface and stay one surface (the 2026-08-24 IA review's
 * first finding); the strip sits above both rather than between them.
 *
 * Lineage and the pack reader are still FULL-SCREEN pushes, not panes:
 * they are readers with their own way back, and they replace the tab
 * whole — the same one-piece-of-state pattern, no navigator.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getDb, rebuildFtsIndexes, listPacks } from '../events/db';
import {
  DocumentDirectoryPath,
  ExternalDirectoryPath,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { describeInstall, importPackViaPicker } from '../packs/importPack';
import { PackRowCard, isBoardPack } from './packRows';
import { FriendsSection } from './FriendsSection';
import { requestMyCardQr } from '../friends/friendCard';
import { ShareAppRow } from './ShareAppRow';
import type { PackRow } from '../types';
import {
  BEAM_FILE_EXT,
  BEAM_MIME,
  exportCampBeam,
  BoardPost,
  BoardThread,
  CampBeamError,
  CampPostType,
  ageLabel,
  deriveBoard,
  getCampIdentity,
  listCampBoard,
  saveCampProfile,
  setPostDone,
  upsertCampPost,
} from '../camp/campBoard';
import { syncBoardOverMesh } from '../crews/boardRecords';
import { listCrews, subscribeCrewsChanged } from '../crews/crew';
import { epochMinutes, subscribeMessagesChanged } from '../crews/messages';
import { getMyCard } from '../friends/friendCard';
import { hasLineageData } from '../facts/lineageView';
import { LineageScreen } from './LineageScreen';
import { PackReader } from './PackReader';
import { AddNoteSheet } from './AddNoteSheet';
import { subscribeNotesChanged } from '../camp/campNotes';
import { subscribeBeamInstalled } from '../beam/ingress';
import BeamQr from '../beam/BeamQr';
import { fitsOneQr } from '../beam/beamLink';
import { colors, radius, spacing, tap, type } from '../theme';

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

import { boardRowOnChanged } from './boardRowOnChanged';

/** The Camp tab's four groups. One is showing; the rest stay mounted. */
type CampPane = 'board' | 'share' | 'knowledge' | 'friends';

/**
 * The pane strip. Labels are the shortest honest word for each group —
 * every pane repeats its full name in its own header, so the strip can be
 * terse without being cryptic. It WRAPS rather than scrolls sideways: a
 * camper running large text must still be able to see that "Share" exists,
 * and a horizontal strip that runs off the edge hides destinations, which
 * is the thing this refactor is undoing.
 */
const PANES: { key: CampPane; label: string; spoken: string }[] = [
  { key: 'board', label: 'Board', spoken: 'The camp board' },
  { key: 'share', label: 'Share', spoken: 'Share and receive' },
  { key: 'knowledge', label: 'Knowledge', spoken: 'Camp knowledge and packs' },
  { key: 'friends', label: 'Friends', spoken: 'Friends on playa' },
];

export function CampScreen({
  onOpenCompass,
}: {
  onOpenCompass: (target: import('../geo/brcGeo').WaypointTarget | null) => void;
}) {
  const conn = getDb();
  const [posts, setPosts] = useState<BoardPost[]>(() => listCampBoard(conn));
  const [noteSheetOpen, setNoteSheetOpen] = useState(false);
  const [identity, setIdentity] = useState(() => getCampIdentity(conn));
  const [freshOnly, setFreshOnly] = useState(true);
  // Lineage rides the Camp tab (LINEAGE-STATEMENTS-DESIGN §6): the row exists
  // ONLY when an enabled pack carries sponsorship edges — no pack, no surface.
  // The tab remounts on every visit, so this is fresh after a pack toggle.
  const [lineageAvailable] = useState(() => hasLineageData(conn));
  const [lineageOpen, setLineageOpen] = useState(false);
  // Which group is showing. The board is the daily thing, so it is what a
  // camper lands on every time — the strip remembers nothing on purpose.
  const [pane, setPane] = useState<CampPane>('board');

  // Composer: new post, edit-own, or reply — one inline card.
  const [postType, setPostType] = useState<CampPostType>('offer');
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<BoardPost | null>(null);

  // Camp sync settings card (collapsed once configured).
  const [syncOpen, setSyncOpen] = useState(false);
  // "Share & receive" (sharing audit, docs/SHARING-SURFACES.md §3.3).
  // Open by default, deliberately: it holds the app's ONLY inbound door
  // ("Import a pack…"), and a hidden inbound door is the exact failure the
  // audit set out to fix. The fold exists so a camper who is set up can
  // shorten a long page, never so a first-timer has to find it.
  const [shareOpen, setShareOpen] = useState(true);
  // The board as a QR, when it fits in one (contract §5). null = not showing.
  const [qrBundle, setQrBundle] = useState<string | null>(null);
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
  // Every canonical note mutation (save, edit, remove, import) re-reads the
  // pack rows — a deleted last note otherwise left a ghost row (audit).
  React.useEffect(() => subscribeNotesChanged(refreshPacks), [refreshPacks]);
  // Set-aside camps keep their pack rows (and toggles) but must not clutter
  // the list: only the ACTIVE camp's camp-packs show. Non-camp private
  // packs always show.
  const inActiveCamp = useCallback(
    (id: string) => {
      const campPrefixes = [
        `camp-board-${identity.campId || 'local'}-`,
        `camp-notes-${identity.campId}-`,
      ];
      if (!id.startsWith('camp-board-') && !id.startsWith('camp-notes-')) {
        return true;
      }
      return campPrefixes.some(pre => id.startsWith(pre));
    },
    [identity.campId],
  );
  const campPacks = packs.filter(
    p => !p.builtin && !isBoardPack(p) && inActiveCamp(p.id),
  );
  const boardPacks = packs.filter(p => isBoardPack(p) && inActiveCamp(p.id));

  const refresh = useCallback(() => {
    setPosts(listCampBoard(conn));
    setIdentity(getCampIdentity(conn));
  }, [conn]);
  // A beam that arrives through the native door (Files, Quick Share, a share
  // sheet) while this tab is open must show up without a remount — same as
  // the picker path, which calls these two directly.
  React.useEffect(
    () =>
      subscribeBeamInstalled(() => {
        refreshPacks();
        refresh();
      }),
    [refreshPacks, refresh],
  );

  // ── THE BOARD RIDES THE POD ────────────────────────────────────────────
  // Posts propagate by themselves now (src/crews/boardRecords.ts): what this
  // phone posts goes out as a gossip record to every pod it belongs to, and
  // what podmates in this camp posted lands on the board here. There is
  // nothing to turn on and nothing to tap — a record moves exactly when the
  // pod's own sync moves, so this is housekeeping, not a transport.
  //
  // The pass is idempotent (unchanged posts publish nothing and import
  // nothing), which is what lets it run off the store's own change signals:
  // a new post, an edit, a pod joined, a podmate's record arriving. An
  // import writes rows, which re-runs this effect once more and then settles.
  const [meshRev, setMeshRev] = useState(0);
  const bumpMesh = useCallback(() => setMeshRev(r => r + 1), []);
  React.useEffect(() => subscribeMessagesChanged(bumpMesh), [bumpMesh]);
  React.useEffect(() => subscribeCrewsChanged(bumpMesh), [bumpMesh]);
  // A refusal in the substrate's own words, shown under the board rather
  // than in an alert: it re-states on every pass until the post is fixed,
  // and an alert that re-opens itself is worse than the problem.
  const [meshNote, setMeshNote] = useState('');
  React.useEffect(() => {
    const result = syncBoardOverMesh(
      conn,
      listCrews(),
      getMyCard(conn).id,
      epochMinutes(Date.now()),
    );
    if (result.imported > 0) {
      rebuildFtsIndexes(conn);
      refreshPacks();
      refresh();
    }
    setMeshNote(result.refusals[0] ?? '');
  }, [conn, meshRev, posts, identity.campId, refresh, refreshPacks]);

  const doImport = useCallback(async () => {
    try {
      const result = await importPackViaPicker();
      if (result) {
        Alert.alert('Pack added', describeInstall(result));
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
    // Marisol finding #7: a save with the keyboard open LOOKED successful
    // while doing nothing, and a mistyped passphrase silently moved her to
    // a different camp. The save now SPEAKS: what saved, and — loudly —
    // when the camp itself changed.
    const before = getCampIdentity(conn);
    const next = saveCampProfile(conn, {
      authorName: nameDraft,
      passphrase: passDraft,
    });
    rebuildFtsIndexes(conn);
    refreshPacks(); // a camp switch retires/restores pack rows — show it now
    setIdentity(next);
    setNameDraft(next.authorName);
    setPassDraft(next.passphrase);
    setSyncOpen(false);
    refresh();
    if (next.campId === '') {
      Alert.alert('Saved', `Name saved as ${next.authorName || 'blank'}. No camp passphrase yet — beams and notes need one.`);
    } else if (before.campId !== '' && before.campId !== next.campId) {
      Alert.alert(
        'You changed camps',
        'This passphrase is DIFFERENT from your old one, so this phone joined a different camp. Boards and notes from the old camp are set aside (switch the passphrase back to restore them). If you meant to stay in your camp, check the passphrase with a campmate — it must match on every phone, word for word.',
      );
    } else {
      Alert.alert(
        'Saved',
        `You're set: ${next.authorName} · camp passphrase saved. Campmates with the same passphrase can now verify your beams.`,
      );
    }
  }, [conn, nameDraft, passDraft, refresh, refreshPacks]);

  const exportBundle = useCallback((): string | null => {
    try {
      const { bundle, shedAuthors } = exportCampBeam(conn);
      if (shedAuthors.length > 0) {
        // Honest degradation, said out loud: the beam still carries YOUR
        // board; the named campmates' boards were too big to ride along.
        // The alert asks them to try from their own phones — and if their
        // own board is over the ceiling, export refuses THEM with words
        // (no universal delivery guarantee exists; codex final tail).
        Alert.alert(
          'Beam is full',
          `This beam carries your board, but ${shedAuthors.join(', ')}’s ` +
            'boards made it too big to include — ask them to beam their own board from their phone.',
        );
      }
      return bundle;
    } catch (e: any) {
      if (e instanceof CampBeamError) {
        setSyncOpen(true);
      }
      Alert.alert('Before you beam', e?.message ?? String(e));
      return null;
    }
  }, [conn]);

  // One button, best transport chosen by payload class (contract §5): a
  // board that fits one QR is shown as one — they point their normal camera
  // at it, no pairing, no permissions, no ecosystem agreement. Anything
  // bigger (or a tap on "Beam as file") goes out as the .playapal file.
  const beam = useCallback(() => {
    const bundle = exportBundle();
    if (bundle === null) {
      return;
    }
    if (fitsOneQr(bundle)) {
      setQrBundle(bundle);
      return;
    }
    void beamAsFile(bundle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportBundle]);

  const beamAsFile = useCallback(async (bundle: string) => {
    setQrBundle(null);
    // The beam is a FILE, shared as one. Text sharing was the field test's
    // hard blocker: the chooser said "Sharing text", Save targets refused
    // it, and receivers got pasted JSON instead of something Import can
    // open (Marisol, 2026-08-20). The file also STAYS on disk as the
    // re-sendable copy.
    const stamp = new Date().toISOString().slice(0, 10);
    // ExternalDirectoryPath is "" on iOS (rn-fs 2.40) — the beam file must
    // land in the platform's real app dir or writeFile fails before any share.
    const beamDir =
      Platform.OS === 'android' ? ExternalDirectoryPath : DocumentDirectoryPath;
    // .playapal, not .json: the receiver's phone opens OUR extension in
    // Playa Pal with one tap (docs/BEAM-INGRESS-CONTRACT.md §1). The content
    // is the same JSON as before; only the name and MIME changed.
    const path = `${beamDir}/camp-beam-${stamp}.${BEAM_FILE_EXT}`;
    try {
      await writeFile(path, bundle, 'utf8');
    } catch (e: any) {
      Alert.alert('Could not write the beam file', e?.message ?? String(e));
      return;
    }
    try {
      if (Platform.OS === 'android' && NativeModules.ShareFile) {
        await NativeModules.ShareFile.shareFile(
          path,
          BEAM_MIME,
          'Beam the board',
        );
      } else {
        await Share.share(
          // url only: a message payload makes iOS targets share the raw
          // JSON as text instead of the importable file.
          { title: 'Playa Pal camp board', url: `file://${path}` },
          { dialogTitle: 'Beam the board' },
        );
      }
    } catch {
      // The share sheet could not open — the persisted copy still stands.
      Alert.alert(
        'Beam saved, not sent',
        Platform.OS === 'android'
          ? `The share sheet did not open, but the beam file is saved at ${path.replace('/storage/emulated/0/', '')} — share it from your Files app.`
          : 'The share sheet did not open, but the beam file is saved in Playa Pal\u2019s folder in the Files app — share it from there.',
      );
      return;
    }
    // Intent, not outcome: we know the file exists and the share sheet
    // opened; whether the camper completed a send is theirs to know.
    Alert.alert(
      'Beam ready',
      Platform.OS === 'android'
        ? `Your share sheet opened with the beam file. Tell your campmate: open it from the FILES app (Quick Share's own "Open" button doesn't know our file type and will say unsupported — the file is fine). A copy stays at ${path.replace('/storage/emulated/0/', '')} so you can re-send it any time.`
        : 'Your share sheet opened with the beam file (a campmate taps it to import — or uses "Import a pack…"). A copy stays in Playa Pal\u2019s folder in the Files app so you can re-send it any time (like everything on this phone, it rides your normal backup — camp boards are not encrypted).',
    );
  }, []);

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
            {/* Bare verbs get a subject in the spoken label (a11y review
                2026-08-24): three posts in a row each say "Reply" — the
                label says reply TO WHAT. */}
            {own ? (
              <>
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => toggleDone(p)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    p.done
                      ? `Undo ${doneWord(p.type)} on: ${p.text}`
                      : `Mark ${doneWord(p.type)}: ${p.text}`
                  }>
                  <Text style={styles.actionText}>
                    {p.done ? 'Undo' : p.type === 'need' ? 'Met' : 'Given'}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.actionBtn}
                  onPress={() => startEdit(p)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit your post: ${p.text}`}>
                  <Text style={styles.actionText}>Edit</Text>
                </Pressable>
              </>
            ) : null}
            {!p.done ? (
              <Pressable
                style={styles.actionBtn}
                onPress={() => startReply(p)}
                accessibilityRole="button"
                accessibilityLabel={`Reply to: ${p.text}`}>
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

  if (lineageOpen) {
    return <LineageScreen onBack={() => setLineageOpen(false)} />;
  }

  return (
    <View style={styles.screen}>
      {/* The pane strip — the whole point of the refactor. It is OUTSIDE
          every scroll, so a board with two hundred posts on it can never
          push another group off the bottom of the world. */}
      <View style={styles.paneBar} accessibilityRole="tablist">
        {PANES.map(p => (
          <Pressable
            key={p.key}
            onPress={() => setPane(p.key)}
            accessibilityRole="tab"
            accessibilityLabel={p.spoken}
            accessibilityState={{ selected: pane === p.key }}
            style={[styles.paneTab, pane === p.key && styles.paneTabOn]}>
            <Text
              style={[
                styles.paneTabText,
                pane === p.key && styles.paneTabTextOn,
              ]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── BOARD: the composer, the feed, and the one control that moves
          them (sharing audit §3.1 — a share control belongs beside the
          thing it shares, so "Beam the board" stays with the board). */}
      <ScrollView
        style={pane === 'board' ? styles.container : styles.paneHidden}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
      {/* Composer */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
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
              // Selection said out loud (a11y review 2026-08-24): which
              // kind is chosen travels to a screen reader, not just a
              // color flip.
              <Pressable
                key={t}
                accessibilityRole="button"
                accessibilityLabel={TYPE_LABELS[t]}
                accessibilityState={{ selected: postType === t }}
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
          <Pressable
            style={styles.primaryBtn}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel={
              replyTo ? 'Post reply' : editingId ? 'Save changes' : 'Post'
            }>
            <Text style={styles.primaryBtnText}>
              {replyTo ? 'Post reply' : editingId ? 'Save changes' : 'Post'}
            </Text>
          </Pressable>
          {editingId || replyTo ? (
            <Pressable
              style={styles.secondaryBtn}
              onPress={clearComposer}
              accessibilityRole="button"
              accessibilityLabel="Cancel">
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Board — DIRECTLY under the composer (a11y+IA review 2026-08-24,
          DO-NOW #1: the board was split in half, composer at the top and
          the feed 200 lines down past sync, packs, pods, and friends —
          write and read are ONE surface). Sync/packs/friends now follow. */}
      <View style={styles.boardHeader}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          The board
        </Text>
        <View style={styles.chipRow}>
          {([true, false] as const).map(fresh => (
            <Pressable
              key={String(fresh)}
              accessibilityRole="button"
              accessibilityLabel={
                fresh ? 'Show fresh posts, last 3 days' : 'Show all posts'
              }
              accessibilityState={{ selected: freshOnly === fresh }}
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
      {meshNote ? <Text style={styles.hiddenNote}>{meshNote}</Text> : null}
      {sections.length === 0 ? (
        <Text style={styles.empty}>
          {freshOnly && hiddenByFresh > 0
            ? `Nothing fresh — ${hiddenByFresh} older post${
                hiddenByFresh === 1 ? '' : 's'
              } under "All".`
            : 'Nothing on the board yet — post a gift or a need above. It works with no signal: what you post travels to campmates in your pods on its own, and beaming reaches everyone else.'}
        </Text>
      ) : (
        sections.map(section => (
          <View key={section.type}>
            <Text style={styles.groupHeader} accessibilityRole="header">
              {SECTION_LABELS[section.type]}
            </Text>
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

      {/* Beam + sync */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Camp sync
      </Text>
      <View style={styles.card}>
        <Pressable
          style={styles.primaryBtn}
          onPress={beam}
          accessibilityRole="button"
          accessibilityLabel="Beam the board">
          <Text style={styles.primaryBtnText}>Beam the board</Text>
        </Pressable>
        {qrBundle !== null ? (
          <View style={styles.qrWrap}>
            <BeamQr bundleJson={qrBundle} onUseFile={() => void beamAsFile(qrBundle)} />
            <View style={styles.btnRow}>
              <Pressable
                style={styles.secondaryBtn}
                onPress={() => void beamAsFile(qrBundle)}
                accessibilityRole="button"
                accessibilityLabel="Beam as file instead">
                <Text style={styles.secondaryBtnText}>Beam as file instead</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryBtn}
                onPress={() => setQrBundle(null)}
                accessibilityRole="button"
                accessibilityLabel="Done showing the code">
                <Text style={styles.secondaryBtnText}>Done</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <Text style={styles.hint}>
          Your posts already travel to campmates in your pods by themselves,
          as phones pass each other. Beaming is for everyone else: it carries
          every board this phone knows (yours + imported campmates') to
          anyone nearby — AirDrop, Quick Share, LocalSend, no internet.
          Two things the RECEIVER does (both measured on real phones in the
          dust-run, 2026-08-21): first, open Quick Share's receive screen so
          this phone can find them — a phone is not visible just by being
          nearby; second, open the arrived file from the FILES app — the
          Quick Share popup's own Open button says "unsupported", the file
          is fine. Their
          beam imports with "Import a pack…", under "Share" at the top of
          this tab.
          {writerCount > 1 ? ` Showing boards from ${writerCount} phones.` : ''}
        </Text>
        {/* A collapsible header carries its expanded state (a11y review
            2026-08-24) — the chevron alone is silent to a screen reader. */}
        <Pressable
          style={styles.syncRow}
          onPress={() => setSyncOpen(o => !o)}
          accessibilityRole="button"
          accessibilityLabel="Your name and camp passphrase"
          accessibilityState={{ expanded: syncOpen }}>
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
            <Pressable
              style={styles.primaryBtn}
              onPress={saveSync}
              accessibilityRole="button"
              accessibilityLabel="Save name and passphrase">
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
      </ScrollView>

      {/* ── SHARE & RECEIVE ── */}
      <ScrollView
        style={pane === 'share' ? styles.container : styles.paneHidden}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
      {/* Share & receive (sharing audit, docs/SHARING-SURFACES.md §3).
          ─────────────────────────────────────────────────────────────
          THE RULE THIS SECTION FOLLOWS, because it is the thing that was
          missing rather than the buttons: a share control belongs beside
          the thing it shares, so "Beam the board" stays under the board
          and the friend-card buttons stay on the card. What was actually
          mis-filed was the OTHER kind of door — the ones that do not
          depend on anything above them on the page:

            · taking something IN (one picker for cards, beams, notes and
              packs alike) was filed under "packs" and named for packs;
            · handing over the APP — the only path that reaches a person
              with no Playa Pal at all — was three levels down in Settings.

          A SECOND door earns its place here only when it REUSES the one
          implementation and the first door is far away: "Show my card"
          runs FriendsSection's own consent ask and QR modal (a pane away),
          and the app row is literally the same component Settings mounts.
          "Beam the board" gets no second door — the first one is under the
          board it beams, one tap away on the Board pane, and a duplicate
          button that close is noise, not a door.

          Signal is named on every row because it is the one thing a
          camper cannot find out by trying: almost nothing here needs
          internet, and the two halves that do are the halves that fail at
          the gate. */}
      <Pressable
        style={styles.sectionTitleRow}
        onPress={() => setShareOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel="Share and receive"
        accessibilityState={{ expanded: shareOpen }}>
        <Text style={styles.sectionTitle}>Share &amp; receive</Text>
        <Text style={styles.sectionChevron}>{shareOpen ? '˅' : '›'}</Text>
      </Pressable>
      {shareOpen ? (
        <View style={styles.card}>
          {/* The request bus (docs/SHARING-SURFACES.md §3.3) still runs the
              show: this row ASKS, FriendsSection answers with its own
              consent ask and its own QR modal, so the app's one consent
              primitive is never forked. The pane switch rides along because
              the answer renders inside the Friends pane — and because a
              camper who just handed over their card is exactly where they
              want to be afterwards, looking at it. */}
          <Pressable
            style={styles.shareRow}
            onPress={() => {
              setPane('friends');
              requestMyCardQr();
            }}
            accessibilityRole="button"
            accessibilityLabel="Show my card as a code to scan">
            <View style={styles.itemBody}>
              <Text style={styles.shareRowTitle}>Show my card</Text>
              <Text style={styles.hintTight}>
                For anyone — a campmate, a friend, someone you just met. They
                point their normal camera at it. With Playa Pal on their phone
                it opens straight in the app with no signal; without it, the
                code sends them to a web page, and that part needs signal.
              </Text>
            </View>
            <Text style={styles.rowChevron}>›</Text>
          </Pressable>
          {/* The same row Settings mounts — one component, two doors
              (src/screens/ShareAppRow.tsx). This is the door for "they are
              standing right here and have nothing". */}
          <ShareAppRow />
          {/* Secondary, deliberately. Moving this door here (the sharing
              audit) also made it the loudest thing on the Camp tab — a
              filled clay button outshouting "Post", which is the control
              people actually use daily. An inbound door wants to be easy
              to FIND, not to be the screen's headline. */}
          <Pressable
            style={styles.secondaryBtn}
            onPress={doImport}
            accessibilityRole="button"
            accessibilityLabel="Import a pack">
            <Text style={styles.secondaryBtnText}>Import a pack…</Text>
          </Pressable>
          <Text style={styles.hint}>
            Takes in anything a camper hands you, whatever it is called — a
            friend's card, a campmate's beam, camp notes, a camp pack.
            No signal, ever.
            Choose all the files belonging to one pack together. If the
            chooser opens on an EMPTY Downloads screen, browse this phone's
            storage from its ☰ menu — the Downloads view misses files that
            arrived by cable (measured, 2026-08-21).
          </Text>
          <Text style={styles.hintTight}>
            Two more ways to hand something over live next to the thing they
            move: "Beam the board" under Board, and "Share card", "Beam
            friends" and the printable list under Friends on playa.
          </Text>
        </View>
      ) : null}
      </ScrollView>

      {/* ── CAMP KNOWLEDGE: what this camp knows, and the packs it came in
          on. Lineage leads because it is a reader, not a control. */}
      <ScrollView
        style={pane === 'knowledge' ? styles.container : styles.paneHidden}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {lineageAvailable ? (
          <Pressable
            style={styles.lineageRow}
            onPress={() => setLineageOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Lineage — who sponsored whom">
            <View style={styles.itemBody}>
              <Text style={styles.lineageTitle}>
                Lineage — who sponsored whom
              </Text>
              <Text style={styles.hintTight}>
                The camp's family tree, from your camp pack. Tap anyone to
                follow the line.
              </Text>
            </View>
            <Text style={styles.rowChevron}>›</Text>
          </Pressable>
        ) : null}

      {/* Camp & private packs (moved from the retired Packs tab) */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Camp & private packs
      </Text>
      <View style={styles.card}>
        <Text style={styles.hint}>
          These travel camper-to-camper, never through an app store: get them
          from a camper who has them — they beam or share the pack file, you
          tap "Import a pack…" under "Share" at the top of this tab. Playa
          Pal does not upload them anywhere.
        </Text>
        {boardPacks.length > 0 ? (
          <Pressable
            onPress={() => setBoardsOpen(o => !o)}
            accessibilityRole="button"
            accessibilityLabel={`Boards, ${boardPacks.length}`}
            accessibilityState={{ expanded: boardsOpen }}
            style={styles.linkTap}>
            <Text style={styles.boardsToggle}>
              Boards: {boardPacks.length} {boardsOpen ? '˅' : '›'}
            </Text>
          </Pressable>
        ) : null}
        {boardsOpen
          ? boardPacks.map(p => (
              <PackRowCard
                key={p.id}
                pack={p}
                all={packs}
                onChanged={boardRowOnChanged(refreshPacks, refresh)}
              />
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
        <Pressable
          style={styles.primaryBtn}
          onPress={() => setNoteSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Add to camp knowledge">
          <Text style={styles.primaryBtnText}>Add to camp knowledge…</Text>
        </Pressable>
        <Text style={styles.hint}>
          A memory, an event the guide missed, a fix to a wrong fact, a camp
          resource, or art you found — typed right here, no files. Notes
          travel with your camp beam. Art is quickest to log from the map,
          where the address fills itself in.
        </Text>
      </View>
      </ScrollView>

      {/* ── FRIENDS ON PLAYA ──
          ALWAYS MOUNTED, hidden rather than unmounted (the App.tsx
          ChatScreen pattern). Two things depend on it: the "Show my card"
          row in the Share pane is answered by this section's subscription
          (docs/SHARING-SURFACES.md §3.3), and an unmounted subscriber is a
          dead tap. Hiding also keeps a half-typed card edit alive while a
          camper checks the board. */}
      <ScrollView
        style={pane === 'friends' ? styles.container : styles.paneHidden}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <FriendsSection conn={conn} onOpenCompass={onOpenCompass} />
      </ScrollView>

      <AddNoteSheet
        visible={noteSheetOpen}
        onClose={() => setNoteSheetOpen(false)}
        onSaved={(label, wasEdit) => {
          refreshPacks();
          Alert.alert(
            wasEdit ? 'Camp knowledge updated' : 'Added to camp knowledge',
            `${label} ${
              wasEdit ? 'updated' : 'saved'
            }. It shows up in search, the reader ("Camp notes"), and travels with your next beam.`,
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1, paddingHorizontal: spacing.lg },
  content: { paddingBottom: spacing.xl },
  // A hidden pane keeps its subtree mounted — state, scroll position and
  // subscriptions all survive a switch (the App.tsx ChatScreen pattern).
  paneHidden: { display: 'none' },
  // The pane strip. It WRAPS instead of scrolling sideways: at large system
  // text a horizontal strip pushes its last tab off the edge, and a
  // destination you cannot see is a destination you do not have.
  paneBar: {
    borderBottomColor: colors.haze,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  paneTab: {
    ...tap, // 44pt floor — dusty, gloved, headlamp-lit hands
    alignItems: 'center',
    borderRadius: radius.chip,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  paneTabOn: { backgroundColor: colors.clay },
  paneTabText: { color: colors.faded, fontSize: type.small, fontWeight: '700' },
  paneTabTextOn: { color: colors.onAccent },
  sectionTitle: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  // A collapsible group header: title left, chevron right, 44pt floor — the
  // header IS a button (the SettingsScreen "Public packs" pattern, reused
  // verbatim so the two tabs fold the same way).
  sectionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: tap.minHeight,
  },
  sectionChevron: {
    color: colors.faded,
    fontSize: type.title,
    fontWeight: '300',
    marginLeft: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  // A "Share & receive" row: title over an honest one-liner, chevron right —
  // the Settings row shape, which is also what ShareAppRow renders, so the
  // three rows in that card read as one list.
  shareRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: tap.minHeight,
  },
  shareRowTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    ...tap, // 44pt chip floor (a11y review 2026-08-24)
    alignItems: 'center',
    backgroundColor: colors.dust,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  chipActive: { backgroundColor: colors.sage, borderColor: colors.sage },
  chipText: { color: colors.night, fontSize: type.small },
  // onAccent: scheme-aware ink on the sage fill (a11y review 2026-08-24).
  chipTextActive: { color: colors.onAccent, fontWeight: '700' },
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
  qrWrap: {
    marginTop: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
  },
  primaryBtn: {
    ...tap, // 44pt floor (a11y review 2026-08-24)
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    padding: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
  },
  primaryBtnText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  secondaryBtn: {
    ...tap,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.haze,
    padding: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: { color: colors.night, fontSize: type.body },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    minHeight: tap.minHeight, // collapsible header = button — 44pt floor
  },
  // Text links keep the quiet look but gain the 44pt floor (a11y review).
  linkTap: { justifyContent: 'center', minHeight: tap.minHeight },
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
  actionBtn: {
    justifyContent: 'center',
    minHeight: tap.minHeight, // 44pt floor (a11y review 2026-08-24)
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
  },
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
