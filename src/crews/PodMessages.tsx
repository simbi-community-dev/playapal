/**
 * PodMessages — the answering machine's face (Camp Mesh, docs/CREW-DESIGN.md
 * §6b): the messages strip INSIDE the Pod card, mounted by CrewSection under
 * the member rows. One composed surface for text + PTT voice notes over the
 * store-and-forward gossip in src/crews/messages.ts — "leave a message for a
 * crewmate; it arrives when radios meet."
 *
 * WHAT IT SHOWS. The thread merges my inbox (messages FOR me: crew-wide or
 * addressed to my card hash) with my own outbox — a sender who can't see
 * their own note would reasonably conclude it was lost, and the answering
 * machine's honesty posture is the opposite of that. Newest first, the
 * store's own order. Sender names resolve by hashing the friend cards this
 * phone holds (from_hash = hash32(FriendCard.id), the beacon.ts identity),
 * then by the pod's member announcements (src/crews/podMembers.ts) — a
 * podmate you joined by code and have never swapped cards with still gets
 * their name over their message. A hash with neither renders "someone in
 * the pod": honest, and now rare rather than routine.
 *
 * WHAT IT NEVER DOES. No clocks in logic — epochMinutes(Date.now()) only at
 * the UI boundary (send, tap-to-read, the mount-time prune). No radios — the
 * sync conductor (meshSync.ts) moves bytes; this strip only reads the store
 * and re-renders on its revision. No native audio — recording/playback go
 * through injected seams (recorder/player props) defaulting to a LAZY
 * require of ./fieldAudio, so tests run with pure fakes and the native
 * module is only touched when a finger actually holds the mic.
 *
 * DELIVERY HONESTY. Gossip is minutes-to-hours, not instant, and the copy
 * says so out loud (the friend-card "note board" posture): the footer names
 * the transport, and the base station appears as what it really is — a
 * plugged-in phone that keeps the mailbox.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getDb } from '../events/db';
import {
  getMyCard,
  listFriends,
  subscribeFriendsChanged,
  type FriendCard,
} from '../friends/friendCard';
import { hash32 } from './beacon';
import { agoPhrase } from './CrewSection';
import {
  TEXT_MAX_BYTES,
  composeText,
  composeVoice,
  epochMinutes,
  inbox,
  markRead,
  messagesRevision,
  myOutbox,
  pruneExpired,
  subscribeMessagesChanged,
  unreadCount,
  utf8ByteLength,
  type CrewMessage,
} from './messages';
import { announcedNames } from './podMembers';
import { colors, radius, spacing, tap, type } from '../theme';

/** Guarded screen-reader announcement (a11y review 2026-08-24): recording
 * state changes are otherwise VISUAL-ONLY, invisible to a listener holding
 * the button. try/catch so a bridge without AccessibilityInfo (tests,
 * stripped builds) makes this a silent no-op, never a crash. */
function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // no announcer here — the visible copy still tells the story
  }
}

/** The recorder seam PodMessages holds a mic press against. Injected in
 * tests; the app default is fieldRecorder (lazy-required below). */
export interface PodRecorder {
  start(): Promise<void>;
  stop(): Promise<{ base64: string; mime: string; durationMs: number }>;
}

/** The playback seam a voice row taps into. play resolves duration ms. */
export interface PodPlayer {
  play(b64: string): Promise<number>;
  stop(): Promise<void>;
}

/**
 * The receiver's duration estimate for a voice row: the store carries
 * bodies, not durations (a wire column for something derivable would just
 * drift), so length is read back from the bytes. FieldAudio records ~24
 * kbps AAC ≈ 3000 audio bytes/s ≈ 4000 base64 chars/s. Floor of 1 s: a
 * clip short enough to round to zero still exists, and "0s" reads broken.
 */
const B64_CHARS_PER_SECOND = 4000;
const voiceSeconds = (b64Body: string): number =>
  Math.max(1, Math.round(b64Body.length / B64_CHARS_PER_SECOND));

/** The store's order (created_min DESC, id DESC), re-asserted over the
 * merged inbox+outbox so interleaved senders read as one timeline. */
