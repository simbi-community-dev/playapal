/**
 * Friends on playa — the Camp tab's Friends pane (2026-08-19; its own pane
 * since the 2026-08-24 IA refactor).
 *
 * My card (playa name, camp, address, find-me note) + the friends I've
 * collected. Sharing is direct and serverless: a QR, or the same share-sheet
 * link lane camp beams use. Friends' addresses link straight to the whiteout
 * compass and carry a walk time from MY address when both parse.
 *
 * SCANNING GOES BOTH WAYS since 2026-08-25. The system camera still scans
 * these codes — that path needs nothing from us and is what a person without
 * Playa Pal uses — but "Scan their code" now takes one in-app photo and
 * reads it here (src/links/scanCode.ts), because collecting a card used to
 * mean leaving the app and finding the way back.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DocumentDirectoryPath,
  ExternalDirectoryPath,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { BEAM_FILE_EXT, BEAM_MIME } from '../camp/campBoard';
import QRCode from 'react-native-qrcode-svg';
import type { DbConnection } from '../events/engine';
import {
  exportFriendsBundle,
  exportMyCard,
  friendsListText,
  getLastScope,
  getMyCard,
  listFriends,
  removeFriend,
  saveMyCard,
  setLastScope,
  subscribeFriendsChanged,
  subscribeMyCardQr,
  type FriendCard,
  type FriendScope,
} from '../friends/friendCard';
import { encodeFriendLink } from '../friends/friendLink';
import { myCardShareLink } from '../friends/cardShare';
import { scanCodeAndDeliver } from '../links/scanCode';
import { QR_MAX_CHARS } from '../beam/beamLink';
import { addressToLatLon, type WaypointTarget } from '../geo/brcGeo';
import { getCityGeometry } from '../geo/cityGeometry';
import { playaWalkMinutes } from '../rightnow/playaWalk';
import { colors, radius, spacing, tap, type } from '../theme';

export function FriendsSection({
  conn,
  onOpenCompass,
}: {
  conn: DbConnection;
  onOpenCompass: (target: WaypointTarget | null) => void;
}) {
  const geo = getCityGeometry();
  const [me, setMe] = useState(() => getMyCard(conn));
  const [friends, setFriends] = useState<FriendCard[]>(() => listFriends(conn));
  const [editOpen, setEditOpen] = useState(false);
  const [drafts, setDrafts] = useState({
    name: me.name,
    camp: me.camp,
    address: me.address,
    note: me.note,
  });
  // QR modal: null = closed; otherwise which bundle it shows.
  const [qrMode, setQrMode] = useState<null | 'me' | 'all'>(null);
  // Consent (owner's catch: gossip re-shared cards the author never agreed
  // to pass on). The author picks per share — "just for you" vs "pass it
  // on" — and the app remembers the last pick as the next default.
  const [scopePick, setScopePick] = useState<FriendScope>(
    () => getLastScope(conn) ?? 'crew',
  );

  const refresh = useCallback(() => {
    setMe(getMyCard(conn));
    setFriends(listFriends(conn));
  }, [conn]);

  // One shared refresh path: deep-link installs, picker imports, and edits
  // all bump the friends revision — mounted sections follow live.
  useEffect(() => subscribeFriendsChanged(refresh), [refresh]);

  const save = useCallback(() => {
    try {
      saveMyCard(conn, { ...drafts, scope: scopePick });
    } catch (e: any) {
      Alert.alert('Almost', e?.message ?? String(e));
      return;
    }
    refresh();
    setEditOpen(false);
  }, [conn, drafts, refresh, scopePick]);

  const shareText = useCallback(async (title: string, message: string) => {
    try {
      await Share.share({ title, message }, { dialogTitle: title });
    } catch {
      // Share sheet dismissed — nothing to clean up.
    }
  }, []);

  // The consent ask, then the actual share. Picking records the choice
  // (remembered as next default) AND stamps it onto my card before export,
  // so what travels carries the intent.
  const confirmShare = useCallback(
    (scope: FriendScope, action: () => void) => {
      setLastScope(conn, scope);
      setScopePick(scope);
      if (me.name.length > 0) {
        try {
          saveMyCard(conn, { ...me, scope });
        } catch {
          // A scope save failure must not block sharing the card as-is.
        }
      }
      action();
    },
    [conn, me],
  );

  const askScopeThen = useCallback(
    (action: () => void) => {
      Alert.alert(
        'Who can pass this on?',
        '"Just for you" cards never ride "Beam friends" — only the person you hand one to gets it.',
        [
          {
            text: 'Just for them',
            onPress: () => confirmShare('direct', action),
          },
          {
            text: 'Pass it on',
            onPress: () => confirmShare('crew', action),
          },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    },
    [confirmShare],
  );

  const shareCard = useCallback(() => {
    const go = () => {
      try {
        // A LINK, not the raw bundle. Sharing the JSON as text is the
        // field-proven failure the beam lane already paid for: the chooser
        // says "Sharing text", Save targets refuse it, and the receiver gets
        // pasted JSON they cannot import (Marisol, 2026-08-20). A link is
        // tappable in any messenger, opens the app when it is installed, and
        // falls back to the card page when it is not — which is exactly what
        // the QR beside this button already promises.
        //
        // Through cardShare.ts since 2026-08-25: the pod's "We're together"
        // row was still shipping the raw JSON this line stopped shipping in
        // August, because it was a SECOND copy of this gesture. One builder,
        // both doors.
        shareText('Playa Pal friend card', myCardShareLink(conn));
      } catch (e: any) {
        setEditOpen(true);
        Alert.alert('Before you share', e?.message ?? String(e));
      }
    };
    askScopeThen(go);
  }, [conn, shareText, askScopeThen]);

  /**
   * The whole crew travels as a FILE, the same way the camp beam does.
   *
   * This shared the bundle as share-sheet TEXT, which is the exact failure
   * the beam lane measured in the field on 2026-08-20 and fixed that day —
   * the chooser says "Sharing text", Save targets refuse it, and the receiver
   * gets pasted JSON instead of something Import can open. The friends lane
   * never got the same cure, and the QR-overflow copy below has been
   * promising "as a file" ever since, which was not true.
   *
   * Overflow is reachable at roughly five friends, so this is not a corner.
   */
  const beamFriends = useCallback(async () => {
    let bundle: string;
    try {
      bundle = exportFriendsBundle(conn);
    } catch (e: any) {
      Alert.alert('Before you beam', e?.message ?? String(e));
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    // ExternalDirectoryPath is "" on iOS (rn-fs 2.40), so the file must land
    // in the platform's real app dir or writeFile fails before any share.
    const dir =
      Platform.OS === 'android' ? ExternalDirectoryPath : DocumentDirectoryPath;
    // .playapal, not .json: the receiver's phone opens OUR extension in Playa
    // Pal with one tap (docs/BEAM-INGRESS-CONTRACT.md §1).
    const path = `${dir}/playapal-friends-${stamp}.${BEAM_FILE_EXT}`;
    try {
      await writeFile(path, bundle, 'utf8');
    } catch (e: any) {
      Alert.alert('Could not write the friends file', e?.message ?? String(e));
      return;
    }
    try {
      if (Platform.OS === 'android' && NativeModules.ShareFile) {
        await NativeModules.ShareFile.shareFile(path, BEAM_MIME, 'Beam friends');
      } else {
        // url only: a message payload makes iOS targets share the raw JSON as
        // text again, which is the bug this function exists to end.
        await Share.share(
          { title: 'Playa Pal friends', url: `file://${path}` },
          { dialogTitle: 'Beam friends' },
        );
      }
    } catch {
      Alert.alert(
        'Friends saved, not sent',
        Platform.OS === 'android'
          ? `The share sheet did not open, but the file is saved at ${path.replace('/storage/emulated/0/', '')} — share it from your Files app.`
          : "The share sheet did not open, but the file is saved in Playa Pal's folder in the Files app — share it from there.",
      );
    }
  }, [conn]);

  const shareList = useCallback(() => {
    shareText('Friends on playa', friendsListText(conn));
  }, [conn, shareText]);

  const openQr = useCallback(
    (mode: 'me' | 'all') => {
      const go = () => {
        try {
          // Validate the export up front so the modal never shows a stale code.
          if (mode === 'me') {
            exportMyCard(conn);
          } else {
            exportFriendsBundle(conn);
          }
          setQrMode(mode);
        } catch (e: any) {
          setEditOpen(true);
          Alert.alert('Before you share', e?.message ?? String(e));
        }
      };
      // My own card via QR is still a share — the same consent ask applies.
      if (mode === 'me') {
        askScopeThen(go);
      } else {
        go();
      }
    },
    [conn, askScopeThen],
  );

  // The Camp tab's "Share & receive" section has a "Show my card" row, and
  // it lands HERE (sharing audit, docs/SHARING-SURFACES.md §3.3): the card,
  // its scope chips, the consent ask and the modal all belong together, so
  // the far-away row asks and this section answers with the very same
  // openQr('me') a tap on "Show QR" runs. One flow, two doors — never a
  // second copy of the consent question.
  useEffect(() => subscribeMyCardQr(() => openQr('me')), [openQr]);

  // QR capacity: QR_MAX_CHARS is imported from src/beam/beamLink.ts — the
  // one shared constant (contract §5). Larger crews travel by "Beam friends"
  // (share sheet) instead (review 2026-08-19).
  const qrValue = useMemo(() => {
    if (!qrMode) {
      return null;
    }
    try {
      const link = encodeFriendLink(
        qrMode === 'me' ? exportMyCard(conn) : exportFriendsBundle(conn),
      );
      return link.length <= QR_MAX_CHARS ? link : 'overflow';
    } catch {
      return null;
    }
  }, [conn, qrMode]);

  const compassFor = useCallback(
    (address: string): WaypointTarget | null => {
      if (!geo || address.length === 0) {
        return null;
      }
      const t = addressToLatLon(address, geo);
      return t ? { label: t.label, lat: t.lat, lon: t.lon } : null;
    },
    [geo],
  );

  const walkFor = useCallback(
    (address: string): number | null => {
      if (me.address.length === 0 || address.length === 0) {
        return null;
      }
      return playaWalkMinutes(me.address, address);
    },
    [me.address],
  );

  const doRemove = useCallback(
    (f: FriendCard) => {
      Alert.alert('Remove friend?', `Forget ${f.name}'s card on this phone?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            removeFriend(conn, f.id);
            refresh();
          },
        },
      ]);
    },
    [conn, refresh],
  );

  const myLine =
    [me.address, me.camp].filter(s => s.length > 0).join(' — ') ||
    'address not set';

  return (
    <>
      {/* The pod card used to sit here, above the friend list — which is
          how pod comms ended up at the bottom of the Camp scroll, since
          this section is itself the last thing on that tab. It has its own
          tab now (src/screens/PodScreen.tsx); this section is back to the
          one job its name describes. */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Friends on playa
      </Text>
      <View style={styles.card}>
        {/* My card. The row is a collapsible button, said out loud (a11y
            sweep 2026-08-24): the ˅/› chevron alone is silent, and the
            spoken label leaves the glyph out of it. */}
        <Pressable
          onPress={() => setEditOpen(o => !o)}
          accessibilityRole="button"
          accessibilityLabel={
            me.name.length > 0
              ? `My card — ${me.name}, ${myLine}`
              : 'Set up my card'
          }
          accessibilityState={{ expanded: editOpen }}
          style={styles.rowTap}>
          <Text style={styles.myRow}>
            {me.name.length > 0 ? (
              <>
                <Text style={styles.myName}>{me.name}</Text>
                <Text style={styles.myWhere}> · {myLine}</Text>
              </>
            ) : (
              <Text style={styles.myName}>Set up my card…</Text>
            )}
            <Text style={styles.rowChevron}> {editOpen ? '˅' : '›'}</Text>
          </Text>
        </Pressable>
        {editOpen ? (
          <View>
            <TextInput
              style={styles.input}
              placeholder="Playa name"
              placeholderTextColor={colors.faded}
              value={drafts.name}
              onChangeText={t => setDrafts(d => ({ ...d, name: t }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Camp"
              placeholderTextColor={colors.faded}
              value={drafts.camp}
              onChangeText={t => setDrafts(d => ({ ...d, camp: t }))}
            />
            <TextInput
              style={styles.input}
              placeholder="Address — like 7:32 & C"
              placeholderTextColor={colors.faded}
              value={drafts.address}
              onChangeText={t => setDrafts(d => ({ ...d, address: t }))}
            />
            {drafts.address.trim().length > 0 && !compassFor(drafts.address) ? (
              <Text style={styles.addrHint}>
                Not a playa address yet — "7:32 & C", "Esplanade & 4:15", and
                "Center Camp" all work. Free text is kept either way.
              </Text>
            ) : null}
            <TextInput
              style={styles.input}
              placeholder="Find me… (shade structure, bar hours)"
              placeholderTextColor={colors.faded}
              value={drafts.note}
              onChangeText={t => setDrafts(d => ({ ...d, note: t }))}
            />
            {/* The consent pick, editable here too — the same choice the
                share flow asks for.

                ONE OF TWO, and the choice is not a color (a11y sweep
                2026-08-24). This picker used to say "chosen" with a plum
                fill and nothing else, which is invisible to a screen
                reader and to anyone who cannot separate plum from cream in
                flat playa sun. It is a radio group now: the ●/○ mark
                Settings already uses for its one-of-N rows, plus the
                selected state said out loud. The mark stays out of the
                spoken label — a glyph read aloud is noise. */}
            <View style={styles.scopeRow} accessibilityRole="radiogroup">
              {(
                [
                  ['direct', 'Just for them'],
                  ['crew', 'Pass it on'],
                ] as [FriendScope, string][]
              ).map(([scope, label]) => {
                const on = scopePick === scope;
                return (
                  <Pressable
                    key={scope}
                    accessibilityRole="radio"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: on }}
                    style={[styles.scopeChip, on && styles.scopeChipOn]}
                    onPress={() => setScopePick(scope)}>
                    <Text
                      style={[
                        styles.scopeChipText,
                        on && styles.scopeChipTextOn,
                      ]}>
                      {on ? '● ' : '○ '}
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.scopeHint}>
              "Just for them" cards never ride "Beam friends" — only the
              person you hand one to gets it.
            </Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={save}
              accessibilityRole="button"
              accessibilityLabel="Save my card">
              <Text style={styles.primaryBtnText}>Save my card</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Share row */}
        <View style={styles.shareRow}>
          <Pressable
            style={styles.shareBtn}
            onPress={() => openQr('me')}
            accessibilityRole="button"
            accessibilityLabel="Show my card as a QR code">
            <Text style={styles.shareBtnText}>Show QR</Text>
          </Pressable>
          <Pressable
            style={styles.shareBtn}
            onPress={shareCard}
            accessibilityRole="button"
            accessibilityLabel="Share my card">
            <Text style={styles.shareBtnText}>Share card</Text>
          </Pressable>
          <Pressable
            style={styles.shareBtn}
            onPress={() => void beamFriends()}
            accessibilityRole="button"
            accessibilityLabel="Beam the friend cards marked pass it on">
            <Text style={styles.shareBtnText}>Beam friends</Text>
          </Pressable>
        </View>
        {/* THE RECEIVING DOOR, beside the three sending ones. The row above
            is all "hold this up"; taking a card the other way meant leaving
            Playa Pal for the camera app and finding your way back (owner,
            2026-08-25). Its own row rather than a fourth pill: it is the
            opposite gesture, and four pills across a phone leaves four
            unreadable labels. */}
        <Pressable
          style={styles.scanBtn}
          onPress={() => void scanCodeAndDeliver()}
          accessibilityRole="button"
          accessibilityLabel="Scan a friend's code with the camera">
          <Text style={styles.scanBtnText}>📷 Scan their code</Text>
        </Pressable>

        {/* Friends */}
        {friends.length === 0 ? (
          <Text style={styles.empty}>
            No friends collected yet — tap "Scan their code" while they show
            theirs, or import their card file with "Import a pack…" under
            Share.
          </Text>
        ) : (
          friends.map(f => {
            const target = compassFor(f.address);
            const walk = walkFor(f.address);
            const where =
              [f.address, f.camp].filter(s => s.length > 0).join(' — ') ||
              'address TBD';
            return (
              <View key={f.id} style={styles.friendRow}>
                <View style={styles.friendBody}>
                  <Text style={styles.friendName}>{f.name}</Text>
                  {f.scope === 'direct' ? (
                    <Text style={styles.directBadge}>shared just with you</Text>
                  ) : null}
                  {target ? (
                    // The compass glyph is decoration; the spoken label
                    // says the verb and the walk in words (a11y sweep
                    // 2026-08-24). Keep the glyph off this comment —
                    // navigationIA.test.ts reads every line that carries
                    // it and insists the line marks a destination.
                    <Pressable
                      onPress={() => onOpenCompass(target)}
                      accessibilityRole="button"
                      accessibilityLabel={`Point the compass at ${f.name}, ${where}${
                        walk !== null ? `, about ${walk} minutes' walk` : ''
                      }`}
                      style={styles.linkTap}>
                      <Text style={styles.friendWhereLink}>
                        🧭 {where}
                        {walk !== null ? ` · ~${walk} min walk` : ''}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.friendWhere}>{where}</Text>
                  )}
                  {f.note.length > 0 ? (
                    <Text style={styles.friendNote}>{f.note}</Text>
                  ) : null}
                  {/* Which card this removes has to be in the label — a
                      list of identical "Remove" buttons names nobody. */}
                  <Pressable
                    onPress={() => doRemove(f)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${f.name}`}
                    style={styles.linkTap}>
                    <Text style={styles.remove}>Remove</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
        {friends.length > 0 ? (
          <Pressable
            onPress={shareList}
            accessibilityRole="button"
            accessibilityLabel="Share a printable list of friends"
            style={styles.linkTap}>
            <Text style={styles.listLink}>Share printable list…</Text>
          </Pressable>
        ) : null}
        <Text style={styles.hint}>
          Cards travel phone-to-phone only — a QR your camera scans, or a file
          over AirDrop / Quick Share. No server ever sees who camps where.
          When you share, you pick "just for them" or "pass it on"; only
          "pass it on" cards ride "Beam friends". The pick is honored by the
          app, not enforced by cryptography — anyone can retype a card by
          hand, so share what you'd write on a note board.
        </Text>
      </View>

      {/* QR modal — big, bright, scannable across a dusty table. */}
      <Modal
        visible={qrMode !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setQrMode(null)}>
        {/* accessible={false} is load-bearing: a Pressable is an
            accessibility element by DEFAULT (RN's Pressable sets
            accessible unless told otherwise), so this full-screen veil
            was swallowing the whole panel — title, hint and both buttons
            reachable as one unlabelled blob (a11y sweep 2026-08-24). The
            veil keeps its tap-to-dismiss; the panel below is where focus
            belongs, and the escape gesture closes it the same way. */}
        <Pressable
          style={styles.qrBackdrop}
          onPress={() => setQrMode(null)}
          accessible={false}>
          <View
            style={styles.qrPanel}
            onAccessibilityEscape={() => setQrMode(null)}>
            <Text style={styles.qrTitle} accessibilityRole="header">
              {qrMode === 'me' ? `${me.name || 'My card'}` : 'All my friends'}
            </Text>
            {qrValue && qrValue !== 'overflow' ? (
              <View style={styles.qrBox}>
                {/* The QR stays white in BOTH modes: quiet-zone contrast
                    is a scanner-hardware requirement, not a theme choice
                    (allowlisted in themeGuard). */}
                <QRCode
                  value={qrValue}
                  size={280}
                  backgroundColor="#ffffff"
                  onError={() => setQrMode(null)}
                />
              </View>
            ) : null}
            <Text style={styles.qrHint}>
              {qrValue === 'overflow'
                ? 'Too many cards for one code — "Beam friends" sends the whole crew as a file they can open in Playa Pal.'
                : 'Friends scan this with their normal camera. With Playa Pal installed it opens right in the app; without it, a page shows your card and where to get the app.'}
            </Text>
            {/* Which code is showing was another color-only state — same
                ●/○ radio treatment as the consent chips. */}
            <View style={styles.shareRow} accessibilityRole="radiogroup">
              <Pressable
                style={[styles.shareBtn, qrMode === 'me' && styles.shareBtnOn]}
                onPress={() => setQrMode('me')}
                accessibilityRole="radio"
                accessibilityLabel="My card"
                accessibilityState={{ selected: qrMode === 'me' }}>
                <Text style={styles.shareBtnText}>
                  {qrMode === 'me' ? '● ' : '○ '}My card
                </Text>
              </Pressable>
              <Pressable
                style={[styles.shareBtn, qrMode === 'all' && styles.shareBtnOn]}
                onPress={() => setQrMode('all')}
                accessibilityRole="radio"
                accessibilityLabel="All friends"
                accessibilityState={{ selected: qrMode === 'all' }}>
                <Text style={styles.shareBtnText}>
                  {qrMode === 'all' ? '● ' : '○ '}All friends
                </Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  // The 44pt floor, applied file-wide (a11y sweep 2026-08-24 — this
  // section was missed by the first pass): rows and buttons take ...tap,
  // quiet text links take linkTap so they keep their look and gain the
  // target. Same two shapes CrewSection and CampScreen use.
  rowTap: { ...tap, justifyContent: 'center' },
  linkTap: { justifyContent: 'center', minHeight: tap.minHeight },
  myRow: { paddingVertical: 2 },
  myName: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  myWhere: { color: colors.faded, fontSize: type.small },
  rowChevron: { color: colors.faded, fontSize: type.body, fontWeight: '300' },
  input: {
    // field, not cream: cream is text-on-accent and stays light in dark
    // mode, while a field surface must follow the ground (dark-mode sweep)
    backgroundColor: colors.field,
    borderRadius: radius.card,
    color: colors.night,
    fontSize: type.body,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addrHint: { color: colors.clay, fontSize: type.tiny, marginTop: 4 },
  primaryBtn: {
    ...tap,
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
  },
  primaryBtnText: {
    color: colors.onAccent, // scheme-aware ink on clay (a11y review 2026-08-24)
    fontSize: type.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  shareRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  shareBtn: {
    ...tap, // these pills were ~25pt tall (a11y sweep 2026-08-24)
    backgroundColor: colors.field,
    borderRadius: 999,
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 6,
  },
  shareBtnOn: { backgroundColor: colors.haze },
  scanBtn: {
    ...tap,
    alignItems: 'center',
    borderColor: colors.clay,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingVertical: 6,
  },
  scanBtnText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  shareBtnText: {
    color: colors.night,
    fontSize: type.small,
    fontWeight: '700',
    textAlign: 'center',
  },
  empty: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginTop: spacing.md,
  },
  friendRow: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  friendBody: {},
  friendName: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  friendWhereLink: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: 2,
  },
  friendWhere: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  friendNote: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  remove: { color: colors.clay, fontSize: type.small, marginTop: spacing.xs },
  listLink: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  hint: { color: colors.faded, fontSize: type.small, marginTop: spacing.md },
  scopeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  scopeChip: {
    ...tap, // 44pt chip floor (a11y sweep 2026-08-24)
    backgroundColor: colors.field,
    borderColor: colors.haze,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 6,
  },
  scopeChipOn: { backgroundColor: colors.plum, borderColor: colors.plum },
  scopeChipText: {
    color: colors.night,
    fontSize: type.small,
    fontWeight: '700',
    textAlign: 'center',
  },
  scopeChipTextOn: { color: colors.onAccent }, // scheme-aware ink on plum
  scopeHint: { color: colors.faded, fontSize: type.tiny, marginTop: 4 },
  directBadge: {
    color: colors.plum,
    fontSize: type.tiny,
    fontStyle: 'italic',
    fontWeight: '700',
    marginTop: 2,
  },
  qrBackdrop: {
    alignItems: 'center',
    backgroundColor: colors.backdrop, // shared modal veil — themed both modes
    flex: 1,
    justifyContent: 'center',
  },
  qrPanel: {
    alignItems: 'center',
    backgroundColor: colors.field,
    borderRadius: radius.card,
    margin: spacing.lg,
    padding: spacing.lg,
  },
  qrTitle: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    marginBottom: spacing.md,
  },
  // Stays white in BOTH modes — the QR quiet zone is scanner-hardware
  // contrast, not a theme choice (themeGuard allowlist).
  qrBox: { backgroundColor: '#ffffff', borderRadius: 8, padding: 12 },
  qrHint: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
