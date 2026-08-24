/**
 * Friends on playa — the Camp tab section (2026-08-19).
 *
 * My card (playa name, camp, address, find-me note) + the friends I've
 * collected. Sharing is direct and serverless: a QR the system camera scans
 * (no in-app scanner, no camera permission), or the same share-sheet text
 * lane camp beams use. Friends' addresses link straight to the whiteout
 * compass and carry a walk time from MY address when both parse.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
  type FriendCard,
  type FriendScope,
} from '../friends/friendCard';
import { encodeFriendLink } from '../friends/friendLink';
import { QR_MAX_CHARS } from '../beam/beamLink';
import { addressToLatLon, type WaypointTarget } from '../geo/brcGeo';
import { getCityGeometry } from '../geo/cityGeometry';
import { playaWalkMinutes } from '../rightnow/playaWalk';
import { colors, radius, spacing, type } from '../theme';

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
        shareText('Playa Pal friend card', exportMyCard(conn));
      } catch (e: any) {
        setEditOpen(true);
        Alert.alert('Before you share', e?.message ?? String(e));
      }
    };
    askScopeThen(go);
  }, [conn, shareText, askScopeThen]);

  const beamFriends = useCallback(() => {
    try {
      shareText('Playa Pal friends', exportFriendsBundle(conn));
    } catch (e: any) {
      Alert.alert('Before you beam', e?.message ?? String(e));
    }
  }, [conn, shareText]);

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
      <Text style={styles.sectionTitle}>Friends on playa</Text>
      <View style={styles.card}>
        {/* My card */}
        <Pressable onPress={() => setEditOpen(o => !o)}>
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
                share flow asks for. */}
            <View style={styles.scopeRow}>
              {(
                [
                  ['direct', 'Just for them'],
                  ['crew', 'Pass it on'],
                ] as [FriendScope, string][]
              ).map(([scope, label]) => (
                <Pressable
                  key={scope}
                  style={[
                    styles.scopeChip,
                    scopePick === scope && styles.scopeChipOn,
                  ]}
                  onPress={() => setScopePick(scope)}>
                  <Text
                    style={[
                      styles.scopeChipText,
                      scopePick === scope && styles.scopeChipTextOn,
                    ]}>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.scopeHint}>
              "Just for them" cards never ride "Beam friends" — only the
              person you hand one to gets it.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={save}>
              <Text style={styles.primaryBtnText}>Save my card</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Share row */}
        <View style={styles.shareRow}>
          <Pressable style={styles.shareBtn} onPress={() => openQr('me')}>
            <Text style={styles.shareBtnText}>Show QR</Text>
          </Pressable>
          <Pressable style={styles.shareBtn} onPress={shareCard}>
            <Text style={styles.shareBtnText}>Share card</Text>
          </Pressable>
          <Pressable style={styles.shareBtn} onPress={beamFriends}>
            <Text style={styles.shareBtnText}>Beam friends</Text>
          </Pressable>
        </View>

        {/* Friends */}
        {friends.length === 0 ? (
          <Text style={styles.empty}>
            No friends collected yet — scan a friend's QR with your camera, or
            import their card file with "Import a pack…" above.
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
                    <Pressable onPress={() => onOpenCompass(target)}>
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
                  <Pressable onPress={() => doRemove(f)}>
                    <Text style={styles.remove}>Remove</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
        {friends.length > 0 ? (
          <Pressable onPress={shareList}>
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
        <Pressable style={styles.qrBackdrop} onPress={() => setQrMode(null)}>
          <View style={styles.qrPanel}>
            <Text style={styles.qrTitle}>
              {qrMode === 'me' ? `${me.name || 'My card'}` : 'All my friends'}
            </Text>
            {qrValue && qrValue !== 'overflow' ? (
              <View style={styles.qrBox}>
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
                ? 'Too many cards for one code — use "Beam friends" to share the whole crew as a file.'
                : 'Friends scan this with their normal camera. With Playa Pal installed it opens right in the app; without it, a page shows your card and where to get the app.'}
            </Text>
            <View style={styles.shareRow}>
              <Pressable
                style={[styles.shareBtn, qrMode === 'me' && styles.shareBtnOn]}
                onPress={() => setQrMode('me')}>
                <Text style={styles.shareBtnText}>My card</Text>
              </Pressable>
              <Pressable
                style={[styles.shareBtn, qrMode === 'all' && styles.shareBtnOn]}
                onPress={() => setQrMode('all')}>
                <Text style={styles.shareBtnText}>All friends</Text>
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
  myRow: { paddingVertical: 2 },
  myName: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  myWhere: { color: colors.faded, fontSize: type.small },
  rowChevron: { color: colors.faded, fontSize: type.body, fontWeight: '300' },
  input: {
    backgroundColor: colors.cream,
    borderRadius: radius.card,
    color: colors.night,
    fontSize: type.body,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addrHint: { color: colors.clay, fontSize: type.tiny, marginTop: 4 },
  primaryBtn: {
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
  },
  primaryBtnText: {
    color: colors.cream,
    fontSize: type.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  shareRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  shareBtn: {
    backgroundColor: colors.cream,
    borderRadius: 999,
    flex: 1,
    paddingVertical: 6,
  },
  shareBtnOn: { backgroundColor: colors.haze },
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
    backgroundColor: colors.cream,
    borderColor: colors.haze,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 6,
  },
  scopeChipOn: { backgroundColor: colors.plum, borderColor: colors.plum },
  scopeChipText: {
    color: colors.night,
    fontSize: type.small,
    fontWeight: '700',
    textAlign: 'center',
  },
  scopeChipTextOn: { color: colors.cream },
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
    backgroundColor: '#000000aa',
    flex: 1,
    justifyContent: 'center',
  },
  qrPanel: {
    alignItems: 'center',
    backgroundColor: colors.cream,
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
  qrBox: { backgroundColor: '#ffffff', borderRadius: 8, padding: 12 },
  qrHint: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