const newestFirst = (a: CrewMessage, b: CrewMessage): number =>
  b.created_min - a.created_min || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function PodMessages({
  crew,
  recorder,
  player,
}: {
  crew: { id: string; name: string; code: string; memberIds: string[] };
  recorder?: PodRecorder;
  player?: PodPlayer;
}) {
  const conn = getDb();

  // The store's revision emitter drives every re-render: composes, accepts
  // off the radio, markRead, prunes (the favorites.ts pattern).
  const msgRev = useSyncExternalStore(
    subscribeMessagesChanged,
    messagesRevision,
  );

  // My card id is the inbox identity (to_hash = hash32(me.id)); friend
  // cards are the sender-name table. Both refresh on the friends signal,
  // exactly like CrewSection's member rows. A phone with no self card yet
  // gets an unsaved random-id card — it still reads crew-wide mail, and
  // directed mail starts working the moment the card is saved.
  const [me, setMe] = useState(() => getMyCard(conn));
  const [friends, setFriends] = useState<FriendCard[]>(() => listFriends(conn));
  useEffect(
    () =>
      subscribeFriendsChanged(() => {
        setFriends(listFriends(conn));
        setMe(getMyCard(conn));
      }),
    [conn],
  );

  // Expired mail falls at mount — the UI's turn of the shared prune cadence
  // (messages.ts: "the sync conductor runs this before serving; the UI runs
  // it on its own cadence"). If anything fell, the revision bump above
  // re-renders with the survivors.
  useEffect(() => {
    pruneExpired(epochMinutes(Date.now()));
  }, []);

  const codes = [crew.code];

  // from_hash -> display name. Membership is NOT required to resolve — mail
  // relayed from a pod-mate whose card you hold but haven't picked into the
  // pod still deserves their name.
  //
  // TWO SOURCES, cards LAST so they win: an announcement is what the sender
  // calls themselves, a card is what this phone calls them, and the rest of
  // the app already shows the card's spelling — one person under two names
  // on one screen is worse than a slightly stale one. Rebuilt on every
  // message revision because that is when an announcement can land.
  const names = useMemo(() => {
    const m = announcedNames(crew.code);
    for (const f of friends) {
      m.set(hash32(f.id), f.name);
    }
    return m;
    // msgRev looks unused to the linter and is the entire point: it is the
    // store signal that says an announcement may have arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends, crew.code, msgRev]);
  const heard = inbox(codes, me.id);
  const mine = myOutbox(codes, me.id);
  const thread = [...heard, ...mine].sort(newestFirst);
  const unread = unreadCount(codes, me.id);

  // The strip rides COLLAPSED behind its header by default (a11y+IA review
  // 2026-08-24, DO-NOW #2: the Pod card was too long to scan) — the
  // Public-packs collapsible pattern. EXPANDED at mount when mail is
  // waiting: a message someone left must never hide behind a chevron.
  // Nothing persists; switching pods remounts (key={crew.id}) and re-asks.
  const [open, setOpen] = useState(() => unread > 0);

  const [draft, setDraft] = useState('');
  // One quiet line for whatever last went wrong (a failed take, a clip the
  // caps refuse) — inline, where the action happened, never a modal for
  // routine friction.
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  // Cap-aware BEFORE the store can throw: the byte overage renders inline
  // while typing, the draft is never truncated, and Send simply refuses
  // until it fits. utf8ByteLength because the cap is a radio-budget byte
  // cap, not a character count (emoji are 4 bytes each).
  const overBytes = Math.max(0, utf8ByteLength(draft) - TEXT_MAX_BYTES);

  // Seam defaults resolve LAZILY, at the moment of use — so a test that
  // injects both props never loads fieldAudio (and through it
  // NativeModules), and the app pays the import only on first real use.
  const getRecorder = useCallback(
    (): PodRecorder =>
      recorder ??
      (require('./fieldAudio') as typeof import('./fieldAudio')).fieldRecorder,
    [recorder],
  );
  const getPlayer = useCallback(
    (): PodPlayer =>
      player ??
      (require('./fieldAudio') as typeof import('./fieldAudio')).fieldPlayer,
    [player],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || overBytes > 0) {
      // Nothing to send, or the inline over-cap copy is already showing —
      // a press here must never truncate or half-send.
      return;
    }
    try {
      composeText(crew.code, me.id, text, null, epochMinutes(Date.now()));
      setDraft('');
      setNotice(null);
    } catch (e: any) {
      // The store's own honest copy (its throws are written for humans).
      setNotice(e?.message ?? String(e));
    }
  }, [crew.code, draft, me.id, overBytes]);

  // Hold lifecycle. holdRef (not state) is the truth the async callbacks
  // check, because a fast tap can land onPressOut before start() resolves:
  // - pressOut before start settles -> stop() rejects 'idle', swallowed,
  //   and when start() then resolves the finger is gone, so the take is
  //   stopped and discarded immediately (no orphaned open mic).
  const holdRef = useRef(false);

  const startHold = useCallback(async () => {
    holdRef.current = true;
    setNotice(null);
    try {
      await getRecorder().start();
    } catch (e: any) {
      holdRef.current = false;
      if (e?.code === 'permission') {
        // The native side never asks (radio.ts discipline) — this is the
        // in-context ask, payoff first. The Allow button raises the real
        // OS sheet on Android; iOS asks by itself on first native mic use.
        Alert.alert(
          'Voice notes',
          'Playa Pal needs the microphone for voice notes — allow it and hold the button again.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Allow the mic',
              onPress: () => {
                if (Platform.OS === 'android') {
                  PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
                  ).catch(() => {});
                }
              },
            },
          ],
        );
        return;
      }
      setNotice(e?.message ?? String(e));
      return;
    }
    if (!holdRef.current) {
      // Finger already lifted while the recorder was arming: end the take
      // now and drop it — an accidental brush must not leave the mic open.
      try {
        await getRecorder().stop();
      } catch {
        // an empty or already-idle take is exactly the goal state here
      }
      return;
    }
    setRecording(true);
    announce('Recording — let go to send');
  }, [getRecorder]);

  const stopHold = useCallback(async () => {
    const wasHolding = holdRef.current;
    holdRef.current = false;
    setRecording(false);
    if (!wasHolding) {
      return; // the failed-start path already cleaned up
    }
    try {
      const clip = await getRecorder().stop();
      composeVoice(
        crew.code,
        me.id,
        clip.base64,
        clip.mime,
        null,
        epochMinutes(Date.now()),
      );
      setNotice(null);
      announce('Voice note sent');
    } catch (e: any) {
      if (e?.code === 'idle') {
        return; // the pressOut-before-start race; startHold owns cleanup
      }
      // 'empty' (too-short hold), the voice byte cap, a recorder fault —
      // all arrive with human copy already on them.
      setNotice(e?.message ?? String(e));
    }
  }, [crew.code, getRecorder, me.id]);

  const tapRow = useCallback(
    (m: CrewMessage) => {
      // Tapping is the read receipt (local-only, never synced). My own
      // rows have no unread state; already-read rows are a store no-op,
      // but the guard here also skips the pointless call.
      if (m.origin !== 'mine' && m.read_at === null) {
        markRead(m.id, epochMinutes(Date.now()));
      }
      if (m.kind === 'voice') {
        getPlayer()
          .play(m.body)
          .catch((e: any) => setNotice(e?.message ?? String(e)));
      }
    },
    [getPlayer],
  );

  const renderRow = (m: CrewMessage) => {
    const isMine = m.origin === 'mine';
    const isUnread = !isMine && m.read_at === null;
    const known = isMine ? 'You' : names.get(m.from_hash);
    // The LAST resort, and now a rare one: neither a card nor a member
    // announcement has reached this phone for that hash. Say WHY, because
    // an anonymous message in a small pod reads like a stranger got in —
    // and on a gossip mesh the truthful answer is "not yet".
    const unknownSender = known === undefined;
    const sender = known ?? 'someone in the pod';
    // Inbox rows with a to_hash are addressed to ME specifically (the inbox
    // predicate guarantees it) — say so; a directed note reads differently.
    const direct = !isMine && m.to_hash !== null ? ' · just for you' : '';
    // The row's spoken label SAYS "unread" (a11y review 2026-08-24, DO-NOW
    // #10): the gold ● stays for eyes, but a dot is silent to a screen
    // reader — the word carries the state.
    const when = agoPhrase(m.created_min * 60_000);
    const rowLabel =
      (isUnread ? 'Unread — ' : '') +
      (m.kind === 'voice'
        ? `voice note from ${sender}${
            direct ? ', just for you' : ''
          }, ${voiceSeconds(m.body)} seconds — tap to play`
        : `message from ${sender}${direct ? ', just for you' : ''}: ${
            m.body
          }`) +
      (when ? ` · ${when}` : '') +
      (unknownSender ? " — their hello hasn't reached this phone yet" : '');
    return (
      <Pressable
        key={m.id}
        style={styles.msgRow}
        onPress={() => tapRow(m)}
        accessibilityRole="button"
        accessibilityLabel={rowLabel}>
        <View style={styles.metaRow}>
          {isUnread ? <Text style={styles.unreadDot}>●</Text> : null}
          <Text style={isUnread ? styles.senderUnread : styles.sender}>
            {sender}
            {direct}
          </Text>
          <Text style={styles.when}>
            {agoPhrase(m.created_min * 60_000) ?? ''}
          </Text>
        </View>
        {m.kind === 'text' ? (
          <Text style={isUnread ? styles.bodyUnread : styles.body}>
            {m.body}
          </Text>
        ) : (
          <Text style={styles.voice}>
            ▶ Voice note · {voiceSeconds(m.body)}s
          </Text>
        )}
        {unknownSender ? (
          <Text style={styles.senderHint}>
            Their hello hasn't reached this phone yet — it comes with the next
            time you pass.
          </Text>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      {/* The whole strip lives behind this header (a11y+IA review
          2026-08-24, DO-NOW #2) — the Public-packs collapsible pattern:
          title + unread badge + chevron, expanded state said out loud. */}
      <Pressable
        style={styles.headerRow}
        onPress={() => setOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel={
          unread > 0 ? `Answering machine, ${unread} new` : 'Answering machine'
        }
        accessibilityState={{ expanded: open }}>
        {/* "Answering machine" is USER-FACING by owner ruling (§6c #3): it
            "harkens cutely back to the era before cell phones when people
            left messages and checked them" — which is literally this
            transport's delivery model. */}
        <Text style={styles.title}>Answering machine</Text>
        {unread > 0 ? <Text style={styles.newBadge}>{unread} new</Text> : null}
        <Text style={styles.chevron}>{open ? '˅' : '›'}</Text>
      </Pressable>
      {open ? (
        <>
          {thread.length === 0 ? (
            <Text style={styles.empty}>
              No messages waiting. Leave one — the pod picks it up when phones
              pass in range, like the answering machine at your first house.
            </Text>
          ) : (
            thread.map(renderRow)
          )}
          {overBytes > 0 ? (
            <Text style={styles.notice}>
              That message is too long to carry — trim it down.
            </Text>
          ) : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          <View style={styles.composeRow}>
            <TextInput
              style={styles.input}
              placeholder="Message the pod…"
              placeholderTextColor={colors.faded}
              value={draft}
              onChangeText={setDraft}
              multiline
            />
            <Pressable
              style={styles.sendBtn}
              onPress={send}
              accessibilityRole="button"
              accessibilityLabel="Send message">
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
            <Pressable
              style={[styles.micBtn, recording && styles.micBtnLive]}
              onPressIn={startHold}
              onPressOut={stopHold}
              accessibilityRole="button"
              accessibilityLabel="Hold to record a voice note">
              <Text style={styles.micIcon}>🎤</Text>
            </Pressable>
          </View>
          {recording ? (
            <Text style={styles.recordingLine}>
              Recording — let go to send
            </Text>
          ) : null}
          <Text style={styles.footer}>
            Messages move while position sharing is on, hopping pod phone to
            pod phone — minutes to hours, not instant. A plugged-in phone at
            camp keeps the mailbox.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: tap.minHeight, // a collapsible header is a button now — 44pt
  },
  title: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  newBadge: { color: colors.gold, fontSize: type.small, fontWeight: '700' },
  chevron: {
    color: colors.faded,
    fontSize: type.title,
    fontWeight: '300',
    marginLeft: 'auto',
  },
  empty: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginVertical: spacing.sm,
  },
  msgRow: { marginTop: spacing.sm },
  metaRow: { alignItems: 'baseline', flexDirection: 'row', gap: spacing.sm },
  unreadDot: { color: colors.gold, fontSize: type.tiny },
  sender: { color: colors.faded, fontSize: type.small, fontWeight: '700' },
  senderUnread: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  when: { color: colors.faded, fontSize: type.tiny },
  // Why a message is anonymous, said where the anonymity shows.
  senderHint: {
    color: colors.faded,
    fontSize: type.tiny,
    fontStyle: 'italic',
    marginTop: 2,
  },
  body: { color: colors.faded, fontSize: type.body, marginTop: 2 },
  bodyUnread: { color: colors.night, fontSize: type.body, marginTop: 2 },
  voice: { color: colors.clay, fontSize: type.body, fontWeight: '700', marginTop: 2 },
  notice: { color: colors.clay, fontSize: type.small, marginTop: spacing.sm },
  composeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    // field, not cream: cream stays light in dark mode (text-on-accent),
    // a field surface must follow the ground (dark-mode sweep)
    backgroundColor: colors.field,
    borderRadius: radius.card,
    color: colors.night,
    flex: 1,
    fontSize: type.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendBtn: {
    ...tap, // 44pt send floor (a11y review 2026-08-24)
    alignItems: 'center',
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  micBtn: {
    ...tap, // the mic is the smallest hold target on the card — 44pt floor
    alignItems: 'center',
    borderColor: colors.haze,
    borderRadius: radius.chip,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  micBtnLive: { backgroundColor: colors.gold, borderColor: colors.gold },
  micIcon: { fontSize: type.body },
  recordingLine: {
    color: colors.gold,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  footer: { color: colors.faded, fontSize: type.tiny, marginTop: spacing.md },
});
